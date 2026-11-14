import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from './api';
import { assetApi, assetFileMime } from './asset-api';
import type { Asset, AssetKind, AssetList, AssetUploadAttempt } from './assets-types';
import type { Versioned } from './types';
import { ErrorNotice } from './ui';

const kindLabels: Record<AssetKind, string> = {
  menu_source: '菜单原文件', logo: 'Logo', restaurant_photo: '餐厅图片', dish_photo: '菜品图片',
};
const assetErrors: Record<string, string> = {
  ASSET_FILE_REQUIRED: '请先从本机选择一个文件，尚未发送上传请求。',
  ASSET_RIGHTS_REQUIRED: '请确认“我有权使用这些素材”后再上传。',
  ASSET_FILE_TYPE_INVALID: '菜单仅接受 PDF、JPG、JPEG、PNG；Logo、餐厅及菜品图片仅接受 JPG、JPEG、PNG。文件类型与扩展名须一致。',
  ASSET_FILE_EMPTY: '所选文件为空，请重新选择。',
  ASSET_FILE_TOO_LARGE: 'PDF 最大 20 MB，图片最大 10 MB，请重新选择符合大小限制的文件。',
  ASSET_IN_USE: '素材被引用，不可删除。请先解除引用，再刷新素材状态。',
  ASSET_ALREADY_DELETED: '同一次上传之前已完成，但该素材后来已删除；不会重新创建。请核对列表后重新选文件。',
  ASSET_TRANSFER_BUSY: '同时处理的文件过多，请稍后手动重试。同一次上传会保留幂等键。',
  ASSET_QUOTA_EXCEEDED: '当前餐厅已达到100份素材或200 MB存储限制，请先删除不再使用的素材。',
  ASSET_UPLOAD_LIMIT_EXCEEDED: '待处理上传过多，请稍后重试或联系平台检查任务。',
  ASSET_VERSION_CHANGED: '素材版本已变化，未执行删除重试。已尝试重新读取，请核对后重新选择要删除的素材。',
  ASSET_DELETE_UNCERTAIN: '删除结果尚未确认，未自动重试。已尝试重新读取，请先核对素材状态。',
  IDEMPOTENCY_CONFLICT: '本次上传与已保存的幂等请求不一致。请先核对素材列表，再放弃本次上传并重新选择文件。',
  IDEMPOTENCY_KEY_CONFLICT: '本次上传与已保存的幂等请求不一致。请先核对素材列表，再放弃本次上传并重新选择文件。',
};

function AssetErrorNotice({ error }: { error: unknown }) {
  if (!(error instanceof ApiError)) return <ErrorNotice error={error} />;
  const message = Object.hasOwn(assetErrors, error.code) ? assetErrors[error.code]
    : error.status === 403 ? '此操作未获授权或安全校验已失效。未自动重放请求；请核对权限后手动重试。'
      : error.status === 404 ? '素材或餐厅不存在，或不属于当前账户。请刷新列表核对。'
        : error.status === 413 ? assetErrors.ASSET_FILE_TOO_LARGE
          : error.status === 415 ? '文件格式或实际内容未通过检查。请使用真实的 PDF、JPG 或 PNG 文件。'
            : null;
  return message ? <div className="notice error-notice" role="alert"><p>{message}</p></div> : <ErrorNotice error={error} />;
}

function formatSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function formatTime(time: string) { return new Date(time).toLocaleString('zh-CN', { hour12: false }); }

type Pending = 'refresh' | 'more' | 'upload' | 'view' | 'download' | 'prepare-delete' | 'delete';
type Preview = { asset: Asset; url: string };

export default function AssetsPanel({ restaurantId, busy, onBusyChange }: {
  restaurantId: string;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const [list, setList] = useState<AssetList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [kind, setKind] = useState<AssetKind>('menu_source');
  const [file, setFile] = useState<File | null>(null);
  const [rights, setRights] = useState(false);
  const [hasAttempt, setHasAttempt] = useState(false);
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmation, setConfirmation] = useState<Versioned<Asset> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const attemptRef = useRef<AssetUploadAttempt | null>(null);
  const flightRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const previewUrlRef = useRef<string | null>(null);
  const downloadUrlsRef = useRef(new Map<string, number>());

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    void assetApi.list(restaurantId, undefined, controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      setList(data);
      setLoadError(null);
      setLoading(false);
    }).catch((caught: unknown) => {
      if (controller.signal.aborted) return;
      setLoadError(caught);
      setLoading(false);
    });
    return () => {
      mountedRef.current = false;
      controller.abort();
      if (flightRef.current) {
        flightRef.current.abort();
        flightRef.current = null;
        onBusyChange(false);
      }
      attemptRef.current = null;
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
      downloadUrlsRef.current.forEach((timer, url) => {
        window.clearTimeout(timer);
        URL.revokeObjectURL(url);
      });
      downloadUrlsRef.current.clear();
    };
  }, [restaurantId, onBusyChange]);

  useEffect(() => { if (confirmation && !busy && !pending) confirmButtonRef.current?.focus(); }, [confirmation, busy, pending]);
  useEffect(() => {
    if (!hasAttempt && !pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasAttempt, pending]);

  function closePreview() {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
    setPreview(null);
  }
  function replaceAsset(asset: Asset) {
    setList((current) => current ? { ...current, items: current.items.map((item) => item.id === asset.id ? asset : item) } : current);
    if (preview?.asset.id === asset.id && (asset.status !== 'ready' || preview.asset.revision !== asset.revision)) closePreview();
  }
  function removeAsset(assetId: string) {
    setList((current) => current ? { ...current, items: current.items.filter((item) => item.id !== assetId) } : current);
    if (preview?.asset.id === assetId) closePreview();
  }

  async function run(operation: Pending, action: (signal: AbortSignal) => Promise<void>, assetId?: string) {
    if (busy || loading || flightRef.current) return;
    const controller = new AbortController();
    flightRef.current = controller;
    setPending(operation);
    setPendingId(assetId ?? null);
    setError(null);
    setNote('');
    onBusyChange(true);
    try { await action(controller.signal); }
    catch (caught) {
      if (mountedRef.current && !controller.signal.aborted) setError(caught);
    } finally {
      if (flightRef.current === controller) {
        flightRef.current = null;
        onBusyChange(false);
        if (mountedRef.current) { setPending(null); setPendingId(null); }
      }
    }
  }

  function readList(more = false) {
    if (more && (!list?.has_more || !list.next_cursor)) return;
    void run(more ? 'more' : 'refresh', async (signal) => {
      const data = await assetApi.list(restaurantId, more ? list?.next_cursor ?? undefined : undefined, signal);
      if (signal.aborted) return;
      if (!more) {
        closePreview();
        setConfirmation(null);
      }
      setList((current) => more && current ? {
        ...data, items: [...current.items.filter((item) => !data.items.some((next) => next.id === item.id)), ...data.items],
      } : data);
      setLoadError(null);
      setNote(more ? '已读取更多素材。' : '已刷新当前餐厅的素材列表。');
    });
  }

  function resetUpload() {
    attemptRef.current = null;
    setHasAttempt(false);
    setFile(null);
    setRights(false);
    setConfirmAbandon(false);
    if (inputRef.current) inputRef.current.value = '';
  }
  function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || loading || flightRef.current || confirmation) return;
    if (!attemptRef.current) {
      try {
        if (!file) throw new ApiError(422, 'ASSET_FILE_REQUIRED');
        if (!rights) throw new ApiError(422, 'ASSET_RIGHTS_REQUIRED');
        assetFileMime(file, kind);
        attemptRef.current = { file, kind, rights: true, key: crypto.randomUUID() };
        setHasAttempt(true);
      } catch (caught) { setError(caught); setNote(''); return; }
    }
    const attempt = attemptRef.current;
    void run('upload', async (signal) => {
      let uploaded: Versioned<Asset>;
      try { uploaded = await assetApi.upload(restaurantId, attempt, signal); }
      catch (caught) {
        if (caught instanceof ApiError && caught.code === 'ASSET_ALREADY_DELETED') {
          resetUpload();
          setNote('先前上传已完成，该素材后来已删除。已释放旧请求，可重新选择文件；不会自动复活素材。');
          try { setList(await assetApi.list(restaurantId, undefined, signal)); } catch { /* 保留现有列表，用户可刷新。 */ }
        }
        throw caught;
      }
      if (signal.aborted) return;
      resetUpload();
      setList((current) => current ? { ...current, items: [uploaded.data, ...current.items.filter((item) => item.id !== uploaded.data.id)] } : current);
      setNote('素材已保存。图片已重编码清除EXIF等元数据，PDF按原文件保存；不执行AI识别、生成或发布。');
      try {
        const data = await assetApi.list(restaurantId, undefined, signal);
        if (!signal.aborted) { setList(data); setLoadError(null); }
      } catch (caught) {
        if (signal.aborted) return;
        setLoadError(caught);
        setNote('素材已上传，但列表刷新失败。上传请求已释放；请刷新列表，不要重复上传。');
      }
    });
  }

  function safeDownload(blob: Blob, asset: Asset) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const extension = asset.mime_type === 'application/pdf' ? 'pdf' : asset.mime_type === 'image/png' ? 'png' : 'jpg';
    const safeName = asset.original_filename.replace(/[\/\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_').replace(/^\.+/, '').trim().slice(0, 180) || '素材';
    anchor.href = url;
    anchor.download = `${safeName.replace(/\.(pdf|jpe?g|png)$/i, '')}.${extension}`;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    try { anchor.click(); }
    finally {
      anchor.remove();
      // 给浏览器接管下载的时间，替换或卸载时同样会释放。
      const timer = window.setTimeout(() => {
        URL.revokeObjectURL(url);
        downloadUrlsRef.current.delete(url);
      }, 1000);
      downloadUrlsRef.current.set(url, timer);
    }
  }

  function openAsset(asset: Asset, download = false) {
    if (confirmation || asset.status !== 'ready') return;
    const isDownload = download || asset.mime_type === 'application/pdf';
    void run(isDownload ? 'download' : 'view', async (signal) => {
      const fresh = await assetApi.get(restaurantId, asset.id, signal);
      if (signal.aborted) return;
      replaceAsset(fresh.data);
      if (fresh.data.status !== 'ready') { setNote('该素材已删除，无法查看或下载。'); return; }
      const blob = await assetApi.content(restaurantId, fresh.data, signal);
      if (signal.aborted) return;
      if (isDownload || fresh.data.mime_type === 'application/pdf') {
        safeDownload(blob, fresh.data);
        setNote('已请求浏览器下载；是否保存完成请查看浏览器下载记录。');
      } else {
        closePreview();
        const url = URL.createObjectURL(blob);
        previewUrlRef.current = url;
        setPreview({ asset: fresh.data, url });
        setNote('已通过当前账户授权读取图片。');
      }
    }, asset.id);
  }

  function prepareDelete(asset: Asset) {
    if (!asset.can_delete || asset.status !== 'ready' || confirmation) return;
    void run('prepare-delete', async (signal) => {
      const fresh = await assetApi.get(restaurantId, asset.id, signal);
      if (signal.aborted) return;
      replaceAsset(fresh.data);
      if (fresh.data.status !== 'ready') { setNote('该素材已删除，无需再次删除。'); return; }
      if (!fresh.data.can_delete) throw new ApiError(409, 'ASSET_IN_USE');
      setConfirmation(fresh);
    }, asset.id);
  }

  function deleteSelected() {
    const selected = confirmation;
    if (!selected || !selected.data.can_delete || selected.data.status !== 'ready') return;
    void run('delete', async (signal) => {
      try { await assetApi.delete(restaurantId, selected, signal); }
      catch (caught) {
        if (signal.aborted) throw caught;
        setConfirmation(null);
        if (caught instanceof ApiError && caught.status === 409) {
          replaceAsset({ ...selected.data, can_delete: false });
          throw new ApiError(409, 'ASSET_IN_USE', caught.details);
        }
        if (caught instanceof ApiError && (caught.status === 412 || caught.status === 0)) {
          try {
            const fresh = await assetApi.get(restaurantId, selected.data.id, signal);
            if (!signal.aborted) replaceAsset(fresh.data);
          } catch (refreshError) {
            if (signal.aborted) throw refreshError;
            if (refreshError instanceof ApiError && refreshError.status === 404) removeAsset(selected.data.id);
            else setNote('素材状态重新读取失败，请刷新列表；删除前会再次读取所选素材版本。');
          }
          throw new ApiError(caught.status, caught.status === 412 ? 'ASSET_VERSION_CHANGED' : 'ASSET_DELETE_UNCERTAIN');
        }
        throw caught;
      }
      if (signal.aborted) return;
      removeAsset(selected.data.id);
      setConfirmation(null);
      setNote('仅所选素材已删除。餐厅资料、营业时间和其他素材未修改。');
    }, selected.data.id);
  }

  const locked = busy || loading || pending !== null;
  const controlsLocked = locked || confirmation !== null;
  const prefix = `assets-${restaurantId}`;
  const pendingText = pending === 'upload' ? '正在上传原文件，请勿关闭或切换页面…'
    : pending === 'delete' ? '正在删除所选素材…' : pending === 'prepare-delete' ? '正在读取所选素材版本…'
      : pending === 'view' ? '正在授权读取图片…' : pending === 'download' ? '正在授权读取文件，准备下载…'
        : pending === 'more' ? '正在读取更多素材…' : '正在刷新素材列表…';

  return <section className="assets-panel" aria-labelledby={`${prefix}-title`} aria-busy={loading || pending !== null}>
    <header className="assets-heading">
      <div><h3 id={`${prefix}-title`}>菜单与图片</h3><p className="micro">仅管理当前餐厅的素材。图片会清除EXIF等元数据后保存；上传不执行AI识别，也不会发布网页。</p></div>
      <button type="button" className="text-button" disabled={controlsLocked} onClick={() => readList()}>刷新素材</button>
    </header>
    <div className="notice"><button type="button" disabled aria-describedby={`${prefix}-ocr-notruns`}>识别菜单（稍后开放）</button><p id={`${prefix}-ocr-notruns`} className="micro">未实现 / notruns：不执行 OCR，不读取菜单内容，不发送模型请求。</p></div>
    {list && <p className="micro assets-storage" role="status">{list.storage_mode === 'local' ? '本地文件保存，云端存储未配置' : '云端存储（S3）；不代表已完成生产验收'}</p>}
    <form className="asset-upload" onSubmit={upload} aria-label="上传当前餐厅素材">
      <fieldset disabled={controlsLocked}>
        <div className="form-grid">
          <div className="field"><label htmlFor={`${prefix}-kind`}>素材类型</label><select id={`${prefix}-kind`} value={kind} disabled={hasAttempt} onChange={(event) => { setKind(event.target.value as AssetKind); setError(null); setNote(''); }}>{Object.entries(kindLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
          <div className="field"><label htmlFor={`${prefix}-file`}>从本机选择文件</label><input ref={inputRef} id={`${prefix}-file`} name="asset_file" type="file" accept={kind === 'menu_source' ? '.pdf,.jpg,.jpeg,.png' : '.jpg,.jpeg,.png'} required={!hasAttempt} disabled={hasAttempt} aria-describedby={`${prefix}-file-help`} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(null); setNote(''); }} /><p id={`${prefix}-file-help`} className="micro">{kind === 'menu_source' ? 'PDF 最大 20 MB；JPG / PNG 最大 10 MB。' : '仅 JPG / PNG，最大 10 MB。'}实际文件内容由服务端检查。</p></div>
        </div>
        <p className="micro asset-selection" aria-live="polite">{file ? `已选择：${file.name} · ${formatSize(file.size)}` : '尚未选择文件，不会发送上传请求。'}</p>
        <label className="check-field" htmlFor={`${prefix}-rights`}><input id={`${prefix}-rights`} type="checkbox" checked={rights} required={!hasAttempt} disabled={hasAttempt} onChange={(event) => setRights(event.target.checked)} /><span>我有权使用这些素材<span className="muted">（必填）</span></span></label>
        <div className="save-row"><button type="submit" className="primary-button" disabled={!hasAttempt && (!file || !rights)}>{pending === 'upload' ? '正在上传…' : hasAttempt ? '重试同一上传' : '上传原文件'}</button></div>
      </fieldset>
    </form>
    <div aria-live="polite" aria-atomic="true">
      {pending && <p className="micro loading-text" role="status">{pendingText}</p>}
      {note && <div className="notice"><p>{note}</p></div>}
    </div>
    <AssetErrorNotice error={error} />
    {hasAttempt && pending !== 'upload' && <section className="notice">
      <p>上传尚未确认成功。原文件、类型、授权确认和幂等键保留在内存；“重试同一上传”不会换键。请先刷新列表核对，避免重复上传。离开餐厅或刷新页面会丢失这次重试信息。</p>
      <button type="button" className="text-button" disabled={controlsLocked} onClick={() => setConfirmAbandon(true)}>放弃本次上传并重新选文件</button>
      {confirmAbandon && <div className="asset-abandon"><p>确认放弃重试信息？这不会撤销可能已保存的素材；请先核对列表。</p><div className="button-row"><button type="button" disabled={controlsLocked} onClick={() => { resetUpload(); setError(null); setNote('已放弃本次重试信息，请重新选择文件并确认使用权。'); inputRef.current?.focus(); }}>确认放弃</button><button type="button" className="text-button" disabled={controlsLocked} onClick={() => setConfirmAbandon(false)}>保留本次上传</button></div></div>}
    </section>}
    {confirmation && <section className="notice confirmation" aria-labelledby={`${prefix}-delete-title`}>
      <h3 id={`${prefix}-delete-title`}>确认删除这一份素材？</h3>
      <p className="asset-filename">{confirmation.data.original_filename}</p>
      <p>仅删除所选的{kindLabels[confirmation.data.kind]}。不会删除本机文件、餐厅或其他素材；被引用素材不可删除。</p>
      <div className="button-row"><button ref={confirmButtonRef} type="button" disabled={locked} onClick={deleteSelected}>{pending === 'delete' ? '正在删除…' : '确认删除所选素材'}</button><button type="button" className="text-button" disabled={locked} onClick={() => setConfirmation(null)}>取消，保留素材</button></div>
    </section>}
    {preview && <section className="asset-preview" aria-labelledby={`${prefix}-preview-title`}>
      <div className="row-heading"><h3 id={`${prefix}-preview-title`} className="asset-filename">{preview.asset.original_filename}</h3><button type="button" className="text-button" disabled={locked} onClick={closePreview}>关闭图片</button></div>
      <img src={preview.url} alt={preview.asset.alt_text ?? `${kindLabels[preview.asset.kind]}：${preview.asset.original_filename}`} onError={() => { closePreview(); setNote('图片无法显示，请尝试下载原文件并检查内容。'); }} />
    </section>}
    {loading && <div className="workspace-loading" role="status"><p className="micro">正在读取当前餐厅的素材…</p><div className="skeleton-line" /><div className="skeleton-line short" /></div>}
    <AssetErrorNotice error={loadError} />
    {Boolean(loadError) && <button type="button" disabled={controlsLocked} onClick={() => readList()}>重新读取素材列表</button>}
    {!loading && list?.items.length === 0 && <div className="empty-state compact"><h3>当前餐厅还没有素材</h3><p>从本机选择菜单 PDF、JPG、PNG 或餐厅图片，确认使用权后上传。其他餐厅的素材不会显示在这里。</p></div>}
    {list && list.items.length > 0 && <ul className="asset-list" aria-label="当前餐厅素材列表">{list.items.map((asset) => {
      const rowPending = pendingId === asset.id;
      const deleteHint = asset.status === 'deleted' ? '素材已删除' : !asset.can_delete ? '被引用，不可删除' : '删除前需二次确认';
      return <li key={asset.id} className="asset-row">
        <div className="asset-row-content"><h3 className="asset-filename">{asset.original_filename}</h3><dl className="asset-meta">
          <div><dt>类型</dt><dd>{kindLabels[asset.kind]}</dd></div><div><dt>大小</dt><dd>{formatSize(asset.size_bytes)}</dd></div>
          <div><dt>上传时间</dt><dd><time dateTime={asset.created_at}>{formatTime(asset.created_at)}</time></dd></div><div><dt>状态</dt><dd>{asset.status === 'ready' ? '可用' : '已删除'}</dd></div>
        </dl></div>
        <div className="asset-row-actions"><div className="button-row">
          <button type="button" className="text-button" disabled={controlsLocked || asset.status !== 'ready'} onClick={() => openAsset(asset)} aria-label={`${asset.mime_type === 'application/pdf' ? '下载 PDF' : '查看图片'}：${asset.original_filename}`}>{rowPending && (pending === 'view' || pending === 'download') ? '正在读取…' : asset.mime_type === 'application/pdf' ? '下载 PDF' : '查看图片'}</button>
          {asset.mime_type !== 'application/pdf' && <button type="button" className="text-button" disabled={controlsLocked || asset.status !== 'ready'} onClick={() => openAsset(asset, true)} aria-label={`下载图片：${asset.original_filename}`}>下载图片</button>}
          <button type="button" className="text-button" disabled={controlsLocked || !asset.can_delete || asset.status !== 'ready'} aria-label={`删除素材：${asset.original_filename}`} aria-describedby={`${prefix}-${asset.id}-delete-help`} onClick={() => prepareDelete(asset)}>{rowPending && (pending === 'delete' || pending === 'prepare-delete') ? '正在处理…' : '删除'}</button>
        </div><p id={`${prefix}-${asset.id}-delete-help`} className="micro">{deleteHint}</p></div>
      </li>;
    })}</ul>}
    {list && <div className="asset-list-footer"><p className="micro" aria-live="polite">已显示 {list.items.length} 份素材{list.has_more ? '，还有更多' : '，已读取完毕'}。</p>{list.has_more && list.next_cursor && <button type="button" disabled={controlsLocked} onClick={() => readList(true)}>{pending === 'more' ? '正在读取…' : '读取更多素材'}</button>}</div>}
  </section>;
}
