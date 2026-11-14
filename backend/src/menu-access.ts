import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Config } from './config.js';
import type { Database } from './db.js';
import { id } from './db.js';
import { ApiError, invalid } from './errors.js';
import { normalizeMenuData, type ConfirmedMenuSnapshot, type MenuData, type MenuImageInput } from './menu-data.js';
import type { StorageBackend } from './asset-storage.js';
import { MAX_IMAGE_BYTES, MAX_UPLOAD_BYTES } from './asset-validation.js';

export interface MenuDraft {
  revision: number; status: 'empty' | 'draft' | 'confirmed'; data: MenuData;
  source_asset_ids: string[]; confirmed_at: string | null;
}
export interface MenuDraftRecord extends Omit<MenuDraft, 'confirmed_at'> { id: string; confirmed_at: Date | null }
export interface MenuSource {
  id: string; mime_type: MenuImageInput['mime_type']; checksum: string; size_bytes: number;
  storage_key: string; storage_backend: StorageBackend;
}
export interface MenuRecognitionInput { asset_ids: string[]; consent_to_ai_processing: true; expected_revision: number }
export interface MenuJobView {
  id: string; status: 'queued' | 'running' | 'succeeded' | 'failed'; error_code: string | null;
  created_at: string; result_revision: number | null;
}
export interface MenuJobRecord extends Omit<MenuJobView, 'created_at'> { created_at: Date }
export interface MenuJob extends MenuJobRecord {
  restaurant_id: string; requesting_user_id: string; sources: MenuSource[]; input: MenuRecognitionInput;
  expected_revision: number; lease_token: string | null; lease_expires_at: Date | null;
}
export interface MenuState {
  draft: MenuDraft | null; jobs: MenuJobView[]; model: 'deepseek-flash'; model_configured: boolean;
  input_mode: 'vision'; pdf_supported: false;
}
export const menuDraftColumns = 'id,revision,status,data,source_asset_ids,confirmed_at';
export const menuJobColumns = 'id,status,error_code,created_at,result_revision';
export function menuDraftView(row: MenuDraftRecord): MenuDraft {
  return { revision: row.revision, status: row.status, data: normalizeMenuData(row.data),
    source_asset_ids: row.source_asset_ids, confirmed_at: row.confirmed_at?.toISOString() ?? null };
}
export function menuJobView(row: MenuJobRecord): MenuJobView {
  return { id: row.id, status: row.status, error_code: row.error_code,
    created_at: row.created_at.toISOString(), result_revision: row.result_revision };
}
export function menuItemCount(data: MenuData): number {
  return data.categories.reduce((count, category) => count + category.items.length, 0);
}
export async function readMenuDraft(db: Database, rid: string): Promise<MenuDraft | null> {
  const row = (await db.query<MenuDraftRecord>(`SELECT ${menuDraftColumns} FROM menu_drafts WHERE restaurant_id=$1`, [rid])).rows[0];
  return row ? menuDraftView(row) : null;
}
// 供已鉴权的网站快照事务调用；无菜单可不展示，有未确认菜品必须先人工确认。
export async function readConfirmedMenu(db: Database, rid: string): Promise<ConfirmedMenuSnapshot | null> {
  const draft = await readMenuDraft(db, rid);
  if (!draft || menuItemCount(draft.data) === 0) return null;
  if (draft.status !== 'confirmed') throw new ApiError(409, 'MENU_CONFIRM_REQUIRED');
  return { revision: draft.revision, data: draft.data };
}
export function menuModelConfigured(config: Config): boolean { return Boolean(config.website?.apiKey?.trim()); }
export function requireMenuAI(config: Config): void {
  if (!menuModelConfigured(config)) throw new ApiError(503, 'AI_NOT_CONFIGURED');
}
export function menuFingerprint(rid: string, input: MenuRecognitionInput): string {
  return createHash('sha256').update(JSON.stringify({ restaurant_id: rid, ...input })).digest('hex');
}
export async function lockMenuRestaurant(db: PoolClient, userId: string, rid: string): Promise<void> {
  const restaurant = (await db.query('SELECT id,status FROM restaurants WHERE id=$1 FOR UPDATE', [rid])).rows[0];
  const member = (await db.query(`SELECT id FROM restaurant_members WHERE restaurant_id=$1 AND user_id=$2
    AND role='owner' AND status='active' FOR UPDATE`, [rid, userId])).rows[0];
  if (!restaurant || !member) throw new ApiError(404);
  if (!['draft', 'active'].includes(restaurant.status)) throw new ApiError(409, 'RESTAURANT_UNAVAILABLE');
}
export async function lockMenuDraft(db: PoolClient, rid: string): Promise<MenuDraftRecord> {
  await db.query('INSERT INTO menu_drafts(id,restaurant_id) VALUES($1,$2) ON CONFLICT(restaurant_id) DO NOTHING', [id('mnd'), rid]);
  return (await db.query<MenuDraftRecord>(`SELECT ${menuDraftColumns} FROM menu_drafts WHERE restaurant_id=$1 FOR UPDATE`, [rid])).rows[0]!;
}
export function requireMenuRevision(current: MenuDraftRecord, expected: number): void {
  if (current.revision !== expected || current.revision >= 2147483646) throw new ApiError(409, 'MENU_REVISION_CONFLICT');
}
export async function requireMenuIdle(db: Database, rid: string): Promise<void> {
  if ((await db.query("SELECT id FROM menu_jobs WHERE restaurant_id=$1 AND status IN ('queued','running') LIMIT 1", [rid])).rowCount) {
    throw new ApiError(409, 'MENU_JOB_BUSY');
  }
}
// 调用者必须先锁用户，再锁餐厅；网站入队也可复用菜单 busy 检查。
export async function requireMenuRecognitionQuota(db: Database, userId: string, rid: string): Promise<void> {
  await requireMenuIdle(db, rid);
  if ((await db.query("SELECT id FROM website_jobs WHERE restaurant_id=$1 AND status IN ('queued','running') LIMIT 1", [rid])).rowCount) {
    throw new ApiError(409, 'WEBSITE_JOB_BUSY');
  }
  const daily = (await db.query(`SELECT count(*)::int AS n FROM (
    SELECT id FROM menu_jobs WHERE requesting_user_id=$1 AND created_at>clock_timestamp()-interval '24 hours'
    UNION ALL SELECT id FROM website_jobs WHERE requesting_user_id=$1 AND created_at>clock_timestamp()-interval '24 hours'
    LIMIT 30) jobs`, [userId])).rows[0]!;
  if (daily.n >= 30) throw new ApiError(429, 'MENU_DAILY_LIMIT');
  const total = (await db.query('SELECT count(*)::int AS n FROM (SELECT id FROM menu_jobs WHERE restaurant_id=$1 LIMIT 200) jobs', [rid])).rows[0]!;
  if (total.n >= 200) throw new ApiError(409, 'MENU_JOB_LIMIT');
}
export async function lockMenuSources(db: PoolClient, rid: string, assetIds: string[]): Promise<MenuSource[]> {
  const assets = (await db.query<MenuSource & { status: string; kind: string }>(`SELECT id,kind,status,mime_type,checksum,size_bytes,storage_key,storage_backend
    FROM assets WHERE restaurant_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE`, [rid, [...assetIds].sort()])).rows;
  if (assets.length !== assetIds.length || assets.some(asset => asset.status !== 'ready')) throw new ApiError(404);
  if (assets.some(asset => asset.kind !== 'menu_source')) invalid('asset_ids', 'MENU_SOURCE_ONLY');
  if (assets.some(asset => (asset.mime_type as string) === 'application/pdf')) throw new ApiError(422, 'PDF_MENU_UNSUPPORTED');
  if (assets.some(asset => !['image/jpeg', 'image/png'].includes(asset.mime_type))) invalid('asset_ids', 'MENU_IMAGES_ONLY');
  if (assets.some(asset => !Number.isSafeInteger(asset.size_bytes) || asset.size_bytes < 1 || asset.size_bytes > MAX_IMAGE_BYTES) ||
      assets.reduce((total, asset) => total + asset.size_bytes, 0) > MAX_UPLOAD_BYTES) throw new ApiError(413, 'MENU_IMAGES_TOO_LARGE');
  return assetIds.map(aid => {
    const asset = assets.find(row => row.id === aid)!;
    return { id: asset.id, mime_type: asset.mime_type, checksum: asset.checksum, size_bytes: asset.size_bytes,
      storage_key: asset.storage_key, storage_backend: asset.storage_backend };
  });
}
export async function menuAudit(db: PoolClient, userId: string, rid: string, entityId: string,
  action: 'menu_recognition_requested' | 'menu_updated' | 'menu_confirmed' | 'menu_job_failed', requestId: string): Promise<void> {
  const failed = action === 'menu_job_failed';
  await db.query(`INSERT INTO audit_logs(id,restaurant_id,actor_type,actor_user_id,action,entity_type,entity_id,request_id,outcome,changed_fields)
    VALUES($1,$2,'merchant',$3,$4,'menu',$5,$6,$7,$8)`, [id('aud'), rid, userId, action, entityId, requestId,
    failed ? 'failed' : 'success', failed ? ['status', 'asset_references'] : action === 'menu_recognition_requested' ? ['status'] : ['data', 'revision', 'status']]);
}
