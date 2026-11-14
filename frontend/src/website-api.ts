import { ApiError, getCsrfToken, notifySessionExpired, refreshCsrf } from './api';
import type { ApiErrorBody } from './types';
import type {
  WebsiteAccepted, WebsiteCancelInput, WebsiteCancelled, WebsiteDiagnostic, WebsiteGenerateInput, WebsiteJob,
  WebsiteMessageInput, WebsiteModelCall, WebsitePreview, WebsitePreviewAsset, WebsiteProgress, WebsitePublication,
  WebsitePublishInput, WebsiteState, WebsiteTrace, WebsiteUsage, WebsiteVersion,
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
function jobPath(restaurantId: string, jobId: string) {
  if (!idPattern.test(jobId)) throw new ApiError(400, 'REQUEST_INVALID');
  return `${basePath(restaurantId)}/jobs/${jobId}`;
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
function cappedText(value: unknown, maximum: number): string {
  const result = text(value);
  if (result.length > maximum) throw invalid();
  return result;
}
function nullableCount(value: unknown): number | null { return value === null ? null : revision(value); }
function readModelCall(value: unknown): WebsiteModelCall {
  const data = record(value);
  if (!['started', 'completed', 'failed'].includes(text(data.status))) throw invalid();
  return {
    index: revision(data.index), status: data.status as WebsiteModelCall['status'],
    prompt_tokens: nullableCount(data.prompt_tokens), completion_tokens: nullableCount(data.completion_tokens),
    total_tokens: nullableCount(data.total_tokens), elapsed_ms: nullableCount(data.elapsed_ms),
    ...(data.error_code === undefined ? {} : { error_code: data.error_code === null ? null : cappedText(data.error_code, 128) }),
  };
}
function readUsage(value: unknown, jobId: string): WebsiteUsage {
  const data = record(value);
  if (identifier(data.job_id) !== jobId || !Array.isArray(data.calls)) throw invalid();
  const calls = data.calls.map(value => {
    const item = readModelCall(value);
    if (item.error_code === undefined) throw invalid();
    return { ...item, error_code: item.error_code };
  });
  if (new Set(calls.map(item => item.index)).size !== calls.length) throw invalid();
  const totalsData = record(data.totals);
  const totals = {
    prompt_tokens: revision(totalsData.prompt_tokens), completion_tokens: revision(totalsData.completion_tokens),
    total_tokens: revision(totalsData.total_tokens),
  };
  const unknownUsageCalls = revision(data.unknown_usage_calls);
  let legacySummary: WebsiteUsage['legacy_summary'];
  if (data.legacy_summary !== undefined) {
    const legacy = record(data.legacy_summary);
    if (calls.length !== 0 || legacy.prompt_tokens !== null || legacy.completion_tokens !== null
      || totals.prompt_tokens !== 0 || totals.completion_tokens !== 0 || totals.total_tokens !== 0) throw invalid();
    legacySummary = {
      model_calls: revision(legacy.model_calls), total_tokens: nullableCount(legacy.total_tokens),
      prompt_tokens: null, completion_tokens: null,
    };
    if (unknownUsageCalls !== legacySummary.model_calls) throw invalid();
  } else if (unknownUsageCalls > calls.length) throw invalid();
  return {
    job_id: jobId, calls, totals, unknown_usage_calls: unknownUsageCalls,
    ...(legacySummary === undefined ? {} : { legacy_summary: legacySummary }),
  };
}
function readDiagnostics(value: unknown): WebsiteDiagnostic[] {
  if (!Array.isArray(value) || value.length > 20) throw invalid();
  return value.map(value => {
    const item = record(value);
    if (!['index.html', 'styles.css', 'assets', 'agent'].includes(text(item.file))) throw invalid();
    return {
      file: item.file as WebsiteDiagnostic['file'], line: revision(item.line), column: revision(item.column),
      code: cappedText(item.code, 128), message: cappedText(item.message, 2000),
    };
  });
}
function readProgress(value: unknown): WebsiteProgress | null {
  if (value === undefined || value === null) return null;
  const data = record(value);
  if (!['planning', 'writing', 'checking', 'repairing', 'ready', 'failed'].includes(text(data.phase))
    || !Array.isArray(data.plan) || data.plan.length > 12) throw invalid();
  const plan = data.plan.map((value): WebsiteProgress['plan'][number] => {
    const item = record(value);
    if (!['pending', 'in_progress', 'completed'].includes(text(item.status))) throw invalid();
    return { id: cappedText(item.id, 128), title: cappedText(item.title, 500), status: item.status as WebsiteProgress['plan'][number]['status'] };
  });
  if (new Set(plan.map(item => item.id)).size !== plan.length) throw invalid();
  return {
    phase: data.phase as WebsiteProgress['phase'], round: revision(data.round),
    model_calls: revision(data.model_calls), total_tokens: revision(data.total_tokens),
    ...(data.prompt_tokens === undefined ? {} : { prompt_tokens: revision(data.prompt_tokens) }),
    ...(data.completion_tokens === undefined ? {} : { completion_tokens: revision(data.completion_tokens) }),
    ...(data.elapsed_ms === undefined ? {} : { elapsed_ms: revision(data.elapsed_ms) }),
    plan, diagnostics: readDiagnostics(data.diagnostics),
  };
}
function readTrace(value: unknown): WebsiteTrace[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 40) throw invalid();
  return value.map(value => {
    const item = record(value);
    if (!['ok', 'error'].includes(text(item.status))) throw invalid();
    return {
      action: cappedText(item.action, 128), status: item.status as WebsiteTrace['status'], round: revision(item.round),
      message: cappedText(item.message, 2000), diagnostics: readDiagnostics(item.diagnostics),
      ...(item.model_call === undefined ? {} : { model_call: readModelCall(item.model_call) }),
    };
  });
}
function readJob(value: unknown): WebsiteJob {
  const data = record(value);
  if (!['chat', 'generate'].includes(text(data.kind)) || !statuses.includes(text(data.status))) throw invalid();
  return {
    id: identifier(data.id), kind: data.kind as WebsiteJob['kind'], status: data.status as WebsiteJob['status'],
    error_code: data.error_code === null ? null : cappedText(data.error_code, 128), result_version_id: nullableId(data.result_version_id), created_at: time(data.created_at),
    progress: readProgress(data.progress), trace: readTrace(data.trace),
  };
}
function readState(value: unknown, restaurantId: string): WebsiteState {
  const data = record(value);
  const agent = record(data.agent);
  if (!Array.isArray(agent.messages) || !Array.isArray(data.versions) || !Array.isArray(data.jobs)
    || typeof data.model_configured !== 'boolean' || data.menu_recognition_enabled !== true) throw invalid();
  const messages = agent.messages.map((value): WebsiteState['agent']['messages'][number] => {
    const message = record(value);
    if (message.role !== 'user' && message.role !== 'assistant') throw invalid();
    return { role: message.role, content: text(message.content) };
  });
  const menu = record(data.menu);
  if (!['empty', 'draft', 'confirmed'].includes(text(menu.status))) throw invalid();
  const menuState = { revision: revision(menu.revision), status: menu.status as WebsiteState['menu']['status'], item_count: revision(menu.item_count) };
  const versions = data.versions.map((value) => readVersion(value, restaurantId));
  const jobs = data.jobs.map(readJob);
  if (new Set(versions.map(item => item.id)).size !== versions.length || new Set(jobs.map(item => item.id)).size !== jobs.length) throw invalid();
  return {
    agent: { id: nullableId(agent.id), revision: revision(agent.revision), messages, design_brief: text(agent.design_brief) },
    versions, jobs, publication: readPublication(data.publication), model: text(data.model),
    model_configured: data.model_configured, menu_recognition_enabled: true, menu: menuState,
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
  signal?: AbortSignal; body?: unknown; key?: string; csrfOnly?: boolean; expectedStatus: number; accept?: string;
}): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = window.setTimeout(abort, 20000);
  try {
    const headers = new Headers({ Accept: options.accept ?? 'application/json' });
    if (options.body !== undefined) {
      if (!options.csrfOnly && (!options.key || !/^[A-Za-z0-9_-]{16,128}$/.test(options.key))) throw new ApiError(400, 'REQUEST_INVALID');
      await abortable(refreshCsrf(), controller.signal);
      headers.set('X-CSRF-Token', getCsrfToken());
      headers.set('Content-Type', 'application/json');
      if (options.key) headers.set('Idempotency-Key', options.key);
    }
    if (controller.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
    const response = await fetch(path, {
      method: options.body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      referrerPolicy: 'same-origin', redirect: 'error', headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 401) {
        notifySessionExpired();
        throw new ApiError(401, 'SESSION_EXPIRED');
      }
      const value: unknown = await response.json().catch(() => undefined);
      const body = value && typeof value === 'object' ? value as Partial<ApiErrorBody> : {};
      const retry = response.headers.get('Retry-After');
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
  getUsage: (restaurantId: string, jobId: string, signal?: AbortSignal) => request(`${jobPath(restaurantId, jobId)}/usage`,
    async response => readUsage(await json(response), jobId), { expectedStatus: 200, signal }),
  cancel: (restaurantId: string, jobId: string, body: WebsiteCancelInput, signal?: AbortSignal) => {
    if (body.confirmed !== true) throw new ApiError(422, 'REQUEST_INVALID');
    return request(`${jobPath(restaurantId, jobId)}/cancel`, async (response): Promise<WebsiteCancelled> => {
      const data = record(await json(response));
      if (identifier(data.job_id) !== jobId || data.status !== 'failed') throw invalid();
      return { job_id: jobId, status: 'failed' };
    }, { body: { confirmed: true }, csrfOnly: true, signal, expectedStatus: 200 });
  },
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

export {
  rewriteWebsitePreview, previewDocumentUrl, textDataUrl,
  PREVIEW_DOCUMENT_LIMIT, PREVIEW_PLACEHOLDER_IMAGE,
} from './website-preview';

const errorMessages: Record<string, string> = {
  MENU_CONFIRM_REQUIRED: '请先在菜单识图中核对并确认菜单，再生成网页。',
  MENU_REVISION_CONFLICT: '菜单版本已变化，请核查网页状态和当前菜单，重新确认后再生成。',
  MENU_JOB_BUSY: '本店菜单图片正在识别，请等待结束后再生成网页。',
  AI_NOT_CONFIGURED: '网页 Agent 尚未配置，不能发送需求或生成网页。请联系服务维护人员。',
  AI_BALANCE_INSUFFICIENT: '模型服务余额不足，请联系服务维护人员处理并核对任务记录。',
  AI_UPSTREAM_UNAVAILABLE: '模型服务暂时不可用，请核对任务状态后再决定是否重新提交。',
  MODEL_OUTPUT_INVALID: '模型输出未通过安全或格式检查，请核对任务记录并调整需求。',
  JOB_INTERRUPTED: '后台任务被中断，请核对任务与版本记录后再发起新任务。',
  WEBSITE_JOB_BUSY: '当前已有网页后台任务，请等待完成后再发送需求或生成。',
  WEBSITE_VERSION_LIMIT: '这是旧任务的版本限额错误，并非当前生成限制；请核对任务记录后手动决定是否重新生成。',
  AGENT_CANCELLED: '你已确认停止本次生成；不会自动发布或重新生成，已发生的费用仍会累计。',
  WEBSITE_DAILY_LIMIT: '已达到每账号每日 30 个建站任务 / 对话 / 识图的合计上限（不是模型调用次数），请明日再试。',
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
  AI_DAILY_LIMIT_EXCEEDED: '已达到每账号每日 30 个建站任务 / 对话 / 识图的合计上限（不是模型调用次数），请明日再试。',
  WEBSITE_DAILY_LIMIT_EXCEEDED: '已达到每账号每日 30 个建站任务 / 对话 / 识图的合计上限（不是模型调用次数），请明日再试。',
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
  if (error.status === 401) return '会话已失效，请重新登录。原写请求不会自动重放。';
  if (Object.hasOwn(errorMessages, error.code)) return errorMessages[error.code];
  if (error.status === 402) return '模型服务余额不足，本次操作未自动重试。请核对账户与任务记录后再手动决定。';
  if (error.status === 403) return '权限或安全校验失效，请核对账户后手动重试。';
  if (error.status === 404) return '餐厅、任务、网页版本或素材不存在，或不属于当前账户。';
  if (error.status === 412 || error.status === 428) return errorMessages.REVISION_CONFLICT;
  if (error.status === 429) return '频率或每日配额受限；每账号每日合计最多 30 个建站任务 / 对话 / 识图，不是模型调用次数。请稍后手动再试。';
  if (error.status === 422) return errorMessages.REQUEST_INVALID;
  if (error.status >= 500) return '服务暂时不可用，操作结果尚未确认。请核查任务与发布记录。';
  return '操作未完成，请核对任务、版本和输入后再确认。';
}
export function websiteJobErrorMessage(code: string | null): string {
  // 服务端 failed 是已知终态，不能套用网络提交“结果未知”的提示。
  const reason = code && /(?:BUDGET|TOKEN|(?:MODEL_)?CALL|REPAIR|ROUND|ITERATION|DURATION|TIME).*(?:LIMIT|EXCEEDED|EXHAUSTED)/.test(code)
    ? '这是旧任务的累计 tokens、调用或修复限额错误，并非当前调试模式的限制；旧任务不会自动恢复。'
    : code === 'REQUEST_TIMEOUT' ? '后台处理超时，已终止本次任务。'
      : code === 'NETWORK_ERROR' ? '后台连接模型服务失败。'
        : code === 'RESPONSE_INVALID' ? '后台服务响应未通过检查。'
          : code && Object.hasOwn(errorMessages, code) ? errorMessages[code]
            : '请核对资料、需求与版本记录后再决定是否发起新任务。';
  return `本次Agent已停止，保留检查结果。${reason}`;
}
export function isWebsiteJobActive(job: WebsiteJob) { return job.status === 'queued' || job.status === 'running'; }
export function isWebsiteWriteUncertain(error: unknown) {
  return !(error instanceof ApiError) || error.status === 0 || error.status >= 500 || /^IDEMPOTENCY/.test(error.code);
}
