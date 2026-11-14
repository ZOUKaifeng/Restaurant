import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Config } from './config.js';
import { id, transaction } from './db.js';
import { ApiError } from './errors.js';
import { callWebsiteAgent, generateWebsite } from './deepseek.js';
import { renderWebsite } from './website-html.js';
import { runWebsiteAgent } from './website-react.js';
import type { WebsiteAgentObservation } from './website-agent-types.js';
import {
  requireWebsiteAI, verifyWebsiteVersion, websiteAudit, websiteUsageNumber, websiteUsageSummary, type WebsiteJob, type WebsiteMessage,
  type WebsiteVersion,
} from './website-access.js';

export interface WebsiteJobClient { chat: typeof callWebsiteAgent; generate: typeof generateWebsite; react?: typeof runWebsiteAgent }
const actualClient: WebsiteJobClient = { chat: callWebsiteAgent, generate: generateWebsite, react: runWebsiteAgent };
const safeErrors = new Set(['AI_NOT_CONFIGURED', 'AI_CONFIGURATION_INVALID', 'AI_BALANCE_INSUFFICIENT', 'AI_RATE_LIMITED', 'AI_AUTH_FAILED',
  'AI_PROVIDER_UNAVAILABLE', 'AI_TIMEOUT', 'AI_RESPONSE_INVALID', 'AI_OUTPUT_INVALID', 'AI_USAGE_UNAVAILABLE', 'AI_USAGE_INVALID', 'AI_OUTPUT_TRUNCATED', 'WEBSITE_HTML_INVALID',
  'WEBSITE_HTML_TOO_LARGE', 'WEBSITE_CHECKSUM_INVALID', 'WEBSITE_MANIFEST_INVALID',
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
  const user = (await db.query('SELECT id,status,email_verified_at FROM users WHERE id=$1 FOR UPDATE', [candidate.requesting_user_id])).rows[0];
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
async function observeJob(pool: Pool, original: WebsiteJob, observation: WebsiteAgentObservation): Promise<void> {
  const call = observedCall(observation);
  const code = await transaction(pool, async db => {
    const valid = await lockWorkerContext(db, original);
    const job = (await db.query<WebsiteJob & { remaining: number | null }>(`SELECT *,
      extract(epoch FROM lease_expires_at-clock_timestamp())::float8 AS remaining
      FROM website_jobs WHERE id=$1 FOR UPDATE`, [original.id])).rows[0];
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
        const previous = (await db.query('SELECT status,runner_token FROM website_model_calls WHERE job_id=$1 AND call_index=$2', [job.id, call.index])).rows[0];
        // completed 回调因取消而抛错后，ReAct 的 failed 回调不得覆盖已知账单。
        if (call.status !== 'failed' || !previous || previous.runner_token !== original.lease_token || previous.status === 'started') return 'AI_USAGE_INVALID';
        return undefined;
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
      const inserted = await db.query(`INSERT INTO website_model_calls(job_id,call_index,runner_token,status,elapsed_ms)
        VALUES($1,$2,$3,'started',$4) ON CONFLICT(job_id,call_index) DO NOTHING`, [job.id, call.index, original.lease_token, call.elapsed_ms]);
      if (!inserted.rowCount) return 'AI_USAGE_INVALID';
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
type Result = { kind: 'chat'; reply: string; design_brief: string } | { kind: 'generate'; version: WebsiteVersion };
function validText(value: unknown, max: number, empty = false): value is string {
  return typeof value === 'string' && (empty || Boolean(value.trim())) && !value.includes('\0') && Array.from(value).length <= max;
}
async function perform(config: Config, job: WebsiteJob, client: WebsiteJobClient, observe?: (obs: WebsiteAgentObservation) => Promise<void>): Promise<Result> {
  requireWebsiteAI(config);
  if (job.kind === 'chat') {
    const output = await client.chat(config, job.input.messages!.slice(-20), job.snapshot);
    if (!validText(output?.reply, 2000) || !validText(output?.design_brief, 3000, true)) throw new ApiError(503, 'AI_RESPONSE_INVALID');
    return { kind: 'chat', reply: output.reply, design_brief: output.design_brief };
  }
  // 旧单次生成仅服务于显式注入的历史 fixture；实际客户端始终执行 ReAct。
  const output = client.react
    ? await client.react(config, job.input.brief!, job.snapshot, observe!)
    : await client.generate(config, job.input.brief!, job.snapshot);
  if (!validText(output?.summary, client.react ? 800 : 2000) || !validText(output?.model, 100) ||
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
  return { kind: 'generate', version };
}
async function finishJob(pool: Pool, original: WebsiteJob, result?: Result, failure?: string): Promise<void> {
  await transaction(pool, async db => {
    const valid = await lockWorkerContext(db, original);
    const job = (await db.query<WebsiteJob & { expired: boolean }>(`SELECT *,lease_expires_at<=clock_timestamp() AS expired
      FROM website_jobs WHERE id=$1 FOR UPDATE`, [original.id])).rows[0];
    if (!job || job.status !== 'running' || job.lease_token !== original.lease_token) return;
    if (!valid || job.expired || failure) {
      await failJob(db, job, !valid ? 'WEBSITE_CONTEXT_REVOKED' : job.expired ? 'JOB_INTERRUPTED' : failure!);
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
      if (number > 20) { await failJob(db, job, 'WEBSITE_VERSION_LIMIT'); return; }
      const version = result.version;
      await db.query(`INSERT INTO website_versions(id,restaurant_id,version_number,summary,html,checksum,snapshot,asset_ids,model,usage)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [version.id, job.restaurant_id, number, version.summary,
        version.html, version.checksum, JSON.stringify(version.snapshot), version.asset_ids, version.model,
        version.usage === undefined ? null : JSON.stringify(version.usage)]);
      // 成功版本保留原 website_job 引用，永久保护版本所依赖的素材。
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
    try { result = await perform(config, claimed.job, client, observation => observeJob(pool, claimed.job!, observation)); }
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
