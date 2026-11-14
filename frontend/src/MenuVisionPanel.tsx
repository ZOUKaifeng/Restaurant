import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import { assetApi } from './asset-api';
import type { Asset } from './assets-types';
import {
  isMenuJobActive, isMenuWriteUncertain, menuApi, menuDataProblem,
  menuErrorMessage, menuJobErrorMessage, menuLimits,
} from './menu-api';
import type { MenuData, MenuDraft, MenuItem, MenuRecognitionAttempt, MenuState } from './menu-types';

const jobLabels = { queued: '排队中', running: '识别中', succeeded: '已完成', failed: '已失败' };
const emptyItem = (): MenuItem => ({ name: '', description: null, price_text: null, review_note: null });
function formatTime(value: string) { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
function sizeText(bytes: number) { return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`; }
function copyData(data: MenuData): MenuData {
  return { categories: data.categories.map(category => ({ name: category.name, items: category.items.map(item => ({ ...item })) })), warnings: [...data.warnings] };
}
function sameData(left: MenuData | null, right: MenuData | null) { return JSON.stringify(left) === JSON.stringify(right); }
function sameDraft(left: MenuDraft | null, right: MenuDraft | null) { return JSON.stringify(left) === JSON.stringify(right); }
function ErrorMessage({ error, readOnly = false }: { error: unknown; readOnly?: boolean }) {
  if (!error) return null;
  return <div className="notice error-notice" role="alert"><p>{readOnly ? '读取失败，保留上次状态，不会重放识别或保存请求。' : ''}{menuErrorMessage(error)}</p></div>;
}
function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { window.clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = window.setTimeout(done, 2000);
    signal.addEventListener('abort', done, { once: true });
  });
}

type Pending = 'recognize' | 'retry' | 'save' | 'confirm';
export default function MenuVisionPanel({ restaurantId, active, busy, editable, onBusyChange, onJobsChange, onDirtyChange, onOpenAssets }: {
  restaurantId: string;
  active: boolean;
  busy: boolean;
  editable: boolean;
  onBusyChange: (busy: boolean) => void;
  onJobsChange: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  onOpenAssets: () => void;
}) {
  const [state, setState] = useState<MenuState | null>(null);
  const [baseline, setBaseline] = useState<MenuDraft | null>(null);
  const [data, setData] = useState<MenuData | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(true);
  const [assetsError, setAssetsError] = useState<unknown>(null);
  const [assetsTruncated, setAssetsTruncated] = useState(false);
  const [assetIds, setAssetIds] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const [checked, setChecked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [attempt, setAttempt] = useState<MenuRecognitionAttempt | null>(null);
  const [acknowledgedId, setAcknowledgedId] = useState<string | null>(null);
  const [writeNeedsCheck, setWriteNeedsCheck] = useState(false);
  const [savedRevision, setSavedRevision] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const [assetReload, setAssetReload] = useState(0);
  const [discardForRecognition, setDiscardForRecognition] = useState(false);
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [discardEditor, setDiscardEditor] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ category: number; item?: number } | null>(null);
  const [newCategoryName, setNewCategoryName] = useState('');
  const stateRef = useRef(state);
  const baselineRef = useRef(baseline);
  const dataRef = useRef(data);
  const attemptRef = useRef(attempt);
  const acknowledgedRef = useRef(acknowledgedId);
  const writeNeedsCheckRef = useRef(writeNeedsCheck);
  const flightRef = useRef<AbortController | null>(null);
  const pollRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const callbacksRef = useRef({ onBusyChange, onJobsChange, onDirtyChange });
  stateRef.current = state;
  baselineRef.current = baseline;
  dataRef.current = data;
  attemptRef.current = attempt;
  acknowledgedRef.current = acknowledgedId;
  writeNeedsCheckRef.current = writeNeedsCheck;
  callbacksRef.current = { onBusyChange, onJobsChange, onDirtyChange };
  const editorDirty = !sameData(data, baseline?.data ?? null) || !!newCategoryName;
  const dirty = editorDirty || !!attempt || writeNeedsCheck;
  const jobsActive = !!acknowledgedId || !!state?.jobs.some(isMenuJobActive);
  const staleEditor = !!state && !sameDraft(baseline, state.draft);

  const keepAttempt = useCallback((next: MenuRecognitionAttempt | null) => {
    attemptRef.current = next;
    setAttempt(next);
  }, []);
  const setNeedsCheck = useCallback((value: boolean) => {
    writeNeedsCheckRef.current = value;
    setWriteNeedsCheck(value);
  }, []);
  const adoptDraft = useCallback((draft: MenuDraft | null) => {
    const nextData = draft ? copyData(draft.data) : null;
    baselineRef.current = draft;
    dataRef.current = nextData;
    setBaseline(draft);
    setData(nextData);
    setChecked(false);
    setSavedRevision(null);
    setDeleteTarget(null);
    setDiscardEditor(false);
    setNewCategoryName('');
  }, []);
  const categoryNameRef = useRef(newCategoryName);
  categoryNameRef.current = newCategoryName;
  const applyState = useCallback((next: MenuState) => {
    // 服务端更新只自动替换未编辑内容；另一窗口或后台的新修订不能覆盖本页人工修改。
    const locallyEdited = !sameData(dataRef.current, baselineRef.current?.data ?? null) || !!categoryNameRef.current;
    if (!sameDraft(baselineRef.current, next.draft) && !locallyEdited && !writeNeedsCheckRef.current) adoptDraft(next.draft);
    const ack = acknowledgedRef.current;
    if (ack && next.jobs.some(job => job.id === ack)) {
      acknowledgedRef.current = null;
      setAcknowledgedId(null);
    }
    stateRef.current = next;
    setState(next);
    setLoading(false);
    setChecking(false);
    setLoadError(null);
  }, [adoptDraft]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      flightRef.current?.abort();
      flightRef.current = null;
      pollRef.current?.abort();
      pollRef.current = null;
      callbacksRef.current.onBusyChange(false);
      callbacksRef.current.onJobsChange(false);
      callbacksRef.current.onDirtyChange(false);
    };
  }, []);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onJobsChange(jobsActive); }, [jobsActive, onJobsChange]);
  useEffect(() => {
    if (!dirty && !jobsActive && !pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, jobsActive, pending]);
  useEffect(() => {
    if (active) return;
    if (flightRef.current) {
      flightRef.current.abort();
      flightRef.current = null;
      setPending(null);
      callbacksRef.current.onBusyChange(false);
    }
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    pollRef.current = controller;
    setChecking(true);
    async function poll() {
      do {
        try {
          const next = await menuApi.get(restaurantId, controller.signal);
          if (controller.signal.aborted) return;
          applyState(next);
          if (!next.jobs.some(isMenuJobActive) && !acknowledgedRef.current) return;
        } catch (caught) {
          if (controller.signal.aborted) return;
          setLoadError(caught);
          setLoading(false);
          setChecking(false);
          if (caught instanceof ApiError && [401, 403, 404].includes(caught.status)) return;
          if (!stateRef.current?.jobs.some(isMenuJobActive) && !acknowledgedRef.current) return;
        }
        await waitForPoll(controller.signal);
      } while (!controller.signal.aborted);
    }
    void poll();
    return () => { controller.abort(); if (pollRef.current === controller) pollRef.current = null; };
  }, [active, restaurantId, reload, applyState]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setAssetsLoading(true);
    setAssetsError(null);
    async function loadAssets() {
      try {
        const items: Asset[] = [];
        const seen = new Set<string>();
        const cursors = new Set<string>();
        let cursor: string | undefined;
        let more = false;
        do {
          const page = await assetApi.list(restaurantId, cursor, controller.signal);
          if (controller.signal.aborted) return;
          for (const asset of page.items) {
            if (seen.has(asset.id)) throw new ApiError(502, 'RESPONSE_INVALID');
            seen.add(asset.id);
            items.push(asset);
          }
          more = page.has_more;
          if (more && !page.items.length) throw new ApiError(502, 'RESPONSE_INVALID');
          if (!more || items.length >= 100) break;
          if (!page.next_cursor || cursors.has(page.next_cursor)) throw new ApiError(502, 'RESPONSE_INVALID');
          cursors.add(page.next_cursor);
          cursor = page.next_cursor;
        } while (true);
        setAssets(items.slice(0, 100).filter(asset => asset.kind === 'menu_source' && asset.status === 'ready' && asset.safety_status === 'approved'));
        setAssetsTruncated(more);
      } catch (caught) { if (!controller.signal.aborted) setAssetsError(caught); }
      finally { if (!controller.signal.aborted) setAssetsLoading(false); }
    }
    void loadAssets();
    return () => controller.abort();
  }, [active, restaurantId, assetReload]);

  const selectedAssets = assetIds.map(id => assets.find(asset => asset.id === id));
  const totalBytes = selectedAssets.reduce((sum, asset) => sum + (asset?.size_bytes ?? 0), 0);
  const missingSelected = selectedAssets.some(asset => !asset || asset.status !== 'ready' || !['image/png', 'image/jpeg'].includes(asset.mime_type));
  const inputLocked = busy || pending !== null || !!attempt || writeNeedsCheck || jobsActive || loading || checking || !active || !editable;
  const recognitionLocked = inputLocked || !!loadError || !state?.model_configured || assetsLoading || !!assetsError;
  const selectionValid = assetIds.length > 0 && assetIds.length <= menuLimits.images && !missingSelected && totalBytes <= menuLimits.imageBytes;
  const problem = data ? menuDataProblem(data) : null;
  const confirmationReady = baseline?.status === 'draft' && savedRevision === baseline.revision;
  const canSave = !!data && (editorDirty || (baseline?.status === 'draft' && !confirmationReady))
    && !inputLocked && !staleEditor && !loadError && !problem && !newCategoryName;
  const itemCount = data?.categories.reduce((sum, category) => sum + category.items.length, 0) ?? 0;

  async function run(kind: Pending, operation: (signal: AbortSignal) => Promise<void>) {
    if (!active || busy || flightRef.current || !editable) return;
    const controller = new AbortController();
    flightRef.current = controller;
    pollRef.current?.abort();
    pollRef.current = null;
    setPending(kind);
    setChecking(false);
    setError(null);
    setNote('');
    callbacksRef.current.onBusyChange(true);
    try { await operation(controller.signal); }
    catch (caught) { if (mountedRef.current && !controller.signal.aborted) setError(caught); }
    finally {
      if (flightRef.current === controller) {
        flightRef.current = null;
        callbacksRef.current.onBusyChange(false);
        if (mountedRef.current) { setPending(null); setReload(value => value + 1); }
      }
    }
  }
  async function executeRecognition(request: MenuRecognitionAttempt, signal: AbortSignal) {
    try {
      const accepted = await menuApi.recognize(restaurantId, request.body, request.key, signal);
      if (signal.aborted) return;
      acknowledgedRef.current = accepted.job_id;
      setAcknowledgedId(accepted.job_id);
      keepAttempt(null);
      setConsent(false);
      setChecked(false);
      setNote('服务端已受理识别任务，尚不代表成功。每 2 秒核查后台状态，不设任务等待的假超时。识别完成后请人工编辑、保存并确认。');
    } catch (caught) {
      if (!signal.aborted && !isMenuWriteUncertain(caught)) keepAttempt(null);
      throw caught;
    }
  }
  function recognize() {
    if (recognitionLocked || !selectionValid || !consent || !state || editorDirty) return;
    setReplaceConfirmed(false);
    setDiscardForRecognition(false);
    const selectedIds = [...assetIds];
    const expectedRevision = state.draft?.revision ?? 0;
    void run('recognize', async signal => {
      // 先重读真实素材元数据；只发送 ID，不下载图片，也不从前端直连模型。
      const fresh = await Promise.all(selectedIds.map(id => assetApi.get(restaurantId, id, signal).then(result => result.data)));
      if (signal.aborted) return;
      setAssets(current => current.map(asset => fresh.find(item => item.id === asset.id) ?? asset));
      if (fresh.some(asset => asset.restaurant_id !== restaurantId || asset.kind !== 'menu_source' || asset.status !== 'ready'
        || asset.safety_status !== 'approved' || !['image/jpeg', 'image/png'].includes(asset.mime_type))) throw new ApiError(422, 'MENU_ASSET_INVALID');
      if (fresh.reduce((sum, asset) => sum + asset.size_bytes, 0) > menuLimits.imageBytes) throw new ApiError(413, 'MENU_INPUT_TOO_LARGE');
      const request: MenuRecognitionAttempt = { key: crypto.randomUUID(), body: {
        asset_ids: selectedIds, consent_to_ai_processing: true, expected_revision: expectedRevision,
      } };
      keepAttempt(request);
      await executeRecognition(request, signal);
    });
  }
  function prepareRecognition() {
    if (recognitionLocked || !selectionValid || !consent) return;
    setError(null);
    if (editorDirty) { setDiscardForRecognition(true); return; }
    if (state?.draft?.status === 'confirmed') { setReplaceConfirmed(true); return; }
    recognize();
  }
  function retryRecognition() {
    const original = attemptRef.current;
    if (!original || pending || busy || !active) return;
    void run('retry', async signal => {
      const next = await menuApi.get(restaurantId, signal);
      if (signal.aborted) return;
      applyState(next);
      // GET 无法将任务关联到幂等键；只有用户点击才重放完全相同的原 POST。
      await executeRecognition(original, signal);
    });
  }
  function save() {
    if (!canSave || !data) return;
    const input = { data: copyData(data), expected_revision: baseline?.revision ?? 0 };
    void run('save', async signal => {
      setNeedsCheck(true);
      try {
        const draft = await menuApi.save(restaurantId, input, signal);
        if (signal.aborted) return;
        setNeedsCheck(false);
        adoptDraft(draft);
        const next = { ...stateRef.current!, draft };
        applyState(next);
        setSavedRevision(draft.revision);
        setDiscardForRecognition(false);
        setReplaceConfirmed(false);
        setNote('菜单草稿已保存，人工确认已失效；请重新核对并确认。已发布网页不会自动更新。');
      } catch (caught) {
        if (!signal.aborted && !isMenuWriteUncertain(caught)) setNeedsCheck(false);
        throw caught;
      }
    });
  }
  function confirm() {
    if (inputLocked || editorDirty || staleEditor || loadError || !checked || !confirmationReady || !baseline || !data || problem) return;
    const expectedRevision = baseline.revision;
    void run('confirm', async signal => {
      setNeedsCheck(true);
      try {
        const draft = await menuApi.confirm(restaurantId, { expected_revision: expectedRevision, confirmed: true }, signal);
        if (signal.aborted) return;
        setNeedsCheck(false);
        adoptDraft(draft);
        applyState({ ...stateRef.current!, draft });
        setNote('已确认，可用于下一次网页生成。旧发布网页不自动更新。');
      } catch (caught) {
        if (!signal.aborted && !isMenuWriteUncertain(caught)) setNeedsCheck(false);
        throw caught;
      }
    });
  }
  function updateData(next: MenuData) {
    dataRef.current = next;
    setData(next);
    setChecked(false);
    setReplaceConfirmed(false);
    setDiscardForRecognition(false);
    setDeleteTarget(null);
    setNote('');
  }
  function changeItem(categoryIndex: number, itemIndex: number, patch: Partial<MenuItem>) {
    if (inputLocked || !data) return;
    updateData({ ...data, categories: data.categories.map((category, index) => index === categoryIndex ? {
      ...category, items: category.items.map((item, position) => position === itemIndex ? { ...item, ...patch } : item),
    } : category) });
  }
  function applyLatest() {
    if (!state || pending || jobsActive || attempt || busy || checking || loadError) return;
    adoptDraft(state.draft);
    setNeedsCheck(false);
    setDiscardForRecognition(false);
    setReplaceConfirmed(false);
    setError(null);
    setNote('已明示采用最新服务端草稿，未保存修改已放弃。请核对后再编辑或确认。');
  }
  function deleteSelected() {
    if (!deleteTarget || !data || inputLocked) return;
    const target = deleteTarget;
    updateData({ ...data, categories: target.item === undefined
      ? data.categories.filter((_, index) => index !== target.category)
      : data.categories.map((category, index) => index === target.category ? { ...category, items: category.items.filter((_, item) => item !== target.item) } : category),
    });
  }
  const prefix = `menu-${restaurantId}`;
  const jobs = [...(state?.jobs ?? [])].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 20);
  const warnings = baseline?.data.warnings ?? state?.draft?.data.warnings ?? [];

  return <section className="menu-vision-panel" aria-labelledby={`${prefix}-title`}>
    <header className="assets-heading"><div><p className="eyebrow">菜单 / 图片理解</p><h3 id={`${prefix}-title`}>菜单识图</h3><p className="micro">把 JPG / PNG 菜单图片交给 DeepSeek 直接理解，不使用独立 OCR。识别结果只是草稿，必须人工核对后确认。</p></div><button type="button" className="text-button" disabled={pending !== null || !active || checking} onClick={() => setReload(value => value + 1)}>核查菜单状态</button></header>
    <p className="micro menu-boundary">仅修改当前餐厅的菜单草稿，不自动修改已发布网页，不自动生成网页。未知价格留空，不换算币种，不从菜名推测过敏原。</p>
    {!editable && <p className="notice">当前餐厅状态不可编辑；可以读取已有菜单与任务记录。</p>}
    {loading && <div className="workspace-loading" aria-busy="true" role="status"><p className="micro">正在读取菜单草稿与任务…</p><div className="skeleton-line" /><div className="skeleton-line short" /></div>}
    <ErrorMessage error={loadError} readOnly />
    {state && <p className="micro">模型：{state.model || '未配置'} · 直接视觉输入 · PDF 不支持</p>}
    {state && !state.model_configured && <p className="notice" role="status">DeepSeek 视觉识别未配置，识别按钮已停用。已有草稿仍可人工编辑；不使用模拟识别。</p>}
    <div aria-live="polite" aria-atomic="true">{pending && <p className="micro loading-text" role="status">{pending === 'retry' ? '正在核查并重试原请求…' : pending === 'recognize' ? '正在核对真实素材并提交识别请求…' : pending === 'save' ? '正在保存菜单草稿…' : '正在提交人工确认…'}</p>}{note && <p className="notice" role="status">{note}</p>}</div>
    <ErrorMessage error={error} />
    {attempt && !pending && <section className="notice"><h3>识别提交结果未知，原输入已锁定</h3><p>原图片 ID、同意确认、版本和幂等键只保留在当前组件内存。只能核查并重试原请求，不能换图片或换键；刷新或关闭会丢失重试信息，可能导致重复计费。</p><button type="button" disabled={busy || !active || !editable} onClick={retryRecognition}>核查并重试原请求</button></section>}
    {writeNeedsCheck && !pending && <section className="notice"><h3>保存或确认结果尚待核查</h3><p>不会重试无幂等键的 PATCH 或确认请求。先点击“核查菜单状态”，比对服务端草稿；本页编辑仍保留。核查后明确采用服务端草稿才能解锁。</p></section>}
    {jobsActive && <section className="notice" aria-live="polite"><h3>菜单识别后台任务正在进行</h3><p>识别和菜单编辑、切店及退出暂时锁定；其他页签仍可查看，已有网页可以预览。仅在本页激活时每 2 秒核查任务，不自动重试付费任务。</p>{acknowledgedId && !state?.jobs.some(job => job.id === acknowledgedId) && <p className="micro">任务已受理，正在核对持久任务记录。</p>}{state?.jobs.filter(isMenuJobActive).map(job => <p key={job.id} className="micro">{jobLabels[job.status]} · {formatTime(job.created_at)}</p>)}</section>}
    <section className="menu-section" aria-labelledby={`${prefix}-sources`}>
      <div className="row-heading"><h3 id={`${prefix}-sources`}>01 / 选择已上传菜单图片</h3><div className="button-row"><button type="button" className="text-button" disabled={busy || pending !== null || !!attempt} onClick={onOpenAssets}>去上传菜单图片</button><button type="button" className="text-button" disabled={inputLocked || assetsLoading} onClick={() => setAssetReload(value => value + 1)}>刷新素材</button></div></div>
      <p className="micro">只读取当前餐厅的已上传菜单素材，分页最多 100 份；最多选择 4 张，总计不超过 20 MiB，按真实 size_bytes 检查，后端还会再次校验。上传素材不会自动发送给模型。</p>
      {assetsLoading && <p className="micro loading-text" role="status">正在分页读取菜单素材…</p>}
      <ErrorMessage error={assetsError} readOnly />
      {!assetsLoading && !assetsError && assets.length === 0 && <div className="empty-state compact"><h3>还没有菜单图片</h3><p>请先到“菜单与图片”上传 JPG / PNG，再返回选择并明确授权识别。</p></div>}
      <ul className="menu-source-options">{assets.map(asset => {
        const selected = assetIds.includes(asset.id);
        const pdf = asset.mime_type === 'application/pdf';
        const full = !selected && (assetIds.length >= menuLimits.images || totalBytes + asset.size_bytes > menuLimits.imageBytes);
        return <li key={asset.id}><label className="check-field"><input type="checkbox" checked={selected} disabled={inputLocked || assetsLoading || !!assetsError || pdf || full || asset.status !== 'ready'} onChange={event => {
          setAssetIds(current => event.target.checked ? [...current, asset.id] : current.filter(id => id !== asset.id));
          setConsent(false); setReplaceConfirmed(false); setDiscardForRecognition(false); setError(null); setNote('');
        }} /><span className="asset-filename">{asset.original_filename}<span className="micro">{pdf ? 'PDF · 不支持识别' : asset.mime_type === 'image/png' ? 'PNG' : 'JPG'} · {sizeText(asset.size_bytes)}{asset.status !== 'ready' ? ' · 已不可用' : ''}</span></span></label></li>;
      })}</ul>
      <p className="micro" aria-live="polite">已选 {assetIds.length} / 4 张 · {sizeText(totalBytes)} / 20 MiB{assetsTruncated ? ' · 已到 100 份读取上限' : ''}</p>
      {missingSelected && <p className="notice">部分所选图片不可用，请取消缺失的选择后重新核对。<button type="button" className="text-button" disabled={inputLocked} onClick={() => { setAssetIds(current => current.filter(id => assets.some(asset => asset.id === id && ['image/png', 'image/jpeg'].includes(asset.mime_type) && asset.status === 'ready'))); setConsent(false); }}>清除不可用选择</button></p>}
      {totalBytes > menuLimits.imageBytes && <p className="menu-warning" role="status">图片合计超过 20 MiB，请取消部分选择。</p>}
      <p id={`${prefix}-privacy`} className="micro menu-consent-help">所选图片内容将离开本机，经后端发送给第三方 DeepSeek 处理，并可能产生模型费用。没有独立 OCR，也不会在勾选或上传时静默发送图片。</p>
      <label className="check-field"><input type="checkbox" checked={consent} disabled={inputLocked} aria-describedby={`${prefix}-privacy`} onChange={event => { setConsent(event.target.checked); setReplaceConfirmed(false); setDiscardForRecognition(false); }} /><span>把所选菜单图片发送给DeepSeek进行识别</span></label>
      <div className="save-row"><button type="button" className="primary-button" disabled={recognitionLocked || !selectionValid || !consent} onClick={prepareRecognition}>提交菜单识别</button></div>
      {discardForRecognition && <section className="notice confirmation"><h3>识别前先处理未保存修改</h3><p>请先保存草稿，或明确放弃本页修改；识别不会静默覆盖人工编辑。</p><div className="button-row"><button type="button" disabled={!canSave} onClick={save}>先保存草稿</button><button type="button" disabled={recognitionLocked} onClick={() => {
        if (!state) return;
        adoptDraft(state.draft); setDiscardForRecognition(false);
        if (state.draft?.status === 'confirmed') setReplaceConfirmed(true);
        else setNote('未保存修改已明确放弃。请再次点击“提交菜单识别”发送请求。');
      }}>确认放弃未保存修改</button><button type="button" className="text-button" disabled={pending !== null} onClick={() => setDiscardForRecognition(false)}>继续编辑</button></div></section>}
      {replaceConfirmed && <section className="notice confirmation"><h3>重新识别已确认菜单？</h3><p>只替换菜单草稿，不修改已发布网页。成功后原人工确认失效，需要重新编辑、保存并确认；此次仍可能产生模型费用。</p><div className="button-row"><button type="button" disabled={recognitionLocked || !consent || !selectionValid || editorDirty} onClick={recognize}>确认只替换菜单草稿</button><button type="button" className="text-button" onClick={() => setReplaceConfirmed(false)}>保留已确认菜单</button></div></section>}
    </section>
    <section className="menu-section" aria-labelledby={`${prefix}-editor`}>
      <div className="row-heading"><h3 id={`${prefix}-editor`}>02 / 人工编辑菜单草稿</h3><span className="micro">{baseline ? `编辑版本 ${baseline.revision}` : '尚无草稿'}</span></div>
      {warnings.length > 0 && <div className="menu-warning"><h3>识别来源警告 · 请核对原图片</h3><ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
      {baseline && <p className="micro menu-source-summary">来源图片：{baseline.source_asset_ids.length ? baseline.source_asset_ids.map(id => assets.find(asset => asset.id === id)?.original_filename ?? id).join('、') : '无来源图片'}</p>}
      {(staleEditor || writeNeedsCheck) && <section className="notice"><h3>服务端草稿需要重新核对</h3><p>当前服务端版本：{state?.draft?.revision ?? '无草稿'}。本页人工修改保留，不自动覆盖。保存与确认已暂停；可核查状态后明确采用最新草稿。</p><button type="button" disabled={pending !== null || jobsActive || !!attempt || busy || checking || !!loadError} onClick={() => setDiscardEditor(true)}>查看采用最新草稿确认</button></section>}
      {!data && !loading && <div className="empty-state compact"><h3>尚无菜单识别草稿</h3><p>选择真实菜单图片并明确授权识别，任务成功后在这里逐项核对，不会自动确认菜单。</p></div>}
      {data && <fieldset disabled={inputLocked}>
        <p className="micro">最多 20 个分类、80 道菜品。分类名和菜名必填，空分类需删除。描述、价格原文和审核备注可留空；清空以 null 保存。价格保留 $、币种及多规格原字符，不做数字解析。</p>
        <div className="menu-categories">{data.categories.map((category, categoryIndex) => <section className="menu-category" key={categoryIndex} aria-label={`分类 ${categoryIndex + 1}`}>
          <div className="row-heading"><h3>分类 {categoryIndex + 1}</h3><button type="button" className="text-button" onClick={() => setDeleteTarget({ category: categoryIndex })}>删除分类</button></div>
          <div className="field"><label htmlFor={`${prefix}-category-${categoryIndex}`}>分类名</label><input id={`${prefix}-category-${categoryIndex}`} value={category.name} required maxLength={menuLimits.categoryName} onChange={event => updateData({ ...data, categories: data.categories.map((item, index) => index === categoryIndex ? { ...item, name: event.target.value } : item) })} /></div>
          {!category.items.length && <p className="menu-warning">空分类不能保存，请添加菜品或删除分类。</p>}
          {category.items.map((item, itemIndex) => {
            const itemPrefix = `${prefix}-${categoryIndex}-${itemIndex}`;
            return <section className="menu-item" key={itemIndex} aria-label={`菜品 ${itemIndex + 1}`}><div className="row-heading"><h3>菜品 {itemIndex + 1}</h3><button type="button" className="text-button" onClick={() => setDeleteTarget({ category: categoryIndex, item: itemIndex })}>删除菜品</button></div><div className="form-grid">
              <div className="field"><label htmlFor={`${itemPrefix}-name`}>菜名</label><input id={`${itemPrefix}-name`} value={item.name} required maxLength={menuLimits.itemName} onChange={event => changeItem(categoryIndex, itemIndex, { name: event.target.value })} /></div>
              <div className="field"><label htmlFor={`${itemPrefix}-price`}>价格原文（可选）</label><input id={`${itemPrefix}-price`} type="text" value={item.price_text ?? ''} maxLength={menuLimits.price} onChange={event => changeItem(categoryIndex, itemIndex, { price_text: event.target.value === '' ? null : event.target.value })} /><p className="micro">未知价格不填或留空；多规格价格按原文保留。</p></div>
              <div className="field wide"><label htmlFor={`${itemPrefix}-description`}>描述（可选）</label><textarea id={`${itemPrefix}-description`} rows={3} value={item.description ?? ''} maxLength={menuLimits.description} onChange={event => changeItem(categoryIndex, itemIndex, { description: event.target.value === '' ? null : event.target.value })} /></div>
              <div className="field wide"><label htmlFor={`${itemPrefix}-note`}>审核备注（可编辑或删除）</label><textarea id={`${itemPrefix}-note`} rows={2} value={item.review_note ?? ''} maxLength={menuLimits.reviewNote} onChange={event => changeItem(categoryIndex, itemIndex, { review_note: event.target.value === '' ? null : event.target.value })} />{item.review_note !== null && <button type="button" className="text-button menu-clear-note" onClick={() => changeItem(categoryIndex, itemIndex, { review_note: null })}>清空审核备注</button>}</div>
            </div></section>;
          })}
          <button type="button" disabled={itemCount >= menuLimits.items} onClick={() => updateData({ ...data, categories: data.categories.map((item, index) => index === categoryIndex ? { ...item, items: [...item.items, emptyItem()] } : item) })}>添加菜品</button>
        </section>)}</div>
        <div className="menu-add-category"><div className="field"><label htmlFor={`${prefix}-new-category`}>新分类名</label><input id={`${prefix}-new-category`} value={newCategoryName} maxLength={menuLimits.categoryName} onChange={event => { categoryNameRef.current = event.target.value; setNewCategoryName(event.target.value); setChecked(false); setReplaceConfirmed(false); setDiscardForRecognition(false); }} /></div><button type="button" disabled={!newCategoryName.trim() || data.categories.length >= menuLimits.categories || itemCount >= menuLimits.items} onClick={() => { updateData({ ...data, categories: [...data.categories, { name: newCategoryName, items: [emptyItem()] }] }); setNewCategoryName(''); }}>添加分类与首道菜品</button></div>
        <p className="micro" aria-live="polite">{data.categories.length} / 20 个分类 · {itemCount} / 80 道菜品{editorDirty ? ' · 未保存' : ' · 与已读取草稿一致'}</p>
        {editorDirty && problem && <p className="menu-warning" role="status">{problem}</p>}
        {newCategoryName && <p className="micro">新分类名尚未加入菜单，请添加分类或清空输入后保存。</p>}
        {deleteTarget && <section className="notice confirmation"><h3>{deleteTarget.item === undefined ? '确认删除整个分类及其菜品？' : '确认删除这一道菜品？'}</h3><p>只修改本页菜单草稿，保存后生效，不删除上传素材或已发布网页。</p><div className="button-row"><button type="button" onClick={deleteSelected}>确认删除</button><button type="button" className="text-button" onClick={() => setDeleteTarget(null)}>保留</button></div></section>}
        <div className="save-row"><button type="button" className="primary-button" disabled={!canSave} onClick={save}>保存菜单草稿</button><button type="button" className="text-button" disabled={!editorDirty && !staleEditor} onClick={() => setDiscardEditor(true)}>放弃修改并采用服务端草稿</button></div>
      </fieldset>}
      {discardEditor && <section className="notice confirmation"><h3>确认采用最新服务端草稿？</h3><p>本页未保存的菜名、描述、价格、备注及新分类输入将被放弃；不重放识别、保存或确认请求。</p><div className="button-row"><button type="button" disabled={pending !== null || jobsActive || !!attempt || busy || checking || !!loadError} onClick={applyLatest}>确认放弃修改并采用最新草稿</button><button type="button" className="text-button" onClick={() => setDiscardEditor(false)}>保留本页修改</button></div></section>}
    </section>
    <section className="menu-section" aria-labelledby={`${prefix}-confirm`}><h3 id={`${prefix}-confirm`}>03 / 保存后人工确认</h3><p className="micro">请在本页先点击“保存菜单草稿”，再勾选人工核对；新识别结果即使无需修改，也必须明确保存后才能确认。任一次保存或新的识别草稿都会使原确认失效；旧发布网页不会自动更新。</p><label className="check-field menu-confirmation"><input type="checkbox" checked={checked} disabled={inputLocked || editorDirty || staleEditor || !confirmationReady || !!loadError} onChange={event => setChecked(event.target.checked)} /><span>已核对菜名/描述/价格；未知价格不填或留空</span></label><div className="save-row"><button type="button" className="primary-button" disabled={inputLocked || editorDirty || staleEditor || !!loadError || !checked || !confirmationReady || !!problem} onClick={confirm}>确认这份已保存菜单</button></div>{baseline?.status === 'confirmed' && !editorDirty && !staleEditor && !writeNeedsCheck && <div className="notice" role="status"><p>已确认，可用于下一次网页生成</p><p className="micro">人工确认时间：{baseline.confirmed_at ? formatTime(baseline.confirmed_at) : '待核对'}。本功能不自动更新旧发布网页。</p></div>}{editorDirty && <p className="micro">菜单有未保存修改：请先保存或明确放弃。为避免退出丢失内容，切店及退出暂时停用；其他页签可继续查看。</p>}</section>
    {jobs.length > 0 && <section className="menu-section"><h3>识别任务记录</h3><ul className="menu-jobs">{jobs.map(job => <li key={job.id}><span>{jobLabels[job.status]}</span><time className="micro" dateTime={job.created_at}>{formatTime(job.created_at)}</time>{job.result_revision !== null && <p className="micro">结果修订 {job.result_revision}（不代表当前修订）</p>}{job.status === 'failed' && <p>{menuJobErrorMessage(job.error_code)}</p>}</li>)}</ul></section>}
  </section>;
}
