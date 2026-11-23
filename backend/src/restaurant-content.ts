import type { Database } from './db.js';
import { audit, id } from './db.js';
import { ApiError, invalid } from './errors.js';
import { requireMenuIdle } from './menu-access.js';
import { contract, input, validateIntervals, validTimezone } from './validation.js';
import type { WebsiteRestaurant } from './website-access.js';
import type { WebsiteEditableContent } from './website-content-types.js';

export const restaurantContentFields = Object.keys(contract.components.schemas.RestaurantCreateInput.properties) as string[];
export type RestaurantContentRow = WebsiteRestaurant & { intervals: WebsiteEditableContent['opening_hours'] };
export async function readRestaurantContent(db: Database, rid: string): Promise<RestaurantContentRow> {
  const row = (await db.query<WebsiteRestaurant>('SELECT * FROM restaurants WHERE id=$1', [rid])).rows[0];
  if (!row) throw new ApiError(404);
  const intervals = (await db.query<WebsiteEditableContent['opening_hours'][number]>(`SELECT weekday,
    to_char(opens_at_local,'HH24:MI') AS opens_at_local,to_char(closes_at_local,'HH24:MI') AS closes_at_local,
    closes_day_offset,accepts_requests,sort_order FROM opening_hours WHERE restaurant_id=$1
    ORDER BY weekday,sort_order,opens_at_local,id`, [rid])).rows;
  return { ...row, intervals };
}
export function editableRestaurant(row: WebsiteRestaurant): Record<string, unknown> {
  return Object.fromEntries(restaurantContentFields.map(field => [field, (row as unknown as Record<string, unknown>)[field]]));
}
export function normalizeOpeningHours(value: unknown): WebsiteEditableContent['opening_hours'] {
  const intervals = input('OpeningHoursInput', { intervals: value }).intervals as WebsiteEditableContent['opening_hours'];
  validateIntervals(intervals);
  return intervals.map(h => ({ weekday: h.weekday, opens_at_local: h.opens_at_local, closes_at_local: h.closes_at_local,
    closes_day_offset: h.closes_day_offset, accepts_requests: h.accepts_requests, sort_order: h.sort_order }))
    .sort((a, b) => a.weekday - b.weekday || a.sort_order - b.sort_order || a.opens_at_local.localeCompare(b.opens_at_local));
}
export async function requireContentIdle(db: Database, rid: string): Promise<void> {
  await requireMenuIdle(db, rid);
  if ((await db.query("SELECT id FROM website_jobs WHERE restaurant_id=$1 AND status IN ('queued','running') LIMIT 1", [rid])).rowCount) {
    throw new ApiError(409, 'WEBSITE_JOB_BUSY');
  }
}
// 调用者先持有 user → restaurant → member 锁；合并资料与时段后只递增一次共享修订。
export async function applyRestaurantContent(db: Database, rid: string, current: RestaurantContentRow,
  changes: { patch?: Record<string, unknown>; intervals?: WebsiteEditableContent['opening_hours'] },
  requestId: string, actorId: string): Promise<RestaurantContentRow> {
  if (current.id !== rid) throw new ApiError(404);
  if (!['draft', 'active'].includes(current.status)) throw new ApiError(409, 'RESTAURANT_UNAVAILABLE');
  const patch = changes.patch === undefined ? {} : input('RestaurantPatchInput', changes.patch);
  const intervals = changes.intervals === undefined ? current.intervals : normalizeOpeningHours(changes.intervals);
  const timezone = Object.hasOwn(patch, 'timezone') ? patch.timezone : current.timezone;
  if (intervals.length && !validTimezone(timezone)) invalid('timezone', 'OPENING_HOURS_REQUIRE_TIMEZONE');
  const columns = restaurantContentFields.filter(field => Object.hasOwn(patch, field) && patch[field] !==
    (current as unknown as Record<string, unknown>)[field]);
  const hoursChanged = changes.intervals !== undefined && JSON.stringify(intervals) !== JSON.stringify(current.intervals);
  if (!columns.length && !hoursChanged) return current;
  if (!Number.isSafeInteger(current.revision) || current.revision >= 2147483646) throw new ApiError(412, 'RESTAURANT_REVISION_CONFLICT');
  await requireContentIdle(db, rid);
  await db.query(`UPDATE restaurants SET ${columns.map((field, i) => `${field}=$${i + 2},`).join('')}
    revision=revision+1,updated_at=now() WHERE id=$1`, [rid, ...columns.map(field => patch[field])]);
  if (hoursChanged) {
    await db.query('DELETE FROM opening_hours WHERE restaurant_id=$1', [rid]);
    for (const h of intervals) await db.query(`INSERT INTO opening_hours(id,restaurant_id,weekday,opens_at_local,
      closes_at_local,closes_day_offset,accepts_requests,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id('hours'), rid, h.weekday, h.opens_at_local, h.closes_at_local, h.closes_day_offset, h.accepts_requests, h.sort_order]);
  }
  if (columns.length) await audit(db, actorId, 'update_restaurant', rid, requestId, columns, rid);
  if (hoursChanged) await audit(db, actorId, 'replace_opening_hours', rid, requestId, ['opening_hours'], rid);
  return readRestaurantContent(db, rid);
}
