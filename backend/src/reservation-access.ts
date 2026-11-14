import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Config } from './config.js';
import type { Database } from './db.js';
import { id, transaction } from './db.js';
import { ApiError } from './errors.js';
import { digest, encryptAction, normalizeEmail, secret } from './security.js';

export type ReservationStatus = 'pending' | 'confirmed' | 'declined' | 'cancelled';
export type ReservationActor = 'guest' | 'merchant' | 'system';
export type ReservationTemplate = 'reservation_received' | 'reservation_confirmed' | 'reservation_declined' | 'reservation_cancelled';

export interface ReservationRecord {
  id: string; restaurant_id: string; public_reference: string;
  customer_user_id: string | null; source: 'website' | 'merchant_manual'; website_version_id: string | null;
  guest_name: string; guest_email: string | null; guest_email_normalized: string | null; guest_phone: string | null;
  guest_email_verified_at: Date | null;
  party_size: number; local_date: string; local_time: string;
  timezone_snapshot: string; requested_start_at: Date;
  guest_note: string | null; internal_note: string | null;
  status: ReservationStatus; decided_at: Date | null; decided_by_user_id: string | null; decision_reason: string | null;
  cancelled_at: Date | null; cancelled_by_type: ReservationActor | null;
  privacy_notice_version: string; privacy_notice_shown_at: Date;
  idempotency_key: string; initial_request_fingerprint: string;
  anonymized_at: Date | null; revision: number; created_at: Date; updated_at: Date;
}
export interface ReservationInterval {
  weekday: number; opens_at_local: string; closes_at_local: string; closes_day_offset: number; accepts_requests: boolean;
}
export interface ReservationSettings {
  restaurant_revision: number; enabled: boolean; notice: string | null; privacy_notice_version: string | null;
  timezone: string | null; intervals: ReservationInterval[];
}
export interface PublicReservationView {
  reference: string; status: ReservationStatus; restaurant_name: string; timezone: string;
  guest_name: string; guest_email_masked: string | null; party_size: number;
  local_date: string; local_time: string; requested_start_at: string;
  note: string | null; decision_reason: string | null; cancelled_at: string | null;
  cancelled_by_type: ReservationActor | null; revision: number; created_at: string;
}
export interface MerchantReservationView extends PublicReservationView {
  id: string; guest_email: string | null; guest_phone: string | null; internal_note: string | null;
  decided_at: string | null; decided_by_user_id: string | null; updated_at: string;
}
export interface PublicSite {
  slug: string; restaurant_id: string; restaurant_name: string; timezone: string | null;
  enabled: boolean; notice: string | null; privacy_notice_version: string | null;
}
export interface CreateReservationInput {
  guest_name: string; guest_email: string | null; guest_phone: string | null; party_size: number;
  local_date: string; local_time: string; note: string | null;
  privacy_notice_version: string; privacy_consent: true; utc_offset_minutes: number | null;
}

export const reservationColumns = `r.id,r.restaurant_id,r.public_reference,r.customer_user_id,r.source,r.website_version_id,
  r.guest_name,r.guest_email,r.guest_email_normalized,r.guest_phone,r.guest_email_verified_at,r.party_size,
  to_char(r.requested_local_date,'YYYY-MM-DD') AS local_date,to_char(r.requested_local_time,'HH24:MI') AS local_time,
  r.timezone_snapshot,r.requested_start_at,r.guest_note,r.internal_note,r.status,r.decided_at,r.decided_by_user_id,
  r.decision_reason,r.cancelled_at,r.cancelled_by_type,r.privacy_notice_version,r.privacy_notice_shown_at,
  r.idempotency_key,r.initial_request_fingerprint,r.anonymized_at,r.revision,r.created_at,r.updated_at`;

export function reservationFingerprint(rid: string, input: CreateReservationInput): string {
  return createHash('sha256').update(JSON.stringify({
    restaurant_id: rid, guest_name: input.guest_name, guest_email: input.guest_email, guest_phone: input.guest_phone,
    party_size: input.party_size, local_date: input.local_date, local_time: input.local_time, note: input.note,
    privacy_notice_version: input.privacy_notice_version, utc_offset_minutes: input.utc_offset_minutes,
  })).digest('hex');
}
export function decisionFingerprint(decision: 'confirm' | 'decline', expected: number, reason: string | null): string {
  return createHash('sha256').update(JSON.stringify({ action: 'decision', decision, expected_revision: expected, reason })).digest('hex');
}
export function cancelFingerprint(expected: number, reason: string | null): string {
  return createHash('sha256').update(JSON.stringify({ action: 'cancel', expected_revision: expected, reason })).digest('hex');
}
export function newPublicReference(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return `R${Array.from(randomBytes(8), byte => alphabet[byte % 32]).join('')}`;
}
export function tokenHash(config: Config, token: string): string { return digest(config, token, 'reservation_manage'); }
export function maskEmail(value: string | null): string | null {
  if (!value) return null;
  const [local, domain] = value.split('@');
  if (!local || !domain) return null;
  return `${local.slice(0, 1)}${'*'.repeat(Math.min(3, Math.max(1, local.length - 1)))}@${domain}`;
}

export async function readPublicSite(db: Database, slug: string): Promise<PublicSite | null> {
  const row = (await db.query<{ slug: string; restaurant_id: string; restaurant_name: string; timezone: string | null;
    enabled: boolean; notice: string | null; privacy_notice_version: string | null }>(`
    SELECT p.slug,r.id AS restaurant_id,r.name AS restaurant_name,r.timezone,r.reservation_enabled AS enabled,
      r.reservation_notice AS notice,r.privacy_notice_version
    FROM website_publications p JOIN restaurants r ON r.id=p.restaurant_id
    WHERE p.slug=$1 AND p.published_version_id IS NOT NULL`, [slug])).rows[0];
  return row ?? null;
}
export function requireReservationConfigured(site: PublicSite): void {
  if (!site.enabled || !site.timezone || !site.privacy_notice_version) throw new ApiError(422, 'RESERVATION_NOT_CONFIGURED');
}
export async function readSettings(db: Database, rid: string): Promise<ReservationSettings> {
  const row = (await db.query<{ restaurant_revision: number; enabled: boolean; notice: string | null;
    privacy_notice_version: string | null; timezone: string | null; intervals: ReservationInterval[] }>(`
    SELECT r.revision AS restaurant_revision,r.reservation_enabled AS enabled,r.reservation_notice AS notice,
      r.privacy_notice_version,r.timezone,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('weekday',h.weekday,
        'opens_at_local',to_char(h.opens_at_local,'HH24:MI'),'closes_at_local',to_char(h.closes_at_local,'HH24:MI'),
        'closes_day_offset',h.closes_day_offset,'accepts_requests',h.accepts_requests)
        ORDER BY h.weekday,h.sort_order,h.id) FROM opening_hours h WHERE h.restaurant_id=r.id),'[]'::jsonb) AS intervals
    FROM restaurants r WHERE r.id=$1`, [rid])).rows[0];
  if (!row) throw new ApiError(404);
  return row;
}
export async function lockOwnedRestaurant(db: PoolClient, userId: string, rid: string): Promise<ReservationSettings> {
  const restaurant = (await db.query<{ status: string }>('SELECT status FROM restaurants WHERE id=$1 FOR UPDATE', [rid])).rows[0];
  const member = (await db.query(`SELECT id FROM restaurant_members WHERE restaurant_id=$1 AND user_id=$2
    AND role='owner' AND status='active' FOR UPDATE`, [rid, userId])).rows[0];
  if (!restaurant || !member) throw new ApiError(404);
  if (!['draft', 'active'].includes(restaurant.status)) throw new ApiError(409, 'RESTAURANT_UNAVAILABLE');
  return readSettings(db, rid);
}
export function requireSettingsRevision(settings: ReservationSettings, expected: number): void {
  if (settings.restaurant_revision !== expected || settings.restaurant_revision >= 2147483646) throw new ApiError(412, 'REVISION_CONFLICT');
}

function isoWeekday(date: string): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
}
export function withinBusinessHours(intervals: ReservationInterval[], date: string, time: string): boolean {
  const weekday = isoWeekday(date);
  const previous = weekday === 1 ? 7 : weekday - 1;
  return intervals.some(interval => {
    if (!interval.accepts_requests) return false;
    if (interval.weekday === weekday && interval.closes_day_offset === 0)
      return time >= interval.opens_at_local && time < interval.closes_at_local;
    if (interval.weekday === weekday && interval.closes_day_offset === 1) return time >= interval.opens_at_local;
    if (interval.weekday === previous && interval.closes_day_offset === 1) return time < interval.closes_at_local;
    return false;
  });
}
export async function resolveLocalStart(db: Database, date: string, time: string, timezone: string,
  offsetMinutes: number | null): Promise<Date> {
  const result = await db.query<{ candidates: Date[] | null }>(`
    SELECT array_agg(u ORDER BY u) AS candidates FROM generate_series(
      (($1::date + $2::time)::timestamp AT TIME ZONE 'UTC') - interval '15 hours',
      (($1::date + $2::time)::timestamp AT TIME ZONE 'UTC') + interval '15 hours',
      interval '15 minutes') u
    WHERE (u AT TIME ZONE $3)=($1::date + $2::time)::timestamp`, [date, time, timezone]);
  const candidates = result.rows[0]?.candidates ?? [];
  if (!candidates.length) throw new ApiError(422, 'RESERVATION_TIME_INVALID');
  if (candidates.length === 1) return candidates[0]!;
  if (offsetMinutes === null) throw new ApiError(422, 'RESERVATION_TIME_AMBIGUOUS');
  const wall = Date.parse(`${date}T${time}:00Z`);
  const chosen = candidates.find(value => Math.round((wall - value.getTime()) / 60000) === offsetMinutes);
  if (!chosen) throw new ApiError(422, 'RESERVATION_TIME_INVALID');
  return chosen;
}
export function publicView(row: ReservationRecord, restaurantName: string, timezone: string): PublicReservationView {
  return {
    reference: row.public_reference, status: row.status, restaurant_name: restaurantName, timezone,
    guest_name: row.guest_name, guest_email_masked: maskEmail(row.guest_email), party_size: row.party_size,
    local_date: row.local_date, local_time: row.local_time, requested_start_at: row.requested_start_at.toISOString(),
    note: row.guest_note, decision_reason: row.decision_reason,
    cancelled_at: row.cancelled_at?.toISOString() ?? null, cancelled_by_type: row.cancelled_by_type,
    revision: row.revision, created_at: row.created_at.toISOString(),
  };
}
export function merchantView(row: ReservationRecord, restaurantName: string, timezone: string): MerchantReservationView {
  return {
    ...publicView(row, restaurantName, timezone), id: row.id,
    guest_email: row.guest_email, guest_phone: row.guest_phone, internal_note: row.internal_note,
    decided_at: row.decided_at?.toISOString() ?? null, decided_by_user_id: row.decided_by_user_id,
    updated_at: row.updated_at.toISOString(),
  };
}
export async function insertEvent(db: Database, input: {
  restaurantId: string; reservationId: string; eventType: 'created' | 'confirmed' | 'declined' | 'cancelled';
  actorType: ReservationActor; actorUserId: string | null; fromStatus: ReservationStatus | null;
  toStatus: ReservationStatus; revision: number; requestId: string; fingerprint: string; changes?: Record<string, unknown>;
}): Promise<void> {
  await db.query(`INSERT INTO reservation_events(id,restaurant_id,reservation_id,event_type,actor_type,actor_user_id,
    from_status,to_status,reservation_revision,changes,request_id,action_fingerprint)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
  [id('rev'), input.restaurantId, input.reservationId, input.eventType, input.actorType, input.actorUserId,
    input.fromStatus, input.toStatus, input.revision, JSON.stringify(input.changes ?? {}), input.requestId, input.fingerprint]);
}
export async function rotateManageToken(db: PoolClient, config: Config, reservation: ReservationRecord): Promise<string> {
  await db.query('UPDATE reservation_access_tokens SET revoked_at=now() WHERE reservation_id=$1 AND revoked_at IS NULL', [reservation.id]);
  const token = secret();
  await db.query(`INSERT INTO reservation_access_tokens(id,restaurant_id,reservation_id,token_hash,expires_at)
    VALUES($1,$2,$3,$4,now()+interval '120 days')`, [id('rtk'), reservation.restaurant_id, reservation.id, tokenHash(config, token)]);
  return token;
}
export async function queueReservationMail(db: PoolClient, config: Config, reservation: ReservationRecord,
  template: ReservationTemplate, token: string | null, restaurantName: string): Promise<void> {
  if (!reservation.guest_email || !reservation.guest_email_normalized) return;
  const outboxId = id('mail');
  const payload = { version: 1, reference: reservation.public_reference, local_date: reservation.local_date,
    local_time: reservation.local_time, party_size: reservation.party_size, restaurant_name: restaurantName };
  await db.query(`INSERT INTO email_outbox(id,restaurant_id,category,template_key,template_version,recipient_email,
    recipient_email_normalized,recipient_email_key,email_key_version,reservation_id,payload,
    sensitive_payload_ciphertext,sensitive_payload_expires_at,dedupe_key)
    VALUES($1,$2,'transactional',$3,'v1',$4,$5,$6,1,$7,$8,$9,now()+interval '30 days',$10)`,
  [outboxId, reservation.restaurant_id, template, reservation.guest_email, reservation.guest_email_normalized,
    digest(config, reservation.guest_email_normalized, 'email'), reservation.id, JSON.stringify(payload),
    token ? encryptAction(config, outboxId, token) : null, `${template}:${reservation.id}:${reservation.revision}`]);
}
export async function reservationAudit(db: Database, userId: string, rid: string, action: string,
  reservationId: string, requestId: string): Promise<void> {
  await db.query(`INSERT INTO audit_logs(id,restaurant_id,actor_type,actor_user_id,action,entity_type,entity_id,request_id,outcome,changed_fields)
    VALUES($1,$2,'merchant',$3,$4,'reservation',$5,$6,'success',ARRAY['status'])`,
  [id('aud'), rid, userId, action, reservationId, requestId]);
}
export async function readReservationByToken(db: Database, config: Config, token: string, lock = false): Promise<ReservationRecord> {
  const result = await db.query<ReservationRecord>(`SELECT ${reservationColumns}
    FROM reservation_access_tokens t JOIN reservations r ON r.restaurant_id=t.restaurant_id AND r.id=t.reservation_id
    WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND t.expires_at>now()${lock ? ' FOR UPDATE OF r' : ''}`,
  [tokenHash(config, token)]);
  if (!result.rows[0]) throw new ApiError(404);
  return result.rows[0];
}
export async function readReservation(db: Database, rid: string, reservationId: string, lock = false): Promise<ReservationRecord> {
  const result = await db.query<ReservationRecord>(`SELECT ${reservationColumns} FROM reservations r
    WHERE r.restaurant_id=$1 AND r.id=$2${lock ? ' FOR UPDATE' : ''}`, [rid, reservationId]);
  if (!result.rows[0]) throw new ApiError(404);
  return result.rows[0];
}
export async function restaurantName(db: Database, rid: string): Promise<{ name: string; timezone: string | null }> {
  const row = (await db.query<{ name: string; timezone: string | null }>('SELECT name,timezone FROM restaurants WHERE id=$1', [rid])).rows[0];
  if (!row) throw new ApiError(404);
  return row;
}

export interface CreateResult { reservation: ReservationRecord; token: string | null; replay: boolean }
export async function createReservation(pool: Pool, config: Config, site: PublicSite,
  input: CreateReservationInput, idempotencyKey: string, requestId: string): Promise<CreateResult> {
  const fingerprint = reservationFingerprint(site.restaurant_id, input);
  return transaction(pool, async db => {
    const existing = (await db.query<ReservationRecord>(`SELECT ${reservationColumns} FROM reservations r
      WHERE r.restaurant_id=$1 AND r.idempotency_key=$2`, [site.restaurant_id, idempotencyKey])).rows[0];
    if (existing) {
      if (existing.initial_request_fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT');
      return { reservation: existing, token: null, replay: true };
    }
    const settings = await readSettings(db, site.restaurant_id);
    if (!settings.timezone) throw new ApiError(422, 'RESERVATION_NOT_CONFIGURED');
    if (!withinBusinessHours(settings.intervals, input.local_date, input.local_time)) throw new ApiError(422, 'RESERVATION_CLOSED');
    const start = await resolveLocalStart(db, input.local_date, input.local_time, settings.timezone, input.utc_offset_minutes);
    const window = (await db.query<{ valid: boolean }>(`SELECT $1::timestamptz>clock_timestamp()+interval '15 minutes'
      AND $1::timestamptz<clock_timestamp()+interval '90 days' AS valid`, [start])).rows[0]!;
    if (!window.valid) throw new ApiError(422, 'RESERVATION_TIME_OUT_OF_RANGE');
    const reservationId = id('rsv');
    let inserted: ReservationRecord | undefined;
    for (let attempt = 0; attempt < 5 && !inserted; attempt += 1) {
      try {
        inserted = (await db.query<ReservationRecord>(`INSERT INTO reservations(id,restaurant_id,public_reference,source,
          website_version_id,guest_name,guest_email,guest_email_normalized,guest_phone,party_size,requested_local_date,
          requested_local_time,timezone_snapshot,requested_start_at,guest_note,privacy_notice_version,
          privacy_notice_shown_at,idempotency_key,initial_request_fingerprint,status,revision)
          VALUES($1,$2,$3,'website',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,clock_timestamp(),$16,$17,'pending',1)
          RETURNING ${reservationColumns.replaceAll('r.', '')}`, [reservationId, site.restaurant_id, newPublicReference(),
          null, input.guest_name, input.guest_email, input.guest_email ? normalizeEmail(input.guest_email) : null,
          input.guest_phone, input.party_size, input.local_date, input.local_time, settings.timezone, start,
          input.note, input.privacy_notice_version, idempotencyKey, fingerprint])).rows[0];
      } catch (error) {
        const constraint = (error as { constraint?: string }).constraint;
        if (constraint === 'reservations_restaurant_id_idempotency_key_key') {
          const replay = (await db.query<ReservationRecord>(`SELECT ${reservationColumns} FROM reservations r
            WHERE r.restaurant_id=$1 AND r.idempotency_key=$2`, [site.restaurant_id, idempotencyKey])).rows[0];
          if (replay && replay.initial_request_fingerprint === fingerprint) return { reservation: replay, token: null, replay: true };
          throw new ApiError(409, 'IDEMPOTENCY_CONFLICT');
        }
        if (constraint !== 'reservations_restaurant_id_public_reference_key') throw error;
      }
    }
    if (!inserted) throw new ApiError(503, 'REFERENCE_ALLOCATION_FAILED');
    const token = await rotateManageToken(db, config, inserted);
    await insertEvent(db, { restaurantId: site.restaurant_id, reservationId: inserted.id, eventType: 'created',
      actorType: 'guest', actorUserId: null, fromStatus: null, toStatus: 'pending', revision: 1,
      requestId, fingerprint, changes: { party_size: input.party_size, local_date: input.local_date, local_time: input.local_time } });
    await queueReservationMail(db, config, inserted, 'reservation_received', token, site.restaurant_name);
    return { reservation: inserted, token, replay: false };
  });
}

export async function cancelGuestReservation(pool: Pool, config: Config, token: string, expected: number,
  requestId: string, reason: string | null = null): Promise<ReservationRecord> {
  return transaction(pool, async db => {
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
      requestId, fingerprint: cancelFingerprint(expected, reason), changes: reason ? { reason } : {} });
    const restaurant = await restaurantName(db, row.restaurant_id);
    await queueReservationMail(db, config, next, 'reservation_cancelled', null, restaurant.name);
    return next;
  });
}
