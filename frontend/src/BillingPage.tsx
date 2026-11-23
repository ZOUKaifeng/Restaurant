import { useEffect, useRef, useState } from 'react';
import { onSessionExpired } from './api';
import { billingErrorMessage, formatBillingAmount, formatBillingCredits, readOverview, type BillingOverview } from './billing-client';
import { creditPeriodRange } from './usage-credits';
import { PageLink, type Navigate } from './ui';
import './billing-page.css';

export type BillingPageProps = { userId: string; busy: boolean; active: boolean; navigate: Navigate };
type OverviewState = { scope: number; data: BillingOverview | null; loading: boolean; error: string | null };

export function useBillingOverview(userId: string | null, active: boolean): OverviewState {
  const live = useRef({ userId, active, scope: 0, expired: false });
  if (live.current.userId !== userId || live.current.active !== active) {
    live.current = { userId, active, scope: live.current.scope + 1, expired: false };
  }
  const scope = live.current.scope;
  const [state, setState] = useState<OverviewState>({ scope, data: null, loading: active && !!userId, error: null });
  const sequence = useRef(0);
  useEffect(() => {
    const controller = new AbortController(), current = ++sequence.current;
    if (!active || !userId) return () => { controller.abort(); ++sequence.current; };
    live.current.expired = false;
    const valid = () => !controller.signal.aborted && current === sequence.current && live.current.scope === scope && !live.current.expired;
    setState({ scope, data: null, loading: true, error: null });
    const unsubscribe = onSessionExpired(() => {
      if (!valid()) return;
      live.current.expired = true;
      controller.abort(); ++sequence.current;
      setState({ scope, data: null, loading: false, error: 'Your session has expired. Sign in again to view billing.' });
    });
    void readOverview(controller.signal).then(data => {
      if (valid()) setState({ scope, data, loading: false, error: null });
    }).catch(error => {
      if (!valid()) return;
      controller.abort();
      setState({ scope, data: null, loading: false, error: billingErrorMessage(error) });
    });
    return () => { controller.abort(); ++sequence.current; unsubscribe(); };
  }, [userId, active, scope]);
  // 首次 render 即隔离旧作用域，不能依赖稍后 effect cleanup 才撤下私有数据。
  if (!active || !userId || state.scope !== scope) return { scope, data: null, loading: active && !!userId, error: null };
  if (live.current.expired) return { scope, data: null, loading: false, error: state.error };
  return state;
}

export function BillingOverviewView({ overview }: { overview: BillingOverview }) {
  const subscription = overview.subscription, credits = overview.credits;
  return <div className="billing-overview">
    <section className="billing-section" aria-label="Recorded subscription">
      <p className="billing-label">Recorded subscription</p>
      <h2>{subscription ? subscription.plan_name : 'No subscription'}</h2>
      {subscription && <p className="billing-muted">Observation record only — not proof of payment or entitlement. Payments are not enabled.</p>}
      {!subscription && <p className="billing-muted">No subscription{overview.account === null ? ' · no billing account yet' : ''}.</p>}
      {subscription && <dl className="billing-facts">
        <div><dt>Plan record</dt><dd>{subscription.plan_name}</dd></div>
        <div><dt>Recorded status</dt><dd>{subscription.status}{overview.account && overview.account.status !== 'active' ? ` · account ${overview.account.status}` : ''}</dd></div>
        <div><dt>Recorded price</dt><dd>{formatBillingAmount(subscription.amount_minor, subscription.currency)} / {subscription.interval === 'year' ? 'year' : 'month'} · USD</dd></div>
      </dl>}
      {subscription && <details className="billing-details"><summary>Subscription details</summary>
        <dl className="billing-facts">{([
          ['Period start', subscription.period_start], ['Period end', subscription.period_end], ['Paid through', subscription.paid_through], ['Cancellation requested', subscription.cancel_requested_at],
        ] as const).map(([title, value]) => <div key={title}><dt>{title}</dt><dd>{value ? <time dateTime={value}>{value.replace('T', ' ').replace(/Z$/, '')} UTC</time> : 'Not set'}</dd></div>)}</dl>
        <p>Recorded subscription information only. Payments and subscription changes are not enabled.</p>
      </details>}
    </section>
    <section className="billing-section" aria-label="Credits"><p className="billing-label">Credits</p>
      {credits.status === 'development_test' ? <>
        <h2>Test allowance · this month</h2>
        <p className="billing-muted">This calendar month · UTC · {creditPeriodRange(credits.period)}</p>
        <dl className="billing-facts">
          <div><dt>Granted credits</dt><dd>{formatBillingCredits(credits.granted)}</dd></div>
          <div><dt>Credits left</dt><dd>{formatBillingCredits(credits.available, true)}</dd></div>
          <div><dt>Used credits</dt><dd>{formatBillingCredits(credits.consumed)}</dd></div>
          <div><dt>Reserved credits</dt><dd>{formatBillingCredits(credits.reserved)}</dd></div>
        </dl>
        <p className="billing-muted">Not a paid subscription. {subscription ? 'Subscription records do not prove a paid plan.' : 'No paid plan.'} Payments are not enabled; no hard limit is enforced.</p>
        <p className="billing-muted">Test credits applied to calls started after grant. Earlier history is not deducted.</p>
        <p className="billing-note">Granted <time dateTime={credits.period.granted_at}>{credits.period.granted_at.replace('T', ' ').replace(/Z$/, '')} UTC</time>. Expires at <time dateTime={credits.period.ends_at}>{credits.period.ends_at.replace('T', ' ').replace(/Z$/, '')} UTC</time> (exclusive). No automatic renewal or next-month grant.</p>
      </> : <>
        <h2>Not configured —</h2>
        <p className="billing-muted">No confirmed credit balance or grant schedule. Usage observations are not a balance.</p>
      </>}
    </section>
    <section className="billing-section" aria-label="Credit add-ons"><p className="billing-label">Credit add-ons</p><h2>No offers available</h2>
      <p className="billing-muted">{overview.addons_status === 'draft' ? 'Draft credit add-ons recorded · currently unavailable. Purchases are not enabled.' : 'Credit top-ups are planned. Prices are not configured; purchases are unavailable.'}</p>
    </section>
    {overview.seed_eligibility === 'approved' && <p className="billing-badge">Seed eligibility approved · not purchasable</p>}
    <p className="billing-note">Observation mode · generated <time dateTime={overview.generated_at}>{overview.generated_at.replace('T', ' ').replace(/Z$/, '')} UTC</time>.</p>
  </div>;
}

function BillingReader({ userId, busy, navigate }: Omit<BillingPageProps, 'active'>) {
  const state = useBillingOverview(userId, true);
  return <div className="billing-page">
    <header className="billing-heading"><div><p className="billing-eyebrow">Account / billing</p><h1>Billing</h1><p>Your recorded subscription and credit configuration.</p></div>
      <nav className="billing-links" aria-label="Billing navigation"><PageLink href="/pricing" navigate={navigate} disabled={busy}>Pricing</PageLink><PageLink href="/account/usage" navigate={navigate} disabled={busy}>Usage</PageLink></nav>
    </header>
    <p className="billing-muted">Payments are not enabled. Subscriptions and credit purchases are unavailable.</p>
    {state.loading && <p className="billing-read-status" role="status">Loading billing…</p>}
    {state.error && <p className="billing-error" role="alert">{state.error}</p>}
    {state.data && <BillingOverviewView overview={state.data} />}
  </div>;
}

export default function BillingPage({ active, ...props }: BillingPageProps) {
  return active ? <BillingReader key={props.userId} {...props} /> : null;
}
