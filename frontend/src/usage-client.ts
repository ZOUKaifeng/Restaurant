import { ApiError, merchantRequest } from './api';
import type { AiCallTotals, AiCreditPeriod, AiFeature, AiOrigin, AiQuotaView, AiUsageCall, AiUsageCalls, AiUsageFilters, AiUsageReport } from '../../backend/src/ai-usage-types';

export type { AiCallTotals, AiCreditPeriod, AiFeature, AiOrigin, AiUsageCall, AiUsageCalls, AiUsageFilters, AiUsageReport };

export function readCreditPeriod(value: unknown): AiCreditPeriod {
  const row = object(value, ['id', 'starts_at', 'ends_at', 'granted_at', 'timezone', 'origin', 'tokens_per_credit', 'auto_renew']);
  if (typeof row.id !== 'string' || !/^aqp_[A-Za-z0-9_-]{24}$/.test(row.id)
    || row.timezone !== 'UTC' || row.origin !== 'development_test' || row.tokens_per_credit !== 100 || row.auto_renew !== false) invalid();
  const start = timestamp(row.starts_at), end = timestamp(row.ends_at), granted = timestamp(row.granted_at);
  const monthStart = /-01T00:00:00\.000000Z$/;
  const nextMonth = new Date(Date.parse(start));
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  if (!monthStart.test(start) || !monthStart.test(end) || nextMonth.toISOString().slice(0, 10) !== end.slice(0, 10)
    || granted < start || granted >= end) invalid();
  return { id: row.id, starts_at: start, ends_at: end, granted_at: granted, timezone: 'UTC', origin: 'development_test', tokens_per_credit: 100, auto_renew: false };
}
function readQuota(value: unknown): AiQuotaView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const configured = (value as Record<string, unknown>).configured;
  const keys = ['configured', 'enforced', 'available_tokens', 'granted_tokens', 'reserved_tokens', 'consumed_tokens'];
  const row = object(value, configured === true ? [...keys, 'period'] : keys);
  if (row.enforced !== false) invalid();
  if (configured === false) {
    if (keys.slice(2).some(key => row[key] !== null)) invalid();
    return { configured: false, enforced: false, available_tokens: null, granted_tokens: null, reserved_tokens: null, consumed_tokens: null };
  }
  if (configured !== true || typeof row.available_tokens !== 'number' || !Number.isSafeInteger(row.available_tokens)) invalid();
  const granted = count(row.granted_tokens), reserved = count(row.reserved_tokens), consumed = count(row.consumed_tokens);
  if (BigInt(granted) - BigInt(reserved) - BigInt(consumed) !== BigInt(row.available_tokens)) invalid();
  return { configured: true, enforced: false, available_tokens: row.available_tokens, granted_tokens: granted,
    reserved_tokens: reserved, consumed_tokens: consumed, period: readCreditPeriod(row.period) };
}
export type UsageQuery = { restaurant_id?: string; feature?: AiFeature; origin?: AiOrigin; from?: string; to?: string };
export type UsageCallsQuery = UsageQuery & { limit?: number; cursor?: string };
export const USAGE_PAGE_SIZE = 20;
export const USAGE_FEATURES = ['menu_recognition', 'website_chat', 'website_generate'] as const;
const filterKeys = ['restaurant_id', 'feature', 'origin', 'from', 'to'] as const;
const totalKeys = ['calls', 'known_usage_calls', 'unknown_usage_calls', 'pending_calls', 'prompt_tokens', 'completion_tokens', 'total_tokens'] as const;
const restaurantPattern = /^[A-Za-z0-9_-]{16,64}$/;
const cursorPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

function invalid(): never { throw new ApiError(502, 'USAGE_RESPONSE_INVALID'); }
function requestInvalid(): never { throw new ApiError(400, 'USAGE_REQUEST_INVALID'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
export function safeUsageSum(values: readonly number[]): number {
  const result = values.reduce((sum, value) => sum + BigInt(count(value)), 0n);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
  return Number(result);
}
function calendar(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}
export function validateUsageRange(from: unknown, to: unknown): void {
  const start = calendar(from), end = calendar(to);
  if (start === null || end === null || end < start || end - start > 365 * 86_400_000) {
    throw new ApiError(400, 'USAGE_RANGE_INVALID');
  }
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/.test(value)
    || calendar(value.slice(0, 10)) === null || Number(value.slice(11, 13)) > 23
    || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) invalid();
  // 保留六位微秒，分页和时间先后不使用会截断微秒的 JS Date。
  return value;
}
function cursor(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 2048 || !cursorPattern.test(value)) invalid();
  return value;
}
export function validateUsageQuery(query: UsageQuery | UsageCallsQuery = {}, calls = false): AiUsageFilters {
  if (!query || typeof query !== 'object' || Array.isArray(query)) requestInvalid();
  const allowed: readonly string[] = calls ? [...filterKeys, 'limit', 'cursor'] : filterKeys;
  if (Object.keys(query).some(key => !allowed.includes(key))) requestInvalid();
  const filters: AiUsageFilters = { restaurant_id: null, feature: null, origin: null, from: null, to: null };
  for (const key of filterKeys) {
    if (Object.hasOwn(query, key)) {
      if (typeof query[key] !== 'string') requestInvalid();
      (filters as unknown as Record<string, unknown>)[key] = query[key];
    }
  }
  if (filters.restaurant_id !== null && !restaurantPattern.test(filters.restaurant_id)) requestInvalid();
  if (filters.feature !== null && !USAGE_FEATURES.includes(filters.feature)) requestInvalid();
  if (filters.origin !== null && filters.origin !== 'live' && filters.origin !== 'legacy_import') requestInvalid();
  if ((filters.from === null) !== (filters.to === null)) throw new ApiError(400, 'USAGE_RANGE_INVALID');
  if (filters.from !== null) validateUsageRange(filters.from, filters.to);
  if (calls) {
    const input = query as UsageCallsQuery;
    if (Object.hasOwn(input, 'limit') && (typeof input.limit !== 'number' || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50)) requestInvalid();
    if (Object.hasOwn(input, 'cursor') && (typeof input.cursor !== 'string' || input.cursor.length > 2048 || !cursorPattern.test(input.cursor))) requestInvalid();
  }
  return filters;
}
function readFilters(value: unknown, query: UsageQuery): AiUsageFilters {
  const row = object(value, filterKeys), expected = validateUsageQuery(query);
  if (filterKeys.some(key => row[key] !== expected[key])) invalid();
  return expected;
}
function totals(value: unknown, feature = false): AiCallTotals {
  const row = object(value, feature ? [...totalKeys, 'feature'] : totalKeys);
  const result: AiCallTotals = {
    calls: count(row.calls), known_usage_calls: count(row.known_usage_calls),
    unknown_usage_calls: count(row.unknown_usage_calls), pending_calls: count(row.pending_calls),
    prompt_tokens: count(row.prompt_tokens), completion_tokens: count(row.completion_tokens), total_tokens: count(row.total_tokens),
  };
  if (safeUsageSum([result.known_usage_calls, result.unknown_usage_calls, result.pending_calls]) !== result.calls
    || safeUsageSum([result.prompt_tokens, result.completion_tokens]) !== result.total_tokens
    || (result.known_usage_calls === 0 && result.total_tokens !== 0)) invalid();
  return result;
}
export function validateUsageReport(value: unknown, query: UsageQuery = {}): AiUsageReport {
  validateUsageQuery(query);
  const hasMonthly = !!value && typeof value === 'object' && Object.hasOwn(value, 'calendar_month_totals');
  const keys = ['mode', 'policy_version', 'generated_at', 'billing_account', 'quota', 'filters', 'account_totals', 'filtered_totals', 'by_feature', 'legacy'];
  const row = object(value, hasMonthly ? [...keys, 'calendar_month_totals'] : keys);
  if (row.mode !== 'observation' || row.policy_version !== 'observation-v1') invalid();
  const quota = readQuota(row.quota), generatedAt = timestamp(row.generated_at);
  if (hasMonthly !== quota.configured || (quota.configured
    && (generatedAt < quota.period.granted_at || generatedAt >= quota.period.ends_at))) invalid();
  let billingAccount: AiUsageReport['billing_account'] = null;
  if (row.billing_account !== null) {
    const account = object(row.billing_account, ['id', 'status']);
    if (typeof account.id !== 'string' || !/^bla_[A-Za-z0-9_-]{24}$/.test(account.id)
      || !['active', 'suspended', 'closed'].includes(account.status as string)) invalid();
    billingAccount = { id: account.id, status: account.status as NonNullable<AiUsageReport['billing_account']>['status'] };
  }
  const filters = readFilters(row.filters, query), accountTotals = totals(row.account_totals), filteredTotals = totals(row.filtered_totals);
  if (totalKeys.some(key => accountTotals[key] < filteredTotals[key])) invalid();
  if (filterKeys.every(key => filters[key] === null) && totalKeys.some(key => accountTotals[key] !== filteredTotals[key])) invalid();
  if (!Array.isArray(row.by_feature) || row.by_feature.length > 3) invalid();
  const seen = new Set<AiFeature>();
  const byFeature = row.by_feature.map(value => {
    const group = object(value, [...totalKeys, 'feature']), feature = group.feature as AiFeature;
    if (!USAGE_FEATURES.includes(feature) || seen.has(feature)) invalid();
    seen.add(feature);
    const result = totals(group, true);
    if (filters.feature !== null && filters.feature !== feature && result.calls !== 0) invalid();
    return { feature, ...result };
  });
  for (const key of totalKeys) if (safeUsageSum(byFeature.map(group => group[key])) !== filteredTotals[key]) invalid();
  const legacy = object(row.legacy, ['aggregate_jobs', 'known_total_tokens', 'unknown_usage_jobs']);
  const legacyTotals = { aggregate_jobs: count(legacy.aggregate_jobs), known_total_tokens: count(legacy.known_total_tokens), unknown_usage_jobs: count(legacy.unknown_usage_jobs) };
  if (!billingAccount && (quota.configured || accountTotals.calls !== 0 || Object.values(legacyTotals).some(value => value !== 0))) invalid();
  let monthly: AiUsageReport['calendar_month_totals'];
  if (quota.configured) {
    const month = object(row.calendar_month_totals, ['period_id', 'totals']);
    if (month.period_id !== quota.period.id) invalid();
    const monthTotals = totals(month.totals);
    if (totalKeys.some(key => monthTotals[key] > accountTotals[key])) invalid();
    monthly = { period_id: quota.period.id, totals: monthTotals };
  }
  return {
    mode: 'observation', policy_version: 'observation-v1', generated_at: generatedAt, billing_account: billingAccount, quota,
    filters, account_totals: accountTotals, filtered_totals: filteredTotals, by_feature: byFeature, legacy: legacyTotals,
    ...(monthly ? { calendar_month_totals: monthly } : {}),
  };
}
const callKeys = ['id', 'restaurant_id', 'restaurant_name', 'job_id', 'feature', 'model', 'provider', 'call_index', 'call_status', 'usage_status', 'origin', 'chargeable', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'elapsed_ms', 'error_code', 'created_at', 'finished_at'] as const;
function readCall(value: unknown, filters: AiUsageFilters): AiUsageCall {
  const row = object(value, callKeys);
  if (typeof row.id !== 'string' || !/^aic_[A-Za-z0-9_-]{24}$/.test(row.id)
    || typeof row.restaurant_id !== 'string' || !restaurantPattern.test(row.restaurant_id)
    || (row.restaurant_name !== null && typeof row.restaurant_name !== 'string') || typeof row.job_id !== 'string'
    || !USAGE_FEATURES.includes(row.feature as AiFeature) || typeof row.model !== 'string' || row.model.length < 1 || row.model.length > 100
    || row.provider !== 'deepseek' || row.chargeable !== false || count(row.call_index) < 1 || (row.call_index as number) > 2147483647
    || !['started', 'completed', 'failed'].includes(row.call_status as string)
    || !['pending', 'known', 'unknown'].includes(row.usage_status as string)
    || (row.origin !== 'live' && row.origin !== 'legacy_import')
    || (row.error_code !== null && (typeof row.error_code !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(row.error_code)))) invalid();
  const createdAt = timestamp(row.created_at), finishedAt = row.finished_at === null ? null : timestamp(row.finished_at);
  if (finishedAt !== null && finishedAt < createdAt) invalid();
  if (row.elapsed_ms !== null) count(row.elapsed_ms);
  if (row.call_status === 'started') {
    if (row.usage_status !== 'pending' || finishedAt !== null || row.elapsed_ms !== null || row.error_code !== null) invalid();
  } else if (row.usage_status === 'pending' || finishedAt === null) invalid();
  if (row.call_status !== 'failed' && row.error_code !== null) invalid();
  if (row.usage_status === 'known') {
    if (safeUsageSum([count(row.prompt_tokens), count(row.completion_tokens)]) !== count(row.total_tokens)) invalid();
  } else if (row.prompt_tokens !== null || row.completion_tokens !== null || row.total_tokens !== null) invalid();
  if ((filters.restaurant_id !== null && row.restaurant_id !== filters.restaurant_id)
    || (filters.feature !== null && row.feature !== filters.feature) || (filters.origin !== null && row.origin !== filters.origin)
    || (filters.from !== null && (createdAt.slice(0, 10) < filters.from || createdAt.slice(0, 10) > filters.to!))) invalid();
  return { ...row, created_at: createdAt, finished_at: finishedAt } as unknown as AiUsageCall;
}
export function validateUsageCalls(value: unknown, query: UsageCallsQuery = {}): AiUsageCalls {
  const expected = validateUsageQuery(query, true);
  const row = object(value, ['filters', 'items', 'next_cursor']);
  const filterQuery = Object.fromEntries(filterKeys.filter(key => expected[key] !== null).map(key => [key, expected[key]])) as UsageQuery;
  const filters = readFilters(row.filters, filterQuery);
  if (!Array.isArray(row.items) || row.items.length > (query.limit ?? USAGE_PAGE_SIZE)) invalid();
  const items = row.items.map(item => readCall(item, filters)), ids = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index], previous = items[index - 1];
    if (ids.has(item.id) || (previous && (previous.created_at < item.created_at || (previous.created_at === item.created_at && previous.id <= item.id)))) invalid();
    ids.add(item.id);
  }
  const next = cursor(row.next_cursor);
  if (next !== null && (items.length === 0 || next === query.cursor)) invalid();
  return { filters, items, next_cursor: next };
}
function params(query: UsageQuery | UsageCallsQuery): string {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) result.set(key, String(value));
  return result.size ? `?${result}` : '';
}
export async function readUsage(query: UsageQuery = {}, signal?: AbortSignal): Promise<AiUsageReport> {
  validateUsageQuery(query);
  const expected = { ...query };
  validateUsageQuery(expected);
  const { data } = await merchantRequest<unknown>(`/ai/usage${params(expected)}`, { method: 'GET', session: true, signal });
  return validateUsageReport(data, expected);
}
export async function readUsageCalls(query: UsageCallsQuery = {}, signal?: AbortSignal): Promise<AiUsageCalls> {
  validateUsageQuery(query, true);
  const expected = { limit: USAGE_PAGE_SIZE, ...query };
  validateUsageQuery(expected, true);
  const { data } = await merchantRequest<unknown>(`/ai/usage/calls${params(expected)}`, { method: 'GET', session: true, signal });
  return validateUsageCalls(data, expected);
}

export function appendUsageCalls(previous: readonly AiUsageCall[], next: readonly AiUsageCall[]): AiUsageCall[] {
  const ids = new Map(previous.map(item => [item.id, item]));
  const added: AiUsageCall[] = [];
  for (const item of next) {
    const existing = ids.get(item.id);
    if (existing) {
      if (callKeys.some(key => existing[key] !== item[key])) invalid();
      continue;
    }
    const last = added.at(-1) ?? previous.at(-1);
    if (last && (last.created_at < item.created_at || (last.created_at === item.created_at && last.id <= item.id))) invalid();
    ids.set(item.id, item); added.push(item);
  }
  return [...previous, ...added];
}
