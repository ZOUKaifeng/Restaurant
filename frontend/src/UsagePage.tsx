import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from './api';
import {
  appendUsageCalls, readUsage, readUsageCalls, USAGE_FEATURES, USAGE_PAGE_SIZE, validateUsageQuery,
  type AiCallTotals, type AiFeature, type AiOrigin, type AiUsageCall, type AiUsageCalls, type AiUsageReport, type UsageQuery,
} from './usage-client';
import { creditPeriodRange, formatUsageCreditBalance, formatUsageCredits } from './usage-credits';
import './usage-page.css';

export type UsagePageProps = { userId: string; active: boolean; busy: boolean };
type Draft = { restaurant_id: string; feature: AiFeature | ''; origin: AiOrigin | ''; dates: boolean; from: string; to: string };
type ReadState = { userId: string; revision: number; query: UsageQuery; report: AiUsageReport | null; page: AiUsageCalls | null; loading: boolean; error: string | null; moreLoading: boolean; moreError: string | null };
type RestaurantOption = { id: string; name: string };
type RestaurantState = { userId: string; items: RestaurantOption[]; cursor: string | null; loading: boolean; error: string | null };
const emptyDraft: Draft = { restaurant_id: '', feature: '', origin: '', dates: false, from: '', to: '' };
const featureLabels: Record<AiFeature, string> = { menu_recognition: 'Menu recognition', website_chat: 'Website chat', website_generate: 'Website generation' };
const originLabels: Record<AiOrigin, string> = { live: 'Live calls', legacy_import: 'Imported legacy calls' };
const format = new Intl.NumberFormat('en-US');
const zeroTotals: AiCallTotals = { calls: 0, known_usage_calls: 0, unknown_usage_calls: 0, pending_calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
const number = (value: number | null) => value === null ? '—' : format.format(value);
function utcTime(value: string): string { return `${value.replace('T', ' ').replace(/Z$/, '')} UTC`; }
function scopeLabel(query: UsageQuery | AiUsageReport['filters']): string {
  return [query.from ? `${query.from} – ${query.to} · UTC inclusive` : 'All time · UTC',
    query.restaurant_id ? `Restaurant ${query.restaurant_id}` : 'All account restaurants',
    query.feature ? featureLabels[query.feature] : 'All features', query.origin ? originLabels[query.origin] : 'All call origins'].join(' / ');
}
function draftQuery(draft: Draft): UsageQuery {
  const query: UsageQuery = {};
  if (draft.restaurant_id) query.restaurant_id = draft.restaurant_id;
  if (draft.feature) query.feature = draft.feature;
  if (draft.origin) query.origin = draft.origin;
  if (draft.dates) { query.from = draft.from; query.to = draft.to; }
  return query;
}
function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'USAGE_RANGE_INVALID') return 'Enter valid UTC calendar dates in order, inclusive of both dates, up to 366 days.';
    if (error.status === 401) return 'Your session is no longer valid. Sign in again to read usage.';
    if ([403, 404, 409].includes(error.status)) return 'The selected restaurant or account access is no longer available. Reload current restaurants or choose all account restaurants.';
    if (error.status === 502) return 'The usage response failed validation. No unverified figures are displayed.';
    if (error.code === 'AI_USAGE_OVERFLOW') return 'Usage exceeds the safe integer limit. No rounded or estimated figures are displayed.';
    if (error.code === 'REQUEST_TIMEOUT') return 'The read request timed out. Retry to read a fresh report.';
    if (error.status === 400 || error.status === 422) return 'The filters or cursor were rejected. Check filters or refresh the report before paging again.';
    if (error.status === 429) return 'Too many requests. Try again later.';
  }
  return 'Unable to read usage. Retry without starting any model calls.';
}
function accessLost(error: unknown): boolean { return error instanceof ApiError && [401, 403, 404, 409].includes(error.status); }
function Metrics({ totals }: { totals: AiCallTotals }) {
  const values = [['Known credit usage', formatUsageCredits(totals.total_tokens), 'Observed, not deducted'],
    ['Model calls', number(totals.calls), 'Across all restaurants'],
    ['Pending', number(totals.pending_calls), 'Awaiting usage'],
    ['Unknown', number(totals.unknown_usage_calls), 'Usage unavailable']] as const;
  return <dl className="usage-metrics">{values.map(([label, value, note]) => <div key={label}><dt>{label}</dt><dd className="usage-value">{value}</dd><dd>{note}</dd></div>)}</dl>;
}

export function UsageAccountOverview({ report }: { report: AiUsageReport }) {
  if (report.quota.configured) {
    const quota = report.quota, month = report.calendar_month_totals!.totals;
    const values = [
      ['Granted credits', formatUsageCredits(quota.granted_tokens), 'Test allowance'],
      ['Used credits', formatUsageCredits(quota.consumed_tokens), 'Since grant · known usage'],
      ['Credits left', formatUsageCreditBalance(quota.available_tokens), 'Reported balance'],
      ['Pending or unknown calls', number(month.pending_calls + month.unknown_usage_calls), `${number(month.pending_calls)} pending · ${number(month.unknown_usage_calls)} unknown`],
    ];
    return <section className="usage-section usage-overview" aria-label="This calendar month credit summary">
      <div className="usage-section-heading"><h2>This calendar month · UTC</h2><span className="usage-badge">Test allowance</span></div>
      <p className="usage-scope">{creditPeriodRange(quota.period)}</p>
      <dl className="usage-metrics">{values.map(([label, value, note]) => <div key={label}><dt>{label}</dt><dd className="usage-value">{value}</dd><dd>{note}</dd></div>)}</dl>
      <p className="usage-note">Test credits applied to calls started after grant. Earlier history is not deducted.</p>
      <p className="usage-note">All account restaurants · {number(month.calls)} calls since grant · {number(month.known_usage_calls)} known usage calls. Unaffected by history filters.</p>
      <p className="usage-note">Pending and unknown usage is not estimated. The known balance may update later when provider usage is reported. Failed calls with known provider usage are counted.</p>
      <p className="usage-note">Not a paid subscription. Payments are not enabled; no hard limit is enforced.</p>
      <p className="usage-note">Expires at <time dateTime={quota.period.ends_at}>{utcTime(quota.period.ends_at)}</time> (exclusive). No automatic renewal or next-month grant.</p>
      <details className="usage-explanation"><summary>Details · account shared · all time</summary>
        <p>History observations, not deductions from this allowance. Known credit usage: {formatUsageCredits(report.account_totals.total_tokens)} · {number(report.account_totals.calls)} model calls · {number(report.account_totals.pending_calls)} pending · {number(report.account_totals.unknown_usage_calls)} unknown.</p>
        <p>Reserved credits: {formatUsageCredits(quota.reserved_tokens)}. Granted <time dateTime={quota.period.granted_at}>{utcTime(quota.period.granted_at)}</time>.</p>
        <p>Credit usage combines reported input and output, with precision to 0.01 credit. Historical observations are separate from the reported balance.</p>
      </details>
    </section>;
  }
  return <section className="usage-section usage-overview" aria-label="Whole account usage">
    <div className="usage-section-heading"><h2>Account shared · all time</h2><span className="usage-badge">Observation mode</span></div>
    <Metrics totals={report.account_totals} />
    <p className="usage-note">Shared across all restaurants. Known credits exclude pending and unknown usage.</p>
    <details className="usage-explanation"><summary>How credits are counted</summary>
      <p>Whole-account usage across all restaurants, unaffected by the filters below. These figures are usage observations, not a credit balance.</p>
      <p>Credit usage combines reported input and output, with precision to 0.01 credit. Pending and unknown calls are excluded, so this sum may be partial, not a final total. A known zero is distinct from missing usage.</p>
      <p>No credits have been deducted. {report.billing_account ? `Account ${report.billing_account.status}` : 'No metering account yet'}. Credit allowances are not configured or enforced.</p>
    </details>
  </section>;
}

export function UsageReportView({ report, calls, includeOverview = true }: { report: AiUsageReport; calls: readonly AiUsageCall[]; includeOverview?: boolean }) {
  return <div className="usage-report">
    {includeOverview && <UsageAccountOverview report={report} />}
    <section className="usage-section" aria-label="Filtered usage">
      <div className="usage-section-heading"><h2>{report.quota.configured ? 'History / filters' : 'Filtered usage'}</h2><span className="usage-filter-total">{formatUsageCredits(report.filtered_totals.total_tokens)} known credits · {number(report.filtered_totals.calls)} calls</span></div>
      <p className="usage-scope">{scopeLabel(report.filters)}</p>
      {report.quota.configured && <p className="usage-note">History observations may include calls before grant. This filtered usage is not the amount deducted from your test allowance.</p>}
      <div className="usage-table-scroll" tabIndex={0} role="region" aria-label="Filtered feature usage table">
        <table><caption>By feature · filtered scope</caption><thead><tr><th scope="col">Feature</th><th scope="col">Known credits</th><th scope="col">Model calls</th><th scope="col">Known usage calls</th><th scope="col">Pending</th><th scope="col">Unknown</th></tr></thead>
          <tbody>{USAGE_FEATURES.map(feature => {
            // 后端分组是稀疏的；通过求和校验后，缺失组确实为空，不补造调用。
            const totals = report.by_feature.find(group => group.feature === feature) ?? zeroTotals;
            return <tr key={feature}><th scope="row">{featureLabels[feature]}</th><td>{formatUsageCredits(totals.total_tokens)}</td><td>{number(totals.calls)}</td><td>{number(totals.known_usage_calls)}</td><td>{number(totals.pending_calls)}</td><td>{number(totals.unknown_usage_calls)}</td></tr>;
          })}</tbody></table>
      </div>
    </section>
    <section className="usage-section" aria-label="Actual model calls">
      <div className="usage-section-heading"><h2>Actual model calls</h2><span>Newest first · UTC</span></div>
      <div className="usage-table-scroll" tabIndex={0} role="region" aria-label="Model call table, scroll horizontally for all columns">
        <table><caption>Calls · {scopeLabel(report.filters)}</caption><thead><tr><th scope="col">Call start · UTC</th><th scope="col">Model</th><th scope="col">Restaurant / feature</th><th scope="col">Input credits</th><th scope="col">Output credits</th><th scope="col">Known total credits</th><th scope="col">Duration</th><th scope="col">Result / usage</th></tr></thead>
          <tbody>{calls.map(call => <tr key={call.id}>
            <th scope="row"><time dateTime={call.created_at}>{call.created_at.slice(0, 10)}<span>{call.created_at.slice(11, 19)} UTC</span></time>
              <details className="usage-call-details"><summary>Details</summary><div className="usage-call-identifiers">
                <span className="usage-id">Call {call.id}</span><span className="usage-id">Restaurant {call.restaurant_id}</span><span className="usage-id">Job {call.job_id}</span>
                <span>{originLabels[call.origin]}</span><span>{utcTime(call.created_at)}</span>
                <p>Each page is a separate read snapshot; refresh to see status changes. Historical identifiers are ledger references, not restaurant or job links.</p>
              </div></details>
            </th>
            <td>{call.model}<span className="usage-note">{call.provider} · call {call.call_index}</span></td>
            <td>{call.restaurant_name ?? 'Name unavailable'}<span className="usage-note">{featureLabels[call.feature]}</span></td>
            <td>{formatUsageCredits(call.prompt_tokens)}</td><td>{formatUsageCredits(call.completion_tokens)}</td><td>{formatUsageCredits(call.total_tokens)}</td><td>{call.elapsed_ms === null ? '—' : `${number(call.elapsed_ms)} ms`}</td>
            <td>{call.call_status}<span>{call.usage_status}</span>{call.error_code && <span>{call.error_code}</span>}</td>
          </tr>)}{calls.length === 0 && <tr><td colSpan={8}>No calls returned for this scope.</td></tr>}</tbody></table>
      </div>
    </section>
    <details className="usage-section usage-legacy" aria-label="Separate legacy aggregate">
      <summary>Legacy aggregate · whole account · all time</summary><p>Separate historical website-generation job summaries, displayed in credits. Not included in model-call counts or known call credits above, and not affected by filters. These summaries cannot be expanded into precise old calls; no historical menu or chat usage is inferred.</p>
      <dl><div><dt>Jobs with a usage summary</dt><dd>{number(report.legacy.aggregate_jobs)}</dd></div><div><dt>Known aggregate credits</dt><dd>{formatUsageCredits(report.legacy.known_total_tokens)}</dd></div><div><dt>Unknown usage jobs</dt><dd>{number(report.legacy.unknown_usage_jobs)}</dd></div></dl>
      <p className="usage-note">Summary-job and unknown-job counts can overlap; they are not additive.</p>
    </details>
    <p className="usage-note">{report.quota.configured ? 'Observation mode · development test credits · no paid subscription or enforced limit.' : 'Observation mode · credit allowances not configured or enforced.'} Report generated <time dateTime={report.generated_at}>{utcTime(report.generated_at)}</time>.</p>
  </div>;
}

function UsageReader({ userId, busy }: Pick<UsagePageProps, 'userId' | 'busy'>) {
  const [draft, setDraft] = useState<Draft>({ ...emptyDraft });
  const [formError, setFormError] = useState<string | null>(null);
  const [state, setState] = useState<ReadState>({ userId, revision: 0, query: {}, report: null, page: null, loading: true, error: null, moreLoading: false, moreError: null });
  const [restaurants, setRestaurants] = useState<RestaurantState>({ userId, items: [], cursor: null, loading: true, error: null });
  const sequence = useRef(0), flight = useRef<AbortController | null>(null), moreFlight = useRef<AbortController | null>(null);
  const listSequence = useRef(0), listFlight = useRef<AbortController | null>(null), listCursors = useRef(new Set<string>());
  const moreCursors = useRef(new Set<string>()), liveUser = useRef(userId), snapshot = useRef(state), listSnapshot = useRef(restaurants);
  const id = useId();
  liveUser.current = userId; snapshot.current = state; listSnapshot.current = restaurants;
  const clearRestaurants = useCallback(() => {
    ++listSequence.current; listFlight.current?.abort(); listFlight.current = null; listCursors.current.clear();
    setRestaurants({ userId, items: [], cursor: null, loading: false, error: 'Access changed. Reload current restaurants before selecting one.' });
  }, [userId]);

  const load = useCallback((query: UsageQuery) => {
    flight.current?.abort(); moreFlight.current?.abort(); moreFlight.current = null; moreCursors.current.clear();
    const controller = new AbortController(), current = ++sequence.current, expected = { ...query };
    flight.current = controller;
    setFormError(null);
    setState({ userId, revision: current, query: expected, report: null, page: null, loading: true, error: null, moreLoading: false, moreError: null });
    const valid = () => !controller.signal.aborted && sequence.current === current && liveUser.current === userId;
    void Promise.all([readUsage(expected, controller.signal), readUsageCalls({ ...expected, limit: USAGE_PAGE_SIZE }, controller.signal)]).then(([report, page]) => {
      if (!valid()) return;
      setState({ userId, revision: current, query: expected, report, page, loading: false, error: null, moreLoading: false, moreError: null });
    }).catch(error => {
      if (!valid()) return;
      controller.abort();
      if (accessLost(error)) clearRestaurants();
      setState({ userId, revision: current, query: expected, report: null, page: null, loading: false, error: errorMessage(error), moreLoading: false, moreError: null });
    });
  }, [userId, clearRestaurants]);

  const loadRestaurants = useCallback((cursor?: string) => {
    if (cursor && ((listFlight.current && !listFlight.current.signal.aborted) || listCursors.current.has(cursor)
      || listSnapshot.current.userId !== userId || listSnapshot.current.cursor !== cursor)) return;
    listFlight.current?.abort();
    const controller = new AbortController(), current = ++listSequence.current;
    const previous = cursor && listSnapshot.current.userId === userId ? listSnapshot.current.items : [];
    if (!cursor) listCursors.current.clear();
    listFlight.current = controller;
    setRestaurants({ userId, items: previous, cursor: cursor ?? null, loading: true, error: null });
    const valid = () => !controller.signal.aborted && current === listSequence.current && liveUser.current === userId;
    void api.restaurants(cursor, controller.signal).then(page => {
      if (!valid()) return;
      if (!page || !Array.isArray(page.items) || page.items.length > 20 || typeof page.has_more !== 'boolean'
        || (page.next_cursor !== null && (typeof page.next_cursor !== 'string' || !page.next_cursor || page.next_cursor.length > 2048))
        || page.has_more !== (page.next_cursor !== null) || (page.next_cursor !== null && (page.next_cursor === cursor || listCursors.current.has(page.next_cursor)))) throw new ApiError(502, 'USAGE_RESPONSE_INVALID');
      const options: RestaurantOption[] = [], ids = new Set<string>();
      for (const item of page.items) {
        if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(item.id) || item.role !== 'owner'
          || typeof item.name !== 'string' || !['draft', 'active', 'suspended', 'archived'].includes(item.status) || ids.has(item.id)) throw new ApiError(502, 'USAGE_RESPONSE_INVALID');
        ids.add(item.id);
        if (item.status === 'draft' || item.status === 'active') options.push({ id: item.id, name: item.name });
      }
      if (cursor) listCursors.current.add(cursor);
      const merged = new Map(previous.map(item => [item.id, item]));
      options.forEach(item => merged.set(item.id, item));
      setRestaurants({ userId, items: [...merged.values()], cursor: page.next_cursor, loading: false, error: null });
    }).catch(error => {
      if (!valid()) return;
      if (accessLost(error)) {
        ++sequence.current; flight.current?.abort(); moreFlight.current?.abort();
        setState({ userId, revision: sequence.current, query: {}, report: null, page: null, loading: false, error: errorMessage(error), moreLoading: false, moreError: null });
      }
      setRestaurants({ userId, items: accessLost(error) ? [] : previous, cursor: cursor ?? null, loading: false, error: errorMessage(error) });
    }).finally(() => { if (listFlight.current === controller) listFlight.current = null; });
  }, [userId]);

  useEffect(() => {
    setDraft({ ...emptyDraft }); load({}); loadRestaurants();
    return () => {
      ++sequence.current; ++listSequence.current;
      flight.current?.abort(); moreFlight.current?.abort(); listFlight.current?.abort();
    };
  }, [load, loadRestaurants]);

  function loadMore() {
    const previous = snapshot.current;
    if (busy || previous.userId !== userId || previous.revision !== sequence.current || previous.loading || previous.moreLoading
      || !previous.report || !previous.page?.next_cursor || moreFlight.current || moreCursors.current.has(previous.page.next_cursor)) return;
    const cursor = previous.page.next_cursor, controller = new AbortController(), current = sequence.current;
    moreFlight.current = controller;
    setState(value => ({ ...value, moreLoading: true, moreError: null }));
    const valid = () => !controller.signal.aborted && current === sequence.current && liveUser.current === userId;
    void readUsageCalls({ ...previous.query, limit: USAGE_PAGE_SIZE, cursor }, controller.signal).then(page => {
      if (!valid()) return;
      if (page.next_cursor !== null && moreCursors.current.has(page.next_cursor)) throw new ApiError(502, 'USAGE_RESPONSE_INVALID');
      const items = appendUsageCalls(previous.page!.items, page.items);
      moreCursors.current.add(cursor);
      setState(value => ({ ...value, page: { ...page, items }, moreLoading: false, moreError: null }));
    }).catch(error => {
      if (!valid()) return;
      if (accessLost(error)) {
        clearRestaurants();
        setState(value => ({ ...value, report: null, page: null, moreLoading: false, error: errorMessage(error) }));
      } else setState(value => ({ ...value, moreLoading: false, moreError: errorMessage(error) }));
    }).finally(() => { if (moreFlight.current === controller) moreFlight.current = null; });
  }
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const query = draftQuery(draft);
    try {
      validateUsageQuery(query);
      if (query.restaurant_id && !restaurants.items.some(item => item.id === query.restaurant_id)) throw new ApiError(400, 'USAGE_REQUEST_INVALID');
    } catch (error) { setFormError(errorMessage(error)); return; }
    load(query);
  }
  const edit = (patch: Partial<Draft>) => { setDraft(value => ({ ...value, ...patch })); setFormError(null); };
  // 外层按用户 key 卸载；本层仍在首次换用户渲染时拒绝展示上一用户状态。
  const current = state.userId === userId ? state : null;
  const currentRestaurants = restaurants.userId === userId ? restaurants : null;
  const changed = current && scopeLabel(draftQuery(draft)) !== scopeLabel(current.query);
  return <section className="usage-page" aria-label="Credit usage">
    <header className="usage-heading"><div><p className="usage-eyebrow">Your account</p><h1 tabIndex={-1}>Credit usage</h1><p>Menu recognition, website chat and generation — in one place.</p></div>
      <button type="button" className="usage-primary" disabled={busy || !current} onClick={() => { if (current) load(current.query); }}>Refresh report</button>
    </header>
    {current?.report && <UsageAccountOverview report={current.report} />}
    <form className="usage-filters" onSubmit={apply} noValidate aria-describedby={`${id}-help`}>
      <fieldset disabled={busy}>
        <legend>{current?.report?.quota.configured ? 'History / filters' : 'Report filters'}</legend>
        <label htmlFor={`${id}-restaurant`}>Current owner restaurant<select id={`${id}-restaurant`} value={draft.restaurant_id} onChange={event => edit({ restaurant_id: event.target.value })}>
          <option value="">All account restaurants</option>{currentRestaurants?.items.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}
        </select></label>
        <label htmlFor={`${id}-feature`}>Feature<select id={`${id}-feature`} value={draft.feature} onChange={event => edit({ feature: event.target.value as Draft['feature'] })}><option value="">All features</option>{USAGE_FEATURES.map(feature => <option key={feature} value={feature}>{featureLabels[feature]}</option>)}</select></label>
        <label htmlFor={`${id}-origin`}>Call origin<select id={`${id}-origin`} value={draft.origin} onChange={event => edit({ origin: event.target.value as Draft['origin'] })}><option value="">All call origins</option><option value="live">Live calls</option><option value="legacy_import">Imported legacy calls (not aggregate jobs)</option></select></label>
        <label className="usage-checkbox" htmlFor={`${id}-dates`}><input id={`${id}-dates`} type="checkbox" checked={draft.dates} onChange={event => edit({ dates: event.target.checked })} />Filter UTC dates</label>
        <label htmlFor={`${id}-from`}>From · UTC<input id={`${id}-from`} type="date" min="0001-01-01" max="9999-12-31" value={draft.from} disabled={!draft.dates} required={draft.dates} aria-invalid={!!formError} onChange={event => edit({ from: event.target.value })} /></label>
        <label htmlFor={`${id}-to`}>To · UTC<input id={`${id}-to`} type="date" min="0001-01-01" max="9999-12-31" value={draft.to} disabled={!draft.dates} required={draft.dates} aria-invalid={!!formError} onChange={event => edit({ to: event.target.value })} /></label>
        <button type="submit" className="usage-primary">Apply filters</button>
      </fieldset>
      <details className="usage-explanation"><summary id={`${id}-help`}>About these filters</summary><p>Default: all time. Optional dates include both UTC calendar days, up to 366 days; no local-time window. Only loaded, current usable owner restaurants can be selected.</p></details>
      {formError && <p className="usage-error" role="alert">{formError}</p>}
    </form>
    <div className="usage-actions">
      <button type="button" disabled={busy} onClick={() => loadRestaurants()}>Reload current restaurants</button>
      {currentRestaurants?.cursor && <button type="button" disabled={busy || currentRestaurants.loading} onClick={() => loadRestaurants(currentRestaurants.cursor!)}>Load more restaurants</button>}
      <span className="usage-note">{currentRestaurants?.loading ? 'Reading 20 current restaurants…' : `${currentRestaurants?.items.length ?? 0} restaurants loaded`}</span>
    </div>
    {currentRestaurants?.error && <p className="usage-error" role="alert">Restaurant list: {currentRestaurants.error}</p>}
    {changed && <p className="usage-note">Unapplied filter changes. Refresh reads the last applied scope, not this draft.</p>}
    <div className="usage-read-status" role="status" aria-live="polite">{current?.loading ? `Reading a fresh usage report… ${scopeLabel(current.query)}` : current?.error ? scopeLabel(current.query) : current?.moreLoading ? 'Reading the next call page…' : ''}</div>
    {current?.error && <div className="usage-error" role="alert"><h2>Usage could not be loaded</h2><p>{current.error}</p><button type="button" disabled={busy} onClick={() => load(current.query)}>Retry report</button></div>}
    {current?.report && current.page && <>
      <UsageReportView report={current.report} calls={current.page.items} includeOverview={false} />
      <div className="usage-actions"><span>{number(current.page.items.length)} calls loaded{current.page.next_cursor === null ? ' · End of returned pages' : ''}.</span>
        {current.page.next_cursor && <button type="button" disabled={busy || current.moreLoading} onClick={loadMore}>{current.moreError ? 'Retry more calls' : 'Load more calls'}</button>}
      </div>
      {current.moreError && <p className="usage-error" role="alert">Next page failed; previously loaded calls remain in this same scope. {current.moreError}</p>}
    </>}
  </section>;
}

export default function UsagePage({ userId, active, busy }: UsagePageProps) {
  // 只读页不保存暂停的私有状态；失效直接卸载，恢复只读取新快照，不重放旧 cursor。
  return active ? <UsageReader key={userId} userId={userId} busy={busy} /> : null;
}
