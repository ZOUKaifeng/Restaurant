import { useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { ApiError } from './api';

const errorMessages: Record<string, string> = {
  UNAUTHENTICATED: '会话已失效，或邮箱与密码不匹配。请重新登录。',
  EMAIL_VERIFICATION_REQUIRED: '请先验证邮箱。可重新申请验证邮件。',
  ACCOUNT_UNAVAILABLE: '当前账号不可用，请联系服务维护人员。',
  FORBIDDEN: '此操作未获授权，请检查会话和本地同源配置后重试。',
  CSRF_INVALID: '安全校验已失效，已尝试更新。请重新确认并提交。',
  CSRF_TOKEN_INVALID: '安全校验已失效，已尝试更新。请重新确认并提交。',
  ORIGIN_FORBIDDEN: '请求来源不被允许，请检查本地 HTTPS 和后端来源配置。',
  REQUEST_INVALID: '请求格式不正确，请检查填写内容。',
  NOT_FOUND: '餐厅不存在，或不属于当前账户。',
  CONFLICT: '请求与现有资料或资源状态冲突，请检查后再提交。',
  IDEMPOTENCY_CONFLICT: '创建请求内容发生变化，请先核对列表，再开始新请求。',
  IDEMPOTENCY_KEY_CONFLICT: '创建请求内容发生变化，请先核对列表，再开始新请求。',
  ACTION_TOKEN_EXPIRED: '链接已失效或过期，请重新申请邮件。',
  ACTION_TOKEN_INVALID: '链接无效，请重新申请邮件。',
  REVISION_CONFLICT: '资料已在另一窗口更新。未保存内容仍在本页，请确认后刷新，不能直接覆盖。',
  VALIDATION_FAILED: '部分字段未通过校验，请根据下方提示修改。',
  PRECONDITION_REQUIRED: '未取得资料版本，请刷新后再保存。',
  UNSUPPORTED_MEDIA_TYPE: '请求格式不受支持。请联系服务维护人员。',
  RATE_LIMITED: '请求过于频繁，请稍后再试。',
  SERVICE_UNAVAILABLE: '服务暂时不可用，未确认操作成功。请稍后重试。',
  NETWORK_ERROR: '无法连接服务。未确认操作成功，请检查连接后重试。',
  REQUEST_TIMEOUT: '请求超时，结果尚未确认。创建可重试同一请求；修改请先核对最新资料。',
  RESPONSE_INVALID: '服务响应与接口契约不一致，不能继续使用这份资料。',
  ETAG_INVALID: '未获得有效的资料版本，不能保存。请刷新或联系服务维护人员。',
};
const statusMessages: Record<number, string> = {
  401: errorMessages.UNAUTHENTICATED,
  403: errorMessages.FORBIDDEN,
  404: errorMessages.NOT_FOUND,
  409: errorMessages.CONFLICT,
  410: errorMessages.ACTION_TOKEN_EXPIRED,
  412: errorMessages.REVISION_CONFLICT,
  422: errorMessages.VALIDATION_FAILED,
  428: errorMessages.PRECONDITION_REQUIRED,
  429: errorMessages.RATE_LIMITED,
  503: errorMessages.SERVICE_UNAVAILABLE,
};
export const fieldLabels: Record<string, string> = {
  email: '邮箱', password: '密码', new_password: '新密码', current_password: '当前密码',
  display_name: '称呼', locale: '账户语言', terms_version: '条款版本', accepted_terms: '条款确认',
  name: '餐厅名称', description: '餐厅简介', cuisine_label: '菜系', country_code: '国家代码',
  region: '地区', city: '城市', address_line1: '地址第一行', address_line2: '地址第二行',
  postal_code: '邮政编码', contact_email: '联系邮箱', phone: '联系电话', timezone: '时区',
  currency_code: '币种代码', primary_locale: '餐厅主要语言', opening_hours: '周营业时间',
  privacy_notice: '隐私告知', intervals: '营业时段', token: '邮件链接',
  weekday: '星期', opens_at_local: '开始时间', closes_at_local: '结束时间',
  closes_day_offset: '结束日期', accepts_requests: '申请规则', sort_order: '排序',
};
const detailMessages: Record<string, string> = {
  REQUIRED: '请填写此项', MISSING: '请填写此项', TOO_SHORT: '长度不足', TOO_LONG: '超过长度上限',
  MIN_LENGTH: '长度不足', MAX_LENGTH: '超过长度上限', INVALID: '格式或内容不正确',
  INVALID_FORMAT: '格式不正确', FORMAT: '格式不正确', PATTERN: '格式不正确',
  INVALID_EMAIL: '邮箱格式不正确', INVALID_PHONE: '请使用国际电话格式',
  INVALID_TIMEZONE: '请填写真实 IANA 时区或 UTC', UNSUPPORTED_TIMEZONE: '此时区不受支持',
  INVALID_CURRENCY: '请填写受支持的三位币种代码', UNSUPPORTED_CURRENCY: '此币种不受支持',
  UNSUPPORTED_LOCALE: '此语言不受支持', INVALID_LOCALE: '语言代码不正确',
  TERMS_VERSION_OUTDATED: '版本已更新，请重新读取并确认条款', TERMS_VERSION_MISMATCH: '版本已更新，请重新读取并确认条款',
  WEAK_PASSWORD: '请选用更难猜测的长密码', PASSWORD_COMPROMISED: '请改用未泄露的密码',
  INTERVAL_OVERLAP: '与另一时段重叠，包括跨午夜或周界', OVERLAP: '营业时段重叠',
  INVALID_DURATION: '单段必须大于 0 且不超过 24 小时', TIMEZONE_REQUIRED: '请先保存餐厅时区',
  OUT_OF_RANGE: '超出允许范围', ENUM: '取值不受支持', UNKNOWN_FIELD: '不允许修改此字段',
};
function detailLabel(field: string) {
  if (fieldLabels[field]) return fieldLabels[field];
  const match = /^intervals(?:\[(\d{1,2})\]|\.(\d{1,2}))\.(\w+)$/.exec(field);
  if (match && fieldLabels[match[3]]) return `第 ${Number(match[1] ?? match[2]) + 1} 段 · ${fieldLabels[match[3]]}`;
  return '填写内容';
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const apiError = error instanceof ApiError ? error : null;
  const knownCode = apiError && Object.hasOwn(errorMessages, apiError.code) ? apiError.code : null;
  const message = knownCode ? errorMessages[knownCode] : apiError ? statusMessages[apiError.status] ?? '请求未完成，请检查内容后重试。' : '操作未完成，请重试。';
  return (
    <div className="notice error-notice" role="alert">
      <p>{message}</p>
      {apiError && <p className="micro">错误代码：{knownCode ?? 'REQUEST_FAILED'}{apiError.status > 0 ? ` · HTTP ${apiError.status}` : ''}</p>}
      {apiError && apiError.details.length > 0 && <ul>{apiError.details.map((detail, index) => {
        const code = detail.code.toUpperCase();
        return <li key={index}>{detailLabel(detail.field)}：{Object.hasOwn(detailMessages, code) ? detailMessages[code] : '未通过校验，请检查格式和允许范围'}</li>;
      })}</ul>}
      {apiError?.retryAfter !== null && apiError?.retryAfter !== undefined && <p>请至少等待 {apiError.retryAfter} 秒后再试。</p>}
    </div>
  );
}

export function useAction(onBusyChange?: (busy: boolean) => void) {
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState('');
  async function run(action: () => Promise<string | void>) {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError(null);
    setNote('');
    onBusyChange?.(true);
    try {
      const message = await action();
      if (message) setNote(message);
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) setError(caught);
    } finally {
      lock.current = false;
      setPending(false);
      onBusyChange?.(false);
    }
  }
  function clear() { setError(null); setNote(''); }
  return { pending, error, note, run, clear };
}

export function ActionFeedback({ action }: { action: Pick<ReturnType<typeof useAction>, 'pending' | 'error' | 'note'> }) {
  return <>
    <div aria-live="polite" aria-atomic="true">
      {action.pending && <p className="micro loading-text" role="status">正在处理，请稍候…</p>}
      {action.note && <div className="notice"><p>{action.note}</p></div>}
    </div>
    <ErrorNotice error={action.error} />
  </>;
}

export type Navigate = (path: string) => void;
export function PageLink({ href, navigate, disabled = false, children, className }: {
  href: string; navigate: Navigate; disabled?: boolean; children: ReactNode; className?: string;
}) {
  function follow(event: MouseEvent<HTMLAnchorElement>) {
    if (disabled) { event.preventDefault(); return; }
    if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) {
      event.preventDefault();
      navigate(href);
    }
  }
  return <a href={href} onClick={follow} className={className} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : undefined}>{children}</a>;
}

export const acceptedMessage = '已受理，邮件是否送达取决于发送状态。如该请求符合条件，系统将向对应邮箱发送说明；此结果不表示邮箱已验证。';

export function LocaleSelect({ name, defaultValue, locales, id }: {
  name: string; defaultValue?: string; locales: string[]; id: string;
}) {
  return <select id={id} name={name} defaultValue={defaultValue && locales.includes(defaultValue) ? defaultValue : locales.includes('zh-CN') ? 'zh-CN' : locales[0]} required>
    {locales.map((locale) => <option key={locale} value={locale}>{locale === 'zh-CN' ? '简体中文' : locale === 'en' ? '英语' : locale}</option>)}
  </select>;
}
