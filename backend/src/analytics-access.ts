import type { Pool } from 'pg';
import type { Database } from './db.js';
import { id, transaction } from './db.js';
import { ApiError } from './errors.js';

export type AnalyticsEventType = 'page_view' | 'reservation_click' | 'reservation_form_view';
export type AnalyticsNamespace = 'local_test' | 'production';
export interface AnalyticsContext {
  restaurant_id: string;
  version_id: string;
  publication_revision: number;
  slug: string;
  timezone: string;
  timezone_fallback: boolean;
  namespace: AnalyticsNamespace;
}
export const metricVersion = 'v1' as const;
export interface AnalyticsDays {
  days: Array<{
    date: string; timezone: string; timezone_fallback: boolean;
    page_views: number; reservation_clicks: number; reservation_form_views: number;
  }>;
  totals: { page_views: number; reservation_clicks: number; reservation_form_views: number };
}

function contextInvalid(): never { throw new ApiError(422, 'ANALYTICS_CONTEXT_INVALID'); }
function validNamespace(value: unknown): value is AnalyticsNamespace {
  return value === 'local_test' || value === 'production';
}
function validateRange(rid: string, namespace: AnalyticsNamespace, from: string, to: string): void {
  if (typeof rid !== 'string' || !rid.trim() || !validNamespace(namespace)) contextInvalid();
  const calendar = (value: string): number => {
    if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000')) contextInvalid();
    const time = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) contextInvalid();
    return time;
  };
  const start = calendar(from), end = calendar(to);
  if (start > end || end - start > 365 * 86400000) contextInvalid();
}
function validateEvent(context: AnalyticsContext, eventType: AnalyticsEventType, dedupeKey: string, occurredAt: Date): void {
  if (!context || typeof context.restaurant_id !== 'string' || !context.restaurant_id.trim()
    || typeof context.version_id !== 'string' || !context.version_id.trim()
    || !Number.isInteger(context.publication_revision) || context.publication_revision < 1 || context.publication_revision > 2147483647
    || typeof context.slug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(context.slug)
    || !validNamespace(context.namespace) || typeof context.timezone_fallback !== 'boolean'
    || typeof context.timezone !== 'string' || context.timezone.length > 64
    || !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(context.timezone)
    || !['page_view', 'reservation_click', 'reservation_form_view'].includes(eventType)
    || typeof dedupeKey !== 'string' || !/^[a-f0-9]{64}$/.test(dedupeKey)
    || !(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())
    || occurredAt.getUTCFullYear() < 1 || occurredAt.getUTCFullYear() > 9999) contextInvalid();
  try { new Intl.DateTimeFormat('en', { timeZone: context.timezone }); } catch { contextInvalid(); }
}

// 只供受信站点服务端调用；context 来自当前发布，dedupeKey 是不可逆摘要而非原请求标识。
export async function recordAnalyticsEvent(pool: Pool, context: AnalyticsContext, eventType: AnalyticsEventType,
  dedupeKey: string, occurredAt: Date = new Date()): Promise<boolean> {
  validateEvent(context, eventType, dedupeKey, occurredAt);
  return transaction(pool, async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('analytics:' || $1))", [context.restaurant_id]);
    const timezone = await db.query('SELECT name FROM pg_catalog.pg_timezone_names WHERE name=$1', [context.timezone]);
    if (!timezone.rowCount) contextInvalid();
    // 所有业务写入均先锁用户，采集也保持 user → restaurant → member → publication，避免和发布/取消死锁。
    const candidate = (await db.query<{ user_id: string }>(`SELECT user_id FROM restaurant_members
      WHERE restaurant_id=$1 AND role='owner' AND status='active'`, [context.restaurant_id])).rows[0];
    if (!candidate || !(await db.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [candidate.user_id])).rowCount) return false;
    if (!(await db.query('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE', [context.restaurant_id])).rowCount) return false;
    if (!(await db.query('SELECT restaurant_id FROM website_publications WHERE restaurant_id=$1 FOR UPDATE',
      [context.restaurant_id])).rowCount) return false;
    const member = (await db.query<{ id: string; user_id: string }>(`SELECT id,user_id FROM restaurant_members
      WHERE restaurant_id=$1 AND role='owner' AND status='active' FOR UPDATE`, [context.restaurant_id])).rows[0];
    if (!member || member.user_id !== candidate.user_id) return false;
    const current = await db.query(`SELECT p.restaurant_id FROM website_publications p
      JOIN restaurants r ON r.id=p.restaurant_id
      JOIN restaurant_members m ON m.restaurant_id=r.id AND m.role='owner' AND m.status='active'
      JOIN users u ON u.id=m.user_id
      WHERE r.id=$1 AND p.published_version_id=$2 AND p.revision=$3 AND p.slug=$4
        AND r.status IN ('draft','active') AND u.status='active' AND u.email_verified_at IS NOT NULL
        AND COALESCE(r.timezone,'UTC')=$5 AND (r.timezone IS NULL)=$6 AND m.id=$7
        AND ($8::text='page_view' OR r.reservation_enabled)`,
    [context.restaurant_id, context.version_id, context.publication_revision, context.slug, context.timezone, context.timezone_fallback, member.id, eventType]);
    if (!current.rowCount) return false;
    const inserted = await db.query(`WITH inserted AS (
      INSERT INTO analytics_events(id,restaurant_id,version_id,publication_revision,namespace,metric_version,event_type,
        dedupe_key,occurred_at,local_date,timezone_snapshot,timezone_fallback)
      VALUES($1,$2,$3,$4,$5,'v1',$6,$7,$8::timestamptz,($8::timestamptz AT TIME ZONE $9)::date,$9,$10)
      ON CONFLICT (restaurant_id,namespace,dedupe_key) DO NOTHING
      RETURNING restaurant_id,namespace,metric_version,local_date,timezone_snapshot,timezone_fallback,event_type
    ) INSERT INTO analytics_daily(restaurant_id,namespace,metric_version,local_date,timezone_snapshot,timezone_fallback,
        page_views,reservation_clicks,reservation_form_views,updated_at)
      SELECT restaurant_id,namespace,metric_version,local_date,timezone_snapshot,timezone_fallback,
        CASE WHEN event_type='page_view' THEN 1 ELSE 0 END,
        CASE WHEN event_type='reservation_click' THEN 1 ELSE 0 END,
        CASE WHEN event_type='reservation_form_view' THEN 1 ELSE 0 END,clock_timestamp() FROM inserted WHERE true
      ON CONFLICT (restaurant_id,namespace,metric_version,local_date,timezone_snapshot,timezone_fallback)
      DO UPDATE SET page_views=analytics_daily.page_views+EXCLUDED.page_views,
        reservation_clicks=analytics_daily.reservation_clicks+EXCLUDED.reservation_clicks,
        reservation_form_views=analytics_daily.reservation_form_views+EXCLUDED.reservation_form_views,
        updated_at=clock_timestamp()
      RETURNING restaurant_id`,
    [id('aev'), context.restaurant_id, context.version_id, context.publication_revision, context.namespace,
      eventType, dedupeKey, occurredAt, context.timezone, context.timezone_fallback]);
    if (inserted.rowCount) return true;
    const existing = (await db.query<{ event_type: AnalyticsEventType; version_id: string }>(
      'SELECT event_type,version_id FROM analytics_events WHERE restaurant_id=$1 AND namespace=$2 AND dedupe_key=$3',
      [context.restaurant_id, context.namespace, dedupeKey])).rows[0]!;
    // 重试时间、时区及发布 revision 不改写首次事实；只有类型/版本冲突才拒绝。
    if (existing.event_type !== eventType || existing.version_id !== context.version_id)
      throw new ApiError(409, 'ANALYTICS_EVENT_CONFLICT');
    return false;
  });
}

export async function rebuildAnalyticsDays(pool: Pool, rid: string, namespace: AnalyticsNamespace,
  from: string, to: string): Promise<void> {
  validateRange(rid, namespace, from, to);
  await transaction(pool, async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('analytics:' || $1))", [rid]);
    if (!(await db.query('SELECT id FROM restaurants WHERE id=$1', [rid])).rowCount) throw new ApiError(404);
    await db.query(`DELETE FROM analytics_daily WHERE restaurant_id=$1 AND namespace=$2 AND metric_version='v1'
      AND local_date BETWEEN $3::date AND $4::date`, [rid, namespace, from, to]);
    await db.query(`INSERT INTO analytics_daily(restaurant_id,namespace,metric_version,local_date,timezone_snapshot,
        timezone_fallback,page_views,reservation_clicks,reservation_form_views,updated_at)
      SELECT restaurant_id,namespace,metric_version,local_date,timezone_snapshot,timezone_fallback,
        count(*) FILTER (WHERE event_type='page_view'),count(*) FILTER (WHERE event_type='reservation_click'),
        count(*) FILTER (WHERE event_type='reservation_form_view'),clock_timestamp()
      FROM analytics_events WHERE restaurant_id=$1 AND namespace=$2 AND metric_version='v1'
        AND local_date BETWEEN $3::date AND $4::date
      GROUP BY restaurant_id,namespace,metric_version,local_date,timezone_snapshot,timezone_fallback`,
    [rid, namespace, from, to]);
  });
}

function safeCount(value: unknown): number {
  if ((typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0))
    || (typeof value === 'string' && !/^(0|[1-9][0-9]*)$/.test(value))
    || !['string', 'bigint', 'number'].includes(typeof value)) throw new ApiError(422, 'ANALYTICS_COUNT_OVERFLOW');
  const count = BigInt(value as string | bigint | number);
  if (count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER)) throw new ApiError(422, 'ANALYTICS_COUNT_OVERFLOW');
  return Number(count);
}

// 返回有计数的聚合日，不补空日；历史日可能因时区/fallback 不同出现多行。
export async function readAnalyticsDays(db: Database, rid: string, namespace: AnalyticsNamespace,
  from: string, to: string): Promise<AnalyticsDays> {
  validateRange(rid, namespace, from, to);
  if (!(await db.query('SELECT id FROM restaurants WHERE id=$1', [rid])).rowCount) throw new ApiError(404);
  const rows = (await db.query<{ date: string; timezone: string; timezone_fallback: boolean;
    page_views: string; reservation_clicks: string; reservation_form_views: string }>(`
    SELECT to_char(local_date,'YYYY-MM-DD') AS date,timezone_snapshot AS timezone,timezone_fallback,
      page_views,reservation_clicks,reservation_form_views FROM analytics_daily
    WHERE restaurant_id=$1 AND namespace=$2 AND metric_version='v1' AND local_date BETWEEN $3::date AND $4::date
      AND (page_views>0 OR reservation_clicks>0 OR reservation_form_views>0)
    ORDER BY local_date,timezone_snapshot,timezone_fallback`, [rid, namespace, from, to])).rows;
  const days = rows.map(row => ({ date: row.date, timezone: row.timezone, timezone_fallback: row.timezone_fallback,
    page_views: safeCount(row.page_views), reservation_clicks: safeCount(row.reservation_clicks),
    reservation_form_views: safeCount(row.reservation_form_views) }));
  let views = 0n, clicks = 0n, forms = 0n;
  for (const day of days) {
    views += BigInt(day.page_views); clicks += BigInt(day.reservation_clicks); forms += BigInt(day.reservation_form_views);
  }
  return { days, totals: { page_views: safeCount(views), reservation_clicks: safeCount(clicks), reservation_form_views: safeCount(forms) } };
}
