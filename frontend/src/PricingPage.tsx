import { useEffect, useState } from 'react';
import { useBillingOverview } from './BillingPage';
import { billingErrorMessage, formatBillingAmount, readCatalog, savesFiveMonths, type BillingCatalog, type BillingInterval, type BillingPlan, type BillingPrice } from './billing-client';
import { PageLink, type Navigate } from './ui';
import './billing-page.css';

export type PricingPageProps = { navigate: Navigate; busy: boolean; authenticated: boolean; userId?: string | null };
export type PricingCatalogViewProps = {
  catalog: BillingCatalog; interval: BillingInterval; busy: boolean;
  onIntervalChange: (interval: BillingInterval) => void;
  onPlanSelect?: (plan: BillingPlan, price: BillingPrice) => void;
};

export function PricingCatalogView({ catalog, interval, busy, onIntervalChange }: PricingCatalogViewProps) {
  const formatNumber = new Intl.NumberFormat('en-US');
  return <div className="pricing-catalog">
    <div className="billing-period" role="group" aria-label="Billing period">
      {(['month', 'year'] as const).map(value => <button type="button" key={value} aria-pressed={interval === value}
        onClick={() => onIntervalChange(value)}>{value === 'month' ? 'Monthly' : 'Yearly'}</button>)}
    </div>
    <p className="billing-payment-note">Payments are not enabled. All plans and credit purchases are unavailable.</p>
    {catalog.plans.length === 0 && <p className="billing-muted" role="status">No plans currently available.</p>}
    {catalog.plans.length > 0 && <div className="billing-plan-grid" data-plan-count={catalog.plans.length}>{catalog.plans.map(plan => {
      const price = plan.prices.find(item => item.interval === interval);
      const proposed = plan.ai.allocation_status === 'proposed';
      return <article className="billing-plan" key={plan.id} aria-label={`${plan.name} plan`}>
        <div className="billing-plan-title"><h2>{plan.name}</h2><span className="billing-label">{plan.status}</span></div>
        {price ? <>
          <p className="billing-price">{formatBillingAmount(price.amount_minor, price.currency)}<span> / {interval === 'year' ? 'year' : 'month'}</span></p>
          <p className="billing-note">{interval === 'year' ? 'Full annual charge · USD' : 'Monthly price · USD'}</p>
          {interval === 'year' && <p className="billing-equivalent">Equivalent to {formatBillingAmount(price.amount_minor / 12, price.currency, 'equivalent')} / month. Not billed monthly.</p>}
          {interval === 'year' && savesFiveMonths(plan) && <p className="billing-saving">Save 5 months compared with 12 monthly prices.</p>}
        </> : <p className="billing-price-unconfigured">Price not configured</p>}
        <ul className="billing-plan-features">
          <li>{plan.ai.mode === 'unlimited' ? 'Unlimited AI usage' : `${formatNumber.format(plan.ai.monthly_credits!)} monthly credits`}<span>{proposed ? 'Proposed · not a confirmed allocation' : 'Confirmed allocation'}</span></li>
          <li>{plan.hosted_site_limit === null ? 'Hosting limits not confirmed' : `${formatNumber.format(plan.hosted_site_limit)} website${plan.hosted_site_limit === 1 ? '' : 's'} · planning budget`}</li>
          {plan.ai.mode === 'limited' && <li>Additional credits planned<span>{catalog.addons_status === 'draft' ? 'Recorded add-ons · currently unavailable' : 'Top-up prices not configured'}</span></li>}
        </ul>
        <button type="button" className="billing-primary" disabled aria-busy={busy || undefined}>Payments not enabled</button>
      </article>;
    })}</div>}
    <section className="billing-section" aria-label="Credit add-ons"><h2>Credit add-ons</h2>
      <p className="billing-muted">{catalog.credit_packs.length ? 'Recorded credit packs · currently unavailable. Purchases are not enabled.' : 'Credit top-ups are planned for limited plans. Prices are not configured; no packs are available to select.'}</p>
      {catalog.credit_packs.length > 0 && <ul className="billing-pack-list">{catalog.credit_packs.map(pack => <li key={pack.id}>
        <div className="billing-plan-title"><strong>{pack.name}</strong><span className="billing-label">{pack.status} · currently unavailable</span></div>
        <p className="billing-note">{formatNumber.format(pack.credits)} credits · Recorded price {formatBillingAmount(pack.amount_minor, pack.currency)} · {pack.validity_policy === 'never_expires' ? 'No expiry' : pack.validity_policy === 'unconfirmed' ? 'Validity not confirmed' : `${formatNumber.format(pack.validity_days!)} days`}</p>
      </li>)}</ul>}
    </section>
    <details className="billing-details"><summary>Plan details</summary>
      {catalog.plans.some(plan => plan.ai.allocation_status === 'proposed') && <p>Credit allowances marked proposed are not final or confirmed.</p>}
      <p>{catalog.plans.length === 0 ? 'No plan grant schedules are configured.' : catalog.plans.every(plan => plan.ai.grant_schedule === 'service_month')
        ? 'Monthly grants are scheduled by service month. This catalog does not grant credits.'
        : 'Some monthly grant schedules remain unconfirmed. This catalog does not grant credits.'}</p>
      <p>Website budgets are planning figures, not guaranteed hosting entitlements. Unspecified limits are unknown. Unlimited refers to AI usage, not storage or hosted websites.</p>
      <p>Yearly prices are the full annual charge. The monthly equivalent is for comparison only.</p>
    </details>
  </div>;
}

export default function PricingPage({ navigate, busy, authenticated, userId = null }: PricingPageProps) {
  const [interval, setInterval] = useState<BillingInterval>('month');
  const [state, setState] = useState<{ catalog: BillingCatalog | null; loading: boolean; error: string | null }>({ catalog: null, loading: true, error: null });
  const overview = useBillingOverview(userId, authenticated && !!userId);
  useEffect(() => {
    const controller = new AbortController();
    void readCatalog(controller.signal).then(catalog => {
      if (!controller.signal.aborted) setState({ catalog, loading: false, error: null });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ catalog: null, loading: false, error: billingErrorMessage(error) });
    });
    return () => { controller.abort(); };
  }, []);
  return <div className="billing-page pricing-page">
    <header className="billing-heading"><div><p className="billing-eyebrow">Table Folk / pricing</p><h1>A plan for your next chapter.</h1><p>Plan credit allowances and pricing. Credit add-ons are not purchasable.</p></div></header>
    {state.loading && <p className="billing-read-status" role="status">Loading plans…</p>}
    {state.error && <p className="billing-error" role="alert">{state.error}</p>}
    {state.catalog && <PricingCatalogView catalog={state.catalog} interval={interval} busy={busy} onIntervalChange={setInterval} />}
    {state.catalog && (overview.data?.seed_eligibility === 'approved'
      ? <p className="billing-badge">Seed eligibility approved · {formatBillingAmount(state.catalog.seed_offer.amount_minor, state.catalog.currency)} / month · Unlimited AI · not purchasable. Offer duration unconfirmed.</p>
      : <p className="billing-note billing-seed-note">Seed offer requires approval.</p>)}
    {authenticated && userId && overview.error && <p className="billing-note" role="status">{overview.error} Seed eligibility could not be verified.</p>}
    <div className="billing-actions"><PageLink href="/app" navigate={navigate} disabled={busy} className="billing-primary">Go to your workspace</PageLink><span className="billing-note">Opens the workspace, not checkout.</span></div>
  </div>;
}
