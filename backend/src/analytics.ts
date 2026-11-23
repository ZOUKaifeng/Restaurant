import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { Config } from './config.js';
import { metricVersion, readAnalyticsDays, type AnalyticsNamespace } from './analytics-access.js';
import { transaction } from './db.js';
import { ApiError, invalid } from './errors.js';
import { lockOwnedRestaurant } from './reservation-access.js';
import { lockAuthenticated, requireSession } from './security.js';
import { validTimezone } from './validation.js';

const dayMilliseconds = 86400000;
type Range = { from: string; to: string };
type Counts = { requests: number; party_size: number;
  statuses: { pending: number; confirmed: number; declined: number; cancelled: number } };
type ReservationDays = { days: Array<Counts & { date: string; timezone: string }>; totals: Counts };
type ReservationDayRow = { kind: 'created' | 'scheduled'; date: string; timezone: string;
  requests: string; party_size: string; pending: string; confirmed: string; declined: string; cancelled: string };

function calendar(value: unknown, field: string): number {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000')) invalid(field);
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) invalid(field);
  return time;
}
function queryRange(query: Record<string, unknown>, config: Config): { range?: Range; namespace: AnalyticsNamespace } {
  if (Object.keys(query).some(key => !['from', 'to', 'namespace'].includes(key))) throw new ApiError(400);
  const namespace = query.namespace ?? (config.nodeEnv === 'production' ? 'production' : 'local_test');
  if (namespace !== 'local_test' && namespace !== 'production') invalid('namespace');
  const hasFrom = Object.hasOwn(query, 'from'), hasTo = Object.hasOwn(query, 'to');
  if (hasFrom !== hasTo) invalid('range', 'FROM_AND_TO_REQUIRED');
  if (!hasFrom) return { namespace };
  const from = calendar(query.from, 'from'), to = calendar(query.to, 'to');
  if (from > to || to - from > 365 * dayMilliseconds) invalid('range', 'INVALID_RANGE');
  return { namespace, range: { from: query.from as string, to: query.to as string } };
}
function safeCount(value: string | bigint): number {
  if (typeof value === 'string' && !/^(0|[1-9][0-9]*)$/.test(value)) throw new ApiError(422, 'ANALYTICS_COUNT_OVERFLOW');
  const count = BigInt(value);
  if (count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER)) throw new ApiError(422, 'ANALYTICS_COUNT_OVERFLOW');
  return Number(count);
}
function emptyCounts(): Counts {
  return { requests: 0, party_size: 0, statuses: { pending: 0, confirmed: 0, declined: 0, cancelled: 0 } };
}
async function readReservationDays(db: PoolClient, rid: string, range: Range): Promise<{
  created: ReservationDays; scheduled: ReservationDays;
}> {
  // 只读取当前订位事实，不连接事件表；两个日期口径共享一条业务查询和同一快照。
  const rows = (await db.query<ReservationDayRow>(`SELECT d.kind,to_char(d.local_date,'YYYY-MM-DD') AS date,
      r.timezone_snapshot AS timezone,count(*) AS requests,sum(r.party_size) AS party_size,
      count(*) FILTER (WHERE r.status='pending') AS pending,
      count(*) FILTER (WHERE r.status='confirmed') AS confirmed,
      count(*) FILTER (WHERE r.status='declined') AS declined,
      count(*) FILTER (WHERE r.status='cancelled') AS cancelled
    FROM reservations r CROSS JOIN LATERAL (VALUES
      ('created',(r.created_at AT TIME ZONE r.timezone_snapshot)::date),
      ('scheduled',r.requested_local_date)) AS d(kind,local_date)
    WHERE r.restaurant_id=$1 AND d.local_date BETWEEN $2::date AND $3::date
    GROUP BY d.kind,d.local_date,r.timezone_snapshot
    ORDER BY d.kind,d.local_date,r.timezone_snapshot`, [rid, range.from, range.to])).rows;
  const result: { created: ReservationDays; scheduled: ReservationDays } = {
    created: { days: [], totals: emptyCounts() }, scheduled: { days: [], totals: emptyCounts() },
  };
  for (const row of rows) {
    const counts: Counts = { requests: safeCount(row.requests), party_size: safeCount(row.party_size),
      statuses: { pending: safeCount(row.pending), confirmed: safeCount(row.confirmed),
        declined: safeCount(row.declined), cancelled: safeCount(row.cancelled) } };
    const target = result[row.kind];
    target.days.push({ date: row.date, timezone: row.timezone, ...counts });
    target.totals.requests = safeCount(BigInt(target.totals.requests) + BigInt(counts.requests));
    target.totals.party_size = safeCount(BigInt(target.totals.party_size) + BigInt(counts.party_size));
    for (const status of ['pending', 'confirmed', 'declined', 'cancelled'] as const)
      target.totals.statuses[status] = safeCount(BigInt(target.totals.statuses[status]) + BigInt(counts.statuses[status]));
  }
  return result;
}

export function registerAnalytics(app: FastifyInstance, pool: Pool, config: Config): void {
  app.get('/api/v1/restaurants/:restaurantId/analytics', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    const session = await requireSession(pool, config, request);
    const rid = (request.params as { restaurantId: string }).restaurantId;
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(rid)) throw new ApiError(400);
    const query = queryRange(request.query as Record<string, unknown>, config);
    try {
      return await transaction(pool, async db => {
        // 必须在首条数据查询前设置；鉴权会取更新锁，因此不能使用 READ ONLY。
        await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await lockAuthenticated(db, config, session);
        let settings;
        try { settings = await lockOwnedRestaurant(db, session.user.id, rid); }
        catch (error) {
          if (error instanceof ApiError && error.status === 404) {
            const revoked = await db.query(`SELECT id FROM restaurant_members WHERE restaurant_id=$1 AND user_id=$2
              AND role='owner' AND status='revoked' FOR UPDATE`, [rid, session.user.id]);
            if (revoked.rowCount) throw new ApiError(403);
          }
          throw error;
        }
        // 默认日期和生成时间来自同一个数据库时刻，无效/缺失当前时区统一回退 UTC。
        const clock = (await db.query<{ generated_at: Date; current_timezone: string; timezone_fallback: boolean;
          from: string; to: string }>(`WITH tz AS (
            SELECT COALESCE((SELECT name FROM pg_catalog.pg_timezone_names WHERE name=$1 AND $2::boolean),'UTC') AS name,
              NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=$1 AND $2::boolean) AS fallback
          ), instant AS MATERIALIZED (SELECT clock_timestamp() AS at)
          SELECT instant.at AS generated_at,tz.name AS current_timezone,tz.fallback AS timezone_fallback,
            to_char((instant.at AT TIME ZONE tz.name)::date-29,'YYYY-MM-DD') AS "from",
            to_char((instant.at AT TIME ZONE tz.name)::date,'YYYY-MM-DD') AS "to"
          FROM tz CROSS JOIN instant`, [settings.timezone, validTimezone(settings.timezone)])).rows[0]!;
        const range = query.range ?? { from: clock.from, to: clock.to };
        // 读取不取 advisory 锁，避免餐厅行锁与采集/重算 advisory 锁形成反序。
        const traffic = await readAnalyticsDays(db, rid, query.namespace, range.from, range.to);
        const reservations = await readReservationDays(db, rid, range);
        return {
          restaurant_id: rid, range, namespace: query.namespace, metric_version: metricVersion,
          generated_at: clock.generated_at.toISOString(), current_timezone: clock.current_timezone,
          timezone_fallback: clock.timezone_fallback,
          traffic: { ...traffic, semantics: {
            page_views: 'successful document requests, not people',
            reservation_clicks: 'platform entry redirect opened; not every button click',
            reservation_form_views: 'successful reservation form GET',
          } },
          // 请求数及人数包括取消/拒绝；confirmed 不是实际到店，且业务来源不按流量命名空间分流。
          reservations: { scope: 'all_restaurant_records', status_semantics: 'current_status_at_query_time', ...reservations },
          subscriptions: { available: false, active_count: null, reason: 'SUBSCRIPTIONS_NOT_IMPLEMENTED' },
          visitors: { available: false, unique_visitors: null, reason: 'UV_NOT_MEASURED' },
        };
      });
    } catch (error) {
      // 撤销授权或反序锁竞争不能退回旧快照/假成功，也不暴露数据库异常。
      if (['40001', '40P01'].includes((error as { code?: string }).code ?? '')) throw new ApiError(503);
      throw error;
    }
  });
}
