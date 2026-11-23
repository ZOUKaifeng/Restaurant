import { useEffect, useId, useRef, useState } from 'react';
import { ApiError } from './api';
import {
  reservationErrorMessage, reservationsClient, validateReservationFilters,
  type MerchantReservationView, type ReservationCancelInput, type ReservationDecisionInput,
  type ReservationDetail, type ReservationFilters, type ReservationList,
  type ReservationSettings, type ReservationSettingsInput, type ReservationStatus,
} from './reservations-client';
import './reservations-page.css';

export interface ReservationsPageProps {
  restaurantId: string; active: boolean; busy: boolean;
  onBusyChange: (value: boolean) => void; onDirtyChange: (value: boolean) => void;
  onSettingsSaved?: (settings: ReservationSettings) => void;
}
type Action = 'confirm' | 'decline' | 'cancel';
type FilterDraft = { status: ReservationStatus | ''; from: string; to: string };
type ActionDraft = {
  action: Action; targetId: string; reference: string; revision: number; reason: string; reviewed: boolean;
};
type SettingsDraft = {
  enabled: boolean; notice: string; privacy: string; basePrivacy: string | null; revision: number; reviewed: boolean;
};
type Attempt = Readonly<{
  kind: 'decision'; restaurantId: string; targetId: string; reference: string;
  key: string; body: Readonly<ReservationDecisionInput>;
}> | Readonly<{
  kind: 'cancel'; restaurantId: string; targetId: string; reference: string;
  key: string; body: Readonly<ReservationCancelInput>;
}> | Readonly<{
  kind: 'settings'; restaurantId: string; key: string; body: Readonly<ReservationSettingsInput>;
}>;
type Flight = { controller: AbortController; epoch: number };
type ReadSlot = 'list' | 'detail' | 'settings';
const actionLabels: Record<Action, string> = { confirm: 'Confirm reservation', decline: 'Decline request', cancel: 'Cancel reservation' };
const statusLabels: Record<ReservationStatus, string> = {
  pending: 'Pending', confirmed: 'Confirmed', declined: 'Declined', cancelled: 'Cancelled',
};
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
function formatInstant(value: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(value));
}
function actionAllowed(status: ReservationStatus, action: Action): boolean {
  return status === 'pending' || (status === 'confirmed' && action === 'cancel');
}
function reasonError(draft: ActionDraft): string | null {
  if (draft.action === 'decline' && !draft.reason.trim()) return 'A reason is required to decline a request.';
  if (Array.from(draft.reason.trim()).length > 500) return 'Use no more than 500 characters for the reason.';
  return null;
}
function settingsDraftError(draft: SettingsDraft, settings: ReservationSettings): string | null {
  if (Array.from(draft.notice.trim()).length > 2000) return 'Use no more than 2,000 characters for the notice.';
  if (Array.from(draft.privacy.trim()).length > 64) return 'Use no more than 64 characters for the privacy notice version.';
  if (!draft.privacy.trim() && draft.basePrivacy !== null) return 'The privacy notice version cannot be cleared. Enter a version or discard your edits.';
  if (draft.enabled && !settings.timezone) return 'Set a timezone in restaurant details before enabling requests.';
  if (draft.enabled && !draft.privacy.trim()) return 'A privacy notice version is required before enabling requests.';
  if (draft.enabled && !settings.intervals.some(interval => interval.accepts_requests)) return 'At least one opening-hours interval must accept requests.';
  return null;
}

export function ReservationsListView({ items, selectedId, onSelect, disabled = false }: {
  items: readonly MerchantReservationView[]; selectedId: string | null;
  onSelect: (id: string) => void; disabled?: boolean;
}) {
  if (!items.length) return <div className="rs-empty"><h3>No reservations found</h3><p>No requests match the applied filters. Try another status or date range.</p></div>;
  return <ul className="rs-list" aria-label="Reservation requests">
    {items.map(item => <li key={item.id}>
      <button className={`rs-row${selectedId === item.id ? ' rs-row-selected' : ''}`} type="button"
        aria-pressed={selectedId === item.id} disabled={disabled} onClick={() => onSelect(item.id)}>
        <span className="rs-row-top"><strong>{item.guest_name}</strong><span className="rs-status">{statusLabels[item.status]}</span></span>
        <span className="rs-row-time">{formatInstant(item.requested_start_at, item.timezone)}</span>
        <span className="rs-row-bottom"><span>{item.party_size} {item.party_size === 1 ? 'guest' : 'guests'}</span><span className="rs-reference">{item.reference}</span></span>
      </button>
    </li>)}
  </ul>;
}
export function ReservationDetailView({ detail }: { detail: ReservationDetail }) {
  const reservation = detail.reservation;
  return <div className="rs-detail-content">
    <div className="rs-detail-title"><div><p className="rs-eyebrow">{reservation.reference}</p><h3>{reservation.guest_name}</h3></div><span className="rs-status">{statusLabels[reservation.status]}</span></div>
    <div className="rs-request-time"><strong>{formatInstant(reservation.requested_start_at, reservation.timezone)}</strong>
      <p>{reservation.party_size} {reservation.party_size === 1 ? 'guest' : 'guests'} · {reservation.restaurant_name}</p>
      <p className="rs-muted">Displayed in {reservation.timezone}. Original local request snapshot: {reservation.local_date} at {reservation.local_time}.</p>
    </div>
    <dl className="rs-contact"><div><dt>Email</dt><dd>{reservation.guest_email ?? 'Not provided'}</dd></div>
      <div><dt>Phone</dt><dd>{reservation.guest_phone ?? 'Not provided'}</dd></div></dl>
    <section className="rs-note"><h4>Guest note</h4><p>{reservation.note || 'No guest note.'}</p></section>
    <section className="rs-note"><h4>Internal note</h4><p>{reservation.internal_note || 'No internal note.'}</p><p className="rs-muted">Read-only. This interface does not edit internal notes.</p></section>
    <section className="rs-note"><h4>Decision reason</h4><p>{reservation.decision_reason || 'No reason recorded.'}</p></section>
    <dl className="rs-meta"><div><dt>Created</dt><dd>{formatInstant(reservation.created_at, reservation.timezone)}</dd></div>
      <div><dt>Updated</dt><dd>{formatInstant(reservation.updated_at, reservation.timezone)}</dd></div>
      {reservation.decided_at && <div><dt>Decided</dt><dd>{formatInstant(reservation.decided_at, reservation.timezone)}</dd></div>}
      {reservation.cancelled_at && <div><dt>Cancelled</dt><dd>{formatInstant(reservation.cancelled_at, reservation.timezone)}{reservation.cancelled_by_type ? ` · ${reservation.cancelled_by_type}` : ''}</dd></div>}
      <div><dt>Revision</dt><dd>{reservation.revision}</dd></div></dl>
    <section className="rs-history"><h4>Request history</h4><p className="rs-muted">Most recent first · up to 50 events</p>
      {!detail.events.length ? <p>No history events returned.</p> : <ol>{detail.events.map(event => <li key={event.reservation_revision}>
        <div><strong>{event.event_type === 'created' ? 'Request received' : statusLabels[event.to_status]}</strong><span className="rs-muted">Revision {event.reservation_revision} · {event.actor_type}</span></div>
        <time dateTime={event.created_at}>{formatInstant(event.created_at, reservation.timezone)}</time>
        <p>{event.from_status ? `${statusLabels[event.from_status]} → ` : ''}{statusLabels[event.to_status]}</p>
      </li>)}</ol>}
    </section>
  </div>;
}

export default function ReservationsPage(props: ReservationsPageProps) {
  const { active, busy, restaurantId } = props;
  const fieldId = useId();
  const propsRef = useRef(props);
  propsRef.current = props;
  const mounted = useRef(false);
  const epoch = useRef(0);
  const reads = useRef<Partial<Record<ReadSlot, Flight>>>({});
  const writeFlight = useRef<Flight | null>(null);
  const appliedRef = useRef<ReservationFilters>({});
  const cursorsRef = useRef<(string | undefined)[]>([undefined]);
  const pageRef = useRef(0);
  const selectedRef = useRef<string | null>(null);
  const detailRef = useRef<ReservationDetail | null>(null);
  const settingsRef = useRef<ReservationSettings | null>(null);
  const detailFresh = useRef(false);
  const settingsFresh = useRef(false);
  const actionRef = useRef<ActionDraft | null>(null);
  const settingsDraftRef = useRef<SettingsDraft | null>(null);
  const attemptRef = useRef<Attempt | null>(null);
  const uncertainAttempts = useRef(new WeakSet<Attempt>());
  const dirtyRef = useRef(false);
  const [filters, setFilters] = useState<FilterDraft>({ status: '', from: '', to: '' });
  const [applied, setApplied] = useState<ReservationFilters>({});
  const [filterError, setFilterError] = useState<string | null>(null);
  const [list, setList] = useState<ReservationList | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReservationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailStale, setDetailStale] = useState(true);
  const [settings, setSettings] = useState<ReservationSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsStale, setSettingsStale] = useState(true);
  const [actionDraft, setActionDraft] = useState<ActionDraft | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [attemptMessage, setAttemptMessage] = useState<string | null>(null);
  const [abandonReview, setAbandonReview] = useState(false);
  const [writing, setWriting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  function reportDirty() {
    const next = !!(actionRef.current || settingsDraftRef.current || attemptRef.current);
    if (dirtyRef.current !== next) {
      dirtyRef.current = next;
      propsRef.current.onDirtyChange(next);
    }
  }
  function putAction(value: ActionDraft | null) { actionRef.current = value; setActionDraft(value); reportDirty(); }
  function putSettingsDraft(value: SettingsDraft | null) { settingsDraftRef.current = value; setSettingsDraft(value); reportDirty(); }
  function putAttempt(value: Attempt | null) { attemptRef.current = value; setAttempt(value); reportDirty(); }
  function canRead() { return mounted.current && propsRef.current.active; }
  function abortReads() {
    Object.values(reads.current).forEach(flight => flight.controller.abort());
    reads.current = {};
  }
  function startRead(slot: ReadSlot): Flight | null {
    if (!canRead()) return null;
    reads.current[slot]?.controller.abort();
    const flight = { controller: new AbortController(), epoch: epoch.current };
    reads.current[slot] = flight;
    return flight;
  }
  function currentRead(slot: ReadSlot, flight: Flight) {
    return canRead() && flight.epoch === epoch.current && reads.current[slot] === flight && !flight.controller.signal.aborted;
  }
  function resetPages() { cursorsRef.current = [undefined]; pageRef.current = 0; setPage(0); }
  async function loadList(cursor?: string) {
    const flight = startRead('list');
    if (!flight) return;
    const filter = { ...appliedRef.current };
    setList(null); setListLoading(true); setListError(null);
    try {
      const result = await reservationsClient.list(propsRef.current.restaurantId, filter, cursor, flight.controller.signal);
      if (currentRead('list', flight)) setList(result);
    } catch (error) {
      if (currentRead('list', flight)) setListError(reservationErrorMessage(error));
    } finally {
      if (currentRead('list', flight)) { delete reads.current.list; setListLoading(false); }
    }
  }
  async function loadDetail(id: string): Promise<ReservationDetail | null> {
    const flight = startRead('detail');
    if (!flight) return null;
    detailRef.current = null; detailFresh.current = false;
    setDetail(null); setDetailStale(true); setDetailLoading(true); setDetailError(null);
    try {
      const result = await reservationsClient.detail(propsRef.current.restaurantId, id, flight.controller.signal);
      if (!currentRead('detail', flight) || selectedRef.current !== id) return null;
      detailRef.current = result; detailFresh.current = true;
      setDetail(result); setDetailStale(false);
      return result;
    } catch (error) {
      if (currentRead('detail', flight)) setDetailError(reservationErrorMessage(error));
      return null;
    } finally {
      if (currentRead('detail', flight)) { delete reads.current.detail; setDetailLoading(false); }
    }
  }
  async function loadSettings(): Promise<ReservationSettings | null> {
    const flight = startRead('settings');
    if (!flight) return null;
    settingsFresh.current = false; setSettingsStale(true); setSettingsLoading(true); setSettingsError(null);
    try {
      const result = await reservationsClient.settings(propsRef.current.restaurantId, flight.controller.signal);
      if (!currentRead('settings', flight)) return null;
      settingsRef.current = result; settingsFresh.current = true; setSettings(result); setSettingsStale(false);
      return result;
    } catch (error) {
      if (currentRead('settings', flight)) setSettingsError(reservationErrorMessage(error));
      return null;
    } finally {
      if (currentRead('settings', flight)) { delete reads.current.settings; setSettingsLoading(false); }
    }
  }
  function releaseWrite(flight: Flight) {
    if (writeFlight.current !== flight) return;
    writeFlight.current = null;
    if (mounted.current) setWriting(false);
    propsRef.current.onBusyChange(false);
  }
  function pause() {
    epoch.current += 1; abortReads();
    const flight = writeFlight.current;
    if (flight) {
      if (attemptRef.current) uncertainAttempts.current.add(attemptRef.current);
      flight.controller.abort(); releaseWrite(flight);
    }
    detailFresh.current = false; settingsFresh.current = false;
    if (mounted.current) {
      setListLoading(false); setDetailLoading(false); setSettingsLoading(false);
      setDetailStale(true); setSettingsStale(true);
      if (attemptRef.current) setAttemptMessage('The request was interrupted. Its result is unverified. Nothing will be replayed automatically.');
    }
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; epoch.current += 1; abortReads();
      const flight = writeFlight.current;
      if (flight) { flight.controller.abort(); releaseWrite(flight); }
      // 卸载不保留全局脏状态；暂停则保留组件内草稿及冻结的 attempt。
      propsRef.current.onDirtyChange(false); dirtyRef.current = false;
    };
    // 餐厅切换由主线程的 key 触发卸载，不在这里复用另一餐厅状态。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (active) { epoch.current += 1; resetPages(); void loadList(); reportDirty(); }
    else pause();
    return () => { pause(); };
    // 恢复只重读列表，不覆盖未保存草稿，也不自动重放写请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, restaurantId]);

  function selectRecord(id: string) {
    if (!canRead() || writeFlight.current || attemptRef.current || actionRef.current) return;
    selectedRef.current = id; setSelectedId(id); setWriteError(null); setMessage(null);
    void loadDetail(id);
  }
  function applyFilters() {
    if (!canRead() || writeFlight.current) return;
    const next: ReservationFilters = {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.from ? { from: filters.from } : {}), ...(filters.to ? { to: filters.to } : {}),
    };
    try { validateReservationFilters(next); }
    catch { setFilterError('Enter valid dates with the start date on or before the end date.'); return; }
    appliedRef.current = next; setApplied(next); setFilterError(null); resetPages(); void loadList();
  }
  function refreshList() { if (canRead() && !writeFlight.current) { resetPages(); void loadList(); } }
  function goPage(next: number) {
    if (!canRead() || writeFlight.current || reads.current.list || !list) return;
    if (next > pageRef.current) {
      if (!list.next_cursor) return;
      cursorsRef.current = [...cursorsRef.current.slice(0, next), list.next_cursor];
    }
    if (next < 0 || next >= cursorsRef.current.length) return;
    pageRef.current = next; setPage(next); void loadList(cursorsRef.current[next]);
  }
  function chooseAction(action: Action) {
    const current = detailRef.current?.reservation;
    if (!canRead() || propsRef.current.busy || writeFlight.current || attemptRef.current || actionRef.current ||
        !detailFresh.current || !current || !actionAllowed(current.status, action)) return;
    setMessage(null); setWriteError(null);
    putAction({ action, targetId: current.id, reference: current.reference, revision: current.revision, reason: '', reviewed: false });
  }
  async function reviewAction() {
    const draft = actionRef.current;
    if (!canRead() || propsRef.current.busy || !draft || attemptRef.current || writeFlight.current || reads.current.detail) return;
    const invalid = reasonError(draft);
    if (invalid) { setWriteError(invalid); return; }
    setWriteError(null);
    const current = await loadDetail(draft.targetId);
    if (!canRead() || actionRef.current !== draft || !current || attemptRef.current || writeFlight.current) return;
    if (current.reservation.revision !== draft.revision || !actionAllowed(current.reservation.status, draft.action)) {
      setWriteError('This reservation changed. Discard the draft and choose a new action from the refreshed record.'); return;
    }
    putAction({ ...draft, reviewed: true });
  }
  function confirmAction() {
    const draft = actionRef.current, current = detailRef.current?.reservation;
    if (!canRead() || propsRef.current.busy || !draft?.reviewed || !current || !detailFresh.current ||
        writeFlight.current || attemptRef.current || current.id !== draft.targetId ||
        current.revision !== draft.revision || !actionAllowed(current.status, draft.action) || reasonError(draft)) return;
    const reason = draft.reason.trim();
    const common = { restaurantId: propsRef.current.restaurantId, targetId: draft.targetId, reference: draft.reference, key: crypto.randomUUID() };
    const body = { expected_revision: draft.revision, ...(reason ? { reason } : {}) };
    const next: Attempt = draft.action === 'cancel'
      ? Object.freeze({ ...common, kind: 'cancel', body: Object.freeze(body) })
      : Object.freeze({ ...common, kind: 'decision', body: Object.freeze({ ...body, decision: draft.action }) });
    putAttempt(next); void sendAttempt(next);
  }
  function editSettings() {
    const current = settingsRef.current;
    if (!canRead() || propsRef.current.busy || writeFlight.current || attemptRef.current || settingsDraftRef.current || !settingsFresh.current || !current) return;
    setWriteError(null); setMessage(null);
    putSettingsDraft({ enabled: current.enabled, notice: current.notice ?? '', privacy: current.privacy_notice_version ?? '',
      basePrivacy: current.privacy_notice_version, revision: current.restaurant_revision, reviewed: false });
  }
  async function reviewSettings() {
    const draft = settingsDraftRef.current;
    if (!canRead() || propsRef.current.busy || !draft || attemptRef.current || writeFlight.current || reads.current.settings) return;
    setWriteError(null);
    const current = await loadSettings();
    if (!canRead() || settingsDraftRef.current !== draft || !current || attemptRef.current || writeFlight.current) return;
    const invalid = settingsDraftError(draft, current);
    if (invalid) { setWriteError(invalid); return; }
    if (draft.revision !== current.restaurant_revision) {
      setWriteError('The shared restaurant revision changed. Review the refreshed settings and explicitly use that revision before saving.'); return;
    }
    putSettingsDraft({ ...draft, reviewed: true });
  }
  function useSettingsRevision() {
    const draft = settingsDraftRef.current, current = settingsRef.current;
    if (!canRead() || propsRef.current.busy || writeFlight.current || attemptRef.current || !draft || !current || !settingsFresh.current) return;
    putSettingsDraft({ ...draft, revision: current.restaurant_revision, basePrivacy: current.privacy_notice_version, reviewed: false });
    setWriteError(null); setMessage('Refreshed restaurant revision selected. Review your draft again before saving.');
  }
  function confirmSettings() {
    const draft = settingsDraftRef.current, current = settingsRef.current;
    if (!canRead() || propsRef.current.busy || !draft?.reviewed || !current || !settingsFresh.current || attemptRef.current || writeFlight.current ||
        draft.revision !== current.restaurant_revision || settingsDraftError(draft, current)) return;
    const privacy = draft.privacy.trim();
    const body = Object.freeze({ enabled: draft.enabled, notice: draft.notice.trim() || null, expected_revision: draft.revision,
      ...(privacy && privacy !== draft.basePrivacy ? { privacy_notice_version: privacy } : {}) });
    const next: Attempt = Object.freeze({ kind: 'settings', restaurantId: propsRef.current.restaurantId, key: crypto.randomUUID(), body });
    putAttempt(next); void sendAttempt(next);
  }
  async function sendAttempt(target: Attempt) {
    if (!canRead() || propsRef.current.busy || writeFlight.current || attemptRef.current !== target || target.restaurantId !== propsRef.current.restaurantId) return;
    const flight = { controller: new AbortController(), epoch: epoch.current };
    writeFlight.current = flight;
    abortReads(); setListLoading(false); setDetailLoading(false); setSettingsLoading(false);
    setWriting(true); setWriteError(null); setMessage(null); setAttemptMessage('Sending the exact confirmed request…'); setAbandonReview(false);
    propsRef.current.onBusyChange(true);
    const isCurrent = () => canRead() && writeFlight.current === flight && epoch.current === flight.epoch && !flight.controller.signal.aborted;
    try {
      if (target.kind === 'settings') {
        const result = await reservationsClient.updateSettings(target.restaurantId, target.body, target.key, flight.controller.signal);
        if (!isCurrent()) return;
        settingsRef.current = result; settingsFresh.current = true; setSettings(result); setSettingsStale(false);
        propsRef.current.onSettingsSaved?.(result);
        putSettingsDraft(null); setMessage('Reservation settings saved.');
      } else {
        if (target.kind === 'decision') await reservationsClient.decide(target.restaurantId, target.targetId, target.body, target.key, flight.controller.signal);
        else await reservationsClient.cancel(target.restaurantId, target.targetId, target.body, target.key, flight.controller.signal);
        if (!isCurrent()) return;
        putAction(null); setMessage('The reservation update was acknowledged. Refreshing the current record.');
        void loadDetail(target.targetId);
      }
      putAttempt(null); setAttemptMessage(null);
      resetPages(); void loadList();
    } catch (error) {
      if (!isCurrent()) return;
      const explanation = reservationErrorMessage(error);
      setWriteError(explanation);
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && !uncertainAttempts.current.has(target)) {
        putAttempt(null); setAttemptMessage(null);
        if (target.kind === 'settings') {
          settingsFresh.current = false; setSettingsStale(true);
          if (settingsDraftRef.current) putSettingsDraft({ ...settingsDraftRef.current, reviewed: false });
        } else {
          detailFresh.current = false; setDetailStale(true);
          if (actionRef.current) putAction({ ...actionRef.current, reviewed: false });
        }
      } else {
        uncertainAttempts.current.add(target);
        setAttemptMessage('The original result is still unknown, even if a retry was rejected. The target, request body, and UUID remain frozen. Refresh to verify or explicitly abandon tracking after review.');
      }
    } finally {
      // 旧请求的 finally 不能释放暂停后新请求持有的全局锁。
      releaseWrite(flight);
    }
  }
  async function verifyAttempt() {
    const target = attemptRef.current;
    if (!canRead() || !target || writeFlight.current) return;
    const verificationEpoch = epoch.current;
    if (target.kind === 'settings') {
      const result = await loadSettings();
      if (!result || !canRead() || epoch.current !== verificationEpoch || attemptRef.current !== target) return;
      setAttemptMessage(`Current shared restaurant revision: ${result.restaurant_revision}. Compare it with request revision ${target.body.expected_revision}. A matching value does not prove which request changed it; tracking is still retained.`);
    } else {
      const result = await loadDetail(target.targetId);
      if (!result || !canRead() || epoch.current !== verificationEpoch || attemptRef.current !== target) return;
      setAttemptMessage(`Current status: ${statusLabels[result.reservation.status]}; revision: ${result.reservation.revision}. History cannot identify this UUID, so tracking is retained. Retry the same request or abandon tracking after review.`);
    }
    resetPages(); void loadList();
  }
  function abandonAttempt() {
    const target = attemptRef.current;
    if (!canRead() || !target || writeFlight.current || !abandonReview) return;
    if (target.kind === 'settings') { putSettingsDraft(null); settingsFresh.current = false; setSettingsStale(true); }
    else { putAction(null); detailFresh.current = false; setDetailStale(true); }
    putAttempt(null); setAttemptMessage(null); setAbandonReview(false); setWriteError(null);
    setMessage('Request tracking discarded. This does not undo a server-side change. Refresh before starting another operation.');
  }
  const readDisabled = !active || writing;
  const editDisabled = !active || busy || writing || !!attempt;
  const selectionDisabled = readDisabled || !!attempt || !!actionDraft;
  const actionMismatch = !!(actionDraft && detail && (actionDraft.targetId !== detail.reservation.id || actionDraft.revision !== detail.reservation.revision || !actionAllowed(detail.reservation.status, actionDraft.action)));
  const settingsMismatch = !!(settingsDraft && settings && settingsDraft.revision !== settings.restaurant_revision);
  const filterChanged = filters.status !== (applied.status ?? '') || filters.from !== (applied.from ?? '') || filters.to !== (applied.to ?? '');

  return <section className="ops-page rs-page" aria-label="Reservations">
    <header className="rs-header"><div><p className="rs-eyebrow">Guest requests</p><h1>Reservations</h1>
      <p>Review requests, stay in touch, and make every decision deliberately.</p></div>
      <button className="rs-button" type="button" disabled={readDisabled || listLoading} onClick={refreshList}>Refresh requests</button>
    </header>
    {!active && <div className="rs-notice" role="status">This page is paused. Drafts and unverified requests remain in memory; no writes will be replayed. Once your session is active, only the request list refreshes automatically.</div>}
    {message && <p className="rs-notice" role="status">{message}</p>}
    {writeError && <p className="rs-error" role="alert">{writeError}</p>}
    {attempt && <section className="rs-attempt" aria-labelledby={`${fieldId}-attempt`}>
      <div className="rs-section-heading"><h2 id={`${fieldId}-attempt`}>{writing ? 'Request in progress' : 'Unverified request'}</h2><span className="rs-status">{attempt.kind === 'settings' ? 'Settings' : attempt.reference}</span></div>
      <p role="status">{attemptMessage}</p>
      <dl className="rs-meta"><div><dt>Target</dt><dd>{attempt.kind === 'settings' ? 'Reservation settings' : attempt.targetId}</dd></div>
        <div><dt>Request UUID</dt><dd className="rs-code">{attempt.key}</dd></div></dl>
      <details className="rs-frozen-body"><summary>Inspect frozen request body</summary><pre>{JSON.stringify(attempt.body, null, 2)}</pre></details>
      {attempt.kind === 'settings' && <p className="rs-muted">Settings PATCH uses the shared restaurant revision, not server-side idempotent replay. An exact retry may return a revision conflict if the original save completed.</p>}
      <div className="rs-buttons"><button className="rs-button" type="button" disabled={readDisabled || detailLoading || settingsLoading} onClick={() => void verifyAttempt()}>Refresh to verify</button>
        <button className="rs-button rs-button-primary" type="button" disabled={!active || busy || writing || detailLoading || settingsLoading} onClick={() => void sendAttempt(attempt)}>Retry exact request</button>
        <button className="rs-button rs-button-text" type="button" disabled={readDisabled} onClick={() => setAbandonReview(true)}>Abandon tracking…</button></div>
      {abandonReview && <div className="rs-confirmation"><h3>Stop tracking this request?</h3><p>The server may already have applied it. This is not a cancellation or an undo. You must refresh before any new change.</p>
        <div className="rs-buttons"><button className="rs-button rs-button-primary" type="button" disabled={readDisabled} onClick={abandonAttempt}>Abandon request tracking</button>
          <button className="rs-button" type="button" disabled={readDisabled} onClick={() => setAbandonReview(false)}>Keep tracking</button></div></div>}
    </section>}
    <form className="rs-filters" onSubmit={event => { event.preventDefault(); applyFilters(); }}>
      <label htmlFor={`${fieldId}-status`}>Status<select id={`${fieldId}-status`} value={filters.status} disabled={readDisabled}
        onChange={event => setFilters({ ...filters, status: event.target.value as FilterDraft['status'] })}>
        <option value="">All statuses</option><option value="pending">Pending</option><option value="confirmed">Confirmed</option><option value="declined">Declined</option><option value="cancelled">Cancelled</option></select></label>
      <label htmlFor={`${fieldId}-from`}>Requested date · from<input id={`${fieldId}-from`} type="date" value={filters.from} disabled={readDisabled} onChange={event => setFilters({ ...filters, from: event.target.value })} /></label>
      <label htmlFor={`${fieldId}-to`}>Requested date · to<input id={`${fieldId}-to`} type="date" value={filters.to} disabled={readDisabled} onChange={event => setFilters({ ...filters, to: event.target.value })} /></label>
      <button className="rs-button rs-button-primary" type="submit" disabled={readDisabled}>Apply filters</button>
      <p className="rs-filter-help">Dates filter the stored local request date, not the date the request was created. Results are newest-created first.{filterChanged ? ' Changes are not applied yet.' : ''}</p>
      {filterError && <p className="rs-error" role="alert">{filterError}</p>}
    </form>
    <div className="rs-workspace">
      <section className="rs-requests" aria-labelledby={`${fieldId}-requests`} aria-busy={listLoading}>
        <div className="rs-section-heading"><h2 id={`${fieldId}-requests`}>Requests</h2><span className="rs-muted">{list ? `${list.items.length} on this page` : '20 per page'}</span></div>
        {listLoading ? <p className="rs-loading" role="status">Loading reservation requests…</p>
          : listError ? <div className="rs-empty"><p className="rs-error" role="alert">{listError}</p><button className="rs-button" type="button" disabled={readDisabled} onClick={() => void loadList(cursorsRef.current[pageRef.current])}>Retry loading</button></div>
          : list ? <ReservationsListView items={list.items} selectedId={selectedId} onSelect={selectRecord} disabled={selectionDisabled} />
          : <p className="rs-loading">{active ? 'Waiting for requests.' : 'Requests are paused.'}</p>}
        <nav className="rs-pagination" aria-label="Reservation pages"><button className="rs-button" type="button" disabled={readDisabled || listLoading || !list || page === 0} onClick={() => goPage(page - 1)}>Previous</button>
          <span>Page {page + 1}</span><button className="rs-button" type="button" disabled={readDisabled || listLoading || !list?.next_cursor} onClick={() => goPage(page + 1)}>Next</button></nav>
        {actionDraft && <p className="rs-muted rs-selection-note">Finish or discard the decision draft before selecting another request.</p>}
      </section>
      <section className="rs-detail" aria-labelledby={`${fieldId}-detail`} aria-busy={detailLoading}>
        <div className="rs-section-heading"><h2 id={`${fieldId}-detail`}>Request details</h2>{selectedId && <button className="rs-button rs-button-text" type="button" disabled={readDisabled || detailLoading} onClick={() => void loadDetail(selectedId)}>Refresh details</button>}</div>
        {detailLoading ? <p className="rs-loading" role="status">Loading current request details…</p>
          : detailError ? <div className="rs-empty"><p className="rs-error" role="alert">{detailError}</p><p>Use Refresh details to try again.</p></div>
          : detail ? <><ReservationDetailView detail={detail} />
            {detailStale && <p className="rs-notice">These details need to be refreshed before a new change.</p>}
            {!actionDraft && !attempt && <div className="rs-actions"><h4>Choose an action</h4>
              {detail.reservation.status === 'pending' ? <div className="rs-buttons">
                <button className="rs-button rs-button-primary" type="button" disabled={editDisabled || detailStale} onClick={() => chooseAction('confirm')}>Confirm</button>
                <button className="rs-button" type="button" disabled={editDisabled || detailStale} onClick={() => chooseAction('decline')}>Decline</button>
                <button className="rs-button" type="button" disabled={editDisabled || detailStale} onClick={() => chooseAction('cancel')}>Cancel reservation</button></div>
                : detail.reservation.status === 'confirmed' ? <button className="rs-button" type="button" disabled={editDisabled || detailStale} onClick={() => chooseAction('cancel')}>Cancel reservation</button>
                  : <p>This request is {statusLabels[detail.reservation.status].toLowerCase()}. No further decision is available.</p>}
            </div>}</>
            : <div className="rs-empty"><h3>Select a request</h3><p>Contact details, notes, and request history will appear here.</p></div>}
        {actionDraft && <section className="rs-editor" aria-labelledby={`${fieldId}-action`}>
          <h3 id={`${fieldId}-action`}>{actionLabels[actionDraft.action]}</h3><p>{actionDraft.reference} · expected revision {actionDraft.revision}</p>
          <label htmlFor={`${fieldId}-reason`}>Reason{actionDraft.action === 'decline' ? ' (required)' : ' (optional)'}<textarea id={`${fieldId}-reason`} rows={3} value={actionDraft.reason}
            disabled={editDisabled || detailLoading || actionDraft.reviewed} onChange={event => putAction({ ...actionDraft, reason: event.target.value, reviewed: false })} /></label>
          <p className="rs-muted">Up to 500 characters. The reason may be visible to the guest.</p>
          {actionMismatch && <p className="rs-error">The current record differs from this draft. Discard it and choose a new action.</p>}
          {actionDraft.reviewed && <div className="rs-confirmation"><h4>Confirm this change</h4><p>{actionLabels[actionDraft.action]} for {actionDraft.reference}, using revision {actionDraft.revision}?</p>
            <p className="rs-reason-preview">{actionDraft.reason.trim() || 'No reason will be sent.'}</p>
            <div className="rs-buttons"><button className="rs-button rs-button-primary" type="button" disabled={editDisabled || detailLoading || detailStale || actionMismatch} onClick={confirmAction}>Yes, {actionDraft.action} reservation</button>
              <button className="rs-button" type="button" disabled={editDisabled || detailLoading} onClick={() => putAction({ ...actionDraft, reviewed: false })}>Back to editing</button></div></div>}
          {!actionDraft.reviewed && <button className="rs-button rs-button-primary" type="button" disabled={editDisabled || detailLoading || actionMismatch} onClick={() => void reviewAction()}>Review decision</button>}
          <button className="rs-button rs-button-text" type="button" disabled={editDisabled || detailLoading} onClick={() => { putAction(null); setWriteError(null); }}>Discard decision draft</button>
        </section>}
      </section>
    </div>
    <details className="rs-settings" onToggle={event => {
      if (event.currentTarget.open && !settingsRef.current && !reads.current.settings && canRead() && !writeFlight.current) void loadSettings();
    }}><summary><span>Reservation request settings</span><span className="rs-muted">Availability & guest notice</span></summary>
      <div className="rs-settings-body"><div className="rs-section-heading"><h2>Request settings</h2><button className="rs-button" type="button" disabled={readDisabled || settingsLoading} onClick={() => void loadSettings()}>Refresh settings</button></div>
        <p className="rs-muted">These settings share the restaurant revision with restaurant details and opening hours. Timezone and hours are managed on those pages.</p>
        {settingsLoading && <p className="rs-loading" role="status">Loading current settings…</p>}
        {settingsError && <p className="rs-error" role="alert">{settingsError}</p>}
        {settings && <><dl className="rs-settings-meta"><div><dt>Guest requests</dt><dd>{settings.enabled ? 'Enabled' : 'Disabled'}</dd></div><div><dt>Timezone</dt><dd>{settings.timezone ?? 'Not configured'}</dd></div>
          <div><dt>Privacy notice version</dt><dd>{settings.privacy_notice_version ?? 'Not configured'}</dd></div><div><dt>Restaurant revision</dt><dd>{settings.restaurant_revision}</dd></div></dl>
          <section className="rs-note"><h4>Guest notice</h4><p>{settings.notice || 'No notice configured.'}</p></section>
          <details className="rs-hours"><summary>Opening-hours request availability</summary>
            {settings.intervals.length ? <ul>{settings.intervals.map((interval, index) => <li key={index}><span>{weekdays[interval.weekday - 1]} · {interval.opens_at_local}–{interval.closes_at_local}{interval.closes_day_offset ? ' (next day)' : ''}</span><span>{interval.accepts_requests ? 'Accepts requests' : 'Does not accept requests'}</span></li>)}</ul> : <p>No opening hours configured.</p>}
          </details>
          {settingsStale && <p className="rs-notice">Refresh settings before editing or reviewing a save.</p>}
          {!settingsDraft && <button className="rs-button" type="button" disabled={editDisabled || settingsLoading || settingsStale} onClick={editSettings}>Edit request settings</button>}
        </>}
        {settingsDraft && <section className="rs-editor"><h3>Edit request settings</h3>
          <label className="rs-checkbox"><input type="checkbox" checked={settingsDraft.enabled} disabled={editDisabled || settingsLoading || settingsDraft.reviewed} onChange={event => putSettingsDraft({ ...settingsDraft, enabled: event.target.checked, reviewed: false })} />Accept guest reservation requests</label>
          <label htmlFor={`${fieldId}-notice`}>Guest notice<textarea id={`${fieldId}-notice`} rows={4} value={settingsDraft.notice} disabled={editDisabled || settingsLoading || settingsDraft.reviewed} onChange={event => putSettingsDraft({ ...settingsDraft, notice: event.target.value, reviewed: false })} /></label>
          <p className="rs-muted">Up to 2,000 characters. Saving an empty notice removes it.</p>
          <label htmlFor={`${fieldId}-privacy`}>Privacy notice version<input id={`${fieldId}-privacy`} type="text" value={settingsDraft.privacy} disabled={editDisabled || settingsLoading || settingsDraft.reviewed} onChange={event => putSettingsDraft({ ...settingsDraft, privacy: event.target.value, reviewed: false })} /></label>
          <p className="rs-muted">Up to 64 characters. Required to enable requests. An existing version cannot be cleared here.</p>
          {settingsMismatch && <div className="rs-notice"><p>Your draft uses restaurant revision {settingsDraft.revision}; refreshed settings use {settings?.restaurant_revision}. Your edits have been kept.</p>
            <button className="rs-button" type="button" disabled={editDisabled || settingsLoading || settingsStale} onClick={useSettingsRevision}>Use refreshed revision, keep draft</button></div>}
          {settingsDraft.reviewed && <div className="rs-confirmation"><h4>Save these settings?</h4><p>Requests will be {settingsDraft.enabled ? 'enabled' : 'disabled'}. Restaurant revision {settingsDraft.revision} will be used.</p>
            <div className="rs-buttons"><button className="rs-button rs-button-primary" type="button" disabled={editDisabled || settingsLoading || settingsStale || settingsMismatch} onClick={confirmSettings}>Yes, save request settings</button>
              <button className="rs-button" type="button" disabled={editDisabled || settingsLoading} onClick={() => putSettingsDraft({ ...settingsDraft, reviewed: false })}>Back to editing</button></div></div>}
          <div className="rs-buttons">{!settingsDraft.reviewed && <button className="rs-button rs-button-primary" type="button" disabled={editDisabled || settingsLoading || settingsMismatch} onClick={() => void reviewSettings()}>Review settings save</button>}
            <button className="rs-button rs-button-text" type="button" disabled={editDisabled || settingsLoading} onClick={() => { putSettingsDraft(null); setWriteError(null); }}>Discard settings draft</button></div>
        </section>}
      </div>
    </details>
    <p className="rs-mail-note">Reservation updates can queue an email when a guest email address is available. Queued does not mean delivered; this page does not verify delivery.</p>
  </section>;
}
