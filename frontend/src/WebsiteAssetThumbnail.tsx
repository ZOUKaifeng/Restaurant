import { useEffect, useRef, useState } from 'react';
import { assetApi } from './asset-api';
import type { Asset } from './assets-types';

async function thumbnailBlob(blob: Blob, signal: AbortSignal): Promise<Blob> {
  if (signal.aborted) throw new DOMException('请求已取消', 'AbortError');
  const sourceUrl = URL.createObjectURL(blob);
  const image = new Image();
  let sourceReleased = false;
  const releaseSource = () => {
    if (!sourceReleased) { URL.revokeObjectURL(sourceUrl); sourceReleased = true; }
  };
  let abort = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => { image.src = ''; releaseSource(); reject(new DOMException('请求已取消', 'AbortError')); };
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('图片无法解码'));
      signal.addEventListener('abort', abort, { once: true });
      image.src = sourceUrl;
    });
    if (signal.aborted) throw new DOMException('请求已取消', 'AbortError');
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('图片尺寸无效');
    const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建缩略图');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    releaseSource();
    // 保留 Logo 的透明背景；只展示最大边 512px 的本地缩略图。
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      value => value ? resolve(value) : reject(new Error('无法创建缩略图')), 'image/png',
    ));
  } finally {
    signal.removeEventListener('abort', abort);
    image.onload = null;
    image.onerror = null;
    image.src = '';
    releaseSource();
  }
}

export default function WebsiteAssetThumbnail({ restaurantId, asset, selected, active }: {
  restaurantId: string; asset: Asset; selected: boolean; active: boolean;
}) {
  const assetRef = useRef(asset);
  assetRef.current = asset;
  const resource = JSON.stringify([restaurantId, asset.id, asset.revision, asset.checksum, asset.mime_type, asset.kind, asset.size_bytes, asset.rights_confirmed_at]);
  const enabled = active && selected && asset.restaurant_id === restaurantId && asset.origin === 'upload'
    && asset.status === 'ready' && asset.safety_status === 'approved'
    && ['image/jpeg', 'image/png'].includes(asset.mime_type);
  const contextRef = useRef({ resource, enabled });
  contextRef.current = { resource, enabled };
  const [snapshot, setSnapshot] = useState<{ resource: string; url: string | null; failed: boolean } | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    setSnapshot(null);
    if (!enabled) return;
    const controller = new AbortController();
    const selectedAsset = assetRef.current;
    let thumbnailUrl: string | null = null;
    const current = () => !controller.signal.aborted && contextRef.current.enabled && contextRef.current.resource === resource;
    async function load() {
      try {
        const blob = await assetApi.content(restaurantId, selectedAsset, controller.signal);
        if (!current()) return;
        const thumbnail = await thumbnailBlob(blob, controller.signal);
        if (!current()) return;
        thumbnailUrl = URL.createObjectURL(thumbnail);
        setSnapshot({ resource, url: thumbnailUrl, failed: false });
      } catch {
        if (current()) setSnapshot({ resource, url: null, failed: true });
      }
    }
    void load();
    return () => {
      controller.abort();
      if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
    };
  }, [restaurantId, resource, enabled, retry]);

  const value = enabled && snapshot?.resource === resource ? snapshot : null;
  return <figure className="website-asset-thumbnail" data-asset-id={asset.id}>
    {value?.url ? <img src={value.url} alt={`所选素材：${asset.original_filename}`} onError={() => {
      if (value.url && contextRef.current.enabled && contextRef.current.resource === resource && snapshotRef.current?.url === value.url) {
        URL.revokeObjectURL(value.url);
        setSnapshot({ resource, url: null, failed: true });
      }
    }} /> : <div className="website-thumbnail-placeholder">
      {asset.mime_type === 'application/pdf' ? <p className="micro">菜单 PDF：不加载缩略图；仅网页展示或下载，不发送建站视觉分析。</p>
        : !enabled ? <p className="micro">缩略图已暂停或素材不可用。</p>
          : value?.failed ? <><p className="micro" role="status">缩略图读取失败，不代表 AI 已看图；不更改已选素材。</p><button type="button" className="text-button" onClick={() => setRetry(value => value + 1)}>重试缩略图</button></>
            : <p className="micro" role="status">正在授权读取缩略图…</p>}
    </div>}
    <figcaption><span className="asset-filename">{asset.original_filename}</span><span className="micro">素材 ID：{asset.id}</span>
      {asset.kind === 'menu_source' && asset.mime_type !== 'application/pdf' && <span className="micro">菜单原图：仅本地查看和网页展示，不发送建站视觉分析。</span>}
    </figcaption>
  </figure>;
}
