import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ApiError, invalid } from './errors.js';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const ASSET_KINDS = ['menu_source', 'logo', 'restaurant_photo', 'dish_photo'] as const;
export type AssetKind = typeof ASSET_KINDS[number];
export type AssetMime = 'application/pdf' | 'image/jpeg' | 'image/png';
export interface ValidatedUpload {
  bytes: Buffer; mimeType: AssetMime; sizeBytes: number; sourceChecksum: string; checksum: string;
  width: number | null; height: number | null;
}
export function checksum(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
export function sanitizeFilename(value: unknown, mime: AssetMime): string {
  if (typeof value !== 'string' || Array.from(value).length > 200) invalid('original_filename', 'LENGTH');
  const filename = value.normalize('NFC').replace(/[\\/\p{Cc}\p{Cf}]/gu, '').trim();
  if (!filename || Array.from(filename).length > 200 || Buffer.byteLength(filename) > 800) invalid('original_filename', 'INVALID');
  const extension = filename.split('.').at(-1)?.toLowerCase();
  const accepted = mime === 'application/pdf' ? ['pdf'] : mime === 'image/jpeg' ? ['jpg', 'jpeg'] : ['png'];
  if (!accepted.includes(extension ?? '') || !filename.includes('.')) invalid('original_filename', 'MIME_EXTENSION_MISMATCH');
  return filename;
}
function signature(bytes: Buffer): AssetMime | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (/^%PDF-(?:1\.[0-7]|2\.0)(?:\r|\n|\s)/.test(bytes.subarray(0, 12).toString('latin1'))) return 'application/pdf';
  return null;
}
const pdfResultCodes = new Set(['OK', 'MALFORMED_FILE', 'ENCRYPTED_PDF', 'PDF_PAGE_LIMIT', 'PDF_COMPLEXITY_LIMIT', 'UNSAFE_PDF']);
async function isolatedPdf(bytes: Buffer): Promise<void> {
  // Child cannot read database, SMTP or application secrets. It only receives this upload.
  const child = fork(fileURLToPath(new URL('./asset-pdf-worker.mjs', import.meta.url)), [], {
    execArgv: ['--max-old-space-size=96'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { PATH: process.env.PATH, NODE_ENV: 'production' },
  });
  await new Promise<void>((complete, reject) => {
    let settled = false;
    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.connected) child.disconnect();
      child.kill('SIGKILL');
      if (result === 'OK') complete();
      else reject(new ApiError(422, 'VALIDATION_FAILED', [{ field: 'body', code: result }]));
    };
    const timer = setTimeout(() => finish('PDF_COMPLEXITY_LIMIT'), 5000);
    child.once('message', value => {
      const code = value && typeof value === 'object' && 'result' in value ? (value as { result: unknown }).result : undefined;
      finish(typeof code === 'string' && pdfResultCodes.has(code) ? code : 'MALFORMED_FILE');
    });
    child.once('error', () => finish('PDF_COMPLEXITY_LIMIT'));
    child.once('exit', () => finish('PDF_COMPLEXITY_LIMIT'));
    child.send(bytes.toString('base64'), error => { if (error) finish('PDF_COMPLEXITY_LIMIT'); });
  });
}
async function validatePdf(bytes: Buffer): Promise<void> {
  // 仅做结构与已知主动内容检查，不能替代防病毒或版权认证。
  const end = bytes.subarray(Math.max(0, bytes.length - 2048)).toString('latin1');
  const trailer = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(end);
  if (!trailer || Number(trailer[1]) >= bytes.length || Number(trailer[1]) <= 0) invalid('body', 'MALFORMED_FILE');
  const xref = bytes.subarray(Number(trailer[1]), Number(trailer[1]) + 60).toString('latin1');
  if (!/^(?:xref\b|\d+\s+\d+\s+obj\b)/.test(xref)) invalid('body', 'MALFORMED_FILE');
  await isolatedPdf(bytes);
}
export async function validateUpload(bytes: Buffer, mime: string, kind: AssetKind): Promise<ValidatedUpload> {
  if (!['application/pdf', 'image/jpeg', 'image/png'].includes(mime)) throw new ApiError(415);
  if (!ASSET_KINDS.includes(kind)) invalid('kind');
  if (!Buffer.isBuffer(bytes) || !bytes.length) invalid('body', 'EMPTY_FILE');
  if (bytes.length > MAX_UPLOAD_BYTES || (mime !== 'application/pdf' && bytes.length > MAX_IMAGE_BYTES)) throw new ApiError(413);
  if (signature(bytes) !== mime) invalid('body', 'MIME_SIGNATURE_MISMATCH');
  if (mime === 'application/pdf' && kind !== 'menu_source') invalid('kind', 'PDF_MENU_ONLY');
  const sourceChecksum = checksum(bytes);
  try {
    if (mime === 'application/pdf') {
      await validatePdf(bytes);
      return { bytes, mimeType: mime, sizeBytes: bytes.length, sourceChecksum, checksum: sourceChecksum, width: null, height: null };
    }
    if (mime === 'image/png') {
      let offset = 8, chunks = 0, ended = false;
      while (offset + 12 <= bytes.length) {
        if (++chunks > 100000) invalid('body', 'INVALID_IMAGE');
        const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
        if (offset + length + 12 > bytes.length || (offset === 8 && (type !== 'IHDR' || length !== 13))) invalid('body', 'MALFORMED_FILE');
        if (['acTL', 'fcTL', 'fdAT'].includes(type)) invalid('body', 'MULTIFRAME_IMAGE');
        offset += length + 12;
        if (type === 'IEND') { ended = length === 0 && offset === bytes.length; break; }
      }
      if (!ended) invalid('body', 'MALFORMED_FILE');
    } else if (bytes.length < 4 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) invalid('body', 'MALFORMED_FILE');
    const image = sharp(bytes, { limitInputPixels: 20000000, animated: false, failOn: 'warning' });
    const metadata = await image.metadata();
    if ((metadata.pages ?? 1) !== 1 || (metadata.format !== 'png' && metadata.format !== 'jpeg') ||
      metadata.format !== (mime === 'image/png' ? 'png' : 'jpeg') || !metadata.width || !metadata.height ||
      metadata.width * metadata.height > 20000000) invalid('body', 'INVALID_IMAGE');
    // 解码所有像素后旋转、重编码；不保留 EXIF、GPS、ICC 或其它上传元数据。
    const pipeline = image.rotate();
    const output = await (mime === 'image/png' ? pipeline.png() : pipeline.jpeg({ quality: 90 })).toBuffer({ resolveWithObject: true });
    if (output.data.length > MAX_IMAGE_BYTES) throw new ApiError(413);
    return { bytes: output.data, mimeType: mime as AssetMime, sizeBytes: output.data.length, sourceChecksum,
      checksum: checksum(output.data), width: output.info.width, height: output.info.height };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    invalid('body', 'MALFORMED_FILE');
  }
}
