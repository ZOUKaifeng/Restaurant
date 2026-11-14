import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Config } from './config.js';
import { transaction } from './db.js';
import { ApiError } from './errors.js';
import { recognizeMenuImages } from './deepseek.js';
import { createAssetStore } from './asset-storage.js';
import { checksum, MAX_IMAGE_BYTES, MAX_UPLOAD_BYTES } from './asset-validation.js';
import { normalizeMenuData, type MenuData, type MenuImageInput, type MenuRecognitionOutput } from './menu-data.js';
import { menuAudit, menuDraftColumns, requireMenuAI, type MenuDraftRecord, type MenuJob, type MenuSource } from './menu-access.js';

export type MenuRecognizer = (config: Config, images: MenuImageInput[], beforeSend?: () => Promise<void>) => Promise<MenuRecognitionOutput>;
const safeErrors = new Set(['AI_NOT_CONFIGURED', 'AI_BALANCE_INSUFFICIENT', 'AI_RATE_LIMITED', 'AI_AUTH_FAILED',
  'AI_PROVIDER_UNAVAILABLE', 'AI_TIMEOUT', 'AI_RESPONSE_INVALID', 'AI_OUTPUT_INVALID', 'MENU_SOURCE_UNAVAILABLE']);
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
  // 不保存异常 message、供应商正文、模型输入、base64 或 usage。
  return 'AI_PROVIDER_UNAVAILABLE';
}
async function lockWorkerContext(db: PoolClient, job: Pick<MenuJob, 'requesting_user_id' | 'restaurant_id'>): Promise<boolean> {
  const user = (await db.query('SELECT id,status,email_verified_at FROM users WHERE id=$1 FOR UPDATE', [job.requesting_user_id])).rows[0];
  const restaurant = (await db.query('SELECT id,status FROM restaurants WHERE id=$1 FOR UPDATE', [job.restaurant_id])).rows[0];
  const member = (await db.query(`SELECT id FROM restaurant_members WHERE restaurant_id=$1 AND user_id=$2
    AND role='owner' AND status='active' FOR UPDATE`, [job.restaurant_id, job.requesting_user_id])).rows[0];
  return Boolean(user?.status === 'active' && user.email_verified_at && restaurant && ['draft', 'active'].includes(restaurant.status) && member);
}
function validSources(job: MenuJob): boolean {
  return Array.isArray(job.sources) && job.sources.length >= 1 && job.sources.length <= 4 &&
    job.input?.consent_to_ai_processing === true && job.input.expected_revision === job.expected_revision &&
    JSON.stringify(job.input.asset_ids) === JSON.stringify(job.sources.map(source => source?.id)) &&
    new Set(job.sources.map(source => source.id)).size === job.sources.length &&
    job.sources.every(source => source && /^ast_[A-Za-z0-9_-]{24}$/.test(source.id) &&
      ['image/jpeg', 'image/png'].includes(source.mime_type) && /^[a-f0-9]{64}$/.test(source.checksum) &&
      Number.isSafeInteger(source.size_bytes) && source.size_bytes >= 1 && source.size_bytes <= MAX_IMAGE_BYTES &&
      ['local', 's3'].includes(source.storage_backend) && source.storage_key === `${job.restaurant_id}/${source.id}.${source.mime_type === 'image/png' ? 'png' : 'jpg'}`) &&
    job.sources.reduce((total, source) => total + source.size_bytes, 0) <= MAX_UPLOAD_BYTES;
}
async function sourcesCurrent(db: PoolClient, job: MenuJob): Promise<boolean> {
  if (!validSources(job)) return false;
  const assets = (await db.query<MenuSource & { status: string; kind: string }>(`SELECT id,mime_type,checksum,size_bytes,storage_key,storage_backend,status,kind
    FROM assets WHERE restaurant_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE`, [job.restaurant_id, job.input.asset_ids])).rows;
  if (assets.length !== job.sources.length || assets.some(asset => {
    const source = job.sources.find(saved => saved.id === asset.id);
    return !source || asset.status !== 'ready' || asset.kind !== 'menu_source' ||
      asset.mime_type !== source.mime_type || asset.checksum !== source.checksum || asset.size_bytes !== source.size_bytes ||
      asset.storage_key !== source.storage_key || asset.storage_backend !== source.storage_backend;
  })) return false;
  const refs = (await db.query(`SELECT asset_id FROM asset_references WHERE restaurant_id=$1 AND purpose='menu_job' AND resource_id=$2 ORDER BY asset_id`, [job.restaurant_id, job.id])).rows;
  return refs.length === job.sources.length && refs.every(ref => job.sources.some(source => source.id === ref.asset_id));
}
async function failJob(db: PoolClient, job: MenuJob, code: string): Promise<void> {
  await db.query(`UPDATE menu_jobs SET status='failed',error_code=$2,lease_token=NULL,lease_expires_at=NULL,
    updated_at=clock_timestamp() WHERE id=$1`, [job.id, code]);
  await db.query("DELETE FROM asset_references WHERE restaurant_id=$1 AND purpose='menu_job' AND resource_id=$2", [job.restaurant_id, job.id]);
  await menuAudit(db, job.requesting_user_id, job.restaurant_id, job.id, 'menu_job_failed', job.id);
}
async function draftForJob(db: PoolClient, job: MenuJob): Promise<MenuDraftRecord | undefined> {
  return (await db.query<MenuDraftRecord>(`SELECT ${menuDraftColumns} FROM menu_drafts WHERE restaurant_id=$1 FOR UPDATE`, [job.restaurant_id])).rows[0];
}
async function claimJob(pool: Pool): Promise<{ job?: MenuJob; consumed: boolean }> {
  return transaction(pool, async db => {
    const candidate = (await db.query<MenuJob>(`SELECT id,restaurant_id,requesting_user_id FROM menu_jobs
      WHERE status='queued' OR (status='running' AND lease_expires_at<=clock_timestamp())
      ORDER BY CASE WHEN status='running' THEN 0 ELSE 1 END,created_at,id LIMIT 1`)).rows[0];
    if (!candidate) return { consumed: false };
    const valid = await lockWorkerContext(db, candidate);
    const job = (await db.query<MenuJob>(`SELECT * FROM menu_jobs WHERE id=$1 AND
      (status='queued' OR (status='running' AND lease_expires_at<=clock_timestamp())) FOR UPDATE SKIP LOCKED`, [candidate.id])).rows[0];
    if (!job) return { consumed: false };
    const draft = await draftForJob(db, job);
    let failure: string | undefined;
    if (job.status === 'running') failure = 'JOB_INTERRUPTED';
    else if (!valid) failure = 'MENU_CONTEXT_REVOKED';
    else if (!draft || draft.revision !== job.expected_revision) failure = 'MENU_CONTEXT_CHANGED';
    else if (!await sourcesCurrent(db, job)) failure = 'MENU_SOURCE_UNAVAILABLE';
    if (failure) { await failJob(db, job, failure); return { consumed: true }; }
    const running = (await db.query<MenuJob>(`UPDATE menu_jobs SET status='running',lease_token=$2,
      lease_expires_at=clock_timestamp()+interval '3 minutes',updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [job.id, randomUUID()])).rows[0]!;
    return { job: running, consumed: true };
  });
}
async function readImages(config: Config, job: MenuJob): Promise<MenuImageInput[]> {
  try {
    if (!validSources(job)) throw new ApiError(503);
    const store = createAssetStore(config);
    try {
      const images: MenuImageInput[] = [];
      let total = 0;
      for (const source of job.sources) {
        const bytes = await store.read(source.storage_backend, source.storage_key, source.size_bytes, source.checksum);
        total += bytes.length;
        if (!Buffer.isBuffer(bytes) || bytes.length !== source.size_bytes || bytes.length > MAX_IMAGE_BYTES ||
          total > MAX_UPLOAD_BYTES || checksum(bytes) !== source.checksum) throw new ApiError(503);
        images.push({ bytes, mime_type: source.mime_type });
      }
      return images;
    } finally { store.close(); }
  } catch { throw new ApiError(503, 'MENU_SOURCE_UNAVAILABLE'); }
}
// 文件全部读取后、付费调用前，再按同一锁序核验授权、租约、菜单 revision 和服务器来源快照。
async function beforePaidCall(pool: Pool, original: MenuJob): Promise<boolean> {
  return transaction(pool, async db => {
    const valid = await lockWorkerContext(db, original);
    const job = (await db.query<MenuJob & { expired: boolean }>(`SELECT *,lease_expires_at<=clock_timestamp() AS expired FROM menu_jobs WHERE id=$1 FOR UPDATE`, [original.id])).rows[0];
    if (!job || job.status !== 'running' || job.lease_token !== original.lease_token) return false;
    const draft = await draftForJob(db, job);
    const failure = !valid ? 'MENU_CONTEXT_REVOKED' : job.expired ? 'JOB_INTERRUPTED' :
      !draft || draft.revision !== job.expected_revision ? 'MENU_CONTEXT_CHANGED' :
      !await sourcesCurrent(db, job) ? 'MENU_SOURCE_UNAVAILABLE' : undefined;
    if (failure) { await failJob(db, job, failure); return false; }
    const lease = (await db.query("SELECT $1::timestamptz>clock_timestamp()+interval '80 seconds' AS valid", [job.lease_expires_at])).rows[0]!;
    if (!lease.valid) { await failJob(db, job, 'JOB_INTERRUPTED'); return false; }
    return true;
  });
}
async function finishJob(pool: Pool, original: MenuJob, data?: MenuData, failure?: string): Promise<void> {
  await transaction(pool, async db => {
    const valid = await lockWorkerContext(db, original);
    const job = (await db.query<MenuJob & { expired: boolean }>(`SELECT *,lease_expires_at<=clock_timestamp() AS expired FROM menu_jobs WHERE id=$1 FOR UPDATE`, [original.id])).rows[0];
    if (!job || job.status !== 'running' || job.lease_token !== original.lease_token) return;
    const draft = await draftForJob(db, job);
    const code = !valid ? 'MENU_CONTEXT_REVOKED' : job.expired ? 'JOB_INTERRUPTED' :
      !draft || draft.revision !== job.expected_revision ? 'MENU_CONTEXT_CHANGED' : failure;
    if (code) { await failJob(db, job, code); return; }
    if (!await sourcesCurrent(db, job)) { await failJob(db, job, 'MENU_SOURCE_UNAVAILABLE'); return; }
    if (!data) { await failJob(db, job, 'AI_OUTPUT_INVALID'); return; }
    const lease = (await db.query('SELECT $1::timestamptz>clock_timestamp() AS valid', [job.lease_expires_at])).rows[0]!;
    if (!lease.valid) { await failJob(db, job, 'JOB_INTERRUPTED'); return; }
    const normalized = normalizeMenuData(data, true), next = job.expected_revision + 1;
    await db.query(`UPDATE menu_drafts SET data=$2,revision=$3,status='draft',source_asset_ids=$4,
      confirmed_at=NULL,updated_at=clock_timestamp() WHERE restaurant_id=$1`, [job.restaurant_id, JSON.stringify(normalized), next, job.input.asset_ids]);
    await db.query(`UPDATE menu_jobs SET status='succeeded',result_revision=$2,lease_token=NULL,lease_expires_at=NULL,
      updated_at=clock_timestamp() WHERE id=$1`, [job.id, next]);
    // 成功来源引用永久保留；人工编辑和后续识别不删除历史 menu_job 引用。
    await menuAudit(db, job.requesting_user_id, job.restaurant_id, draft!.id, 'menu_updated', job.id);
  });
}

// 与 website-worker 共用跨进程的两个会话 advisory 槽位，模型及存储 I/O 不持有数据库事务。
export async function runMenuJobs(pool: Pool, config: Config, recognizer: MenuRecognizer = recognizeMenuImages): Promise<number> {
  const guard = await pool.connect();
  let slot: number | undefined;
  try {
    for (const candidate of [0, 1]) {
      if ((await guard.query('SELECT pg_try_advisory_lock(771042,$1::integer) AS locked', [candidate])).rows[0].locked) { slot = candidate; break; }
    }
    if (slot === undefined) return 0;
    const claimed = await claimJob(pool);
    if (!claimed.job) return claimed.consumed ? 1 : 0;
    const job = claimed.job;
    let data: MenuData | undefined, failure: string | undefined;
    try {
      requireMenuAI(config);
      const images = await readImages(config, job);
      if (!await beforePaidCall(pool, job)) return 1;
      const output = await recognizer(config, images, async () => {
        if (!await beforePaidCall(pool, job)) throw new ApiError(503, 'MENU_SEND_CANCELLED');
      });
      data = normalizeMenuData(output?.data, true);
    } catch (error) { failure = errorCode(error); }
    await finishJob(pool, job, data, failure);
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
