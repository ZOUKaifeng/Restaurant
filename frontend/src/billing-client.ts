import { ApiError, merchantRequest } from './api';
import { readCreditPeriod } from './usage-client';
import type { BillingCatalog, BillingCreditPack, BillingInterval, BillingOverview, BillingPlan, BillingPlanCode, BillingPrice, BillingSubscriptionView } from '../../backend/src/billing-types';

export type { BillingCatalog, BillingCreditPack, BillingInterval, BillingOverview, BillingPlan, BillingPlanCode, BillingPrice, BillingSubscriptionView };
const codes = ['maintain', 'build', 'unlimited'] as const;
const statuses = ['draft', 'active', 'retired'] as const;
function invalid(): never { throw new ApiError(502, 'BILLING_RESPONSE_INVALID'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid();
  return value;
}
function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}
function identifier(value: unknown, prefix: 'bpv' | 'bpr' | 'bsu' | 'bla' | 'bcp'): string {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[A-Za-z0-9_-]{24}$`).test(value)) invalid();
  return value;
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) invalid();
  return value as T;
}
function time(value: unknown): string {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/.test(value)) invalid();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)) invalid();
  return value;
}
function nullableTime(value: unknown): string | null { return value === null ? null : time(value); }
function price(value: unknown): BillingPrice {
  const row = object(value, ['id', 'interval', 'amount_minor', 'currency', 'status']);
  if (row.currency !== 'USD') invalid();
  return { id: identifier(row.id, 'bpr'), interval: choice(row.interval, ['month', 'year']), amount_minor: integer(row.amount_minor), currency: 'USD', status: choice(row.status, statuses) };
}
function plan(value: unknown): BillingPlan {
  const row = object(value, ['id', 'code', 'name', 'version', 'status', 'ai', 'hosted_site_limit', 'prices']);
  const code = choice(row.code, codes);
  const ai = object(row.ai, ['mode', 'monthly_credits', 'tokens_per_credit', 'allocation_status', 'grant_schedule']);
  const mode = choice(ai.mode, ['limited', 'unlimited']);
  const monthlyCredits = ai.monthly_credits === null ? null : integer(ai.monthly_credits);
  const allocationStatus = choice(ai.allocation_status, ['proposed', 'confirmed']);
  const grantSchedule = choice(ai.grant_schedule, ['unconfirmed', 'service_month']);
  if ((code === 'unlimited') !== (mode === 'unlimited') || (mode === 'unlimited') !== (monthlyCredits === null)
    || (allocationStatus === 'proposed' && grantSchedule !== 'unconfirmed')) invalid();
  if (!Array.isArray(row.prices) || row.prices.length > 2) invalid();
  const prices = row.prices.map(price);
  if (new Set(prices.map(item => item.interval)).size !== prices.length || new Set(prices.map(item => item.id)).size !== prices.length) invalid();
  return { id: identifier(row.id, 'bpv'), code, name: label(row.name), version: integer(row.version, 1), status: choice(row.status, statuses),
    ai: { mode, monthly_credits: monthlyCredits, tokens_per_credit: integer(ai.tokens_per_credit, 1), allocation_status: allocationStatus, grant_schedule: grantSchedule },
    hosted_site_limit: row.hosted_site_limit === null ? null : integer(row.hosted_site_limit), prices };
}
function creditPack(value: unknown): BillingCreditPack {
  const row = object(value, ['id', 'name', 'credits', 'amount_minor', 'currency', 'tokens_per_credit', 'validity_policy', 'validity_days', 'status']);
  if (row.currency !== 'USD') invalid();
  const validityPolicy = choice(row.validity_policy, ['unconfirmed', 'days', 'never_expires']);
  const validityDays = row.validity_days === null ? null : integer(row.validity_days, 1);
  if ((validityPolicy === 'days') !== (validityDays !== null)) invalid();
  return { id: identifier(row.id, 'bcp'), name: label(row.name), credits: integer(row.credits, 1), amount_minor: integer(row.amount_minor), currency: 'USD',
    tokens_per_credit: integer(row.tokens_per_credit, 1), validity_policy: validityPolicy, validity_days: validityDays, status: choice(row.status, statuses) };
}
export function validateCatalog(value: unknown): BillingCatalog {
  const row = object(value, ['schema_version', 'billing_model', 'currency', 'payment_enabled', 'plans', 'credit_packs', 'addons_status', 'seed_offer']);
  if (row.schema_version !== 'billing-catalog-v1' || row.billing_model !== 'subscription_with_credit_addons'
    || row.currency !== 'USD' || row.payment_enabled !== false
    || !Array.isArray(row.credit_packs) || !Array.isArray(row.plans) || row.plans.length > 3) invalid();
  const packs = row.credit_packs.map(creditPack);
  const addonsStatus = choice(row.addons_status, ['not_configured', 'draft']);
  if (new Set(packs.map(item => item.id)).size !== packs.length || addonsStatus !== (packs.length ? 'draft' : 'not_configured')) invalid();
  const plans = row.plans.map(plan);
  const priceIds = plans.flatMap(item => item.prices.map(item => item.id));
  if (new Set(plans.map(item => item.code)).size !== plans.length || new Set(plans.map(item => item.id)).size !== plans.length
    || new Set(priceIds).size !== priceIds.length) invalid();
  const seed = object(row.seed_offer, ['plan_code', 'amount_minor', 'interval', 'requires_approval', 'duration_status', 'purchasable']);
  if (seed.plan_code !== 'unlimited' || seed.amount_minor !== 3990 || seed.interval !== 'month'
    || seed.requires_approval !== true || seed.duration_status !== 'unconfirmed' || seed.purchasable !== false) invalid();
  return { schema_version: 'billing-catalog-v1', billing_model: 'subscription_with_credit_addons', currency: 'USD', payment_enabled: false,
    plans, credit_packs: packs, addons_status: addonsStatus,
    seed_offer: { plan_code: 'unlimited', amount_minor: seed.amount_minor, interval: 'month', requires_approval: true, duration_status: 'unconfirmed', purchasable: false } };
}
function subscription(value: unknown, catalog?: BillingCatalog): BillingSubscriptionView {
  const row = object(value, ['id', 'plan_id', 'plan_code', 'plan_name', 'price_id', 'interval', 'amount_minor', 'currency', 'status', 'period_start', 'period_end', 'paid_through', 'cancel_requested_at', 'revision']);
  if (row.currency !== 'USD') invalid();
  const result: BillingSubscriptionView = { id: identifier(row.id, 'bsu'), plan_id: identifier(row.plan_id, 'bpv'), plan_code: choice(row.plan_code, codes), plan_name: label(row.plan_name),
    price_id: identifier(row.price_id, 'bpr'), interval: choice(row.interval, ['month', 'year']), amount_minor: integer(row.amount_minor), currency: 'USD',
    status: choice(row.status, ['incomplete', 'active', 'past_due', 'suspended', 'cancelled', 'expired']), period_start: nullableTime(row.period_start),
    period_end: nullableTime(row.period_end), paid_through: nullableTime(row.paid_through), cancel_requested_at: nullableTime(row.cancel_requested_at), revision: integer(row.revision, 1) };
  if ((result.period_start === null) !== (result.period_end === null)
    || (result.period_start !== null && result.period_end !== null && result.period_end.slice(0, -1).padEnd(26, '0') <= result.period_start.slice(0, -1).padEnd(26, '0'))) invalid();
  if (catalog) {
    const selected = catalog.plans.find(item => item.id === result.plan_id);
    const priceOwner = catalog.plans.find(item => item.prices.some(price => price.id === result.price_id));
    const selectedPrice = priceOwner?.prices.find(item => item.id === result.price_id);
    if ((selected && (selected.code !== result.plan_code || selected.name !== result.plan_name))
      || (priceOwner && (priceOwner.id !== result.plan_id || selectedPrice?.interval !== result.interval
        || selectedPrice.amount_minor !== result.amount_minor || selectedPrice.currency !== result.currency))) invalid();
    // 私有概览可以引用已退役版本或不公开的种子报价，不能用当前公开目录否认历史记录。
  }
  return result;
}
function creditAmount(value: unknown, signed = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER / 100
    || (!signed && value < 0)) invalid();
  // Billing 是展示投影；用可往返的百分位校验，不把浮点投影当原始账本。
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || cents / 100 !== value) invalid();
  return value;
}
export function formatBillingCredits(value: number, signed = false): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(creditAmount(value, signed));
}
function readCredits(value: unknown): BillingOverview['credits'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const status = (value as Record<string, unknown>).status;
  const keys = ['status', 'enforced', 'available', 'reserved', 'consumed'];
  const row = object(value, status === 'development_test' ? [...keys, 'granted', 'period'] : keys);
  if (row.enforced !== false) invalid();
  if (status === 'not_configured') {
    if (row.available !== null || row.reserved !== null || row.consumed !== null) invalid();
    return { status, enforced: false, available: null, reserved: null, consumed: null };
  }
  if (status !== 'development_test') invalid();
  let period: ReturnType<typeof readCreditPeriod>;
  try { period = readCreditPeriod(row.period); } catch { invalid(); }
  return { status, enforced: false, available: creditAmount(row.available, true), granted: creditAmount(row.granted),
    reserved: creditAmount(row.reserved), consumed: creditAmount(row.consumed), period };
}
export function validateOverview(value: unknown, catalog?: BillingCatalog): BillingOverview {
  const row = object(value, ['schema_version', 'mode', 'payment_enabled', 'account', 'subscription', 'seed_eligibility', 'credits', 'addons_status', 'generated_at']);
  if (row.schema_version !== 'billing-overview-v1' || row.mode !== 'observation' || row.payment_enabled !== false) invalid();
  const credits = readCredits(row.credits), generatedAt = time(row.generated_at);
  const generatedMicros = `${generatedAt.slice(0, -1).padEnd(26, '0')}Z`;
  if (credits.status === 'development_test' && (generatedMicros < credits.period.granted_at || generatedMicros >= credits.period.ends_at)) invalid();
  let account: BillingOverview['account'] = null;
  if (row.account !== null) {
    const item = object(row.account, ['id', 'status']);
    if (typeof item.id !== 'string' || !/^bla_[A-Za-z0-9_-]{24}$/.test(item.id)) invalid();
    account = { id: item.id, status: choice(item.status, ['active', 'suspended', 'closed']) };
  }
  const selected = row.subscription === null ? null : subscription(row.subscription, catalog);
  if (!account && (selected || credits.status === 'development_test')) invalid();
  return { schema_version: 'billing-overview-v1', mode: 'observation', payment_enabled: false, account, subscription: selected,
    seed_eligibility: choice(row.seed_eligibility, ['not_granted', 'pending', 'approved', 'ended']),
    credits, addons_status: choice(row.addons_status, ['not_configured', 'draft']), generated_at: generatedAt };
}
export async function readCatalog(signal?: AbortSignal): Promise<BillingCatalog> {
  const { data } = await merchantRequest<unknown>('/billing/catalog', { method: 'GET', session: false, signal });
  return validateCatalog(data);
}
export async function readOverview(signal?: AbortSignal): Promise<BillingOverview> {
  const { data } = await merchantRequest<unknown>('/billing/overview', { method: 'GET', session: true, signal });
  return validateOverview(data);
}
export function billingErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Your session has expired. Sign in again to view billing.';
    if ([403, 404, 409].includes(error.status)) return 'Billing access is no longer available for this account.';
    if (error.code === 'REQUEST_TIMEOUT') return 'The billing read timed out. Please try again later.';
    if (error.status === 0) return 'Unable to reach billing. Check your connection and try again later.';
    if (error.status === 502) return 'The billing response failed validation. No unverified prices or balances are displayed.';
    if (error.status === 429) return 'Too many requests. Please try again later.';
  }
  return 'Unable to load billing. Please try again later.';
}
export function formatBillingAmount(amountMinor: number, currency: 'USD' = 'USD', kind: 'charge' | 'equivalent' = 'charge'): string {
  if (kind === 'equivalent') {
    // 仅年价的月均比较允许小数 minor units；真实报价仍必须是安全整数。
    if (!Number.isFinite(amountMinor) || amountMinor < 0 || amountMinor > Number.MAX_SAFE_INTEGER) invalid();
  } else integer(amountMinor);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amountMinor / 100);
}
export function savesFiveMonths(plan: BillingPlan): boolean {
  const month = plan.prices.find(item => item.interval === 'month'), year = plan.prices.find(item => item.interval === 'year');
  return !!month && !!year && month.amount_minor > 0 && BigInt(year.amount_minor) === BigInt(month.amount_minor) * 7n;
}
