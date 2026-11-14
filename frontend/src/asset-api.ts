import { ApiError, getCsrfToken, notifySessionExpired, refreshCsrf } from './api';
import type { Asset, AssetKind, AssetList, AssetMime, AssetUploadAttempt } from './assets-types';
import type { ApiErrorBody, Versioned } from './types';

const idPattern = /^[A-Za-z0-9_-]{16,64}$/;
const cursorPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;
const kinds: AssetKind[] = ['menu_source', 'logo', 'restaurant_photo', 'dish_photo'];
const mimeByExtension: Record<string, AssetMime> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
};

export function assetFileMime(file: File, kind: AssetKind): AssetMime {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const mime = Object.hasOwn(mimeByExtension, extension) ? mimeByExtension[extension] : undefined;
  if (!mime || (kind !== 'menu_source' && mime === 'application/pdf')) {
    throw new ApiError(422, 'ASSET_FILE_TYPE_INVALID');
  }
  if (file.type && file.type !== mime) throw new ApiError(422, 'ASSET_FILE_TYPE_INVALID');
  const limit = (mime === 'application/pdf' ? 20 : 10) * 1024 * 1024;
  if (!file.size) throw new ApiError(422, 'ASSET_FILE_EMPTY');
  if (file.size > limit) throw new ApiError(413, 'ASSET_FILE_TOO_LARGE');
  // MIME 为空时才按允许的扩展补齐；实际文件字节仍由后端严格检查。
  return mime;
}

function collectionPath(restaurantId: string) {
  if (!idPattern.test(restaurantId)) throw new ApiError(400, 'REQUEST_INVALID');
  return `/restaurants/${encodeURIComponent(restaurantId)}/assets`;
}

function itemPath(restaurantId: string, assetId: string) {
  if (!idPattern.test(assetId)) throw new ApiError(400, 'REQUEST_INVALID');
  return `${collectionPath(restaurantId)}/${encodeURIComponent(assetId)}`;
}

function assetEtag(asset: Asset) { return `"asset-${asset.id}-v${asset.revision}"`; }

function readAsset(value: unknown, restaurantId: string, assetId?: string): Asset {
  if (!value || typeof value !== 'object') throw new ApiError(502, 'RESPONSE_INVALID');
  const data = value as Record<string, unknown>;
  const validTime = (time: unknown) => typeof time === 'string' && Number.isFinite(Date.parse(time));
  const validDimension = (dimension: unknown) => dimension === null || (typeof dimension === 'number' && Number.isSafeInteger(dimension) && dimension > 0);
  if (typeof data.id !== 'string' || !idPattern.test(data.id) || (assetId && data.id !== assetId)
    || data.restaurant_id !== restaurantId || !kinds.includes(data.kind as AssetKind)
    || data.origin !== 'upload' || typeof data.original_filename !== 'string'
    || !['application/pdf', 'image/jpeg', 'image/png'].includes(data.mime_type as string)
    || (data.mime_type === 'application/pdf' && data.kind !== 'menu_source')
    || typeof data.size_bytes !== 'number' || !Number.isSafeInteger(data.size_bytes) || data.size_bytes <= 0
    || typeof data.checksum !== 'string' || !validDimension(data.width_px) || !validDimension(data.height_px)
    || (data.alt_text !== null && typeof data.alt_text !== 'string') || !validTime(data.rights_confirmed_at)
    || data.safety_status !== 'approved' || !['ready', 'deleted'].includes(data.status as string)
    || typeof data.revision !== 'number' || !Number.isSafeInteger(data.revision) || data.revision < 1
    || !validTime(data.created_at) || !validTime(data.updated_at) || typeof data.can_delete !== 'boolean'
    || typeof data.content_url !== 'string' || !/^\/(?!\/)/.test(data.content_url) || /[\\\u0000-\u001f\u007f]/.test(data.content_url)) {
    throw new ApiError(502, 'RESPONSE_INVALID');
  }
  // 只保留契约字段；不将服务端额外字段或存储内部信息带入界面。
  return {
    id: data.id, restaurant_id: restaurantId, kind: data.kind as AssetKind, origin: 'upload',
    original_filename: data.original_filename, mime_type: data.mime_type as AssetMime,
    size_bytes: data.size_bytes, checksum: data.checksum, width_px: data.width_px as number | null,
    height_px: data.height_px as number | null, alt_text: data.alt_text as string | null,
    rights_confirmed_at: data.rights_confirmed_at as string, safety_status: 'approved',
    status: data.status as Asset['status'], revision: data.revision, created_at: data.created_at as string,
    updated_at: data.updated_at as string, can_delete: data.can_delete, content_url: data.content_url,
  };
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: File;
  headers?: Record<string, string>;
  csrf?: boolean;
  signal?: AbortSignal;
  timeout?: number;
  expectedStatus: number;
};

async function assetRequest<T>(path: string, read: (response: Response) => Promise<T>, options: RequestOptions): Promise<{ data: T; headers: Headers }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = window.setTimeout(abort, options.timeout ?? 20000);
  try {
    const headers = new Headers({ Accept: 'application/json', ...options.headers });
    if (options.csrf) {
      if (controller.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
      await refreshCsrf();
      const token = getCsrfToken();
      if (!token) throw new ApiError(403, 'CSRF_INVALID');
      headers.set('X-CSRF-Token', token);
    }
    const response = await fetch(`/api/v1${path}`, {
      method: options.method ?? 'GET', credentials: 'same-origin', referrerPolicy: 'same-origin',
      cache: 'no-store', redirect: 'error', headers, body: options.body, signal: controller.signal,
    });
    if (!response.ok) {
      const value: unknown = await response.json().catch(() => undefined);
      const body = value && typeof value === 'object' ? value as Partial<ApiErrorBody> : {};
      const details = Array.isArray(body.details) ? body.details.filter((item): item is ApiErrorBody['details'][number] =>
        !!item && typeof item.field === 'string' && typeof item.code === 'string').slice(0, 50) : [];
      const retryHeader = response.headers.get('Retry-After');
      const retryAfter = retryHeader && /^\d{1,6}$/.test(retryHeader) ? Number(retryHeader) : null;
      if (response.status === 401) notifySessionExpired();
      // 包括 CSRF 403 在内的写请求都不自动重放。
      throw new ApiError(response.status, typeof body.code === 'string' ? body.code : 'REQUEST_FAILED', details, retryAfter);
    }
    if (response.status !== options.expectedStatus) throw new ApiError(502, 'RESPONSE_INVALID');
    const data = await read(response);
    if (controller.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
    return { data, headers: response.headers };
  } catch (error) {
    if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
    if (controller.signal.aborted) throw new ApiError(0, 'REQUEST_TIMEOUT');
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, 'NETWORK_ERROR');
  } finally {
    window.clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); }
  catch { throw new ApiError(502, 'RESPONSE_INVALID'); }
}

function versionedAsset(response: { data: unknown; headers: Headers }, restaurantId: string, assetId?: string): Versioned<Asset> {
  const data = readAsset(response.data, restaurantId, assetId);
  const etag = response.headers.get('ETag');
  if (etag !== assetEtag(data)) throw new ApiError(502, 'ETAG_INVALID');
  return { data, etag };
}

export const assetApi = {
  list: async (restaurantId: string, cursor?: string, signal?: AbortSignal): Promise<AssetList> => {
    const query = new URLSearchParams({ limit: '20' });
    if (cursor) {
      if (cursor.length > 2048 || !cursorPattern.test(cursor)) throw new ApiError(400, 'REQUEST_INVALID');
      query.set('cursor', cursor);
    }
    const { data: value } = await assetRequest(`${collectionPath(restaurantId)}?${query}`, readJson, { expectedStatus: 200, signal });
    if (!value || typeof value !== 'object') throw new ApiError(502, 'RESPONSE_INVALID');
    const data = value as Record<string, unknown>;
    if (!Array.isArray(data.items) || data.items.length > 20 || typeof data.has_more !== 'boolean'
      || (data.next_cursor !== null && (typeof data.next_cursor !== 'string' || data.next_cursor.length > 2048 || !cursorPattern.test(data.next_cursor)))
      || (data.has_more && (!data.next_cursor || data.next_cursor === cursor))
      || !['local', 's3'].includes(data.storage_mode as string)) throw new ApiError(502, 'RESPONSE_INVALID');
    return {
      items: data.items.map((item) => readAsset(item, restaurantId)), next_cursor: data.next_cursor as string | null,
      has_more: data.has_more, storage_mode: data.storage_mode as AssetList['storage_mode'],
    };
  },
  upload: async (restaurantId: string, attempt: AssetUploadAttempt, signal?: AbortSignal): Promise<Versioned<Asset>> => {
    if (!attempt.rights || !kinds.includes(attempt.kind) || !/^[A-Za-z0-9_-]{16,128}$/.test(attempt.key)) {
      throw new ApiError(400, 'REQUEST_INVALID');
    }
    const mime = assetFileMime(attempt.file, attempt.kind);
    const query = new URLSearchParams({ kind: attempt.kind, original_filename: attempt.file.name, rights_confirmed: 'true' });
    const response = await assetRequest(`${collectionPath(restaurantId)}?${query}`, readJson, {
      method: 'POST', body: attempt.file, csrf: true, signal, timeout: 90000, expectedStatus: 201,
      headers: { 'Content-Type': mime, 'Idempotency-Key': attempt.key },
    });
    const uploaded = versionedAsset(response, restaurantId);
    if (uploaded.data.kind !== attempt.kind || uploaded.data.status !== 'ready') throw new ApiError(502, 'RESPONSE_INVALID');
    return uploaded;
  },
  get: async (restaurantId: string, assetId: string, signal?: AbortSignal): Promise<Versioned<Asset>> =>
    versionedAsset(await assetRequest(itemPath(restaurantId, assetId), readJson, { expectedStatus: 200, signal }), restaurantId, assetId),
  content: async (restaurantId: string, asset: Asset, signal?: AbortSignal): Promise<Blob> => {
    if (asset.restaurant_id !== restaurantId || asset.status !== 'ready') throw new ApiError(400, 'REQUEST_INVALID');
    // 始终构造当前店的授权地址，不导航到响应中的任意 URL。
    const { data } = await assetRequest(`${itemPath(restaurantId, asset.id)}/content`, async (response) => {
      if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== asset.mime_type) {
        throw new ApiError(502, 'RESPONSE_INVALID');
      }
      const blob = await response.blob();
      if (blob.size !== asset.size_bytes) throw new ApiError(502, 'RESPONSE_INVALID');
      return blob;
    }, { expectedStatus: 200, signal, headers: { Accept: asset.mime_type } });
    return data;
  },
  delete: async (restaurantId: string, asset: Versioned<Asset>, signal?: AbortSignal): Promise<void> => {
    if (asset.data.restaurant_id !== restaurantId || asset.etag !== assetEtag(asset.data)) throw new ApiError(400, 'REQUEST_INVALID');
    await assetRequest(itemPath(restaurantId, asset.data.id), async () => undefined, {
      method: 'DELETE', csrf: true, signal, expectedStatus: 204, headers: { 'If-Match': asset.etag },
    });
  },
};
