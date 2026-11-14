import { createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { Config } from './config.js';
import { id, transaction } from './db.js';
import { ApiError, invalid } from './errors.js';
import { equal, lockAuthenticated, normalizeEmail, requireSession, requireWrite, type Session } from './security.js';
import {
  cancelFingerprint, createReservation, decisionFingerprint, insertEvent, lockOwnedRestaurant, merchantView,
  publicView, readPublicSite, readReservation, readReservationByToken, readSettings, requireReservationConfigured,
  requireSettingsRevision, reservationAudit, reservationColumns, restaurantName, queueReservationMail,
  type CreateReservationInput, type PublicSite, type ReservationRecord,
} from './reservation-access.js';

const base = '/api/v1/restaurants/:restaurantId/reservations';
const publicBase = '/api/v1/public';
const slugPattern = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
type Cursor = { v: 1; u: string; r: string; l: number; t: string; i: string };

function privateHeaders(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
}
function restaurantId(request: FastifyRequest): string {
  const rid = (request.params as { restaurantId: string }).restaurantId;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(rid)) throw new ApiError(400);
  return rid;
}
function body(request: FastifyRequest, required: string[], optional: string[] = []): Record<string, unknown> {
  const value = request.body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('body');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !required.includes(key) && !optional.includes(key)) ||
    required.some(key => !Object.hasOwn(result, key))) invalid('body', 'UNKNOWN_OR_MISSING_FIELDS');
  return result;
}
function revision(value: unknown, field = 'expected_revision'): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2147483646) invalid(field);
  return value as number;
}
function idem(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{16,128}$/.test(key)) throw new ApiError(400);
  return key;
}
function text(value: unknown, field: string, max: number, required = true): string | null {
  if (value === undefined || value === null) {
    if (required) invalid(field);
    return null;
  }
  if (typeof value !== 'string') invalid(field);
  const trimmed = value.trim();
  if (!trimmed) { if (required) invalid(field); return null; }
  if (Array.from(trimmed).length > max) invalid(field, 'TOO_LONG');
  return trimmed;
}
function requirePublicOrigin(request: FastifyRequest, config: Config): void {
  const origin = request.headers.origin;
  if (origin === undefined) return;
  if (origin === config.website?.publicOrigin ||
    (config.nodeEnv !== 'production' && origin === config.appOrigin)) return;
  throw new ApiError(403);
}
function slugOf(request: FastifyRequest): string {
  const slug = (request.params as { slug: string }).slug;
  if (!slugPattern.test(slug) || Object.keys(request.query as object).length) throw new ApiError(404);
  return slug;
}
function tokenOf(request: FastifyRequest): string {
  const token = (request.params as { token: string }).token;
  if (!tokenPattern.test(token)) throw new ApiError(404);
  return token;
}
function signCursor(config: Config, cursor: Cursor): string {
  const value = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return `${value}.${createHmac('sha256', config.cursorSecret).update(`reservations\0${value}`).digest('base64url')}`;
}
function readCursor(config: Config, value: unknown, session: Session, rid: string, limit: number): Cursor {
  try {
    if (typeof value !== 'string' || value.length > 1024) throw new Error();
    const [textValue, signature] = value.split('.');
    if (!textValue || !signature || !equal(createHmac('sha256', config.cursorSecret).update(`reservations\0${textValue}`).digest('base64url'), signature)) throw new Error();
    const cursor = JSON.parse(Buffer.from(textValue, 'base64url').toString('utf8')) as Cursor;
    if (cursor.v !== 1 || cursor.u !== session.user.id || cursor.r !== rid || cursor.l !== limit ||
      typeof cursor.t !== 'string' || !Number.isFinite(Date.parse(cursor.t)) ||
      typeof cursor.i !== 'string' || !/^rsv_[A-Za-z0-9_-]{24}$/.test(cursor.i)) throw new Error();
    return cursor;
  } catch { invalid('cursor'); }
}
async function locked<T>(pool: Pool, config: Config, session: Session, rid: string,
  run: (db: PoolClient) => Promise<T>): Promise<T> {
  return transaction(pool, async db => {
    await lockAuthenticated(db, config, session);
    await lockOwnedRestaurant(db, session.user.id, rid);
    return run(db);
  });
}
function parseCreate(value: Record<string, unknown>): CreateReservationInput {
  const guestName = text(value.guest_name, 'guest_name', 100)!;
  const email = text(value.guest_email, 'guest_email', 254, false);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid('guest_email');
  const phone = text(value.guest_phone, 'guest_phone', 32, false);
  if (phone && !/^[+0-9() .-]{6,32}$/.test(phone)) invalid('guest_phone');
  if (!email && !phone) invalid('guest_email', 'CONTACT_REQUIRED');
  const party = value.party_size;
  if (!Number.isSafeInteger(party) || (party as number) < 1 || (party as number) > 20) invalid('party_size');
  const localDate = text(value.local_date, 'local_date', 10)!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) ||
    new Date(`${localDate}T00:00:00Z`).toISOString().slice(0, 10) !== localDate) invalid('local_date');
  const localTime = text(value.local_time, 'local_time', 5)!;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) invalid('local_time');
  const notice = text(value.privacy_notice_version, 'privacy_notice_version', 64)!;
  if (value.privacy_consent !== true) invalid('privacy_consent', 'CONSENT_REQUIRED');
  let offset: number | null = null;
  if (Object.hasOwn(value, 'utc_offset_minutes') && value.utc_offset_minutes !== null) {
    if (!Number.isInteger(value.utc_offset_minutes) || (value.utc_offset_minutes as number) < -720 ||
      (value.utc_offset_minutes as number) > 840) invalid('utc_offset_minutes');
    offset = value.utc_offset_minutes as number;
  }
  return { guest_name: guestName, guest_email: email ? normalizeEmail(email) : null, guest_phone: phone,
    party_size: party as number, local_date: localDate, local_time: localTime,
    note: text(value.note, 'note', 1000, false), privacy_notice_version: notice,
    privacy_consent: true, utc_offset_minutes: offset };
}
function reservationReply(row: ReservationRecord, site: Pick<PublicSite, 'restaurant_name' | 'timezone'>) {
  return publicView(row, site.restaurant_name, site.timezone ?? row.timezone_snapshot);
}

export function registerReservations(app: FastifyInstance, pool: Pool, config: Config): void {
  // 公开提交：游客无需登录；由公开站点同源调用，不开放跨站任意Origin。
  app.post(`${publicBase}/restaurants/:slug/reservations`,
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
      privateHeaders(reply);
      requirePublicOrigin(request, config);
      const slug = slugOf(request);
      const value = body(request, ['guest_name', 'party_size', 'local_date', 'local_time', 'privacy_notice_version', 'privacy_consent'],
        ['guest_email', 'guest_phone', 'note', 'utc_offset_minutes']);
      const input = parseCreate(value);
      const key = idem(request);
      const site = await readPublicSite(pool, slug);
      if (!site) throw new ApiError(404);
      requireReservationConfigured(site);
      if (input.privacy_notice_version !== site.privacy_notice_version) throw new ApiError(422, 'PRIVACY_NOTICE_STALE');
      const result = await createReservation(pool, config, site, input, key, request.id);
      return reply.code(result.replay ? 200 : 201).header('Idempotency-Replayed', String(result.replay)).send({
        reservation: reservationReply(result.reservation, site),
        ...(result.token ? { manage_token: result.token, manage_token_expires_in_days: 120 } : {}),
      });
    });

  app.get(`${publicBase}/reservations/:token`,
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
      privateHeaders(reply);
      requirePublicOrigin(request, config);
      const row = await readReservationByToken(pool, config, tokenOf(request));
      const restaurant = await restaurantName(pool, row.restaurant_id);
      return { reservation: publicView(row, restaurant.name, restaurant.timezone ?? row.timezone_snapshot) };
    });

  // 不接受GET取消，避免邮件扫描器或预取直接改变状态。
  app.post(`${publicBase}/reservations/:token/cancel`,
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
      privateHeaders(reply);
      requirePublicOrigin(request, config);
      const token = tokenOf(request);
      const value = body(request, ['expected_revision'], ['reason']);
      const expected = revision(value.expected_revision as number);
      const reason = text(value.reason, 'reason', 500, false);
      const updated = await transaction(pool, async db => {
        const row = await readReservationByToken(db, config, token, true);
        if (row.status === 'cancelled') return row;
        if (row.status !== 'pending' && row.status !== 'confirmed') throw new ApiError(409, 'RESERVATION_FINAL');
        if (row.revision !== expected) throw new ApiError(409, 'RESERVATION_REVISION_CONFLICT');
        const next = (await db.query<ReservationRecord>(`UPDATE reservations SET status='cancelled',
          cancelled_at=clock_timestamp(),cancelled_by_type='guest',revision=revision+1,updated_at=clock_timestamp()
          WHERE restaurant_id=$1 AND id=$2 AND revision=$3 RETURNING ${reservationColumns.replaceAll('r.', '')}`,
        [row.restaurant_id, row.id, expected])).rows[0];
        if (!next) throw new ApiError(409, 'RESERVATION_REVISION_CONFLICT');
        await insertEvent(db, { restaurantId: row.restaurant_id, reservationId: row.id, eventType: 'cancelled',
          actorType: 'guest', actorUserId: null, fromStatus: row.status, toStatus: 'cancelled', revision: next.revision,
          requestId: request.id, fingerprint: cancelFingerprint(expected, reason), changes: reason ? { reason } : {} });
        const restaurant = await restaurantName(db, row.restaurant_id);
        await queueReservationMail(db, config, next, 'reservation_cancelled', null, restaurant.name);
        return next;
      });
      const restaurant = await restaurantName(pool, updated.restaurant_id);
      return { reservation: publicView(updated, restaurant.name, restaurant.timezone ?? updated.timezone_snapshot) };
    });

  app.get(`${base}/settings`, async (request, reply) => {
    privateHeaders(reply);
    const session = await requireSession(pool, config, request), rid = restaurantId(request);
    if (Object.keys(request.query as object).length) throw new ApiError(400);
    return locked(pool, config, session, rid, db => readSettings(db, rid));
  });

  app.patch(`${base}/settings`, async (request, reply) => {
    privateHeaders(reply);
    const session = (await requireWrite(pool, config, request))!, rid = restaurantId(request);
    const value = body(request, ['enabled'], ['notice', 'privacy_notice_version', 'expected_revision']);
    if (typeof value.enabled !== 'boolean') invalid('enabled');
    const expected = revision(value.expected_revision as number);
    const notice = text(value.notice, 'notice', 2000, false);
    return locked(pool, config, session, rid, async db => {
      const settings = await lockOwnedRestaurant(db, session.user.id, rid);
      requireSettingsRevision(settings, expected);
      const privacy = Object.hasOwn(value, 'privacy_notice_version')
        ? text(value.privacy_notice_version, 'privacy_notice_version', 64) : settings.privacy_notice_version;
      if (value.enabled) {
        if (!settings.timezone) throw new ApiError(422, 'TIMEZONE_REQUIRED');
        if (!privacy) throw new ApiError(422, 'PRIVACY_NOTICE_REQUIRED');
        if (!settings.intervals.some(interval => interval.accepts_requests)) throw new ApiError(422, 'NO_ACCEPTING_HOURS');
      }
      const updated = await db.query(`UPDATE restaurants SET reservation_enabled=$1,reservation_notice=$2,
        privacy_notice_version=$3,revision=revision+1,updated_at=now() WHERE id=$4 AND revision=$5`,
      [value.enabled, notice, privacy, rid, expected]);
      if (updated.rowCount !== 1) throw new ApiError(412, 'REVISION_CONFLICT');
      await db.query(`INSERT INTO audit_logs(id,restaurant_id,actor_type,actor_user_id,action,entity_type,entity_id,
        request_id,outcome,changed_fields) VALUES($1,$2,'merchant',$3,'reservation_settings_updated','restaurant',$2,$4,'success',
        ARRAY['reservation_enabled','reservation_notice','privacy_notice_version'])`, [id('aud'), rid, session.user.id, request.id]);
      return readSettings(db, rid);
    });
  });

  app.get(base, async (request, reply) => {
    privateHeaders(reply);
    const session = await requireSession(pool, config, request), rid = restaurantId(request);
    const query = request.query as Record<string, unknown>;
    if (Object.keys(query).some(key => !['status', 'from', 'to', 'limit', 'cursor'].includes(key))) throw new ApiError(400);
    const status = query.status;
    if (status !== undefined && (typeof status !== 'string' ||
      !['pending', 'confirmed', 'declined', 'cancelled'].includes(status))) invalid('status');
    for (const field of ['from', 'to'] as const) {
      const value = query[field];
      if (value !== undefined && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))) invalid(field);
    }
    if (query.limit !== undefined && (typeof query.limit !== 'string' || !/^\d{1,3}$/.test(query.limit))) invalid('limit');
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    if (limit < 1 || limit > 100) invalid('limit');
    const cursor = query.cursor === undefined ? undefined : readCursor(config, query.cursor, session, rid, limit);
    return locked(pool, config, session, rid, async db => {
      const rows = (await db.query<ReservationRecord>(`SELECT ${reservationColumns} FROM reservations r
        WHERE r.restaurant_id=$1
          AND ($2::text IS NULL OR r.status=$2)
          AND ($3::date IS NULL OR r.requested_local_date>=$3::date)
          AND ($4::date IS NULL OR r.requested_local_date<=$4::date)
          ${cursor ? 'AND (r.created_at,r.id)<($6::timestamptz,$7::text)' : ''}
        ORDER BY r.created_at DESC,r.id DESC LIMIT $5`,
      cursor ? [rid, status ?? null, query.from ?? null, query.to ?? null, limit + 1, cursor.t, cursor.i]
        : [rid, status ?? null, query.from ?? null, query.to ?? null, limit + 1])).rows;
      const items = rows.slice(0, limit), last = items.at(-1);
      const restaurant = await restaurantName(db, rid);
      return {
        items: items.map(row => merchantView(row, restaurant.name, restaurant.timezone ?? row.timezone_snapshot)),
        next_cursor: rows.length > limit && last ? signCursor(config, { v: 1, u: session.user.id, r: rid, l: limit,
          t: last.created_at.toISOString(), i: last.id }) : null,
      };
    });
  });

  app.get(`${base}/:reservationId`, async (request, reply) => {
    privateHeaders(reply);
    const session = await requireSession(pool, config, request), rid = restaurantId(request);
    const reservationId = (request.params as { reservationId: string }).reservationId;
    if (!/^rsv_[A-Za-z0-9_-]{24}$/.test(reservationId) || Object.keys(request.query as object).length) throw new ApiError(404);
    return locked(pool, config, session, rid, async db => {
      const row = await readReservation(db, rid, reservationId);
      const restaurant = await restaurantName(db, rid);
      const events = (await db.query<{ event_type: string; actor_type: string; from_status: string | null;
        to_status: string; reservation_revision: number; created_at: Date }>(`SELECT event_type,actor_type,from_status,
        to_status,reservation_revision,created_at FROM reservation_events WHERE restaurant_id=$1 AND reservation_id=$2
        ORDER BY reservation_revision DESC,id DESC LIMIT 50`, [rid, reservationId])).rows;
      return { reservation: merchantView(row, restaurant.name, restaurant.timezone ?? row.timezone_snapshot),
        events: events.map(event => ({ ...event, created_at: event.created_at.toISOString() })) };
    });
  });

  app.post(`${base}/:reservationId/decision`, async (request, reply) => {
    privateHeaders(reply);
    const session = (await requireWrite(pool, config, request))!, rid = restaurantId(request);
    const reservationId = (request.params as { reservationId: string }).reservationId;
    if (!/^rsv_[A-Za-z0-9_-]{24}$/.test(reservationId)) throw new ApiError(404);
    const value = body(request, ['decision', 'expected_revision'], ['reason']);
    if (value.decision !== 'confirm' && value.decision !== 'decline') invalid('decision');
    const decision = value.decision as 'confirm' | 'decline';
    const expected = revision(value.expected_revision as number);
    const reason = text(value.reason, 'reason', 500, decision === 'decline');
    const key = idem(request), fingerprint = decisionFingerprint(decision, expected, reason);
    return locked(pool, config, session, rid, async db => {
      const row = await readReservation(db, rid, reservationId, true);
      const previous = (await db.query<{ action_fingerprint: string }>(`SELECT action_fingerprint FROM reservation_events
        WHERE reservation_id=$1 AND request_id=$2`, [reservationId, key])).rows[0];
      if (previous) {
        if (previous.action_fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT');
        const restaurant = await restaurantName(db, rid);
        return merchantView(row, restaurant.name, restaurant.timezone ?? row.timezone_snapshot);
      }
      if (row.status !== 'pending') throw new ApiError(409, 'RESERVATION_FINAL');
      if (row.revision !== expected) throw new ApiError(409, 'RESERVATION_REVISION_CONFLICT');
      const status = decision === 'confirm' ? 'confirmed' : 'declined';
      const next = (await db.query<ReservationRecord>(`UPDATE reservations SET status=$1,decided_at=clock_timestamp(),
        decided_by_user_id=$2,decision_reason=$3,revision=revision+1,updated_at=clock_timestamp()
        WHERE restaurant_id=$4 AND id=$5 AND revision=$6 RETURNING ${reservationColumns.replaceAll('r.', '')}`,
      [status, session.user.id, reason, rid, reservationId, expected])).rows[0];
      if (!next) throw new ApiError(409, 'RESERVATION_REVISION_CONFLICT');
      await insertEvent(db, { restaurantId: rid, reservationId, eventType: status, actorType: 'merchant',
        actorUserId: session.user.id, fromStatus: 'pending', toStatus: status, revision: next.revision,
        requestId: key, fingerprint, changes: reason ? { reason } : {} });
      const restaurant = await restaurantName(db, rid);
      // 不轮换顾客已有管理链接：SMTP未配置时换令牌会让顾客失去查看入口。
      await queueReservationMail(db, config, next, decision === 'confirm' ? 'reservation_confirmed' : 'reservation_declined',
        null, restaurant.name);
      await reservationAudit(db, session.user.id, rid, 'reservation_decided', reservationId, request.id);
      return merchantView(next, restaurant.name, restaurant.timezone ?? next.timezone_snapshot);
    });
  });

  app.post(`${base}/:reservationId/cancel`, async (request, reply) => {
    privateHeaders(reply);
    const session = (await requireWrite(pool, config, request))!, rid = restaurantId(request);
    const reservationId = (request.params as { reservationId: string }).reservationId;
    if (!/^rsv_[A-Za-z0-9_-]{24}$/.test(reservationId)) throw new ApiError(404);
    const value = body(request, ['expected_revision'], ['reason']);
    const expected = revision(value.expected_revision as number);
    const reason = text(value.reason, 'reason', 500, false);
    const key = idem(request), fingerprint = cancelFingerprint(expected, reason);
    return locked(pool, config, session, rid, async db => {
      const row = await readReservation(db, rid, reservationId, true);
      const previous = (await db.query<{ action_fingerprint: string }>(`SELECT action_fingerprint FROM reservation_events
        WHERE reservation_id=$1 AND request_id=$2`, [reservationId, key])).rows[0];
      if (previous) {
        if (previous.action_fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT');
        const restaurant = await restaurantName(db, rid);
        return merchantView(row, restaurant.name, restaurant.timezone ?? row.timezone_snapshot);
      }
      if (row.status !== 'pending' && row.status !== 'confirmed') throw new ApiError(409, 'RESERVATION_FINAL');
      if (row.revision !== expected) throw new ApiError(409, 'RESERVATION_REVISION_CONFLICT');
      const next = (await db.query<ReservationRecord>(`UPDATE reservations SET status='cancelled',
        cancelled_at=clock_timestamp(),cancelled_by_type='merchant',decision_reason=COALESCE($1,decision_reason),
        revision=revision+1,updated_at=clock_timestamp()
        WHERE restaurant_id=$2 AND id=$3 AND revision=$4 RETURNING ${reservationColumns.replaceAll('r.', '')}`,
      [reason, rid, reservationId, expected])).rows[0];
      if (!next) throw new ApiError(409, 'RESERVATION_REVISION_CONFLICT');
      await insertEvent(db, { restaurantId: rid, reservationId, eventType: 'cancelled', actorType: 'merchant',
        actorUserId: session.user.id, fromStatus: row.status, toStatus: 'cancelled', revision: next.revision,
        requestId: key, fingerprint, changes: reason ? { reason } : {} });
      const restaurant = await restaurantName(db, rid);
      await queueReservationMail(db, config, next, 'reservation_cancelled', null, restaurant.name);
      await reservationAudit(db, session.user.id, rid, 'reservation_cancelled', reservationId, request.id);
      return merchantView(next, restaurant.name, restaurant.timezone ?? next.timezone_snapshot);
    });
  });
}
