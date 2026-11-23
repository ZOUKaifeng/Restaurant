import { ApiError } from './errors.js';
import type { WebsiteSnapshot } from './website-html.js';
import type { WebsiteToolMessage, WebsiteUserContentPart, WebsiteVisionImage } from './website-agent-types.js';

export type { WebsiteVisionImage } from './website-agent-types.js';
export const websiteVisionLimits = Object.freeze({
  maxImages: 8, maxDimension: 1280, perImageBytes: 160 * 1024, totalImageBytes: 1280 * 1024,
  originalImageBytes: 10 * 1024 * 1024, originalImagePixels: 20_000_000,
  textBytes: 1024 * 1024, requestBytes: 3 * 1024 * 1024,
});
const photoKinds = new Set(['logo', 'restaurant_photo', 'dish_photo']);
function invalid(): never { throw new ApiError(503, 'WEBSITE_VISION_INVALID'); }
function overLimit(): never { throw new ApiError(503, 'WEBSITE_VISION_LIMIT'); }
function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)));
}
function imageBytes(url: unknown): number {
  if (typeof url !== 'string' || !url.startsWith('data:image/jpeg;base64,')) invalid();
  const encoded = url.slice('data:image/jpeg;base64,'.length);
  if (encoded.length > 4 * Math.ceil(websiteVisionLimits.perImageBytes / 3)) overLimit();
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) invalid();
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) invalid();
  if (bytes.length > websiteVisionLimits.perImageBytes) overLimit();
  return bytes.length;
}

export function validateWebsiteVisionParts(messages: WebsiteToolMessage[]): void {
  let count = 0;
  let total = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      if (message.role === 'assistant' ? message.content !== null && typeof message.content !== 'string' : typeof message.content !== 'string') invalid();
      continue;
    }
    if (message.role !== 'user' || !message.content.length) invalid();
    for (const part of message.content) {
      if (part?.type === 'text') {
        if (!keys(part, ['type', 'text']) || typeof part.text !== 'string') invalid();
      } else if (part?.type === 'image_url') {
        if (!keys(part, ['type', 'image_url']) || !keys(part.image_url, ['url', 'detail']) || part.image_url.detail !== 'original') invalid();
        const bytes = imageBytes(part.image_url.url);
        // Separate authorized assets may contain identical pixels; count each part,
        // while asset-id uniqueness is enforced by makeWebsiteVisionParts.
        count++;
        total += bytes;
        if (count > websiteVisionLimits.maxImages || total > websiteVisionLimits.totalImageBytes) overLimit();
      } else invalid();
    }
  }
}

export function makeWebsiteVisionParts(brief: string, images: WebsiteVisionImage[], snapshot: WebsiteSnapshot): WebsiteUserContentPart[] {
  if (!Array.isArray(images)) invalid();
  if (images.length > websiteVisionLimits.maxImages) overLimit();
  const seen = new Set<string>();
  const parts: WebsiteUserContentPart[] = [{ type: 'text', text: JSON.stringify({ design_brief: brief }) }];
  for (const image of images) {
    if (!image || typeof image.asset_id !== 'string' || !image.asset_id || seen.has(image.asset_id) || image.mime_type !== 'image/jpeg') invalid();
    const matches = snapshot.assets.filter(asset => asset.id === image.asset_id);
    const asset = matches[0];
    if (matches.length !== 1 || !asset || !photoKinds.has(asset.kind) || !['image/jpeg', 'image/png'].includes(asset.mime_type)) invalid();
    if (![image.width_px, image.height_px].every(n => Number.isSafeInteger(n) && n > 0)) invalid();
    if (Math.max(image.width_px, image.height_px) > websiteVisionLimits.maxDimension) overLimit();
    seen.add(image.asset_id);
    parts.push({ type: 'text', text: JSON.stringify({ asset_id: image.asset_id, kind: asset.kind, width_px: image.width_px, height_px: image.height_px }) },
      { type: 'image_url', image_url: { url: image.data_url, detail: 'original' } });
  }
  validateWebsiteVisionParts([{ role: 'user', content: parts }]);
  return parts;
}

export function requestTextBytes(payload: { messages: WebsiteToolMessage[]; [key: string]: unknown }): number {
  // 只扣除原生 user 图片 URL；工具参数、正文及其他字段仍按真实 JSON UTF8 字节计入。
  const messages = payload.messages.map(message => message.role === 'user' && Array.isArray(message.content)
    ? { ...message, content: message.content.map(part => part.type === 'image_url'
      ? { ...part, image_url: { ...part.image_url, url: '[website-vision-image]' } } : part) } : message);
  return Buffer.byteLength(JSON.stringify({ ...payload, messages }), 'utf8');
}
