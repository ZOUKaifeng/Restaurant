import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, onSessionExpired } from './api';
import WebsiteWorkbench, { savedContentReview, WebsiteContentReviewPanel, WebsiteDifferences } from './WebsiteWorkbench';
import { websiteContentClient } from './website-content-client';
import { assetApi } from './asset-api';
import type { Asset, AssetKind } from './assets-types';
import { profileFields } from './profile';
import type { Restaurant } from './types';
import {
  isWebsiteJobActive, isWebsiteWriteUncertain, safeLocalPublicationUrl,
  websiteApi, websiteSlugPattern,
} from './website-api';
import {
  buildPreviewDocument, previewImageUrl, rewriteWebsitePreview, textDataUrl,
} from './website-preview';
import type { WebsiteContentReview, WebsiteContentVersion, WebsiteEditableContent, WebsiteWorkbenchReport, WebsitePublishInput } from './website-types';
import WebsiteAssetThumbnail from './WebsiteAssetThumbnail';
import type { WebsiteAccepted, WebsiteAttempt, WebsiteDiagnostic, WebsiteJob, WebsiteModelCall, WebsiteProgress, WebsiteState, WebsiteUsage, WebsiteVersion } from './website-types';

type Draft = { brief: string; assetIds: string[]; message: string; confirmed: boolean; visionConfirmed: boolean };
type Saved = Pick<Draft, 'brief' | 'assetIds'>;
type Preview = {
  versionId: string; versionNumber: number; checksum: string; documentUrl: string; fullUrl: string; reducedImages: number;
  pdfs: Array<{ id: string; url: string }>; originals: Array<{ id: string; url: string; label: string }>;
};

type Acknowledged = WebsiteAccepted & { kind: 'chat' | 'generate' };
const kindLabels: Record<AssetKind, string> = { menu_source: 'Original menu file', logo: 'Logo', restaurant_photo: 'Restaurant photo', dish_photo: 'Dish photo' };
const jobLabels = { queued: 'Queued', running: 'Running', succeeded: 'Completed', failed: 'Failed' };
const phaseLabels: Record<WebsiteProgress['phase'], string> = {
  planning: 'Planning', writing: 'Writing', checking: 'Checking',
  repairing: 'Repairing', ready: 'Checks passed', failed: 'Stopped',
};
const planStatusLabels = { pending: 'Pending', in_progress: 'In progress', completed: 'Completed' };
const callStatusLabels = { started: 'In progress', completed: 'Completed', failed: 'Failed' };
function countLabel(value: number | null | undefined) { return value == null ? 'Unknown' : value.toLocaleString('zh-CN'); }
function elapsedLabel(value: number | null | undefined) { return value == null ? 'Unknown' : `${value.toLocaleString('zh-CN')} ms`; }
function roundLabel(round: number) { return round === 0 ? 'Preparing draft' : round === 1 ? 'First draft' : `Repair ${round - 1}`; }
function ModelCallCounts({ call }: { call: WebsiteModelCall }) {
  return <p className="micro">Call #{call.index} · {callStatusLabels[call.status]} · Input {countLabel(call.prompt_tokens)} / output {countLabel(call.completion_tokens)} / total {countLabel(call.total_tokens)} tokens · {elapsedLabel(call.elapsed_ms)}</p>;
}
function Diagnostics({ items }: { items: WebsiteDiagnostic[] }) {
  return <ul className="website-diagnostics" aria-label="Server diagnostics">{items.map((item, index) => <li key={index}><span>{item.file} · line {item.line} / column {item.column} · <code>{item.code}</code></span><p>{item.message}</p></li>)}</ul>;
}
function AgentProgress({ job, waiting, stale, headingId }: { job: WebsiteJob | undefined; waiting: boolean; stale: boolean; headingId: string }) {
  const progress = job?.progress;
  const trace = job?.trace ?? [];
  const diagnostics = progress?.diagnostics ?? [...trace].reverse().find(item => !item.model_call && !/model|模型/i.test(item.action) && item.diagnostics.length)?.diagnostics ?? [];
  return <section className="website-section website-agent-progress" aria-labelledby={headingId}>
    <div className="row-heading"><h3 id={headingId}>AI design progress</h3>{job && <time className="micro" dateTime={job.created_at}>{formatTime(job.created_at)}</time>}</div>
    <div aria-live="polite">{stale && <p className="wb-notice">Checking paused. This is the last confirmed record, not proof that the job stopped.</p>}
      <p>{waiting ? "Generation accepted. Waiting for recorded progress." : !job ? "No design job yet." : job.status === "failed" ? "Generation failed. No automatic restart." : progress ? phaseLabels[progress.phase] : jobLabels[job.status]}</p>
      {job?.status === "failed" && <p className="wb-notice">{job.error_code ?? "Unknown error"}. Check the saved facts and design brief before creating another draft.</p>}
    </div>
    {diagnostics.length > 0 && <details><summary>Check results · {diagnostics.length}</summary><Diagnostics items={diagnostics} /><p className="micro">Line / column 0 means no location was provided. Private source is never shown.</p></details>}
    {job && <details className="website-agent-details"><summary>Plan, model & tool details</summary>
      {progress && <><p className="micro">{roundLabel(progress.round)} · {countLabel(progress.model_calls)} calls · input {countLabel(progress.prompt_tokens)} / output {countLabel(progress.completion_tokens)} / total {countLabel(progress.total_tokens)} tokens · {elapsedLabel(progress.elapsed_ms)}</p><ol>{progress.plan.map(item => <li key={item.id}>{planStatusLabels[item.status]} · {item.title}</li>)}</ol></>}
      <p className="micro">Observation mode. Recorded tokens are not a bill; unknown usage is not zero. Raw model input and output are never shown.</p>
      {trace.length ? <ol>{trace.map((item, index) => <li key={index}><p>{roundLabel(item.round)} · {item.action} · {item.model_call ? callStatusLabels[item.model_call.status] : item.status}</p>{item.model_call ? <ModelCallCounts call={item.model_call} /> : /model|模型/i.test(item.action) ? <p className="micro">Legacy model usage is unknown.</p> : <><p>{item.message}</p>{item.diagnostics.length > 0 && <Diagnostics items={item.diagnostics} />}</>}</li>)}</ol> : <p className="micro">No tool trace recorded.</p>}
    </details>}
  </section>;
}
function formatTime(value: string) { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
function sameIds(left: string[], right: string[]) { return [...left].sort().join(',') === [...right].sort().join(','); }
function storageKey(id: string) { return `website-attempt:${id}`; }
function restoreAttempt(id: string): WebsiteAttempt | null {
  try {
    const value = sessionStorage.getItem(storageKey(id));
    if (!value) return null;
    const item = JSON.parse(value) as WebsiteAttempt;
    if (!item || typeof item.key !== 'string' || !/^[A-Za-z0-9_.:-]{16,128}$/.test(item.key) || !item.body) return null;
    const validRevision = (value: number) => Number.isSafeInteger(value) && value >= 0;
    if (item.kind === 'chat' && typeof item.body.message === 'string' && item.body.message.trim() && item.body.message.length <= 2000 && validRevision(item.body.expected_revision)) {
      return { kind: 'chat', key: item.key, body: { message: item.body.message, expected_revision: item.body.expected_revision } };
    }
    if (item.kind === 'generate' && typeof item.body.brief === 'string' && item.body.brief.trim() && item.body.brief.length <= 3000
      && Array.isArray(item.body.asset_ids) && item.body.asset_ids.length <= 8 && new Set(item.body.asset_ids).size === item.body.asset_ids.length
      && item.body.asset_ids.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(id))
      && item.body.public_assets_confirmed === true
      && (item.body.image_vision_confirmed === undefined || item.body.image_vision_confirmed === true)
      && validRevision(item.body.expected_restaurant_revision) && item.body.expected_restaurant_revision >= 1
      && (item.body.expected_menu_revision === undefined || validRevision(item.body.expected_menu_revision))) {
      return { kind: 'generate', key: item.key, body: {
        brief: item.body.brief, asset_ids: [...item.body.asset_ids], public_assets_confirmed: true,
        // 旧请求缺省仍缺省，不能在恢复或同键重试时补造外发授权。
        ...(item.body.image_vision_confirmed === true ? { image_vision_confirmed: true } : {}),
        expected_restaurant_revision: item.body.expected_restaurant_revision,
        ...(item.body.expected_menu_revision === undefined ? {} : Number.isSafeInteger(item.body.expected_menu_revision) && item.body.expected_menu_revision >= 0 ? { expected_menu_revision: item.body.expected_menu_revision } : {}),
      } };
    }
    if (item.kind === 'publish' && typeof item.body.version_id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(item.body.version_id) && validRevision(item.body.expected_revision)
      && (item.body.slug === undefined || (typeof item.body.slug === 'string' && websiteSlugPattern.test(item.body.slug)))) {
      const enhanced = ['expected_checksum', 'expected_public_content_hash', 'content_mode', 'review_confirmed'].some(field => Object.hasOwn(item.body, field));
      if (enhanced && (!/^[a-f0-9]{64}$/.test(item.body.expected_checksum ?? '') || !/^[a-f0-9]{64}$/.test(item.body.expected_public_content_hash ?? '')
        || !['current', 'historical'].includes(item.body.content_mode ?? '') || item.body.review_confirmed !== true)) return null;
      return { kind: 'publish', key: item.key, body: {
        version_id: item.body.version_id, expected_revision: item.body.expected_revision,
        ...(enhanced ? { expected_checksum: item.body.expected_checksum, expected_public_content_hash: item.body.expected_public_content_hash,
          content_mode: item.body.content_mode, review_confirmed: true as const } : {}),
        ...(item.body.slug === undefined ? {} : { slug: item.body.slug }),
      } };
    }
  } catch { /* 本地重试存储不可用时，不发起任何请求。 */ }
  return null;
}
function ErrorMessage({ error, readOnly = false, submissionUnknown = false, cancellation = false }: { error: unknown; readOnly?: boolean; submissionUnknown?: boolean; cancellation?: boolean }) {
  if (!error) return null;
  const code = error instanceof ApiError ? error.code : "REQUEST_UNCONFIRMED";
  const message = error instanceof ApiError && error.status === 401 ? "Session expired. No request will be replayed."
    : cancellation && isWebsiteWriteUncertain(error) ? "Stop result unknown. Check status; no stop or generation request is automatically resent."
      : readOnly ? "Read failed. The last confirmed record is retained. Check result; writes are never replayed because of a read failure."
        : "Request did not complete. Check the fields and current result before trying again.";
  return <div className="notice error-notice" role="alert">{submissionUnknown && <p>Submission result unknown. Original input and request key are retained.</p>}<p>{message} <code>{code}</code></p></div>;
}
function useWebsiteUsage(restaurantId: string, jobId: string | null, job: WebsiteJob | undefined, active: boolean) {
  const resource = `${restaurantId}:${jobId ?? ''}`;
  const contextRef = useRef({ resource, active });
  contextRef.current = { resource, active };
  const [snapshot, setSnapshot] = useState<{ resource: string; value: WebsiteUsage } | null>(null);
  const [failure, setFailure] = useState<{ resource: string; value: unknown } | null>(null);
  const [openedResource, setOpenedResource] = useState<string | null>(null);
  const [pendingResource, setPendingResource] = useState<string | null>(null);
  const openedRef = useRef<string | null>(null);
  const flightRef = useRef<AbortController | null>(null);
  const refreshQueuedRef = useRef(false);
  const autoBlockedRef = useRef(false);
  const observedRef = useRef<{ metrics: string | null; calls: Map<number, string> }>({ metrics: null, calls: new Map() });

  useEffect(() => {
    openedRef.current = null;
    refreshQueuedRef.current = false;
    autoBlockedRef.current = false;
    observedRef.current = { metrics: null, calls: new Map() };
    setOpenedResource(null);
    setSnapshot(null);
    setFailure(null);
    setPendingResource(null);
  }, [resource]);
  useEffect(() => {
    if (!active) setPendingResource(null);
    return () => {
      flightRef.current?.abort();
      flightRef.current = null;
      refreshQueuedRef.current = false;
    };
  }, [resource, active]);

  const load = useCallback(async function loadCurrent(automatic = false): Promise<void> {
    if (!jobId || !active || contextRef.current.resource !== resource || !contextRef.current.active) return;
    if (automatic && (openedRef.current !== resource || autoBlockedRef.current)) return;
    if (flightRef.current) {
      if (automatic) refreshQueuedRef.current = true;
      return;
    }
    if (!automatic) autoBlockedRef.current = false;
    openedRef.current = resource;
    setOpenedResource(resource);
    const controller = new AbortController();
    flightRef.current = controller;
    setPendingResource(resource);
    setFailure(null);
    try {
      const value = await websiteApi.getUsage(restaurantId, jobId, controller.signal);
      if (!controller.signal.aborted && contextRef.current.resource === resource) setSnapshot({ resource, value });
    } catch (caught) {
      if (!controller.signal.aborted && contextRef.current.resource === resource) {
        autoBlockedRef.current = true;
        setFailure({ resource, value: caught });
      }
    } finally {
      if (flightRef.current === controller) {
        flightRef.current = null;
        if (!controller.signal.aborted && contextRef.current.resource === resource) setPendingResource(null);
        const refresh = refreshQueuedRef.current;
        refreshQueuedRef.current = false;
        if (refresh && !controller.signal.aborted && !autoBlockedRef.current) void loadCurrent(true);
      }
    }
  }, [restaurantId, jobId, resource, active]);

  useEffect(() => {
    const observed = observedRef.current;
    const progress = job?.progress;
    const metrics = JSON.stringify([progress?.prompt_tokens, progress?.completion_tokens, progress?.total_tokens,
      job && !isWebsiteJobActive(job) ? job.status : null]);
    let changed = observed.metrics !== null && observed.metrics !== metrics;
    observed.metrics = metrics;
    const latestCalls = new Map<number, WebsiteModelCall>();
    for (const event of job?.trace ?? []) {
      const call = event.model_call;
      if (call && call.status !== 'started') latestCalls.set(call.index, call);
    }
    for (const call of latestCalls.values()) {
      const signature = JSON.stringify([call.status, call.prompt_tokens, call.completion_tokens, call.total_tokens, call.elapsed_ms, call.error_code]);
      if (observed.calls.get(call.index) !== signature) changed = true;
      observed.calls.set(call.index, signature);
    }
    // 仅在用户打开后刷新终态/迟到用量；started 和滑出轨迹窗口都不会拉取全部历史。
    if (changed && active && openedRef.current === resource) void load(true);
  }, [resource, active, job, load]);

  const opened = openedResource === resource;
  const data = opened && snapshot?.resource === resource ? snapshot.value : null;
  const error = opened && failure?.resource === resource ? failure.value : null;
  const pending = pendingResource === resource;
  const settling = active && opened && !error && !!data?.calls.some(call => call.status === 'started');
  useEffect(() => {
    if (!settling || pending) return;
    // 终态任务也可能仍有原请求在结算；只核对账单，不更改任务状态。
    const timer = window.setTimeout(() => void load(true), 5000);
    return () => window.clearTimeout(timer);
  }, [settling, pending, resource, load]);

  const close = useCallback(() => {
    openedRef.current = null;
    refreshQueuedRef.current = false;
    flightRef.current?.abort();
    flightRef.current = null;
    setOpenedResource(null);
    setPendingResource(null);
  }, []);

  return { data, error, opened, pending, settling, load, close };
}
function WebsiteUsagePanel({ usage, jobId, active, headingId }: { usage: ReturnType<typeof useWebsiteUsage>; jobId: string | null; active: boolean; headingId: string }) {
  const data = usage.data, legacy = data?.legacy_summary;
  return <section className="website-section" aria-labelledby={headingId}>
    <div className="row-heading"><h3 id={headingId}>Generation usage</h3><button type="button" disabled={!jobId || !active || usage.pending} aria-expanded={usage.opened} onClick={() => void usage.load()}>{usage.pending ? "Reading usage…" : "View usage"}</button>{usage.opened && <button type="button" onClick={usage.close}>Close usage</button>}</div>
    <p className="micro">Observation mode, not a bill. Unknown usage is not zero. Opening this view only reads recorded usage, never resubmits a job. Close or leave to stop checking.</p>
    {usage.settling && <p role="status">Original call is still settling. Checking recorded usage.</p>}<ErrorMessage error={usage.error} readOnly />
    {legacy ? <p className="wb-notice">Legacy total: {countLabel(legacy.total_tokens)} tokens · {countLabel(legacy.model_calls)} recorded calls. Input / output and per-call details are unknown; no records are invented.</p>
      : data ? <><p>Known input {countLabel(data.totals.prompt_tokens)} / output {countLabel(data.totals.completion_tokens)} / total {countLabel(data.totals.total_tokens)} tokens.</p>{data.unknown_usage_calls > 0 && <p className="wb-notice">{data.unknown_usage_calls} calls have unknown usage. The known total is incomplete.</p>}<div style={{ overflowX: "auto" }}><table><caption>Recorded model call usage</caption><thead><tr><th>Call</th><th>Status</th><th>Input</th><th>Output</th><th>Total</th><th>Elapsed</th></tr></thead><tbody>{[...data.calls].sort((a,b) => a.index - b.index).map(call => <tr key={call.index}><th scope="row">#{call.index}</th><td>{callStatusLabels[call.status]}</td><td>{countLabel(call.prompt_tokens)}</td><td>{countLabel(call.completion_tokens)}</td><td>{countLabel(call.total_tokens)}</td><td>{elapsedLabel(call.elapsed_ms)}</td></tr>)}</tbody></table></div></> : <p className="micro">No usage has been read yet.</p>}
  </section>;
}
function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { window.clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = window.setTimeout(done, 2000);
    signal.addEventListener('abort', done, { once: true });
  });
}

export default function WebsitePanel({ restaurant, active, busy, restaurantDirty, onBusyChange, onJobsChange, onDirtyChange, onRestaurantConflict, onContentSaved, onContentDirtyChange }: {
  restaurant: Restaurant;
  active: boolean;
  busy: boolean;
  restaurantDirty: boolean;
  onBusyChange: (busy: boolean) => void;
  onJobsChange: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  onRestaurantConflict: () => void;
  onContentSaved?: (content: WebsiteEditableContent) => void | Promise<void>;
  onContentDirtyChange?: (value: boolean) => void;
}) {
  const [contentDirty, setContentDirty] = useState(false);
  const [contentBusy, setContentBusy] = useState(false);
  const [workbenchReport, setWorkbenchReport] = useState<WebsiteWorkbenchReport | null>(null);
  const [extraVersion, setExtraVersion] = useState<WebsiteVersion | null>(null);
  const [reviewPending, setReviewPending] = useState(false);
  const [publishReview, setPublishReview] = useState<{ input: WebsitePublishInput; report: WebsiteWorkbenchReport; version: WebsiteContentVersion; contentReview: WebsiteContentReview | null } | null>(null);
  const contentReviewRef = useRef<WebsiteContentReview | null>(null);
  const [historicalConfirmed, setHistoricalConfirmed] = useState(false);
  const [expired, setExpired] = useState(false);
  const reviewFlightRef = useRef<AbortController | null>(null);
  const autoPreviewRef = useRef<string | null>(null);
  const sessionRef = useRef({ active, expired: false, selectedId: null as string | null });
  sessionRef.current.active = active;
  const [attempt, setAttempt] = useState<WebsiteAttempt | null>(() => restoreAttempt(restaurant.id));
  const [state, setState] = useState<WebsiteState | null>(null);
  const [draft, setDraft] = useState<Draft>(() => ({
    brief: attempt?.kind === 'generate' ? attempt.body.brief : '',
    assetIds: attempt?.kind === 'generate' ? [...attempt.body.asset_ids] : [],
    message: attempt?.kind === 'chat' ? attempt.body.message : '',
    confirmed: attempt?.kind === 'generate',
    visionConfirmed: attempt?.kind === 'generate' && attempt.body.image_vision_confirmed === true,
  }));
  const [saved, setSaved] = useState<Saved>({ brief: '', assetIds: [] });
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(true);
  const [assetsError, setAssetsError] = useState<unknown>(null);
  const [assetsTruncated, setAssetsTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<WebsiteAttempt['kind'] | 'retry' | 'cancel' | null>(null);
  const [cancelTargetId, setCancelTargetId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<unknown>(null);
  const [cancelNeedsCheck, setCancelNeedsCheck] = useState(false);
  const [acknowledged, setAcknowledged] = useState<Acknowledged | null>(null);
  const [reload, setReload] = useState(0);
  const [assetReload, setAssetReload] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(attempt?.kind === 'publish' ? attempt.body.version_id : null);
  sessionRef.current.selectedId = selectedId;
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop');
  const [slug, setSlug] = useState(attempt?.kind === 'publish' ? attempt.body.slug ?? '' : '');
  const [publicationConfirmed, setPublicationConfirmed] = useState(false);
  const [publicationNeedsCheck, setPublicationNeedsCheck] = useState(false);
  const [publishTarget, setPublishTarget] = useState<WebsiteVersion | null>(null);
  const draftRef = useRef(draft);
  const savedRef = useRef(saved);
  const attemptRef = useRef(attempt);
  const stateRef = useRef(state);
  const acknowledgedRef = useRef(acknowledged);
  const initializedRef = useRef(false);
  const confirmedRevisionRef = useRef(restaurant.revision);
  const visionRevisionRef = useRef(restaurant.revision);
  const observedRestaurantRef = useRef(`${restaurant.id}:${restaurant.revision}`);
  const assetsRef = useRef<Asset[] | null>(null);
  const serverBriefRef = useRef('');
  const observedJobsRef = useRef(new Set<string>());
  const flightRef = useRef<AbortController | null>(null);
  const pollFlightRef = useRef<AbortController | null>(null);
  const previewFlightRef = useRef<AbortController | null>(null);
  const urlsRef = useRef<string[]>([]);
  const callbacksRef = useRef({ onBusyChange, onJobsChange, onDirtyChange, onRestaurantConflict });
  const mountedRef = useRef(false);
  const reportedBusyRef = useRef(false);
  const reportBusy = useCallback((value: boolean) => {
    if (reportedBusyRef.current === value) return;
    reportedBusyRef.current = value;
    callbacksRef.current.onBusyChange(value);
  }, []);
  draftRef.current = draft;
  savedRef.current = saved;
  attemptRef.current = attempt;
  stateRef.current = state;
  acknowledgedRef.current = acknowledged;
  callbacksRef.current = { onBusyChange, onJobsChange, onDirtyChange, onRestaurantConflict };
  const jobsActive = !!acknowledged || !!state?.jobs.some(isWebsiteJobActive);
  const dirty = !!attempt || !!draft.message || draft.brief !== saved.brief || !sameIds(draft.assetIds, saved.assetIds);

  const updateDraft = useCallback((next: Draft) => {
    const current = draftRef.current;
    const changed = next.brief !== current.brief || !sameIds(next.assetIds, current.assetIds);
    const value = changed ? { ...next, confirmed: false, visionConfirmed: false } : next;
    draftRef.current = value;
    setDraft(value);
  }, []);
  useEffect(() => {
    const revision = `${restaurant.id}:${restaurant.revision}`;
    if (observedRestaurantRef.current !== revision) {
      observedRestaurantRef.current = revision;
      updateDraft({ ...draftRef.current, confirmed: false, visionConfirmed: false });
    }
  }, [restaurant.id, restaurant.revision, updateDraft]);
  const updateSaved = useCallback((next: Saved) => { savedRef.current = next; setSaved(next); }, []);
  const keepAttempt = useCallback((next: WebsiteAttempt | null) => {
    attemptRef.current = next;
    setAttempt(next);
    try {
      if (next) sessionStorage.setItem(storageKey(restaurant.id), JSON.stringify(next));
      else sessionStorage.removeItem(storageKey(restaurant.id));
    } catch {
      if (next) setNote('Retry storage is unavailable. The original key is retained in memory; do not reload while the result is unknown.');
    }
  }, [restaurant.id]);
  const closePreview = useCallback(() => {
    previewFlightRef.current?.abort();
    previewFlightRef.current = null;
    urlsRef.current.forEach(url => URL.revokeObjectURL(url));
    urlsRef.current = [];
    setPreview(null);
    setPreviewPending(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      flightRef.current?.abort();
      flightRef.current = null;
      previewFlightRef.current?.abort();
      previewFlightRef.current = null;
      urlsRef.current.forEach(url => URL.revokeObjectURL(url));
      urlsRef.current = [];
      reportBusy(false);
      callbacksRef.current.onJobsChange(false);
    };
  }, []);
  useEffect(() => { onDirtyChange(dirty || contentDirty); }, [dirty, contentDirty, onDirtyChange]);
  useEffect(() => { onContentDirtyChange?.(contentDirty); }, [contentDirty, onContentDirtyChange]);
  useEffect(() => { reportBusy(pending !== null || contentBusy || reviewPending); }, [pending, contentBusy, reviewPending, reportBusy]);
  useEffect(() => onSessionExpired(() => {
    sessionRef.current.expired = true; contentReviewRef.current = null;
    flightRef.current?.abort(); pollFlightRef.current?.abort(); reviewFlightRef.current?.abort();
    closePreview(); keepAttempt(null); setState(null); setWorkbenchReport(null); setExtraVersion(null); setPublishReview(null); setExpired(true);
    updateDraft({ brief: '', assetIds: [], message: '', confirmed: false, visionConfirmed: false });
  }), [closePreview, keepAttempt, updateDraft]);
  useEffect(() => { onJobsChange(jobsActive); }, [jobsActive, onJobsChange]);
  useEffect(() => {
    if (active) return;
    closePreview();
    setCancelTargetId(null);
    if (flightRef.current) {
      flightRef.current.abort();
      flightRef.current = null;
      setPending(null);
      reportBusy(false);
    }
  }, [active, closePreview]);

  const applyState = useCallback((next: WebsiteState, selectGeneratedVersion = true) => {
    const current = draftRef.current;
    const baseline = savedRef.current;
    const first = !initializedRef.current;
    if (first || next.agent.design_brief !== serverBriefRef.current) {
      if (!attemptRef.current && current.brief === baseline.brief) {
        updateDraft({ ...current, brief: next.agent.design_brief, confirmed: false });
      }
      updateSaved({ ...baseline, brief: next.agent.design_brief });
    }
    serverBriefRef.current = next.agent.design_brief;
    initializedRef.current = true;
    if (stateRef.current && stateRef.current.menu.revision !== next.menu.revision) updateDraft({ ...draftRef.current, confirmed: false });
    const ack = acknowledgedRef.current;
    const completed = next.jobs.filter(job => observedJobsRef.current.has(job.id) && job.status === 'succeeded' && job.result_version_id)
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0];
    if (first) setSelectedId(currentId => currentId ?? next.publication.published_version_id ?? next.versions[0]?.id ?? null);
    if (selectGeneratedVersion && completed?.result_version_id) {
      setSelectedId(completed.result_version_id);
      setPublicationConfirmed(false);
      setPublishTarget(null);
      setNote('New design saved. Opening its real preview; publication requires your confirmation.');
    }
    next.jobs.forEach(job => {
      if (isWebsiteJobActive(job)) observedJobsRef.current.add(job.id);
      else observedJobsRef.current.delete(job.id);
    });
    if (ack && next.jobs.some(job => job.id === ack.job_id)) {
      acknowledgedRef.current = null;
      setAcknowledged(null);
    }
    if (stateRef.current && stateRef.current.publication.revision !== next.publication.revision) {
      setPublicationConfirmed(false);
      setPublishTarget(null);
    }
    stateRef.current = next;
    setState(next);
    if (next.publication.slug !== null) setSlug(next.publication.slug);
    setLoading(false);
    setLoadError(null);
    setChecking(false);
    setPublicationNeedsCheck(false);
    setCancelNeedsCheck(false);
  }, [updateDraft, updateSaved]);

  useEffect(() => {
    if (!active || expired) return;
    const controller = new AbortController();
    pollFlightRef.current = controller;
    setChecking(true);
    async function poll() {
      do {
        try {
          const next = await websiteApi.get(restaurant.id, controller.signal);
          if (controller.signal.aborted) return;
          applyState(next);
          if (!next.jobs.some(isWebsiteJobActive) && !acknowledgedRef.current) return;
        } catch (caught) {
          if (controller.signal.aborted) return;
          setLoadError(caught);
          setLoading(false);
          setChecking(false);
          // 读取失败就停止轮询，保留已知状态，等待用户手动核查。
          return;
        }
        await waitForPoll(controller.signal);
      } while (!controller.signal.aborted);
    }
    void poll();
    return () => {
      controller.abort();
      if (pollFlightRef.current === controller) pollFlightRef.current = null;
    };
  }, [active, expired, restaurant.id, reload, applyState]);

  useEffect(() => {
    if (!active || expired) return;
    const controller = new AbortController();
    setAssetsLoading(true);
    setAssetsError(null);
    async function loadAssets() {
      try {
        const items: Asset[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        let more = false;
        do {
          const page = await assetApi.list(restaurant.id, cursor, controller.signal);
          if (controller.signal.aborted) return;
          for (const item of page.items) {
            if (items.some(existing => existing.id === item.id)) throw new ApiError(502, 'RESPONSE_INVALID');
            items.push(item);
          }
          more = page.has_more;
          if (more && page.items.length === 0) throw new ApiError(502, 'RESPONSE_INVALID');
          if (!more || items.length >= 100) break;
          if (!page.next_cursor || cursors.has(page.next_cursor)) throw new ApiError(502, 'RESPONSE_INVALID');
          cursors.add(page.next_cursor);
          cursor = page.next_cursor;
        } while (true);
        const available = items.slice(0, 100).filter(item => item.origin === 'upload' && item.status === 'ready' && item.safety_status === 'approved');
        const selectedChanged = draftRef.current.assetIds.some(id => {
          const next = available.find(asset => asset.id === id);
          const previous = assetsRef.current?.find(asset => asset.id === id);
          return !next || (!!assetsRef.current && (!previous || previous.revision !== next.revision
            || previous.checksum !== next.checksum || previous.kind !== next.kind || previous.mime_type !== next.mime_type
            || previous.rights_confirmed_at !== next.rights_confirmed_at));
        });
        if (selectedChanged) updateDraft({ ...draftRef.current, confirmed: false, visionConfirmed: false });
        assetsRef.current = available;
        setAssets(available);
        setAssetsTruncated(more);
      } catch (caught) { if (!controller.signal.aborted) setAssetsError(caught); }
      finally { if (!controller.signal.aborted) setAssetsLoading(false); }
    }
    void loadAssets();
    return () => controller.abort();
  }, [active, expired, restaurant.id, assetReload, updateDraft]);

  const selected = extraVersion?.id === selectedId ? extraVersion : state?.versions.find(version => version.id === selectedId) ?? null;
  const publishedNumber = workbenchReport?.published_version?.id === state?.publication.published_version_id
    ? workbenchReport?.published_version?.version_number : state?.versions.find(version => version.id === state.publication.published_version_id)?.version_number;
  const inputLocked = busy || contentBusy || reviewPending || pending !== null || !!attempt || loading || checking || !active || expired;
  const modelLocked = inputLocked || jobsActive || cancelNeedsCheck || checking || loading || !!loadError || !state?.model_configured || restaurantDirty || contentDirty
    || !['draft', 'active'].includes(restaurant.status);
  const selectedAssets = draft.assetIds.map(id => assets.find(asset => asset.id === id));
  const missingSelected = selectedAssets.some(asset => !asset);
  const needsVision = selectedAssets.some(asset => !!asset && ['logo', 'restaurant_photo', 'dish_photo'].includes(asset.kind)
    && ['image/jpeg', 'image/png'].includes(asset.mime_type));
  const visionConfirmed = draft.visionConfirmed && visionRevisionRef.current === restaurant.revision;
  const factsConfirmed = draft.confirmed && confirmedRevisionRef.current === restaurant.revision;
  const menuNeedsConfirm = !!state && state.menu.item_count > 0 && state.menu.status !== 'confirmed';
  const generationBlockers = ([
    [!active, 'This panel is not active.'],
    [busy, 'Another workspace operation is pending.'],
    [pending !== null, 'A request is pending.'],
    [!!attempt, 'Check the unresolved original request first.'],
    [loading, 'Reading website state.'],
    [checking, 'Checking jobs and versions.'],
    [!!loadError, 'Website read failed. Check status first.'],
    [cancelNeedsCheck, 'Stop result needs a status check.'],
    [!state, 'No validated website state yet.'],
    [!!state && !state.model_configured, 'AI is not configured. No simulated generation is available.'],
    [jobsActive, 'A background job is active.'],
    [restaurantDirty || contentDirty, 'Finish or discard unsaved restaurant content first.'],
    [contentBusy || reviewPending || expired, 'Another request is pending or the session expired.'],
    [!['draft', 'active'].includes(restaurant.status), 'This restaurant cannot generate a design.'],
    [menuNeedsConfirm, 'Confirm the saved menu first.'],
    [!draft.brief.trim(), 'Enter a design brief.'],
    [!factsConfirmed, 'Confirm saved facts and permission to publish selected assets.'],
    [needsVision && !visionConfirmed, 'Separately authorize sending selected photo / logo thumbnails to DeepSeek.'],
    [assetsLoading, 'Reading available assets.'],
    [!!assetsError, 'Asset read failed. Refresh assets.'],
    [missingSelected, 'Remove unavailable selected assets and confirm again.'],
  ] satisfies Array<[boolean, string]>).filter(([blocked]) => blocked).map(([, reason]) => reason);
  // 「结果未知」保护态不能把放弃入口一起锁死，否则用户既不能改、也不能取消。
  // 放弃只清除浏览器本地草稿与未确认请求的幂等键，不向服务端发送任何写请求。
  const discardDisabled = !active || busy || pending !== null || loading || !!flightRef.current || !dirty;
  const discardDraft = () => {
    if (discardDisabled) return;
    const hadUncertainRequest = !!attemptRef.current;
    keepAttempt(null);
    updateDraft({ ...draftRef.current, brief: savedRef.current.brief, assetIds: [...savedRef.current.assetIds], message: '', confirmed: false, visionConfirmed: false });
    setError(null);
    setCancelError(null);
    setPublicationConfirmed(false);
    setPublishTarget(null);
    setNote(hadUncertainRequest
      ? 'Local changes and the unresolved request were discarded. No write was sent. A job already accepted by the server may still exist; check status.'
      : 'Unsaved design changes discarded.');
  };

  async function execute(request: WebsiteAttempt, signal: AbortSignal) {
    try {
      if (request.kind === 'publish') {
        // 同键重试也可能返回历史动作；回执绝不合并到当前发布状态。
        await websiteApi.publish(restaurant.id, request.body, request.key, signal);
        if (signal.aborted) return;
        keepAttempt(null);
        setPublicationNeedsCheck(true);
        setPublicationConfirmed(false);
        setPublishTarget(null);
        setChecking(true);
        setNote('Publication acknowledged. Reading current publication; the original receipt does not represent its current pointer.');
        try {
          const next = await websiteApi.get(restaurant.id, signal);
          if (signal.aborted) return;
          applyState(next, false);
          setNote('Publication acknowledged. Current state reloaded; no publication pointer was restored automatically.');
          if (next.jobs.some(isWebsiteJobActive)) setReload(value => value + 1);
        } catch (caught) {
          if (signal.aborted) return;
          // 原动作已知完成，GET 失败不能转成写入未知或再发一次发布。
          setLoadError(caught);
          setChecking(false);
          setNote('Publication acknowledged, current state read failed. Check status; no publication will be resubmitted.');
        }
        return;
      } else {
        const accepted = request.kind === 'chat'
          ? await websiteApi.message(restaurant.id, request.body, request.key, signal)
          : await websiteApi.generate(restaurant.id, request.body, request.key, signal);
        if (signal.aborted) return;
        const ack = { ...accepted, kind: request.kind };
        acknowledgedRef.current = ack;
        setAcknowledged(ack);
        observedJobsRef.current.add(accepted.job_id);
        keepAttempt(null);
        if (request.kind === 'chat') updateDraft({ ...draftRef.current, message: '' });
        else updateSaved({ brief: request.body.brief, assetIds: [...request.body.asset_ids] });
        setNote('Background job accepted. Checking recorded progress every 2 seconds; a read failure pauses checks, never resubmits the job.');
      }
      setReload(value => value + 1);
    } catch (caught) {
      if (!signal.aborted && !isWebsiteWriteUncertain(caught)) {
        keepAttempt(null);
        setReload(value => value + 1);
        if (caught instanceof ApiError && (caught.status === 412 || caught.status === 428 || /REVISION_CONFLICT/.test(caught.code))) {
          setPublicationConfirmed(false);
          setPublishTarget(null);
          if (request.kind === 'generate') callbacksRef.current.onRestaurantConflict();
        }
      }
      throw caught;
    }
  }
  async function run(request: WebsiteAttempt, retry = false) {
    if (!active || sessionRef.current.expired || busy || contentBusy || reviewPending || flightRef.current) return;
    const controller = new AbortController();
    flightRef.current = controller;
    if (request.kind === 'publish') {
      // 取消可能携带旧指针的并行轮询，只接受原动作完成后的 GET。
      pollFlightRef.current?.abort();
      pollFlightRef.current = null;
      setChecking(true);
    }
    setPending(retry ? 'retry' : request.kind);
    setError(null);
    setCancelError(null);
    setNote('');
    keepAttempt(request);
    reportBusy(true);
    try {
      if (retry) {
        // 核查只读状态后，同内容同键查询原写入结果；绝不换键或自动重放。
        const next = await websiteApi.get(restaurant.id, controller.signal);
        if (controller.signal.aborted) return;
        applyState(next, request.kind !== 'publish');
      }
      await execute(request, controller.signal);
    } catch (caught) {
      if (mountedRef.current && !controller.signal.aborted) {
        setError(caught);
        if (request.kind === 'publish') setChecking(false);
      }
    } finally {
      if (flightRef.current === controller) {
        flightRef.current = null;
        reportBusy(false);
        if (mountedRef.current) setPending(null);
      }
    }
  }
  async function stopGeneration(jobId: string) {
    const latest = [...(stateRef.current?.jobs ?? [])].filter(job => job.kind === 'generate')
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    if (!active || busy || pending !== null || flightRef.current || cancelNeedsCheck || cancelTargetId !== jobId
      || latest?.id !== jobId || !isWebsiteJobActive(latest)) return;
    const controller = new AbortController();
    flightRef.current = controller;
    pollFlightRef.current?.abort();
    pollFlightRef.current = null;
    setPending('cancel');
    setCancelNeedsCheck(true);
    setChecking(true);
    setError(null);
    setCancelError(null);
    setNote('Submitting the confirmed stop request. The job is not yet confirmed stopped.');
    setPublicationConfirmed(false);
    setPublishTarget(null);
    reportBusy(true);
    let confirmed = false;
    try {
      await websiteApi.cancel(restaurant.id, jobId, { confirmed: true }, controller.signal);
      if (controller.signal.aborted) return;
      confirmed = true;
      setCancelTargetId(null);
      setNote('Stop acknowledged. Reading current state; recorded model usage is retained. No automatic publication or restart.');
      const next = await websiteApi.get(restaurant.id, controller.signal);
      if (controller.signal.aborted) return;
      applyState(next, false);
      if (next.jobs.some(isWebsiteJobActive)) setReload(value => value + 1);
    } catch (caught) {
      if (!mountedRef.current || controller.signal.aborted) return;
      setChecking(false);
      setCancelTargetId(null);
      if (confirmed) {
        setLoadError(caught);
        setNote('Stop acknowledged, current state read failed. Check status; no stop or generation request will be resent.');
      } else {
        setCancelError(caught);
        if (isWebsiteWriteUncertain(caught)) {
          setNote('Stop result unknown. Check status; the job may still run. No stop or generation request is resent automatically.');
        } else {
          setCancelNeedsCheck(false);
          setNote('Stop was not acknowledged. Check current state before deciding; no automatic retry.');
          if (!(caught instanceof ApiError && caught.status === 401)) setReload(value => value + 1);
        }
      }
    } finally {
      if (flightRef.current === controller) {
        flightRef.current = null;
        reportBusy(false);
        if (mountedRef.current) setPending(null);
      }
    }
  }
  function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (modelLocked || !state || !draft.message.trim()) return;
    void run({ kind: 'chat', key: crypto.randomUUID(), body: { message: draft.message, expected_revision: state.agent.revision } });
  }
  function generate() {
    if (generationBlockers.length > 0) return;
    void run({ kind: 'generate', key: crypto.randomUUID(), body: {
      brief: draft.brief, asset_ids: [...draft.assetIds], public_assets_confirmed: true,
      ...(needsVision ? { image_vision_confirmed: true } : {}),
      expected_restaurant_revision: restaurant.revision, expected_menu_revision: state?.menu.revision ?? 0,
    } });
  }
  async function reviewPublication() {
    if (!selected || !preview || preview.versionId !== selected.id || preview.checksum !== selected.checksum || inputLocked || jobsActive || restaurantDirty || contentDirty || !active || reviewFlightRef.current) return;
    const candidateId = selected.id;
    const controller = new AbortController(); reviewFlightRef.current = controller; setReviewPending(true); setError(null);
    try {
      const report = await websiteContentClient.workbench(restaurant.id, candidateId, controller.signal);
      if (controller.signal.aborted || sessionRef.current.expired || !sessionRef.current.active || sessionRef.current.selectedId !== candidateId) return;
      const version = report.editing_version;
      if (!version || version.id !== candidateId || version.checksum !== preview.checksum) throw new ApiError(409, 'WEBSITE_CONTENT_REVIEW_REQUIRED');
      if (version.origin !== 'legacy' && !version.public_content_hash) throw new ApiError(409, 'WEBSITE_CONTENT_REVIEW_REQUIRED');
      const current = version.public_content_hash === report.current_public_content_hash;
      const input: WebsitePublishInput = { version_id: candidateId, expected_revision: report.publication.revision,
        ...(version.public_content_hash ? { expected_checksum: version.checksum, expected_public_content_hash: version.public_content_hash,
          content_mode: current ? 'current' as const : 'historical' as const, review_confirmed: true as const } : {}),
        ...(!report.publication.slug ? { slug } : {}) };
      setWorkbenchReport(report);
      const savedReview = contentReviewRef.current;
      const contentReview = savedReview && savedReview.restaurant_id === restaurant.id && savedReview.version_id === candidateId
        && savedReview.checksum === version.checksum && savedReview.public_content_hash === version.public_content_hash
        && report.publication.published_version_id !== candidateId ? structuredClone(savedReview) : savedContentReview(report);
      setPublishReview({ input, report, version, contentReview }); setPublishTarget(version); setPublicationConfirmed(true); setHistoricalConfirmed(false);
    } catch (caught) { if (!controller.signal.aborted) setError(caught); }
    finally { if (reviewFlightRef.current === controller) { reviewFlightRef.current = null; if (!controller.signal.aborted) setReviewPending(false); } }
  }
  const publishStale = !!publishReview && !!workbenchReport && (workbenchReport.publication.revision !== publishReview.input.expected_revision
    || workbenchReport.current_public_content_hash !== publishReview.report.current_public_content_hash);
  function publish() {
    if (publishStale || !publishReview || !publishTarget || selectedId !== publishTarget.id || preview?.versionId !== publishTarget.id || !state || inputLocked || jobsActive || !publicationConfirmed || publishReview.report.publication.deployment_mode !== 'local'
      || publicationNeedsCheck || checking || loadError || restaurantDirty || contentDirty || !['draft', 'active'].includes(restaurant.status)
      || ((publishReview.input.content_mode === 'historical' || publishReview.version.origin === 'legacy') && !historicalConfirmed)) return;
    if (publishReview.input.slug !== undefined && !websiteSlugPattern.test(publishReview.input.slug)) return;
    void run({ kind: 'publish', key: crypto.randomUUID(), body: structuredClone(publishReview.input) });
  }
  async function openPreview(version: WebsiteVersion) {
    if (!active || sessionRef.current.expired || previewFlightRef.current) return;
    closePreview();
    const controller = new AbortController();
    previewFlightRef.current = controller;
    setPreviewPending(true);
    setPreviewError(null);
    const created: string[] = [];
    try {
      const previewDoc = await websiteApi.preview(restaurant.id, version, controller.signal);
      const blobs = new Map<string, Blob>();
      const downloadUrls = new Map<string, string>();
      // 仅下载此版本列出的已知素材字节；原图 blob 地址用于新窗口预览与下载。
      for (const asset of previewDoc.assets) {
        const blob = await websiteApi.assetContent(restaurant.id, asset, controller.signal);
        if (controller.signal.aborted) return;
        blobs.set(asset.id, blob);
        const url = URL.createObjectURL(blob);
        created.push(url);
        downloadUrls.set(asset.id, url);
      }
      const inlineUrls = new Map<string, string>();
      const images: Array<{ id: string; length: number }> = [];
      for (const asset of previewDoc.assets) {
        if (asset.mime_type === 'application/pdf') {
          inlineUrls.set(asset.id, textDataUrl('Download the original menu PDF below the preview.'));
          continue;
        }
        const url = await previewImageUrl(blobs.get(asset.id)!);
        if (controller.signal.aborted) return;
        inlineUrls.set(asset.id, url);
        images.push({ id: asset.id, length: url.length });
      }
      const { documentUrl, reducedImages } = buildPreviewDocument(previewDoc.html, inlineUrls, images);
      const fullUrl = URL.createObjectURL(new Blob(
        [rewriteWebsitePreview(previewDoc.html, downloadUrls)],
        { type: 'text/html;charset=utf-8' },
      ));
      created.push(fullUrl);
      if (controller.signal.aborted) return;
      urlsRef.current = created;
      setPreview({
        versionId: version.id, versionNumber: version.version_number, checksum: previewDoc.checksum, documentUrl, fullUrl, reducedImages,
        pdfs: previewDoc.assets.filter(asset => asset.mime_type === 'application/pdf')
          .map(asset => ({ id: asset.id, url: downloadUrls.get(asset.id)! })),
        originals: previewDoc.assets.filter(asset => asset.mime_type !== 'application/pdf')
          .map((asset, index) => ({ id: asset.id, url: downloadUrls.get(asset.id)!,
            label: `image-${index + 1}.${asset.mime_type === 'image/png' ? 'png' : 'jpg'}` })),
      });
    } catch (caught) {
      if (mountedRef.current && !controller.signal.aborted) setPreviewError(caught);
    } finally {
      if (controller.signal.aborted || urlsRef.current !== created) created.forEach(url => URL.revokeObjectURL(url));
      if (previewFlightRef.current === controller) { previewFlightRef.current = null; setPreviewPending(false); }
    }
  }
  const publicUrl = state ? safeLocalPublicationUrl(state.publication.url, state.publication.slug) : null;
  const prefix = `website-${restaurant.id}`;
  const activeJobs = state?.jobs.filter(isWebsiteJobActive) ?? [];
  const generationJobs = [...(state?.jobs ?? [])].filter(job => job.kind === 'generate')
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  const generationWaiting = acknowledged?.kind === 'generate' && !generationJobs.some(job => job.id === acknowledged.job_id);
  const progressJob = generationWaiting ? undefined : generationJobs[0];
  const usageJobId = generationWaiting ? acknowledged?.job_id ?? null : progressJob?.id ?? null;
  const usage = useWebsiteUsage(restaurant.id, usageJobId, progressJob, active);
  const canStopGeneration = !!progressJob && isWebsiteJobActive(progressJob);
  useEffect(() => {
    setCancelTargetId(null);
  }, [restaurant.id, usageJobId, canStopGeneration]);

  useEffect(() => {
    if (!active || expired || !selectedId || preview?.versionId === selectedId || previewPending || autoPreviewRef.current === selectedId) return;
    autoPreviewRef.current = selectedId;
    const controller = new AbortController();
    const known = extraVersion?.id === selectedId ? extraVersion : state?.versions.find(version => version.id === selectedId);
    void (async () => {
      try {
        const version = known ?? await websiteContentClient.version(restaurant.id, selectedId, controller.signal);
        if (!controller.signal.aborted && sessionRef.current.active && !sessionRef.current.expired && sessionRef.current.selectedId === version.id) {
          if (!known) setExtraVersion(version);
          await openPreview(version);
        }
      } catch (caught) { if (!controller.signal.aborted) setPreviewError(caught); }
    })();
    return () => controller.abort();
  }, [active, expired, selectedId, preview?.versionId, previewPending, restaurant.id]);
  useEffect(() => { setPublishReview(null); setPublishTarget(null); setPublicationConfirmed(false); }, [selectedId, restaurant.revision, contentDirty]);
  useEffect(() => {
    if (!active) { reviewFlightRef.current?.abort(); reviewFlightRef.current = null; setReviewPending(false); setPublishReview(null); autoPreviewRef.current = null; }
    return () => { reviewFlightRef.current?.abort(); };
  }, [active]);
  const selectVersion = useCallback((version: WebsiteContentVersion) => {
    if (contentReviewRef.current?.version_id !== version.id) contentReviewRef.current = null;
    setExtraVersion(version); setSelectedId(version.id); setPublicationConfirmed(false); setPublishTarget(null); setPublishReview(null);
    autoPreviewRef.current = null;
  }, []);
  const reportChanged = useCallback((report: WebsiteWorkbenchReport | null) => {
    if (!report || report.publication.published_version_id === contentReviewRef.current?.version_id) contentReviewRef.current = null;
    setWorkbenchReport(report);
  }, []);
  const contentReviewChanged = useCallback((review: WebsiteContentReview | null) => {
    if (sessionRef.current.expired) return;
    contentReviewRef.current = review?.restaurant_id === restaurant.id ? structuredClone(review) : null;
    setPublishReview(null); setPublishTarget(null); setPublicationConfirmed(false); setHistoricalConfirmed(false);
  }, [restaurant.id]);
  useEffect(() => {
    const review = contentReviewRef.current;
    if (review && (review.restaurant_id !== restaurant.id || review.version_id !== selectedId || review.version_id === state?.publication.published_version_id)) contentReviewRef.current = null;
  }, [restaurant.id, selectedId, state?.publication.published_version_id]);
  const contentChanged = useCallback((value: boolean) => { setContentDirty(value); }, []);
  const contentRequestChanged = useCallback((value: boolean) => { setContentBusy(value); }, []);
  const status = <>
    <ErrorMessage error={loadError} readOnly /><ErrorMessage error={error} submissionUnknown={!!attempt && isWebsiteWriteUncertain(error)} /><ErrorMessage error={cancelError} cancellation />
    {pending && <p role="status" className="wb-small">{pending === "retry" ? "Checking the original request…" : pending === "cancel" ? "Stopping and checking…" : "Submitting request…"}</p>}
    {note && <p className="wb-notice" role="status">{note}</p>}
    {attempt && !pending && <section className="wb-notice" aria-labelledby={`${prefix}-uncertain`}><h3 id={`${prefix}-uncertain`}>Request result unknown</h3><p>Original input and request key are retained. Check result before retrying the same request; never start a replacement request automatically.</p>
      {attempt.kind === "generate" && <p className="wb-small">{attempt.body.image_vision_confirmed === true ? "The original request includes separate image consent. Retry preserves it." : "The original request has no image consent. Retry will not add permission."}</p>}
      {attempt.kind === "publish" && <p className="wb-small">Fixed publication target: {attempt.body.version_id}. Preview selection cannot change this request.</p>}
      <button type="button" disabled={busy || contentBusy || !active} onClick={() => void run(attempt, true)}>Check result / Retry same request</button><button type="button" disabled={discardDisabled} onClick={discardDraft}>Discard local request</button>
    </section>}
    {jobsActive && <p className="wb-notice" role="status">A background job is active. You can read content, preview saved versions, and open history. New changes must wait.</p>}
    <AgentProgress job={progressJob} waiting={!!generationWaiting} stale={!!loadError || cancelNeedsCheck} headingId={`${prefix}-agent-progress`} />
    {canStopGeneration && progressJob && <section className="wb-notice"><h3>Stop this generation</h3>{cancelTargetId === progressJob.id ? <><p>Stop this job? It will not publish or restart. Model usage already recorded is retained.</p><button type="button" disabled={!active || busy || contentBusy || pending !== null || cancelNeedsCheck} onClick={() => void stopGeneration(progressJob.id)}>Confirm stop</button><button type="button" disabled={pending === "cancel"} onClick={() => setCancelTargetId(null)}>Keep running</button></> : <button type="button" disabled={!active || busy || contentBusy || pending !== null || cancelNeedsCheck} onClick={() => setCancelTargetId(progressJob.id)}>Stop generation</button>}{cancelNeedsCheck && <p>Stop result requires a manual check.</p>}</section>}
    <details onToggle={event => { if (!event.currentTarget.open) usage.close(); }}><summary>Model usage · observation mode</summary><WebsiteUsagePanel usage={usage} jobId={usageJobId} active={active} headingId={`${prefix}-usage-title`} /></details>
    {!!activeJobs.length && <details><summary>Active jobs</summary>{activeJobs.map(job => <p key={job.id}>{job.kind} · {job.status} · {formatTime(job.created_at)}</p>)}</details>}
    <button type="button" disabled={pending !== null || !active} onClick={() => setReload(value => value + 1)}>Check website status</button>
  </>;
  const design = <>
    <section className="website-section" aria-labelledby={`${prefix}-generate-title`}><h3 id={`${prefix}-generate-title`}>Create a new AI design</h3><p className="wb-small">A new AI-generated layout using saved restaurant facts. AI edits to an existing design are not available yet. Nothing publishes automatically.</p>
      {!state?.model_configured && <p className="wb-notice">Design generation is unavailable. Content updates and saved previews do not require AI.</p>}
      <label className="field" htmlFor={`${prefix}-brief`}>Design brief<textarea id={`${prefix}-brief`} rows={4} maxLength={3000} value={draft.brief} disabled={inputLocked} onChange={event => updateDraft({ ...draft, brief: event.target.value, confirmed: false })} placeholder="Describe the layout, style and what to highlight." /></label>
      <details><summary>Saved facts & menu</summary><p>{restaurant.name} · {state?.menu.status === "confirmed" ? `${state.menu.item_count} confirmed menu items` : "No confirmed menu"}</p><p className="wb-small">Missing facts: {restaurant.readiness.missing_fields.join(", ") || "None reported"}</p><dl className="website-facts">{profileFields.map(field => <div key={field.key}><dt>{field.key}</dt><dd>{restaurant[field.key] || "Not set"}</dd></div>)}</dl></details>
      <div className="row-heading"><h3>Public assets</h3><button type="button" disabled={inputLocked || assetsLoading} onClick={() => setAssetReload(value => value + 1)}>Refresh assets</button></div>
      <p className="wb-small">Choose up to 8 real uploads. At most one logo and one menu file. Menu images / PDF are not sent for design vision analysis.</p>
      {assetsLoading && <p role="status">Reading assets…</p>}<ErrorMessage error={assetsError} readOnly />
      {!assetsLoading && !assets.length && <p className="wb-small">No available uploads. A text-only design is supported.</p>}
      <ul className="website-asset-options">{assets.map(asset => <li key={asset.id}><label className="check-field"><input type="checkbox" checked={draft.assetIds.includes(asset.id)} disabled={inputLocked || assetsLoading || (!draft.assetIds.includes(asset.id) && (draft.assetIds.length >= 8 || (["menu_source", "logo"].includes(asset.kind) && assets.some(chosen => chosen.kind === asset.kind && draft.assetIds.includes(chosen.id)))))} onChange={event => updateDraft({ ...draft, confirmed: false, assetIds: event.target.checked ? [...draft.assetIds, asset.id] : draft.assetIds.filter(id => id !== asset.id) })} /><span>{asset.original_filename}<span className="micro">{kindLabels[asset.kind]} · {asset.mime_type === "application/pdf" ? "PDF (download only)" : "Uploaded image"}</span></span></label></li>)}</ul>
      {draft.assetIds.length > 0 && <ul className="website-selected-assets" aria-label="Selected asset thumbnails">{selectedAssets.map((asset, index) => <li key={draft.assetIds[index]}>{asset ? <WebsiteAssetThumbnail restaurantId={restaurant.id} asset={asset} selected active={active} /> : <p>Selected asset unavailable. Remove and review the selection.</p>}</li>)}</ul>}
      {assetsTruncated && <p className="wb-small">Showing the first 100 available assets.</p>}{missingSelected && <p className="wb-notice">An asset is unavailable. Select available uploads and confirm again.</p>}
      <label className="check-field website-confirmation"><input type="checkbox" checked={factsConfirmed} disabled={inputLocked || assetsLoading || !!assetsError || missingSelected} onChange={event => { confirmedRevisionRef.current = restaurant.revision; updateDraft({ ...draft, confirmed: event.target.checked }); }} /><span>I confirm the saved facts and permission to publish these assets. This does not authorize image sharing with AI.</span></label>
      {needsVision ? <div className="website-vision-consent"><p id={`${prefix}-vision-help`} className="wb-small">Only selected restaurant, dish and logo thumbnails are sent to DeepSeek for layout analysis. This is not menu OCR. Menu images / PDF are not sent. Multiple model calls may be needed. Local thumbnails do not mean AI has seen the images.</p><label className="check-field website-confirmation"><input type="checkbox" checked={visionConfirmed} disabled={inputLocked || assetsLoading || !!assetsError || missingSelected} aria-describedby={`${prefix}-vision-help`} onChange={event => { visionRevisionRef.current = restaurant.revision; updateDraft({ ...draft, visionConfirmed: event.target.checked }); }} /><span>I separately authorize sending selected photo / logo thumbnails to DeepSeek. Changing the brief, selection or restaurant revision requires confirmation again.</span></label></div> : <p className="wb-small">No image sharing consent is requested for this selection. Menu images / PDF remain in the existing menu workflow.</p>}
      <div className="save-row"><button type="button" className="primary-button" disabled={generationBlockers.length > 0} aria-describedby={`${prefix}-generation-blockers`} onClick={generate}>Create draft</button><button type="button" disabled={discardDisabled} onClick={discardDraft}>Discard design changes</button></div>
      <div id={`${prefix}-generation-blockers`} className="wb-small" aria-live="polite">{generationBlockers.length > 0 ? <><p>Before creating a draft</p><ul>{generationBlockers.map(reason => <li key={reason}>{reason}</li>)}</ul></> : <p>Creates a real background job. Preview opens when the saved version is ready. Nothing publishes automatically.</p>}</div>
    </section>
    <details><summary>Ask about design</summary><ol className="website-messages">{state?.agent.messages.map((message, index) => <li key={index}><span>{message.role === "user" ? "You" : "Design assistant"}</span><p>{message.content}</p></li>)}</ol><form onSubmit={sendMessage}><label className="field" htmlFor={`${prefix}-message`}>Optional question<textarea id={`${prefix}-message`} rows={3} maxLength={2000} value={draft.message} disabled={inputLocked} onChange={event => updateDraft({ ...draft, message: event.target.value })} /></label><button type="submit" disabled={modelLocked || !draft.message.trim()}>Send question</button></form></details>
  </>;
  const previewPanel = <>
    {previewPending && <p role="status">Loading the saved preview…</p>}<ErrorMessage error={previewError} readOnly />
    {preview ? <section className="website-preview"><div className="row-heading"><h3>Preview v{preview.versionNumber}{preview.versionId === state?.publication.published_version_id ? " · Published" : " · Saved, not published"}</h3><div role="group" aria-label="Preview size"><button type="button" aria-pressed={viewport === "desktop"} onClick={() => setViewport("desktop")}>Desktop</button><button type="button" aria-pressed={viewport === "mobile"} onClick={() => setViewport("mobile")}>Mobile</button></div></div><p className="wb-small">Isolated saved preview. Scripts, forms, same-origin access and network connections are disabled.</p>
      <div className={`website-preview-frame ${viewport}`}><iframe key={preview.versionId} src={preview.documentUrl} sandbox="allow-popups allow-popups-to-escape-sandbox allow-downloads" referrerPolicy="no-referrer" title={`Website preview: ${restaurant.name}`} /></div>
      <a href={preview.fullUrl} target="_blank" rel="noopener noreferrer">Open full preview</a>
      {preview.reducedImages > 0 && <p className="wb-small">{preview.reducedImages} images could not fit in the isolated preview. Open the full preview or download originals.</p>}
      <div className="button-row">{preview.originals.map(image => <a key={image.id} href={image.url} download={image.label} rel="noopener">Download {image.label}</a>)}{preview.pdfs.map(pdf => <a key={pdf.id} href={pdf.url} download={`menu-${pdf.id}.pdf`} rel="noopener">Download original menu PDF</a>)}</div>
      <button type="button" onClick={() => { autoPreviewRef.current = preview.versionId; closePreview(); }}>Close preview</button>
    </section> : !previewPending && <div className="wb-notice"><p>{selected ? "The saved preview is not open." : "Create a draft to preview your website."}</p>{selected && <button type="button" disabled={!active} onClick={() => void openPreview(selected)}>Open saved preview</button>}</div>}
  </>;
  const publicationPanel = <section className="wb-publication"><p className="wb-small">{publicUrl ? "Local test only · not a public domain" : "Publishing requires the local deployment service."}{publishedNumber ? ` · Published v${publishedNumber}` : ""}</p>
    {publicationNeedsCheck && <p className="wb-notice">Original publication was acknowledged. Current publication still needs a read check; do not resubmit.</p>}
    <button type="button" className="primary-button" disabled={!preview || !selected || preview.versionId !== selected.id || inputLocked || jobsActive || contentDirty || restaurantDirty || !!loadError || publicationNeedsCheck || state?.publication.deployment_mode !== "local"} onClick={() => void reviewPublication()}>{reviewPending ? "Reading review…" : preview ? `Publish preview v${preview.versionNumber}` : "Publish saved preview"}</button>
    {publishReview && publishTarget && publicationConfirmed && <section className="wb-review" role="dialog" aria-modal="false" aria-labelledby={`${prefix}-publish-review`}><h3 id={`${prefix}-publish-review`}>Review preview v{publishReview.version.version_number}</h3>{publishStale && <p role="alert">Saved facts or publication changed. Cancel and review this draft again.</p>}<p>Target: {publishReview.version.id}</p><p className="wb-small">Publication revision {publishReview.input.expected_revision}. This publishes only the reviewed website; it never restores restaurant or menu data.</p>
      {!publishReview.report.publication.slug && <label className="field" htmlFor={`${prefix}-slug`}>Local website path<input id={`${prefix}-slug`} value={slug} minLength={3} maxLength={50} pattern={websiteSlugPattern.source} disabled={pending !== null || !!attempt} onChange={event => { setSlug(event.target.value); setPublishReview(current => current ? { ...current, input: { ...current.input, slug: event.target.value } } : null); }} /><span className="wb-small">3–50 lowercase letters / digits / hyphens. Not a domain registration.</span></label>}
      {publishReview.contentReview ? <WebsiteContentReviewPanel review={publishReview.contentReview} /> : publishReview.version.origin === 'content_refresh' && <p className="wb-small">The previous content-save comparison is not retained in this session. Review the saved preview; current restaurant differences below are not a comparison with the published website.</p>}
      {(publishReview.input.content_mode === "historical" || publishReview.version.origin === 'legacy') && <><p className="wb-notice">This draft contains historical facts that differ from the saved restaurant. Review the differences before restoring this website.</p><h4>Historical version vs saved restaurant</h4><WebsiteDifferences differences={publishReview.report.differences} beforeLabel="Historical version" afterLabel="Saved restaurant" /><label className="wb-check"><input type="checkbox" checked={historicalConfirmed} disabled={pending !== null || !!attempt} onChange={event => setHistoricalConfirmed(event.target.checked)} />I reviewed the historical facts. Publish this website without restoring restaurant data.</label></>}
      <button type="button" className="primary-button" disabled={publishStale || inputLocked || jobsActive || contentDirty || restaurantDirty || ((publishReview.input.content_mode === "historical" || publishReview.version.origin === 'legacy') && !historicalConfirmed) || (publishReview.input.slug !== undefined && !websiteSlugPattern.test(publishReview.input.slug))} onClick={publish}>Confirm publish</button><button type="button" disabled={pending !== null} onClick={() => { setPublishTarget(null); setPublishReview(null); setPublicationConfirmed(false); }}>Cancel</button>
    </section>}
  </section>;
  if (expired) return <p role="alert">Session expired. Sign in again; original requests will not be replayed.</p>;
  return <WebsiteWorkbench restaurantId={restaurant.id} active={active} busy={busy || pending !== null || !!attempt || reviewPending} restaurantDirty={restaurantDirty} selectedId={selectedId} previewVersion={preview ? { id: preview.versionId, version_number: preview.versionNumber } : undefined}
    refreshToken={`${restaurant.revision}:${state?.menu.revision ?? 0}:${state?.publication.revision ?? 0}:${jobsActive}:${reload}`} design={design} preview={previewPanel} status={status} publication={publicationPanel}
    onPreview={selectVersion} onReport={reportChanged} onSaved={onContentSaved} onContentReview={contentReviewChanged} onDirtyChange={contentChanged} onBusyChange={contentRequestChanged} />;
}
