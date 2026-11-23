import { ApiError } from './api';

// 固定展示换算，不授额、不定价、不结算，也不重新解释历史用量。
export const USAGE_CREDIT_DISPLAY_POLICY = 'credit-display-v1';
export const USAGE_TOKENS_PER_CREDIT = 100;
const integerFormat = new Intl.NumberFormat('en-US');

export function formatUsageCredits(tokens: number | null): string {
  if (tokens === null) return '—';
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new ApiError(502, 'USAGE_RESPONSE_INVALID');
  // 商和余数保留安全整数上限处的精确百分位，不逐调用向上取整。
  const value = BigInt(tokens), divisor = BigInt(USAGE_TOKENS_PER_CREDIT);
  const whole = integerFormat.format(value / divisor);
  const fraction = (value % divisor).toString().padStart(2, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export function formatUsageCreditBalance(tokens: number | null): string {
  if (tokens === null) return '—';
  if (!Number.isSafeInteger(tokens)) throw new ApiError(502, 'USAGE_RESPONSE_INVALID');
  const value = BigInt(tokens), magnitude = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${formatUsageCredits(Number(magnitude))}`;
}

export function creditPeriodRange(period: { starts_at: string; ends_at: string }): string {
  const lastDay = new Date(Date.parse(period.ends_at) - 86_400_000).toISOString().slice(0, 10);
  return `${period.starts_at.slice(0, 10)} – ${lastDay}`;
}
