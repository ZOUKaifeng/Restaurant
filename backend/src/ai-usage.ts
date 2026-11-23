import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { Config } from './config.js';
import type { AiCallTotals, AiFeature, AiUsageCall, AiUsageCalls, AiUsageFilters, AiUsageReport } from './ai-usage-types.js';
import { readCalendarQuota } from './calendar-credits.js';
import { transaction } from './db.js';
import { ApiError } from './errors.js';
import { lockOwnedRestaurant } from './reservation-access.js';
import { lockAuthenticated, requireSession } from './security.js';

const features = ['menu_recognition', 'website_chat', 'website_generate'] as const;
const filterKeys = ['restaurant_id', 'feature', 'origin', 'from', 'to'] as const;
const timestampPattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/;
const utcTimestamp = (column: string): string => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
type Account = NonNullable<AiUsageReport['billing_account']>;
type CalendarUsageReport = AiUsageReport & { calendar_month_totals?: { period_id: string; totals: AiCallTotals } };
type Cursor = { v: 1; user_id: string; filters: AiUsageFilters; limit: number; last_created_at: string; last_id: string };
type TotalsRow = { [K in keyof AiCallTotals]: string };
type CallRow = Omit<AiUsageCall, 'prompt_tokens' | 'completion_tokens' | 'total_tokens' | 'elapsed_ms'> & {
  prompt_tokens: string | null; completion_tokens: string | null; total_tokens: string | null; elapsed_ms: string | null;
};

function safeBigInt(value: string | bigint): number {
  if (typeof value === 'string' && !/^(0|[1-9][0-9]*)$/.test(value)) throw new ApiError(422, 'AI_USAGE_OVERFLOW');
  const number = BigInt(value);
  if (number < 0n || number > BigInt(Number.MAX_SAFE_INTEGER)) throw new ApiError(422, 'AI_USAGE_OVERFLOW');
  return Number(number);
}
function totals(row?: TotalsRow): AiCallTotals {
  return {
    calls: safeBigInt(row?.calls ?? '0'), known_usage_calls: safeBigInt(row?.known_usage_calls ?? '0'),
    unknown_usage_calls: safeBigInt(row?.unknown_usage_calls ?? '0'), pending_calls: safeBigInt(row?.pending_calls ?? '0'),
    prompt_tokens: safeBigInt(row?.prompt_tokens ?? '0'), completion_tokens: safeBigInt(row?.completion_tokens ?? '0'),
    total_tokens: safeBigInt(row?.total_tokens ?? '0'),
  };
}
function calendar(value: string): number {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000')) throw new ApiError(400);
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new ApiError(400);
  return time;
}
function query(request: FastifyRequest, calls: boolean): { filters: AiUsageFilters; limit: number; cursor: string | null } {
  const input = request.query as Record<string, unknown>;
  const allowed: readonly string[] = calls ? [...filterKeys, 'limit', 'cursor'] : filterKeys;
  if (Object.entries(input).some(([key, value]) => !allowed.includes(key) || typeof value !== 'string')) throw new ApiError(400);
  // 即使将来 query parser 改成覆盖重复键，也不能静默接受重复参数。
  const raw = new URLSearchParams(request.url.split('?')[1] ?? '');
  for (const key of raw.keys()) if (!allowed.includes(key) || raw.getAll(key).length !== 1) throw new ApiError(400);
  const filters: AiUsageFilters = { restaurant_id: null, feature: null, origin: null, from: null, to: null };
  if (input.restaurant_id !== undefined) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(input.restaurant_id as string)) throw new ApiError(400);
    filters.restaurant_id = input.restaurant_id as string;
  }
  if (input.feature !== undefined) {
    if (!features.includes(input.feature as AiFeature)) throw new ApiError(400);
    filters.feature = input.feature as AiFeature;
  }
  if (input.origin !== undefined) {
    if (input.origin !== 'live' && input.origin !== 'legacy_import') throw new ApiError(400);
    filters.origin = input.origin;
  }
  if (Object.hasOwn(input, 'from') !== Object.hasOwn(input, 'to')) throw new ApiError(400);
  if (input.from !== undefined) {
    const from = calendar(input.from as string), to = calendar(input.to as string);
    if (from > to || to - from > 365 * 86400000) throw new ApiError(400);
    filters.from = input.from as string; filters.to = input.to as string;
  }
  let limit = 20;
  if (input.limit !== undefined) {
    if (!/^[1-9][0-9]*$/.test(input.limit as string)) throw new ApiError(400);
    limit = Number(input.limit);
    if (!Number.isSafeInteger(limit) || limit > 50) throw new ApiError(400);
  }
  const cursor = (input.cursor as string | undefined) ?? null;
  if (cursor !== null && (cursor.length === 0 || cursor.length > 2048)) throw new ApiError(400);
  return { filters, limit, cursor };
}
function sign(config: Config, payload: string): Buffer {
  return createHmac('sha256', config.cursorSecret).update(`ai-usage-cursor\0${payload}`).digest();
}
function encodeCursor(config: Config, cursor: Cursor): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return `${payload}.${sign(config, payload).toString('base64url')}`;
}
function decodeCursor(config: Config, value: string, userId: string, filters: AiUsageFilters, limit: number): Cursor {
  const invalid = (): never => { throw new ApiError(400); };
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) invalid();
  const [payload, signature] = value.split('.') as [string, string];
  const mac = Buffer.from(signature, 'base64url');
  if (mac.toString('base64url') !== signature || mac.length !== 32 || !timingSafeEqual(mac, sign(config, payload))) invalid();
  const bytes = Buffer.from(payload, 'base64url');
  if (bytes.toString('base64url') !== payload) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { invalid(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  const cursor = parsed as Cursor;
  if (cursor.v !== 1 || cursor.user_id !== userId || cursor.limit !== limit ||
    typeof cursor.last_id !== 'string' || !/^aic_[A-Za-z0-9_-]{24}$/.test(cursor.last_id) ||
    typeof cursor.last_created_at !== 'string' || !timestampPattern.test(cursor.last_created_at)) invalid();
  const at = cursor.last_created_at;
  calendar(at.slice(0, 10));
  if (Number(at.slice(11, 13)) > 23 || Number(at.slice(14, 16)) > 59 || Number(at.slice(17, 19)) > 59) invalid();
  const expected: Cursor = { v: 1, user_id: userId, filters, limit, last_created_at: at, last_id: cursor.last_id };
  if (JSON.stringify(cursor) !== JSON.stringify(expected)) invalid();
  // 验证只解析日历，不把分页边界转成 JS Date：PG 六位微秒原样传回数据库。
  return expected;
}

const accountScope = 'a.owner_user_id=$1 AND c.requesting_user_id=$1';
const filteredScope = `${accountScope}
  AND ($2::text IS NULL OR c.restaurant_id=$2) AND ($3::text IS NULL OR c.feature=$3)
  AND ($4::text IS NULL OR c.origin=$4)
  AND ($5::date IS NULL OR c.created_at >= ($5::date::timestamp AT TIME ZONE 'UTC'))
  AND ($6::date IS NULL OR c.created_at < (($6::date+1)::timestamp AT TIME ZONE 'UTC'))`;
const aggregateColumns = `count(*)::text AS calls,
  (count(*) FILTER (WHERE c.usage_status='known'))::text AS known_usage_calls,
  (count(*) FILTER (WHERE c.usage_status='unknown'))::text AS unknown_usage_calls,
  (count(*) FILTER (WHERE c.usage_status='pending'))::text AS pending_calls,
  coalesce(sum(c.prompt_tokens) FILTER (WHERE c.usage_status='known'),0)::text AS prompt_tokens,
  coalesce(sum(c.completion_tokens) FILTER (WHERE c.usage_status='known'),0)::text AS completion_tokens,
  coalesce(sum(c.total_tokens) FILTER (WHERE c.usage_status='known'),0)::text AS total_tokens`;
const callJoin = 'FROM ai_model_calls c JOIN billing_accounts a ON a.id=c.billing_account_id';
function parameters(userId: string, filters: AiUsageFilters): Array<string | null> {
  return [userId, filters.restaurant_id, filters.feature, filters.origin, filters.from, filters.to];
}
async function readAccount(db: PoolClient, userId: string): Promise<Account | null> {
  return (await db.query<Account>('SELECT id,status FROM billing_accounts WHERE owner_user_id=$1', [userId])).rows[0] ?? null;
}
async function readLegacy(db: PoolClient, userId: string): Promise<AiUsageReport['legacy']> {
  const row = (await db.query<{ aggregate_jobs: string; known_total_tokens: string; unknown_usage_jobs: string }>(`
    WITH summaries AS (
      SELECT CASE WHEN j.usage IS NOT NULL THEN j.usage WHEN j.status='succeeded' THEN v.usage END AS usage,
        (j.usage IS NOT NULL OR (j.status='succeeded' AND v.usage IS NOT NULL)) AS has_usage
      FROM website_jobs j JOIN billing_accounts a ON a.owner_user_id=j.requesting_user_id
      LEFT JOIN website_versions v ON v.id=j.result_version_id AND v.restaurant_id=j.restaurant_id
      WHERE a.owner_user_id=$1 AND j.requesting_user_id=$1 AND j.kind='generate'
        AND j.created_at < (SELECT applied_at FROM schema_migrations WHERE version='010_ai_metering')
        AND NOT EXISTS (SELECT 1 FROM ai_model_calls c WHERE c.website_job_id=j.id)
        AND NOT EXISTS (SELECT 1 FROM website_model_calls c WHERE c.job_id=j.id)
        AND (j.usage IS NOT NULL OR j.result_version_id IS NOT NULL)
    ), counts AS (
      SELECT s.*,
        CASE WHEN jsonb_typeof(usage->'total_tokens')='number' THEN (usage->>'total_tokens')::numeric END AS t,
        CASE WHEN jsonb_typeof(usage->'prompt_tokens')='number' THEN (usage->>'prompt_tokens')::numeric END AS p,
        CASE WHEN jsonb_typeof(usage->'completion_tokens')='number' THEN (usage->>'completion_tokens')::numeric END AS c,
        (usage->'prompt_tokens' IS NOT NULL AND usage->'prompt_tokens'<>'null'::jsonb AND
          usage->'completion_tokens' IS NOT NULL AND usage->'completion_tokens'<>'null'::jsonb) AS three_available
      FROM summaries s
    ), validated AS (
      SELECT *, coalesce(t BETWEEN 0 AND 9007199254740991 AND t=trunc(t) AND
        (NOT three_available OR (p BETWEEN 0 AND 9007199254740991 AND p=trunc(p) AND
          c BETWEEN 0 AND 9007199254740991 AND c=trunc(c) AND p+c=t)),false) AS known FROM counts
    )
    SELECT (count(*) FILTER (WHERE has_usage))::text AS aggregate_jobs,
      trunc(coalesce(sum(t) FILTER (WHERE known),0))::text AS known_total_tokens,
      (count(*) FILTER (WHERE NOT known))::text AS unknown_usage_jobs FROM validated`, [userId])).rows[0]!;
  return { aggregate_jobs: safeBigInt(row.aggregate_jobs), known_total_tokens: safeBigInt(row.known_total_tokens),
    unknown_usage_jobs: safeBigInt(row.unknown_usage_jobs) };
}
async function readReport(db: PoolClient, userId: string, filters: AiUsageFilters, account: Account | null): Promise<CalendarUsageReport> {
  const generated = (await db.query<{ at: string }>(`SELECT ${utcTimestamp('clock_timestamp()')} AS at`)).rows[0]!.at;
  const accountTotals = (await db.query<TotalsRow>(`SELECT ${aggregateColumns} ${callJoin} WHERE ${accountScope}`, [userId])).rows[0];
  const values = parameters(userId, filters);
  const filtered = (await db.query<TotalsRow>(`SELECT ${aggregateColumns} ${callJoin} WHERE ${filteredScope}`, values)).rows[0];
  const grouped = (await db.query<TotalsRow & { feature: AiFeature }>(`SELECT c.feature,${aggregateColumns}
    ${callJoin} WHERE ${filteredScope} GROUP BY c.feature ORDER BY c.feature`, values)).rows;
  const quota = await readCalendarQuota(db, account?.id ?? null, generated);
  // 独立于 filters/all time，只统计登记后本月 live 事实；配额余额仍取 helper 的账本投影。
  const calendarMonth = quota.configured ? { period_id: quota.period.id, totals: totals((await db.query<TotalsRow>(`
    SELECT ${aggregateColumns} ${callJoin} WHERE ${accountScope} AND c.billing_account_id=$2 AND c.origin='live'
      AND c.created_at >= $3::timestamptz AND c.created_at < $4::timestamptz AND c.created_at >= $5::timestamptz`,
  [userId, account!.id, quota.period.starts_at, quota.period.ends_at, quota.period.granted_at])).rows[0]) } : undefined;
  return {
    mode: 'observation', policy_version: 'observation-v1', generated_at: generated, billing_account: account,
    quota, ...(calendarMonth ? { calendar_month_totals: calendarMonth } : {}),
    filters, account_totals: totals(accountTotals), filtered_totals: totals(filtered),
    by_feature: grouped.map(row => ({ feature: row.feature, ...totals(row) })),
    // 旧聚合是独立的全账户 all time 摘要，不进入调用统计，也不应用本次过滤器。
    legacy: account ? await readLegacy(db, userId) : { aggregate_jobs: 0, known_total_tokens: 0, unknown_usage_jobs: 0 },
  };
}
async function readCalls(db: PoolClient, config: Config, userId: string, filters: AiUsageFilters, limit: number,
  cursor: Cursor | null): Promise<AiUsageCalls> {
  const rows = (await db.query<CallRow>(`SELECT c.id,c.restaurant_id,
      CASE WHEN r.status IN ('draft','active') AND EXISTS (SELECT 1 FROM restaurant_members m
        WHERE m.restaurant_id=c.restaurant_id AND m.user_id=$1 AND m.role='owner' AND m.status='active')
        THEN r.name ELSE NULL END AS restaurant_name,
      coalesce(c.website_job_id,c.menu_job_id) AS job_id,c.feature,c.model,c.provider,c.call_index,c.call_status,
      c.usage_status,c.origin,c.chargeable,c.prompt_tokens::text,c.completion_tokens::text,c.total_tokens::text,
      c.elapsed_ms::text,c.error_code,${utcTimestamp('c.created_at')} AS created_at,
      ${utcTimestamp('c.finished_at')} AS finished_at
    ${callJoin} LEFT JOIN restaurants r ON r.id=c.restaurant_id WHERE ${filteredScope}
      AND ($7::timestamptz IS NULL OR (c.created_at,c.id)<($7::timestamptz,$8::text))
    ORDER BY c.created_at DESC,c.id DESC LIMIT $9`,
  [...parameters(userId, filters), cursor?.last_created_at ?? null, cursor?.last_id ?? null, limit + 1])).rows;
  const page = rows.slice(0, limit);
  const items: AiUsageCall[] = page.map(row => ({
    id: row.id, restaurant_id: row.restaurant_id, restaurant_name: row.restaurant_name, job_id: row.job_id,
    feature: row.feature, model: row.model, provider: 'deepseek', call_index: row.call_index,
    call_status: row.call_status, usage_status: row.usage_status, origin: row.origin, chargeable: false,
    prompt_tokens: row.prompt_tokens === null ? null : safeBigInt(row.prompt_tokens),
    completion_tokens: row.completion_tokens === null ? null : safeBigInt(row.completion_tokens),
    total_tokens: row.total_tokens === null ? null : safeBigInt(row.total_tokens),
    elapsed_ms: row.elapsed_ms === null ? null : safeBigInt(row.elapsed_ms), error_code: row.error_code,
    created_at: row.created_at, finished_at: row.finished_at,
  }));
  const last = page.at(-1);
  return { filters, items, next_cursor: rows.length > limit && last ? encodeCursor(config, {
    v: 1, user_id: userId, filters, limit, last_created_at: last.created_at, last_id: last.id,
  }) : null };
}

export function registerAiUsage(app: FastifyInstance, pool: Pool, config: Config): void {
  for (const path of ['/api/v1/ai/usage', '/api/v1/ai/usage/calls', '/api/v1/billing/account']) {
    app.get(path, async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
      const session = await requireSession(pool, config, request);
      const isAccount = path === '/api/v1/billing/account', isCalls = path === '/api/v1/ai/usage/calls';
      if (isAccount && (Object.keys(request.query as object).length || new URLSearchParams(request.url.split('?')[1] ?? '').size)) throw new ApiError(400);
      const input = query(request, isCalls);
      const cursor = input.cursor ? decodeCursor(config, input.cursor, session.user.id, input.filters, input.limit) : null;
      try {
        return await transaction(pool, async db => {
          // 鉴权与 owner 校验需要行锁，不能 SET READ ONLY；业务查询只读同一 REPEATABLE READ 快照。
          await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
          await lockAuthenticated(db, config, session);
          if (input.filters.restaurant_id) await lockOwnedRestaurant(db, session.user.id, input.filters.restaurant_id);
          const account = await readAccount(db, session.user.id);
          if (isAccount) return { mode: 'observation' as const, account, payment_enabled: false as const };
          if (isCalls) return readCalls(db, config, session.user.id, input.filters, input.limit, cursor);
          return readReport(db, session.user.id, input.filters, account);
        });
      } catch (error) {
        if (['40001', '40P01'].includes((error as { code?: string }).code ?? '')) throw new ApiError(503);
        throw error;
      }
    });
  }
}
