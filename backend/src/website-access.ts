import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Config } from './config.js';
import type { Database } from './db.js';
import { ApiError, invalid } from './errors.js';
import type { WebsiteSnapshot } from './website-html.js';
import { readMenuDraft, menuItemCount } from './menu-access.js';
import type { WebsiteAgentProgress, WebsiteAgentEvent } from './website-agent-types.js';

export interface WebsiteSettings {
  apiKey?: string; baseUrl: string; model: string; publicOrigin: string;
  port: number; host: string; baseDomain?: string;
}
export type WebsiteRuntimeConfig = Config & { website?: WebsiteSettings };
export interface WebsiteMessage { role: 'user' | 'assistant'; content: string }
export interface WebsiteAgent { id: string | null; revision: number; messages: WebsiteMessage[]; design_brief: string }
export interface WebsiteJobView {
  id: string; kind: 'chat' | 'generate'; status: 'queued' | 'running' | 'succeeded' | 'failed';
  error_code: string | null; result_version_id: string | null; created_at: string;
  progress?: WebsiteAgentProgress | null; trace?: WebsiteAgentEvent[];
}
export type WebsiteJobRecord = Omit<WebsiteJobView, 'created_at'> & { created_at: Date };
export interface WebsiteJob extends WebsiteJobRecord {
  restaurant_id: string; requesting_user_id: string; input: {
    message?: string; messages?: WebsiteMessage[]; brief?: string; asset_ids?: string[];
    public_assets_confirmed?: true; expected_revision?: number; expected_restaurant_revision?: number;
  };
  snapshot: WebsiteSnapshot; agent_revision: number | null; lease_token: string | null;
  lease_expires_at: Date | null; usage?: unknown;
}
export interface WebsiteUsageTotals { prompt_tokens: number; completion_tokens: number; total_tokens: number }
export interface WebsiteUsageSummary { totals: WebsiteUsageTotals; model_calls: number; unknown_usage_calls: number }
export function websiteUsageNumber(value: unknown): number {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^[0-9]+$/.test(value))) throw new ApiError(503, 'AI_USAGE_INVALID');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new ApiError(503, 'AI_USAGE_INVALID');
  return result;
}
export async function websiteUsageSummary(db: Database, jobId: string): Promise<WebsiteUsageSummary> {
  const row = (await db.query(`SELECT count(*) AS model_calls,count(*) FILTER (WHERE total_tokens IS NULL) AS unknown_usage_calls,
    COALESCE(sum(prompt_tokens),0) AS prompt_tokens,COALESCE(sum(completion_tokens),0) AS completion_tokens,
    COALESCE(sum(total_tokens),0) AS total_tokens FROM website_model_calls WHERE job_id=$1`, [jobId])).rows[0];
  const totals = { prompt_tokens: websiteUsageNumber(row.prompt_tokens), completion_tokens: websiteUsageNumber(row.completion_tokens),
    total_tokens: websiteUsageNumber(row.total_tokens) };
  if (!Number.isSafeInteger(totals.prompt_tokens + totals.completion_tokens) ||
      totals.total_tokens !== totals.prompt_tokens + totals.completion_tokens) throw new ApiError(503, 'AI_USAGE_INVALID');
  return { totals, model_calls: websiteUsageNumber(row.model_calls), unknown_usage_calls: websiteUsageNumber(row.unknown_usage_calls) };
}
export interface WebsiteVersionView {
  id: string; restaurant_id: string; version_number: number; summary: string; created_at: string;
  checksum: string; asset_ids: string[];
}
export interface WebsiteVersion extends Omit<WebsiteVersionView, 'created_at'> {
  created_at: Date; html: string; snapshot: WebsiteSnapshot; model: string; usage: unknown;
}
export interface WebsitePublication {
  revision: number; published_version_id: string | null; slug: string | null;
  url: string | null; deployment_mode: 'local' | 'unconfigured';
}
export interface WebsiteState {
  agent: WebsiteAgent; versions: WebsiteVersionView[]; jobs: WebsiteJobView[]; publication: WebsitePublication;
  model: string; model_configured: boolean; menu_recognition_enabled: true;
  menu: { revision: number; status: 'empty' | 'draft' | 'confirmed'; item_count: number };
}
export function websiteJobView(row: WebsiteJobRecord): WebsiteJobView {
  return { id: row.id, kind: row.kind, status: row.status, error_code: row.error_code,
    result_version_id: row.result_version_id, created_at: row.created_at.toISOString(), progress: row.progress ?? null, trace: row.trace ?? [] };
}
export interface WebsiteRestaurant {
  id: string; revision: number; status: 'draft' | 'active' | 'suspended' | 'archived';
  name: string; description: string | null; cuisine_label: string | null; address_line1: string | null;
  address_line2: string | null; city: string | null; region: string | null; postal_code: string | null;
  country_code: string | null; contact_email: string | null; phone: string | null; timezone: string | null;
  currency_code: string | null; primary_locale: string; reservation_enabled: boolean;
  reservation_notice: string | null; privacy_notice_version: string | null;
}
export const websiteJobColumns = 'id,kind,status,error_code,result_version_id,created_at,progress,trace';
export const websiteVersionColumns = 'id,restaurant_id,version_number,summary,created_at,checksum,asset_ids';
export function websiteSettings(config: Config): WebsiteSettings | undefined {
  return (config as WebsiteRuntimeConfig).website;
}
export function requireWebsiteAI(config: Config): void {
  if (!websiteSettings(config)?.apiKey?.trim()) throw new ApiError(503, 'AI_NOT_CONFIGURED');
}
export function localWebsiteOrigin(config: Config): string | null {
  const value = websiteSettings(config)?.publicOrigin;
  if (config.nodeEnv === 'production' || !value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.origin === config.appOrigin || url.username || url.password) return null;
    return value;
  } catch { return null; }
}
export function publicationView(config: Config, row?: { revision: number; published_version_id: string | null; slug: string | null }): WebsitePublication {
  const origin = localWebsiteOrigin(config);
  return { revision: row?.revision ?? 0, published_version_id: row?.published_version_id ?? null,
    slug: row?.slug ?? null, url: origin && row?.slug ? `${origin}/s/${row.slug}` : null,
    deployment_mode: origin ? 'local' : 'unconfigured' };
}
export async function ownedWebsiteRestaurant(db: Database, userId: string, rid: string, lock = false): Promise<WebsiteRestaurant> {
  const result = await db.query<WebsiteRestaurant>(`SELECT r.* FROM restaurants r
    JOIN restaurant_members m ON m.restaurant_id=r.id AND m.user_id=$1 AND m.role='owner' AND m.status='active'
    WHERE r.id=$2 ${lock ? 'FOR UPDATE OF r,m' : ''}`, [userId, rid]);
  if (!result.rows[0]) throw new ApiError(404);
  return result.rows[0];
}
export function requireWebsiteRestaurant(row: WebsiteRestaurant): void {
  if (!['draft', 'active'].includes(row.status)) throw new ApiError(409, 'RESTAURANT_UNAVAILABLE');
}
export async function websiteSnapshot(db: Database, row: WebsiteRestaurant, assetIds: string[], lockAssets = false): Promise<WebsiteSnapshot> {
  const assets = await db.query<WebsiteSnapshot['assets'][number] & { status: string }>(`SELECT id,kind,mime_type,checksum,width_px,height_px,status
    FROM assets WHERE restaurant_id=$1 AND id=ANY($2::text[]) ORDER BY id ${lockAssets ? 'FOR UPDATE' : ''}`, [row.id, [...assetIds].sort()]);
  if (assets.rows.length !== assetIds.length || assets.rows.some(asset => asset.status !== 'ready')) throw new ApiError(404);
  if (assets.rows.filter(asset => asset.kind === 'menu_source').length > 1) invalid('asset_ids', 'ONE_MENU_SOURCE_ONLY');
  if (assets.rows.filter(asset => asset.kind === 'logo').length > 1) invalid('asset_ids', 'ONE_LOGO_ONLY');
  if (assets.rows.some(asset => asset.mime_type === 'application/pdf' && asset.kind !== 'menu_source')) invalid('asset_ids');
  const hours = await db.query<WebsiteSnapshot['opening_hours'][number]>(`SELECT weekday,to_char(opens_at_local,'HH24:MI') AS opens_at_local,
    to_char(closes_at_local,'HH24:MI') AS closes_at_local,closes_day_offset FROM opening_hours
    WHERE restaurant_id=$1 ORDER BY weekday,sort_order,opens_at_local,id LIMIT 22`, [row.id]);
  if (hours.rows.length > 21) invalid('opening_hours', 'TOO_MANY_INTERVALS');
  // 只纳入人工确认的菜单，不读取图片或PDF、不把未确认草稿变成事实。
  const draft = await readMenuDraft(db, row.id);
  const menu = draft?.status === 'confirmed' && menuItemCount(draft.data) > 0 ? { revision: draft.revision, data: draft.data } : null;
  return { menu, restaurant: { id: row.id, name: row.name, description: row.description, cuisine_type: row.cuisine_label,
    address_line1: row.address_line1, address_line2: row.address_line2, city: row.city, region: row.region,
    postal_code: row.postal_code, country_code: row.country_code, contact_email: row.contact_email,
    contact_phone: row.phone, timezone: row.timezone, currency: row.currency_code, primary_locale: row.primary_locale,
    reservation_enabled: row.reservation_enabled, reservation_notice: row.reservation_notice },
    opening_hours: hours.rows, assets: assets.rows.map(({ status: _status, ...asset }) => asset) };
}
export function websiteFingerprint(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
export function verifyWebsiteVersion(version: Pick<WebsiteVersion, 'html' | 'checksum' | 'snapshot' | 'asset_ids'>): void {
  if (Buffer.byteLength(version.html, 'utf8') > 200 * 1024 ||
      createHash('sha256').update(version.html, 'utf8').digest('hex') !== version.checksum) throw new ApiError(503, 'WEBSITE_CHECKSUM_INVALID');
  if (!Array.isArray(version.snapshot?.assets) ||
      JSON.stringify(version.asset_ids) !== JSON.stringify(version.snapshot.assets.map(asset => asset.id))) throw new ApiError(503, 'WEBSITE_MANIFEST_INVALID');
}
export async function readyWebsiteVersion(db: Database, rid: string, vid: string): Promise<WebsiteVersion> {
  const version = (await db.query<WebsiteVersion>('SELECT * FROM website_versions WHERE restaurant_id=$1 AND id=$2', [rid, vid])).rows[0];
  if (!version) throw new ApiError(404);
  verifyWebsiteVersion(version);
  const assets = await db.query(`SELECT id,checksum,mime_type FROM assets WHERE restaurant_id=$1 AND id=ANY($2::text[]) AND status='ready' ORDER BY id`, [rid, version.asset_ids]);
  if (assets.rows.length !== version.asset_ids.length || assets.rows.some(asset => {
    const saved = version.snapshot.assets.find(item => item.id === asset.id);
    return !saved || saved.checksum !== asset.checksum || saved.mime_type !== asset.mime_type;
  })) throw new ApiError(404);
  return version;
}
export async function websiteAudit(db: PoolClient, userId: string, rid: string, entityId: string,
  action: 'website_chat' | 'website_generate' | 'website_publish' | 'website_job_failed', requestId: string): Promise<void> {
  await db.query(`INSERT INTO audit_logs(id,restaurant_id,actor_type,actor_user_id,action,entity_type,entity_id,request_id,outcome,changed_fields)
    VALUES($1,$2,'merchant',$3,$4,'website',$5,$6,$7,$8)`,
  [randomUUID(), rid, userId, action, entityId, requestId, action === 'website_job_failed' ? 'failed' : 'success',
    action === 'website_publish' ? ['published_version_id', 'revision'] : action === 'website_job_failed' ? ['status', 'asset_references'] : ['status']]);
}

// 公共服务只按当前指针读取；状态或归属撤销后立即失效。素材下载须再以 slug、version_id、asset_id 查询此清单。
export const WEBSITE_PUBLIC_READ_QUERY = `SELECT p.restaurant_id,p.slug,p.revision,v.id AS version_id,v.html,v.checksum,v.snapshot,v.asset_ids,
  r.name AS restaurant_name,r.timezone,r.reservation_enabled,r.reservation_notice,r.privacy_notice_version,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'mime_type',a.mime_type,'checksum',a.checksum,
    'size_bytes',a.size_bytes,'storage_backend',a.storage_backend,'storage_key',a.storage_key) ORDER BY a.id)
    FROM assets a WHERE a.restaurant_id=v.restaurant_id AND a.id=ANY(v.asset_ids) AND a.status='ready'),'[]'::jsonb) AS assets
  FROM website_publications p JOIN website_versions v ON v.restaurant_id=p.restaurant_id AND v.id=p.published_version_id
  JOIN restaurants r ON r.id=p.restaurant_id AND r.status IN ('draft','active')
  JOIN restaurant_members m ON m.restaurant_id=r.id AND m.role='owner' AND m.status='active'
  JOIN users u ON u.id=m.user_id AND u.status='active' AND u.email_verified_at IS NOT NULL
  WHERE p.slug=$1 AND p.deployment_mode='local' AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v.snapshot->'assets') saved LEFT JOIN assets a
    ON a.restaurant_id=v.restaurant_id AND a.id=saved->>'id' AND a.status='ready'
    AND a.checksum=saved->>'checksum' AND a.mime_type=saved->>'mime_type' WHERE a.id IS NULL)
  LIMIT 1`;
export interface PublicWebsite {
  restaurant_id: string; slug: string; revision: number; version_id: string; html: string; checksum: string;
  snapshot: WebsiteSnapshot; asset_ids: string[];
  restaurant_name: string; timezone: string | null; reservation_enabled: boolean;
  reservation_notice: string | null; privacy_notice_version: string | null;
  assets: Array<{ id: string; mime_type: string; checksum: string; size_bytes: number; storage_backend: 'local' | 's3'; storage_key: string }>;
}
export async function readPublicWebsite(db: Database, slug: string): Promise<PublicWebsite | null> {
  if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug) || ['admin', 'api', 'auth', 'www'].includes(slug)) return null;
  const row = (await db.query<PublicWebsite>(WEBSITE_PUBLIC_READ_QUERY, [slug])).rows[0];
  if (!row) return null;
  verifyWebsiteVersion(row);
  return row;
}
