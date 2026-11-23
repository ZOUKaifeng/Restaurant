import { ApiError, merchantRequest, notifySessionExpired } from './api';
import { safeLocalPublicationUrl, websiteSlugPattern } from './website-api';
import type { RestaurantProfile } from './types';
import type { MenuData } from './menu-types';
import type { WebsiteContentVersion, WebsiteContentVersionPage, WebsiteEditableContent, WebsiteWorkbenchReport, WebsiteContentDifference, WebsiteContentPreviewInput, WebsiteContentPreviewResult } from './website-types';

const ID = /^[A-Za-z0-9_-]{16,64}$/;
const HASH = /^[a-f0-9]{64}$/;
const CURSOR = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;
const fail = () => { throw new ApiError(502, 'RESPONSE_INVALID'); };
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const data = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(data, key)) || Object.keys(data).some(key => !required.includes(key) && !optional.includes(key))) return fail();
  return data;
}
function string(value: unknown, max = Infinity, min = 0): string {
  if (typeof value !== 'string' || Array.from(value).length > max || Array.from(value).length < min) return fail();
  return value;
}
function match(value: unknown, pattern: RegExp): string { const text = string(value); if (!pattern.test(text)) return fail(); return text; }
function integer(value: unknown, min = 0, max = 2147483646): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return fail();
  return value;
}
function enumeration<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) return fail(); return value as T;
}
function array(value: unknown, max = Infinity): unknown[] { if (!Array.isArray(value) || value.length > max) return fail(); return value; }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') return fail(); return value; }
const nullableId = (value: unknown) => value === null ? null : match(value, ID);
const nullableHash = (value: unknown) => value === null ? null : match(value, HASH);
function timestamp(value: unknown): string {
  const text = string(value); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(text) || !Number.isFinite(Date.parse(text))) return fail(); return text;
}
const profileLimits: Record<keyof RestaurantProfile, number> = { name: 150, description: 2000, cuisine_label: 100, country_code: 2, region: 100, city: 100, address_line1: 200, address_line2: 200, postal_code: 32, contact_email: 254, phone: 16, timezone: 64, currency_code: 3, primary_locale: 35 };
function profile(value: unknown, patch = false): RestaurantProfile {
  const keys = Object.keys(profileLimits) as Array<keyof RestaurantProfile>;
  const data = object(value, patch ? [] : keys, patch ? keys : []);
  if (patch && !Object.keys(data).length) return fail();
  for (const key of Object.keys(data) as Array<keyof RestaurantProfile>) {
    const v = data[key];
    if (v === null && key !== 'name' && key !== 'primary_locale') continue;
    const text = string(v, profileLimits[key], ['name', 'primary_locale', 'timezone', 'contact_email', 'phone'].includes(key) ? 1 : 0);
    if (key === 'primary_locale') enumeration(text, ['en', 'zh-CN']);
    if (key === 'country_code') match(text, /^[A-Z]{2}$/);
    if (key === 'currency_code') match(text, /^[A-Z]{3}$/);
    if (key === 'phone' && (text.length < 8 || !/^\+[1-9][0-9]{6,14}$/.test(text))) return fail();
    if (key === 'contact_email' && (text.length < 3 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text))) return fail();
  }
  return structuredClone(data) as unknown as RestaurantProfile;
}
function hours(value: unknown): WebsiteEditableContent['opening_hours'] {
  return array(value, 21).map(v => {
    const d = object(v, ['weekday', 'opens_at_local', 'closes_at_local', 'closes_day_offset', 'accepts_requests', 'sort_order']);
    return { weekday: integer(d.weekday, 1, 7), opens_at_local: match(d.opens_at_local, /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/), closes_at_local: match(d.closes_at_local, /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/), closes_day_offset: integer(d.closes_day_offset, 0, 1) as 0 | 1, accepts_requests: boolean(d.accepts_requests), sort_order: integer(d.sort_order, 0, 20) };
  });
}
function menu(value: unknown): MenuData {
  const data = object(value, ['categories', 'warnings']); let count = 0;
  const categories = array(data.categories, 20).map(v => {
    const category = object(v, ['name', 'items']); const items = array(category.items, 80);
    if (!items.length || (count += items.length) > 80) return fail();
    return { name: string(category.name, 150, 1), items: items.map(v => {
      const d = object(v, ['name', 'description', 'price_text', 'review_note']);
      return { name: string(d.name, 200, 1), description: d.description === null ? null : string(d.description, 1000, 1), price_text: d.price_text === null ? null : string(d.price_text, 80, 1), review_note: d.review_note === null ? null : string(d.review_note, 500, 1) };
    }) };
  });
  return { categories, warnings: array(data.warnings, 20).map(v => string(v, 500, 1)) };
}
export function readWebsiteContent(value: unknown): WebsiteEditableContent {
  const d = object(value, ['restaurant', 'restaurant_revision', 'opening_hours', 'menu']);
  const m = object(d.menu, ['revision', 'status', 'data']); const data = menu(m.data);
  const status = enumeration(m.status, ['empty', 'draft', 'confirmed']);
  if ((status === 'empty' && data.categories.length) || (status === 'confirmed' && !data.categories.length)) return fail();
  return { restaurant: profile(d.restaurant), restaurant_revision: integer(d.restaurant_revision), opening_hours: hours(d.opening_hours), menu: { revision: integer(m.revision), status, data } };
}
export function readContentVersion(value: unknown, rid: string): WebsiteContentVersion {
  const d = object(value, ['id', 'restaurant_id', 'version_number', 'summary', 'created_at', 'checksum', 'asset_ids', 'source_status', 'origin', 'base_version_id', 'public_content_hash']);
  if (d.restaurant_id !== rid) return fail();
  const assetIds = array(d.asset_ids, 8).map(v => match(v, /^ast_[A-Za-z0-9_-]{24}$/));
  if (new Set(assetIds).size !== assetIds.length) return fail();
  const result: WebsiteContentVersion = { id: match(d.id, ID), restaurant_id: rid, version_number: integer(d.version_number, 1, 2147483647), summary: string(d.summary), created_at: timestamp(d.created_at), checksum: match(d.checksum, HASH), asset_ids: assetIds, source_status: enumeration(d.source_status, ['available', 'missing', 'incompatible']), origin: enumeration(d.origin, ['generation', 'content_refresh', 'legacy']), base_version_id: nullableId(d.base_version_id), public_content_hash: nullableHash(d.public_content_hash) };
  if ((result.origin === 'legacy' && (result.base_version_id !== null || result.public_content_hash !== null || result.source_status === 'available')) || (result.origin !== 'legacy' && result.public_content_hash === null) || (result.origin === 'content_refresh' && result.base_version_id === null) || (result.origin === 'generation' && result.base_version_id !== null) || result.base_version_id === result.id) return fail();
  return result;
}
function differences(value: unknown): WebsiteContentDifference[] {
  return array(value).map(v => { const d = object(v, ['field', 'label', 'before', 'after']); return { field: enumeration(d.field, ['name', 'description', 'cuisine', 'address', 'contact', 'timezone', 'locale', 'currency', 'hours', 'menu', 'reservation']), label: string(d.label), before: string(d.before), after: string(d.after) }; });
}
const blockerCodes = ['WEBSITE_BASE_REQUIRED', 'WEBSITE_SOURCE_MISSING', 'WEBSITE_SOURCE_INCOMPATIBLE', 'MENU_UNCONFIRMED', 'RESTAURANT_UNAVAILABLE', 'WEBSITE_JOB_BUSY', 'MENU_JOB_BUSY'] as const;
export function readWorkbench(value: unknown, rid: string, baseId?: string): WebsiteWorkbenchReport {
  const d = object(value, ['restaurant_id', 'generated_at', 'publication', 'published_version', 'editing_version', 'latest_version', 'content', 'current_public_content_hash', 'differences', 'blockers', 'model_configured', 'ai_usage_mode'], ['saved_differences']);
  if (d.restaurant_id !== rid || d.ai_usage_mode !== 'observation') return fail();
  const p = object(d.publication, ['revision', 'published_version_id', 'slug', 'url', 'deployment_mode']);
  const slug = p.slug === null ? null : match(p.slug, websiteSlugPattern), url = p.url === null ? null : string(p.url);
  const publication = { revision: integer(p.revision), published_version_id: nullableId(p.published_version_id), slug, url, deployment_mode: enumeration(p.deployment_mode, ['local', 'unconfigured']) };
  if ((url !== null && (!safeLocalPublicationUrl(url, slug) || !publication.published_version_id || publication.deployment_mode !== 'local')) || (publication.published_version_id !== null && !slug)) return fail();
  const version = (v: unknown) => v === null ? null : readContentVersion(v, rid);
  const published = version(d.published_version), editing = version(d.editing_version), latest = version(d.latest_version);
  const blockers = array(d.blockers).map(v => enumeration(v, blockerCodes));
  if (new Set(blockers).size !== blockers.length || (published?.id ?? null) !== publication.published_version_id || (baseId && editing?.id !== baseId) || (!baseId && (editing?.id ?? null) !== (published?.id ?? latest?.id ?? null)) || ((editing || published) && !latest) || (latest && [editing, published].some(v => v && v.version_number > latest.version_number)) || (!editing && !blockers.includes('WEBSITE_BASE_REQUIRED')) || (editing?.source_status === 'missing' && !blockers.includes('WEBSITE_SOURCE_MISSING')) || (editing?.source_status === 'incompatible' && !blockers.includes('WEBSITE_SOURCE_INCOMPATIBLE'))) return fail();
  const versions = [published, editing, latest].filter((v): v is WebsiteContentVersion => !!v);
  for (const v of versions) if (versions.some(other => other.id === v.id && JSON.stringify(other) !== JSON.stringify(v))) return fail();
  return { restaurant_id: rid, generated_at: timestamp(d.generated_at), publication, published_version: published, editing_version: editing, latest_version: latest, content: readWebsiteContent(d.content), current_public_content_hash: match(d.current_public_content_hash, HASH), differences: differences(d.differences), ...(Object.hasOwn(d, 'saved_differences') ? { saved_differences: differences(d.saved_differences) } : {}), blockers, model_configured: boolean(d.model_configured), ai_usage_mode: 'observation' };
}
export function validateContentInput(value: unknown): WebsiteContentPreviewInput {
  try {
    const d = object(value, ['base_version_id', 'expected_restaurant_revision', 'expected_menu_revision', 'expected_public_content_hash', 'expected_publication_revision'], ['restaurant_patch', 'opening_hours', 'menu_data', 'menu_review_confirmed']);
    match(d.base_version_id, ID); match(d.expected_public_content_hash, HASH);
    for (const key of ['expected_restaurant_revision', 'expected_menu_revision', 'expected_publication_revision']) integer(d[key]);
    if (d.restaurant_patch !== undefined) profile(d.restaurant_patch, true);
    if (d.opening_hours !== undefined) hours(d.opening_hours);
    if (Object.hasOwn(d, 'menu_data') !== Object.hasOwn(d, 'menu_review_confirmed') || (Object.hasOwn(d, 'menu_data') && (d.menu_review_confirmed !== true || !menu(d.menu_data).categories.length))) return fail();
    const result = structuredClone(d) as unknown as WebsiteContentPreviewInput;
    if (new TextEncoder().encode(JSON.stringify(result)).length > 1024 * 1024) throw new ApiError(413, 'REQUEST_INVALID');
    return result;
  } catch (error) { if (error instanceof ApiError && error.status === 413) throw error; throw new ApiError(422, 'REQUEST_INVALID'); }
}
export function readContentResult(value: unknown, rid: string, input: WebsiteContentPreviewInput): WebsiteContentPreviewResult {
  const d = object(value, ['version', 'content', 'public_content_hash', 'base_publication_revision', 'differences', 'changed', 'ai_called', 'warnings']);
  const version = readContentVersion(d.version, rid), hash = match(d.public_content_hash, HASH), changed = boolean(d.changed);
  const content = readWebsiteContent(d.content);
  const warnings = array(d.warnings).map(v => enumeration(v, ['MENU_FILE_MAY_BE_OUTDATED']));
  if (d.ai_called !== false || version.source_status !== 'available' || version.public_content_hash !== hash || integer(d.base_publication_revision) !== input.expected_publication_revision || new Set(warnings).size !== warnings.length || (changed ? version.origin !== 'content_refresh' || version.base_version_id !== input.base_version_id || version.id === input.base_version_id : version.id !== input.base_version_id) || content.restaurant_revision < input.expected_restaurant_revision || content.menu.revision < input.expected_menu_revision) return fail();
  return { version, content, public_content_hash: hash, base_publication_revision: d.base_publication_revision as number, differences: differences(d.differences), changed, ai_called: false, warnings };
}
function path(rid: string): string { if (!ID.test(rid)) throw new ApiError(400, 'REQUEST_INVALID'); return `/restaurants/${rid}/website`; }
function versionPath(rid: string, vid: string): string { if (!ID.test(vid)) throw new ApiError(400, 'REQUEST_INVALID'); return `${path(rid)}/versions/${vid}`; }
async function contentRequest(url: string, options: Parameters<typeof merchantRequest>[1]) {
  try { return await merchantRequest<unknown>(url, options); }
  catch (error) {
    // 本店内容接口的 401 只表示会话失效；缺省认证头也不能保留旧私有稿与重试权限。
    if (error instanceof ApiError && error.status === 401) notifySessionExpired();
    throw error;
  }
}
export const websiteContentClient = {
  workbench: async (rid: string, baseId?: string, signal?: AbortSignal) => {
    const base = baseId === undefined ? '' : (versionPath(rid, baseId), `?base_version_id=${baseId}`);
    return readWorkbench((await contentRequest(`${path(rid)}/workbench${base}`, { method: 'GET', session: true, signal })).data, rid, baseId);
  },
  version: async (rid: string, vid: string, signal?: AbortSignal) => {
    const result = readContentVersion((await contentRequest(versionPath(rid, vid), { method: 'GET', session: true, signal })).data, rid);
    if (result.id !== vid) return fail(); return result;
  },
  versions: async (rid: string, cursor?: string, signal?: AbortSignal): Promise<WebsiteContentVersionPage> => {
    if (cursor !== undefined && (cursor.length > 1024 || !CURSOR.test(cursor))) throw new ApiError(400, 'REQUEST_INVALID');
    const query = new URLSearchParams({ limit: '20', ...(cursor ? { cursor } : {}) });
    const d = object((await contentRequest(`${path(rid)}/versions?${query}`, { method: 'GET', session: true, signal })).data, ['items', 'has_more', 'next_cursor']);
    const items = array(d.items, 20).map(v => readContentVersion(v, rid)), more = boolean(d.has_more);
    const next = d.next_cursor === null ? null : match(d.next_cursor, CURSOR);
    if ((next !== null && (next.length > 1024 || next === cursor)) || more !== (next !== null) || (more && !items.length) || new Set(items.map(v => v.id)).size !== items.length || items.some((v, i) => i > 0 && v.version_number >= items[i - 1].version_number)) return fail();
    return { items, has_more: more, next_cursor: next };
  },
  savePreview: async (rid: string, input: WebsiteContentPreviewInput, key: string, signal?: AbortSignal) => {
    const body = validateContentInput(input);
    if (!/^[A-Za-z0-9_.:-]{16,128}$/.test(key)) throw new ApiError(400, 'REQUEST_INVALID');
    return readContentResult((await contentRequest(`${path(rid)}/content-previews`, { method: 'POST', body, csrf: true, session: true, signal, headers: { 'Idempotency-Key': key } })).data, rid, body);
  },
};
