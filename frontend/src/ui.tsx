import { useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { ApiError } from './api';

const errorMessages: Record<string, string> = {
  UNAUTHENTICATED: 'Your session has expired, or your email and password do not match. Please sign in again.',
  EMAIL_VERIFICATION_REQUIRED: 'Verify your email before signing in. You can request another verification email.',
  ACCOUNT_UNAVAILABLE: 'This account is unavailable. Please contact support.',
  FORBIDDEN: 'This action is not authorized. Check your session and the service configuration.',
  CSRF_INVALID: 'The security check expired. A refresh was attempted. Review your request and submit it again.',
  CSRF_TOKEN_INVALID: 'The security check expired. A refresh was attempted. Review your request and submit it again.',
  ORIGIN_FORBIDDEN: 'This request origin is not allowed. Check HTTPS and the service origin configuration.',
  REQUEST_INVALID: 'The request format is invalid. Check the information you entered.',
  NOT_FOUND: 'This restaurant was not found or is not available to your account.',
  CONFLICT: 'This request conflicts with the current information. Review it before submitting again.',
  IDEMPOTENCY_CONFLICT: 'The creation request has changed. Check the list before starting a new request.',
  IDEMPOTENCY_KEY_CONFLICT: 'The creation request has changed. Check the list before starting a new request.',
  ACTION_TOKEN_EXPIRED: 'This email link is no longer valid or has expired. Request a new link.',
  ACTION_TOKEN_INVALID: 'This email link is invalid. Request a new link.',
  REVISION_CONFLICT: 'This information changed in another window. Your unsaved edits are still here. Review them before refreshing; they cannot overwrite the newer version.',
  VALIDATION_FAILED: 'Some fields need attention. Review the details below.',
  PRECONDITION_REQUIRED: 'The current information version is missing. Refresh before saving.',
  UNSUPPORTED_MEDIA_TYPE: 'This request format is not supported. Please contact support.',
  RATE_LIMITED: 'Too many requests. Please wait before trying again.',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable. The outcome is unknown. Check the current state before trying again.',
  NETWORK_ERROR: 'The service could not be reached. The outcome is unknown. Check your connection and the current state before trying again.',
  REQUEST_TIMEOUT: 'The request timed out. The outcome is unknown. Check the current state before trying again.',
  RESPONSE_INVALID: 'The service returned an unexpected response. The outcome is unknown; this response cannot be used.',
  ETAG_INVALID: 'A valid information version was not received. Refresh or contact support before saving.',
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
  500: errorMessages.SERVICE_UNAVAILABLE,
  502: errorMessages.SERVICE_UNAVAILABLE,
  503: errorMessages.SERVICE_UNAVAILABLE,
  504: errorMessages.SERVICE_UNAVAILABLE,
};
export const fieldLabels: Record<string, string> = {
  email: 'Email address', password: 'Password', new_password: 'New password', current_password: 'Current password',
  display_name: 'Display name', locale: 'Language', terms_version: 'Terms version', accepted_terms: 'Terms acceptance',
  name: 'Restaurant name', description: 'Restaurant description', cuisine_label: 'Cuisine', country_code: 'Country code',
  region: 'State / region', city: 'City', address_line1: 'Address line 1', address_line2: 'Address line 2',
  postal_code: 'Postal code', contact_email: 'Contact email', phone: 'Phone number', timezone: 'Time zone',
  currency_code: 'Currency code', primary_locale: 'Restaurant language', opening_hours: 'Weekly opening hours',
  privacy_notice: 'Privacy notice', intervals: 'Opening intervals', token: 'Email link',
  weekday: 'Day of the week', opens_at_local: 'Opening time', closes_at_local: 'Closing time',
  closes_day_offset: 'Closing day', accepts_requests: 'Request settings', sort_order: 'Sort order',
};
const detailMessages: Record<string, string> = {
  REQUIRED: 'This field is required', MISSING: 'This field is required', TOO_SHORT: 'Too short', TOO_LONG: 'Exceeds the length limit',
  MIN_LENGTH: 'Too short', MAX_LENGTH: 'Exceeds the length limit', INVALID: 'Invalid format or value',
  INVALID_FORMAT: 'Invalid format', FORMAT: 'Invalid format', PATTERN: 'Invalid format',
  INVALID_EMAIL: 'Enter a valid email address', INVALID_PHONE: 'Use the international phone number format',
  INVALID_TIMEZONE: 'Enter a valid IANA time zone or UTC', UNSUPPORTED_TIMEZONE: 'This time zone is not supported',
  INVALID_CURRENCY: 'Enter a supported three-letter currency code', UNSUPPORTED_CURRENCY: 'This currency is not supported',
  UNSUPPORTED_LOCALE: 'This language is not supported', INVALID_LOCALE: 'Invalid language code',
  TERMS_VERSION_OUTDATED: 'The terms have changed. Reload and review them before accepting', TERMS_VERSION_MISMATCH: 'The terms have changed. Reload and review them before accepting',
  WEAK_PASSWORD: 'Choose a longer password that is harder to guess', PASSWORD_COMPROMISED: 'Choose a password that has not appeared in a data breach',
  INTERVAL_OVERLAP: 'Overlaps another interval, including across midnight or the week boundary', OVERLAP: 'Opening intervals overlap',
  INVALID_DURATION: 'Each interval must be longer than 0 and no longer than 24 hours', TIMEZONE_REQUIRED: 'Save the restaurant time zone first',
  OUT_OF_RANGE: 'Outside the allowed range', ENUM: 'This value is not supported', UNKNOWN_FIELD: 'This field cannot be changed',
};
function detailLabel(field: string) {
  if (Object.hasOwn(fieldLabels, field)) return fieldLabels[field];
  const match = /^intervals(?:\[(\d{1,2})\]|\.(\d{1,2}))\.(\w+)$/.exec(field);
  if (match && Object.hasOwn(fieldLabels, match[3])) return `Interval ${Number(match[1] ?? match[2]) + 1} · ${fieldLabels[match[3]]}`;
  return 'Entered information';
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const apiError = error instanceof ApiError ? error : null;
  const knownCode = apiError && Object.hasOwn(errorMessages, apiError.code) ? apiError.code : null;
  const message = apiError?.status === 500 ? statusMessages[500] : knownCode ? errorMessages[knownCode] : apiError ? statusMessages[apiError.status] ?? 'The request could not be confirmed. Check the current state before trying again.' : 'The action could not be confirmed. Check the current state before trying again.';
  const retryAfter = apiError?.retryAfter;
  return (
    <div className="notice error-notice" role="alert">
      <p>{message}</p>
      {apiError && <p className="micro">Error code: {knownCode ?? 'REQUEST_FAILED'}{apiError.status > 0 ? ` · HTTP ${apiError.status}` : ''}</p>}
      {apiError && apiError.details.length > 0 && <ul>{apiError.details.map((detail, index) => {
        const code = detail.code.toUpperCase();
        return <li key={index}>{detailLabel(detail.field)}: {Object.hasOwn(detailMessages, code) ? detailMessages[code] : 'Check the format and allowed range'}</li>;
      })}</ul>}
      {typeof retryAfter === 'number' && Number.isInteger(retryAfter) && retryAfter >= 0 && retryAfter <= 999999 && <p>Wait at least {retryAfter} seconds before trying again.</p>}
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
      {action.pending && <p className="micro loading-text" role="status">Working. Please wait…</p>}
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

export const acceptedMessage = 'Check your email for the next step.';

export function LocaleSelect({ name, defaultValue, locales, id }: {
  name: string; defaultValue?: string; locales: string[]; id: string;
}) {
  return <select id={id} name={name} defaultValue={defaultValue && locales.includes(defaultValue) ? defaultValue : locales.includes('en') ? 'en' : locales[0]} required>
    {locales.map((locale) => <option key={locale} value={locale}>{locale === 'zh-CN' ? 'Chinese (Simplified)' : locale === 'en' ? 'English' : locale}</option>)}
  </select>;
}
