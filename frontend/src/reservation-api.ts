import { ApiError, getCsrfToken, notifySessionExpired, refreshCsrf } from './api';
import type { ApiErrorBody } from './types';

export interface ReservationIntervalView {
  weekday: number; opens_at_local: string; closes_at_local: string; closes_day_offset: number; accepts_requests: boolean;
}
export interface ReservationSettingsView {
  restaurant_revision: number; enabled: boolean; notice: string | null; privacy_notice_version: string | null;
  timezone: string | null; intervals: ReservationIntervalView[];
}

const invalid = () => new ApiError(502, 'RESPONSE_INVALID');
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number, required = false): string {
  if (typeof value !== 'string' || Array.from(value).length > maximum || (required && !value.trim())) throw invalid();
  return value;
}
function nullableText(value: unknown, maximum: number): string | null {
  return value === null ? null : text(value, maximum);
}
function revision(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw invalid();
  return value;
}
function readSettings(value: unknown): ReservationSettingsView {
  const data = record(value);
  if (!Array.isArray(data.intervals) || data.intervals.length > 21) throw invalid();
  const intervals = data.intervals.map(value => {
    const item = record(value);
    if (!Number.isSafeInteger(item.weekday) || (item.weekday as number) < 1 || (item.weekday as number) > 7
      || !Number.isSafeInteger(item.closes_day_offset) || ![0, 1].includes(item.closes_day_offset as number)
      || typeof item.accepts_requests !== 'boolean') throw invalid();
    return { weekday: item.weekday as number, opens_at_local: text(item.opens_at_local, 5, true),
      closes_at_local: text(item.closes_at_local, 5, true), closes_day_offset: item.closes_day_offset as number,
      accepts_requests: item.accepts_requests };
  });
  return { restaurant_revision: revision(data.restaurant_revision, 1), enabled: data.enabled === true,
    notice: nullableText(data.notice, 2000), privacy_notice_version: nullableText(data.privacy_notice_version, 64),
    timezone: nullableText(data.timezone, 64), intervals };
}
async function request<T>(path: string, read: (value: unknown) => T, options: {
  method?: 'GET' | 'PATCH'; body?: unknown; signal?: AbortSignal; expectedStatus: number;
}): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = window.setTimeout(abort, 20000);
  try {
    const headers = new Headers({ Accept: 'application/json' });
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined) {
      await refreshCsrf();
      headers.set('X-CSRF-Token', getCsrfToken());
      headers.set('Content-Type', 'application/json');
    }
    const response = await fetch(path, { method: options.method ?? 'GET', body, headers, credentials: 'same-origin',
      cache: 'no-store', referrerPolicy: 'same-origin', redirect: 'error', signal: controller.signal });
    const value: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const data = value && typeof value === 'object' ? value as Partial<ApiErrorBody> : {};
      if (response.status === 401) notifySessionExpired();
      throw new ApiError(response.status, typeof data.code === 'string' ? data.code : 'REQUEST_FAILED', [], null);
    }
    if (response.status !== options.expectedStatus) throw invalid();
    return read(value);
  } catch (error) {
    if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
    if (controller.signal.aborted) throw new ApiError(0, 'REQUEST_TIMEOUT');
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, 'NETWORK_ERROR');
  } finally {
    window.clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
export const reservationApi = {
  settings: (restaurantId: string, signal?: AbortSignal) =>
    request(`/api/v1/restaurants/${restaurantId}/reservations/settings`, readSettings, { signal, expectedStatus: 200 }),
  updateSettings: (restaurantId: string, input: { enabled: boolean; notice: string | null;
    privacy_notice_version?: string; expected_revision: number }, signal?: AbortSignal) => {
    if (typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1) throw new ApiError(422, 'REQUEST_INVALID');
    if (input.notice !== null && Array.from(input.notice).length > 2000) throw new ApiError(422, 'REQUEST_INVALID');
    if (input.privacy_notice_version !== undefined && (!input.privacy_notice_version.trim() || Array.from(input.privacy_notice_version).length > 64)) throw new ApiError(422, 'REQUEST_INVALID');
    return request(`/api/v1/restaurants/${restaurantId}/reservations/settings`, readSettings,
      { method: 'PATCH', body: input, signal, expectedStatus: 200 });
  },
};
export function reservationSettingsError(error: unknown): string {
  if (!(error instanceof ApiError)) return '订位设置保存失败，请稍后重试。';
  const messages: Record<string, string> = {
    REVISION_CONFLICT: '餐厅资料已被其他窗口更新，请刷新页面后重试。',
    TIMEZONE_REQUIRED: '请先在餐厅资料中填写时区。',
    PRIVACY_NOTICE_REQUIRED: '请填写隐私说明版本。',
    NO_ACCEPTING_HOURS: '请先在营业时间中勾选至少一个“此段允许申请”。',
    SESSION_EXPIRED: '登录已失效，请重新登录。',
    NETWORK_ERROR: '网络未连接，设置未保存。',
    REQUEST_TIMEOUT: '请求超时，未确认是否保存，请刷新核查。',
  };
  return messages[error.code] ?? '订位设置保存失败，请核查输入后重试。';
}
