import { ApiError, getCsrfToken, notifySessionExpired, refreshCsrf } from './api';
import type { ApiErrorBody } from './types';
import type {
  WebsiteAccepted, WebsiteGenerateInput, WebsiteJob, WebsiteMessageInput, WebsitePreview,
  WebsitePreviewAsset, WebsitePublication, WebsitePublishInput, WebsiteState, WebsiteVersion,
} from './website-types';

const idPattern = /^[A-Za-z0-9_-]{16,64}$/;
export const websiteSlugPattern = /^(?!(?:admin|api|auth|www)$)[a-z0-9][a-z0-9\-]{1,48}[a-z0-9]$/;
const statuses = ['queued', 'running', 'succeeded', 'failed'];
const invalid = () => new ApiError(502, 'RESPONSE_INVALID');
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string { if (typeof value !== 'string') throw invalid(); return value; }
function identifier(value: unknown): string {
  const result = text(value);
  if (!idPattern.test(result)) throw invalid();
  return result;
}
function nullableId(value: unknown) { return value === null ? null : identifier(value); }
function revision(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw invalid();
  return value;
}
function time(value: unknown) { const result = text(value); if (!Number.isFinite(Date.parse(result))) throw invalid(); return result; }
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 8) throw invalid();
  const result = value.map(identifier);
  if (new Set(result).size !== result.length) throw invalid();
  return result;
}
function basePath(restaurantId: string) {
  if (!idPattern.test(restaurantId)) throw new ApiError(400, 'REQUEST_INVALID');
  return `/api/v1/restaurants/${restaurantId}/website`;
}
function versionPath(restaurantId: string, versionId: string) {
  if (!idPattern.test(versionId)) throw new ApiError(400, 'REQUEST_INVALID');
  return `${basePath(restaurantId)}/versions/${versionId}/preview`;
}

export function safeLocalPublicationUrl(value: string | null, slug: string | null): string | null {
  if (!value || !slug || !websiteSlugPattern.test(slug)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== `/s/${slug}`) return null;
    return url.href;
  } catch { return null; }
}
function readPublication(value: unknown): WebsitePublication {
  const data = record(value);
  const slug = data.slug === null ? null : text(data.slug);
  const url = data.url === null ? null : text(data.url);
  const publishedId = nullableId(data.published_version_id);
  if (!['local', 'unconfigured'].includes(text(data.deployment_mode)) || (slug !== null && !websiteSlugPattern.test(slug))
    || (url !== null && !safeLocalPublicationUrl(url, slug))
    || (publishedId !== null && slug === null)
    || (data.deployment_mode === 'unconfigured' && url !== null)
    || (publishedId === null && url !== null)) throw invalid();
  return { revision: revision(data.revision), published_version_id: publishedId, slug, url, deployment_mode: data.deployment_mode as WebsitePublication['deployment_mode'] };
}
function readVersion(value: unknown, restaurantId: string): WebsiteVersion {
  const data = record(value);
  if (data.restaurant_id !== restaurantId) throw invalid();
  return {
    id: identifier(data.id), restaurant_id: restaurantId, version_number: revision(data.version_number, 1),
    summary: text(data.summary), created_at: time(data.created_at), checksum: text(data.checksum), asset_ids: ids(data.asset_ids),
  };
}
function readJob(value: unknown): WebsiteJob {
  const data = record(value);
  if (!['chat', 'generate'].includes(text(data.kind)) || !statuses.includes(text(data.status))) throw invalid();
  return {
    id: identifier(data.id), kind: data.kind as WebsiteJob['kind'], status: data.status as WebsiteJob['status'],
    error_code: data.error_code === null ? null : text(data.error_code), result_version_id: nullableId(data.result_version_id), created_at: time(data.created_at),
  };
}
function readState(value: unknown, restaurantId: string): WebsiteState {
  const data = record(value);
  const agent = record(data.agent);
  if (!Array.isArray(agent.messages) || !Array.isArray(data.versions) || !Array.isArray(data.jobs)
    || typeof data.model_configured !== 'boolean' || data.menu_recognition_enabled !== false) throw invalid();
  const messages = agent.messages.map((value): WebsiteState['agent']['messages'][number] => {
    const message = record(value);
    if (message.role !== 'user' && message.role !== 'assistant') throw invalid();
    return { role: message.role, content: text(message.content) };
  });
  const versions = data.versions.map((value) => readVersion(value, restaurantId));
  const jobs = data.jobs.map(readJob);
  if (new Set(versions.map(item => item.id)).size !== versions.length || new Set(jobs.map(item => item.id)).size !== jobs.length) throw invalid();
  return {
    agent: { id: nullableId(agent.id), revision: revision(agent.revision), messages, design_brief: text(agent.design_brief) },
    versions, jobs, publication: readPublication(data.publication), model: text(data.model),
    model_configured: data.model_configured, menu_recognition_enabled: false,
  };
}
function readAccepted(value: unknown): WebsiteAccepted {
  const data = record(value);
  if (!statuses.includes(text(data.status))) throw invalid();
  return { job_id: identifier(data.job_id), status: data.status as WebsiteAccepted['status'] };
}

function assetContentPath(restaurantId: string, asset: WebsitePreviewAsset) {
  if (!idPattern.test(restaurantId) || !idPattern.test(asset.id)) throw invalid();
  const expected = `/api/v1/restaurants/${restaurantId}/assets/${asset.id}/content`;
  if (asset.content_url !== expected) throw invalid();
  return expected;
}
function readPreview(value: unknown, restaurantId: string, version: WebsiteVersion): WebsitePreview {
  const data = record(value);
  if (!Array.isArray(data.assets) || data.assets.length > 8 || data.checksum !== version.checksum) throw invalid();
  const assets = data.assets.map((value): WebsitePreviewAsset => {
    const item = record(value);
    const id = identifier(item.id);
    if (!version.asset_ids.includes(id) || !['application/pdf', 'image/png', 'image/jpeg'].includes(text(item.mime_type))) throw invalid();
    const asset = { id, content_url: text(item.content_url), mime_type: item.mime_type as WebsitePreviewAsset['mime_type'] };
    assetContentPath(restaurantId, asset);
    return asset;
  });
  if (new Set(assets.map(item => item.id)).size !== assets.length) throw invalid();
  return { html: text(data.html), assets, checksum: text(data.checksum) };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('请求已取消', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('请求已取消', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function request<T>(path: string, read: (response: Response) => Promise<T>, options: {
  signal?: AbortSignal; body?: unknown; key?: string; expectedStatus: number; accept?: string;
}): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = window.setTimeout(abort, 20000);
  try {
    const headers = new Headers({ Accept: options.accept ?? 'application/json' });
    if (options.body !== undefined) {
      if (!options.key || !/^[A-Za-z0-9_-]{16,128}$/.test(options.key)) throw new ApiError(400, 'REQUEST_INVALID');
      await abortable(refreshCsrf(), controller.signal);
      headers.set('X-CSRF-Token', getCsrfToken());
      headers.set('Content-Type', 'application/json');
      headers.set('Idempotency-Key', options.key);
    }
    if (controller.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
    const response = await fetch(path, {
      method: options.body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      referrerPolicy: 'same-origin', redirect: 'error', headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: controller.signal,
    });
    if (!response.ok) {
      const value: unknown = await response.json().catch(() => undefined);
      const body = value && typeof value === 'object' ? value as Partial<ApiErrorBody> : {};
      const retry = response.headers.get('Retry-After');
      if (response.status === 401) notifySessionExpired();
      throw new ApiError(response.status, typeof body.code === 'string' ? body.code : 'REQUEST_FAILED', [], retry && /^\d{1,6}$/.test(retry) ? Number(retry) : null);
    }
    if (response.status !== options.expectedStatus) throw invalid();
    const result = await read(response);
    if (controller.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
    return result;
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
async function json(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { throw invalid(); }
}
export const websiteApi = {
  get: (restaurantId: string, signal?: AbortSignal) => request(basePath(restaurantId), async response => readState(await json(response), restaurantId), { expectedStatus: 200, signal }),
  message: (restaurantId: string, body: WebsiteMessageInput, key: string, signal?: AbortSignal) => {
    if (!body.message.trim() || body.message.length > 2000 || !Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0) throw new ApiError(422, 'REQUEST_INVALID');
    return request(`${basePath(restaurantId)}/messages`, async response => readAccepted(await json(response)), { body, key, signal, expectedStatus: 202 });
  },
  generate: (restaurantId: string, body: WebsiteGenerateInput, key: string, signal?: AbortSignal) => {
    if (!body.brief.trim() || body.brief.length > 3000 || body.asset_ids.length > 8 || new Set(body.asset_ids).size !== body.asset_ids.length
      || body.asset_ids.some(id => !idPattern.test(id)) || body.public_assets_confirmed !== true
      || !Number.isSafeInteger(body.expected_restaurant_revision) || body.expected_restaurant_revision < 1) throw new ApiError(422, 'REQUEST_INVALID');
    return request(`${basePath(restaurantId)}/generations`, async response => readAccepted(await json(response)), { body, key, signal, expectedStatus: 202 });
  },
  publish: (restaurantId: string, body: WebsitePublishInput, key: string, signal?: AbortSignal) => {
    if (!idPattern.test(body.version_id) || (body.slug !== undefined && !websiteSlugPattern.test(body.slug))
      || !Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0) throw new ApiError(422, 'REQUEST_INVALID');
    return request(`${basePath(restaurantId)}/publication`, async response => {
      const publication = readPublication(await json(response));
      // 幂等回执描述原动作，不表示此刻的发布指针或部署配置。
      if (publication.published_version_id !== body.version_id) throw invalid();
      return publication;
    }, { body, key, signal, expectedStatus: 200 });
  },
  preview: (restaurantId: string, version: WebsiteVersion, signal?: AbortSignal) => {
    if (version.restaurant_id !== restaurantId) throw new ApiError(400, 'REQUEST_INVALID');
    return request(versionPath(restaurantId, version.id), async response => readPreview(await json(response), restaurantId, version), { signal, expectedStatus: 200 });
  },
  assetContent: (restaurantId: string, asset: WebsitePreviewAsset, signal?: AbortSignal) => request(assetContentPath(restaurantId, asset), async response => {
    if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== asset.mime_type) throw invalid();
    const blob = await response.blob();
    if (!blob.size || blob.size > (asset.mime_type === 'application/pdf' ? 20 : 10) * 1024 * 1024) throw invalid();
    return blob;
  }, { signal, expectedStatus: 200, accept: asset.mime_type }),
};

export function rewriteWebsitePreview(html: string, urls: ReadonlyMap<string, string>): string {
  // 只改写完整 src/href 保留占位符，不替换文本、样式或任意 URL。
  const rewritten = html.replace(/<[a-z][a-z0-9:-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, tag =>
    tag.replace(/(\s)([a-z_:][a-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
      (match, space: string, attribute: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, unquoted: string | undefined) => {
        if (!['src', 'href'].includes(attribute.toLowerCase())) return match;
        const token = /^__SITE_ASSET_([A-Za-z0-9_-]{16,64})__$/.exec(doubleQuoted ?? singleQuoted ?? unquoted ?? '');
        if (!token) return match;
        const url = urls.get(token[1]);
        if (!url || !url.startsWith('blob:') || /["'<>\s]/.test(url)) throw invalid();
        return `${space}${attribute}="${url}"`;
      }));
  if (/__SITE_ASSET_/.test(rewritten) || !/<head(?:\s[^>]*)?>/i.test(rewritten)) throw invalid();
  const csp = "default-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; frame-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; script-src 'none'";
  // 在服务端安全文档的 head 起始处加同等或更严格的约束，后续策略不能放宽。
  return rewritten.replace(/<head(?:\s[^>]*)?>/i, match => `${match}<meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer">`);
}

const errorMessages: Record<string, string> = {
  AI_NOT_CONFIGURED: '网页 Agent 尚未配置，不能发送需求或生成网页。请联系服务维护人员。',
  AI_BALANCE_INSUFFICIENT: '模型服务余额不足，请联系服务维护人员处理并核对任务记录。',
  AI_UPSTREAM_UNAVAILABLE: '模型服务暂时不可用，请核对任务状态后再决定是否重新提交。',
  MODEL_OUTPUT_INVALID: '模型输出未通过安全或格式检查，请核对任务记录并调整需求。',
  JOB_INTERRUPTED: '后台任务被中断，请核对任务与版本记录后再发起新任务。',
  WEBSITE_JOB_BUSY: '当前已有网页后台任务，请等待完成后再发送需求或生成。',
  WEBSITE_VERSION_LIMIT: '当前餐厅已达到网页版本数量上限，不能继续生成。请联系服务维护人员。',
  WEBSITE_DAILY_LIMIT: '已达到每日 30 次 Agent 调用上限，请明日再试。',
  WEBSITE_SLUG_CONFLICT: '这个本地路径已被使用，请换一个路径后重新确认。',
  WEBSITE_SLUG_IMMUTABLE: '已发布的网站路径不可修改，请刷新并核对发布状态。',
  PUBLICATION_REVISION_CONFLICT: '发布版本已在其他窗口变化，未自动重放。请重新读取当前发布状态，再确认发布或回滚。',
  AGENT_REVISION_CONFLICT: 'Agent 对话版本已变化，未自动重发需求。请核对最新对话后重新确认。',
  AI_OUTPUT_INVALID: '模型输出未通过内容或格式检查，请核对任务记录并调整需求。',
  AI_PROVIDER_UNAVAILABLE: '模型服务暂时不可用，请核对任务记录后再决定是否重新提交。',
  AI_RESPONSE_INVALID: '模型服务响应未通过格式检查，请核对任务记录。',
  WEBSITE_HTML_INVALID: '网页文档未通过安全或格式校验，不能使用该文档预览或发布。',
  WEBSITE_HTML_TOO_LARGE: '网页文档超过大小上限，请简化需求后重新确认生成。',
  WEBSITE_CONTEXT_REVOKED: '任务使用的餐厅资料或素材授权已失效，请刷新资料与素材，重新确认公开权限。',
  AI_DAILY_LIMIT_EXCEEDED: '已达到每日 30 次 Agent 调用上限，请明日再试。',
  WEBSITE_DAILY_LIMIT_EXCEEDED: '已达到每日 30 次 Agent 调用上限，请明日再试。',
  AI_RATE_LIMITED: '模型调用受限，请等待后手动重试；不会自动重复付费调用。',
  JOB_ALREADY_ACTIVE: '当前已有后台任务，请等待完成后再发送需求或生成。',
  JOB_IN_PROGRESS: '当前已有后台任务，请等待完成后再发送需求或生成。',
  RESTAURANT_REVISION_CONFLICT: '餐厅资料版本已变化，请刷新餐厅资料，核对后重新确认生成。',
  REVISION_CONFLICT: '版本已变化，未自动重放操作。请刷新并核对后重新确认。',
  IDEMPOTENCY_CONFLICT: '同一请求内容与服务端记录不一致。请核对任务与版本，不要换键重复提交。',
  IDEMPOTENCY_KEY_CONFLICT: '同一请求内容与服务端记录不一致。请核对任务与版本，不要换键重复提交。',
  SLUG_ALREADY_TAKEN: '这个本地路径已被使用，请换一个路径后重新确认。',
  SLUG_CONFLICT: '这个本地路径已被使用，请换一个路径后重新确认。',
  SLUG_IMMUTABLE: '已发布的网站路径不可修改，请刷新发布状态。',
  DEPLOYMENT_NOT_CONFIGURED: '本地发布服务尚未配置，未执行发布。云端托管也未验收。',
  ASSET_NOT_READY: '所选素材不可用，请刷新素材并重新选择真实上传文件。',
  ASSET_NOT_FOUND: '所选素材已删除或不属于当前餐厅，请刷新素材。',
  REQUEST_INVALID: '请核对填写长度、版本、素材数量及公开授权确认。',
  RESPONSE_INVALID: '服务响应与网页接口契约不一致，结果尚不能确认。请核查状态，不要重复付费。',
  REQUEST_TIMEOUT: '请求超时，结果未知。请“核查并重试”，保留原内容和幂等键，避免重复付费。',
  NETWORK_ERROR: '服务连接失败，结果未知。请“核查并重试”，不会静默换键。',
};
export function websiteErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return '操作未完成，请重新核对状态。';
  if (Object.hasOwn(errorMessages, error.code)) return errorMessages[error.code];
  if (error.status === 401) return '会话已失效，请重新登录。原写请求不会自动重放。';
  if (error.status === 403) return '权限或安全校验失效，请核对账户后手动重试。';
  if (error.status === 404) return '餐厅、网页版本或素材不存在，或不属于当前账户。';
  if (error.status === 412 || error.status === 428) return errorMessages.REVISION_CONFLICT;
  if (error.status === 429) return '调用频率或每日配额受限（每日最多 30 次）。请稍后再试。';
  if (error.status === 422) return errorMessages.REQUEST_INVALID;
  if (error.status >= 500) return '服务暂时不可用，操作结果尚未确认。请核查任务与发布记录。';
  return '操作未完成，请核对任务、版本和输入后再确认。';
}
export function websiteJobErrorMessage(code: string | null): string {
  // 服务端 failed 是已知终态，不能套用网络提交“结果未知”的提示。
  const reason = code === 'REQUEST_TIMEOUT' ? '后台处理超时。'
    : code === 'NETWORK_ERROR' ? '后台连接模型服务失败。'
      : code === 'RESPONSE_INVALID' ? '后台服务响应未通过检查。'
        : code && Object.hasOwn(errorMessages, code) ? errorMessages[code]
          : '请核对资料、需求与版本记录后再决定是否发起新任务。';
  return `后台任务已失败，不会自动重试。${reason}`;
}
export function isWebsiteJobActive(job: WebsiteJob) { return job.status === 'queued' || job.status === 'running'; }
export function isWebsiteWriteUncertain(error: unknown) {
  return !(error instanceof ApiError) || error.status === 0 || error.status >= 500 || /^IDEMPOTENCY/.test(error.code);
}
