import { ApiError, merchantRequest } from './api';

export type ReservationStatus = 'pending' | 'confirmed' | 'declined' | 'cancelled';
export type ReservationActor = 'guest' | 'merchant' | 'system';
export interface PublicReservationView {
  reference: string; status: ReservationStatus; restaurant_name: string; timezone: string;
  guest_name: string; guest_email_masked: string | null; party_size: number;
  local_date: string; local_time: string; requested_start_at: string;
  note: string | null; decision_reason: string | null; cancelled_at: string | null;
  cancelled_by_type: ReservationActor | null; revision: number; created_at: string;
}
export interface MerchantReservationView extends PublicReservationView {
  id: string; guest_email: string | null; guest_phone: string | null; internal_note: string | null;
  decided_at: string | null; decided_by_user_id: string | null; updated_at: string;
}
export interface ReservationEvent {
  event_type: 'created' | 'confirmed' | 'declined' | 'cancelled';
  actor_type: ReservationActor; from_status: ReservationStatus | null; to_status: ReservationStatus;
  reservation_revision: number; created_at: string;
}
export interface ReservationDetail { reservation: MerchantReservationView; events: ReservationEvent[] }
export interface ReservationList { items: MerchantReservationView[]; next_cursor: string | null }
export interface ReservationFilters { status?: ReservationStatus; from?: string; to?: string }
export interface ReservationInterval {
  weekday: number; opens_at_local: string; closes_at_local: string; closes_day_offset: number; accepts_requests: boolean;
}
export interface ReservationSettings {
  restaurant_revision: number; enabled: boolean; notice: string | null; privacy_notice_version: string | null;
  timezone: string | null; intervals: ReservationInterval[];
}
export interface ReservationDecisionInput {
  decision: 'confirm' | 'decline'; expected_revision: number; reason?: string;
}
export interface ReservationCancelInput { expected_revision: number; reason?: string }
export interface ReservationSettingsInput {
  enabled: boolean; notice: string | null; privacy_notice_version?: string; expected_revision: number;
}
export const RESERVATION_PAGE_SIZE = 20;
const statuses: readonly string[] = ['pending', 'confirmed', 'declined', 'cancelled'];
const actors: readonly string[] = ['guest', 'merchant', 'system'];
const reservationIdPattern = /^rsv_[A-Za-z0-9_-]{24}$/;
const restaurantIdPattern = /^[A-Za-z0-9_-]{16,64}$/;
const userIdPattern = /^usr_[A-Za-z0-9_-]{24}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const responseInvalid = () => new ApiError(502, 'RESPONSE_INVALID');
const inputInvalid = () => new ApiError(422, 'REQUEST_INVALID');

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw responseInvalid();
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 10000, required = false): string {
  if (typeof value !== 'string' || Array.from(value).length > max || (required && !value.trim())) throw responseInvalid();
  return value;
}
function nullableString(value: unknown, max = 10000): string | null {
  return value === null ? null : string(value, max);
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw responseInvalid();
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw responseInvalid();
  return value;
}
function status(value: unknown): ReservationStatus {
  if (typeof value !== 'string' || !statuses.includes(value)) throw responseInvalid();
  return value as ReservationStatus;
}
function actor(value: unknown): ReservationActor {
  if (typeof value !== 'string' || !actors.includes(value)) throw responseInvalid();
  return value as ReservationActor;
}
export function isReservationDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function date(value: unknown): string {
  const result = string(value, 10);
  if (!isReservationDate(result)) throw responseInvalid();
  return result;
}
function time(value: unknown): string {
  const result = string(value, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(result)) throw responseInvalid();
  return result;
}
function instant(value: unknown): string {
  const result = string(value, 30);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) ||
      !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) throw responseInvalid();
  return result;
}
function nullableInstant(value: unknown): string | null { return value === null ? null : instant(value); }
function zone(value: unknown): string {
  const result = string(value, 128, true);
  try { new Intl.DateTimeFormat('en-US', { timeZone: result }).format(0); }
  catch { throw responseInvalid(); }
  return result;
}
function safeId(value: unknown, pattern: RegExp): string {
  const result = string(value, 64, true);
  if (!pattern.test(result)) throw responseInvalid();
  return result;
}
function basePath(restaurantId: string): string {
  if (!restaurantIdPattern.test(restaurantId)) throw inputInvalid();
  return `/restaurants/${encodeURIComponent(restaurantId)}/reservations`;
}
function recordPath(restaurantId: string, reservationId: string): string {
  if (!reservationIdPattern.test(reservationId)) throw inputInvalid();
  return `${basePath(restaurantId)}/${encodeURIComponent(reservationId)}`;
}
export function validateReservationFilters(filters: ReservationFilters): void {
  if (Object.keys(filters).some(key => !['status', 'from', 'to'].includes(key)) ||
      (filters.status !== undefined && !statuses.includes(filters.status)) ||
      (filters.from !== undefined && !isReservationDate(filters.from)) ||
      (filters.to !== undefined && !isReservationDate(filters.to)) ||
      (filters.from && filters.to && filters.from > filters.to)) throw inputInvalid();
}
function readReservation(value: unknown, expectedId?: string): MerchantReservationView {
  const item = object(value);
  const id = safeId(item.id, reservationIdPattern);
  if (expectedId !== undefined && id !== expectedId) throw responseInvalid();
  const reference = string(item.reference, 9, true);
  if (!/^R[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(reference)) throw responseInvalid();
  return {
    id, reference, status: status(item.status), restaurant_name: string(item.restaurant_name, 300, true),
    timezone: zone(item.timezone), guest_name: string(item.guest_name, 100, true),
    guest_email_masked: nullableString(item.guest_email_masked, 254), party_size: integer(item.party_size, 1, 20),
    local_date: date(item.local_date), local_time: time(item.local_time), requested_start_at: instant(item.requested_start_at),
    note: nullableString(item.note, 1000), decision_reason: nullableString(item.decision_reason, 500),
    cancelled_at: nullableInstant(item.cancelled_at), cancelled_by_type: item.cancelled_by_type === null ? null : actor(item.cancelled_by_type),
    revision: integer(item.revision, 1, 2147483647), created_at: instant(item.created_at),
    guest_email: nullableString(item.guest_email, 254), guest_phone: nullableString(item.guest_phone, 32),
    internal_note: nullableString(item.internal_note), decided_at: nullableInstant(item.decided_at),
    decided_by_user_id: item.decided_by_user_id === null ? null : safeId(item.decided_by_user_id, userIdPattern),
    updated_at: instant(item.updated_at),
  };
}
function readDetail(value: unknown, expectedId: string): ReservationDetail {
  const data = object(value);
  const reservation = readReservation(data.reservation, expectedId);
  if (!Array.isArray(data.events) || data.events.length > 50) throw responseInvalid();
  const events = data.events.map((value): ReservationEvent => {
    const event = object(value);
    const eventType = string(event.event_type, 20);
    if (!['created', 'confirmed', 'declined', 'cancelled'].includes(eventType)) throw responseInvalid();
    const from = event.from_status === null ? null : status(event.from_status);
    const to = status(event.to_status);
    if ((eventType === 'created' && (from !== null || to !== 'pending')) ||
        ((eventType === 'confirmed' || eventType === 'declined') && (from !== 'pending' || to !== eventType)) ||
        (eventType === 'cancelled' && ((!from || !['pending', 'confirmed'].includes(from)) || to !== 'cancelled'))) throw responseInvalid();
    return { event_type: eventType as ReservationEvent['event_type'], actor_type: actor(event.actor_type),
      from_status: from, to_status: to, reservation_revision: integer(event.reservation_revision, 1, reservation.revision),
      created_at: instant(event.created_at) };
  });
  for (let i = 1; i < events.length; i += 1) {
    if (events[i]!.reservation_revision >= events[i - 1]!.reservation_revision) throw responseInvalid();
  }
  return { reservation, events };
}
function readCursor(value: unknown, restaurantId: string): { token: string; t: string; i: string } {
  const token = string(value, 1024, true);
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw responseInvalid();
  try {
    const encoded = token.split('.')[0]!;
    const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4)), c => c.charCodeAt(0));
    const cursor = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (cursor.v !== 1 || cursor.r !== restaurantId || cursor.l !== RESERVATION_PAGE_SIZE) throw responseInvalid();
    safeId(cursor.u, userIdPattern);
    // 此处只验证游标结构和作用域；签名真实性仍由后端验证。
    return { token, t: instant(cursor.t), i: safeId(cursor.i, reservationIdPattern) };
  } catch { throw responseInvalid(); }
}
function readList(value: unknown, restaurantId: string, filters: ReservationFilters): ReservationList {
  const data = object(value);
  if (!Array.isArray(data.items) || data.items.length > RESERVATION_PAGE_SIZE) throw responseInvalid();
  const items = data.items.map(value => readReservation(value));
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id) || (filters.status && item.status !== filters.status) ||
        (filters.from && item.local_date < filters.from) || (filters.to && item.local_date > filters.to)) throw responseInvalid();
    seen.add(item.id);
  }
  for (let i = 1; i < items.length; i += 1) {
    if (items[i]!.created_at > items[i - 1]!.created_at) throw responseInvalid();
  }
  let nextCursor: string | null = null;
  if (data.next_cursor !== null) {
    const cursor = readCursor(data.next_cursor, restaurantId);
    const last = items.at(-1);
    if (items.length !== RESERVATION_PAGE_SIZE || !last || last.id !== cursor.i || last.created_at !== cursor.t) throw responseInvalid();
    nextCursor = cursor.token;
  }
  return { items, next_cursor: nextCursor };
}
function readSettings(value: unknown): ReservationSettings {
  const data = object(value);
  if (!Array.isArray(data.intervals) || data.intervals.length > 21) throw responseInvalid();
  const intervals = data.intervals.map((value): ReservationInterval => {
    const interval = object(value);
    const start = time(interval.opens_at_local), end = time(interval.closes_at_local);
    const offset = integer(interval.closes_day_offset, 0, 1);
    const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    const duration = minutes(end) + offset * 1440 - minutes(start);
    if (duration <= 0 || duration > 1440) throw responseInvalid();
    return { weekday: integer(interval.weekday, 1, 7), opens_at_local: start, closes_at_local: end,
      closes_day_offset: offset, accepts_requests: boolean(interval.accepts_requests) };
  });
  return { restaurant_revision: integer(data.restaurant_revision, 1, 2147483647), enabled: boolean(data.enabled),
    notice: nullableString(data.notice, 2000), privacy_notice_version: nullableString(data.privacy_notice_version, 64),
    timezone: data.timezone === null ? null : zone(data.timezone), intervals };
}
function expectedRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483646) throw inputInvalid();
}
function reasonInput(reason: unknown, required: boolean): void {
  if ((reason !== undefined && (typeof reason !== 'string' || Array.from(reason).length > 500 || !reason.trim())) ||
      (required && (typeof reason !== 'string' || !reason.trim()))) throw inputInvalid();
}
function keyInput(key: string): void { if (!uuidPattern.test(key)) throw inputInvalid(); }
function writeOptions(body: unknown, key: string, signal?: AbortSignal) {
  keyInput(key);
  return { body, signal, session: true, csrf: true, headers: { 'Idempotency-Key': key } };
}
export const reservationsClient = {
  async list(restaurantId: string, filters: ReservationFilters, cursor?: string, signal?: AbortSignal): Promise<ReservationList> {
    const path = basePath(restaurantId);
    validateReservationFilters(filters);
    if (cursor !== undefined) readCursor(cursor, restaurantId);
    const query = new URLSearchParams({ limit: String(RESERVATION_PAGE_SIZE) });
    if (filters.status) query.set('status', filters.status);
    if (filters.from) query.set('from', filters.from);
    if (filters.to) query.set('to', filters.to);
    if (cursor) query.set('cursor', cursor);
    const { data } = await merchantRequest<unknown>(`${path}?${query}`, { session: true, signal });
    return readList(data, restaurantId, filters);
  },
  async detail(restaurantId: string, reservationId: string, signal?: AbortSignal): Promise<ReservationDetail> {
    const { data } = await merchantRequest<unknown>(recordPath(restaurantId, reservationId), { session: true, signal });
    return readDetail(data, reservationId);
  },
  async decide(restaurantId: string, reservationId: string, input: ReservationDecisionInput, key: string, signal?: AbortSignal): Promise<MerchantReservationView> {
    const path = recordPath(restaurantId, reservationId);
    if (!['confirm', 'decline'].includes(input.decision) || Object.keys(input).some(key => !['decision', 'expected_revision', 'reason'].includes(key))) throw inputInvalid();
    expectedRevision(input.expected_revision);
    reasonInput(input.reason, input.decision === 'decline');
    const { data } = await merchantRequest<unknown>(`${path}/decision`, { method: 'POST', ...writeOptions(input, key, signal) });
    const result = readReservation(data, reservationId);
    if (result.revision <= input.expected_revision) throw responseInvalid();
    return result;
  },
  async cancel(restaurantId: string, reservationId: string, input: ReservationCancelInput, key: string, signal?: AbortSignal): Promise<MerchantReservationView> {
    const path = recordPath(restaurantId, reservationId);
    if (Object.keys(input).some(key => !['expected_revision', 'reason'].includes(key))) throw inputInvalid();
    expectedRevision(input.expected_revision);
    reasonInput(input.reason, false);
    const { data } = await merchantRequest<unknown>(`${path}/cancel`, { method: 'POST', ...writeOptions(input, key, signal) });
    const result = readReservation(data, reservationId);
    if (result.revision <= input.expected_revision) throw responseInvalid();
    return result;
  },
  async settings(restaurantId: string, signal?: AbortSignal): Promise<ReservationSettings> {
    const { data } = await merchantRequest<unknown>(`${basePath(restaurantId)}/settings`, { session: true, signal });
    return readSettings(data);
  },
  async updateSettings(restaurantId: string, input: ReservationSettingsInput, key: string, signal?: AbortSignal): Promise<ReservationSettings> {
    const path = basePath(restaurantId);
    expectedRevision(input.expected_revision);
    if (Object.keys(input).some(key => !['enabled', 'notice', 'privacy_notice_version', 'expected_revision'].includes(key)) ||
        typeof input.enabled !== 'boolean' || (input.notice !== null && (typeof input.notice !== 'string' || Array.from(input.notice).length > 2000)) ||
        (input.privacy_notice_version !== undefined && (typeof input.privacy_notice_version !== 'string' ||
          !input.privacy_notice_version.trim() || Array.from(input.privacy_notice_version).length > 64))) throw inputInvalid();
    // PATCH 后端只提供 expected_revision 并发保护，不提供 Idempotency-Key 重放语义。
    const { data } = await merchantRequest<unknown>(`${path}/settings`, { method: 'PATCH', ...writeOptions(input, key, signal) });
    const result = readSettings(data);
    if (result.restaurant_revision !== input.expected_revision + 1) throw responseInvalid();
    return result;
  },
};
export function reservationErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'The request could not be completed. Refresh to check the current state.';
  if (error.status === 401) return 'Your session needs attention. Sign in again before continuing.';
  if (error.status === 409) return 'The reservation changed, reached a final state, or conflicts with this request. Refresh before making a new decision.';
  if (error.status === 412) return 'Restaurant settings changed elsewhere. Refresh settings, review your draft, then explicitly confirm a new save.';
  if (error.status === 429) return `Too many requests. Try again${error.retryAfter !== null ? ` after ${error.retryAfter} seconds` : ' later'}.`;
  const messages: Record<string, string> = {
    REQUEST_INVALID: 'Check the date range, required reason, and field lengths.',
    RESPONSE_INVALID: 'The server response could not be verified. Refresh to check the current state.',
    NETWORK_ERROR: 'The connection was interrupted. A write may have completed; refresh to verify.',
    REQUEST_TIMEOUT: 'The request timed out. A write may have completed; refresh to verify.',
    TIMEZONE_REQUIRED: 'Set a restaurant timezone in restaurant details before enabling requests.',
    PRIVACY_NOTICE_REQUIRED: 'Enter a privacy notice version before enabling requests.',
    NO_ACCEPTING_HOURS: 'Mark at least one opening-hours interval as accepting requests before enabling.',
    RESTAURANT_UNAVAILABLE: 'This restaurant is not currently available for changes.',
  };
  if (error.status === 403) return 'This request was not authorized. Check your session and permissions; no automatic retry was made.';
  if (error.status === 404) return 'The requested restaurant or reservation is no longer available to this account.';
  return messages[error.code] ?? 'The request could not be completed. Refresh and review the current state.';
}
