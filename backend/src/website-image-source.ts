import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import type { Database } from './db.js';
import type { AssetKind, AssetMime } from './asset-validation.js';
import type { AssetStore, StorageBackend } from './asset-storage.js';
import { ApiError } from './errors.js';
import type { WebsiteJob } from './website-access.js';
import type { WebsiteSnapshot } from './website-html.js';
import { websiteVisionLimits, type WebsiteVisionImage } from './website-vision.js';

export type WebsiteImageJob = Pick<WebsiteJob, 'id' | 'kind' | 'restaurant_id' | 'requesting_user_id' | 'status' | 'lease_token' | 'snapshot'> & {
  input: WebsiteJob['input'] & { image_vision_confirmed?: true };
};
export interface WebsiteImageSourceRow {
  id: string; restaurant_id: string; kind: AssetKind; mime_type: AssetMime; checksum: string;
  width_px: number | null; height_px: number | null; size_bytes: number;
  status: string; safety_status: string; rights_confirmed_at: Date | null; origin: string;
  storage_backend: StorageBackend; storage_key: string;
  reference_restaurant_id: string; reference_asset_id: string; reference_purpose: string; reference_resource_id: string;
}
const photoKinds = new Set(['logo', 'restaurant_photo', 'dish_photo']);
const metadataFields = ['id', 'checksum', 'mime_type', 'kind', 'width_px', 'height_px'] as const;
const preparationMs = 60_000, readMs = 15_000, decodeMs = 5_000;
function unavailable(): never { throw new ApiError(503, 'WEBSITE_IMAGE_SOURCE_UNAVAILABLE'); }
function overLimit(): never { throw new ApiError(503, 'WEBSITE_VISION_LIMIT'); }

export function eligibleWebsiteImageAssets(snapshot: WebsiteSnapshot): WebsiteSnapshot['assets'] {
  if (!Array.isArray(snapshot?.assets)) unavailable();
  return snapshot.assets.filter(asset => asset && photoKinds.has(asset.kind) && ['image/jpeg', 'image/png'].includes(asset.mime_type));
}
export function websiteImageSourcesRequired(job: WebsiteImageJob): boolean {
  return job.kind === 'generate' && job.input?.image_vision_confirmed === true && eligibleWebsiteImageAssets(job.snapshot).length > 0;
}
function validateManifest(job: WebsiteImageJob): void {
  if (job.status !== 'running' || !job.lease_token) throw new ApiError(503, 'JOB_INTERRUPTED');
  if (job.input.image_vision_confirmed !== true || job.input.public_assets_confirmed !== true ||
      job.snapshot.restaurant.id !== job.restaurant_id || !job.id || !job.requesting_user_id) unavailable();
  const ids = job.snapshot.assets.map(asset => asset?.id), selected = job.input.asset_ids;
  if (!Array.isArray(selected) || ids.some(assetId => typeof assetId !== 'string' || !/^ast_[A-Za-z0-9_-]{24}$/.test(assetId)) ||
      new Set(ids).size !== ids.length || new Set(selected).size !== selected.length || selected.length !== ids.length ||
      selected.some(assetId => !ids.includes(assetId))) unavailable();
}

// 调用者须先按 user → restaurant → member → job 持锁；租约剩余时间来自数据库时钟。
export function validateWebsiteImageJob(current: WebsiteImageJob, original: WebsiteImageJob, authorized: boolean, remainingSeconds: number | null): void {
  if (!websiteImageSourcesRequired(original)) return;
  if (current.id !== original.id || current.restaurant_id !== original.restaurant_id ||
      current.requesting_user_id !== original.requesting_user_id || current.kind !== original.kind ||
      current.status !== 'running' || !original.lease_token || current.lease_token !== original.lease_token ||
      remainingSeconds === null || !Number.isFinite(remainingSeconds) || remainingSeconds <= 0) throw new ApiError(503, 'JOB_INTERRUPTED');
  if (!authorized) throw new ApiError(503, 'WEBSITE_CONTEXT_REVOKED');
  validateManifest(original);
  validateManifest(current);
  // 冻结的源清单仅比较既有公开元数据，不把 storage descriptor 写入 snapshot。
  const frozen = original.snapshot.assets;
  if (current.snapshot.assets.length !== frozen.length || current.snapshot.assets.some(asset => {
    const saved = frozen.find(item => item.id === asset.id);
    return !saved || metadataFields.some(field => asset[field] !== saved[field]);
  })) unavailable();
}
export function validateWebsiteImageSources(job: WebsiteImageJob, rows: readonly WebsiteImageSourceRow[]): WebsiteImageSourceRow[] {
  if (!websiteImageSourcesRequired(job)) return [];
  validateManifest(job);
  const eligible = eligibleWebsiteImageAssets(job.snapshot);
  if (eligible.length > websiteVisionLimits.maxImages) overLimit();
  if (rows.length !== eligible.length || new Set(rows.map(row => row.id)).size !== rows.length) unavailable();
  return eligible.map(asset => {
    const row = rows.find(item => item.id === asset.id);
    if (!row || row.restaurant_id !== job.restaurant_id || row.reference_restaurant_id !== job.restaurant_id ||
        row.reference_asset_id !== asset.id || row.reference_purpose !== 'website_job' || row.reference_resource_id !== job.id ||
        row.status !== 'ready' || row.safety_status !== 'approved' || row.origin !== 'upload' ||
        !(row.rights_confirmed_at instanceof Date) || !Number.isFinite(row.rights_confirmed_at.getTime()) ||
        metadataFields.some(field => row[field] !== asset[field]) || !/^[a-f0-9]{64}$/.test(row.checksum) ||
        !Number.isSafeInteger(row.size_bytes) || row.size_bytes < 1 || !['local', 's3'].includes(row.storage_backend) ||
        row.storage_key !== `${job.restaurant_id}/${asset.id}.${asset.mime_type === 'image/jpeg' ? 'jpg' : 'png'}`) unavailable();
    if (![asset.width_px, asset.height_px].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0)) unavailable();
    if (row.size_bytes > websiteVisionLimits.originalImageBytes || asset.width_px! * asset.height_px! > websiteVisionLimits.originalImagePixels) overLimit();
    return { ...row };
  });
}
export async function sourcesCurrent(db: Database, current: WebsiteImageJob, original: WebsiteImageJob,
  authorized: boolean, remainingSeconds: number | null): Promise<WebsiteImageSourceRow[]> {
  if (!websiteImageSourcesRequired(original)) return [];
  validateWebsiteImageJob(current, original, authorized, remainingSeconds);
  const ids = eligibleWebsiteImageAssets(original.snapshot).map(asset => asset.id);
  if (ids.length > websiteVisionLimits.maxImages) overLimit();
  const result = await db.query<WebsiteImageSourceRow>(`SELECT a.id,a.restaurant_id,a.kind,a.mime_type,a.checksum,a.width_px,a.height_px,
    a.size_bytes,a.status,a.safety_status,a.rights_confirmed_at,a.origin,a.storage_backend,a.storage_key,
    ar.restaurant_id AS reference_restaurant_id,ar.asset_id AS reference_asset_id,
    ar.purpose AS reference_purpose,ar.resource_id AS reference_resource_id
    FROM assets a JOIN asset_references ar ON ar.restaurant_id=a.restaurant_id AND ar.asset_id=a.id
      AND ar.purpose='website_job' AND ar.resource_id=$2
    WHERE a.restaurant_id=$1 AND a.id=ANY($3::text[]) ORDER BY a.id`, [original.restaurant_id, original.id, ids]);
  return validateWebsiteImageSources(original, result.rows);
}
async function beforeDeadline<T>(promise: Promise<T>, deadline: number, timeout: () => void = () => {}): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { timeout(); reject(new ApiError(503, 'WEBSITE_VISION_LIMIT')); }, Math.max(0, deadline - performance.now()));
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
function validateContainer(bytes: Buffer, mime: AssetMime): void {
  if (mime === 'image/jpeg') {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff ||
        bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) unavailable();
    return;
  }
  if (mime !== 'image/png' || bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) unavailable();
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset + length + 12 > bytes.length || (offset === 8 && (type !== 'IHDR' || length !== 13)) ||
        ['acTL', 'fcTL', 'fdAT'].includes(type)) unavailable();
    offset += length + 12;
    if (type === 'IEND') { if (length !== 0 || offset !== bytes.length) unavailable(); return; }
  }
  unavailable();
}
async function encodeImage(bytes: Buffer, row: WebsiteImageSourceRow, deadline: number): Promise<WebsiteVisionImage> {
  let image = sharp(bytes, { limitInputPixels: websiteVisionLimits.originalImagePixels, animated: false, failOn: 'warning' }).timeout({ seconds: 5 });
  try {
    return await beforeDeadline((async () => {
      const metadata = await image.metadata();
      if ((metadata.pages ?? 1) !== 1 || metadata.format !== (row.mime_type === 'image/png' ? 'png' : 'jpeg') ||
          metadata.width !== row.width_px || metadata.height !== row.height_px) unavailable();
      if (!metadata.width || !metadata.height || metadata.width * metadata.height > websiteVisionLimits.originalImagePixels) overLimit();
      // 所有尝试共用单图 5s 预算；默认重编码移除 EXIF/GPS/ICC/XMP，透明像素铺白。
      for (const [dimension, quality] of [[websiteVisionLimits.maxDimension, 75], [1280, 55], [1280, 40], [1024, 40], [768, 40]]) {
        image.destroy();
        const remaining = deadline - performance.now();
        if (remaining <= 0) overLimit();
        image = sharp(bytes, { limitInputPixels: websiteVisionLimits.originalImagePixels, animated: false, failOn: 'warning' })
          .timeout({ seconds: Math.max(1, Math.floor(remaining / 1000)) }).rotate()
          .resize({ width: dimension, height: dimension, fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' }).jpeg({ quality });
        const output = await image.toBuffer({ resolveWithObject: true });
        if (performance.now() >= deadline) overLimit();
        if (output.data.length <= websiteVisionLimits.perImageBytes) return {
          asset_id: row.id, mime_type: 'image/jpeg', data_url: `data:image/jpeg;base64,${output.data.toString('base64')}`,
          width_px: output.info.width, height_px: output.info.height,
        };
      }
      overLimit();
    })(), deadline, () => image.destroy());
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (performance.now() >= deadline || (error instanceof Error && /timeout|exceeds pixel limit/i.test(error.message))) overLimit();
    unavailable();
  } finally { image.destroy(); }
}

// 接收短事务验证后的私有 descriptor；拥有传入 store，任何出口都关闭，不写数据库或文件。
export async function prepareWebsiteImages(job: WebsiteImageJob, sourceRows: readonly WebsiteImageSourceRow[],
  store: Pick<AssetStore, 'read' | 'close'>): Promise<WebsiteVisionImage[]> {
  const deadline = performance.now() + preparationMs;
  try {
    const rows = validateWebsiteImageSources(job, sourceRows);
    const images: WebsiteVisionImage[] = [];
    let total = 0;
    for (const row of rows) {
      if (performance.now() >= deadline) overLimit();
      const bytes = await beforeDeadline(store.read(row.storage_backend, row.storage_key, row.size_bytes, row.checksum),
        Math.min(deadline, performance.now() + readMs));
      if (!Buffer.isBuffer(bytes) || bytes.length !== row.size_bytes || createHash('sha256').update(bytes).digest('hex') !== row.checksum) unavailable();
      if (bytes.length > websiteVisionLimits.originalImageBytes) overLimit();
      validateContainer(bytes, row.mime_type);
      const image = await encodeImage(bytes, row, Math.min(deadline, performance.now() + decodeMs));
      total += Buffer.from(image.data_url.slice('data:image/jpeg;base64,'.length), 'base64').length;
      if (total > websiteVisionLimits.totalImageBytes) overLimit();
      images.push(image);
    }
    return images;
  } catch (error) {
    if (error instanceof ApiError && ['WEBSITE_IMAGE_SOURCE_UNAVAILABLE', 'WEBSITE_VISION_LIMIT'].includes(error.code)) throw error;
    unavailable();
  } finally { store.close(); }
}
