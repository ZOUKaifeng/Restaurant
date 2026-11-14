import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import type { Pool } from 'pg';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { assertAppDatabase, createPool, id } from '../src/db.js';
import { migrate } from '../scripts/migrate.js';
import { ApiError } from '../src/errors.js';
import { FLOW_COOKIE, SESSION_COOKIE } from '../src/security.js';
import { resolveLocalStart } from '../src/reservation-access.js';

let app: FastifyInstance, pool: Pool, owner: Pool, config: Config;
let sequence = 0;
const password = '订位测试-Valid-Password-2026!';
const tables = 'reservations,reservation_events,reservation_access_tokens,website_model_calls,menu_jobs,menu_drafts,website_publish_actions,website_publications,website_jobs,website_versions,website_agents,asset_upload_intents,asset_references,assets,audit_logs,email_outbox,opening_hours,restaurant_members,auth_tokens,auth_sessions,auth_identities,restaurants,users';
interface Actor { email: string; cookie: string; csrf: string }
interface Shop { rid: string; slug: string; revision: number }

function testUrl(key: string, role: string): string {
  const value = process.env[key];
  assert.ok(value, `必须提供真实 ${key}，禁止跳过或连接开发数据库`);
  const url = new URL(value);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55439');
  assert.equal(url.pathname, '/restaurant_test'); assert.equal(decodeURIComponent(url.username), role);
  return value;
}
before(async () => {
  const databaseUrl = testUrl('TEST_DATABASE_URL', 'restaurant_test_app');
  const migrationDatabaseUrl = testUrl('TEST_MIGRATION_DATABASE_URL', 'restaurant_test_owner');
  config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, MIGRATION_DATABASE_URL: migrationDatabaseUrl,
    APP_ORIGIN: 'https://localhost:5173', EMAIL_MODE: 'disabled', STORAGE_MODE: 'local',
    STORAGE_LOCAL_ROOT: '/tmp/restaurant-reservation-test-assets', SITE_PUBLIC_ORIGIN: 'http://127.0.0.1:4010',
    SITE_PORT: '4010', TOKEN_PEPPER: 'reservation-fixture-pepper-'.repeat(3),
    CURSOR_SECRET: 'reservation-fixture-cursor-'.repeat(3), OUTBOX_ENCRYPTION_KEY: 'b2'.repeat(32) });
  owner = createPool(migrationDatabaseUrl); pool = createPool(databaseUrl);
  await migrate(owner, 'restaurant_test_app');
  await assertAppDatabase(pool);
  await owner.query(`TRUNCATE ${tables}`);
  app = createApp({ pool, config });
  await app.ready();
});
after(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
  if (owner) { try { await owner.query(`TRUNCATE ${tables}`); } finally { await owner.end(); } }
});
function cookie(response: { headers: Record<string, unknown> }, name: string): string {
  const values = response.headers['set-cookie'];
  const found = (Array.isArray(values) ? values : [values]).find(value => typeof value === 'string' && value.startsWith(`${name}=`));
  assert.equal(typeof found, 'string');
  return (found as string).split(';')[0]!;
}
async function request(method: HTTPMethods, path: string, actor?: Actor, payload?: Record<string, unknown>,
  extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (actor) { headers.cookie = actor.cookie; headers['x-csrf-token'] = actor.csrf; }
  if (method !== 'GET') headers.origin ??= config.appOrigin;
  if (payload !== undefined) headers['content-type'] ??= 'application/json';
  return app.inject({ method, url: `/api/v1${path}`, headers, ...(payload === undefined ? {} : { payload }),
    remoteAddress: `127.5.${Math.floor(++sequence / 250)}.${sequence % 250 + 1}` });
}
async function actor(email: string): Promise<Actor> {
  const flow = await request('GET', '/auth/csrf', undefined, undefined, { origin: config.appOrigin });
  assert.equal(flow.statusCode, 200, flow.body);
  const anonymous = { email, cookie: cookie(flow, FLOW_COOKIE), csrf: flow.json().csrf_token };
  assert.equal((await request('POST', '/auth/register', anonymous,
    { email, password, locale: 'en', terms_version: 'terms-v1', accepted_terms: true })).statusCode, 202);
  const row = (await owner.query(`SELECT id,sensitive_payload_ciphertext FROM email_outbox
    WHERE recipient_email_normalized=$1 AND template_key='verify_email' AND sensitive_payload_ciphertext IS NOT NULL`, [email])).rows[0];
  const [version, iv, tag, ciphertext] = row.sensitive_payload_ciphertext.split('.');
  assert.equal(version, 'v1');
  const decoder = createDecipheriv('aes-256-gcm', Buffer.from(config.outboxEncryptionKey, 'hex'), Buffer.from(iv, 'base64url'));
  decoder.setAAD(Buffer.from(row.id)); decoder.setAuthTag(Buffer.from(tag, 'base64url'));
  const token = JSON.parse(Buffer.concat([decoder.update(Buffer.from(ciphertext, 'base64url')), decoder.final()]).toString('utf8')).token;
  assert.equal((await request('POST', '/auth/verify-email', undefined, { token })).statusCode, 204);
  const login = await request('POST', '/auth/login', anonymous, { email, password });
  assert.equal(login.statusCode, 200, login.body);
  return { email, cookie: cookie(login, SESSION_COOKIE), csrf: login.json().csrf_token };
}
async function createRestaurant(actorValue: Actor, name: string): Promise<string> {
  const response = await request('POST', '/restaurants', actorValue, { name, primary_locale: 'en' },
    { 'idempotency-key': id('create') });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().id as string;
}
function localDate(days = 3): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(Date.now() + days * 86400000));
}
async function publishFixture(rid: string, slug: string): Promise<void> {
  const html = '<!DOCTYPE html><html lang="en"><head><title>fixture</title></head><body><h1>fixture</h1></body></html>';
  const vid = id('wsv');
  await owner.query(`INSERT INTO website_versions(id,restaurant_id,version_number,summary,html,checksum,snapshot,asset_ids,model)
    VALUES($1,$2,1,'fixture',$3,$4,$5,'{}','fixture')`, [vid, rid, html,
  createHash('sha256').update(html).digest('hex'), JSON.stringify({ restaurant: {}, opening_hours: [], assets: [] })]);
  await owner.query(`INSERT INTO website_publications(restaurant_id,revision,published_version_id,slug,deployment_mode)
    VALUES($1,1,$2,$3,'local')`, [rid, vid, slug]);
}
async function addHours(rid: string, opens = '10:00', closes = '22:00', accepts = true): Promise<void> {
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    await owner.query(`INSERT INTO opening_hours(id,restaurant_id,weekday,opens_at_local,closes_at_local,
      closes_day_offset,accepts_requests,sort_order) VALUES($1,$2,$3,$4,$5,0,$6,0)`,
    [id('hours'), rid, weekday, opens, closes, accepts]);
  }
}
async function shop(actorValue: Actor, name: string): Promise<Shop> {
  const rid = await createRestaurant(actorValue, name);
  const slug = `shop-${Date.now().toString(36)}-${++sequence}`;
  await owner.query(`UPDATE restaurants SET timezone='America/New_York' WHERE id=$1`, [rid]);
  await owner.query(`UPDATE restaurants SET privacy_notice_version='privacy-v1' WHERE id=$1`, [rid]);
  await addHours(rid);
  await publishFixture(rid, slug);
  const enabled = await request('PATCH', `/restaurants/${rid}/reservations/settings`, actorValue,
    { enabled: true, privacy_notice_version: 'privacy-v1', expected_revision: 1 });
  assert.equal(enabled.statusCode, 200, enabled.body);
  return { rid, slug, revision: enabled.json().restaurant_revision as number };
}
function booking(_slug: string, overrides: Record<string, unknown> = {}) {
  return { guest_name: 'Alex Chen', guest_email: 'alex@example.com', guest_phone: '+1 212 555 0100',
    party_size: 2, local_date: localDate(), local_time: '18:00', privacy_notice_version: 'privacy-v1',
    privacy_consent: true, ...overrides };
}
async function submit(slug: string, payload: Record<string, unknown>, key = id('idem')) {
  const response = await app.inject({ method: 'POST', url: `/api/v1/public/restaurants/${slug}/reservations`,
    headers: { 'content-type': 'application/json', origin: config.website!.publicOrigin, 'idempotency-key': key },
    payload, remoteAddress: `127.6.${Math.floor(++sequence / 250)}.${sequence % 250 + 1}` });
  assert.equal(response.headers['cache-control'], 'no-store');
  return { response, key };
}

test('订位设置：未开启、无接受段、revision冲突与跨店读取', async () => {
  const operator = await actor(`settings-${randomUUID()}@example.com`);
  const rid = await createRestaurant(operator, 'Settings Shop');
  await owner.query(`UPDATE restaurants SET timezone='America/New_York' WHERE id=$1`, [rid]);
  await owner.query(`UPDATE restaurants SET privacy_notice_version='privacy-v1' WHERE id=$1`, [rid]);
  const slug = `settings-${Date.now().toString(36)}`;
  await publishFixture(rid, slug);
  const off = await submit(slug, booking(slug));
  assert.equal(off.response.statusCode, 422);
  assert.equal(off.response.json().code, 'RESERVATION_NOT_CONFIGURED');
  const noHours = await request('PATCH', `/restaurants/${rid}/reservations/settings`, operator,
    { enabled: true, privacy_notice_version: 'privacy-v1', expected_revision: 1 });
  assert.equal(noHours.statusCode, 422);
  assert.equal(noHours.json().code, 'NO_ACCEPTING_HOURS');
  await addHours(rid);
  const enabled = await request('PATCH', `/restaurants/${rid}/reservations/settings`, operator,
    { enabled: true, privacy_notice_version: 'privacy-v1', expected_revision: 1 });
  assert.equal(enabled.statusCode, 200, enabled.body);
  assert.equal(enabled.json().enabled, true);
  assert.equal(enabled.json().restaurant_revision, 2);
  const stale = await request('PATCH', `/restaurants/${rid}/reservations/settings`, operator,
    { enabled: false, expected_revision: 1 });
  assert.equal(stale.statusCode, 412);
  const unauthenticated = await app.inject({ method: 'GET', url: `/api/v1/restaurants/${rid}/reservations/settings` });
  assert.equal(unauthenticated.statusCode, 401);
  const other = await actor(`settings-other-${randomUUID()}@example.com`);
  const crossShop = await request('GET', `/restaurants/${rid}/reservations/settings`, other);
  assert.equal(crossShop.statusCode, 404);
});

test('公开提交：营业时间、隐私版本、幂等与来源限制', async () => {
  const operator = await actor(`submit-${randomUUID()}@example.com`);
  const { slug, rid } = await shop(operator, 'Submit Shop');
  const first = await submit(slug, booking(slug), 'booking-key-0000000000001');
  assert.equal(first.response.statusCode, 201, first.response.body);
  const created = first.response.json();
  assert.equal(created.reservation.status, 'pending');
  assert.match(created.reservation.reference, /^R[A-Z0-9]{8}$/);
  assert.match(created.manage_token, /^[A-Za-z0-9_-]{43}$/);
  const replay = await submit(slug, booking(slug), 'booking-key-0000000000001');
  assert.equal(replay.response.statusCode, 200);
  assert.equal(replay.response.json().manage_token, undefined);
  const conflict = await submit(slug, booking(slug, { party_size: 3 }), 'booking-key-0000000000001');
  assert.equal(conflict.response.statusCode, 409);
  assert.equal(conflict.response.json().code, 'IDEMPOTENCY_CONFLICT');
  const rows = await owner.query(`SELECT status,revision,public_reference FROM reservations WHERE restaurant_id=$1`, [rid]);
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].status, 'pending');
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM reservation_events WHERE restaurant_id=$1`, [rid])).rows[0].n, 1);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM reservation_access_tokens WHERE restaurant_id=$1`, [rid])).rows[0].n, 1);
  const outbox = (await owner.query(`SELECT template_key,payload,sensitive_payload_ciphertext,status FROM email_outbox
    WHERE restaurant_id=$1`, [rid])).rows;
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].template_key, 'reservation_received');
  assert.equal(outbox[0].status, 'queued');
  assert.deepEqual(Object.keys(outbox[0].payload).sort(), ['local_date', 'local_time', 'party_size', 'reference', 'restaurant_name', 'version']);
  assert.ok(outbox[0].sensitive_payload_ciphertext);
  const closed = await submit(slug, booking(slug, { local_time: '03:00' }));
  assert.equal(closed.response.statusCode, 422);
  assert.equal(closed.response.json().code, 'RESERVATION_CLOSED');
  const bigParty = await submit(slug, booking(slug, { party_size: 21 }));
  assert.equal(bigParty.response.statusCode, 422);
  const noContact = await submit(slug, booking(slug, { guest_email: null, guest_phone: null }));
  assert.equal(noContact.response.statusCode, 422);
  const staleNotice = await submit(slug, booking(slug, { privacy_notice_version: 'privacy-v0' }));
  assert.equal(staleNotice.response.statusCode, 422);
  assert.equal(staleNotice.response.json().code, 'PRIVACY_NOTICE_STALE');
  const badOrigin = await app.inject({ method: 'POST', url: `/api/v1/public/restaurants/${slug}/reservations`,
    headers: { 'content-type': 'application/json', origin: 'https://evil.example', 'idempotency-key': id('idem') },
    payload: booking(slug) });
  assert.equal(badOrigin.statusCode, 403);
  const missingSite = await submit('not-a-real-shop', booking('not-a-real-shop'));
  assert.equal(missingSite.response.statusCode, 404);
});

test('顾客令牌查询、取消与终态保护', async () => {
  const operator = await actor(`guest-${randomUUID()}@example.com`);
  const { slug, rid } = await shop(operator, 'Guest Shop');
  const created = await submit(slug, booking(slug));
  assert.equal(created.response.statusCode, 201, created.response.body);
  const token = created.response.json().manage_token as string;
  const read = await app.inject({ method: 'GET', url: `/api/v1/public/reservations/${token}`,
    headers: { origin: config.website!.publicOrigin } });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().reservation.status, 'pending');
  assert.equal(read.json().reservation.guest_email, undefined);
  assert.ok(!read.body.includes('alex@example.com'));
  const invalidToken = await app.inject({ method: 'GET', url: `/api/v1/public/reservations/${'x'.repeat(43)}` });
  assert.equal(invalidToken.statusCode, 404);
  const cancel = await app.inject({ method: 'POST', url: `/api/v1/public/reservations/${token}/cancel`,
    headers: { 'content-type': 'application/json', origin: config.website!.publicOrigin },
    payload: { expected_revision: 1 } });
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.equal(cancel.json().reservation.status, 'cancelled');
  const again = await app.inject({ method: 'POST', url: `/api/v1/public/reservations/${token}/cancel`,
    headers: { 'content-type': 'application/json', origin: config.website!.publicOrigin },
    payload: { expected_revision: 1 } });
  assert.equal(again.statusCode, 200);
  const afterCancel = await app.inject({ method: 'GET', url: `/api/v1/public/reservations/${token}` });
  assert.equal(afterCancel.statusCode, 200);
  assert.equal(afterCancel.json().reservation.status, 'cancelled');
  const second = await submit(slug, booking(slug, { local_time: '19:00' }));
  const secondToken = second.response.json().manage_token as string;
  const secondId = (await owner.query(`SELECT id FROM reservations WHERE restaurant_id=$1
    AND public_reference=$2`, [rid, second.response.json().reservation.reference])).rows[0].id;
  const decision = await request('POST', `/restaurants/${rid}/reservations/${secondId}/decision`, operator,
    { decision: 'decline', expected_revision: 1, reason: 'Fully booked' }, { 'idempotency-key': id('decide') });
  assert.equal(decision.statusCode, 200, decision.body);
  assert.equal(decision.json().status, 'declined');
  const finalCancel = await app.inject({ method: 'POST', url: `/api/v1/public/reservations/${secondToken}/cancel`,
    headers: { 'content-type': 'application/json', origin: config.website!.publicOrigin },
    payload: { expected_revision: 2 } });
  assert.equal(finalCancel.statusCode, 409);
  assert.equal(finalCancel.json().code, 'RESERVATION_FINAL');
});

test('商家处理：确认幂等、审计、跨店隔离与邮箱通知', async () => {
  const operator = await actor(`merchant-${randomUUID()}@example.com`);
  const { slug, rid } = await shop(operator, 'Merchant Shop');
  assert.equal((await submit(slug, booking(slug))).response.statusCode, 201);
  const reservationId = (await owner.query('SELECT id FROM reservations WHERE restaurant_id=$1', [rid])).rows[0].id;
  const list = await request('GET', `/restaurants/${rid}/reservations?status=pending&limit=10`, operator);
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().items.length, 1);
  assert.equal(list.json().items[0].guest_email, 'alex@example.com');
  assert.match(list.body, /Alex Chen/);
  assert.ok(!list.body.includes('manage_token'));
  const other = await actor(`merchant-other-${randomUUID()}@example.com`);
  const crossList = await request('GET', `/restaurants/${rid}/reservations`, other);
  assert.equal(crossList.statusCode, 404);
  const crossDecision = await request('POST', `/restaurants/${rid}/reservations/${reservationId}/decision`, other,
    { decision: 'confirm', expected_revision: 1 }, { 'idempotency-key': id('decide') });
  assert.equal(crossDecision.statusCode, 404);
  const noCsrf = await app.inject({ method: 'POST', url: `/api/v1/restaurants/${rid}/reservations/${reservationId}/decision`,
    headers: { cookie: operator.cookie, origin: config.appOrigin, 'content-type': 'application/json',
      'idempotency-key': id('decide') }, payload: { decision: 'confirm', expected_revision: 1 } });
  assert.equal(noCsrf.statusCode, 403);
  const unauthenticated = await app.inject({ method: 'GET', url: `/api/v1/restaurants/${rid}/reservations` });
  assert.equal(unauthenticated.statusCode, 401);
  const key = id('decide');
  const confirmed = await request('POST', `/restaurants/${rid}/reservations/${reservationId}/decision`, operator,
    { decision: 'confirm', expected_revision: 1 }, { 'idempotency-key': key });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(confirmed.json().status, 'confirmed');
  assert.equal(confirmed.json().decided_by_user_id, (await owner.query('SELECT id FROM users WHERE email=$1', [operator.email])).rows[0].id);
  const replay = await request('POST', `/restaurants/${rid}/reservations/${reservationId}/decision`, operator,
    { decision: 'confirm', expected_revision: 1 }, { 'idempotency-key': key });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().status, 'confirmed');
  const different = await request('POST', `/restaurants/${rid}/reservations/${reservationId}/decision`, operator,
    { decision: 'decline', expected_revision: 1, reason: 'No' }, { 'idempotency-key': key });
  assert.equal(different.statusCode, 409);
  const final = await request('POST', `/restaurants/${rid}/reservations/${reservationId}/decision`, operator,
    { decision: 'confirm', expected_revision: 2 }, { 'idempotency-key': id('decide') });
  assert.equal(final.statusCode, 409);
  assert.equal(final.json().code, 'RESERVATION_FINAL');
  const audits = await owner.query(`SELECT action,entity_type FROM audit_logs WHERE restaurant_id=$1 AND entity_type='reservation'`, [rid]);
  assert.equal(audits.rowCount, 1);
  assert.equal(audits.rows[0].action, 'reservation_decided');
  const mails = (await owner.query(`SELECT template_key,payload,sensitive_payload_ciphertext FROM email_outbox
    WHERE restaurant_id=$1 ORDER BY created_at`, [rid])).rows;
  assert.deepEqual(mails.map(row => row.template_key), ['reservation_received', 'reservation_confirmed']);
  // 状态通知复用顾客原管理链接，不再轮换令牌；SMTP未配置时不会让顾客失去查看入口。
  assert.equal(mails[1].sensitive_payload_ciphertext, null);
  assert.ok(!JSON.stringify(mails[1].payload).includes('alex@example.com'));
  assert.ok(!JSON.stringify(mails[1].payload).includes('Alex Chen'));
  const merchantCancel = await request('POST', `/restaurants/${rid}/reservations/${reservationId}/cancel`, operator,
    { expected_revision: 2, reason: 'Kitchen closed' }, { 'idempotency-key': id('cancel') });
  assert.equal(merchantCancel.statusCode, 200, merchantCancel.body);
  assert.equal(merchantCancel.json().status, 'cancelled');
  assert.equal(merchantCancel.json().cancelled_by_type, 'merchant');
  const detail = await request('GET', `/restaurants/${rid}/reservations/${reservationId}`, operator);
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().events.length, 3);
});

test('夏令时不存在/重复时间与原始事实不可改写', async () => {
  await assert.rejects(resolveLocalStart(pool, '2027-03-14', '02:30', 'America/New_York', null),
    (error: unknown) => error instanceof ApiError && error.code === 'RESERVATION_TIME_INVALID');
  await assert.rejects(resolveLocalStart(pool, '2027-11-07', '01:30', 'America/New_York', null),
    (error: unknown) => error instanceof ApiError && error.code === 'RESERVATION_TIME_AMBIGUOUS');
  const daylight = await resolveLocalStart(pool, '2027-11-07', '01:30', 'America/New_York', -240);
  assert.equal(daylight.toISOString(), '2027-11-07T05:30:00.000Z');
  const standard = await resolveLocalStart(pool, '2027-11-07', '01:30', 'America/New_York', -300);
  assert.equal(standard.toISOString(), '2027-11-07T06:30:00.000Z');
  const operator = await actor(`facts-${randomUUID()}@example.com`);
  const { slug, rid } = await shop(operator, 'Facts Shop');
  await submit(slug, booking(slug));
  const row = (await owner.query('SELECT id FROM reservations WHERE restaurant_id=$1', [rid])).rows[0];
  await assert.rejects(owner.query(`UPDATE reservations SET guest_name='Changed' WHERE id=$1`, [row.id]));
  await assert.rejects(owner.query(`UPDATE reservations SET status='confirmed',decided_at=now(),
    decided_by_user_id=(SELECT id FROM users WHERE email=$2) WHERE id=$1`, [row.id, operator.email]));
  await assert.rejects(owner.query(`UPDATE reservation_events SET request_id='other' WHERE reservation_id=$1`, [row.id]));
  await assert.rejects(owner.query('DELETE FROM reservations WHERE id=$1', [row.id]));
  const version = await owner.query(`SELECT revision FROM reservations WHERE id=$1`, [row.id]);
  assert.equal(version.rows[0].revision, 1);
});
