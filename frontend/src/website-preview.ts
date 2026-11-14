import { ApiError } from './api.js';

// 隔离预览使用 data: 文档而不是 srcdoc：srcdoc 没有自身 URL，网页里的 #menu
// 会被浏览器解析成父页面地址并拒绝加载，导航菜单因此完全点不动。
// Chrome 对可导航的 data: URL 有长度上限（约 2MB），这里取更保守的预算。
export const PREVIEW_DOCUMENT_LIMIT = 1_000_000;

const invalid = () => new ApiError(502, 'RESPONSE_INVALID');
const safeDataUrl = /^data:(?:image\/(?:png|jpeg)|application\/pdf|text\/plain);base64,[A-Za-z0-9+/]+={0,2}$/;
const safeBlobUrl = /^blob:https?:\/\/[^\s"'<>]+$/;

// 1x1 透明 PNG。大图超出预览文档预算时用占位图替换，而不是让整个 iframe 被拒绝加载。
export const PREVIEW_PLACEHOLDER_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

export function textDataUrl(message: string): string {
  const bytes = new TextEncoder().encode(message);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:text/plain;base64,${btoa(binary)}`;
}

function resourceUrl(value: string | undefined): string {
  if (!value || (!safeDataUrl.test(value) && !safeBlobUrl.test(value))) throw invalid();
  return value;
}

export function rewriteWebsitePreview(html: string, urls: ReadonlyMap<string, string>): string {
  // 只改写完整 src/href 保留占位符，不替换文本、样式或任意 URL。
  const rewritten = html.replace(/<[a-z][a-z0-9:-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, tag =>
    tag.replace(/(\s)([a-z_:][a-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
      (match, space: string, attribute: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, unquoted: string | undefined) => {
        if (!['src', 'href'].includes(attribute.toLowerCase())) return match;
        const token = /^__SITE_ASSET_([A-Za-z0-9_-]{16,64})__$/.exec(doubleQuoted ?? singleQuoted ?? unquoted ?? '');
        if (!token) return match;
        const url = urls.get(token[1]);
        if (!url) throw invalid();
        return `${space}${attribute}="${resourceUrl(url)}"`;
      }));
  if (!/<head(?:\s[^>]*)?>/i.test(rewritten)) throw invalid();
  const csp = "default-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; frame-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; script-src 'none'";
  // 在服务端安全文档的 head 起始处加同等或更严格的约束，后续策略不能放宽。
  // 订位入口由站点服务在发布时替换；隔离预览没有真实订位页，避免跳到不存在的相对地址。
  return rewritten.replace(/<head(?:\s[^>]*)?>/i, match => `${match}<meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer">`)
    .replaceAll('__SITE_RESERVE__', '#');
}

export function previewDocumentUrl(html: string): string {
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  if (url.length > PREVIEW_DOCUMENT_LIMIT) throw new ApiError(413, 'PREVIEW_DOCUMENT_TOO_LARGE');
  return url;
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('PREVIEW_ASSET_UNREADABLE'));
    reader.readAsDataURL(blob);
  });
}
// 隔离 iframe 是独立源，父页面创建的 blob: 图片地址在内部会被浏览器拒绝。
// 预览用的图片缩放后内嵌为 data:，原图仍可在新窗口或下载链接中查看。
export async function previewImageUrl(blob: Blob): Promise<string> {
  if (typeof createImageBitmap !== 'function') return blobDataUrl(blob);
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) { bitmap.close(); return blobDataUrl(blob); }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.78);
  } catch { return blobDataUrl(blob); }
}

// 单张图片降为占位，而不是让整个 iframe 因 data: 文档过长被浏览器拒绝加载。
export function buildPreviewDocument(html: string, urls: Map<string, string>, images: Array<{ id: string; length: number }>) {
  const candidates = [...images].sort((left, right) => right.length - left.length);
  let reducedImages = 0;
  for (;;) {
    const rewritten = rewriteWebsitePreview(html, urls);
    try { return { documentUrl: previewDocumentUrl(rewritten), reducedImages }; }
    catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'PREVIEW_DOCUMENT_TOO_LARGE') throw error;
      const next = candidates.find(item => urls.get(item.id) !== PREVIEW_PLACEHOLDER_IMAGE);
      if (!next) throw error;
      urls.set(next.id, PREVIEW_PLACEHOLDER_IMAGE);
      reducedImages += 1;
    }
  }
}
