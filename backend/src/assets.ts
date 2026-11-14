import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { Config } from './config.js';
import { id, transaction, type Database } from './db.js';
import { ApiError, invalid } from './errors.js';
import { equal, lockAuthenticated, requireSession, requireWrite, type Session } from './security.js';
import { ASSET_KINDS, MAX_UPLOAD_BYTES, MAX_IMAGE_BYTES, checksum, sanitizeFilename, validateUpload, type AssetKind, type AssetMime } from './asset-validation.js';
import { createAssetStore, type AssetStore, type StorageBackend } from './asset-storage.js';

interface AssetRow {
  id: string; restaurant_id: string; kind: AssetKind; origin: 'upload'; original_filename: string;
  mime_type: AssetMime; size_bytes: number; checksum: string; width_px: number | null; height_px: number | null;
  alt_text: string | null; rights_confirmed_at: Date; safety_status: 'approved'; status: 'ready' | 'deleted'; revision: number;
  created_at: Date; updated_at: Date; can_delete: boolean; cursor_created_at: string;
  storage_backend: StorageBackend; storage_key: string; initial_request_fingerprint: string;
}
const select = `SELECT a.*,a.created_at::text AS cursor_created_at,
  (a.status='ready' AND NOT EXISTS(SELECT 1 FROM asset_references ar WHERE ar.restaurant_id=a.restaurant_id AND ar.asset_id=a.id)) AS can_delete FROM assets a`;
const base = '/api/v1/restaurants/:restaurantId/assets';
function parameters(request: FastifyRequest): { rid: string; aid?: string } {
  const params = request.params as { restaurantId: string; assetId?: string };
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(params.restaurantId)) throw new ApiError(400);
  if (params.assetId !== undefined && !/^[A-Za-z0-9_-]{16,64}$/.test(params.assetId)) throw new ApiError(400);
  return { rid: params.restaurantId, aid: params.assetId };
}
function queryOnly(request: FastifyRequest, allowed: string[]): Record<string, unknown> {
  const query = request.query as Record<string, unknown>;
  if (Object.keys(query).some(key => !allowed.includes(key))) throw new ApiError(400);
  return query;
}
async function owned(db: Database, session: Session, rid: string, lock = false): Promise<void> {
  const result = await db.query(`SELECT r.id FROM restaurants r JOIN restaurant_members m ON m.restaurant_id=r.id
    AND m.user_id=$1 AND m.status='active' AND m.role='owner' WHERE r.id=$2 ${lock ? 'FOR UPDATE OF r,m' : ''}`, [session.user.id, rid]);
  if (!result.rowCount) throw new ApiError(404);
}
async function asset(db: Database, rid: string, aid: string, lock = false): Promise<AssetRow> {
  if (lock) {
    const current = await db.query('SELECT id FROM assets WHERE restaurant_id=$1 AND id=$2 FOR UPDATE', [rid, aid]);
    if (!current.rowCount) throw new ApiError(404);
  }
  const result = await db.query<AssetRow>(`${select} WHERE a.restaurant_id=$1 AND a.id=$2`, [rid, aid]);
  if (!result.rows[0]) throw new ApiError(404);
  return result.rows[0];
}
function view(row: AssetRow) {
  // 只派生这一份公开结构，不将 storage_key、源校验值、幂等摘要或密钥带出数据库。
  return {
    id: row.id, restaurant_id: row.restaurant_id, kind: row.kind, origin: row.origin,
    original_filename: row.original_filename, mime_type: row.mime_type, size_bytes: row.size_bytes, checksum: row.checksum,
    width_px: row.width_px, height_px: row.height_px, alt_text: row.alt_text,
    rights_confirmed_at: row.rights_confirmed_at.toISOString(), safety_status: row.safety_status, status: row.status,
    revision: row.revision, created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
    can_delete: row.can_delete, content_url: `/api/v1/restaurants/${row.restaurant_id}/assets/${row.id}/content`,
  };
}
function etag(row: AssetRow): string { return `"asset-${row.id}-v${row.revision}"`; }
async function auditAsset(db: PoolClient, session: Session, action: 'upload_asset' | 'delete_asset', row: AssetRow, requestId: string): Promise<void> {
  await db.query(`INSERT INTO audit_logs(id,restaurant_id,actor_type,actor_user_id,action,entity_type,entity_id,request_id,outcome,changed_fields)
    VALUES($1,$2,'merchant',$3,$4,'asset',$5,$6,'success',$7)`,
  [id('aud'), row.restaurant_id, session.user.id, action, row.id, requestId, action === 'upload_asset' ? ['kind', 'original_filename', 'mime_type', 'rights_confirmed_at'] : ['status']]);
}
async function locked<T>(pool: Pool, config: Config, session: Session, rid: string, run: (db: PoolClient) => Promise<T>): Promise<T> {
  return transaction(pool, async db => {
    await lockAuthenticated(db, config, session);
    await owned(db, session, rid, true);
    return run(db);
  });
}
interface Cursor { v: 1; u: string; r: string; l: number; t: string; i: string }
function signCursor(config: Config, cursor: Cursor): string {
  const text = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return `${text}.${createHmac('sha256', config.cursorSecret).update(`assets\0${text}`).digest('base64url')}`;
}
function readCursor(config: Config, value: unknown, session: Session, rid: string, limit: number): Cursor {
  try {
    if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) throw new Error();
    const [text, signature] = value.split('.') as [string, string];
    if (!equal(createHmac('sha256', config.cursorSecret).update(`assets\0${text}`).digest('base64url'), signature)) throw new Error();
    const cursor = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Cursor;
    if (cursor.v !== 1 || cursor.u !== session.user.id || cursor.r !== rid || cursor.l !== limit ||
      typeof cursor.t !== 'string' || !Number.isFinite(Date.parse(cursor.t)) || typeof cursor.i !== 'string' || !/^ast_[A-Za-z0-9_-]{24}$/.test(cursor.i)) throw new Error();
    return cursor;
  } catch { throw new ApiError(400); }
}
function privateHeaders(reply: FastifyReply): FastifyReply {
  return reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').header('X-Content-Type-Options', 'nosniff');
}
async function removeDeleted(pool: Pool, store: AssetStore, row: Pick<AssetRow, 'id' | 'storage_backend' | 'storage_key'>): Promise<boolean> {
  let code: string | null = null;
  try { await store.remove(row.storage_backend, row.storage_key); } catch { code = 'STORAGE_DELETE_FAILED'; }
  await pool.query(`UPDATE assets SET last_error_code=$2 WHERE id=$1 AND status='deleted'`, [row.id, code]);
  return code === null;
}
// 后台按 next_cursor 循环扫描墓碑，覆盖逻辑删除提交后进程崩溃的情况；永远不递归或列举删除存储目录。
export async function cleanupDeletedAssets(pool: Pool, store: AssetStore, limit = 100, afterId?: string): Promise<{ processed: number; failed: number; next_cursor: string | null }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (afterId !== undefined && !/^ast_[A-Za-z0-9_-]{24}$/.test(afterId))) throw new Error('清理分页参数不合法');
  const result = await pool.query<AssetRow>(`SELECT id,storage_backend,storage_key FROM assets WHERE status='deleted'
    AND ($1::text IS NULL OR id>$1) ORDER BY id LIMIT $2`, [afterId ?? null, limit + 1]);
  const rows = result.rows.slice(0, limit);
  let failed = 0;
  for (const row of rows) if (!await removeDeleted(pool, store, row)) failed++;
  return { processed: rows.length, failed, next_cursor: result.rows.length > limit ? rows.at(-1)!.id : null };
}
interface UploadIntent {
  id: string; restaurant_id: string; storage_key: string; storage_backend: StorageBackend;
  expected_checksum: string; expected_size_bytes: number; attempt_marker: string;
  state: 'pending' | 'committed' | 'abandoned' | 'blocked' | 'cleaned'; expires_at: Date;
}
async function lockIntent<T>(pool: Pool, aid: string, run: (db: PoolClient, intent: UploadIntent) => Promise<T>): Promise<T | undefined> {
  return transaction(pool, async db => {
    const initial = await db.query<UploadIntent>('SELECT restaurant_id FROM asset_upload_intents WHERE id=$1', [aid]);
    if (!initial.rows[0]) return undefined;
    await db.query('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE', [initial.rows[0].restaurant_id]);
    const current = await db.query<UploadIntent>('SELECT * FROM asset_upload_intents WHERE id=$1 FOR UPDATE', [aid]);
    if (!current.rows[0]) return undefined;
    return run(db, current.rows[0]);
  });
}
async function hasAssetRecord(db: Database, intent: UploadIntent): Promise<boolean> {
  // 墓碑也受保护；正常逻辑删除的物理清理由 cleanupDeletedAssets 独立负责。
  return Boolean((await db.query('SELECT id FROM assets WHERE storage_key=$1', [intent.storage_key])).rowCount);
}
async function abandonIntent(pool: Pool, aid: string, errorCode: 'UPLOAD_RESULT_UNKNOWN' | 'UPLOAD_NOT_COMMITTED' | 'UPLOAD_OBJECT_MISMATCH'): Promise<void> {
  await lockIntent(pool, aid, async (db, intent) => {
    if (intent.state !== 'pending' || await hasAssetRecord(db, intent)) return;
    await db.query(`UPDATE asset_upload_intents SET state=$2,last_error_code=$3,updated_at=clock_timestamp() WHERE id=$1`,
      [aid, errorCode === 'UPLOAD_OBJECT_MISMATCH' ? 'blocked' : 'abandoned', errorCode]);
  });
}
async function compensateIntent(pool: Pool, store: AssetStore, aid: string, expiredOnly: boolean): Promise<'cleaned' | 'failed' | 'skipped'> {
  const candidate = await lockIntent(pool, aid, async (db, intent) => {
    if (!['pending', 'abandoned'].includes(intent.state)) return undefined;
    const expired = (await db.query('SELECT $1::timestamptz<=clock_timestamp() AS expired', [intent.expires_at])).rows[0].expired;
    if (expiredOnly && !expired) return undefined;
    if (await hasAssetRecord(db, intent)) {
      await db.query(`UPDATE asset_upload_intents SET state='blocked',last_error_code='ASSET_RECORD_PRESENT',updated_at=clock_timestamp() WHERE id=$1`, [aid]);
      return undefined;
    }
    // 先提交 abandoned：最终上传事务只接受未过期 pending，因此锁外 I/O 不可能与迟到 insert-ready 交错。
    await db.query(`UPDATE asset_upload_intents SET state='abandoned',updated_at=clock_timestamp() WHERE id=$1`, [aid]);
    return intent;
  });
  if (!candidate) return 'skipped';
  let state: 'cleaned' | 'blocked' | 'abandoned' = 'cleaned', code: string | null = null;
  try {
    const removed = await store.removeConditional(candidate.storage_backend, candidate.storage_key, candidate.expected_checksum, candidate.attempt_marker);
    if (removed === 'mismatch') { state = 'blocked'; code = 'UPLOAD_OBJECT_MISMATCH'; }
  } catch { state = 'abandoned'; code = 'STORAGE_CLEANUP_FAILED'; }
  const outcome = await lockIntent(pool, aid, async (db, intent) => {
    if (intent.state !== 'abandoned') return 'skipped' as const;
    if (await hasAssetRecord(db, intent)) {
      await db.query(`UPDATE asset_upload_intents SET state='blocked',last_error_code='ASSET_RECORD_PRESENT',updated_at=clock_timestamp() WHERE id=$1`, [aid]);
      return 'skipped' as const;
    }
    await db.query(`UPDATE asset_upload_intents SET state=$2,last_error_code=$3,updated_at=clock_timestamp() WHERE id=$1`, [aid, state, code]);
    return state === 'cleaned' ? 'cleaned' as const : 'failed' as const;
  });
  return outcome ?? 'skipped';
}
export async function cleanupAssetUploadIntents(pool: Pool, store: AssetStore, limit = 100, afterId?: string): Promise<{ processed: number; cleaned: number; failed: number; next_cursor: string | null }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (afterId !== undefined && !/^ast_[A-Za-z0-9_-]{24}$/.test(afterId))) throw new Error('上传意图清理分页参数不合法');
  const result = await pool.query<UploadIntent>(`SELECT id FROM asset_upload_intents WHERE state IN ('pending','abandoned') AND expires_at<=clock_timestamp()
    AND ($1::text IS NULL OR id>$1) ORDER BY id LIMIT $2`, [afterId ?? null, limit + 1]);
  const rows = result.rows.slice(0, limit);
  let cleaned = 0, failed = 0;
  for (const intent of rows) {
    try {
      const outcome = await compensateIntent(pool, store, intent.id, true);
      if (outcome === 'cleaned') cleaned++;
      else if (outcome === 'failed') failed++;
    } catch { failed++; }
  }
  return { processed: rows.length, cleaned, failed, next_cursor: result.rows.length > limit ? rows.at(-1)!.id : null };
}
async function replayAsset(db: Database, rid: string, key: string, fingerprint: string, mime: AssetMime): Promise<AssetRow | undefined> {
  const existing = (await db.query<AssetRow>(`${select} WHERE a.restaurant_id=$1 AND a.upload_idempotency_key=$2`, [rid, key])).rows[0];
  if (!existing) return undefined;
  if (!equal(existing.initial_request_fingerprint, fingerprint) || existing.mime_type !== mime) throw new ApiError(409);
  if (existing.status === 'deleted') throw new ApiError(410, 'ASSET_ALREADY_DELETED');
  return existing;
}
async function checkQuota(db: Database, rid: string, size = 0): Promise<void> {
  const quota = await db.query<{ count: number; size: string }>(`SELECT count(*)::int AS count,COALESCE(sum(size_bytes),0)::text AS size FROM assets WHERE restaurant_id=$1 AND status='ready'`, [rid]);
  if (quota.rows[0]!.count >= 100 || Number(quota.rows[0]!.size) + size > 200 * 1024 * 1024 || (size === 0 && Number(quota.rows[0]!.size) >= 200 * 1024 * 1024)) throw new ApiError(409, 'ASSET_QUOTA_EXCEEDED');
}
function uploadReply(reply: FastifyReply, row: AssetRow, replay: boolean) {
  return privateHeaders(reply).code(201).header('ETag', etag(row)).header('Idempotency-Replayed', String(replay))
    .header('Location', `/api/v1/restaurants/${row.restaurant_id}/assets/${row.id}`).send(view(row));
}
export function registerAssets(app: FastifyInstance, pool: Pool, config: Config): void {
  const store = createAssetStore(config);
  const uploadSessions = new WeakMap<FastifyRequest, Session>();
  const transfers = new Set<FastifyRequest>();
  const release = (request: FastifyRequest) => { transfers.delete(request); };
  // Bound raw buffering, image decode, private downloads and isolated PDF processes.
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    const upload = request.method === 'POST' && /^\/api\/v1\/restaurants\/[A-Za-z0-9_-]{16,64}\/assets$/.test(path);
    const download = request.method === 'GET' && /^\/api\/v1\/restaurants\/[A-Za-z0-9_-]{16,64}\/assets\/[A-Za-z0-9_-]{16,64}\/content$/.test(path);
    if (!upload && !download) return;
    const session = upload ? (await requireWrite(pool, config, request))! : await requireSession(pool, config, request);
    await owned(pool, session, parameters(request).rid);
    if (transfers.size >= 2) {
      reply.header('Retry-After', '5');
      throw new ApiError(429, 'ASSET_TRANSFER_BUSY');
    }
    transfers.add(request);
  });
  app.addHook('onResponse', async request => { release(request); });
  app.addHook('onRequestAbort', async request => { release(request); });
  app.addHook('onTimeout', async request => { release(request); });
  app.addHook('onClose', async () => { store.close(); });
  app.addContentTypeParser(['application/pdf', 'image/jpeg', 'image/png'], { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_request, body, done) => done(null, body));
  app.get(base, async (request, reply) => {
    const session = await requireSession(pool, config, request), { rid } = parameters(request);
    const result = await locked(pool, config, session, rid, async db => {
      const query = queryOnly(request, ['limit', 'cursor']);
      if (query.limit !== undefined && (typeof query.limit !== 'string' || !/^\d{1,3}$/.test(query.limit))) invalid('limit');
      const limit = query.limit === undefined ? 20 : Number(query.limit);
      if (limit < 1 || limit > 100) invalid('limit');
      const cursor = query.cursor === undefined ? undefined : readCursor(config, query.cursor, session, rid, limit);
      const result = await db.query<AssetRow>(`${select} WHERE a.restaurant_id=$1 AND a.status='ready'
        ${cursor ? 'AND (a.created_at,a.id)<($2::timestamptz,$3::text)' : ''} ORDER BY a.created_at DESC,a.id DESC LIMIT $${cursor ? 4 : 2}`,
      cursor ? [rid, cursor.t, cursor.i, limit + 1] : [rid, limit + 1]);
      const items = result.rows.slice(0, limit), hasMore = result.rows.length > limit, last = items.at(-1);
      return { items: items.map(view), has_more: hasMore,
        next_cursor: hasMore && last ? signCursor(config, { v: 1, u: session.user.id, r: rid, l: limit, t: last.cursor_created_at, i: last.id }) : null,
        storage_mode: store.mode };
    });
    return privateHeaders(reply).send(result);
  });
  app.post(base, { bodyLimit: MAX_UPLOAD_BYTES, onRequest: async request => {
    const session = (await requireWrite(pool, config, request))!;
    await owned(pool, session, parameters(request).rid);
    if (!/^(application\/pdf|image\/jpeg|image\/png)$/i.test(request.headers['content-type'] ?? '')) throw new ApiError(415);
    uploadSessions.set(request, session);
  } }, async (request, reply) => {
    const session = uploadSessions.get(request)!;
    const { rid } = parameters(request), query = queryOnly(request, ['kind', 'original_filename', 'rights_confirmed']);
    if (typeof query.kind !== 'string' || !ASSET_KINDS.includes(query.kind as AssetKind)) invalid('kind');
    if (query.rights_confirmed !== 'true') invalid('rights_confirmed', 'CONFIRMATION_REQUIRED');
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{16,128}$/.test(key)) throw new ApiError(400);
    const mime = request.headers['content-type']!.toLowerCase() as AssetMime;
    const filename = sanitizeFilename(query.original_filename, mime);
    const kind = query.kind as AssetKind, raw = request.body as Buffer;
    if (!Buffer.isBuffer(raw) || !raw.length) invalid('body', 'EMPTY_FILE');
    if (raw.length > MAX_UPLOAD_BYTES || (mime !== 'application/pdf' && raw.length > MAX_IMAGE_BYTES)) throw new ApiError(413);
    const fingerprint = createHash('sha256').update(JSON.stringify([checksum(raw), kind, filename])).digest('hex');
    // 同键已完成重放不解码文件、不调用存储；原始实际字节摘要与初始指纹完全一致即可。
    const preexisting = await locked(pool, config, session, rid, async db => {
      const existing = await replayAsset(db, rid, key, fingerprint, mime);
      if (!existing) await checkQuota(db, rid);
      return existing;
    });
    if (preexisting) return uploadReply(reply, preexisting, true);
    const validated = await validateUpload(raw, mime, kind);
    const aid = id('ast'), extension = mime === 'application/pdf' ? 'pdf' : mime === 'image/jpeg' ? 'jpg' : 'png';
    const storageKey = `${rid}/${aid}.${extension}`, marker = randomBytes(24).toString('hex');
    // 验证后的候选元数据先持久化；崩溃或 PUT 失联仍有数据库线索。
    const prepared = await locked(pool, config, session, rid, async db => {
      const existing = await replayAsset(db, rid, key, fingerprint, mime);
      if (existing) return existing;
      await checkQuota(db, rid, validated.sizeBytes);
      const pending = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM asset_upload_intents WHERE restaurant_id=$1 AND state='pending'`, [rid]);
      if (pending.rows[0]!.count >= 8) throw new ApiError(409, 'ASSET_UPLOAD_LIMIT_EXCEEDED');
      await db.query(`INSERT INTO asset_upload_intents(id,restaurant_id,user_id,storage_backend,storage_key,expected_checksum,expected_size_bytes,attempt_marker)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [aid, rid, session.user.id, store.mode, storageKey, validated.checksum, validated.sizeBytes, marker]);
      return undefined;
    });
    if (prepared) return uploadReply(reply, prepared, true);
    try { await store.put(storageKey, validated.bytes, validated.mimeType, marker); }
    catch (error) {
      // 不即时补删或因 HEAD 404 终结：15分钟期限覆盖15秒PUT执行边界，晚完成仍会被后台复查。
      try { await abandonIntent(pool, aid, error instanceof ApiError && error.code === 'UPLOAD_STORAGE_CONFLICT' ? 'UPLOAD_OBJECT_MISMATCH' : 'UPLOAD_RESULT_UNKNOWN'); }
      catch { request.log.error({ request_id: request.id }, '未知上传结果保留为待补偿意图'); }
      throw error;
    }
    let result: { row: AssetRow; replay: boolean };
    try {
      result = await locked(pool, config, session, rid, async db => {
        const intent = (await db.query<UploadIntent>('SELECT * FROM asset_upload_intents WHERE id=$1 FOR UPDATE', [aid])).rows[0];
        if (!intent || intent.state !== 'pending' || !(await db.query('SELECT $1::timestamptz>clock_timestamp() AS valid', [intent.expires_at])).rows[0].valid) throw new ApiError(503);
        const existing = await replayAsset(db, rid, key, fingerprint, mime);
        if (existing) {
          await db.query(`UPDATE asset_upload_intents SET state='abandoned',last_error_code='UPLOAD_NOT_COMMITTED',updated_at=clock_timestamp() WHERE id=$1`, [aid]);
          return { row: existing, replay: true };
        }
        await checkQuota(db, rid, validated.sizeBytes);
        await db.query(`INSERT INTO assets(id,restaurant_id,kind,original_filename,mime_type,size_bytes,checksum,source_checksum,width_px,height_px,
          rights_confirmed_at,storage_backend,storage_key,upload_idempotency_key,initial_request_fingerprint)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp(),$11,$12,$13,$14)`,
        [aid, rid, kind, filename, validated.mimeType, validated.sizeBytes, validated.checksum, validated.sourceChecksum,
          validated.width, validated.height, store.mode, storageKey, key, fingerprint]);
        const row = await asset(db, rid, aid);
        await auditAsset(db, session, 'upload_asset', row, request.id);
        await db.query(`UPDATE asset_upload_intents SET state='committed',last_error_code=NULL,updated_at=clock_timestamp() WHERE id=$1`, [aid]);
        return { row, replay: false };
      });
    } catch (error) {
      // COMMIT 回执不确定时，补偿锁等待结束后按此精确 key 检查所有资产记录；有记录/committed 永不删除。
      try {
        await abandonIntent(pool, aid, 'UPLOAD_NOT_COMMITTED');
        await compensateIntent(pool, store, aid, false);
      } catch { request.log.error({ request_id: request.id }, '上传意图保留，等待后台条件补偿'); }
      throw error;
    }
    if (result.replay) {
      try { await compensateIntent(pool, store, aid, false); }
      catch { request.log.error({ request_id: request.id }, '重复候选保留，等待后台条件补偿'); }
    }
    return uploadReply(reply, result.row, result.replay);
  });
  app.get(`${base}/:assetId`, async (request, reply) => {
    const session = await requireSession(pool, config, request), { rid, aid } = parameters(request);
    const row = await locked(pool, config, session, rid, async db => { queryOnly(request, []); return asset(db, rid, aid!); });
    return privateHeaders(reply).header('ETag', etag(row)).send(view(row));
  });
  app.get(`${base}/:assetId/content`, async (request, reply) => {
    const session = await requireSession(pool, config, request), { rid, aid } = parameters(request);
    const row = await locked(pool, config, session, rid, async db => {
      queryOnly(request, []);
      const row = await asset(db, rid, aid!);
      if (row.status !== 'ready') throw new ApiError(404);
      return row;
    });
    const bytes = await store.read(row.storage_backend, row.storage_key, row.size_bytes, row.checksum);
    // 存储读取不占用事务；读取结束后再检查撤销、归属及墓碑。
    await locked(pool, config, session, rid, async db => {
      const current = await asset(db, rid, aid!);
      if (current.status !== 'ready') throw new ApiError(404);
    });
    privateHeaders(reply).header('ETag', etag(row)).header('Content-Length', bytes.length);
    const disposition = row.mime_type === 'application/pdf' ? 'attachment' : 'inline';
    reply.header('Content-Disposition', `${disposition}; filename="${row.id}.${row.mime_type === 'application/pdf' ? 'pdf' : row.mime_type === 'image/jpeg' ? 'jpg' : 'png'}"; filename*=UTF-8''${encodeURIComponent(row.original_filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`);
    if (row.mime_type === 'application/pdf') reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
    return reply.type(row.mime_type).send(bytes);
  });
  app.delete(`${base}/:assetId`, async (request, reply) => {
    const session = (await requireWrite(pool, config, request))!, { rid, aid } = parameters(request);
    const row = await locked(pool, config, session, rid, async db => {
      queryOnly(request, []);
      const current = await asset(db, rid, aid!, true);
      const match = request.headers['if-match'];
      if (match === undefined) throw new ApiError(428);
      if (typeof match !== 'string' || !/^"asset-[A-Za-z0-9_-]{16,64}-v[1-9]\d*"$/.test(match)) throw new ApiError(400);
      // 相同删除请求可重放旧版本，但仍必须携带针对本素材的有效强 ETag。
      if (current.status === 'deleted') {
        if (match !== etag(current) && match !== `"asset-${current.id}-v${current.revision - 1}"`) throw new ApiError(412);
        return current;
      }
      if (match !== etag(current)) throw new ApiError(412);
      if (!current.can_delete) throw new ApiError(409, 'ASSET_IN_USE');
      await db.query(`UPDATE assets SET status='deleted',deleted_at=clock_timestamp(),updated_at=clock_timestamp(),revision=revision+1 WHERE id=$1`, [current.id]);
      const deleted = await asset(db, rid, aid!);
      await auditAsset(db, session, 'delete_asset', deleted, request.id);
      return deleted;
    });
    // 逻辑删除与审计已经提交；物理故障不撤回墓碑，后台 helper 可继续精确清理。
    await removeDeleted(pool, store, row);
    return privateHeaders(reply).code(204).send();
  });
}
