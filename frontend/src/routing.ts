export type Page = 'home' | 'examples' | 'app' | 'login' | 'register' | 'forgot' | 'resend' | 'verify' | 'reset' | 'sessions' | 'usage' | 'pricing' | 'billing' | 'terms' | 'privacy' | 'not-found';
export interface RouteState { page: Page; path: string; token: string | null }

export function readRoute(): RouteState {
  const path = window.location.pathname;
  const pages: Record<string, Page> = {
    '/': 'home', '/examples': 'examples', '/pricing': 'pricing', '/account/billing': 'billing', '/app': 'app', '/app/restaurants': 'app',
    '/app/reservations': 'app', '/app/analytics': 'app',
    '/auth/login': 'login', '/auth/register': 'register',
    '/auth/forgot': 'forgot', '/auth/resend': 'resend', '/auth/verify': 'verify', '/auth/reset': 'reset', '/account/sessions': 'sessions', '/account/usage': 'usage',
  };
  const page = pages[path] ?? (path.startsWith('/legal/privacy') ? 'privacy' : path.startsWith('/legal/terms') ? 'terms' : 'not-found');
  let token: string | null = null;
  if (page === 'verify' || page === 'reset') {
    const candidate = new URLSearchParams(window.location.hash.slice(1)).get('token')
      ?? new URLSearchParams(window.location.search).get('token');
    if (candidate && candidate.length >= 32 && candidate.length <= 256) token = candidate;
    // 在任何网络请求之前移除令牌，不放入 history.state 或可见页面。
    window.history.replaceState(null, '', path);
  }
  return { page, path, token };
}

export function legalPath(value: string | undefined, kind: 'terms' | 'privacy'): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin && url.pathname.startsWith(`/legal/${kind}`) ? url.pathname : null;
  } catch { return null; }
}
