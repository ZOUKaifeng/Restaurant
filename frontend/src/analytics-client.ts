import { ApiError, merchantRequest } from './api';

export type AnalyticsNamespace = 'production' | 'local_test';
export type AnalyticsRange = { from: string; to: string };
export type AnalyticsQuery = { from?: string; to?: string; namespace?: AnalyticsNamespace };
export type ReservationBasis = 'created' | 'scheduled';
export type TrafficCounts = {
  page_views: number;
  reservation_clicks: number;
  reservation_form_views: number;
};
export type ReservationStatuses = {
  pending: number;
  confirmed: number;
  declined: number;
  cancelled: number;
};
export type ReservationCounts = {
  requests: number;
  party_size: number;
  statuses: ReservationStatuses;
};
export type TrafficDay = TrafficCounts & { date: string; timezone: string; timezone_fallback: boolean };
export type ReservationDay = ReservationCounts & { date: string; timezone: string };
export type AnalyticsReport = {
  restaurant_id: string;
  range: AnalyticsRange;
  namespace: AnalyticsNamespace;
  metric_version: 'v1';
  generated_at: string;
  current_timezone: string;
  timezone_fallback: boolean;
  traffic: {
    days: TrafficDay[];
    totals: TrafficCounts;
    semantics: Record<string, unknown>;
  };
  reservations: {
    scope: 'all_restaurant_records';
    status_semantics: 'current_status_at_query_time';
    created: { days: ReservationDay[]; totals: ReservationCounts };
    scheduled: { days: ReservationDay[]; totals: ReservationCounts };
  };
  subscriptions: { available: false; active_count: null; reason: 'SUBSCRIPTIONS_NOT_IMPLEMENTED' };
  visitors: { available: false; unique_visitors: null; reason: 'UV_NOT_MEASURED' };
};

const dayMilliseconds = 86_400_000;
const trafficKeys = ['page_views', 'reservation_clicks', 'reservation_form_views'] as const;
const statusKeys = ['pending', 'confirmed', 'declined', 'cancelled'] as const;

function invalidResponse(): never {
  throw new ApiError(502, 'ANALYTICS_RESPONSE_INVALID');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidResponse();
  return value as Record<string, unknown>;
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalidResponse();
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalidResponse();
  return value;
}

function calendar(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000')) return null;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}

export function validateAnalyticsRange(range: AnalyticsRange): void {
  const from = calendar(range.from), to = calendar(range.to);
  if (from === null || to === null || from > to || to - from > 365 * dayMilliseconds) {
    throw new ApiError(422, 'ANALYTICS_RANGE_INVALID');
  }
}

export function analyticsCalendarDates(range: AnalyticsRange): string[] {
  validateAnalyticsRange(range);
  const dates: string[] = [];
  const end = calendar(range.to)!;
  for (let time = calendar(range.from)!; time <= end; time += dayMilliseconds) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }
  return dates;
}

export function safeAnalyticsSum(values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + BigInt(count(value)), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new ApiError(502, 'ANALYTICS_COUNT_OVERFLOW');
  return Number(total);
}

function validateQuery(restaurantId: string, query: AnalyticsQuery): void {
  if (typeof restaurantId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(restaurantId)) {
    throw new ApiError(400, 'ANALYTICS_REQUEST_INVALID');
  }
  if (!query || typeof query !== 'object' || Array.isArray(query)
    || Object.keys(query).some(key => !['from', 'to', 'namespace'].includes(key))) {
    throw new ApiError(422, 'ANALYTICS_REQUEST_INVALID');
  }
  const hasFrom = Object.hasOwn(query, 'from'), hasTo = Object.hasOwn(query, 'to');
  if (hasFrom !== hasTo) throw new ApiError(422, 'ANALYTICS_RANGE_INVALID');
  if (hasFrom) validateAnalyticsRange({ from: query.from!, to: query.to! });
  if (Object.hasOwn(query, 'namespace') && query.namespace !== 'production' && query.namespace !== 'local_test') {
    throw new ApiError(422, 'ANALYTICS_NAMESPACE_INVALID');
  }
}

function dateInRange(value: unknown, range: AnalyticsRange): string {
  if (typeof value !== 'string' || calendar(value) === null || value < range.from || value > range.to) invalidResponse();
  return value;
}

function generatedAt(value: unknown): string {
  if (typeof value !== 'string') invalidResponse();
  const match = /^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(Z|[+-]([0-9]{2}):([0-9]{2}))$/.exec(value);
  if (!match || calendar(match[1]) === null || Number(match[2]) > 23 || Number(match[3]) > 59
    || Number(match[4]) > 59 || (match[6] !== undefined && (Number(match[6]) > 23 || Number(match[7]) > 59))
    || !Number.isFinite(Date.parse(value))) invalidResponse();
  return value;
}

function readTrafficCounts(value: unknown): TrafficCounts {
  const row = object(value);
  return {
    page_views: count(row.page_views),
    reservation_clicks: count(row.reservation_clicks),
    reservation_form_views: count(row.reservation_form_views),
  };
}

function readReservationCounts(value: unknown): ReservationCounts {
  const row = object(value), states = object(row.statuses);
  const statuses: ReservationStatuses = {
    pending: count(states.pending), confirmed: count(states.confirmed),
    declined: count(states.declined), cancelled: count(states.cancelled),
  };
  const requests = count(row.requests);
  if (safeAnalyticsSum(statusKeys.map(key => statuses[key])) !== requests) invalidResponse();
  return { requests, party_size: count(row.party_size), statuses };
}

function compareDays(a: { date: string; timezone: string; timezone_fallback?: boolean }, b: { date: string; timezone: string; timezone_fallback?: boolean }): number {
  // 使用字符串日历顺序，避免浏览器本地时区或语言影响历史分桶顺序。
  const left = `${a.date}\0${a.timezone}\0${Number(a.timezone_fallback ?? false)}`;
  const right = `${b.date}\0${b.timezone}\0${Number(b.timezone_fallback ?? false)}`;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function validateAnalyticsReport(value: unknown, restaurantId: string, query: AnalyticsQuery = {}): AnalyticsReport {
  validateQuery(restaurantId, query);
  const raw = object(value), rawRange = object(raw.range);
  if (raw.restaurant_id !== restaurantId || raw.metric_version !== 'v1'
    || (raw.namespace !== 'production' && raw.namespace !== 'local_test')) invalidResponse();
  if (typeof rawRange.from !== 'string' || typeof rawRange.to !== 'string') invalidResponse();
  const range = { from: rawRange.from, to: rawRange.to };
  try { validateAnalyticsRange(range); } catch { invalidResponse(); }
  if ((query.from !== undefined && (range.from !== query.from || range.to !== query.to))
    || (query.namespace !== undefined && raw.namespace !== query.namespace)) invalidResponse();

  const checkedTimezones = new Set<string>();
  const timezone = (value: unknown): string => {
    if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(value)) invalidResponse();
    if (!checkedTimezones.has(value)) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: value }); } catch { invalidResponse(); }
      checkedTimezones.add(value);
    }
    return value;
  };
  const currentTimezone = timezone(raw.current_timezone), timezoneFallback = boolean(raw.timezone_fallback);
  if (timezoneFallback && currentTimezone !== 'UTC') invalidResponse();
  const traffic = object(raw.traffic), trafficTotals = readTrafficCounts(traffic.totals);
  if (!Array.isArray(traffic.days)) invalidResponse();
  const trafficDays: TrafficDay[] = traffic.days.map(value => {
    const row = object(value), tz = timezone(row.timezone), fallback = boolean(row.timezone_fallback);
    if (fallback && tz !== 'UTC') invalidResponse();
    return { ...readTrafficCounts(row), date: dateInRange(row.date, range), timezone: tz, timezone_fallback: fallback };
  }).sort(compareDays);
  for (const key of trafficKeys) {
    if (safeAnalyticsSum(trafficDays.map(day => day[key])) !== trafficTotals[key]) invalidResponse();
  }
  const semantics = object(traffic.semantics);
  const reservations = object(raw.reservations);
  if (reservations.scope !== 'all_restaurant_records' || reservations.status_semantics !== 'current_status_at_query_time') invalidResponse();
  const reservationGroup = (value: unknown): { days: ReservationDay[]; totals: ReservationCounts } => {
    const rawGroup = object(value), totals = readReservationCounts(rawGroup.totals);
    if (!Array.isArray(rawGroup.days)) invalidResponse();
    const days: ReservationDay[] = rawGroup.days.map(value => {
      const row = object(value);
      return { ...readReservationCounts(row), date: dateInRange(row.date, range), timezone: timezone(row.timezone) };
    }).sort(compareDays);
    for (const key of ['requests', 'party_size'] as const) {
      if (safeAnalyticsSum(days.map(day => day[key])) !== totals[key]) invalidResponse();
    }
    for (const key of statusKeys) {
      if (safeAnalyticsSum(days.map(day => day.statuses[key])) !== totals.statuses[key]) invalidResponse();
    }
    return { days, totals };
  };
  const subscriptions = object(raw.subscriptions), visitors = object(raw.visitors);
  if (subscriptions.available !== false || subscriptions.active_count !== null || subscriptions.reason !== 'SUBSCRIPTIONS_NOT_IMPLEMENTED'
    || visitors.available !== false || visitors.unique_visitors !== null || visitors.reason !== 'UV_NOT_MEASURED') invalidResponse();
  return {
    restaurant_id: restaurantId, range, namespace: raw.namespace, metric_version: 'v1',
    generated_at: generatedAt(raw.generated_at), current_timezone: currentTimezone, timezone_fallback: timezoneFallback,
    traffic: { days: trafficDays, totals: trafficTotals, semantics: { ...semantics } },
    reservations: {
      scope: 'all_restaurant_records', status_semantics: 'current_status_at_query_time',
      created: reservationGroup(reservations.created), scheduled: reservationGroup(reservations.scheduled),
    },
    subscriptions: { available: false, active_count: null, reason: 'SUBSCRIPTIONS_NOT_IMPLEMENTED' },
    visitors: { available: false, unique_visitors: null, reason: 'UV_NOT_MEASURED' },
  };
}

export async function readAnalytics(restaurantId: string, query: AnalyticsQuery = {}, signal?: AbortSignal): Promise<AnalyticsReport> {
  // 请求与回包校验共用不可变快照，防止调用者在请求途中改变期待范围。
  const expected = { ...query };
  validateQuery(restaurantId, expected);
  const params = new URLSearchParams();
  if (expected.from !== undefined) { params.set('from', expected.from); params.set('to', expected.to!); }
  if (expected.namespace !== undefined) params.set('namespace', expected.namespace);
  const suffix = params.size ? `?${params}` : '';
  const { data } = await merchantRequest<unknown>(`/restaurants/${encodeURIComponent(restaurantId)}/analytics${suffix}`, {
    method: 'GET', session: true, signal,
  });
  return validateAnalyticsReport(data, restaurantId, expected);
}
