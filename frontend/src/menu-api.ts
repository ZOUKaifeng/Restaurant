import { ApiError, getCsrfToken, notifySessionExpired, refreshCsrf } from './api';
import type { ApiErrorBody } from './types';
import type {
  MenuAccepted, MenuConfirmInput, MenuData, MenuDraft, MenuJob, MenuPatchInput,
  MenuRecognitionInput, MenuState,
} from './menu-types';

export const menuLimits = {
  categories: 20, items: 80, categoryName: 150, itemName: 200,
  description: 1000, price: 80, reviewNote: 500, warnings: 20, warning: 500,
  images: 4, imageBytes: 20 * 1024 * 1024, requestBytes: 1024 * 1024,
} as const;
const idPattern = /^[A-Za-z0-9_-]{16,64}$/;
const statuses = ['queued', 'running', 'succeeded', 'failed'];
const invalid = () => new ApiError(502, 'RESPONSE_INVALID');
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number, required = false): string {
  if (typeof value !== 'string' || Array.from(value).length > maximum || (required && !value.trim())) throw invalid();
  return value;
}
function nullableText(value: unknown, maximum: number): string | null {
  return value === null ? null : text(value, maximum);
}
function revision(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw invalid();
  return value;
}
function identifier(value: unknown): string {
  const result = text(value, 64);
  if (!idPattern.test(result)) throw invalid();
  return result;
}
function time(value: unknown): string {
  const result = text(value, 100, true);
  if (!Number.isFinite(Date.parse(result))) throw invalid();
  return result;
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > menuLimits.images) throw invalid();
  const result = value.map(identifier);
  if (new Set(result).size !== result.length) throw invalid();
  return result;
}
function readData(value: unknown): MenuData {
  const data = record(value);
  if (!Array.isArray(data.categories) || data.categories.length > menuLimits.categories
    || !Array.isArray(data.warnings) || data.warnings.length > menuLimits.warnings) throw invalid();
  let itemCount = 0;
  const categories = data.categories.map(value => {
    const category = record(value);
    if (!Array.isArray(category.items)) throw invalid();
    itemCount += category.items.length;
    if (itemCount > menuLimits.items) throw invalid();
    return {
      name: text(category.name, menuLimits.categoryName, true),
      items: category.items.map(value => {
        const item = record(value);
        return {
          name: text(item.name, menuLimits.itemName, true),
          description: nullableText(item.description, menuLimits.description),
          price_text: nullableText(item.price_text, menuLimits.price),
          review_note: nullableText(item.review_note, menuLimits.reviewNote),
        };
      }),
    };
  });
  return { categories, warnings: data.warnings.map(value => text(value, menuLimits.warning)) };
}
function readDraft(value: unknown): MenuDraft {
  const data = record(value);
  if (!['empty', 'draft', 'confirmed'].includes(text(data.status, 20))) throw invalid();
  const content = readData(data.data);
  const confirmedAt = data.confirmed_at === null ? null : time(data.confirmed_at);
  if ((data.status === 'confirmed') !== (confirmedAt !== null)
    || (data.status === 'empty' && content.categories.length !== 0)) throw invalid();
  return {
    revision: revision(data.revision, data.status === 'empty' ? 0 : 1),
    status: data.status as MenuDraft['status'], data: content,
    source_asset_ids: ids(data.source_asset_ids), confirmed_at: confirmedAt,
  };
}
function readJob(value: unknown): MenuJob {
  const data = record(value);
  if (!statuses.includes(text(data.status, 20))) throw invalid();
  return {
    id: identifier(data.id), status: data.status as MenuJob['status'],
    error_code: nullableText(data.error_code, 150), created_at: time(data.created_at),
    result_revision: data.result_revision === null ? null : revision(data.result_revision, 1),
  };
}
function readState(value: unknown): MenuState {
  const data = record(value);
  if (!Array.isArray(data.jobs) || typeof data.model_configured !== 'boolean'
    || data.input_mode !== 'vision' || data.pdf_supported !== false) throw invalid();
  const jobs = data.jobs.map(readJob);
  if (new Set(jobs.map(job => job.id)).size !== jobs.length) throw invalid();
  return {
    draft: data.draft === null ? null : readDraft(data.draft), jobs,
    model: text(data.model, 150), model_configured: data.model_configured,
    input_mode: 'vision', pdf_supported: false,
  };
}
function readAccepted(value: unknown): MenuAccepted {
  const data = record(value);
  if (!statuses.includes(text(data.status, 20))) throw invalid();
  return { job_id: identifier(data.job_id), status: data.status as MenuAccepted['status'] };
}
function basePath(id: string) {
  if (!idPattern.test(id)) throw new ApiError(400, 'REQUEST_INVALID');
  return `/api/v1/restaurants/${encodeURIComponent(id)}/menu`;
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('请求已取消', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('请求已取消', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function request<T>(path: string, read: (value: unknown) => T, options: {
  method?: 'GET' | 'POST' | 'PATCH'; body?: unknown; key?: string; signal?: AbortSignal; expectedStatus: number;
}): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = window.setTimeout(abort, 20000);
  try {
    const headers = new Headers({ Accept: 'application/json' });
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined) {
      if (new TextEncoder().encode(body).length > menuLimits.requestBytes) throw new ApiError(413, 'MENU_DATA_TOO_LARGE');
      await abortable(refreshCsrf(), controller.signal);
      headers.set('X-CSRF-Token', getCsrfToken());
      headers.set('Content-Type', 'application/json');
    }
    if (options.key !== undefined) {
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(options.key)) throw new ApiError(400, 'REQUEST_INVALID');
      headers.set('Idempotency-Key', options.key);
    }
    if (controller.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
    const response = await fetch(path, {
      method: options.method ?? 'GET', body, headers, credentials: 'same-origin',
      cache: 'no-store', referrerPolicy: 'same-origin', redirect: 'error', signal: controller.signal,
    });
    const value: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const data = value && typeof value === 'object' ? value as Partial<ApiErrorBody> : {};
      const details = Array.isArray(data.details) ? data.details.filter((item): item is ApiErrorBody['details'][number] =>
        !!item && typeof item.field === 'string' && typeof item.code === 'string').slice(0, 50) : [];
      const retry = response.headers.get('Retry-After');
      if (response.status === 401 && /^Session(?:\s|$)/i.test(response.headers.get('WWW-Authenticate') ?? '')) notifySessionExpired();
      // 403 只表示权限或 CSRF 校验失败，不冒充会话过期，也不自动重放写请求。
      throw new ApiError(response.status, typeof data.code === 'string' ? data.code : 'REQUEST_FAILED', details,
        retry && /^\d{1,6}$/.test(retry) ? Number(retry) : null);
    }
    if (response.status !== options.expectedStatus) throw invalid();
    const result = read(value);
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
function expectedRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new ApiError(422, 'REQUEST_INVALID');
}
export function menuDataProblem(data: MenuData): string | null {
  if (!data.categories.length) return '请至少保留一个分类和一道菜品。';
  if (data.categories.some(category => !category.items.length)) return '空分类不能保存，请添加菜品或删除分类。';
  try { readData(data); }
  catch { return '分类名与菜名不能为空；空分类请删除。最多 20 个分类、80 道菜品，请核对字段长度。'; }
  return null;
}
export const menuApi = {
  get: (id: string, signal?: AbortSignal) => request(basePath(id), readState, { signal, expectedStatus: 200 }),
  recognize: (id: string, input: MenuRecognitionInput, key: string, signal?: AbortSignal) => {
    expectedRevision(input.expected_revision);
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ApiError(400, 'REQUEST_INVALID');
    let assetIds: string[];
    try { assetIds = ids(input.asset_ids); } catch { throw new ApiError(422, 'REQUEST_INVALID'); }
    if (!assetIds.length || input.consent_to_ai_processing !== true) throw new ApiError(422, 'MENU_CONSENT_REQUIRED');
    return request(`${basePath(id)}/recognitions`, readAccepted, {
      method: 'POST', body: { asset_ids: assetIds, consent_to_ai_processing: true, expected_revision: input.expected_revision },
      key, signal, expectedStatus: 202,
    });
  },
  save: (id: string, input: MenuPatchInput, signal?: AbortSignal) => {
    expectedRevision(input.expected_revision);
    if (menuDataProblem(input.data)) throw new ApiError(422, 'MENU_DATA_INVALID');
    const content = readData(input.data);
    const data: MenuData = { categories: content.categories.map(category => ({
      name: category.name, items: category.items.map(item => ({
        name: item.name, description: item.description === '' ? null : item.description,
        price_text: item.price_text === '' ? null : item.price_text,
        review_note: item.review_note === '' ? null : item.review_note,
      })),
    })), warnings: content.warnings };
    return request(basePath(id), value => {
      const draft = readDraft(value);
      if (draft.status !== 'draft' || draft.revision <= input.expected_revision) throw invalid();
      return draft;
    }, { method: 'PATCH', body: { data, expected_revision: input.expected_revision }, signal, expectedStatus: 200 });
  },
  confirm: (id: string, input: MenuConfirmInput, signal?: AbortSignal) => {
    expectedRevision(input.expected_revision);
    if (input.confirmed !== true) throw new ApiError(422, 'MENU_CONFIRMATION_REQUIRED');
    return request(`${basePath(id)}/confirm`, value => {
      const draft = readDraft(value);
      if (draft.status !== 'confirmed' || draft.revision < input.expected_revision) throw invalid();
      return draft;
    }, { method: 'POST', body: { expected_revision: input.expected_revision, confirmed: true }, signal, expectedStatus: 200 });
  },
};

const errors: Record<string, string> = {
  AI_NOT_CONFIGURED: 'DeepSeek 视觉识别尚未配置，不能提交识别。请联系服务维护人员。',
  AI_BALANCE_INSUFFICIENT: '模型服务余额不足，请联系服务维护人员并核对任务记录。',
  AI_RATE_LIMITED: '模型调用受限，请稍后手动操作；不会自动重复付费调用。',
  AI_DAILY_LIMIT_EXCEEDED: '已达到模型每日调用上限，请稍后再试。',
  AI_UPSTREAM_UNAVAILABLE: '模型服务暂时不可用，请核对任务记录。',
  AI_PROVIDER_UNAVAILABLE: '模型服务暂时不可用，请核对任务记录。',
  AI_RESPONSE_INVALID: '模型响应未通过格式检查，请核对任务记录。',
  AI_OUTPUT_INVALID: '模型输出未通过菜单结构检查，请核对原图片。',
  MODEL_OUTPUT_INVALID: '模型输出未通过菜单结构检查，请核对原图片。',
  MENU_JOB_BUSY: '当前已有菜单识别任务，请等待任务结束。',
  JOB_ALREADY_ACTIVE: '当前已有后台任务，请等待任务结束。',
  JOB_IN_PROGRESS: '当前已有后台任务，请等待任务结束。',
  JOB_INTERRUPTED: '后台任务被中断，请核对任务记录。',
  MENU_REVISION_CONFLICT: '菜单版本已变化，未自动重放；请核查最新草稿再编辑。',
  REVISION_CONFLICT: '菜单版本已变化，未自动重放；请核查最新草稿再编辑。',
  MENU_CONSENT_REQUIRED: '请先选择菜单图片并明确同意发送给 DeepSeek。',
  MENU_CONFIRMATION_REQUIRED: '请先保存草稿并勾选人工核对确认。',
  MENU_NOT_CONFIRMED: '菜单尚未人工确认，请先保存并核对。',
  MENU_DATA_INVALID: '请核对非空分类名、菜名、菜品数量与字段长度。',
  MENU_DATA_TOO_LARGE: '菜单请求超过 1 MiB，请缩短描述或审核备注后保存。',
  MENU_INPUT_TOO_LARGE: '所选菜单图片合计超过 20 MiB，请减少图片。',
  MENU_ASSET_INVALID: '仅支持当前餐厅可用的菜单 JPG / PNG；PDF 不支持识别。',
  MENU_PDF_UNSUPPORTED: 'PDF 不支持菜单识图，请上传 JPG / PNG 菜单图片。',
  MENU_DAILY_LIMIT_EXCEEDED: '已达到菜单识别每日调用上限，请稍后再试。',
  ASSET_NOT_READY: '所选素材不可用，请刷新素材后重新选择。',
  ASSET_NOT_FOUND: '所选素材已删除或不属于当前餐厅，请刷新素材。',
  IDEMPOTENCY_CONFLICT: '原请求与服务端幂等记录冲突。输入与原键仍锁定，请联系服务维护人员核查，不能换键重复计费。',
  IDEMPOTENCY_KEY_CONFLICT: '原请求与服务端幂等记录冲突。输入与原键仍锁定，请联系服务维护人员核查，不能换键重复计费。',
  REQUEST_INVALID: '请核对菜单输入、素材数量与版本。',
  RESPONSE_INVALID: '服务响应与菜单协议不一致，请核查状态；不能据此认定识别失败。',
  REQUEST_TIMEOUT: '本次 API 超时，结果未知。未取消后台任务，也不会自动重试。',
  NETWORK_ERROR: '连接失败，结果未知。请核查状态，不会自动重试写请求。',
};
export function menuErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return '操作未完成，请核对菜单与任务状态。';
  if (Object.hasOwn(errors, error.code)) return errors[error.code];
  if (error.status === 401) return '会话未获认证，请核对登录状态。原写请求不会自动重放。';
  if (error.status === 403) return '没有操作权限或安全校验失效；不会因此退出登录，也不会自动重放。';
  if (error.status === 404) return '餐厅、菜单接口或素材不存在，或不属于当前账户。';
  if (error.status === 409 || error.status === 412 || error.status === 428) return '菜单版本或任务状态冲突，请核查后重新确认。';
  if (error.status === 413) return '请求或素材超过大小限制，请核对菜单与图片大小。';
  if (error.status === 422) return errors.REQUEST_INVALID;
  if (error.status === 429) return '调用频率或配额受限，请稍后手动操作。';
  if (error.status >= 500) return '服务暂时不可用，结果尚未确认，请核查菜单状态。';
  return '操作未完成，请核对菜单与任务状态。';
}
export function menuJobErrorMessage(code: string | null): string {
  const reason = code === 'REQUEST_TIMEOUT' ? '后台模型处理超时。'
    : code === 'NETWORK_ERROR' ? '后台连接模型失败。'
      : code === 'RESPONSE_INVALID' ? '后台响应未通过格式检查。'
        : code && Object.hasOwn(errors, code) ? errors[code] : '请核对原图片和菜单内容。';
  return `识别任务已失败，不会自动重试。${reason}`;
}
export function isMenuJobActive(job: MenuJob) { return job.status === 'queued' || job.status === 'running'; }
export function isMenuWriteUncertain(error: unknown) {
  return !(error instanceof ApiError) || error.status === 0 || error.status >= 500 || /^IDEMPOTENCY/.test(error.code);
}
