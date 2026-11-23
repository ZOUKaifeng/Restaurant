import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { BillingCatalog, BillingCreditPack, BillingOverview, BillingPlan, BillingPrice, BillingSubscriptionView } from './billing-types.js';
import type { Config } from './config.js';
import { readCalendarQuota } from './calendar-credits.js';
import { transaction } from './db.js';
import { ApiError } from './errors.js';
import { lockAuthenticated, requireSession } from './security.js';

type PlanRow = Pick<BillingPlan, 'id' | 'code' | 'name' | 'status'> & {
  version: string; ai_mode: BillingPlan['ai']['mode']; monthly_credits: string | null;
  tokens_per_credit: string; hosted_site_limit: string | null;
  allocation_status: BillingPlan['ai']['allocation_status']; grant_schedule: BillingPlan['ai']['grant_schedule'];
};
type PriceRow = Omit<BillingPrice, 'amount_minor'> & { plan_version_id: string; amount_minor: string };
type PackRow = Omit<BillingCreditPack, 'credits' | 'tokens_per_credit' | 'amount_minor' | 'validity_days'> & {
  credits: string; tokens_per_credit: string; amount_minor: string; validity_days: string | null;
};
type SubscriptionRow = Omit<BillingSubscriptionView, 'amount_minor' | 'revision'> & { amount_minor: string; revision: string };
const utcTimestamp = (column: string): string => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function safeInteger(value: string, minimum = 0): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new ApiError(503);
  const number = BigInt(value);
  if (number < BigInt(minimum) || number > BigInt(Number.MAX_SAFE_INTEGER)) throw new ApiError(503);
  return Number(number);
}
function rejectQuery(request: FastifyRequest): void {
  if (Object.keys(request.query as object).length || new URLSearchParams(request.url.split('?')[1] ?? '').size) throw new ApiError(400);
}
async function readPacks(db: PoolClient): Promise<BillingCreditPack[]> {
  const rows = (await db.query<PackRow>(`SELECT id,name,credits::text,tokens_per_credit::text,amount_minor::text,
    currency,validity_days::text,validity_policy,status FROM billing_credit_pack_versions WHERE status<>'retired' ORDER BY created_at,id`)).rows;
  return rows.map(row => ({
    id: row.id, name: row.name, credits: safeInteger(row.credits, 1), tokens_per_credit: safeInteger(row.tokens_per_credit, 1),
    amount_minor: safeInteger(row.amount_minor), currency: row.currency,
    validity_days: row.validity_days === null ? null : safeInteger(row.validity_days, 1), validity_policy: row.validity_policy, status: row.status,
  }));
}
async function readAddonsStatus(db: PoolClient): Promise<BillingOverview['addons_status']> {
  const row = (await db.query<{ configured: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM billing_credit_pack_versions WHERE status<>'retired') AS configured`)).rows[0]!;
  return row.configured ? 'draft' : 'not_configured';
}
async function readCatalog(db: PoolClient): Promise<BillingCatalog> {
  const rows = (await db.query<PlanRow>(`SELECT id,code,name,version::text,status,ai_mode,monthly_credits::text,
      tokens_per_credit::text,hosted_site_limit::text,allocation_status,grant_schedule FROM (
      SELECT DISTINCT ON (code) * FROM billing_plan_versions WHERE status<>'retired'
      ORDER BY code,version DESC,id DESC
    ) current_plans ORDER BY CASE code WHEN 'maintain' THEN 1 WHEN 'build' THEN 2 ELSE 3 END`)).rows;
  const prices = (await db.query<PriceRow>(`SELECT id,plan_version_id,interval,amount_minor::text,currency,status
    FROM billing_price_versions WHERE plan_version_id=ANY($1::text[]) AND offer_type='standard' AND status<>'retired'
    ORDER BY CASE interval WHEN 'month' THEN 1 ELSE 2 END,id`, [rows.map(row => row.id)])).rows;
  const plans: BillingPlan[] = rows.map(row => ({
    id: row.id, code: row.code, name: row.name, version: safeInteger(row.version, 1), status: row.status,
    // 本批只展示拟定目录，即使后续目录版本确认，也不在这里激活或授予任何权益。
    ai: { mode: row.ai_mode, monthly_credits: row.monthly_credits === null ? null : safeInteger(row.monthly_credits, 1),
      tokens_per_credit: safeInteger(row.tokens_per_credit, 1), allocation_status: row.allocation_status, grant_schedule: row.grant_schedule },
    hosted_site_limit: row.hosted_site_limit === null ? null : safeInteger(row.hosted_site_limit),
    prices: prices.filter(price => price.plan_version_id === row.id).map(price => ({
      id: price.id, interval: price.interval, amount_minor: safeInteger(price.amount_minor), currency: price.currency, status: price.status,
    })),
  }));
  const packs = await readPacks(db);
  return {
    schema_version: 'billing-catalog-v1', billing_model: 'subscription_with_credit_addons', currency: 'USD',
    payment_enabled: false, plans, credit_packs: packs, addons_status: packs.length ? 'draft' : 'not_configured',
    // 全局种子说明没有报价 ID、审批信息或账户资格，也不是购买入口。
    seed_offer: { plan_code: 'unlimited', amount_minor: 3990, interval: 'month', requires_approval: true,
      duration_status: 'unconfirmed', purchasable: false },
  };
}
async function readSubscription(db: PoolClient, accountId: string): Promise<BillingSubscriptionView | null> {
  const row = (await db.query<SubscriptionRow>(`SELECT s.id,s.plan_version_id AS plan_id,p.code AS plan_code,p.name AS plan_name,
      s.price_version_id AS price_id,v.interval,v.amount_minor::text,v.currency,s.status,
      ${utcTimestamp('s.period_start')} AS period_start,${utcTimestamp('s.period_end')} AS period_end,
      ${utcTimestamp('s.paid_through')} AS paid_through,${utcTimestamp('s.cancel_requested_at')} AS cancel_requested_at,
      s.revision::text
    FROM billing_subscriptions s JOIN billing_plan_versions p ON p.id=s.plan_version_id
    JOIN billing_price_versions v ON v.id=s.price_version_id AND v.plan_version_id=s.plan_version_id
    WHERE s.billing_account_id=$1
    ORDER BY (s.status NOT IN ('cancelled','expired')) DESC,s.created_at DESC,s.id DESC LIMIT 1`, [accountId])).rows[0];
  if (!row) return null;
  return {
    id: row.id, plan_id: row.plan_id, plan_code: row.plan_code, plan_name: row.plan_name, price_id: row.price_id,
    interval: row.interval, amount_minor: safeInteger(row.amount_minor), currency: row.currency, status: row.status,
    period_start: row.period_start, period_end: row.period_end, paid_through: row.paid_through,
    cancel_requested_at: row.cancel_requested_at, revision: safeInteger(row.revision, 1),
  };
}
async function readSeedEligibility(db: PoolClient, accountId: string, at: string): Promise<BillingOverview['seed_eligibility']> {
  const row = (await db.query<{ eligibility: Exclude<BillingOverview['seed_eligibility'], 'not_granted'> }>(`SELECT CASE
      WHEN g.status='ended' OR (g.valid_end IS NOT NULL AND g.valid_end<=$2::timestamptz) THEN 'ended'
      WHEN g.status='pending' OR g.valid_from>$2::timestamptz THEN 'pending'
      WHEN g.status='approved' AND g.valid_from<=$2::timestamptz THEN 'approved'
      ELSE 'ended' END AS eligibility
    FROM billing_offer_grants g JOIN billing_price_versions v ON v.id=g.price_version_id
    JOIN billing_plan_versions p ON p.id=v.plan_version_id
    WHERE g.billing_account_id=$1 AND v.offer_type='seed' AND v.interval='month' AND p.code='unlimited'
    ORDER BY (g.status IN ('pending','approved')) DESC,g.created_at DESC,g.id DESC LIMIT 1`, [accountId, at])).rows[0];
  return row?.eligibility ?? 'not_granted';
}
async function readOverview(db: PoolClient, userId: string): Promise<BillingOverview> {
  const account = (await db.query<NonNullable<BillingOverview['account']>>(
    'SELECT id,status FROM billing_accounts WHERE owner_user_id=$1', [userId])).rows[0] ?? null;
  const generated = (await db.query<{ at: string }>(`SELECT ${utcTimestamp('clock_timestamp()')} AS at`)).rows[0]!.at;
  const quota = await readCalendarQuota(db, account?.id ?? null, generated);
  // /100 仅为积分展示；账本精度、实际订阅和非金钱 observation 策略不变。
  const credits: BillingOverview['credits'] = quota.configured ? {
    status: 'development_test', enforced: false, available: quota.available_tokens / 100,
    reserved: quota.reserved_tokens / 100, consumed: quota.consumed_tokens / 100,
    granted: quota.granted_tokens / 100, period: quota.period,
  } : { status: 'not_configured', enforced: false, available: null, reserved: null, consumed: null };
  return {
    schema_version: 'billing-overview-v1', mode: 'observation', payment_enabled: false,
    account, subscription: account ? await readSubscription(db, account.id) : null,
    seed_eligibility: account ? await readSeedEligibility(db, account.id, generated) : 'not_granted',
    credits,
    addons_status: await readAddonsStatus(db), generated_at: generated,
  };
}

export function registerBilling(app: FastifyInstance, pool: Pool, config: Config): void {
  app.get('/api/v1/billing/catalog', async (request, reply): Promise<BillingCatalog> => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    rejectQuery(request);
    try {
      return await transaction(pool, async db => {
        await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        return readCatalog(db);
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503);
    }
  });
  app.get('/api/v1/billing/overview', async (request, reply): Promise<BillingOverview> => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    try {
      const session = await requireSession(pool, config, request);
      rejectQuery(request);
      return await transaction(pool, async db => {
        // 真实鉴权需要行锁，不能 READ ONLY；业务 SQL 只有 SELECT，不 ensure 账户或修改用户。
        await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await lockAuthenticated(db, config, session);
        return readOverview(db, session.user.id);
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503);
    }
  });
}
