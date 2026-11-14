import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, onSessionExpired, refreshCsrf } from './api';
import AuthView from './AuthView';
import Dashboard from './Dashboard';
import { readRoute } from './routing';
import type { RouteState } from './routing';
import type { CurrentUser, RegistrationPolicy, SessionView } from './types';
import { ActionFeedback, ErrorNotice, PageLink, useAction } from './ui';
import type { Navigate } from './ui';

function SessionSettings({ user, busy, onBusyChange, onLoggedOut }: {
  user: CurrentUser; busy: boolean; onBusyChange: (busy: boolean) => void; onLoggedOut: () => void;
}) {
  const action = useAction(onBusyChange);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || action.pending) return;
    const form = event.currentTarget;
    const password = String(new FormData(form).get('current_password') ?? '');
    const input = form.elements.namedItem('current_password');
    if (input instanceof HTMLInputElement) input.value = '';
    void action.run(async () => {
      await api.logoutAll({ current_password: password });
      onLoggedOut();
    });
  }
  return <section className="auth-layout"><div className="section-intro"><p className="eyebrow">账户 / 会话</p><h1 tabIndex={-1}>会话管理</h1><p className="muted">全设备退出需要验证当前密码，包括本设备。不会修改账号角色。</p></div><div className="form-column"><form onSubmit={submit} aria-busy={action.pending}><fieldset disabled={busy || action.pending}><div className="field"><label htmlFor="session-email">当前邮箱</label><input id="session-email" name="email" type="email" value={user.email} autoComplete="username" readOnly /></div><div className="field"><label htmlFor="current-password">当前密码</label><input id="current-password" name="current_password" type="password" autoComplete="current-password" minLength={1} maxLength={128} required /></div><button type="submit" className="primary-button">{action.pending ? '正在撤销会话…' : '验证密码并退出所有设备'}</button></fieldset></form><ActionFeedback action={action} /></div></section>;
}

function LegalDraft({ route, policy, navigate, busy }: {
  route: RouteState; policy: RegistrationPolicy | null; navigate: Navigate; busy: boolean;
}) {
  const privacy = route.page === 'privacy';
  return <section className="legal-draft"><p className="eyebrow">账户 / 草案说明</p><h1 tabIndex={-1}>{privacy ? '隐私告知草案' : '条款草案'}</h1><p className="muted">当前版本：{privacy ? policy?.privacy_notice_version ?? '尚未读取' : policy?.terms_version ?? '尚未读取'}</p><div className="notice"><p>正式内容尚未审核。本页仅标识注册政策返回的草案版本，不伪造已生效的服务条款、隐私承诺或营销授权。</p><p>完整正式内容和审核仍待项目方提供。本页面不代表正式条款已上线。</p></div><PageLink href="/auth/register" navigate={navigate} disabled={busy}>返回注册，重新填写并确认</PageLink></section>;
}

export default function App({ initialRoute }: { initialRoute: RouteState }) {
  const [route, setRoute] = useState(initialRoute);
  const [session, setSession] = useState<SessionView | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<unknown>(null);
  const [policy, setPolicy] = useState<RegistrationPolicy | null>(null);
  const [policyLoading, setPolicyLoading] = useState(true);
  const [policyError, setPolicyError] = useState<unknown>(null);
  const [csrfError, setCsrfError] = useState<unknown>(null);
  const [childBusy, setChildBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [bootVersion, setBootVersion] = useState(0);
  const action = useAction();
  const policyAction = useAction();
  const busy = childBusy || action.pending;

  useEffect(() => {
    const controller = new AbortController();
    setBooting(true);
    setBootError(null);
    setPolicyLoading(true);
    setPolicyError(null);
    setCsrfError(null);
    void api.me(controller.signal).then((value) => {
      if (!controller.signal.aborted) { setSession(value); setBooting(false); }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) { setBootError(error); setBooting(false); }
    });
    void api.policy(controller.signal).then((value) => {
      if (!controller.signal.aborted) { setPolicy(value); setPolicyLoading(false); }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) { setPolicyError(error); setPolicyLoading(false); }
    });
    void refreshCsrf().catch((error: unknown) => { if (!controller.signal.aborted) setCsrfError(error); });
    return () => controller.abort();
  }, [bootVersion]);

  useEffect(() => onSessionExpired(() => {
    setSession(null);
    setNotice('会话已失效，请重新登录。安全上下文正在更新，原写请求不会自动重放。');
    window.history.replaceState(null, '', '/auth/login');
    setRoute({ page: 'login', path: '/auth/login', token: null });
  }), []);

  useEffect(() => {
    const pop = () => {
      if (busy) { window.history.pushState(null, '', route.path); return; }
      setRoute(readRoute());
      setNotice('');
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [busy, route.path]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const heading = document.querySelector<HTMLElement>('main h1');
      document.title = heading ? `${heading.textContent ?? '商家工作台'} · 商家工作台` : '商家工作台';
      if (!booting) heading?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [route.path, booting, session?.user.id]);

  function forceNavigate(path: string) {
    window.history.pushState(null, '', path);
    setRoute(readRoute());
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
  const navigate: Navigate = (path) => {
    if (busy || !path.startsWith('/') || path.startsWith('//') || path === route.path) return;
    action.clear();
    setNotice('');
    forceNavigate(path);
  };
  function loggedIn(value: SessionView) {
    setSession(value);
    setBootError(null);
    setCsrfError(null);
    setNotice('');
    forceNavigate('/');
  }
  function loggedOut(all = false) {
    setSession(null);
    setCsrfError(null);
    setNotice(all ? '所有设备的会话已撤销。请自行重新登录。' : '当前会话已在服务端撤销。');
    forceNavigate('/auth/login');
  }
  function logout() {
    if (busy) return;
    void action.run(async () => { await api.logout(); loggedOut(); });
  }
  function reloadPolicy() {
    if (policyLoading || policyAction.pending) return;
    setPolicyError(null);
    void policyAction.run(async () => { setPolicy(await api.policy()); });
  }
  const dashboard = session && (route.page === 'home' || route.page === 'login');
  const legal = route.page === 'terms' || route.page === 'privacy';

  return <div className="app-shell">
    <a className="skip-link" href="#main">跳到主要内容</a>
    <header className="site-header">
      <PageLink href="/" navigate={navigate} disabled={busy} className="wordmark">商家工作台<span className="brand-dot" aria-hidden="true" /></PageLink>
      <nav className="header-nav" aria-label="主导航">
        {session ? <><span className="account-email">{session.user.email}</span><PageLink href="/" navigate={navigate} disabled={busy}>餐厅</PageLink><PageLink href="/account/sessions" navigate={navigate} disabled={busy}>会话管理</PageLink><button type="button" className="text-button" disabled={busy} onClick={logout}>退出登录</button></>
          : <PageLink href="/auth/login" navigate={navigate} disabled={busy}>账户登录</PageLink>}
      </nav>
    </header>
    <main id="main" tabIndex={-1}>
      {notice && <div className="notice global-notice" role="status">{notice}</div>}
      <ActionFeedback action={action} />
      {booting ? <section className="boot-state" aria-busy="true" role="status"><p>正在检查账户会话…</p><div className="skeleton-line" /><div className="skeleton-line short" /></section>
        : <>
          {Boolean(bootError) && <section className="boot-error"><ErrorNotice error={bootError} /><button type="button" disabled={busy} onClick={() => setBootVersion((value) => value + 1)}>重新检查服务与会话</button><p className="micro">未确认会话状态，不使用模拟登录。仍可尝试真实账户操作。</p></section>}
          {Boolean(csrfError) && !session && <section className="boot-error"><ErrorNotice error={csrfError} /><p className="micro">写操作会再次请求安全上下文；请检查本地 HTTPS 与后端同源配置。</p></section>}
          {legal ? <LegalDraft route={route} policy={policy} navigate={navigate} busy={busy} />
            : route.page === 'not-found' ? <section className="empty-state"><h1 tabIndex={-1}>页面不存在</h1><PageLink href="/" navigate={navigate} disabled={busy}>返回工作台</PageLink></section>
            : dashboard && session ? <Dashboard key={session.user.id} user={session.user} locales={policy?.supported_locales ?? []} busy={busy} onBusyChange={setChildBusy} />
            : route.page === 'sessions' && session ? <SessionSettings user={session.user} busy={busy} onBusyChange={setChildBusy} onLoggedOut={() => loggedOut(true)} />
            : <AuthView key={route.page} route={route.page === 'sessions' ? { ...route, page: 'login' } : route} policy={policy} policyError={policyError || policyAction.error} policyLoading={policyLoading || policyAction.pending} reloadPolicy={reloadPolicy} navigate={navigate} busy={busy} onBusyChange={setChildBusy} onLogin={loggedIn} onConsumed={(reset) => { setRoute((current) => ({ ...current, token: null })); if (reset) setSession(null); }} />}
        </>}
    </main>
    <footer className="site-footer"><span>账户与餐厅资料</span><span>草稿不等于发布 · 营业规则不等于座位库存</span></footer>
  </div>;
}
