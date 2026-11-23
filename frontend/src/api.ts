import type {
  Accepted, ActionTokenInput, ApiErrorBody, CsrfResponse, EmailInput, LoginInput,
  LoginResponse, LogoutAllInput, OpeningHoursInput, OpeningHoursView,
  RegisterInput, RegistrationPolicy, ResetPasswordInput, Restaurant,
  RestaurantCreateInput, RestaurantList, RestaurantPatchInput, SessionView, Versioned,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ApiErrorBody['details'];
  readonly retryAfter: number | null;

  constructor(status: number, code: string, details: ApiErrorBody['details'] = [], retryAfter: number | null = null) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

let csrfToken: string | null = null;
let csrfFlight: Promise<void> | null = null;
const expiredListeners = new Set<() => void>();

export function onSessionExpired(listener: () => void) {
  expiredListeners.add(listener);
  return () => { expiredListeners.delete(listener); };
}

export function clearCsrf() { csrfToken = null; }
export function getCsrfToken(): string {
  if (!csrfToken) throw new ApiError(403, 'CSRF_REQUIRED');
  return csrfToken;
}
export function notifySessionExpired(): void {
  clearCsrf();
  expiredListeners.forEach(listener => listener());
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT';
  body?: unknown;
  headers?: Record<string, string>;
  csrf?: boolean;
  session?: boolean;
  signal?: AbortSignal;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<{ data: T; headers: Headers }> {
  if (options.csrf) await refreshCsrf();
  if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  const headers = new Headers({ Accept: 'application/json', ...options.headers });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.csrf && csrfToken) headers.set('X-CSRF-Token', csrfToken);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = window.setTimeout(abort, 20000);
  let response: Response;
  let data: unknown;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      referrerPolicy: 'same-origin',
      redirect: 'error',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    data = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  } catch {
    if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
    throw new ApiError(0, controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR');
  } finally {
    window.clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
  if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  if (!response.ok) {
    const body = data && typeof data === 'object' ? data as Partial<ApiErrorBody> : {};
    const details = Array.isArray(body.details)
      ? body.details.filter((item): item is ApiErrorBody['details'][number] => !!item && typeof item.field === 'string' && typeof item.code === 'string').slice(0, 50)
      : [];
    const retryHeader = response.headers.get('Retry-After');
    const retryAfter = retryHeader && /^\d{1,6}$/.test(retryHeader) ? Number(retryHeader) : null;
    const error = new ApiError(response.status, typeof body.code === 'string' ? body.code : 'REQUEST_FAILED', details, retryAfter);
    if (options.session && response.status === 401 && /^Session(?:\s|$)/i.test(response.headers.get('WWW-Authenticate') ?? '')) {
      clearCsrf();
      expiredListeners.forEach((listener) => listener());
      await refreshCsrf().catch(() => undefined);
    } else if (response.status === 403 && /CSRF/i.test(error.code)) {
      clearCsrf();
      await refreshCsrf().catch(() => undefined);
    }
    // 不自动重放写操作；会话或 CSRF 改变后由用户重新确认。
    throw error;
  }
  if (response.status !== 204 && data === undefined) throw new ApiError(502, 'RESPONSE_INVALID');
  return { data: data as T, headers: response.headers };
}

// Shared transport for restaurant-scoped pages: real session, CSRF, timeout, no replay.
export { request as merchantRequest };

export function refreshCsrf(): Promise<void> {
  if (!csrfFlight) {
    csrfFlight = request<CsrfResponse>('/auth/csrf').then(({ data }) => {
      if (typeof data.csrf_token !== 'string' || data.csrf_token.length < 32 || data.csrf_token.length > 256) {
        throw new ApiError(502, 'RESPONSE_INVALID');
      }
      csrfToken = data.csrf_token;
    }).finally(() => { csrfFlight = null; });
  }
  return csrfFlight;
}

function versioned<T>(response: { data: T; headers: Headers }, id: string, revision: number): Versioned<T> {
  const etag = response.headers.get('ETag');
  if (!etag || etag !== `"restaurant-${id}-v${revision}"`) throw new ApiError(502, 'ETAG_INVALID');
  return { data: response.data, etag };
}

function restaurantPath(id: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) throw new ApiError(400, 'REQUEST_INVALID');
  return `/restaurants/${encodeURIComponent(id)}`;
}

function restaurantResponse(response: { data: Restaurant; headers: Headers }, expectedId?: string) {
  if ((expectedId && response.data.id !== expectedId) || response.data.role !== 'owner') {
    throw new ApiError(502, 'RESPONSE_INVALID');
  }
  return versioned(response, response.data.id, response.data.revision);
}

function hoursResponse(response: { data: OpeningHoursView; headers: Headers }, id: string) {
  if (response.data.restaurant_id !== id) throw new ApiError(502, 'RESPONSE_INVALID');
  return versioned(response, id, response.data.restaurant_revision);
}

export const api = {
  policy: async (signal?: AbortSignal) => (await request<RegistrationPolicy>('/auth/registration-policy', { signal })).data,
  me: async (signal?: AbortSignal): Promise<SessionView | null> => {
    try { return (await request<SessionView>('/auth/me', { signal })).data; }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  },
  register: async (body: RegisterInput) => (await request<Accepted>('/auth/register', { method: 'POST', body, csrf: true })).data,
  resendVerification: async (body: EmailInput) => (await request<Accepted>('/auth/verification-emails', { method: 'POST', body, csrf: true })).data,
  verify: async (body: ActionTokenInput) => { await request<void>('/auth/verify-email', { method: 'POST', body }); },
  login: async (body: LoginInput): Promise<SessionView> => {
    const { data } = await request<LoginResponse>('/auth/login', { method: 'POST', body, csrf: true });
    if (typeof data.csrf_token !== 'string' || data.csrf_token.length < 32 || data.csrf_token.length > 256) {
      clearCsrf();
      throw new ApiError(502, 'RESPONSE_INVALID');
    }
    csrfToken = data.csrf_token;
    return { user: data.user, session_expires_at: data.session_expires_at };
  },
  requestReset: async (body: EmailInput) => (await request<Accepted>('/auth/password-reset-requests', { method: 'POST', body, csrf: true })).data,
  reset: async (body: ResetPasswordInput) => {
    await request<void>('/auth/password-reset', { method: 'POST', body });
    clearCsrf();
  },
  logout: async () => {
    await request<void>('/auth/logout', { method: 'POST', csrf: true, session: true });
    clearCsrf();
  },
  logoutAll: async (body: LogoutAllInput) => {
    // 401 也可能是当前密码错误，不能据此假称会话已注销。
    await request<void>('/auth/logout-all', { method: 'POST', body, csrf: true });
    clearCsrf();
  },
  restaurants: async (cursor?: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ limit: '20' });
    if (cursor) query.set('cursor', cursor);
    return (await request<RestaurantList>(`/restaurants?${query}`, { session: true, signal })).data;
  },
  createRestaurant: async (body: RestaurantCreateInput, key: string) => restaurantResponse(await request<Restaurant>('/restaurants', {
    method: 'POST', body, csrf: true, session: true, headers: { 'Idempotency-Key': key },
  })),
  restaurant: async (id: string, signal?: AbortSignal) => restaurantResponse(await request<Restaurant>(restaurantPath(id), { session: true, signal }), id),
  updateRestaurant: async (id: string, body: RestaurantPatchInput, etag: string) => restaurantResponse(await request<Restaurant>(restaurantPath(id), {
    method: 'PATCH', body, csrf: true, session: true, headers: { 'If-Match': etag },
  }), id),
  hours: async (id: string, signal?: AbortSignal) => hoursResponse(await request<OpeningHoursView>(`${restaurantPath(id)}/opening-hours`, { session: true, signal }), id),
  updateHours: async (id: string, body: OpeningHoursInput, etag: string) => hoursResponse(await request<OpeningHoursView>(`${restaurantPath(id)}/opening-hours`, {
    method: 'PUT', body, csrf: true, session: true, headers: { 'If-Match': etag },
  }), id),
};
