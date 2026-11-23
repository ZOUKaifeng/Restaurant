import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api';
import RestaurantWorkspace from './RestaurantWorkspace';
import ReservationsPage from './ReservationsPage';
import AnalyticsPage from './AnalyticsPage';
import type { CurrentUser, Restaurant, RestaurantCreateInput, RestaurantList } from './types';
import { ActionFeedback, ErrorNotice, fieldLabels, LocaleSelect, useAction } from './ui';
import './dashboard.css';

const restaurantStatusLabels: Record<Restaurant['status'], string> = {
  draft: 'Restaurant draft', active: 'Active', suspended: 'Suspended', archived: 'Archived',
};

interface CreateAttempt { key: string; body: RestaurantCreateInput }
function CreateRestaurant({ locales, busy, onBusyChange, onDirtyChange, onCreated }: {
  locales: string[]; busy: boolean; onBusyChange: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void; onCreated: (restaurant: Restaurant) => void;
}) {
  const attempt = useRef<CreateAttempt | null>(null);
  const [name, setName] = useState('');
  const [hasAttempt, setHasAttempt] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const action = useAction(onBusyChange);
  const [languageChanged, setLanguageChanged] = useState(false);
  useEffect(() => { onDirtyChange(Boolean(name.trim()) || hasAttempt || languageChanged); }, [name, hasAttempt, languageChanged, onDirtyChange]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || action.pending) return;
    const form = event.currentTarget;
    if (!attempt.current) {
      const values = new FormData(form);
      attempt.current = {
        key: crypto.randomUUID(),
        body: { name: String(values.get('name') ?? '').trim(), primary_locale: String(values.get('primary_locale') ?? '') },
      };
      setHasAttempt(true);
    }
    const request = attempt.current;
    void action.run(async () => {
      const { data } = await api.createRestaurant(request.body, request.key);
      attempt.current = null;
      setHasAttempt(false);
      setConfirmNew(false);
      setName('');
      setLanguageChanged(false);
      form.reset();
      onCreated(data);
    });
  }
  function newRequest() {
    setName(attempt.current?.body.name ?? name);
    attempt.current = null;
    setHasAttempt(false);
    setConfirmNew(false);
    action.clear();
  }
  return <section className="create-panel dashboard-create-panel" aria-labelledby="create-title">
    <p className="eyebrow">Restaurant draft</p>
    <h2 id="create-title">Start with the essentials.</h2>
    <p className="muted">Add your restaurant name and primary language. You can complete the details in the workspace afterward.</p>
    <form onSubmit={submit} aria-busy={action.pending} onChange={(event) => {
      const target = event.target as EventTarget;
      if ((target instanceof HTMLInputElement || target instanceof HTMLSelectElement) && target.name === 'primary_locale') setLanguageChanged(true);
    }}>
      <fieldset disabled={busy || action.pending}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="create-name">Restaurant name</label>
            <input id="create-name" name="name" required maxLength={150} pattern=".*\S.*" value={attempt.current?.body.name ?? name} onChange={(event) => setName(event.target.value)} readOnly={hasAttempt} autoComplete="organization" />
          </div>
          <div className="field">
            <label htmlFor="create-locale">Primary language</label>
            {hasAttempt ? <><input id="create-locale" value={attempt.current?.body.primary_locale ?? ''} readOnly /><input type="hidden" name="primary_locale" value={attempt.current?.body.primary_locale ?? ''} /></>
              : locales.length > 0 ? <LocaleSelect id="create-locale" name="primary_locale" defaultValue="en" locales={locales} />
              : <input id="create-locale" name="primary_locale" defaultValue="en" required minLength={2} maxLength={35} pattern="[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*" aria-describedby="create-locale-help" />}
            {locales.length === 0 && <p className="micro" id="create-locale-help">Enter a language code. The server will check whether it is supported.</p>}
          </div>
        </div>
        <button type="submit" className="primary-button">{action.pending ? 'Creating restaurant…' : hasAttempt ? 'Retry the same request' : 'Create restaurant'}</button>
      </fieldset>
    </form>
    <ActionFeedback action={action} />
    {hasAttempt && !action.pending && <div className="notice">
      <p>The result is not confirmed. Your original inputs and request key are kept in this page. Retrying uses the same key and the same inputs.</p>
      <p>Go back to restaurants and refresh the list before starting another request. A timeout does not mean creation failed. Returning to the list keeps this request; reloading or leaving this page loses it.</p>
      <button type="button" className="text-button" disabled={busy} onClick={() => setConfirmNew(true)}>Start a different request…</button>
    </div>}
    {confirmNew && <section className="notice" aria-labelledby="new-request-title">
      <h3 id="new-request-title">Have you checked the restaurant list?</h3>
      <p>The original request may already have created a restaurant. A new key is not a retry: it can create a duplicate restaurant and repeat any applicable charges.</p>
      <div className="button-row">
        <button type="button" disabled={busy} onClick={newRequest}>I checked — discard the old key</button>
        <button type="button" className="text-button" disabled={busy} onClick={() => setConfirmNew(false)}>Keep the original request</button>
      </div>
    </section>}
  </section>;
}

export type WorkspaceMode = 'restaurants' | 'reservations' | 'analytics';
export default function Dashboard({ user, locales, mode = 'restaurants', routePath = '/app', active = true, busy, onBusyChange, onDirtyChange, headerTarget = null }: {
  user: CurrentUser; locales: string[]; mode?: WorkspaceMode; routePath?: string; active?: boolean; busy: boolean; onBusyChange: (busy: boolean) => void;
  headerTarget?: HTMLElement | null;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [list, setList] = useState<RestaurantList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [retryMore, setRetryMore] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [createDirty, setCreateDirty] = useState(false);
  useEffect(() => { onDirtyChange(dirty || createDirty); }, [dirty, createDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const [nextSelection, setNextSelection] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  // Read-only list requests must not acquire or release a write lock in another page.
  const listAction = useAction();
  const selecting = !selected && !creating;
  const headerInTopbar = mode === 'restaurants' && !!selected && !creating && !!headerTarget;
  const listPending = loading || listAction.pending;
  const title = mode === 'reservations' ? 'Reservations' : mode === 'analytics' ? 'Analytics' : 'My restaurants';
  const scope = useRef({ active, userId: user.id });
  scope.current = { active, userId: user.id };
  const listFlight = useRef<AbortController | null>(null);
  const pageRoot = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!active) { listFlight.current?.abort(); return; }
    const controller = new AbortController();
    listFlight.current = controller;
    setLoading(true);
    void api.restaurants(undefined, controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      setList(data);
      setLoading(false);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setLoadError(error);
      setLoading(false);
    });
    return () => controller.abort();
  }, [user.id, active]);
  useEffect(() => () => listFlight.current?.abort(), []);

  useEffect(() => {
    const target = pageRoot.current?.querySelector<HTMLElement>('h1');
    if (active && target) { target.tabIndex = -1; target.focus({ preventScroll: true }); }
  }, [selected, creating, mode, active, headerInTopbar]);
  useEffect(() => {
    setDirty(false); setCreateDirty(false); setNextSelection(null);
    if (mode !== 'restaurants') setCreating(false);
  }, [mode, routePath]);

  function loadList(more = false) {
    if (busy || loading || listAction.pending) return;
    setRetryMore(more);
    void listAction.run(async () => {
      listFlight.current?.abort();
      const controller = new AbortController();
      listFlight.current = controller;
      const userId = user.id;
      const data = await api.restaurants(more && list?.next_cursor ? list.next_cursor : undefined, controller.signal);
      if (controller.signal.aborted || !scope.current.active || scope.current.userId !== userId) return;
      setList((current) => more && current ? {
        ...data, items: [...current.items, ...data.items.filter((item) => !current.items.some((existing) => existing.id === item.id))],
      } : data);
      setLoadError(null);
    });
  }
  function applySelection(value: string) {
    setCreating(value === 'create');
    setSelected(value === 'create' || value === 'selector' ? null : value);
    setNextSelection(null);
    setDirty(false);
    setNotice('');
  }
  function choose(value: string) {
    if (!active || busy || (selected === value && !creating) || (value === 'create' && creating) || (value === 'selector' && selecting)) return;
    if (dirty) setNextSelection(value);
    else applySelection(value);
  }
  function updated(restaurant: Restaurant) {
    setList((current) => current ? { ...current, items: current.items.map((item) => item.id === restaurant.id ? restaurant : item) } : current);
  }
  function created(restaurant: Restaurant) {
    setList((current) => current ? { ...current, items: [restaurant, ...current.items.filter((item) => item.id !== restaurant.id)] } : { items: [restaurant], next_cursor: null, has_more: false });
    setCreating(false);
    setSelected(restaurant.id);
    setDirty(false);
    setNotice('Restaurant created, or the result of the same request recovered. Review its details in the workspace.');
  }

  return <section ref={pageRoot} className={`dashboard table-folk-dashboard${mode === 'restaurants' && selected && !creating ? ' dashboard-selected-workspace' : ''}`} aria-labelledby={selecting || creating ? 'dashboard-title' : undefined} aria-label={!selecting && !creating ? mode === 'restaurants' ? 'Restaurant workspace' : title : undefined}>
    {headerInTopbar && active && createPortal(<div className="restaurant-topbar">
      <button type="button" className="text-button" disabled={busy} onClick={() => choose('selector')}>← Back to restaurants</button>
    </div>, headerTarget!)}
    {headerInTopbar && <h1 className="workspace-title" tabIndex={-1}>{list?.items.find(item => item.id === selected)?.name ?? 'Restaurant'}</h1>}
    {!selecting && !headerInTopbar && <button type="button" className="text-button dashboard-back" disabled={busy} onClick={() => choose('selector')}>← Back to restaurants</button>}
    {(selecting || creating) && <header className="dashboard-page-heading">
      <div>
        <p className="eyebrow">{selecting ? 'Your restaurant workspace' : 'New restaurant'}</p>
        <h1 id="dashboard-title" ref={heading} tabIndex={-1}>{selecting ? title : 'Create restaurant'}</h1>
        <p className="muted">{selecting ? mode === 'reservations' ? 'Choose a restaurant to review and manage its reservation requests.' : mode === 'analytics' ? 'Choose a restaurant to view its website activity and reservation metrics.' : 'Choose a restaurant to manage its details, menu and website.' : 'A name and a language are all you need to get started.'}</p>
      </div>
      {selecting && <div className="dashboard-heading-actions">
        <button type="button" className="dashboard-refresh" disabled={busy || listPending} onClick={() => loadList()}>{listAction.pending ? 'Loading…' : 'Refresh'}</button>
        {mode === 'restaurants' && <button type="button" className="primary-button" disabled={busy || loading || !list} onClick={() => choose('create')}>Create restaurant</button>}
      </div>}
    </header>}
    {mode !== 'restaurants' && selected && !creating && <div className="operations-restaurant-selector">
      <label htmlFor="operations-restaurant">Restaurant</label>
      <select id="operations-restaurant" value={selected} disabled={busy || !active} onChange={event => choose(event.target.value)}>
        {list?.items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        {!list?.items.some(item => item.id === selected) && <option value={selected}>Selected restaurant</option>}
      </select>
      {list?.has_more && <span className="micro">Back to restaurants to load more.</span>}
    </div>}

    {nextSelection && <section className="notice dashboard-switch-confirmation" aria-labelledby="switch-title">
      <h2 id="switch-title">Discard unsaved changes?</h2>
      <p>{nextSelection === 'selector' ? 'Returning to the restaurant list will discard your unsaved changes. Nothing will be saved automatically.' : 'Switching will discard your unsaved changes. Nothing will be saved automatically.'}</p>
      <div className="button-row">
        <button type="button" disabled={busy} onClick={() => applySelection(nextSelection)}>{nextSelection === 'selector' ? 'Discard and return to restaurants' : 'Discard and continue'}</button>
        <button type="button" className="text-button" disabled={busy} onClick={() => setNextSelection(null)}>Keep editing</button>
      </div>
    </section>}
    {notice && <p className="notice" role="status">{notice}</p>}

    <section className="dashboard-selector" hidden={!selecting} aria-label="Restaurant selector" aria-busy={listPending}>
      {list && <div className="dashboard-list-summary">
        <p><strong>{list.items.length}</strong> loaded restaurants</p>
        {list.has_more && <p className="micro">More restaurants can be loaded.</p>}
      </div>}
      {!listAction.pending && !listAction.error && <ErrorNotice error={loadError} />}
      <ActionFeedback action={listAction} />
      {!listPending && Boolean(loadError || listAction.error) && <button type="button" className="dashboard-retry" disabled={busy} onClick={() => loadList(retryMore)}>{retryMore ? 'Retry loading more restaurants' : 'Retry loading restaurants'}</button>}
      {listPending && !list && <div className="dashboard-loading" role="status">
        <p className="micro">Loading your restaurants…</p>
        <div className="restaurant-cards" aria-hidden="true">{[0, 1, 2].map((index) => <div className="restaurant-card restaurant-skeleton" key={index}><div className="dashboard-skeleton-line short" /><div className="dashboard-skeleton-line" /><div className="dashboard-skeleton-line medium" /><div className="dashboard-skeleton-line" /></div>)}</div>
      </div>}
      {list?.items.length === 0 && <div className="dashboard-empty">
        <div className="dashboard-empty-mark" aria-hidden="true">+</div>
        <h2>Your first restaurant starts here.</h2>
        <p>Add a name and primary language, then complete the details at your own pace.</p>
        {mode === 'restaurants' && <button type="button" className="primary-button" disabled={busy || listPending} onClick={() => choose('create')}>Create restaurant</button>}
      </div>}
      {list && list.items.length > 0 && <ul className="restaurant-cards">{list.items.map((restaurant) => <li key={restaurant.id}>
        <article className="restaurant-card" aria-labelledby={`restaurant-name-${restaurant.id}`}>
          <div className="restaurant-card-top">
            <span className="restaurant-status">{restaurantStatusLabels[restaurant.status]}</span>
            <span className="restaurant-requests">{restaurant.reservation_enabled ? 'Requests enabled' : 'Requests disabled'}</span>
          </div>
          <h2 id={`restaurant-name-${restaurant.id}`}>{restaurant.name}</h2>
          {restaurant.cuisine_label && <p className="restaurant-cuisine">{restaurant.cuisine_label}</p>}
          <dl className="restaurant-card-details">
            {[restaurant.city, restaurant.region, restaurant.country_code].some(Boolean) && <div><dt>Location</dt><dd>{[restaurant.city, restaurant.region, restaurant.country_code].filter(Boolean).join(', ')}</dd></div>}
            <div><dt>Primary language</dt><dd>{restaurant.primary_locale}</dd></div>
            {restaurant.contact_email && <div><dt>Contact email</dt><dd>{restaurant.contact_email}</dd></div>}
          </dl>
          <div className="restaurant-card-readiness">
            {restaurant.readiness.missing_fields.length > 0 ? <>
              <p className="restaurant-readiness-label">Details to add</p>
              <p>{restaurant.readiness.missing_fields.map((field) => Object.hasOwn(fieldLabels, field) ? fieldLabels[field] : field.replace(/[_.]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())).join(' · ')}</p>
            </> : <p>No missing fields reported by the server.</p>}
          </div>
          <button type="button" className="restaurant-open" aria-label={`Open ${mode === 'restaurants' ? 'workspace' : mode} for ${restaurant.name}`} disabled={busy} onClick={() => choose(restaurant.id)}>{mode === 'reservations' ? 'View reservations' : mode === 'analytics' ? 'View analytics' : 'Open workspace'} <span aria-hidden="true">↗</span></button>
        </article>
      </li>)}</ul>}
      {list?.has_more && list.next_cursor && <div className="dashboard-list-footer">
        <p className="micro">Showing the restaurants loaded so far.</p>
        <button type="button" disabled={busy || listPending} onClick={() => loadList(true)}>Load more restaurants</button>
      </div>}
    </section>

    {mode === 'restaurants' && <div className="dashboard-content" hidden={!creating}><CreateRestaurant key={routePath} locales={locales} busy={busy} onBusyChange={onBusyChange} onDirtyChange={setCreateDirty} onCreated={created} /></div>}
    {!creating && selected && <div className="dashboard-content dashboard-workspace">
      {mode === 'restaurants' ? <RestaurantWorkspace key={`workspace-${routePath}-${selected}`} id={selected} headerInTopbar={headerInTopbar} active={active} locales={locales} busy={busy} onBusyChange={onBusyChange} onDirtyChange={setDirty} onUpdated={updated} />
        : mode === 'reservations' ? <ReservationsPage key={`reservations-${selected}`} restaurantId={selected} active={active} busy={busy} onBusyChange={onBusyChange} onDirtyChange={setDirty} onSettingsSaved={settings => {
          setList(current => current ? { ...current, items: current.items.map(item => item.id === selected && item.revision <= settings.restaurant_revision
            ? { ...item, reservation_enabled: settings.enabled, revision: settings.restaurant_revision } : item) } : current);
        }} />
        : <AnalyticsPage key={`analytics-${selected}`} restaurantId={selected} active={active} busy={busy} />}
    </div>}
  </section>;
}
