import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Config } from './config.js';
import { id, transaction } from './db.js';
import { ApiError } from './errors.js';
import { callWebsiteAgent, generateWebsite, parseAiTokenUsage } from './deepseek.js';
import { startAiCall, finishAiCall } from './ai-metering.js';
import { renderWebsite } from './website-html.js';
import { insertWebsiteSource } from './website-source.js';
import type { WebsiteRawSource } from './website-content-types.js';
import { runWebsiteAgent } from './website-react.js';
import type { WebsiteAgentObservation, WebsiteVisionImage } from './website-agent-types.js';
import { createAssetStore } from './asset-storage.js';
import { prepareWebsiteImages, sourcesCurrent, websiteImageSourcesRequired, type WebsiteImageJob } from './website-image-source.js';
import {
  requireWebsiteAI, verifyWebsiteVersion, websiteAudit, websiteUsageNumber, websiteUsageSummary, type WebsiteJob, type WebsiteMessage,
  type WebsiteVersion,
} from './website-access.js';

export interface WebsiteJobClient { chat: typeof callWebsiteAgent; generate: typeof generateWebsite; react?: typeof runWebsiteAgent }
const actualClient: WebsiteJobClient = { chat: callWebsiteAgent, generate: generateWebsite, react: runWebsiteAgent };
const safeErrors = new Set(['AI_NOT_CONFIGURED', 'AI_CONFIGURATION_INVALID', 'AI_BALANCE_INSUFFICIENT', 'AI_RATE_LIMITED', 'AI_AUTH_FAILED',
  'AI_PROVIDER_UNAVAILABLE', 'AI_TIMEOUT', 'AI_RESPONSE_INVALID', 'AI_OUTPUT_INVALID', 'AI_USAGE_UNAVAILABLE', 'AI_USAGE_INVALID', 'AI_OUTPUT_TRUNCATED', 'WEBSITE_HTML_INVALID',
  'WEBSITE_HTML_TOO_LARGE', 'WEBSITE_CHECKSUM_INVALID', 'WEBSITE_MANIFEST_INVALID',
  'WEBSITE_IMAGE_SOURCE_UNAVAILABLE', 'WEBSITE_VISION_LIMIT', 'WEBSITE_VISION_INVALID',
  'AGENT_REPAIR_LIMIT', 'AGENT_TOKEN_LIMIT', 'AGENT_TIME_LIMIT', 'AGENT_STEP_LIMIT',
  'WEBSITE_CONTEXT_REVOKED', 'JOB_INTERRUPTED', 'AGENT_CANCELLED']);
function errorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; status?: unknown; statusCode?: unknown };
    if (typeof value.code === 'string' && safeErrors.has(value.code)) return value.code;
    const status = value.status ?? value.statusCode;
    if (status === 402) return 'AI_BALANCE_INSUFFICIENT';
    if (status === 429) return 'AI_RATE_LIMITED';
    if (status === 401 || status === 403) return 'AI_AUTH_FAILED';
    if (status === 408 || status === 504) return 'AI_TIMEOUT';
  }
  // 绝不存储异常 message、响应正文、用户内容或配置密钥。
  return 'AI_PROVIDER_UNAVAILABLE';
}
async function lockWorkerContext(db: PoolClient, candidate: Pick<WebsiteJob, 'requesting_user_id' | 'restaurant_id'>): Promise<boolean> {
  const user = (await db.query('SELECT id,status,email_verified_at FROM users WHERE id=$1 FOR NO KEY UPDATE', [candidate.requesting_user_id])).rows[0];
  const restaurant = (await db.query('SELECT id,status FROM restaurants WHERE id=$1 FOR UPDATE', [candidate.restaurant_id])).rows[0];
  const membership = (await db.query(`SELECT id FROM restaurant_members WHERE restaurant_id=$1 AND user_id=$2
    AND role='owner' AND status='active' FOR UPDATE`, [candidate.restaurant_id, candidate.requesting_user_id])).rows[0];
  return Boolean(user && user.status === 'active' && user.email_verified_at && restaurant && ['draft', 'active'].includes(restaurant.status) && membership);
}
async function failJob(db: PoolClient, job: WebsiteJob, code: string): Promise<void> {
  await db.query(`UPDATE website_jobs SET status='failed',error_code=$2,lease_token=NULL,lease_expires_at=NULL,
    progress=CASE WHEN progress IS NULL THEN NULL ELSE jsonb_set(progress,'{phase}','"failed"'::jsonb) END,
    updated_at=clock_timestamp() WHERE id=$1`, [job.id, code]);
  // 与餐厅锁、失败状态及审计处在同一事务，只释放引用，不删除任何源文件。
  await db.query(`DELETE FROM asset_references WHERE restaurant_id=$1 AND purpose='website_job' AND resource_id=$2`, [job.restaurant_id, job.id]);
  await websiteAudit(db, job.requesting_user_id, job.restaurant_id, job.id, 'website_job_failed', job.id);
}
async function claimJob(pool: Pool): Promise<{ job?: WebsiteJob; consumed: boolean }> {
  return transaction(pool, async db => {
    const candidate = (await db.query<WebsiteJob>(`SELECT id,restaurant_id,requesting_user_id FROM website_jobs
      WHERE status='queued' OR (status='running' AND lease_expires_at<=clock_timestamp())
      ORDER BY CASE WHEN status='running' THEN 0 ELSE 1 END,created_at,id LIMIT 1`)).rows[0];
    if (!candidate) return { consumed: false };
    const valid = await lockWorkerContext(db, candidate);
    const job = (await db.query<WebsiteJob & { expired: boolean }>(`SELECT *,lease_expires_at<=clock_timestamp() AS expired FROM website_jobs
      WHERE id=$1 AND (status='queued' OR (status='running' AND lease_expires_at<=clock_timestamp())) FOR UPDATE SKIP LOCKED`, [candidate.id])).rows[0];
    if (!job) return { consumed: false };
    if (job.status === 'running') {
      await failJob(db, job, 'JOB_INTERRUPTED');
      return { consumed: true };
    }
    if (!valid) {
      await failJob(db, job, 'WEBSITE_CONTEXT_REVOKED');
      return { consumed: true };
    }
    const token = randomUUID();
    const running = (await db.query<WebsiteJob>(`UPDATE website_jobs SET status='running',lease_token=$2,
      lease_expires_at=clock_timestamp()+interval '3 minutes',
      updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [job.id, token])).rows[0]!;
    return { job: running, consumed: true };
  });
}
async function prepareJobImages(pool: Pool, config: Config, original: WebsiteJob): Promise<WebsiteVisionImage[]> {
  if (!websiteImageSourcesRequired(original)) return [];
  const prepared = await transaction(pool, async db => {
    const valid = await lockWorkerContext(db, original);
    const job = (await db.query<WebsiteJob & { remaining: number | null }>(`SELECT *,
      extract(epoch FROM lease_expires_at-clock_timestamp())::float8 AS remaining
      FROM website_jobs WHERE id=$1 FOR UPDATE`, [original.id])).rows[0];
    if (!job || job.restaurant_id !== original.restaurant_id || job.requesting_user_id !== original.requesting_user_id ||
        job.status !== 'running' || job.lease_token !== original.lease_token) return { code: 'JOB_INTERRUPTED' };
    if (!valid || job.remaining === null || job.remaining <= 0) {
      const code = !valid ? 'WEBSITE_CONTEXT_REVOKED' : 'JOB_INTERRUPTED';
      await failJob(db, job, code);
      return { code };
    }
    try { return { rows: await sourcesCurrent(db, job, original, valid, job.remaining) }; }
    catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const code = errorCode(error);
      await failJob(db, job, code);
      return { code };
    }
  });
  if (prepared.code) throw new ApiError(503, prepared.code);
  if (!prepared.rows?.length) return [];
  // 短事务提交后才创建存储客户端和读取字节；helper 在所有出口 finally.close。
  try { return await prepareWebsiteImages(original, prepared.rows, createAssetStore(config)); }
  catch (error) {
    if (error instanceof ApiError && ['WEBSITE_IMAGE_SOURCE_UNAVAILABLE', 'WEBSITE_VISION_LIMIT'].includes(error.code)) throw error;
    throw new ApiError(503, 'WEBSITE_IMAGE_SOURCE_UNAVAILABLE');
  }
}
function observedCall(observation: WebsiteAgentObservation): WebsiteAgentObservation['event']['model_call'] {
  const call = observation.event.model_call;
  const actions = { model_call_started: 'started', model_call_completed: 'completed', model_call_failed: 'failed' };
  const expected = actions[observation.event.action as keyof typeof actions];
  if (!call) {
    if (expected) throw new ApiError(503, 'AI_USAGE_INVALID');
    return undefined;
  }
  if (!expected || call.status !== expected || !Number.isInteger(call.index) || call.index < 1 || call.index > 2147483647 ||
      typeof call.elapsed_ms !== 'number') throw new ApiError(503, 'AI_USAGE_INVALID');
  websiteUsageNumber(call.elapsed_ms);
  const counts = [call.prompt_tokens, call.completion_tokens, call.total_tokens];
  const unknown = counts.every(value => value === null);
  if (!unknown) {
    for (const value of counts) {
      if (typeof value !== 'number') throw new ApiError(503, 'AI_USAGE_INVALID');
      websiteUsageNumber(value);
    }
    if (!Number.isSafeInteger(call.prompt_tokens! + call.completion_tokens!) ||
        call.total_tokens !== call.prompt_tokens! + call.completion_tokens!) throw new ApiError(503, 'AI_USAGE_INVALID');
  }
  if ((call.status === 'started' && !unknown) || (call.status === 'completed' && unknown) ||
      (call.status !== 'failed' && call.error_code !== undefined)) throw new ApiError(503, 'AI_USAGE_INVALID');
  return { ...call, ...(call.status === 'failed' && call.error_code !== undefined ? { error_code: errorCode({ code: call.error_code }) } : {}) };
}
async function observeJob(pool: Pool, config: Config, original: WebsiteJob, observation: WebsiteAgentObservation): Promise<void> {
  const call = observedCall(observation);
  const code = await transaction(pool, async db => {
    const valid = await lockWorkerContext(db, original);
    const job = (await db.query<WebsiteJob & { remaining: number | null }>(`SELECT *,
      extract(epoch FROM lease_expires_at-clock_timestamp())::float8 AS remaining
      FROM website_jobs WHERE id=$1 FOR UPDATE`, [original.id])).rows[0];
    if (call && call.status !== 'started') {
      await finishAiCall(db, { requestingUserId: original.requesting_user_id, restaurantId: original.restaurant_id,
        websiteJobId: original.id, runnerToken: original.lease_token!, callIndex: call.index, status: call.status,
        usage: parseAiTokenUsage(call), elapsedMs: call.elapsed_ms, ...(call.error_code ? { errorCode: call.error_code } : {}) });
    }
    if (!job || job.restaurant_id !== original.restaurant_id || job.requesting_user_id !== original.requesting_user_id) return 'JOB_INTERRUPTED';
    const terminalReason = job.error_code === 'AGENT_CANCELLED' ? 'AGENT_CANCELLED' : 'JOB_INTERRUPTED';
    const active = job.status === 'running' && job.lease_token === original.lease_token;
    // 外部请求已发出：原始调用行中的令牌允许取消、过期或撤权后补账，但绝不写业务进度或复活任务。
    if (call && call.status !== 'started' && original.lease_token && (active || job.status === 'failed')) {
      const changed = await db.query(`UPDATE website_model_calls SET status=$4,prompt_tokens=$5,completion_tokens=$6,
        total_tokens=$7,elapsed_ms=$8,error_code=$9,updated_at=clock_timestamp()
        WHERE job_id=$1 AND call_index=$2 AND runner_token=$3 AND status='started'`,
      [job.id, call.index, original.lease_token, call.status, call.prompt_tokens, call.completion_tokens,
        call.total_tokens, call.elapsed_ms, call.error_code ?? null]);
      if (!changed.rowCount) {
        if (!active) return terminalReason;
        const previous = (await db.query('SELECT status,runner_token,prompt_tokens,completion_tokens,total_tokens,elapsed_ms,error_code FROM website_model_calls WHERE job_id=$1 AND call_index=$2', [job.id, call.index])).rows[0];
        if (!previous || previous.runner_token !== original.lease_token || previous.status === 'started') return 'AI_USAGE_INVALID';
        // 相同终态观察可重复提交，但不重复写事件、扣量或误杀仍运行的任务。
        const sameCount = (stored: string | null, observed: number | null) => stored === null ? observed === null : stored === String(observed);
        if (call.status === previous.status && sameCount(previous.prompt_tokens, call.prompt_tokens) &&
            sameCount(previous.completion_tokens, call.completion_tokens) && sameCount(previous.total_tokens, call.total_tokens) &&
            sameCount(previous.elapsed_ms, call.elapsed_ms) && previous.error_code === (call.error_code ?? null)) return undefined;
        // completed 回调因取消而抛错后，ReAct 的 failed 回调不得覆盖已知账单。
        if (call.status === 'failed' && previous.status === 'completed') return undefined;
        return 'AI_USAGE_INVALID';
      }
    }
    if (!active) return terminalReason;
    if (!valid || job.remaining === null || job.remaining <= 0) {
      const reason = !valid ? 'WEBSITE_CONTEXT_REVOKED' : 'JOB_INTERRUPTED';
      await failJob(db, job, reason);
      // 在事务外抛错，保留失败状态、引用释放以及已经发生的调用账单。
      return reason;
    }
    if (call?.status === 'started') {
      // 每次付费调用都复核，而不是仅依赖 I/O 前的检查；失败先提交终态，绝不创建假账单。
      try { await sourcesCurrent(db, job, original, valid, job.remaining); }
      catch (error) {
        if (!(error instanceof ApiError)) throw error;
        const reason = errorCode(error);
        await failJob(db, job, reason);
        return reason;
      }
      const inserted = await db.query(`INSERT INTO website_model_calls(job_id,call_index,runner_token,status,elapsed_ms)
        VALUES($1,$2,$3,'started',$4) ON CONFLICT(job_id,call_index) DO NOTHING`, [job.id, call.index, original.lease_token, call.elapsed_ms]);
      if (!inserted.rowCount) return 'AI_USAGE_INVALID';
      await startAiCall(db, { requestingUserId: original.requesting_user_id, restaurantId: original.restaurant_id,
        websiteJobId: original.id, runnerToken: original.lease_token!, callIndex: call.index, model: config.website?.model ?? 'deepseek-flash' });
    }
    const progress = JSON.stringify(observation.progress), event = JSON.stringify({ ...observation.event, ...(call ? { model_call: call } : {}) });
    const draft = observation.draft === undefined ? null : JSON.stringify(observation.draft);
    if (Buffer.byteLength(progress) > 64 * 1024 || Buffer.byteLength(event) > 24 * 1024 ||
        (draft !== null && (Buffer.byteLength(draft) > 1024 * 1024 ||
        Buffer.byteLength(observation.draft!.html_body) > 100 * 1024 || Buffer.byteLength(observation.draft!.css) > 40 * 1024 ||
        Array.from(observation.draft!.summary).length > 800))) {
      await failJob(db, job, 'AGENT_STEP_LIMIT');
      return 'AGENT_STEP_LIMIT';
    }
    let usage: Record<string, number>;
    try {
      const summary = await websiteUsageSummary(db, job.id);
      usage = { model_calls: summary.model_calls, ...summary.totals, unknown_usage_calls: summary.unknown_usage_calls,
        ...(observation.progress.elapsed_ms === undefined ? {} : { elapsed_ms: websiteUsageNumber(observation.progress.elapsed_ms) }) };
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'AI_USAGE_INVALID') throw error;
      await failJob(db, job, error.code);
      return error.code;
    }
    await db.query(`UPDATE website_jobs SET progress=$2::jsonb,
      trace=COALESCE((SELECT jsonb_agg(value ORDER BY ordinality) FROM
        jsonb_array_elements(trace || jsonb_build_array($3::jsonb)) WITH ORDINALITY AS events(value,ordinality)
        WHERE ordinality>GREATEST(0,jsonb_array_length(trace)+1-40)), '[]'::jsonb),
      agent_draft=CASE WHEN $4::jsonb IS NULL THEN agent_draft ELSE $4::jsonb END,
      usage=$5::jsonb,lease_expires_at=CASE WHEN $6::boolean THEN GREATEST(lease_expires_at,clock_timestamp()+interval '3 minutes') ELSE lease_expires_at END,
      updated_at=clock_timestamp() WHERE id=$1`,
    [job.id, progress, event, draft, JSON.stringify(usage), call?.status === 'started']);
    return undefined;
  });
  if (code) throw new ApiError(503, code);
}
type Result = { kind: 'chat'; reply: string; design_brief: string } | { kind: 'generate'; version: WebsiteVersion; raw: WebsiteRawSource };
function validText(value: unknown, max: number, empty = false): value is string {
  return typeof value === 'string' && (empty || Boolean(value.trim())) && !value.includes('\0') && Array.from(value).length <= max;
}
async function singleModelCall<T extends { usage?: unknown }>(pool: Pool, config: Config, original: WebsiteJob,
  invoke: (beforeSend: () => Promise<void>) => Promise<T>, supportsHook: boolean): Promise<T> {
  let callStarted: number | undefined;
  const identity = { requestingUserId: original.requesting_user_id, restaurantId: original.restaurant_id,
    websiteJobId: original.id, runnerToken: original.lease_token!, callIndex: 1 };
  const beforeSend = async () => {
    if (callStarted !== undefined) return;
    const code = await transaction(pool, async db => {
      const valid = await lockWorkerContext(db, original);
      const job = (await db.query<WebsiteJob & { remaining: number | null }>(`SELECT *,
        extract(epoch FROM lease_expires_at-clock_timestamp())::float8 AS remaining
        FROM website_jobs WHERE id=$1 FOR UPDATE`, [original.id])).rows[0];
      if (!job || job.restaurant_id !== original.restaurant_id || job.requesting_user_id !== original.requesting_user_id ||
          job.status !== 'running' || job.lease_token !== original.lease_token) return 'JOB_INTERRUPTED';
      if (!valid || job.remaining === null || job.remaining <= 0) {
        const reason = !valid ? 'WEBSITE_CONTEXT_REVOKED' : 'JOB_INTERRUPTED';
        await failJob(db, job, reason);
        return reason;
      }
      if (job.kind === 'chat') {
        const agent = (await db.query<{ revision: number; messages: WebsiteMessage[] }>(`SELECT revision,messages FROM website_agents
          WHERE restaurant_id=$1 FOR UPDATE`, [job.restaurant_id])).rows[0];
        if (!agent || agent.revision !== job.agent_revision || JSON.stringify(agent.messages.slice(-20)) !== JSON.stringify(job.input.messages)) {
          await failJob(db, job, 'AGENT_CONTEXT_CHANGED');
          return 'AGENT_CONTEXT_CHANGED';
        }
      } else {
        try { await sourcesCurrent(db, job, original, valid, job.remaining); }
        catch (error) {
          if (!(error instanceof ApiError)) throw error;
          const reason = errorCode(error);
          await failJob(db, job, reason);
          return reason;
        }
      }
      await startAiCall(db, { ...identity, model: config.website?.model ?? 'deepseek-flash' });
      if (job.kind === 'generate') {
        const inserted = await db.query(`INSERT INTO website_model_calls(job_id,call_index,runner_token,status,elapsed_ms)
          VALUES($1,1,$2,'started',0) ON CONFLICT(job_id,call_index) DO NOTHING`, [job.id, original.lease_token]);
        if (!inserted.rowCount) throw new ApiError(503, 'AI_USAGE_INVALID');
      }
      return undefined;
    });
    if (code) throw new ApiError(503, code);
    callStarted = Date.now();
  };
  const finishCall = async (status: 'completed' | 'failed', value: unknown, code?: string) => {
    if (callStarted === undefined) return;
    const usage = parseAiTokenUsage(value), elapsedMs = Math.max(0, Date.now() - callStarted);
    await transaction(pool, async db => {
      // 旧 007 UPDATE 的 trigger 也锁 job，先保持原锁序；权限结果不阻止已发生调用的结账。
      await lockWorkerContext(db, original);
      const job = (await db.query<WebsiteJob>('SELECT * FROM website_jobs WHERE id=$1 FOR UPDATE', [original.id])).rows[0];
      await finishAiCall(db, { ...identity, status, usage, elapsedMs, ...(code ? { errorCode: code } : {}) });
      if (original.kind === 'generate' && job?.restaurant_id === original.restaurant_id && job.requesting_user_id === original.requesting_user_id &&
          (job.status === 'failed' || (job.status === 'running' && job.lease_token === original.lease_token))) {
        // 007 不允许 completed + unknown；仅旧行使用 failed，010 保持真实 completed + unknown，不影响业务成功。
        const legacyUnknown = status === 'completed' && usage === null;
        await db.query(`UPDATE website_model_calls SET status=$3,prompt_tokens=$4,completion_tokens=$5,
          total_tokens=$6,elapsed_ms=$7,error_code=$8,updated_at=clock_timestamp()
          WHERE job_id=$1 AND call_index=1 AND runner_token=$2 AND status='started'`,
        [original.id, original.lease_token, legacyUnknown ? 'failed' : status, usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null,
          usage?.total_tokens ?? null, elapsedMs, legacyUnknown ? 'AI_USAGE_UNAVAILABLE' : code ?? null]);
      }
    });
  };
  try {
    // 只对不声明第四参数的旧注入 fixture 提前开始；真实 JSON provider 的本地失败不能生成调用行。
    if (!supportsHook) await beforeSend();
    const output = await invoke(beforeSend);
    await finishCall('completed', output?.usage);
    return output;
  } catch (error) {
    await finishCall('failed', (error as { usage?: unknown } | null)?.usage, errorCode(error));
    throw error;
  }
}
async function perform(pool: Pool, config: Config, job: WebsiteJob, client: WebsiteJobClient, observe?: (obs: WebsiteAgentObservation) => Promise<void>): Promise<Result> {
  requireWebsiteAI(config);
  if (job.kind === 'chat') {
    const output = await singleModelCall(pool, config, job,
      beforeSend => client.chat(config, job.input.messages!.slice(-20), job.snapshot, beforeSend),
      client.chat === callWebsiteAgent || client.chat.length >= 4);
    if (!validText(output?.reply, 2000) || !validText(output?.design_brief, 3000, true)) throw new ApiError(503, 'AI_RESPONSE_INVALID');
    return { kind: 'chat', reply: output.reply, design_brief: output.design_brief };
  }
  if (client.react === runWebsiteAgent && (config.website?.baseUrl !== 'https://api.deepseek.com' || config.website.model !== 'deepseek-flash')) {
    throw new ApiError(503, 'AI_CONFIGURATION_INVALID');
  }
  if (websiteImageSourcesRequired(job) && !client.react) throw new ApiError(503, 'WEBSITE_IMAGE_SOURCE_UNAVAILABLE');
  const images = (job.input as WebsiteImageJob['input']).image_vision_confirmed === true
    ? await prepareJobImages(pool, config, job) : [];
  // 旧单次生成仅服务于显式注入的历史 fixture；有视觉输入必须使用原生 ReAct，不能丢弃照片。
  const output = client.react
    ? await client.react(config, job.input.brief!, job.snapshot, observe!, undefined, undefined, images)
    : await singleModelCall(pool, config, job,
      beforeSend => client.generate(config, job.input.brief!, job.snapshot, beforeSend),
      client.generate === generateWebsite || client.generate.length >= 4);
  if (!validText(output?.summary, client.react ? 800 : 2000) || (output?.model !== null && !validText(output?.model, 100)) ||
      typeof output?.html_body !== 'string' || typeof output?.css !== 'string') throw new ApiError(503, 'AI_RESPONSE_INVALID');
  let rendered: ReturnType<typeof renderWebsite>;
  try {
    if (client.react) {
      if (!('html' in output) || !('checksum' in output) || typeof output.html !== 'string' || typeof output.checksum !== 'string') {
        throw new ApiError(503, 'AI_RESPONSE_INVALID');
      }
      rendered = { html: output.html, checksum: output.checksum };
    } else rendered = renderWebsite(output, job.snapshot);
  }
  catch (error) {
    if (error instanceof ApiError && safeErrors.has(error.code)) throw error;
    throw new ApiError(503, 'WEBSITE_HTML_INVALID');
  }
  if (!rendered.html.trim() || Buffer.byteLength(rendered.html, 'utf8') > 200 * 1024) throw new ApiError(503, 'WEBSITE_HTML_TOO_LARGE');
  const version: WebsiteVersion = { id: id('wsv'), restaurant_id: job.restaurant_id, version_number: 0,
    html: rendered.html, checksum: rendered.checksum, snapshot: job.snapshot, summary: output.summary,
    model: output.model, usage: output.usage, asset_ids: job.snapshot.assets.map(asset => asset.id), created_at: new Date() };
  verifyWebsiteVersion(version);
  return { kind: 'generate', version, raw: { html_body: output.html_body, css: output.css, summary: output.summary } };
}
async function finishJob(pool: Pool, original: WebsiteJob, result?: Result, failure?: string): Promise<void> {
  await transaction(pool, async db => {
    const valid = await lockWorkerContext(db, original);
    const job = (await db.query<WebsiteJob & { expired: boolean; remaining: number | null }>(`SELECT *,lease_expires_at<=clock_timestamp() AS expired,
      extract(epoch FROM lease_expires_at-clock_timestamp())::float8 AS remaining
      FROM website_jobs WHERE id=$1 FOR UPDATE`, [original.id])).rows[0];
    if (!job || job.restaurant_id !== original.restaurant_id || job.requesting_user_id !== original.requesting_user_id ||
        job.status !== 'running' || job.lease_token !== original.lease_token) return;
    if (!valid || job.expired || failure) {
      await failJob(db, job, !valid ? 'WEBSITE_CONTEXT_REVOKED' : job.expired ? 'JOB_INTERRUPTED' : failure!);
      return;
    }
    try { await sourcesCurrent(db, job, original, valid, job.remaining); }
    catch (error) {
      if (!(error instanceof ApiError)) throw error;
      await failJob(db, job, errorCode(error));
      return;
    }
    let versionId: string | null = null;
    if (result?.kind === 'chat') {
      const agent = (await db.query<{ revision: number; messages: WebsiteMessage[] }>(`SELECT revision,messages FROM website_agents
        WHERE restaurant_id=$1 FOR UPDATE`, [job.restaurant_id])).rows[0];
      if (!agent || agent.revision !== job.agent_revision || JSON.stringify(agent.messages.slice(-20)) !== JSON.stringify(job.input.messages)) {
        await failJob(db, job, 'AGENT_CONTEXT_CHANGED');
        return;
      }
      const messages: WebsiteMessage[] = [...agent.messages, { role: 'assistant' as const, content: result.reply }].slice(-24);
      await db.query(`UPDATE website_agents SET messages=$2,design_brief=$3,revision=revision+1,updated_at=clock_timestamp()
        WHERE restaurant_id=$1`, [job.restaurant_id, JSON.stringify(messages), result.design_brief]);
    } else if (result?.kind === 'generate') {
      const last = (await db.query('SELECT version_number FROM website_versions WHERE restaurant_id=$1 ORDER BY version_number DESC LIMIT 1', [job.restaurant_id])).rows[0];
      const number = (last?.version_number ?? 0) + 1;
      if (number > 2147483647) { await failJob(db, job, 'WEBSITE_VERSION_LIMIT'); return; }
      const version = { ...result.version, version_number: number };
      await db.query(`INSERT INTO website_versions(id,restaurant_id,version_number,summary,html,checksum,snapshot,asset_ids,model,usage)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [version.id, job.restaurant_id, number, version.summary,
        version.html, version.checksum, JSON.stringify(version.snapshot), version.asset_ids, version.model,
        version.usage == null ? null : JSON.stringify(version.usage)]);
      await insertWebsiteSource(db, version, result.raw, { origin: 'generation', jobId: job.id,
        restaurantRevision: job.input.expected_restaurant_revision ?? 0, menuRevision: job.snapshot.menu?.revision ?? null });
      // 保留旧任务引用，另加永久版本引用；原稿与任务成功终态由 deferred guard 在提交时联合核验。
      versionId = version.id;
    } else {
      await failJob(db, job, 'AI_RESPONSE_INVALID');
      return;
    }
    await db.query(`UPDATE website_jobs SET status='succeeded',result_version_id=$2,lease_token=NULL,lease_expires_at=NULL,
      progress=CASE WHEN progress IS NULL THEN NULL ELSE jsonb_set(progress,'{phase}','"ready"'::jsonb) END,
      updated_at=clock_timestamp() WHERE id=$1`, [job.id, versionId]);
  });
}

// 两个跨进程全局槽位使用专用连接的会话 advisory lock；模型 I/O 不持有数据库事务或行锁。
export async function runWebsiteJobs(pool: Pool, config: Config, client: WebsiteJobClient = actualClient): Promise<number> {
  const guard = await pool.connect();
  let slot: number | undefined;
  try {
    for (const candidate of [0, 1]) {
      if ((await guard.query('SELECT pg_try_advisory_lock(771042,$1::integer) AS locked', [candidate])).rows[0].locked) { slot = candidate; break; }
    }
    if (slot === undefined) return 0;
    const claimed = await claimJob(pool);
    if (!claimed.job) return claimed.consumed ? 1 : 0;
    let result: Result | undefined, failure: string | undefined;
    try { result = await perform(pool, config, structuredClone(claimed.job), client, observation => observeJob(pool, config, claimed.job!, observation)); }
    catch (error) { failure = errorCode(error); }
    await finishJob(pool, claimed.job, result, failure);
    return 1;
  } finally {
    let broken = false;
    if (slot !== undefined) {
      try { await guard.query('SELECT pg_advisory_unlock(771042,$1::integer)', [slot]); }
      catch { broken = true; }
    }
    guard.release(broken);
  }
}
