import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, onSessionExpired } from './api';
import { isWebsiteWriteUncertain, safeLocalPublicationUrl } from './website-api';
import { validateContentInput, websiteContentClient } from './website-content-client';
import WebsiteContentPanel, { contentDraft } from './WebsiteContentPanel';
import type { WebsiteContentDraft } from './WebsiteContentPanel';
import type { WebsiteContentDifference, WebsiteContentReview, WebsiteContentVersion, WebsiteEditableContent, WebsiteWorkbenchReport, WebsiteContentPreviewInput } from './website-types';
import './website-workbench.css';

const blockerLabels: Record<string, string> = {
  WEBSITE_BASE_REQUIRED: 'Create a design before updating website content.',
  WEBSITE_SOURCE_MISSING: 'This version has no editable source. You can preview it or create a new design.',
  WEBSITE_SOURCE_INCOMPATIBLE: 'This source cannot be refreshed safely. You can preview it or create a new design.',
  RESTAURANT_UNAVAILABLE: 'This restaurant cannot be edited.', WEBSITE_JOB_BUSY: 'A design job is running. Content is read-only until it finishes.',
  MENU_JOB_BUSY: 'Menu recognition is running. Content is read-only until it finishes.',
};
export function contentChanges(report: WebsiteWorkbenchReport, draft: WebsiteContentDraft, review: boolean): WebsiteContentPreviewInput {
  if (!report.editing_version || report.editing_version.source_status !== 'available') throw new ApiError(409, 'WEBSITE_SOURCE_MISSING');
  const patch = Object.fromEntries(Object.entries(draft.restaurant).filter(([key, value]) => value !== report.content.restaurant[key as keyof typeof draft.restaurant]));
  const changedMenu = JSON.stringify(draft.menu) !== JSON.stringify(report.content.menu.data) || report.content.menu.status === 'draft' || report.blockers.includes('MENU_UNCONFIRMED');
  return validateContentInput({ base_version_id: report.editing_version.id, expected_restaurant_revision: report.content.restaurant_revision,
    expected_menu_revision: report.content.menu.revision, expected_public_content_hash: report.current_public_content_hash,
    expected_publication_revision: report.publication.revision, ...(Object.keys(patch).length ? { restaurant_patch: patch } : {}),
    ...(JSON.stringify(draft.opening_hours) !== JSON.stringify(report.content.opening_hours) ? { opening_hours: draft.opening_hours } : {}),
    ...(changedMenu ? { menu_data: draft.menu, menu_review_confirmed: review } : {}) });
}
function errorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Request did not complete. Check the saved result before trying again.';
  if (error.status === 401) return 'Session expired. Sign in again; no request will be replayed.';
  if (error.status === 422) return 'Check the fields, hours, and menu confirmation. Nothing was automatically retried.';
  if (error.code === 'RESPONSE_INVALID') return 'The response failed validation. Check result; do not start a replacement request.';
  if (blockerLabels[error.code]) return blockerLabels[error.code];
  if (error.status === 409 || error.status === 412 || error.status === 428) return 'The saved content or publication changed. Your input is retained. Discard and reload before starting a new save.';
  return 'Could not confirm the result. Check result / Retry same request.';
}
const differenceLabels: Record<WebsiteContentDifference['field'], string> = {
  name: 'Restaurant name', description: 'Description', cuisine: 'Cuisine', address: 'Address', contact: 'Contact',
  timezone: 'Time zone', locale: 'Language', currency: 'Currency', hours: 'Opening hours', menu: 'Menu', reservation: 'Reservation rules',
};
export function WebsiteDifferences({ differences, beforeLabel = 'Before', afterLabel = 'After' }: {
  differences: WebsiteContentDifference[]; beforeLabel?: string; afterLabel?: string;
}) {
  return <>{differences.map((difference, index) => <div className="wb-difference" key={index}><h4>{differenceLabels[difference.field]}</h4><div className="wb-difference-values"><div><p className="wb-small">{beforeLabel}</p><pre>{difference.before}</pre></div><div><p className="wb-small">{afterLabel}</p><pre>{difference.after}</pre></div></div></div>)}</>;
}
export function savedContentReview(report: WebsiteWorkbenchReport): WebsiteContentReview | null {
  const version = report.editing_version;
  if (!version || version.origin !== 'content_refresh' || !version.base_version_id || !version.public_content_hash
    || version.id === report.publication.published_version_id || !report.saved_differences?.length) return null;
  return { restaurant_id: report.restaurant_id, version_id: version.id, version_number: version.version_number,
    base_version_id: version.base_version_id, checksum: version.checksum, public_content_hash: version.public_content_hash,
    differences: structuredClone(report.saved_differences) };
}
export function WebsiteContentReviewPanel({ review }: { review: WebsiteContentReview }) {
  return <section className="wb-content-review" aria-label="Saved content changes" data-candidate-id={review.version_id}>
    <h3>Content changes</h3><p className="wb-small">Design unchanged / No AI</p>
    <p className="wb-small">Saved candidate v{review.version_number} · Preview ID: {review.version_id}<br />Compared with base version: {review.base_version_id}. These are saved content changes from the base version to this candidate, not current unsaved edits or a comparison with the published website.</p>
    <WebsiteDifferences differences={review.differences} />
  </section>;
}
export default function WebsiteWorkbench({ restaurantId, active, busy, restaurantDirty, selectedId, previewVersion, refreshToken, design, preview, status, publication,
  onPreview, onReport, onSaved, onContentReview, onDirtyChange, onBusyChange }: {
  restaurantId: string; active: boolean; busy: boolean; restaurantDirty: boolean; selectedId: string | null; previewVersion?: { id: string; version_number: number }; refreshToken: string;
  design: ReactNode; preview: ReactNode; status: ReactNode; publication: ReactNode;
  onPreview: (version: WebsiteContentVersion) => void; onReport: (report: WebsiteWorkbenchReport | null) => void;
  onSaved?: (content: WebsiteEditableContent) => void | Promise<void>; onContentReview?: (review: WebsiteContentReview | null) => void;
  onDirtyChange: (value: boolean) => void; onBusyChange: (value: boolean) => void;
}) {
  const [report, setReport] = useState<WebsiteWorkbenchReport | null>(null);
  const [baseline, setBaseline] = useState<WebsiteWorkbenchReport | null>(null);
  const [draft, setDraft] = useState<WebsiteContentDraft | null>(null);
  const [editor, setEditor] = useState<'content' | 'design'>('design');
  const [mobile, setMobile] = useState<'editor' | 'preview'>('preview');
  const [history, setHistory] = useState(false);
  const [versions, setVersions] = useState<WebsiteContentVersion[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [historyPending, setHistoryPending] = useState(false);
  const [readPending, setReadPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [review, setReview] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [historyError, setHistoryError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saveReview, setSaveReview] = useState<WebsiteContentReview | null>(null);
  const saveReviewRef = useRef(saveReview); saveReviewRef.current = saveReview;
  const [reload, setReload] = useState(0);
  const [expired, setExpired] = useState(false);
  const [attempt, setAttempt] = useState<{ restaurantId: string; key: string; body: WebsiteContentPreviewInput } | null>(null);
  const readFlight = useRef<AbortController | null>(null), writeFlight = useRef<AbortController | null>(null), historyFlight = useRef<AbortController | null>(null);
  const pinned = useRef<string | undefined>(selectedId ?? undefined), observedSelection = useRef(selectedId), initialized = useRef(false), epoch = useRef(0);
  const dirtyRef = useRef(false), draftRef = useRef(draft), attemptRef = useRef(attempt), syncRequired = useRef(false);
  const context = useRef({ restaurantId, active, expired }); context.current = { restaurantId, active, expired };
  const callbacks = useRef({ onPreview, onReport, onSaved, onContentReview, onDirtyChange, onBusyChange }); callbacks.current = { onPreview, onReport, onSaved, onContentReview, onDirtyChange, onBusyChange };
  draftRef.current = draft; attemptRef.current = attempt;
  const dirty = !!draft && !!baseline && JSON.stringify(draft) !== JSON.stringify(contentDraft(baseline.content));
  dirtyRef.current = dirty || !!attempt;
  function updateSaveReview(next: WebsiteContentReview | null) {
    saveReviewRef.current = next; setSaveReview(next); callbacks.current.onContentReview?.(next ? structuredClone(next) : null);
  }
  useEffect(() => { callbacks.current.onDirtyChange(dirty || !!attempt); }, [dirty, attempt]);
  useEffect(() => {
    epoch.current += 1;
    return () => {
      epoch.current += 1;
      readFlight.current?.abort(); readFlight.current = null;
      writeFlight.current?.abort(); writeFlight.current = null;
      historyFlight.current?.abort(); historyFlight.current = null;
      callbacks.current.onBusyChange(false);
    };
  }, [restaurantId, active]);
  useEffect(() => {
    pinned.current = selectedId ?? undefined; observedSelection.current = selectedId; initialized.current = false; syncRequired.current = false;
    attemptRef.current = null; dirtyRef.current = false; updateSaveReview(null);
    setReport(null); setBaseline(null); setDraft(null); setAttempt(null); setVersions([]); setCursor(null); setNotice(''); setWarnings([]); setError(null); setReadError(null);
    setReview(false); setSaving(false); setHistoryPending(false); setHistory(false);
    callbacks.current.onReport(null);
  }, [restaurantId]);
  useEffect(() => onSessionExpired(() => {
    epoch.current += 1; readFlight.current?.abort(); writeFlight.current?.abort(); historyFlight.current?.abort();
    context.current.expired = true; syncRequired.current = false; attemptRef.current = null; dirtyRef.current = false; updateSaveReview(null);
    setExpired(true); setReport(null); setBaseline(null); setDraft(null); setAttempt(null); setVersions([]); setWarnings([]); setNotice('');
    callbacks.current.onReport(null); callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false);
  }), []);
  useEffect(() => {
    if (selectedId !== observedSelection.current) {
      observedSelection.current = selectedId; pinned.current = selectedId ?? undefined;
      if (saveReviewRef.current && saveReviewRef.current.version_id !== selectedId) updateSaveReview(null);
    }
    if (!active || expired) { setSaving(false); setReadPending(false); setHistoryPending(false); return; }
    if (writeFlight.current) return;
    const controller = new AbortController(); readFlight.current = controller;
    const currentEpoch = epoch.current;
    setReadPending(true); setReadError(null);
    void (async () => {
      const next = await websiteContentClient.workbench(restaurantId, pinned.current, controller.signal);
      if (controller.signal.aborted || currentEpoch !== epoch.current || !context.current.active || context.current.expired) return;
      pinned.current = next.editing_version?.id; setReport(next); callbacks.current.onReport(next);
      const savedReview = saveReviewRef.current;
      if (savedReview && (next.editing_version?.id !== savedReview.version_id || next.editing_version.checksum !== savedReview.checksum || next.editing_version.public_content_hash !== savedReview.public_content_hash || next.publication.published_version_id === savedReview.version_id)) updateSaveReview(null);
      if (!saveReviewRef.current && !attemptRef.current) {
        const restored = savedContentReview(next);
        if (restored) updateSaveReview(restored);
      }
      if (!dirtyRef.current) { setBaseline(next); setDraft(contentDraft(next.content)); setReview(false); }
      if (!initialized.current) {
        initialized.current = true; setEditor(next.latest_version ? 'content' : 'design');
        if (!next.latest_version) setMobile('editor');
        if (next.editing_version) callbacks.current.onPreview(next.editing_version);
      }
      if (syncRequired.current) {
        await callbacks.current.onSaved?.(next.content);
        if (!controller.signal.aborted && currentEpoch === epoch.current) syncRequired.current = false;
      }
    })().catch(caught => { if (!controller.signal.aborted && currentEpoch === epoch.current) setReadError(caught); })
      .finally(() => { if (readFlight.current === controller) { readFlight.current = null; if (!controller.signal.aborted && currentEpoch === epoch.current) setReadPending(false); } });
    return () => { controller.abort(); if (readFlight.current === controller) readFlight.current = null; };
  }, [restaurantId, active, expired, selectedId, refreshToken, reload]);
  const stale = !!report && !!baseline && (report.editing_version?.id !== baseline.editing_version?.id || report.content.restaurant_revision !== baseline.content.restaurant_revision || report.content.menu.revision !== baseline.content.menu.revision || report.current_public_content_hash !== baseline.current_public_content_hash || report.publication.revision !== baseline.publication.revision);
  const blockers = report?.blockers.filter(code => code !== 'MENU_UNCONFIRMED') ?? [];
  const disabled = !active || expired || busy || saving || !!attempt || restaurantDirty || readPending || !!readError || stale || baseline?.editing_version?.source_status !== 'available' || blockers.length > 0;
  const menuNeedsReview = !!draft && !!baseline && (JSON.stringify(draft.menu) !== JSON.stringify(baseline.content.menu.data) || baseline.content.menu.status === 'draft' || baseline.blockers.includes('MENU_UNCONFIRMED'));
  async function save(retry = false) {
    if (!context.current.active || context.current.expired || writeFlight.current || busy) return;
    let request = attemptRef.current;
    if (!retry) {
      if (disabled || !baseline || !draftRef.current || attemptRef.current) return;
      try { request = { restaurantId, key: crypto.randomUUID(), body: contentChanges(baseline, draftRef.current, review) }; }
      catch (caught) { setError(caught); return; }
    }
    if (!request || request.restaurantId !== restaurantId) return;
    // 冻结独立副本；停用同会话面板保留原正文与键，只有明确会话失效才清空。
    request = Object.freeze({ ...request, body: structuredClone(request.body) });
    attemptRef.current = request; dirtyRef.current = true; setAttempt(request); updateSaveReview(null);
    readFlight.current?.abort(); readFlight.current = null;
    const controller = new AbortController(), currentEpoch = epoch.current;
    writeFlight.current = controller; setReadPending(false); setSaving(true); setError(null); callbacks.current.onBusyChange(true);
    let acknowledged = false;
    try {
      if (retry) await websiteContentClient.workbench(restaurantId, request.body.base_version_id, controller.signal);
      if (controller.signal.aborted || currentEpoch !== epoch.current) return;
      const result = await websiteContentClient.savePreview(restaurantId, request.body, request.key, controller.signal);
      if (controller.signal.aborted || currentEpoch !== epoch.current || context.current.expired) return;
      acknowledged = true; attemptRef.current = null; dirtyRef.current = false; syncRequired.current = true; setAttempt(null);
      const nextDraft = contentDraft(result.content); draftRef.current = nextDraft; setDraft(nextDraft); setReview(false);
      setWarnings(previous => [...new Set([...previous, ...result.warnings])]);
      updateSaveReview(result.changed && result.differences.length ? {
        restaurant_id: restaurantId, version_id: result.version.id, version_number: result.version.version_number,
        base_version_id: request.body.base_version_id, checksum: result.version.checksum,
        public_content_hash: result.public_content_hash, differences: structuredClone(result.differences),
      } : null);
      const nextBaseline = { ...baseline!, content: result.content, editing_version: result.version, current_public_content_hash: result.public_content_hash,
        differences: [], saved_differences: result.changed ? structuredClone(result.differences) : [], blockers: baseline!.blockers.filter(code => code !== 'MENU_UNCONFIRMED') };
      setBaseline(nextBaseline); setReport(nextBaseline); callbacks.current.onReport(nextBaseline); pinned.current = result.version.id;
      setNotice(result.changed ? 'Saved, not published. Loading the updated draft preview.' : 'Saved. Public content is unchanged; no new website version was created.');
      callbacks.current.onPreview(result.version); setMobile('preview');
      await callbacks.current.onSaved?.(result.content);
      if (controller.signal.aborted || currentEpoch !== epoch.current) return;
      syncRequired.current = false; setReload(value => value + 1);
    } catch (caught) {
      if (controller.signal.aborted || currentEpoch !== epoch.current || context.current.expired) return;
      if (acknowledged) { setReadError(caught); setNotice('Content was saved. Restaurant synchronization failed; check the saved result. Do not resubmit.'); }
      else {
        setError(caught);
        if (!isWebsiteWriteUncertain(caught)) { attemptRef.current = null; setAttempt(null); if (!(caught instanceof ApiError && caught.status === 422)) setReadError(caught); }
      }
    } finally {
      if (writeFlight.current === controller) { writeFlight.current = null; callbacks.current.onBusyChange(false); if (currentEpoch === epoch.current) setSaving(false); }
    }
  }
  async function loadHistory(more = false) {
    if (!active || expired || historyFlight.current || (more && !cursor)) return;
    const controller = new AbortController(), currentEpoch = epoch.current; historyFlight.current = controller;
    setHistory(true); setHistoryPending(true); setHistoryError(null);
    try {
      const page = await websiteContentClient.versions(restaurantId, more ? cursor! : undefined, controller.signal);
      if (controller.signal.aborted || currentEpoch !== epoch.current) return;
      if (more && (page.items.some(item => versions.some(v => v.id === item.id)) || (page.items.length && versions.length && page.items[0].version_number >= versions.at(-1)!.version_number))) throw new ApiError(502, 'RESPONSE_INVALID');
      setVersions(more ? [...versions, ...page.items] : page.items); setCursor(page.next_cursor);
    } catch (caught) { if (!controller.signal.aborted && currentEpoch === epoch.current) setHistoryError(caught); }
    finally { if (historyFlight.current === controller) { historyFlight.current = null; if (!controller.signal.aborted && currentEpoch === epoch.current) setHistoryPending(false); } }
  }
  function discard() {
    if (saving || attemptRef.current || !active) return;
    if (report) { const next = contentDraft(report.content); dirtyRef.current = false; draftRef.current = next; setBaseline(report); setDraft(next); }
    setError(null); setReadError(null); setReview(false); setReload(v => v + 1);
  }
  const publicUrl = report ? safeLocalPublicationUrl(report.publication.url, report.publication.slug) : null;
  const shownVersion = previewVersion ?? null;
  if (expired) return <p role="alert">Session expired. Sign in again.</p>;
  return <section className="website-workbench" hidden={!active} aria-label="Website workbench">
    <header className="wb-header"><div><p className="wb-label">Website</p><h2>{shownVersion ? `Preview · v${shownVersion.version_number}${shownVersion.id === report?.publication.published_version_id ? ' · Published' : ' · Saved, not published'}` : selectedId ? 'Loading saved preview' : 'Create your website'}</h2><p className="wb-small">{report?.published_version ? `Published · v${report.published_version.version_number}` : 'Not published'}{shownVersion && <span> · Preview ID: {shownVersion.id}</span>}</p></div>
      <div className="wb-actions">{publicUrl && <a href={publicUrl} target="_blank" rel="noopener noreferrer">Local test ↗</a>}{report?.published_version && <button type="button" disabled={readPending || saving || !!attempt || dirty} onClick={() => callbacks.current.onPreview(report.published_version!)}>Published</button>}<button type="button" disabled={!active || historyPending} onClick={() => { if (history) setHistory(false); else void loadHistory(); }}>History</button><button type="button" disabled={readPending || saving} onClick={() => setReload(v => v + 1)}>Check result</button></div>
    </header>
    {history && <section className="wb-history" aria-label="Version history"><h3>Version history</h3><p className="wb-small">Previewing does not publish or restore restaurant data.</p>{versions.map(version => <button type="button" key={version.id} aria-pressed={selectedId === version.id} disabled={saving || !!attempt || dirty || readPending} onClick={() => callbacks.current.onPreview(version)}>v{version.version_number} · {version.summary} <span>{version.source_status === 'available' ? '' : ' · Preview only'}</span></button>)}{!!historyError && <p role="alert">{errorText(historyError)}</p>}{cursor && <button type="button" disabled={historyPending} onClick={() => void loadHistory(true)}>Load more</button>}{!!historyError && <button type="button" disabled={historyPending} onClick={() => void loadHistory(versions.length > 0)}>Retry history</button>}</section>}
    <div className="wb-mobile-nav" role="group" aria-label="Workbench view"><button type="button" aria-pressed={mobile === 'editor'} onClick={() => setMobile('editor')}>Editor</button><button type="button" aria-pressed={mobile === 'preview'} onClick={() => setMobile('preview')}>Preview</button></div>
    <div className="wb-columns" data-mobile-view={mobile}>
      <div className="wb-editor"><nav className="wb-editor-nav" aria-label="Website editor"><button type="button" aria-pressed={editor === 'content'} onClick={() => setEditor('content')}>Content</button><button type="button" aria-pressed={editor === 'design'} onClick={() => setEditor('design')}>AI design</button></nav>
        {readPending && <p className="wb-small" role="status">Reading saved content…</p>}{!!readError && <p className="wb-notice" role="alert">{errorText(readError)}</p>}
        {active && editor === 'content' && <div>
          {restaurantDirty && <p className="wb-notice" role="status">Finish or discard changes in the restaurant / menu editor first. This editor will not overwrite that draft.</p>}
          {dirty && <p className="wb-small">Unsaved edits are not included in the saved preview or its Content changes.</p>}
          {!!report?.differences.length && <details aria-label="Saved facts awaiting preview update"><summary>Saved facts not in this preview</summary><p className="wb-small">Compared with editing version {report.editing_version?.id}. These are current saved restaurant facts, not the changes from the last successful save.</p><WebsiteDifferences differences={report.differences} beforeLabel="Editing version" afterLabel="Saved restaurant" /></details>}
          {stale && <p className="wb-notice" role="alert">The base version or saved facts changed. Your draft is retained. Discard changes and reload before saving.</p>}
          {blockers.map(code => <p className="wb-notice" key={code}>{blockerLabels[code] ?? 'Content update is unavailable.'}</p>)}
          {!!error && <p className="wb-notice" role="alert">{errorText(error)}</p>}
          {error instanceof ApiError && error.details.length > 0 && <ul className="wb-small">{error.details.map((detail, i) => <li key={i}>{detail.field}: {detail.code}</li>)}</ul>}
          {notice && <p className="wb-notice" role="status">{notice}</p>}{warnings.includes('MENU_FILE_MAY_BE_OUTDATED') && <p className="wb-notice">The original menu image / PDF was not changed. Its printed prices may be outdated.</p>}
          {attempt && <section className="wb-notice" role="alert"><h3>Save result unknown</h3><p>Original input, base version and request key are retained in memory. No automatic retry. Keep this page open.</p><button type="button" disabled={saving || !active || busy} onClick={() => void save(true)}>Check result / Retry same request</button></section>}
          {(stale || !!readError) && !attempt && <button type="button" disabled={saving} onClick={discard}>Discard changes and reload</button>}
          {draft && !restaurantDirty && <WebsiteContentPanel draft={draft} disabled={disabled} menuReview={review} onMenuReview={setReview} menuNeedsReview={menuNeedsReview} dirty={dirty} saving={saving} discardDisabled={!active || !!attempt} onSave={() => void save()} onDiscard={discard} onChange={next => { if (disabled) return; dirtyRef.current = true; draftRef.current = next; setDraft(next); if (JSON.stringify(next.menu) !== JSON.stringify(draft.menu)) setReview(false); setError(null); }} />}
        </div>}
        {active && editor === 'design' && <div>{design}</div>}
      </div>
      <div className="wb-preview-column"><div className="wb-preview-heading"><h3>Preview</h3><span className="wb-small">Saved version · not live changes</span></div>{preview}{active && saveReview?.restaurant_id === restaurantId && saveReview.version_id === selectedId && saveReview.version_id === shownVersion?.id && saveReview.version_id !== report?.publication.published_version_id && <WebsiteContentReviewPanel review={saveReview} />}{publication}</div>
    </div>
    <div className="wb-status">{status}</div>
  </section>;
}
