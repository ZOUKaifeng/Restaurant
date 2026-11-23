import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, onSessionExpired, refreshCsrf } from './api';
import AuthView from './AuthView';
import Dashboard from './Dashboard';
import HomePage from './HomePage';
import ExamplesPage from './ExamplesPage';
import UsagePage from './UsagePage';
import PricingPage from './PricingPage';
import BillingPage from './BillingPage';
import TokenBalance from './TokenBalance';
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
    void action.run(async () => { await api.logoutAll({ current_password: password }); onLoggedOut(); });
  }
  return <section className="account-settings"><p className="eyebrow">Your account</p><h1 tabIndex={-1}>Account & security</h1><p className="muted">Manage your sign-in sessions. Your restaurant data stays with your account.</p><div className="account-settings-grid"><div><h2>Sign out on every device</h2><p className="muted">Confirm your current password to revoke every session, including this one. You will need to sign in again.</p><p className="micro">This action does not delete your account or restaurants.</p></div><form onSubmit={submit} aria-busy={action.pending}><fieldset disabled={busy || action.pending}><div className="field"><label htmlFor="session-email">Email address</label><input id="session-email" name="email" type="email" value={user.email} autoComplete="username" readOnly /></div><div className="field"><label htmlFor="current-password">Current password</label><input id="current-password" name="current_password" type="password" autoComplete="current-password" minLength={1} maxLength={128} required /></div><button type="submit" className="primary-button">{action.pending ? 'Revoking sessions…' : 'Sign out on every device'}</button></fieldset><ActionFeedback action={action} /></form></div></section>;
}

function LegalDraft({ route, policy, navigate, busy }: {
  route: RouteState; policy: RegistrationPolicy | null; navigate: Navigate; busy: boolean;
}) {
  const privacy = route.page === 'privacy';
  return <section className="legal-draft"><p className="eyebrow">Policy draft</p><h1 tabIndex={-1}>{privacy ? 'Privacy notice draft' : 'Terms draft'}</h1><p className="muted">Current version: {privacy ? policy?.privacy_notice_version ?? 'Not available' : policy?.terms_version ?? 'Not available'}</p><div className="notice"><p>The final policy text has not been supplied or reviewed. This page identifies the draft version returned by the registration service; it is not a complete or finalized legal document.</p><p>Acceptance of registration terms is not consent to marketing emails.</p></div><PageLink href="/auth/register" navigate={navigate} disabled={busy}>Return to registration</PageLink></section>;
}

type LeaveIntent = { type: 'navigate'; path: string } | { type: 'logout' };

export default function App({ initialRoute }: { initialRoute: RouteState }) {
  const [route, setRoute] = useState(initialRoute);
  const [session, setSession] = useState<SessionView | null>(null);
  const [pausedSession, setPausedSession] = useState<SessionView | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<unknown>(null);
  const [policy, setPolicy] = useState<RegistrationPolicy | null>(null);
  const [policyLoading, setPolicyLoading] = useState(true);
  const [policyError, setPolicyError] = useState<unknown>(null);
  const [csrfError, setCsrfError] = useState<unknown>(null);
  const [childBusy, setChildBusy] = useState(false);
  const [childDirty, setChildDirty] = useState(false);
  const [leaveIntent, setLeaveIntent] = useState<LeaveIntent | null>(null);
  const [notice, setNotice] = useState('');
  const [bootVersion, setBootVersion] = useState(0);
  const [workspaceHeaderTarget, setWorkspaceHeaderTarget] = useState<HTMLDivElement | null>(null);
  const action = useAction();
  const policyAction = useAction();
  const busy = childBusy || action.pending;
  const publicPage = route.page === 'home' || route.page === 'examples' || route.page === 'pricing';
  const protectedPage = route.page === 'app' || route.page === 'sessions' || route.page === 'usage' || route.page === 'billing';
  const workspaceSession = session ?? pausedSession;
  const management = protectedPage && Boolean(['usage', 'billing'].includes(route.page) ? session : workspaceSession);
  const scopeRef = useRef({ session, childDirty, route });
  scopeRef.current = { session, childDirty, route };
  const workspaceBusyChanged = useCallback((value: boolean) => {
    if (scopeRef.current.session) setChildBusy(value);
  }, []);
  const historyIndex = useRef(0);
  const restoringHistory = useRef(false);
  useEffect(() => {
    const value = window.history.state?.tableFolkIndex;
    historyIndex.current = Number.isSafeInteger(value) ? value : 0;
    window.history.replaceState({ ...window.history.state, tableFolkIndex: historyIndex.current }, '', route.path);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setBooting(true); setBootError(null); setPolicyLoading(true); setPolicyError(null); setCsrfError(null);
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
    const previous = scopeRef.current;
    setSession(null); setChildBusy(false); setLeaveIntent(null);
    setNotice('Your session expired. Please sign in again. The previous request will not be replayed automatically.');
    if (previous.session && previous.childDirty && previous.route.page === 'app') {
      // Keep this user's workspace in memory, hidden and paused; never persist credentials or drafts.
      setPausedSession(previous.session);
      return;
    }
    setPausedSession(null); setChildDirty(false);
    window.history.replaceState({ tableFolkIndex: historyIndex.current }, '', '/auth/login');
    setRoute({ page: 'login', path: '/auth/login', token: null });
  }), []);

  useEffect(() => {
    const pop = () => {
      if (restoringHistory.current) { restoringHistory.current = false; return; }
      const targetIndex = window.history.state?.tableFolkIndex;
      if (busy || childDirty) {
        const attemptedPath = window.location.pathname;
        if (Number.isSafeInteger(targetIndex) && targetIndex !== historyIndex.current) {
          restoringHistory.current = true;
          window.history.go(historyIndex.current - targetIndex);
        } else {
          window.history.pushState({ tableFolkIndex: historyIndex.current }, '', route.path);
        }
        if (!busy && attemptedPath !== route.path) setLeaveIntent({ type: 'navigate', path: attemptedPath });
        return;
      }
      if (Number.isSafeInteger(targetIndex)) historyIndex.current = targetIndex;
      setRoute(readRoute()); setNotice('');
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [busy, childDirty, route.path]);

  useEffect(() => {
    if (!childDirty) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [childDirty]);

  useEffect(() => {
    document.documentElement.lang = 'en';
    const frame = window.requestAnimationFrame(() => {
      const heading = document.querySelector<HTMLElement>('.management-header-context h1, main h1');
      document.title = heading ? `${heading.textContent ?? 'Your restaurant'} · Table Folk` : 'Table Folk';
      if (!publicPage && !booting) heading?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [route.path, booting, publicPage, session?.user.id]);

  function forceNavigate(path: string) {
    historyIndex.current += 1;
    window.history.pushState({ tableFolkIndex: historyIndex.current }, '', path); setRoute(readRoute());
    setChildDirty(false); setPausedSession(null); setLeaveIntent(null); window.scrollTo({ top: 0, behavior: 'auto' });
  }
  const navigate: Navigate = (path) => {
    if (busy || !path.startsWith('/') || path.startsWith('//') || path === route.path) return;
    if (childDirty) { setLeaveIntent({ type: 'navigate', path }); return; }
    action.clear(); setNotice(''); forceNavigate(path);
  };
  function loggedIn(value: SessionView) {
    const restoring = pausedSession?.user.id === value.user.id && route.page === 'app';
    setSession(value); setBootError(null); setCsrfError(null); setNotice('');
    if (restoring) setPausedSession(null);
    else forceNavigate('/app');
  }
  function loggedOut(all = false) {
    setSession(null); setCsrfError(null); setChildDirty(false);
    setNotice(all ? 'All sessions have been revoked. Sign in again to continue.' : 'You have been signed out.');
    forceNavigate('/auth/login');
  }
  function executeLogout() { void action.run(async () => { await api.logout(); loggedOut(); }); }
  function logout() {
    if (busy) return;
    if (childDirty) { setLeaveIntent({ type: 'logout' }); return; }
    executeLogout();
  }
  function leave() {
    if (busy || !leaveIntent) return;
    const intent = leaveIntent;
    setLeaveIntent(null);
    if (intent.type === 'logout') executeLogout();
    else { action.clear(); setNotice(''); forceNavigate(intent.path); }
  }
  function reloadPolicy() {
    if (policyLoading || policyAction.pending) return;
    setPolicyError(null); void policyAction.run(async () => { setPolicy(await api.policy()); });
  }
  const legal = route.page === 'terms' || route.page === 'privacy';
  const authRoute = protectedPage ? { page: 'login' as const, path: '/auth/login', token: null } : route;
  const marketingProps = { navigate, busy, authenticated: Boolean(session) };

  const content = <>
    {notice && <div className="notice global-notice" role="status">{notice}</div>}
    {leaveIntent && <section className="notice global-leave" aria-labelledby="leave-title"><h2 id="leave-title">Leave your unsaved changes?</h2><p>Your current changes or unconfirmed creation request will be left behind. This does not cancel a request already accepted by the server or replay any request.</p><div className="button-row"><button type="button" disabled={busy} onClick={leave}>{leaveIntent.type === 'logout' ? 'Discard and sign out' : 'Discard and leave'}</button><button type="button" className="text-button" disabled={busy} onClick={() => setLeaveIntent(null)}>Keep editing</button></div></section>}
    <ActionFeedback action={action} />
    {publicPage ? (route.page === 'home' ? <HomePage {...marketingProps} /> : route.page === 'pricing' ? <PricingPage {...marketingProps} userId={session?.user.id ?? null} /> : <ExamplesPage {...marketingProps} />)
      : booting ? <section className="boot-state" aria-busy="true" role="status"><p>Checking your account session…</p><div className="skeleton-line" /><div className="skeleton-line short" /></section>
      : <>
        {Boolean(bootError) && <section className="boot-error"><ErrorNotice error={bootError} /><button type="button" disabled={busy} onClick={() => setBootVersion((value) => value + 1)}>Check service & session again</button><p className="micro">The session is not confirmed. No simulated sign-in is used.</p></section>}
        {Boolean(csrfError) && !session && <section className="boot-error"><ErrorNotice error={csrfError} /><p className="micro">A write request checks the security context again before it is sent.</p></section>}
        {legal ? <LegalDraft route={route} policy={policy} navigate={navigate} busy={busy} />
          : route.page === 'not-found' ? <section className="empty-state"><h1 tabIndex={-1}>This page isn't here.</h1><PageLink href="/" navigate={navigate} disabled={busy}>Back to Table Folk</PageLink></section>
          : route.page === 'app' && workspaceSession ? <>
            {!session && <AuthView key="reauthenticate" route={{ page: 'login', path: '/auth/login', token: null }} policy={policy} policyError={policyError} policyLoading={policyLoading} reloadPolicy={reloadPolicy} navigate={navigate} busy={busy} onBusyChange={setChildBusy} onLogin={loggedIn} onConsumed={() => undefined} />}
            <div key="saved-workspace" hidden={!session}><Dashboard key={workspaceSession.user.id} user={workspaceSession.user} headerTarget={workspaceHeaderTarget} routePath={route.path} mode={route.path === '/app/reservations' ? 'reservations' : route.path === '/app/analytics' ? 'analytics' : 'restaurants'} active={Boolean(session)} locales={policy?.supported_locales ?? []} busy={busy || !session} onBusyChange={workspaceBusyChanged} onDirtyChange={setChildDirty} /></div>
          </>
          : route.page === 'billing' && session ? <BillingPage key={session.user.id} userId={session.user.id} active={true} busy={busy} navigate={navigate} />
          : route.page === 'usage' && session ? <UsagePage key={session.user.id} userId={session.user.id} active={true} busy={busy} />
          : route.page === 'sessions' && session ? <SessionSettings user={session.user} busy={busy} onBusyChange={setChildBusy} onLoggedOut={() => loggedOut(true)} />
          : <AuthView key={authRoute.page} route={authRoute} policy={policy} policyError={policyError || policyAction.error} policyLoading={policyLoading || policyAction.pending} reloadPolicy={reloadPolicy} navigate={navigate} busy={busy} onBusyChange={setChildBusy} onLogin={loggedIn} onConsumed={(reset) => { setRoute((current) => ({ ...current, token: null })); if (reset) setSession(null); }} />}
      </>}
  </>;

  return <div className={`app-shell table-folk-app ${management ? 'management-shell' : 'public-shell'}`}>
    <a className="skip-link" href="#main">Skip to content</a>
    {management ? <>
      <aside className="management-sidebar"><PageLink href="/" navigate={navigate} disabled={busy} className="wordmark">TABLE FOLK<span className="brand-dot" aria-hidden="true" /></PageLink><p className="sidebar-eyebrow">Restaurant workspace</p><nav aria-label="Workspace navigation"><PageLink href="/app" navigate={navigate} disabled={busy} className={route.page === 'app' && !['/app/reservations', '/app/analytics'].includes(route.path) ? 'shell-nav-link active' : 'shell-nav-link'}>My restaurants <span aria-hidden="true">↗</span></PageLink><PageLink href="/app/reservations" navigate={navigate} disabled={busy} className={route.path === '/app/reservations' ? 'shell-nav-link active' : 'shell-nav-link'}>Reservations</PageLink><PageLink href="/app/analytics" navigate={navigate} disabled={busy} className={route.path === '/app/analytics' ? 'shell-nav-link active' : 'shell-nav-link'}>Analytics</PageLink><PageLink href="/account/sessions" navigate={navigate} disabled={busy} className={route.page === 'sessions' ? 'shell-nav-link active' : 'shell-nav-link'}>Account & security</PageLink><PageLink href="/account/usage" navigate={navigate} disabled={busy} className={route.page === 'usage' ? 'shell-nav-link active' : 'shell-nav-link'}>Credit usage</PageLink><PageLink href="/account/billing" navigate={navigate} disabled={busy} className={route.page === 'billing' ? 'shell-nav-link active' : 'shell-nav-link'}>Billing</PageLink></nav><div className="sidebar-bottom"><PageLink href="/" navigate={navigate} disabled={busy}>Back to website</PageLink><button type="button" className="text-button" disabled={busy} onClick={logout}>Sign out</button></div></aside>
      <div className="management-body"><header className="management-header"><div className="management-header-context" ref={setWorkspaceHeaderTarget} />{session && <TokenBalance key={session.user.id} userId={session.user.id} active={true} refreshKey={route.path} navigate={navigate} busy={busy} />}</header><main id="main" tabIndex={-1} className={route.page === 'app' && !['/app/reservations', '/app/analytics'].includes(route.path) ? 'restaurant-workspace-main' : undefined}>{content}</main><footer className="management-footer"><span>Your restaurant. Your point of view.</span><span>Local development · Public deployment not connected</span></footer></div>
    </> : <>
      <header className="site-header"><PageLink href="/" navigate={navigate} disabled={busy} className="wordmark">TABLE FOLK<span className="brand-dot" aria-hidden="true" /></PageLink><nav className="header-nav public-nav" aria-label="Main navigation"><PageLink href="/" navigate={navigate} disabled={busy} className={route.page === 'home' ? 'active' : ''}>Home</PageLink><PageLink href="/examples" navigate={navigate} disabled={busy} className={route.page === 'examples' ? 'active' : ''}>Examples</PageLink><PageLink href="/pricing" navigate={navigate} disabled={busy} className={route.page === 'pricing' ? 'active' : ''}>Pricing</PageLink></nav><div className="header-actions">{session ? <PageLink className="header-primary" href="/app" navigate={navigate} disabled={busy}>Your workspace <span aria-hidden="true">↗</span></PageLink> : <><PageLink className="header-login" href="/auth/login" navigate={navigate} disabled={busy}>Sign in</PageLink><PageLink className="header-primary" href="/auth/register" navigate={navigate} disabled={busy}>Get started <span aria-hidden="true">↗</span></PageLink></>}</div></header>
      <main id="main" tabIndex={-1} className={publicPage ? 'marketing-main' : 'account-main'}>{content}</main>
      <footer className="site-footer"><PageLink href="/" navigate={navigate} disabled={busy} className="wordmark footer-wordmark">TABLE FOLK</PageLink><span>Made for the people behind the restaurant.</span><nav aria-label="Footer navigation"><PageLink href="/legal/terms" navigate={navigate} disabled={busy}>Terms draft</PageLink><PageLink href="/legal/privacy" navigate={navigate} disabled={busy}>Privacy draft</PageLink></nav></footer>
    </>}
  </div>;
}
