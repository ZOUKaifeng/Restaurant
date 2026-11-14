import { existsSync, readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createRequire } from 'node:module';
import type { AnySchema, ValidateFunction } from 'ajv';
import { ApiError, invalid } from './errors.js';

const sourceContract = new URL('../contracts/merchant-core.openapi.json', import.meta.url);
const contractUrl = existsSync(sourceContract) ? sourceContract : new URL('../../contracts/merchant-core.openapi.json', import.meta.url);
export const contract = JSON.parse(readFileSync(contractUrl, 'utf8'));
const ajv = new Ajv2020({ allErrors: true, removeAdditional: false, coerceTypes: false, useDefaults: false, strict: true });
const addFormats = createRequire(import.meta.url)('ajv-formats') as typeof import('ajv-formats').default;
addFormats(ajv);
ajv.addKeyword({ keyword: 'components', valid: true });
ajv.addSchema({ $id: 'merchant-core', components: contract.components });
const compiled = new Map<string, ValidateFunction>();
export function schemaValidator(name: string): ValidateFunction {
  let validate = compiled.get(name);
  if (!validate) { validate = ajv.compile({ $ref: `merchant-core#/components/schemas/${name}` }); compiled.set(name, validate); }
  return validate;
}
export function validateSchema(name: string, value: unknown): void {
  const validate = schemaValidator(name);
  if (!validate(value)) throw new ApiError(422, undefined, (validate.errors ?? []).slice(0, 50).map(error => ({ field: (error.instancePath || '$').slice(0, 128), code: error.keyword })));
}
export function validateParameter(name: string, value: unknown, status = 400): void {
  const schema = contract.components.parameters[name].schema as AnySchema;
  if (!ajv.validate(schema, value)) throw new ApiError(status);
}
export type Input = Record<string, unknown>;
export const locales = ['en', 'zh-CN'];
const timezones = new Set<string>(['UTC', ...Intl.supportedValuesOf('timeZone')]);
const currencies = new Set<string>(Intl.supportedValuesOf('currency'));
export function validTimezone(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (timezones.has(value)) return true;
  if (!value.includes('/')) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; }
}
export function input(name: string, value: unknown): Input {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('$', 'OBJECT_REQUIRED');
  const result: Input = { ...(value as Input) };
  for (const [key, child] of Object.entries(value)) {
    result[key] = typeof child === 'string' && !['password', 'current_password', 'new_password', 'token'].includes(key) ? child.trim() : child;
  }
  if (typeof result.email === 'string') result.email = result.email.toLowerCase();
  if (typeof result.contact_email === 'string') result.contact_email = result.contact_email.toLowerCase();
  validateSchema(name, result);
  for (const key of ['locale', 'primary_locale']) if (result[key] !== undefined && !locales.includes(result[key] as string)) invalid(key, 'UNSUPPORTED_LOCALE');
  if (result.timezone !== undefined && result.timezone !== null && !validTimezone(result.timezone)) invalid('timezone', 'INVALID_TIMEZONE');
  if (result.currency_code !== undefined && result.currency_code !== null && !currencies.has(result.currency_code as string)) invalid('currency_code', 'UNSUPPORTED_CURRENCY');
  return result;
}
export interface Interval { weekday: number; opens_at_local: string; closes_at_local: string; closes_day_offset: number; accepts_requests: boolean; sort_order: number }
export function validateIntervals(intervals: Interval[]): void {
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const segments: [number, number][] = [];
  for (const [i, interval] of intervals.entries()) {
    const duration = minutes(interval.closes_at_local) + interval.closes_day_offset * 1440 - minutes(interval.opens_at_local);
    if (duration <= 0 || duration > 1440) invalid(`intervals/${i}`, 'INVALID_DURATION');
    const start = (interval.weekday - 1) * 1440 + minutes(interval.opens_at_local), end = start + duration;
    segments.push([start, Math.min(end, 10080)]);
    if (end > 10080) segments.push([0, end - 10080]);
  }
  segments.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < segments.length; i++) if (segments[i]![0] < segments[i - 1]![1]) invalid('intervals', 'OVERLAP');
}
