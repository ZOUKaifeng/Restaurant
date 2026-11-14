import { createHash, createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from './config.js';
import { audit, id, transaction, type Database } from './db.js';
import { ApiError, invalid } from './errors.js';
import { equal, lockAuthenticated, requireSession, requireWrite } from './security.js';
import { contract, input, validateParameter, validateIntervals, validTimezone, type Interval, type Input } from './validation.js';

const fields = Object.keys(contract.components.schemas.RestaurantCreateInput.properties) as string[];
const select = `SELECT r.*,r.created_at::text AS cursor_created_at,m.role,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('weekday',h.weekday,'opens_at_local',to_char(h.opens_at_local,'HH24:MI'),
    'closes_at_local',to_char(h.closes_at_local,'HH24:MI'),'closes_day_offset',h.closes_day_offset,
    'accepts_requests',h.accepts_requests,'sort_order',h.sort_order) ORDER BY h.weekday,h.sort_order,h.opens_at_local,h.id)
    FROM opening_hours h WHERE h.restaurant_id=r.id),'[]'::jsonb) AS intervals
  FROM restaurants r JOIN restaurant_members m ON m.restaurant_id=r.id AND m.user_id=$1 AND m.status='active' AND m.role='owner'`;
type Row = Record<string, any>;
function view(row: Row) {
  const result: Row = {};
  for (const field of [...fields, 'id', 'slug', 'status', 'reservation_enabled', 'revision', 'role', 'created_at', 'updated_at']) result[field] = row[field];
  const missing = ['country_code', 'city', 'address_line1', 'contact_email', 'timezone', 'currency_code'].filter(field => !row[field]);
  if (!row.intervals.length) missing.push('opening_hours');
  if (!row.privacy_notice_version) missing.push('privacy_notice');
  // 这里只派生资料完整性，不实施发布、批准或预订门禁。
  result.readiness = { ready_for_publication: missing.length === 0, missing_fields: missing };
  return result;
}
function hours(row: Row) { return { restaurant_id: row.id, restaurant_revision: row.revision, timezone: row.timezone, intervals: row.intervals }; }
function etag(row: Row): string { return `"restaurant-${row.id}-v${row.revision}"`; }
function restaurantId(request: FastifyRequest): string {
  const value = (request.params as { restaurantId: string }).restaurantId;
  validateParameter('RestaurantId', value);
  return value;
}
async function owned(db: Database, userId: string, rid: string, lock = false): Promise<Row> {
  if (lock) {
    const locked = await db.query(`SELECT r.id FROM restaurants r
      JOIN restaurant_members m ON m.restaurant_id=r.id AND m.user_id=$1 AND m.status='active' AND m.role='owner'
      WHERE r.id=$2 FOR UPDATE OF r,m`, [userId, rid]);
    if (!locked.rows[0]) throw new ApiError(404);
  }
  // READ COMMITTED 下下一条语句取得锁等待后主行及营业段的一致新快照。
  const result = await db.query(`${select} WHERE r.id=$2`, [userId, rid]);
  if (!result.rows[0]) throw new ApiError(404);
  return result.rows[0];
}
function match(request: FastifyRequest, row: Row): void {
  const value = request.headers['if-match'];
  if (value === undefined) throw new ApiError(428);
  validateParameter('IfMatch', value);
  if (value !== etag(row)) throw new ApiError(412);
  if (row.status !== 'draft') throw new ApiError(409);
}
function fingerprint(body: Input): string {
  const normalized = fields.map(field => [field, body[field] ?? null]);
  return `sha256:v1:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`;
}
function signCursor(config: Config, payload: Row): string {
  const text = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${text}.${createHmac('sha256', config.cursorSecret).update(text).digest('base64url')}`;
}
function readCursor(config: Config, token: string, userId: string, limit: number): Row {
  try {
    const [text, signature, extra] = token.split('.');
    if (!text || !signature || extra || !equal(createHmac('sha256', config.cursorSecret).update(text).digest('base64url'), signature)) throw new Error();
    const payload = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    if (payload.v !== 1 || payload.u !== userId || payload.l !== limit || typeof payload.t !== 'string' || !Number.isFinite(Date.parse(payload.t)) || typeof payload.i !== 'string') throw new Error();
    return payload;
  } catch { throw new ApiError(400); }
}
export function registerRestaurants(app: FastifyInstance, pool: Pool, config: Config): void {
  app.get('/api/v1/restaurants', async request => {
    const session = await requireSession(pool, config, request);
    const query = request.query as Record<string, unknown>;
    if (Object.keys(query).some(key => !['limit', 'cursor'].includes(key))) throw new ApiError(400);
    if (query.limit !== undefined && (typeof query.limit !== 'string' || !/^\d+$/.test(query.limit))) throw new ApiError(422);
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    validateParameter('Limit', limit, 422);
    let cursor: Row | undefined;
    if (query.cursor !== undefined) { validateParameter('Cursor', query.cursor); cursor = readCursor(config, query.cursor as string, session.user.id, limit); }
    const result = await pool.query(`${select} ${cursor ? 'WHERE (r.created_at,r.id)<($2::timestamptz,$3::text)' : ''}
      ORDER BY r.created_at DESC,r.id DESC LIMIT $${cursor ? 4 : 2}`, cursor ? [session.user.id, cursor.t, cursor.i, limit + 1] : [session.user.id, limit + 1]);
    const more = result.rows.length > limit, items = result.rows.slice(0, limit), last = items.at(-1);
    return { items: items.map(view), has_more: more, next_cursor: more && last ? signCursor(config, { v: 1, u: session.user.id, l: limit, t: last.cursor_created_at, i: last.id }) : null };
  });
  app.post('/api/v1/restaurants', async (request, reply) => {
    const session = (await requireWrite(pool, config, request))!;
    const body = input('RestaurantCreateInput', request.body);
    const key = request.headers['idempotency-key'];
    validateParameter('IdempotencyKey', key);
    const initialDigest = fingerprint(body);
    const result = await transaction(pool, async db => {
      await lockAuthenticated(db, config, session);
      const rid = id('rst');
      const columns = fields.filter(field => Object.hasOwn(body, field));
      const values = columns.map(field => body[field]);
      const inserted = await db.query(`INSERT INTO restaurants(id,created_by_user_id,create_idempotency_key,create_request_fingerprint,slug,${columns.join(',')})
        VALUES($1,$2,$3,$4,$5,${columns.map((_, i) => `$${i + 6}`).join(',')}) ON CONFLICT(created_by_user_id,create_idempotency_key) DO NOTHING RETURNING id`, [rid, session.user.id, key, initialDigest, `restaurant-${rid.slice(4)}`, ...values]);
      if (inserted.rowCount) {
        await db.query(`INSERT INTO restaurant_members(id,restaurant_id,user_id,role) VALUES($1,$2,$3,'owner')`, [id('mem'), rid, session.user.id]);
        await audit(db, session.user.id, 'create_restaurant', rid, request.id, columns, rid);
        return { row: await owned(db, session.user.id, rid), replay: false };
      }
      const existing = await db.query(`SELECT id,create_request_fingerprint FROM restaurants WHERE created_by_user_id=$1 AND create_idempotency_key=$2`, [session.user.id, key]);
      const row = await owned(db, session.user.id, existing.rows[0].id);
      if (existing.rows[0].create_request_fingerprint !== initialDigest) throw new ApiError(409);
      return { row, replay: true };
    });
    return reply.code(201).header('ETag', etag(result.row)).header('Location', `/api/v1/restaurants/${result.row.id}`).header('Idempotency-Replayed', String(result.replay)).send(view(result.row));
  });
  app.get('/api/v1/restaurants/:restaurantId', async (request, reply) => {
    const session = await requireSession(pool, config, request);
    const row = await owned(pool, session.user.id, restaurantId(request));
    return reply.header('ETag', etag(row)).send(view(row));
  });
  app.patch('/api/v1/restaurants/:restaurantId', async (request, reply) => {
    const session = (await requireWrite(pool, config, request))!;
    const rid = restaurantId(request);
    const row = await transaction(pool, async db => {
      await lockAuthenticated(db, config, session);
      const current = await owned(db, session.user.id, rid, true);
      match(request, current);
      const body = input('RestaurantPatchInput', request.body);
      if (body.timezone === null && current.intervals.length) invalid('timezone', 'OPENING_HOURS_REQUIRE_TIMEZONE');
      const columns = fields.filter(field => Object.hasOwn(body, field));
      await db.query(`UPDATE restaurants SET ${columns.map((field, i) => `${field}=$${i + 2}`).join(',')},revision=revision+1,updated_at=now() WHERE id=$1`, [rid, ...columns.map(field => body[field])]);
      await audit(db, session.user.id, 'update_restaurant', rid, request.id, columns, rid);
      return owned(db, session.user.id, rid);
    });
    return reply.header('ETag', etag(row)).send(view(row));
  });
  app.get('/api/v1/restaurants/:restaurantId/opening-hours', async (request, reply) => {
    const session = await requireSession(pool, config, request);
    const row = await owned(pool, session.user.id, restaurantId(request));
    return reply.header('ETag', etag(row)).send(hours(row));
  });
  app.put('/api/v1/restaurants/:restaurantId/opening-hours', async (request, reply) => {
    const session = (await requireWrite(pool, config, request))!;
    const rid = restaurantId(request);
    const row = await transaction(pool, async db => {
      await lockAuthenticated(db, config, session);
      const current = await owned(db, session.user.id, rid, true);
      match(request, current);
      if (!validTimezone(current.timezone)) invalid('timezone', 'TIMEZONE_REQUIRED');
      const body = input('OpeningHoursInput', request.body);
      const intervals = body.intervals as Interval[];
      validateIntervals(intervals);
      await db.query('DELETE FROM opening_hours WHERE restaurant_id=$1', [rid]);
      for (const interval of intervals) await db.query(`INSERT INTO opening_hours(id,restaurant_id,weekday,opens_at_local,closes_at_local,closes_day_offset,accepts_requests,sort_order)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id('hours'), rid, interval.weekday, interval.opens_at_local, interval.closes_at_local, interval.closes_day_offset, interval.accepts_requests, interval.sort_order]);
      await db.query('UPDATE restaurants SET revision=revision+1,updated_at=now() WHERE id=$1', [rid]);
      await audit(db, session.user.id, 'replace_opening_hours', rid, request.id, ['opening_hours'], rid);
      return owned(db, session.user.id, rid);
    });
    return reply.header('ETag', etag(row)).send(hours(row));
  });
}
