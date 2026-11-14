import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { Config } from './config.js';
import { id, transaction } from './db.js';
import { ApiError, invalid } from './errors.js';
import { lockAuthenticated, requireSession, requireWrite, type Session } from './security.js';
import { createAssetStore } from './asset-storage.js';
import { requireMenuIdle, readConfirmedMenu, readMenuDraft, menuItemCount } from './menu-access.js';
import {
  localWebsiteOrigin, ownedWebsiteRestaurant, publicationView, readyWebsiteVersion, requireWebsiteAI,
  requireWebsiteRestaurant, websiteAudit, websiteFingerprint, websiteJobColumns, websiteSettings,
  websiteSnapshot, websiteVersionColumns, websiteJobView, type WebsiteJobRecord, type WebsiteMessage,
  websiteUsageNumber, websiteUsageSummary, type WebsiteJob,
  type WebsiteRestaurant, type WebsiteAgent as Agent, type WebsiteState, type WebsiteVersion,
} from './website-access.js';

const base = '/api/v1/restaurants/:restaurantId/website';
function privateHeaders(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
}
function params(request: FastifyRequest): { rid: string; vid?: string; jid?: string } {
  const p = request.params as { restaurantId: string; versionId?: string; jobId?: string };
  for (const value of [p.restaurantId, p.versionId, p.jobId]) {
    if (value !== undefined && !/^[A-Za-z0-9_-]{16,64}$/.test(value)) throw new ApiError(400);
  }
  if (Object.keys(request.query as object).length) throw new ApiError(400);
  return { rid: p.restaurantId, vid: p.versionId, jid: p.jobId };
}
function body(request: FastifyRequest, required: string[], optional: string[] = []): Record<string, unknown> {
  const value = request.body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('body');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !required.includes(key) && !optional.includes(key)) || required.some(key => !Object.hasOwn(result, key))) invalid('body', 'UNKNOWN_OR_MISSING_FIELDS');
  return result;
}
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > max || value.includes('\0')) invalid(field);
  return value;
}
function revision(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2147483646) invalid(field);
  return value as number;
}
function objectId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(value)) invalid(field);
  return value;
}
function idem(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{16,128}$/.test(key)) throw new ApiError(400);
  return key;
}
async function locked<T>(pool: Pool, config: Config, session: Session, rid: string,
  run: (db: PoolClient, row: WebsiteRestaurant) => Promise<T>): Promise<T> {
  return transaction(pool, async db => {
    await lockAuthenticated(db, config, session);
    return run(db, await ownedWebsiteRestaurant(db, session.user.id, rid, true));
  });
}
async function initialize(db: PoolClient, rid: string): Promise<Agent> {
  await db.query('INSERT INTO website_agents(id,restaurant_id) VALUES($1,$2) ON CONFLICT(restaurant_id) DO NOTHING', [id('wsa'), rid]);
  await db.query('INSERT INTO website_publications(restaurant_id) VALUES($1) ON CONFLICT(restaurant_id) DO NOTHING', [rid]);
  return (await db.query<Agent>('SELECT id,revision,messages,design_brief FROM website_agents WHERE restaurant_id=$1 FOR UPDATE', [rid])).rows[0]!;
}
async function replayJob(db: PoolClient, rid: string, userId: string, kind: string, key: string, fingerprint: string): Promise<WebsiteJobRecord | undefined> {
  const result = await db.query<WebsiteJobRecord & { request_fingerprint: string }>(`SELECT ${websiteJobColumns},request_fingerprint FROM website_jobs
    WHERE restaurant_id=$1 AND requesting_user_id=$2 AND kind=$3 AND idempotency_key=$4`, [rid, userId, kind, key]);
  if (result.rows[0]?.request_fingerprint !== undefined && result.rows[0].request_fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT');
  return result.rows[0];
}
async function quota(db: PoolClient, userId: string, rid: string, generate: boolean): Promise<void> {
  if ((await db.query(`SELECT id FROM website_jobs WHERE restaurant_id=$1 AND status IN ('queued','running') LIMIT 1`, [rid])).rowCount) throw new ApiError(409, 'WEBSITE_JOB_BUSY');
  await requireMenuIdle(db, rid);
  const daily = await db.query(`SELECT count(*)::int AS n FROM (
    SELECT id FROM website_jobs WHERE requesting_user_id=$1 AND created_at>clock_timestamp()-interval '24 hours'
    UNION ALL SELECT id FROM menu_jobs WHERE requesting_user_id=$1 AND created_at>clock_timestamp()-interval '24 hours'
    LIMIT 30) jobs`, [userId]);
  if (daily.rows[0].n >= 30) throw new ApiError(429, 'WEBSITE_DAILY_LIMIT');
  if (generate) {
    const versions = await db.query('SELECT count(*)::int AS n FROM (SELECT id FROM website_versions WHERE restaurant_id=$1 LIMIT 20) versions', [rid]);
    if (versions.rows[0].n >= 20) throw new ApiError(409, 'WEBSITE_VERSION_LIMIT');
  }
}
function jobReply(reply: FastifyReply, job: WebsiteJobRecord) {
  return reply.code(202).send({ job_id: job.id, status: job.status });
}
export function registerWebsites(app: FastifyInstance, pool: Pool, config: Config): void {
  const store = createAssetStore(config);
  app.addHook('onClose', async () => store.close());
  app.get(base, async (request, reply) => {
    privateHeaders(reply);
    const session = await requireSession(pool, config, request), { rid } = params(request);
    const result = await locked(pool, config, session, rid, async db => {
      const agent = (await db.query<Agent>('SELECT id,revision,messages,design_brief FROM website_agents WHERE restaurant_id=$1', [rid])).rows[0];
      const publication = (await db.query('SELECT revision,published_version_id,slug FROM website_publications WHERE restaurant_id=$1', [rid])).rows[0];
      const versions = await db.query<WebsiteVersion>(`SELECT ${websiteVersionColumns} FROM website_versions WHERE restaurant_id=$1 ORDER BY version_number DESC LIMIT 20`, [rid]);
      const jobs = await db.query<WebsiteJobRecord>(`SELECT ${websiteJobColumns} FROM website_jobs WHERE restaurant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20`, [rid]);
      return { agent: agent ?? { id: null, revision: 0, messages: [], design_brief: '' },
        versions: versions.rows.map(version => ({ id: version.id, restaurant_id: version.restaurant_id,
          version_number: version.version_number, summary: version.summary, created_at: version.created_at.toISOString(),
          checksum: version.checksum, asset_ids: version.asset_ids })), jobs: jobs.rows.map(websiteJobView),
        publication: publicationView(config, publication), model: websiteSettings(config)?.model ?? 'deepseek-flash',
        model_configured: Boolean(websiteSettings(config)?.apiKey?.trim()), menu_recognition_enabled: true,
        menu: await (async () => { const draft = await readMenuDraft(db, rid); return { revision: draft?.revision ?? 0, status: draft?.status ?? 'empty', item_count: draft ? menuItemCount(draft.data) : 0 }; })() } satisfies WebsiteState;
    });
    return result;
  });
  app.post(`${base}/messages`, async (request, reply) => {
    privateHeaders(reply);
    const session = (await requireWrite(pool, config, request))!, { rid } = params(request);
    const value = body(request, ['message', 'expected_revision']);
    const input = { message: text(value.message, 'message', 2000), expected_revision: revision(value.expected_revision, 'expected_revision') };
    const key = idem(request), fingerprint = websiteFingerprint(input);
    const job = await locked(pool, config, session, rid, async (db, row) => {
      const existing = await replayJob(db, rid, session.user.id, 'chat', key, fingerprint);
      if (existing) return existing;
      requireWebsiteAI(config); requireWebsiteRestaurant(row);
      const current = await initialize(db, rid);
      if (current.revision !== input.expected_revision) throw new ApiError(409, 'AGENT_REVISION_CONFLICT');
      await quota(db, session.user.id, rid, false);
      const messages: WebsiteMessage[] = [...current.messages, { role: 'user' as const, content: input.message }].slice(-24);
      const snapshot = await websiteSnapshot(db, row, []), jid = id('wsj');
      await db.query('UPDATE website_agents SET messages=$2,revision=revision+1,updated_at=clock_timestamp() WHERE restaurant_id=$1', [rid, JSON.stringify(messages)]);
      const inserted = await db.query<WebsiteJobRecord>(`INSERT INTO website_jobs(id,restaurant_id,requesting_user_id,kind,idempotency_key,request_fingerprint,input,snapshot,agent_revision)
        VALUES($1,$2,$3,'chat',$4,$5,$6,$7,$8) RETURNING ${websiteJobColumns}`,
      [jid, rid, session.user.id, key, fingerprint, JSON.stringify({ ...input, messages: messages.slice(-20) }), JSON.stringify(snapshot), current.revision + 1]);
      await websiteAudit(db, session.user.id, rid, jid, 'website_chat', request.id);
      return inserted.rows[0]!;
    });
    return jobReply(reply, job);
  });
  app.post(`${base}/generations`, async (request, reply) => {
    privateHeaders(reply);
    const session = (await requireWrite(pool, config, request))!, { rid } = params(request);
    const value = body(request, ['brief', 'asset_ids', 'public_assets_confirmed', 'expected_restaurant_revision'], ['expected_menu_revision']);
    if (value.public_assets_confirmed !== true) invalid('public_assets_confirmed', 'CONFIRMATION_REQUIRED');
    if (!Array.isArray(value.asset_ids) || value.asset_ids.length > 8 || value.asset_ids.some(aid => typeof aid !== 'string' || !/^ast_[A-Za-z0-9_-]{24}$/.test(aid)) || new Set(value.asset_ids).size !== value.asset_ids.length) invalid('asset_ids');
    const input = { brief: text(value.brief, 'brief', 3000), asset_ids: value.asset_ids as string[], public_assets_confirmed: true as const,
      expected_restaurant_revision: revision(value.expected_restaurant_revision, 'expected_restaurant_revision'),
      ...(Object.hasOwn(value, 'expected_menu_revision') ? { expected_menu_revision: revision(value.expected_menu_revision, 'expected_menu_revision') } : {}) };
    const key = idem(request), fingerprint = websiteFingerprint(input);
    const job = await locked(pool, config, session, rid, async (db, row) => {
      const existing = await replayJob(db, rid, session.user.id, 'generate', key, fingerprint);
      if (existing) return existing;
      requireWebsiteAI(config); requireWebsiteRestaurant(row);
      if (row.revision !== input.expected_restaurant_revision) throw new ApiError(412, 'RESTAURANT_REVISION_CONFLICT');
      await quota(db, session.user.id, rid, true);
      const menuDraft = await readMenuDraft(db, rid);
      if (input.expected_menu_revision !== undefined && input.expected_menu_revision !== (menuDraft?.revision ?? 0)) throw new ApiError(409, 'MENU_REVISION_CONFLICT');
      const confirmedMenu = await readConfirmedMenu(db, rid);
      const snapshot = await websiteSnapshot(db, row, input.asset_ids, true);
      snapshot.menu = confirmedMenu;
      await initialize(db, rid);
      const jid = id('wsj');
      const inserted = await db.query<WebsiteJobRecord>(`INSERT INTO website_jobs(id,restaurant_id,requesting_user_id,kind,idempotency_key,request_fingerprint,input,snapshot)
        VALUES($1,$2,$3,'generate',$4,$5,$6,$7) RETURNING ${websiteJobColumns}`,
      [jid, rid, session.user.id, key, fingerprint, JSON.stringify(input), JSON.stringify(snapshot)]);
      for (const asset of snapshot.assets) await db.query(`INSERT INTO asset_references(id,restaurant_id,asset_id,purpose,resource_id)
        VALUES($1,$2,$3,'website_job',$4)`, [id('ref'), rid, asset.id, jid]);
      await websiteAudit(db, session.user.id, rid, jid, 'website_generate', request.id);
      return inserted.rows[0]!;
    });
    return jobReply(reply, job);
  });
  app.post(`${base}/publication`, async (request, reply) => {
    privateHeaders(reply);
    const session = (await requireWrite(pool, config, request))!, { rid } = params(request);
    const value = body(request, ['version_id', 'expected_revision'], ['slug']);
    const input = { version_id: objectId(value.version_id, 'version_id'), expected_revision: revision(value.expected_revision, 'expected_revision'),
      ...(Object.hasOwn(value, 'slug') ? { slug: value.slug } : {}) };
    if (input.slug !== undefined && (typeof input.slug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(input.slug) || ['admin', 'api', 'auth', 'www'].includes(input.slug))) invalid('slug');
    const key = idem(request), fingerprint = websiteFingerprint(input);
    // 发布前核验真实资源；文件/S3 I/O不占用户和餐厅行锁，最终提交再次核验版本归属。
    await ownedWebsiteRestaurant(pool, session.user.id, rid);
    if (!localWebsiteOrigin(config)) throw new ApiError(503, 'PUBLIC_DEPLOYMENT_UNCONFIGURED');
    const alreadyApplied = (await pool.query('SELECT id FROM website_publish_actions WHERE restaurant_id=$1 AND requesting_user_id=$2 AND idempotency_key=$3', [rid, session.user.id, key])).rowCount;
    if (!alreadyApplied) {
      const version = await readyWebsiteVersion(pool, rid, input.version_id);
      for (const asset of version.snapshot.assets) {
        const stored = (await pool.query('SELECT storage_backend,storage_key,size_bytes,checksum FROM assets WHERE restaurant_id=$1 AND id=$2 AND status=$3', [rid, asset.id, 'ready'])).rows[0];
        if (!stored) throw new ApiError(404);
        await store.read(stored.storage_backend, stored.storage_key, stored.size_bytes, stored.checksum);
      }
    }
    const result = await locked(pool, config, session, rid, async (db, row) => {
      const existing = (await db.query(`SELECT request_fingerprint,result FROM website_publish_actions
        WHERE restaurant_id=$1 AND requesting_user_id=$2 AND idempotency_key=$3`, [rid, session.user.id, key])).rows[0];
      if (existing && existing.request_fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT');
      const origin = localWebsiteOrigin(config);
      if (!origin) throw new ApiError(503, 'PUBLIC_DEPLOYMENT_UNCONFIGURED');
      requireWebsiteRestaurant(row);
      if (existing) return existing.result;
      await initialize(db, rid);
      const current = (await db.query('SELECT revision,published_version_id,slug FROM website_publications WHERE restaurant_id=$1 FOR UPDATE', [rid])).rows[0]!;
      if (current.revision !== input.expected_revision) throw new ApiError(409, 'PUBLICATION_REVISION_CONFLICT');
      if (current.slug && input.slug !== undefined && current.slug !== input.slug) throw new ApiError(409, 'WEBSITE_SLUG_IMMUTABLE');
      const slug = current.slug ?? input.slug;
      if (!slug) invalid('slug', 'FIRST_PUBLICATION_REQUIRES_SLUG');
      await readyWebsiteVersion(db, rid, input.version_id);
      // 唯一索引处理不同餐厅的并发注册；不以先查后写冒充全局唯一。
      try {
        await db.query(`UPDATE website_publications SET revision=revision+1,published_version_id=$2,slug=$3,
          deployment_mode='local',updated_at=clock_timestamp() WHERE restaurant_id=$1`, [rid, input.version_id, slug]);
      } catch (error) {
        if ((error as { code?: string; constraint?: string }).code === '23505' && (error as { constraint?: string }).constraint === 'website_publications_slug_key') throw new ApiError(409, 'WEBSITE_SLUG_CONFLICT');
        throw error;
      }
      const published = publicationView(config, { revision: current.revision + 1, published_version_id: input.version_id, slug });
      await db.query(`INSERT INTO website_publish_actions(id,restaurant_id,requesting_user_id,idempotency_key,request_fingerprint,version_id,result)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [id('wsp'), rid, session.user.id, key, fingerprint, input.version_id, JSON.stringify(published)]);
      await websiteAudit(db, session.user.id, rid, input.version_id, 'website_publish', request.id);
      return published;
    });
    return result;
  });
  app.get(`${base}/versions/:versionId/preview`, async (request, reply) => {
    privateHeaders(reply);
    const session = await requireSession(pool, config, request), { rid, vid } = params(request);
    return locked(pool, config, session, rid, async db => {
      const version = await readyWebsiteVersion(db, rid, vid!);
      // HTML 仅作为 JSON 字符串返回，后台域名绝不执行生成内容。
      return { html: version.html, checksum: version.checksum, assets: version.snapshot.assets.map(asset => ({ id: asset.id,
        content_url: `/api/v1/restaurants/${rid}/assets/${asset.id}/content`, mime_type: asset.mime_type })) };
    });
  });
  app.get(`${base}/jobs/:jobId/usage`, async (request, reply) => {
    privateHeaders(reply);
    const session = await requireSession(pool, config, request), { rid, jid } = params(request);
    return locked(pool, config, session, rid, async db => {
      const job = (await db.query<Pick<WebsiteJob, 'id' | 'progress' | 'usage'>>('SELECT id,progress,usage FROM website_jobs WHERE restaurant_id=$1 AND id=$2', [rid, jid])).rows[0];
      if (!job) throw new ApiError(404);
      const summary = await websiteUsageSummary(db, job.id);
      const rows = await db.query(`SELECT call_index,status,prompt_tokens,completion_tokens,total_tokens,elapsed_ms,error_code
        FROM website_model_calls WHERE job_id=$1 ORDER BY call_index`, [job.id]);
      const calls = rows.rows.map(row => ({ index: row.call_index, status: row.status,
        prompt_tokens: row.prompt_tokens === null ? null : websiteUsageNumber(row.prompt_tokens),
        completion_tokens: row.completion_tokens === null ? null : websiteUsageNumber(row.completion_tokens),
        total_tokens: row.total_tokens === null ? null : websiteUsageNumber(row.total_tokens),
        elapsed_ms: row.elapsed_ms === null ? null : websiteUsageNumber(row.elapsed_ms), error_code: row.error_code }));
      // 迁移前只有累计 total 的任务单独标识；不能伪造输入/输出为零或将历史账单当成新逐次记录。
      const legacy = job.usage as { model_calls?: unknown; total_tokens?: unknown } | null | undefined;
      const legacyCalls = summary.model_calls === 0 ? websiteUsageNumber(legacy?.model_calls ?? job.progress?.model_calls ?? 0) : 0;
      const legacyTotal = legacy?.total_tokens ?? job.progress?.total_tokens;
      return { job_id: job.id, calls, totals: summary.totals, unknown_usage_calls: summary.unknown_usage_calls + legacyCalls,
        ...(legacyCalls ? { legacy_summary: { model_calls: legacyCalls, total_tokens: legacyTotal == null ? null : websiteUsageNumber(legacyTotal),
          prompt_tokens: null, completion_tokens: null } } : {}) };
    });
  });
  app.post(`${base}/jobs/:jobId/cancel`, async (request, reply) => {
    privateHeaders(reply);
    const session = (await requireWrite(pool, config, request))!, { rid, jid } = params(request);
    const value = body(request, ['confirmed']);
    if (value.confirmed !== true) invalid('confirmed', 'CONFIRMATION_REQUIRED');
    return locked(pool, config, session, rid, async db => {
      const job = (await db.query<WebsiteJob>('SELECT * FROM website_jobs WHERE restaurant_id=$1 AND id=$2 FOR UPDATE', [rid, jid])).rows[0];
      if (!job) throw new ApiError(404);
      if (job.status === 'failed' && job.error_code === 'AGENT_CANCELLED') return { job_id: job.id, status: 'failed' };
      if (job.status !== 'queued' && job.status !== 'running') throw new ApiError(409, 'JOB_ALREADY_FINISHED');
      await db.query(`UPDATE website_jobs SET status='failed',error_code='AGENT_CANCELLED',lease_token=NULL,lease_expires_at=NULL,
        progress=CASE WHEN progress IS NULL THEN jsonb_build_object('phase','failed','round',0,'model_calls',0,'total_tokens',0,
          'plan','[]'::jsonb,'diagnostics','[]'::jsonb) ELSE jsonb_set(progress,'{phase}','"failed"'::jsonb) END,
        updated_at=clock_timestamp() WHERE id=$1`, [job.id]);
      await db.query(`DELETE FROM asset_references WHERE restaurant_id=$1 AND purpose='website_job' AND resource_id=$2`, [rid, job.id]);
      await websiteAudit(db, session.user.id, rid, job.id, 'website_job_failed', request.id);
      return { job_id: job.id, status: 'failed' };
    });
  });
  app.get(`${base}/jobs/:jobId`, async (request, reply) => {
    privateHeaders(reply);
    const session = await requireSession(pool, config, request), { rid, jid } = params(request);
    return locked(pool, config, session, rid, async db => {
      const job = (await db.query<WebsiteJobRecord>(`SELECT ${websiteJobColumns} FROM website_jobs WHERE restaurant_id=$1 AND id=$2`, [rid, jid])).rows[0];
      if (!job) throw new ApiError(404);
      return websiteJobView(job);
    });
  });
}
