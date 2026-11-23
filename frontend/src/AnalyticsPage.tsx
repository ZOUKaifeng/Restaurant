import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError } from './api';
import {
  analyticsCalendarDates, readAnalytics, safeAnalyticsSum, validateAnalyticsRange,
  type AnalyticsNamespace, type AnalyticsQuery, type AnalyticsRange, type AnalyticsReport,
  type ReservationBasis, type ReservationDay, type TrafficDay,
} from './analytics-client';
import './analytics-page.css';

export type AnalyticsPageProps = { restaurantId: string; active: boolean; busy: boolean };
export type AnalyticsReportViewProps = {
  report: AnalyticsReport;
  reservationBasis?: ReservationBasis;
  onReservationBasisChange?: (basis: ReservationBasis) => void;
};
type Draft = AnalyticsRange & { namespace: AnalyticsNamespace | '' };
type Attempt = { query: AnalyticsQuery; draftRevision: number | null };
type TrendPoint = { date: string; values: Record<string, number> };
type TrendSeries = { key: string; label: string; color: string; dash?: string };

const numberFormat = new Intl.NumberFormat('en-US');
const trafficSeries: TrendSeries[] = [
  { key: 'page_views', label: 'Page views', color: '#555' },
  { key: 'reservation_clicks', label: 'Reservation entry opens', color: '#888', dash: '6 3' },
  { key: 'reservation_form_views', label: 'Reservation form views', color: '#666', dash: '2 3' },
];
const reservationSeries: TrendSeries[] = [
  { key: 'requests', label: 'Requests', color: '#555' },
  { key: 'party_size', label: 'Requested guests', color: '#737373', dash: '6 3' },
];
const statusLabels = [
  ['pending', 'Pending'], ['confirmed', 'Confirmed'], ['declined', 'Declined'], ['cancelled', 'Cancelled'],
] as const;
const basisLabels: Record<ReservationBasis, { title: string; day: string; description: string }> = {
  created: {
    title: 'By request creation date', day: 'Creation date',
    description: 'Requests created in this range, grouped by creation day in each record’s historical timezone.',
  },
  scheduled: {
    title: 'By scheduled reservation date', day: 'Scheduled date',
    description: 'Requests scheduled for local reservation dates in this range, regardless of when they were created.',
  },
};

function displayDate(date: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${date}T00:00:00.000Z`));
}

function displayGeneratedAt(report: AnalyticsReport): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: report.current_timezone, timeZoneName: 'short',
  }).format(new Date(report.generated_at));
}

function environmentLabel(namespace: AnalyticsNamespace): string {
  return namespace === 'local_test' ? 'Local test traffic' : 'Production traffic';
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'ANALYTICS_RANGE_INVALID') return 'Enter valid dates in order. The inclusive range may not exceed 366 days.';
    if (error.code === 'ANALYTICS_NAMESPACE_INVALID') return 'Choose a valid traffic environment.';
    if (error.code === 'REQUEST_TIMEOUT') return 'The analytics request timed out. Retry to read a fresh report.';
    if (error.status === 401) return 'Your session has expired. Sign in again to view analytics.';
    if (error.status === 403) return 'Access to this restaurant is no longer available.';
    if (error.status === 404) return 'This restaurant is unavailable or does not belong to your account.';
    if (error.code === 'ANALYTICS_COUNT_OVERFLOW') return 'Counts exceed the safe integer limit. No estimated report is shown.';
    if (error.status === 422) return 'The server could not accept this range or safely calculate its counts. Check the dates and retry.';
    if (error.status === 400) return 'The analytics request is invalid. Check the selected restaurant and filters.';
    if (error.status === 502) return 'The analytics response failed validation. No unverified report is shown.';
    if (error.status === 503) return 'Analytics is temporarily unavailable. Retry to read a fresh report.';
    if (error.status === 429) return 'Too many requests. Try again later.';
    if (error.status === 0) return 'Unable to reach analytics. Check your connection and retry.';
  }
  return 'Unable to load analytics. Retry to read a fresh report.';
}

function trendPoints(range: AnalyticsRange, days: readonly (TrafficDay | ReservationDay)[], series: readonly TrendSeries[]): TrendPoint[] {
  const buckets = new Map<string, Record<string, number>>();
  for (const day of days) {
    const values = buckets.get(day.date) ?? {};
    for (const item of series) {
      const value = item.key in day ? (day as unknown as Record<string, number>)[item.key] : undefined;
      if (value === undefined) throw new ApiError(502, 'ANALYTICS_RESPONSE_INVALID');
      values[item.key] = safeAnalyticsSum([values[item.key] ?? 0, value]);
    }
    buckets.set(day.date, values);
  }
  // 仅趋势补齐稀疏日；原始表保留所有历史时区分桶，绝不补造原始行。
  return analyticsCalendarDates(range).map(date => ({
    date, values: buckets.get(date) ?? Object.fromEntries(series.map(item => [item.key, 0])),
  }));
}

function DailyTrend({ title, points, series }: { title: string; points: TrendPoint[]; series: readonly TrendSeries[] }) {
  const titleId = useId(), descriptionId = useId();
  const maximum = Math.max(1, ...points.flatMap(point => series.map(item => point.values[item.key])));
  const left = 62, right = 658, top = 18, bottom = 170;
  const x = (index: number) => points.length === 1 ? (left + right) / 2 : left + index / (points.length - 1) * (right - left);
  const y = (value: number) => bottom - value / maximum * (bottom - top);
  const middle = Math.floor((points.length - 1) / 2);
  const ticks = [...new Set([0, middle, points.length - 1])];
  return <figure className="an-trend">
    <svg viewBox="0 0 680 210" role="img" aria-labelledby={`${titleId} ${descriptionId}`}>
      <title id={titleId}>{title}</title>
      <desc id={descriptionId}>Daily counts for {points[0].date} through {points[points.length - 1].date}. Historical timezone buckets are summed by calendar date. Missing daily buckets plot as zero. Exact values are available in the daily tables.</desc>
      {[top, bottom].map((position, index) => <g key={position}>
        <line x1={left} y1={position} x2={right} y2={position} className="an-grid-line" />
        <text x={index === 0 ? left : left - 10} y={index === 0 ? position - 6 : position + 4} textAnchor={index === 0 ? 'start' : 'end'} className="an-axis-label">{numberFormat.format(index === 0 ? maximum : 0)}</text>
      </g>)}
      <line x1={left} y1={(top + bottom) / 2} x2={right} y2={(top + bottom) / 2} className="an-grid-line" />
      {series.map(item => <g key={item.key}>
        <polyline points={points.map((point, index) => `${x(index)},${y(point.values[item.key])}`).join(' ')}
          fill="none" stroke={item.color} strokeWidth="2" strokeDasharray={item.dash} vectorEffect="non-scaling-stroke" />
        {points.length === 1 && <circle cx={x(0)} cy={y(points[0].values[item.key])} r="3" fill={item.color} />}
      </g>)}
      {ticks.map(index => <text key={index} x={x(index)} y="197" textAnchor={points.length === 1 ? 'middle' : index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'} className="an-axis-label">{points[index].date}</text>)}
    </svg>
    <figcaption>
      <ul className="an-legend" aria-label="Chart series">
        {series.map(item => <li key={item.key}><svg width="20" height="8" aria-hidden="true"><line x1="0" y1="4" x2="20" y2="4" stroke={item.color} strokeWidth="2" strokeDasharray={item.dash} /></svg>{item.label}</li>)}
      </ul>
      <p className="an-small">Calendar-day totals across historical timezones. Missing daily buckets plot as zero; raw rows remain sparse.</p>
    </figcaption>
  </figure>;
}

function Metric({ label, value, note }: { label: string; value: number; note: string }) {
  return <div className="an-metric">
    <dt>{label}</dt>
    <dd className="an-metric-value">{numberFormat.format(value)}</dd>
    <dd className="an-small an-metric-note">{note}</dd>
  </div>;
}

export function AnalyticsReportView({ report, reservationBasis = 'created', onReservationBasisChange }: AnalyticsReportViewProps) {
  const traffic = report.traffic, group = report.reservations[reservationBasis], labels = basisLabels[reservationBasis];
  const empty = Object.values(traffic.totals).every(count => count === 0)
    && report.reservations.created.totals.requests === 0 && report.reservations.created.totals.party_size === 0
    && report.reservations.scheduled.totals.requests === 0 && report.reservations.scheduled.totals.party_size === 0;
  return <div className="an-page an-report-view">
    <section className="an-report-meta" aria-label="Current report">
      <div>
        <p className="an-eyebrow">Current report · metric {report.metric_version}</p>
        <h2>{displayDate(report.range.from)} – {displayDate(report.range.to)}</h2>
        <p className="an-small">Restaurant <span className="an-id">{report.restaurant_id}</span></p>
      </div>
      <div className="an-meta-side">
        <span className={`an-badge${report.namespace === 'local_test' ? ' an-test-badge' : ''}`}>{environmentLabel(report.namespace)}</span>
        <p className="an-small">Current restaurant timezone: {report.current_timezone}{report.timezone_fallback ? ' · UTC fallback' : ''}</p>
        <p className="an-small">Generated <time dateTime={report.generated_at}>{displayGeneratedAt(report)}</time></p>
      </div>
    </section>

    {report.namespace === 'local_test' && <p className="an-notice">Test traffic only — these traffic counts are not production activity. Reservation records below still include all records for this restaurant.</p>}
    {report.timezone_fallback && <p className="an-notice">The restaurant’s current timezone is missing or invalid. The server uses UTC when selecting default dates. Historical rows retain their recorded timezones.</p>}
    {empty && <div className="an-empty" role="status"><h3>No activity in this report</h3><p>No traffic was recorded in this environment, and no reservation requests matched either date basis in this range.</p></div>}

    <section className="an-section" aria-label="Website traffic">
      <div className="an-section-heading"><div><p className="an-eyebrow">Website traffic</p><h3>Activity, not people</h3></div><span className="an-small">{environmentLabel(report.namespace)}</span></div>
      <dl className="an-metrics">
        <Metric label="Page views" value={traffic.totals.page_views} note="Successful document requests. Not unique visitors." />
        <Metric label="Reservation entry opens" value={traffic.totals.reservation_clicks} note="Platform entry redirects opened. Not every button click." />
        <Metric label="Reservation form views" value={traffic.totals.reservation_form_views} note="Successful reservation form GET requests." />
      </dl>
      {traffic.days.length === 0 && <p className="an-empty-line">No recorded traffic in this environment and range.</p>}
      <DailyTrend title="Daily website traffic" points={trendPoints(report.range, traffic.days, trafficSeries)} series={trafficSeries} />
      <p className="an-small">These are independent request counters, not a conversion funnel or a count of individual people.</p>
    </section>

    <section className="an-section" aria-label="Reservation activity">
      <div className="an-section-heading">
        <div><p className="an-eyebrow">Reservations · all restaurant records</p><h3>{labels.title}</h3></div>
        {onReservationBasisChange && <label className="an-basis-label">Date basis
          <select value={reservationBasis} onChange={event => onReservationBasisChange(event.target.value as ReservationBasis)}>
            <option value="created">Request creation date</option><option value="scheduled">Scheduled reservation date</option>
          </select>
        </label>}
      </div>
      <p className="an-description">{labels.description} Traffic environment does not filter reservations.</p>
      <dl className="an-metrics an-metrics-two">
        <Metric label="Reservation requests" value={group.totals.requests} note="All requests, including declined and cancelled records." />
        <Metric label="Requested guests" value={group.totals.party_size} note="Sum of requested party sizes, including declined and cancelled requests. Not arrivals." />
      </dl>
      <div className="an-reservation-detail">
        <div className="an-reservation-chart">
          {group.days.length === 0 && <p className="an-empty-line">No reservation requests matched this date basis and range.</p>}
          <DailyTrend title={`Daily reservations: ${labels.title.toLowerCase()}`} points={trendPoints(report.range, group.days, reservationSeries)} series={reservationSeries} />
        </div>
        <div className="an-statuses">
          <h4>Current request status</h4>
          <p className="an-small">Status at query time, not historical status on each day.</p>
          <dl>
            {statusLabels.map(([key, label]) => <div className="an-status-row" key={key}>
              <dt>{label}</dt><dd>{numberFormat.format(group.totals.statuses[key])}</dd>
              <dd className="an-status-track" aria-hidden="true"><span style={{ width: `${group.totals.statuses[key] / Math.max(1, group.totals.requests) * 100}%` }} /></dd>
            </div>)}
          </dl>
          <p className="an-small">Confirmed means accepted, not attended. These records do not establish a traffic-to-reservation conversion rate.</p>
        </div>
      </div>
    </section>

    <section className="an-section" aria-label="Daily source rows">
      <div className="an-section-heading"><div><p className="an-eyebrow">Daily source rows</p><h3>Historical timezone buckets</h3></div></div>
      <p className="an-description">Only returned daily rows are listed. A date may appear more than once with different historical timezone or fallback labels. Charts sum those rows by date.</p>
      <div className="an-table-scroll" tabIndex={0} role="region" aria-label="Daily traffic table, scroll horizontally for all columns">
        <table>
          <caption>Traffic · {environmentLabel(report.namespace)}</caption>
          <thead><tr><th scope="col">Date</th><th scope="col">Historical timezone</th><th scope="col">UTC fallback</th><th scope="col">Page views</th><th scope="col">Entry opens</th><th scope="col">Form views</th></tr></thead>
          <tbody>{traffic.days.map((day, index) => <tr key={`${day.date}-${day.timezone}-${day.timezone_fallback}-${index}`}>
            <th scope="row"><time dateTime={day.date}>{day.date}</time></th><td>{day.timezone}</td><td>{day.timezone_fallback ? 'Yes' : 'No'}</td>
            <td>{numberFormat.format(day.page_views)}</td><td>{numberFormat.format(day.reservation_clicks)}</td><td>{numberFormat.format(day.reservation_form_views)}</td>
          </tr>)}{traffic.days.length === 0 && <tr><td colSpan={6} className="an-table-empty">No traffic rows returned for this environment and range.</td></tr>}</tbody>
        </table>
      </div>
      <div className="an-table-scroll" tabIndex={0} role="region" aria-label="Daily reservation table, scroll horizontally for all columns">
        <table>
          <caption>Reservations · {labels.title} · all restaurant records</caption>
          <thead><tr><th scope="col">{labels.day}</th><th scope="col">Historical timezone</th><th scope="col">Requests</th><th scope="col">Requested guests</th>{statusLabels.map(([key, label]) => <th scope="col" key={key}>{label}</th>)}</tr></thead>
          <tbody>{group.days.map((day, index) => <tr key={`${day.date}-${day.timezone}-${index}`}>
            <th scope="row"><time dateTime={day.date}>{day.date}</time></th><td>{day.timezone}</td>
            <td>{numberFormat.format(day.requests)}</td><td>{numberFormat.format(day.party_size)}</td>{statusLabels.map(([key]) => <td key={key}>{numberFormat.format(day.statuses[key])}</td>)}
          </tr>)}{group.days.length === 0 && <tr><td colSpan={8} className="an-table-empty">No reservation rows returned for this date basis and range.</td></tr>}</tbody>
        </table>
      </div>
      <p className="an-small">Reservation timezone snapshots are provided, but v1 does not provide a reservation-day fallback flag. No fallback value is inferred.</p>
    </section>

    <section className="an-unavailable" aria-label="Unavailable measurements">
      <div><h3>Unique visitors</h3><p>Not measured</p><span className="an-small">UV is unavailable, not zero.</span></div>
      <div><h3>Subscriptions</h3><p>Not available</p><span className="an-small">Subscription tracking is not implemented; no active count is available.</span></div>
    </section>
  </div>;
}

function AnalyticsReader({ restaurantId, busy }: Pick<AnalyticsPageProps, 'restaurantId' | 'busy'>) {
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [draft, setDraft] = useState<Draft>({ from: '', to: '', namespace: '' });
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [basis, setBasis] = useState<ReservationBasis>('created');
  const sequence = useRef(0), controller = useRef<AbortController | null>(null), draftRevision = useRef(0);
  const lastAttempt = useRef<Attempt>({ query: {}, draftRevision: 0 });
  const formErrorId = useId(), filterHelpId = useId();

  const load = useCallback((attempt: Attempt) => {
    controller.current?.abort();
    const currentController = new AbortController(), currentSequence = ++sequence.current;
    controller.current = currentController;
    const snapshot: Attempt = { query: { ...attempt.query }, draftRevision: attempt.draftRevision };
    lastAttempt.current = snapshot;
    setLoading(true);
    setReadError(null);
    setFormError(null);
    void readAnalytics(restaurantId, snapshot.query, currentController.signal).then(next => {
      if (currentController.signal.aborted || currentSequence !== sequence.current) return;
      setReport(next);
      if (snapshot.draftRevision !== null && draftRevision.current === snapshot.draftRevision) {
        setDraft({ ...next.range, namespace: next.namespace });
      }
    }).catch(error => {
      if (currentController.signal.aborted || currentSequence !== sequence.current) return;
      // 出错即撤下旧报告，不把新草稿或失败范围配到旧数值上。
      setReport(null);
      setReadError(errorMessage(error));
    }).finally(() => {
      if (!currentController.signal.aborted && currentSequence === sequence.current) setLoading(false);
    });
  }, [restaurantId]);

  useEffect(() => {
    load({ query: {}, draftRevision: 0 });
    return () => { ++sequence.current; controller.current?.abort(); };
  }, [load]);

  const edit = (patch: Partial<Draft>) => {
    ++draftRevision.current;
    setDraft(previous => ({ ...previous, ...patch }));
    setFormError(null);
  };
  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || loading) return;
    try { validateAnalyticsRange(draft); }
    catch (error) { setFormError(errorMessage(error)); return; }
    const query: AnalyticsQuery = { from: draft.from, to: draft.to };
    if (draft.namespace) query.namespace = draft.namespace;
    load({ query, draftRevision: draftRevision.current });
  };
  const draftChanged = report !== null && (draft.from !== report.range.from || draft.to !== report.range.to || draft.namespace !== report.namespace);

  return <section className="an-page" aria-label="Analytics">
    <header className="an-page-heading"><p className="an-eyebrow">Table Folk · restaurant analytics</p><h1>Analytics</h1><p>Understand website activity and reservation requests. Real counts, with their limits made clear.</p></header>
    <form className="an-filters" onSubmit={apply} noValidate aria-describedby={`${filterHelpId}${formError ? ` ${formErrorId}` : ''}`}>
      <fieldset disabled={busy}>
        <legend className="an-sr-only">Analytics report filters</legend>
        <label>From<input type="date" value={draft.from} min="0001-01-01" max="9999-12-31" onChange={event => edit({ from: event.target.value })} required aria-invalid={!!formError} aria-describedby={formError ? formErrorId : undefined} /></label>
        <label>To<input type="date" value={draft.to} min="0001-01-01" max="9999-12-31" onChange={event => edit({ to: event.target.value })} required aria-invalid={!!formError} aria-describedby={formError ? formErrorId : undefined} /></label>
        <label>Traffic environment<select value={draft.namespace} onChange={event => edit({ namespace: event.target.value as Draft['namespace'] })}>
          <option value="">Server default</option><option value="production">Production</option><option value="local_test">Local test</option>
        </select></label>
        <button className="an-button" type="submit" disabled={loading}>Apply filters</button>
      </fieldset>
      <div className="an-filter-footer">
        <p id={filterHelpId} className="an-small">Inclusive dates · up to 366 calendar days. Defaults are selected by the server in the restaurant’s current timezone.</p>
        <div className="an-actions">
          <button className="an-button an-secondary" type="button" disabled={busy || loading} onClick={() => load({ query: {}, draftRevision: draftRevision.current })}>Default last 30 days</button>
          <button className="an-button an-secondary" type="button" disabled={busy || loading || !report} onClick={() => {
            if (report) load({ query: { ...report.range, namespace: report.namespace }, draftRevision: null });
          }}>Refresh report</button>
        </div>
      </div>
      {formError && <p className="an-notice" id={formErrorId} role="alert">{formError}</p>}
    </form>
    {draftChanged && <p className="an-draft-note">Unapplied filter changes. The current report below still shows its own dates and traffic environment. Refresh does not apply your draft.</p>}
    <div className="an-read-status" role="status" aria-live="polite" aria-atomic="true">
      {loading ? (report ? 'Updating… The previous report below remains labeled with its own range and environment.' : 'Loading analytics… Reading a fresh report from the server.') : report ? 'Report ready.' : ''}
    </div>
    {readError && <div className="an-error" role="alert"><h2>Analytics could not be loaded</h2><p>{readError}</p><button className="an-button" type="button" disabled={busy || loading} onClick={() => load(lastAttempt.current)}>Retry report</button></div>}
    {report && <div className={loading ? 'an-updating' : undefined} aria-busy={loading}>
      <AnalyticsReportView report={report} reservationBasis={basis} onReservationBasisChange={setBasis} />
    </div>}
  </section>;
}

export default function AnalyticsPage({ restaurantId, active, busy }: AnalyticsPageProps) {
  // 停用或切店时卸载整个读取状态；重新激活始终重新读取真实后端默认。
  return active ? <AnalyticsReader key={restaurantId} restaurantId={restaurantId} busy={busy} /> : null;
}
