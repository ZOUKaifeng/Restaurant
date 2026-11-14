import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from './api';
import { assetApi } from './asset-api';
import type { Asset, AssetKind } from './assets-types';
import { profileFields } from './profile';
import type { Restaurant } from './types';
import {
  isWebsiteJobActive, isWebsiteWriteUncertain, safeLocalPublicationUrl,
  websiteApi, websiteErrorMessage, websiteJobErrorMessage, websiteSlugPattern,
} from './website-api';
import {
  buildPreviewDocument, previewImageUrl, rewriteWebsitePreview, textDataUrl,
} from './website-preview';
import type { WebsiteAccepted, WebsiteAttempt, WebsiteDiagnostic, WebsiteJob, WebsiteModelCall, WebsiteProgress, WebsiteState, WebsiteUsage, WebsiteVersion } from './website-types';

type Draft = { brief: string; assetIds: string[]; message: string; confirmed: boolean };
type Saved = Pick<Draft, 'brief' | 'assetIds'>;
type Preview = {
  versionId: string; checksum: string; documentUrl: string; fullUrl: string; reducedImages: number;
  pdfs: Array<{ id: string; url: string }>; originals: Array<{ id: string; url: string; label: string }>;
};

type Acknowledged = WebsiteAccepted & { kind: 'chat' | 'generate' };
const kindLabels: Record<AssetKind, string> = { menu_source: '菜单原文件', logo: 'Logo', restaurant_photo: '餐厅图片', dish_photo: '菜品图片' };
const jobLabels = { queued: '排队中', running: '正在处理', succeeded: '已完成', failed: '已失败' };
const phaseLabels: Record<WebsiteProgress['phase'], string> = {
  planning: '制定建站计划', writing: '编写网页草稿', checking: '执行真实检查',
  repairing: '根据检查结果修复', ready: '检查通过', failed: '已停止',
};
const planStatusLabels = { pending: '待办', in_progress: '进行中', completed: '已完成' };
const callStatusLabels = { started: '进行中', completed: '已完成', failed: '已失败' };
function countLabel(value: number | null | undefined) { return value == null ? '未知' : value.toLocaleString('zh-CN'); }
function elapsedLabel(value: number | null | undefined) { return value == null ? '未知' : `${value.toLocaleString('zh-CN')} ms`; }
function roundLabel(round: number) { return round === 0 ? '准备第1稿' : round === 1 ? '第1稿' : `修复第${round - 1}轮`; }
function ModelCallCounts({ call }: { call: WebsiteModelCall }) {
  return <p className="micro">调用 #{call.index} · {callStatusLabels[call.status]} · 输入 {countLabel(call.prompt_tokens)} / 输出 {countLabel(call.completion_tokens)} / 总计 {countLabel(call.total_tokens)} tokens · 耗时 {elapsedLabel(call.elapsed_ms)}{[call.prompt_tokens, call.completion_tokens, call.total_tokens].some(value => value === null) && ' · 未知用量不按 0 计算'}</p>;
}
function Diagnostics({ items }: { items: WebsiteDiagnostic[] }) {
  return <ul className="website-diagnostics" aria-label="服务端检查诊断">{items.map((item, index) => <li key={index}>
    <span className="website-diagnostic-location">{item.file} · 行 {item.line} / 列 {item.column} · <code>{item.code}</code></span>
    <p>{item.message}</p>
  </li>)}</ul>;
}
function AgentProgress({ job, waiting, stale, headingId }: {
  job: WebsiteJob | undefined; waiting: boolean; stale: boolean; headingId: string;
}) {
  const progress = job?.progress;
  const trace = job?.trace ?? [];
  const diagnostics = progress?.diagnostics ?? [...trace].reverse().find(item => !item.model_call && !/model|模型/i.test(item.action) && item.diagnostics.length)?.diagnostics ?? [];
  const failed = job?.status === 'failed';
  return <section className="website-section website-agent-progress" aria-labelledby={headingId}>
    <div className="row-heading"><h3 id={headingId}>Agent建站进度</h3>{job && <time className="micro" dateTime={job.created_at}>{formatTime(job.created_at)}</time>}</div>
    <div aria-live="polite">
      {stale && <p className="micro">以下为上次成功读取的记录；状态核查已停止，请手动核查，不代表后台已停止。</p>}
      {waiting ? <p>生成任务已受理，等待服务端持久进度；尚不能确认已开始写稿。</p>
        : !job ? <p className="micro">尚无生成任务。提交后读取服务端计划、草稿检查与修复记录，不模拟进度。</p>
          : <>
            <p>当前步骤：{failed ? '已停止' : progress ? phaseLabels[progress.phase] : jobLabels[job.status]}
              {progress && <> · {progress.round === 0 && progress.phase === 'planning' ? '准备第1稿' : roundLabel(progress.round)}</>}</p>
            {progress ? <><p className="micro">已知模型调用 {countLabel(progress.model_calls)} 次 · 已知输入 {countLabel(progress.prompt_tokens)} / 输出 {countLabel(progress.completion_tokens)} / 累计 {countLabel(progress.total_tokens)} tokens · 耗时 {elapsedLabel(progress.elapsed_ms)}（服务端计数）</p><p className="micro">累计仅代表服务端已知用量；未返回的 token 计数为未知，不按 0 计算，不据此估算费用。</p></>
              : <p className="micro">此任务未提供进度；模型调用次数和 tokens 未知，不按任务数估算。</p>}
            {failed ? <p className="notice">{websiteJobErrorMessage(job.error_code)} 新生成须由你重新核对并点击下方生成按钮，可能产生新费用。</p>
              : job.status === 'succeeded' && progress?.phase === 'ready' ? <p className="notice">检查通过，等待你预览发布</p> : null}
          </>}
    </div>
    {progress && <ol className="website-agent-plan" aria-label="Agent建站计划">{progress.plan.map(item => <li key={item.id}>
      <span className={`website-plan-status ${item.status}`}>{planStatusLabels[item.status]}</span><span>{item.title}</span>
    </li>)}</ol>}
    {progress?.plan.length === 0 && <p className="micro">服务端尚未返回计划条目。</p>}
    {diagnostics.length > 0 && <div className="website-agent-checks"><h3>检查结果</h3><Diagnostics items={diagnostics} /><p className="micro">行 / 列为 0 表示服务端未提供具体位置；这里只展示诊断，不展示私有草稿。</p></div>}
    {job && <details className="website-agent-details"><summary>模型与工具详情（服务端记录）</summary>
      <p className="micro">{progress ? `此任务已知调用 ${progress.model_calls} 次，累计 ${progress.total_tokens.toLocaleString('zh-CN')} tokens。` : '此任务调用与 tokens 未知。'} 仅读取后端进度与工具轨迹；计数不是金额，不估算实际费用。</p>
      {trace.length ? <ol className="website-agent-trace">{trace.map((item, index) => <li key={index}>
        <p>{item.round === 0 ? '计划阶段' : roundLabel(item.round)} · {item.action} · {item.model_call ? callStatusLabels[item.model_call.status] : item.status === 'ok' ? '完成' : '错误'}</p>
        {item.model_call ? <ModelCallCounts call={item.model_call} /> : /model|模型/i.test(item.action) ? <p className="micro">此旧模型记录未提供逐次用量；不展示模型输入、输出或请求内容。</p> : <><p>{item.message}</p>{item.diagnostics.length > 0 && <Diagnostics items={item.diagnostics} />}</>}
      </li>)}</ol> : <p className="micro">暂无工具轨迹；不代表已执行真实检查。</p>}
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
    if (!item || typeof item.key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(item.key) || !item.body) return null;
    const validRevision = (value: number) => Number.isSafeInteger(value) && value >= 0;
    if (item.kind === 'chat' && typeof item.body.message === 'string' && item.body.message.trim() && item.body.message.length <= 2000 && validRevision(item.body.expected_revision)) {
      return { kind: 'chat', key: item.key, body: { message: item.body.message, expected_revision: item.body.expected_revision } };
    }
    if (item.kind === 'generate' && typeof item.body.brief === 'string' && item.body.brief.trim() && item.body.brief.length <= 3000
      && Array.isArray(item.body.asset_ids) && item.body.asset_ids.length <= 8 && new Set(item.body.asset_ids).size === item.body.asset_ids.length
      && item.body.asset_ids.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(id))
      && item.body.public_assets_confirmed === true && validRevision(item.body.expected_restaurant_revision) && item.body.expected_restaurant_revision >= 1) {
      return { kind: 'generate', key: item.key, body: {
        brief: item.body.brief, asset_ids: [...item.body.asset_ids], public_assets_confirmed: true,
        expected_restaurant_revision: item.body.expected_restaurant_revision,
        ...(item.body.expected_menu_revision === undefined ? {} : Number.isSafeInteger(item.body.expected_menu_revision) && item.body.expected_menu_revision >= 0 ? { expected_menu_revision: item.body.expected_menu_revision } : {}),
      } };
    }
    if (item.kind === 'publish' && typeof item.body.version_id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(item.body.version_id) && validRevision(item.body.expected_revision)
      && (item.body.slug === undefined || (typeof item.body.slug === 'string' && websiteSlugPattern.test(item.body.slug)))) {
      return { kind: 'publish', key: item.key, body: {
        version_id: item.body.version_id, expected_revision: item.body.expected_revision,
        ...(item.body.slug === undefined ? {} : { slug: item.body.slug }),
      } };
    }
  } catch { /* 本地重试存储不可用时，不发起任何请求。 */ }
  return null;
}
function ErrorMessage({ error, readOnly = false, submissionUnknown = false, cancellation = false }: {
  error: unknown; readOnly?: boolean; submissionUnknown?: boolean; cancellation?: boolean;
}) {
  if (!error) return null;
  const readFailed = readOnly && error instanceof ApiError && (error.status === 0 || error.code === 'RESPONSE_INVALID');
  return <div className="notice error-notice" role="alert">
    {submissionUnknown && <p>提交结果未知，不能据此认定后台任务已失败。原输入和幂等键保留。</p>}
    <p>{cancellation && isWebsiteWriteUncertain(error) ? '停止请求结果未知，不代表后台已停止。请手动核查网页状态；不会自动重发停止或生成请求。'
      : readFailed ? '读取失败，保留上次读取的资料。请手动核查状态；不会因此重放写请求。' : websiteErrorMessage(error)}</p>
  </div>;
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
function WebsiteUsagePanel({ usage, jobId, active, headingId }: {
  usage: ReturnType<typeof useWebsiteUsage>; jobId: string | null; active: boolean; headingId: string;
}) {
  const data = usage.data;
  const legacy = data?.legacy_summary;
  return <section className="website-section" aria-labelledby={headingId}>
    <div className="row-heading"><h3 id={headingId}>本次生成用量</h3><div className="button-row"><button type="button" disabled={!jobId || !active || usage.pending} aria-expanded={usage.opened} onClick={() => void usage.load()}>{usage.pending ? '正在读取用量…' : usage.error ? '重试读取用量' : '查看本次用量'}</button>{usage.opened && <button type="button" className="text-button" onClick={usage.close}>关闭用量详情</button>}</div></div>
    <p className="micro">仅查询最近一次生成；打开详情后按调用结束刷新，原请求仍在结算时每 5 秒只读核对账单。关闭详情、切换面板或读取失败即停止核对，不重发任务、不改变业务状态。仅展示计数，不展示模型原始输入、输出或顾客信息。</p>
    {usage.settling && <p className="micro" role="status">原请求仍在结算，自动核对账单</p>}
    {usage.pending && <p className="micro loading-text" role="status">正在读取逐次模型用量…</p>}
    <ErrorMessage error={usage.error} readOnly />
    {!!usage.error && <p className="micro">用量可能已变化，保留上次成功读取的计数；请手动再次查看，不会因此重试生成。</p>}
    {legacy ? <div className="notice" role="status">
      <p>{legacy.total_tokens === null ? '旧任务累计未知' : `旧任务仅记录累计 ${legacy.total_tokens} tokens`}，输入/输出分项未知，不能补造。</p>
      <p className="micro">已记录模型调用 {countLabel(legacy.model_calls)} 次，但没有逐调用账单；不能补造每次输入、输出或总用量，也不按 0 计算。接口 totals 仅汇总新逐调用账单，不代表此旧任务的累计。</p>
    </div> : data ? <>
      <p className="micro" aria-live="polite">已知输入 {countLabel(data.totals.prompt_tokens)} / 输出 {countLabel(data.totals.completion_tokens)} / 总计 {countLabel(data.totals.total_tokens)} tokens（不是费用）</p>
      {data.unknown_usage_calls > 0 && <p className="notice" role="status">{countLabel(data.unknown_usage_calls)} 次调用的 token 用量未知，不按 0 计算；已知累计不是完整用量，费用仍可能增加。</p>}
      {data.calls.length ? <div style={{ overflowX: 'auto' }}><table><caption>本次模型调用的输入、输出与总用量</caption><thead><tr><th scope="col">调用</th><th scope="col">状态</th><th scope="col">输入 tokens</th><th scope="col">输出 tokens</th><th scope="col">总计 tokens</th><th scope="col">耗时</th></tr></thead><tbody>{[...data.calls].sort((a, b) => a.index - b.index).map(call => <tr key={call.index}><th scope="row">#{call.index}</th><td>{callStatusLabels[call.status]}</td><td>{countLabel(call.prompt_tokens)}</td><td>{countLabel(call.completion_tokens)}</td><td>{countLabel(call.total_tokens)}</td><td>{elapsedLabel(call.elapsed_ms)}</td></tr>)}</tbody></table></div> : <p className="micro">服务端尚无调用记录；不代表无需费用。</p>}
    </> : <p className="micro">{usage.opened ? '尚未成功读取本次用量，计数未知。' : jobId ? '点击按钮读取本次生成的实际用量。' : '尚无生成任务，用量未知。'}</p>}
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

export default function WebsitePanel({ restaurant, active, busy, restaurantDirty, onBusyChange, onJobsChange, onDirtyChange, onRestaurantConflict }: {
  restaurant: Restaurant;
  active: boolean;
  busy: boolean;
  restaurantDirty: boolean;
  onBusyChange: (busy: boolean) => void;
  onJobsChange: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  onRestaurantConflict: () => void;
}) {
  const [attempt, setAttempt] = useState<WebsiteAttempt | null>(() => restoreAttempt(restaurant.id));
  const [state, setState] = useState<WebsiteState | null>(null);
  const [draft, setDraft] = useState<Draft>(() => ({
    brief: attempt?.kind === 'generate' ? attempt.body.brief : '',
    assetIds: attempt?.kind === 'generate' ? [...attempt.body.asset_ids] : [],
    message: attempt?.kind === 'chat' ? attempt.body.message : '',
    confirmed: attempt?.kind === 'generate',
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
  const serverBriefRef = useRef('');
  const observedJobsRef = useRef(new Set<string>());
  const flightRef = useRef<AbortController | null>(null);
  const pollFlightRef = useRef<AbortController | null>(null);
  const previewFlightRef = useRef<AbortController | null>(null);
  const urlsRef = useRef<string[]>([]);
  const callbacksRef = useRef({ onBusyChange, onJobsChange, onDirtyChange, onRestaurantConflict });
  const mountedRef = useRef(false);
  draftRef.current = draft;
  savedRef.current = saved;
  attemptRef.current = attempt;
  stateRef.current = state;
  acknowledgedRef.current = acknowledged;
  callbacksRef.current = { onBusyChange, onJobsChange, onDirtyChange, onRestaurantConflict };
  const jobsActive = !!acknowledged || !!state?.jobs.some(isWebsiteJobActive);
  const dirty = !!attempt || !!draft.message || draft.brief !== saved.brief || !sameIds(draft.assetIds, saved.assetIds);

  const updateDraft = useCallback((next: Draft) => { draftRef.current = next; setDraft(next); }, []);
  const updateSaved = useCallback((next: Saved) => { savedRef.current = next; setSaved(next); }, []);
  const keepAttempt = useCallback((next: WebsiteAttempt | null) => {
    attemptRef.current = next;
    setAttempt(next);
    try {
      if (next) sessionStorage.setItem(storageKey(restaurant.id), JSON.stringify(next));
      else sessionStorage.removeItem(storageKey(restaurant.id));
    } catch {
      if (next) setNote('浏览器未允许保存重试信息；本次幂等键仍保留在内存。结果未知时请勿刷新或离开。');
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
      callbacksRef.current.onBusyChange(false);
      callbacksRef.current.onJobsChange(false);
    };
  }, []);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onJobsChange(jobsActive); }, [jobsActive, onJobsChange]);
  useEffect(() => {
    if (active) return;
    closePreview();
    setCancelTargetId(null);
    if (flightRef.current) {
      flightRef.current.abort();
      flightRef.current = null;
      setPending(null);
      callbacksRef.current.onBusyChange(false);
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
    if (selectGeneratedVersion && completed?.result_version_id) {
      setSelectedId(completed.result_version_id);
      setPublicationConfirmed(false);
      setPublishTarget(null);
      setNote('新网页版本已生成。请点击“预览此版本”，检查后再单独确认本地发布。');
    } else if (selectGeneratedVersion && first) setSelectedId(current => current ?? [...next.versions].sort((a, b) => b.version_number - a.version_number)[0]?.id ?? null);
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
    if (!active) return;
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
  }, [active, restaurant.id, reload, applyState]);

  useEffect(() => {
    if (!active) return;
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
        setAssets(items.slice(0, 100).filter(item => item.origin === 'upload' && item.status === 'ready' && item.safety_status === 'approved'));
        setAssetsTruncated(more);
      } catch (caught) { if (!controller.signal.aborted) setAssetsError(caught); }
      finally { if (!controller.signal.aborted) setAssetsLoading(false); }
    }
    void loadAssets();
    return () => controller.abort();
  }, [active, restaurant.id, assetReload]);

  const selected = state?.versions.find(version => version.id === selectedId) ?? null;
  const publishedNumber = state?.versions.find(version => version.id === state.publication.published_version_id)?.version_number;
  const rollback = !!selected && !!state?.publication.published_version_id && (publishedNumber === undefined
    ? selected.version_number < Math.max(...state.versions.map(version => version.version_number))
    : selected.version_number < publishedNumber);
  const inputLocked = busy || pending !== null || !!attempt || loading || checking || !active;
  const paidLocked = inputLocked || jobsActive || cancelNeedsCheck || checking || loading || !!loadError || !state?.model_configured || restaurantDirty
    || !['draft', 'active'].includes(restaurant.status);
  const missingSelected = draft.assetIds.some(id => !assets.some(asset => asset.id === id));
  const factsConfirmed = draft.confirmed && confirmedRevisionRef.current === restaurant.revision;
  const menuNeedsConfirm = !!state && state.menu.item_count > 0 && state.menu.status !== 'confirmed';
  const generationBlockers = ([
    [!active, '当前建站面板未激活。'],
    [busy, '工作区正在处理其他操作，请等待结束。'],
    [pending !== null, '当前请求正在提交或核查，请等待结束。'],
    [!!attempt, '旧请求结果待确认，请先核查原请求，不能直接发起新生成。'],
    [loading, '正在首次读取网页状态。'],
    [checking, '正在核查网页任务与版本。'],
    [!!loadError, '网页状态读取失败，请先手动核查成功。'],
    [cancelNeedsCheck, '停止请求结果待核查，请先手动读取网页状态，不要重复生成。'],
    [!state, '尚未读到可确认的后端网页状态。'],
    [!!state && !state.model_configured, '网页模型未配置，不能生成；不会使用模拟结果。'],
    [jobsActive, '已有后台建站或对话任务，请等待完成。'],
    [restaurantDirty, '餐厅资料或菜单未保存，或版本待核对；请先保存并确认。'],
    [!['draft', 'active'].includes(restaurant.status), '当前餐厅状态不允许生成，请核对餐厅状态。'],
    [menuNeedsConfirm, '结构化菜单尚未确认，请到菜单识图中人工确认。'],
    [!draft.brief.trim(), '官网需求摘要为空，请填写摘要。'],
    [!factsConfirmed, '尚未确认当前版本的餐厅事实与素材公开权限，请勾选确认。'],
    [assetsLoading, '正在读取可选素材，请等待结束。'],
    [!!assetsError, '素材读取失败，请刷新可选素材。'],
    [missingSelected, '所选素材不在最新可用列表中，请移除不可用选择并重新确认。'],
  ] satisfies Array<[boolean, string]>).filter(([blocked]) => blocked).map(([, reason]) => reason);

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
        setNote('原操作已处理，发布回执不代表当前版本；正在重新读取当前发布状态。');
        try {
          const next = await websiteApi.get(restaurant.id, signal);
          if (signal.aborted) return;
          applyState(next, false);
          setNote('原操作已处理，已重新读取当前发布状态；不会自动把发布指针切回原操作的版本。');
          if (next.jobs.some(isWebsiteJobActive)) setReload(value => value + 1);
        } catch (caught) {
          if (signal.aborted) return;
          // 原动作已知完成，GET 失败不能转成写入未知或再发一次发布。
          setLoadError(caught);
          setChecking(false);
          setNote('原操作已处理，未再次提交发布。当前版本仅以重新读取的服务端状态为准。');
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
        setNote('服务端已受理后台任务，尚不代表生成成功。每 2 秒只读核查任务；核查失败即暂停，等待手动核查，不会重复付费提交。');
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
    if (!active || busy || flightRef.current) return;
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
    callbacksRef.current.onBusyChange(true);
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
        callbacksRef.current.onBusyChange(false);
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
    setNote('正在提交你二次确认的停止请求；尚不能认定后台已停止。');
    setPublicationConfirmed(false);
    setPublishTarget(null);
    callbacksRef.current.onBusyChange(true);
    let confirmed = false;
    try {
      await websiteApi.cancel(restaurant.id, jobId, { confirmed: true }, controller.signal);
      if (controller.signal.aborted) return;
      confirmed = true;
      setCancelTargetId(null);
      setNote('服务端已确认停止本次生成，不会自动发布或重新生成；已发生的费用仍须核对。正在读取最新任务状态。');
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
        setNote('服务端已确认停止，但最新任务状态读取失败。请手动核查；不会再次发送停止或生成请求。');
      } else {
        setCancelError(caught);
        if (isWebsiteWriteUncertain(caught)) {
          setNote('停止请求结果未知，不代表后台已停止。请手动核查网页状态；不会自动重发停止请求或重新生成。');
        } else {
          setCancelNeedsCheck(false);
          setNote('停止请求未获确认，请核查任务状态后再决定；不会自动重复提交。');
          if (!(caught instanceof ApiError && caught.status === 401)) setReload(value => value + 1);
        }
      }
    } finally {
      if (flightRef.current === controller) {
        flightRef.current = null;
        callbacksRef.current.onBusyChange(false);
        if (mountedRef.current) setPending(null);
      }
    }
  }
  function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (paidLocked || !state || !draft.message.trim()) return;
    void run({ kind: 'chat', key: crypto.randomUUID(), body: { message: draft.message, expected_revision: state.agent.revision } });
  }
  function generate() {
    if (generationBlockers.length > 0) return;
    void run({ kind: 'generate', key: crypto.randomUUID(), body: {
      brief: draft.brief, asset_ids: [...draft.assetIds], public_assets_confirmed: true, expected_restaurant_revision: restaurant.revision, expected_menu_revision: state?.menu.revision ?? 0,
    } });
  }
  function publish() {
    if (!publishTarget || !state || inputLocked || jobsActive || !publicationConfirmed || state.publication.deployment_mode !== 'local'
      || publicationNeedsCheck || checking || loadError || restaurantDirty || !['draft', 'active'].includes(restaurant.status)) return;
    if (!state.publication.slug && !websiteSlugPattern.test(slug)) return;
    void run({ kind: 'publish', key: crypto.randomUUID(), body: {
      version_id: publishTarget.id, ...(!state.publication.slug ? { slug } : {}), expected_revision: state.publication.revision,
    } });
  }
  async function openPreview(version: WebsiteVersion) {
    if (!active || previewFlightRef.current) return;
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
          inlineUrls.set(asset.id, textDataUrl('菜单 PDF 请在预览区下方下载原文件。'));
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
        versionId: version.id, checksum: previewDoc.checksum, documentUrl, fullUrl, reducedImages,
        pdfs: previewDoc.assets.filter(asset => asset.mime_type === 'application/pdf')
          .map(asset => ({ id: asset.id, url: downloadUrls.get(asset.id)! })),
        originals: previewDoc.assets.filter(asset => asset.mime_type !== 'application/pdf')
          .map((asset, index) => ({ id: asset.id, url: downloadUrls.get(asset.id)!,
            label: `图片${index + 1}.${asset.mime_type === 'image/png' ? 'png' : 'jpg'}` })),
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
  const versions = [...(state?.versions ?? [])].sort((left, right) => right.version_number - left.version_number).slice(0, 20);
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

  return <section className="website-panel" aria-labelledby={`${prefix}-title`}>
    <header className="assets-heading"><div><p className="eyebrow">网页 Agent</p><h3 id={`${prefix}-title`}>确认真实资料，再生成餐厅网页</h3><p className="micro">先讨论风格、布局与缺失信息，再生成版本。仅服务端调用模型，前端不传模型密钥。每账号每日合计最多 30 个建站任务 / 对话 / 识图，不是模型调用次数。</p></div><button type="button" className="text-button" disabled={pending !== null || !active} onClick={() => setReload(value => value + 1)}>核查网页状态</button></header>
    <div className="notice"><p>本地发布仅供本机测试，未绑定公网域名；云端托管未验收。</p><p className="micro">菜单图片可在“菜单识图”中直接交给视觉大模型识别，无独立 OCR。只有人工确认的菜单文字会进入新网页；所选原文件仍可独立展示。生成与发布不会开放真实订位。</p></div>
    <section className="website-capabilities" aria-labelledby={`${prefix}-capabilities`}><h3 id={`${prefix}-capabilities`}>Agent真实能力说明</h3><ul><li>读取已保存的餐厅资料，讨论风格与布局。</li><li>使用当前餐厅已上传且可用、经确认允许公开的素材。</li><li>将人工确认的菜单冻结进新网页版本。</li><li>生成版本，读取服务端计划、真实检查与修复结果；预览、发布须分别确认。</li></ul><p>顾客预订、订阅和统计尚未实现，不会添加伪功能按钮。</p><p>当前调试模式不限制累计tokens/调用或修复轮次，每次模型请求仍有网络超时；费用持续累计，发布须人工确认</p></section>
    {state && <p className="notice" role="status">{menuNeedsConfirm ? '菜单尚未确认，请到“菜单识图”核对并确认后再生成网页。' : state.menu.status === 'confirmed' ? `已确认菜单：${state.menu.item_count} 个菜品 · 菜单版本 ${state.menu.revision}；会冻结进下一次网页生成，不自动更新旧网页。` : '暂无已确认的结构化菜单；可以仅展示菜单原文件或生成纯文字页面。'}</p>}
    {restaurantDirty && <p className="notice" role="status">餐厅资料、营业时间或菜单还有未保存内容，或版本需要重新核对。请先保存、确认并刷新，再生成网页或发布。</p>}
    <section className="website-section" aria-labelledby={`${prefix}-facts`}><div className="row-heading"><h3 id={`${prefix}-facts`}>已保存资料 · 只读确认</h3><span className="micro">餐厅版本 {restaurant.revision}</span></div><dl className="website-facts">{profileFields.map(field => <div key={field.key} className={field.key === 'description' ? 'wide' : ''}><dt>{field.label}</dt><dd>{restaurant[field.key] || '尚未填写'}</dd></div>)}</dl><p className="micro">Agent 不修改餐厅事实；请在“餐厅资料”中补充并保存。{restaurant.readiness.missing_fields.length ? `仍有 ${restaurant.readiness.missing_fields.length} 项待补充，请核对资料检查。` : '资料检查无缺项也不代表预订功能已开通。'}</p></section>
    {loading && <div className="workspace-loading" aria-busy="true" role="status"><p className="micro">正在读取网页 Agent、版本和任务…</p><div className="skeleton-line" /><div className="skeleton-line short" /></div>}
    <ErrorMessage error={loadError} readOnly />
    {state && !state.model_configured && <p className="notice" role="status">网页 Agent 未配置，付费按钮已停用。已有版本仍可预览；不会使用模拟生成。</p>}
    <div aria-live="polite" aria-atomic="true">{pending && <p className="micro loading-text" role="status">{pending === 'retry' ? '正在核查并重试同一请求…' : pending === 'cancel' ? '正在提交停止请求并核查状态…' : '正在提交请求（单次 API 最长等待 20 秒）…'}</p>}{note && <p className="notice" role="status">{note}</p>}</div>
    <ErrorMessage error={error} submissionUnknown={!!attempt && isWebsiteWriteUncertain(error)} />
    <ErrorMessage error={cancelError} cancellation />
    {attempt && !pending && <section className="notice" aria-labelledby={`${prefix}-uncertain`}><h3 id={`${prefix}-uncertain`}>本次{attempt.kind === 'chat' ? '需求发送' : attempt.kind === 'generate' ? '网页生成' : '本地发布'}结果尚未确认</h3><p>原输入和幂等键保持不变，编辑与新付费操作已暂停。核查后只重试同一请求，不会静默换键；本窗口刷新后也会尝试恢复重试信息。</p>{attempt.kind === 'publish' && <p className="micro">待核查的版本：{state?.versions.find(version => version.id === attempt.body.version_id)?.version_number ?? '请核对版本记录'}。本次请求不会随预览选择改变。</p>}<button type="button" disabled={busy || !active} onClick={() => void run(attempt, true)}>核查并重试</button></section>}
    {jobsActive && <section className="notice" aria-live="polite"><h3>后台任务正在进行</h3><p>付费操作与餐厅切换已暂停。可以预览已有版本；这里不会因等待超过 60 秒就声称任务失败。</p>{acknowledged && !state?.jobs.some(job => job.id === acknowledged.job_id) && <p className="micro">{acknowledged.kind === 'chat' ? '需求讨论' : '网页生成'} · 已受理，正在核对持久任务记录。</p>}{activeJobs.map(job => <p key={job.id} className="micro">{job.kind === 'chat' ? '需求讨论' : '网页生成'} · {jobLabels[job.status]} · {formatTime(job.created_at)}</p>)}<p className="micro">页面可恢复服务端任务。网络核查失败时不会重复提交模型调用。</p></section>}
    <AgentProgress job={progressJob} waiting={!!generationWaiting} stale={!!loadError || cancelNeedsCheck} headingId={`${prefix}-agent-progress`} />
    {canStopGeneration && progressJob && <section className="notice" aria-labelledby={`${prefix}-cancel-title`}>
      <h3 id={`${prefix}-cancel-title`}>手动停止本次生成</h3>
      <p className="micro">仅针对当前餐厅最近一次仍排队或运行的生成任务；不会自动停止循环，已发生的费用不撤销。</p>
      {cancelTargetId === progressJob.id ? <><p>确认停止本次生成？停止后不自动发布、不自动重新生成；已发生的模型费用仍会累计。</p><div className="button-row"><button type="button" disabled={!active || busy || pending !== null || cancelNeedsCheck} onClick={() => void stopGeneration(progressJob.id)}>确认停止本次生成</button><button type="button" className="text-button" disabled={pending === 'cancel'} onClick={() => setCancelTargetId(null)}>继续生成，返回</button></div></>
        : <button type="button" disabled={!active || busy || pending !== null || cancelNeedsCheck} onClick={() => setCancelTargetId(progressJob.id)}>停止本次生成</button>}
      {cancelNeedsCheck && <p className="micro" role="status">停止请求状态仍待核对，请手动核查网页状态，不据此认定后台已停止。</p>}
    </section>}
    <WebsiteUsagePanel usage={usage} jobId={usageJobId} active={active} headingId={`${prefix}-usage-title`} />
    <section className="website-section" aria-labelledby={`${prefix}-chat-title`}><h3 id={`${prefix}-chat-title`}>01 / 与 Agent 确认需求</h3><p className="micro">说明喜欢的风格、页面布局和展示重点。Agent 根据已保存事实追问缺失信息；图片、菜单不会在需求讨论中发送识别。</p><ol className="website-messages" aria-label="网页需求对话">{state?.agent.messages.map((message, index) => <li key={index} className={`website-message ${message.role}`}><span className="micro">{message.role === 'user' ? '你' : '网页 Agent'}</span><p>{message.content}</p></li>)}</ol>{state?.agent.messages.length === 0 && <p className="micro website-empty">尚无对话。可以告诉 Agent 你想要的风格，或直接填写下面的官网需求。</p>}<form onSubmit={sendMessage}><div className="field"><label htmlFor={`${prefix}-message`}>风格与布局需求</label><textarea id={`${prefix}-message`} rows={3} maxLength={2000} value={draft.message} disabled={inputLocked} onChange={event => updateDraft({ ...draft, message: event.target.value })} placeholder="例如：白底、绿色细线；先介绍餐厅，再展示菜品与联系方式。不要编造菜单价格或预订功能。" /><span className="micro">{draft.message.length} / 2000 · 未发送内容仅保留在当前页面</span></div><button type="submit" disabled={paidLocked || !draft.message.trim()}>发送需求给 Agent</button></form></section>
    <section className="website-section" aria-labelledby={`${prefix}-generate-title`}><h3 id={`${prefix}-generate-title`}>02 / 官网需求与公开素材</h3><div className="field"><label htmlFor={`${prefix}-brief`}>官网需求摘要（可编辑）</label><textarea id={`${prefix}-brief`} rows={6} maxLength={3000} value={draft.brief} disabled={inputLocked} onChange={event => updateDraft({ ...draft, brief: event.target.value, confirmed: false })} /><p className="micro">{draft.brief.length} / 3000 · 摘要可描述展示方式，不应替代真实餐厅资料。点击生成后提交此摘要及选择。</p></div><div className="row-heading"><h3>选择已上传素材</h3><button type="button" className="text-button" disabled={inputLocked || assetsLoading} onClick={() => setAssetReload(value => value + 1)}>刷新可选素材</button></div><p className="micro">最多读取 100 份素材，最多选择 8 份；菜单原文件和 Logo 各最多 1 份。只使用当前餐厅已上传且可用的文件，没有示例图片。</p>{assetsLoading && <p className="micro loading-text" role="status">正在分页读取全部可选素材…</p>}<ErrorMessage error={assetsError} readOnly />{!assetsLoading && !assetsError && assets.length === 0 && <p className="micro website-empty">暂无可选素材。可先到“菜单与图片”上传；也可以不选素材生成纯文字网页。</p>}<ul className="website-asset-options">{assets.map(asset => <li key={asset.id}><label className="check-field"><input type="checkbox" checked={draft.assetIds.includes(asset.id)} disabled={inputLocked || assetsLoading || (!draft.assetIds.includes(asset.id) && (draft.assetIds.length >= 8 || (['menu_source', 'logo'].includes(asset.kind) && assets.some(chosen => chosen.kind === asset.kind && draft.assetIds.includes(chosen.id)))))} onChange={event => updateDraft({ ...draft, confirmed: false, assetIds: event.target.checked ? [...draft.assetIds, asset.id] : draft.assetIds.filter(id => id !== asset.id) })} /><span className="asset-filename">{asset.original_filename}<span className="micro">{kindLabels[asset.kind]} · {asset.mime_type === 'application/pdf' ? 'PDF 原文件（只下载）' : '已上传图片'}</span></span></label></li>)}</ul><p className="micro" aria-live="polite">已选 {draft.assetIds.length} / 8{assetsTruncated ? ' · 仅显示前 100 份可用范围内的素材' : ''}</p>{missingSelected && !assetsLoading && <p className="notice">部分已选素材不在最新可用列表中，请清除选择并重新核对。<button type="button" className="text-button" disabled={inputLocked} onClick={() => updateDraft({ ...draft, assetIds: draft.assetIds.filter(id => assets.some(asset => asset.id === id)), confirmed: false })}>移除不可用选择</button></p>}<label className="check-field website-confirmation"><input type="checkbox" checked={factsConfirmed} disabled={inputLocked} onChange={event => { confirmedRevisionRef.current = restaurant.revision; updateDraft({ ...draft, confirmed: event.target.checked }); }} /><span>确认资料真实且所选图片/菜单允许公开<span className="muted">（必填；人工确认的菜单文字与所选原文件将按上述说明公开）</span></span></label><div className="save-row"><button type="button" className="primary-button" disabled={generationBlockers.length > 0} aria-describedby={`${prefix}-generation-blockers`} onClick={generate}>确认资料并生成网页</button><button type="button" className="text-button" disabled={inputLocked || !dirty} onClick={() => updateDraft({ ...draft, brief: saved.brief, assetIds: [...saved.assetIds], message: '', confirmed: false })}>放弃未提交的网页修改</button></div><div id={`${prefix}-generation-blockers`} className="micro website-generation-blockers" aria-live="polite">{generationBlockers.length > 0 ? <><p>暂不能生成，请处理以下全部阻止原因</p><ul>{generationBlockers.map(reason => <li key={reason}>{reason}</li>)}</ul></> : <p>当前生成条件已满足。点击会提交新的建站任务，可能产生多轮模型费用；不会自动生成或发布。</p>}</div></section>
    {!!state?.jobs.length && <section className="website-section"><h3>任务记录</h3><p className="micro">仅展示最近20条；接口可返回更多任务。失败任务不会自动重试或换键新生成。</p><ul className="website-jobs">{[...state.jobs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 20).map(job => {
      const diagnostics = job.progress?.diagnostics ?? [...(job.trace ?? [])].reverse().find(item => !item.model_call && !/model|模型/i.test(item.action) && item.diagnostics.length)?.diagnostics ?? [];
      return <li key={job.id}><span>{job.kind === 'chat' ? '需求讨论' : '网页生成'} · {jobLabels[job.status]}</span><time className="micro" dateTime={job.created_at}>{formatTime(job.created_at)}</time>
        {job.status === 'failed' && <div className="website-job-failure"><p>{websiteJobErrorMessage(job.error_code)}{job.error_code && <>（<code>{job.error_code}</code>）</>}</p>{diagnostics.length > 0 && <Diagnostics items={diagnostics} />}</div>}
      </li>;
    })}</ul></section>}
    <section className="website-section" aria-labelledby={`${prefix}-versions-title`}><h3 id={`${prefix}-versions-title`}>03 / 网页版本与预览</h3><p className="micro">最近 20 个版本。预览不发布；选择旧版本也不会自动回滚。</p>{versions.length === 0 && !loading && <p className="micro website-empty">尚无生成版本。后台任务成功后，真实版本会显示在这里。</p>}<ul className="website-versions">{versions.map(version => <li key={version.id} className={selectedId === version.id ? 'selected' : ''}><button type="button" className="text-button" aria-pressed={selectedId === version.id} onClick={() => { setSelectedId(version.id); setPublicationConfirmed(false); setPublishTarget(null); }}><span>版本 {version.version_number}{state?.publication.published_version_id === version.id ? publicationNeedsCheck || checking || !!loadError ? ' · 上次读取的发布版本' : ' · 当前本地发布' : ''}</span><time className="micro" dateTime={version.created_at}>{formatTime(version.created_at)}</time><span className="website-summary">{version.summary}</span></button><button type="button" disabled={previewPending || !active} onClick={() => { setSelectedId(version.id); setPublicationConfirmed(false); setPublishTarget(null); void openPreview(version); }}>预览此版本</button></li>)}</ul>
      {previewPending && <div className="notice" role="status"><p>正在读取安全网页文档与此版本的授权素材…</p><button type="button" className="text-button" onClick={closePreview}>取消预览</button></div>}<ErrorMessage error={previewError} readOnly />
      {preview && <section className="website-preview" aria-labelledby={`${prefix}-preview-title`}><div className="row-heading"><h3 id={`${prefix}-preview-title`}>预览版本 {state?.versions.find(version => version.id === preview.versionId)?.version_number ?? '已生成'}</h3><button type="button" className="text-button" onClick={closePreview}>关闭预览</button></div><div className="button-row" role="group" aria-label="预览尺寸"><button type="button" aria-pressed={viewport === 'desktop'} onClick={() => setViewport('desktop')}>桌面</button><button type="button" aria-pressed={viewport === 'mobile'} onClick={() => setViewport('mobile')}>手机 · 390px</button></div><p className="micro">预览框内可滚动，网页里的菜单、联系方式等锚点可直接点击跳转；切换桌面／手机会重新从网页顶部显示。隔离预览仍禁用脚本、同源权限、表单与网络连接，内容与菜单真实性需人工核对。</p><div className="button-row website-preview-links"><a href={preview.fullUrl} target="_blank" rel="noopener noreferrer">在新窗口打开完整预览（原图与完整尺寸）</a></div>{preview.reducedImages > 0 && <p className="notice" role="status">有 {preview.reducedImages} 张图片因隔离预览文档大小限制以占位显示；请在新窗口预览或下载原图核对。</p>}{preview.originals.length > 0 && <div className="button-row website-pdf-downloads">{preview.originals.map(image => <a key={image.id} href={image.url} download={image.label} rel="noopener">下载 {image.label}</a>)}</div>}<div className={`website-preview-frame ${viewport}`}><iframe key={`${preview.versionId}-${viewport}`} src={preview.documentUrl} sandbox="allow-popups allow-popups-to-escape-sandbox allow-downloads" referrerPolicy="no-referrer" title={`餐厅网页隔离预览：${restaurant.name}`} /></div>{preview.pdfs.length > 0 && <div className="button-row website-pdf-downloads">{preview.pdfs.map(pdf => <a key={pdf.id} href={pdf.url} download={`menu-${pdf.id}.pdf`} rel="noopener">下载此版本菜单 PDF</a>)}</div>}</section>}
    </section>
    <section className="website-section" aria-labelledby={`${prefix}-publication-title`}><h3 id={`${prefix}-publication-title`}>04 / 本地发布与回滚</h3>{publicationNeedsCheck && <p className="notice" role="status">原操作已处理，当前版本尚待核对。以下保留上次读取的状态，不代表原操作的版本仍是当前版本。</p>}{state?.publication.published_version_id ? <p className="micro">{publicationNeedsCheck || checking || !!loadError ? '上次读取的发布版本' : '当前发布版本'}：{publishedNumber ?? '不在最近版本列表'} · 发布修订 {state.publication.revision}</p> : <p className="micro">{publicationNeedsCheck || checking || !!loadError ? '尚待核对当前发布状态。' : '尚未本地发布。'}生成成功不等于发布成功。</p>}{publicUrl && <p className="website-public-url"><a href={publicUrl} target="_blank" rel="noopener noreferrer">打开已发布的本地网页</a><span className="micro">{publicUrl}</span></p>}{state?.publication.deployment_mode === 'unconfigured' && <p className="notice">本地发布服务未配置，发布与回滚已停用。</p>}<div className="field"><label htmlFor={`${prefix}-slug`}>本地网页路径（不是域名注册）</label><input id={`${prefix}-slug`} value={slug} minLength={3} maxLength={50} pattern={websiteSlugPattern.source} readOnly={!!state?.publication.slug} disabled={inputLocked} aria-describedby={`${prefix}-slug-help`} onChange={event => { setSlug(event.target.value); setPublicationConfirmed(false); setPublishTarget(null); }} /><p id={`${prefix}-slug-help`} className="micro">3–50 位；首尾必须为小写字母或数字，中间可含连字符；禁用 admin、api、auth、www。第一次发布后固定不变，不会注册二级域名或绑定公网域名。</p>{slug && !websiteSlugPattern.test(slug) && <p className="micro">路径格式不正确：首尾须为字母或数字，长度 3–50，且不能使用保留名称。</p>}</div><p className="micro">本次选择：{selected ? `版本 ${selected.version_number} · ${selected.summary}` : '请先选择一个真实版本'}{rollback ? ' · 将回滚到较早版本' : ''}</p><label className="check-field website-confirmation"><input type="checkbox" checked={publicationConfirmed} disabled={inputLocked || jobsActive} onChange={event => { setPublicationConfirmed(event.target.checked); setPublishTarget(null); }} /><span>我确认这一版可公开展示（本地网址）</span></label><div className="save-row"><button type="button" disabled={inputLocked || jobsActive || publicationNeedsCheck || checking || !!loadError || restaurantDirty || !['draft', 'active'].includes(restaurant.status) || !selected || state?.publication.deployment_mode !== 'local' || !publicationConfirmed || !websiteSlugPattern.test(slug) || selected.id === state.publication.published_version_id} onClick={() => setPublishTarget(selected)}>{rollback ? '回滚到此版本' : '发布此版本到本地'}</button></div>{publishTarget && <section className="notice confirmation"><h3>确认{rollback ? '回滚' : '本地发布'}版本 {publishTarget.version_number}？</h3><p>{publishTarget.summary}</p><p>将改变本地网址展示的版本；不会自动重放，也不会开放真实预订。其他网页版本与原始素材保留。</p><div className="button-row"><button type="button" disabled={inputLocked || jobsActive || !publicationConfirmed} onClick={publish}>确认{rollback ? '回滚到此版本' : '本地发布'}</button><button type="button" className="text-button" disabled={pending !== null} onClick={() => setPublishTarget(null)}>取消</button></div></section>}</section>
  </section>;
}
