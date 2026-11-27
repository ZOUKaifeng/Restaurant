import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createDecipheriv } from 'node:crypto';
import type { Pool } from 'pg';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { loadConfig, type Config } from '../src/config.js';
import { assertAppDatabase, id, transaction } from '../src/db.js';
import { createApp } from '../src/app.js';
import { migrate } from '../scripts/migrate.js';
import { contract, schemaValidator } from '../src/validation.js';
import { runMailBatch } from '../src/mail-worker.js';
import { digest, lockAuthenticated, SESSION_COOKIE, FLOW_COOKIE, REGISTRATION_COOKIE, type Session } from '../src/security.js';

let pool: Pool, owner: Pool, app: FastifyInstance, config: Config;
let sequence = 0;
const password = '测试专用-Valid-Password-2026!';
const newPassword = '测试专用-New-Password-2026!';
interface Actor { cookie: string; csrf: string; email: string; password: string }
const tables = 'ai_calendar_credit_grants,website_content_actions,website_version_sources,billing_subscriptions,billing_offer_grants,ai_quota_ledger,ai_quota_periods,ai_model_calls,billing_accounts,analytics_events,analytics_daily,website_model_calls,menu_jobs,menu_drafts,website_publish_actions,website_publications,website_jobs,website_versions,website_agents,asset_references,asset_upload_intents,assets,reservations,reservation_events,reservation_access_tokens,audit_logs,email_outbox,opening_hours,restaurant_members,auth_tokens,auth_sessions,auth_identities,restaurants,users';
import { createTestDatabasePool, createTestDatabasePools, readTestDatabaseScope } from './database-scope.js';
before(async () => {
  const scope = readTestDatabaseScope();
  const { databaseUrl: appUrl, migrationDatabaseUrl: ownerUrl } = scope;
  config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: appUrl, MIGRATION_DATABASE_URL: ownerUrl,
    TOKEN_PEPPER: process.env.TOKEN_PEPPER ?? 'merchant-core-fixture-pepper-'.repeat(4),
    CURSOR_SECRET: process.env.CURSOR_SECRET ?? 'merchant-core-fixture-cursor-'.repeat(4),
    OUTBOX_ENCRYPTION_KEY: process.env.OUTBOX_ENCRYPTION_KEY ?? 'a4'.repeat(32),
    APP_ORIGIN: 'https://localhost:5173', EMAIL_MODE: 'disabled' });
  ({ owner, pool } = await createTestDatabasePools(scope));
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
function cookies(response: { headers: Record<string, unknown> }, name: string): string {
  const values = response.headers['set-cookie'];
  const rows = Array.isArray(values) ? values : [values];
  const found = rows.find(value => typeof value === 'string' && value.startsWith(`${name}=`));
  assert.equal(typeof found, 'string', `响应应设置 ${name}`);
  assert.match(found as string, /HttpOnly/i);
  assert.match(found as string, /Secure/i);
  assert.match(found as string, /SameSite=Lax/i);
  assert.doesNotMatch(found as string, /Domain=/i);
  return (found as string).split(';')[0]!;
}
async function request(method: HTTPMethods, path: string, actor?: Actor, payload?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (actor) { headers.cookie = actor.cookie; headers['x-csrf-token'] = actor.csrf; }
  if (method !== 'GET') headers.origin ??= config.appOrigin;
  if (payload !== undefined) headers['content-type'] ??= 'application/json';
  const response = await app.inject({ method, url: `/api/v1${path}`, headers, ...(payload === undefined ? {} : { payload: payload as object }), remoteAddress: `127.1.${Math.floor(++sequence / 250)}.${sequence % 250 + 1}` });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.ok(response.headers['x-request-id']);
  if (response.statusCode >= 400) {
    const body = response.json();
    assert.ok(schemaValidator('Error')(body), JSON.stringify(body));
    assert.equal((body as { request_id: string }).request_id, response.headers['x-request-id']);
    if (response.statusCode === 401) assert.equal(response.headers['www-authenticate'], 'Session realm="restaurant-platform"');
  }
  return response;
}
async function anonymous(email = '', currentPassword = password): Promise<Actor> {
  const result = await request('GET', '/auth/csrf', undefined, undefined, { origin: config.appOrigin });
  assert.equal(result.statusCode, 200);
  assert.ok(schemaValidator('CsrfResponse')(result.json()));
  return { cookie: cookies(result, FLOW_COOKIE), csrf: result.json().csrf_token, email, password: currentPassword };
}
async function action(email: string, purpose: string): Promise<string> {
  const result = await owner.query(`SELECT o.* FROM email_outbox o WHERE recipient_email_normalized=$1 AND template_key=$2 AND sensitive_payload_ciphertext IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1`, [email.toLowerCase(), purpose]);
  const row = result.rows[0];
  assert.ok(row, '动作 token 只从真实测试库短期密文取得');
  assert.equal(row.status, 'queued');
  assert.ok(row.sensitive_payload_expires_at > new Date());
  const [version, iv, tag, ciphertext] = row.sensitive_payload_ciphertext.split('.');
  assert.equal(version, 'v1');
  const decoder = createDecipheriv('aes-256-gcm', Buffer.from(config.outboxEncryptionKey, 'hex'), Buffer.from(iv, 'base64url'));
  decoder.setAAD(Buffer.from(row.id));
  decoder.setAuthTag(Buffer.from(tag, 'base64url'));
  const payload = JSON.parse(Buffer.concat([decoder.update(Buffer.from(ciphertext, 'base64url')), decoder.final()]).toString('utf8'));
  assert.match(payload.token, /^[A-Za-z0-9_-]{43}$/);
  const tokenRow = await owner.query('SELECT token_hash FROM auth_tokens WHERE id=$1', [row.auth_token_id]);
  assert.equal(tokenRow.rows[0].token_hash, digest(config, payload.token, purpose));
  assert.ok(!JSON.stringify(row.payload).includes(payload.token));
  return payload.token;
}
async function register(email: string): Promise<Actor> {
  const actor = await anonymous(email);
  const result = await request('POST', '/auth/register', actor, { email, password, display_name: ' 测试商家 ', locale: 'en', terms_version: 'terms-v1', accepted_terms: true });
  assert.equal(result.statusCode, 202, result.body);
  assert.ok(schemaValidator('Accepted')(result.json()));
  const proof = cookies(result, REGISTRATION_COOKIE);
  assert.ok(!proof.includes(email));
  return actor;
}
async function login(actor: Actor): Promise<Actor> {
  const result = await request('POST', '/auth/login', actor, { email: actor.email, password: actor.password });
  assert.equal(result.statusCode, 200, result.body);
  assert.ok(schemaValidator('LoginResponse')(result.json()), result.body);
  return { ...actor, cookie: cookies(result, SESSION_COOKIE), csrf: result.json().csrf_token };
}
async function sessionSnapshot(actor: Actor): Promise<Session> {
  const hash = digest(config, decodeURIComponent(actor.cookie.split('=')[1]!), 'session');
  const result = await owner.query(`SELECT s.id AS session_id,s.expires_at,u.id,u.email,u.display_name,u.locale,u.status,u.email_verified_at,u.created_at
    FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.session_secret_hash=$1`, [hash]);
  const row = result.rows[0];
  assert.ok(row);
  return { sessionId: row.session_id, sessionHash: hash, expires: row.expires_at, user: { id: row.id, email: row.email, display_name: row.display_name, locale: row.locale, status: row.status, email_verified_at: row.email_verified_at, created_at: row.created_at } };
}
async function waitForLock(blockerPid: number, waiterPid?: number): Promise<void> {
  const deadline = Date.now() + 5000;
  do {
    const result = await owner.query(`SELECT pid FROM pg_stat_activity WHERE usename='restaurant_test_app'
      AND $1::int=ANY(pg_blocking_pids(pid)) AND ($2::int IS NULL OR pid=$2::int)`, [blockerPid, waiterPid ?? null]);
    if (result.rowCount) return;
  } while (Date.now() < deadline);
  assert.fail('测试请求必须实际等待指定数据库锁，不以计时猜测并发顺序');
}
const interval = { weekday: 7, opens_at_local: '22:00', closes_at_local: '02:00', closes_day_offset: 1, accepts_requests: true, sort_order: 0 };

test('真实 PG 商家账户与餐厅完整闭环', async t => {
  let alice: Actor, bob: Actor, pending: Actor, restaurant: any, etag: string, originalBody: Record<string, unknown>;
  const key = 'create-alice-2026-0001';
  let verifyToken: string;
  await t.test('拒绝应用管理权限；SMTP disabled 不伪造发送；注册中性且规范化邮箱', async () => {
    await assert.rejects(assertAppDatabase(owner));
    alice = await register('Owner.Name+Alice@restaurant.example');
    const db = await owner.query('SELECT * FROM users WHERE email_normalized=$1', [alice.email.toLowerCase()]);
    assert.equal(db.rows[0].email_normalized, 'owner.name+alice@restaurant.example');
    assert.equal(db.rows[0].display_name, '测试商家');
    assert.equal(db.rows[0].status, 'pending_verification');
    assert.equal(db.rows[0].platform_role, 'none');
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM restaurant_members')).rows[0].n, 0);
    const firstHash = (await owner.query('SELECT password_hash FROM auth_identities WHERE user_id=$1', [db.rows[0].id])).rows[0].password_hash;
    assert.match(firstHash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    const again = await request('POST', '/auth/register', alice, { email: alice.email.toLowerCase(), password: newPassword, locale: 'en', terms_version: 'terms-v1', accepted_terms: true });
    assert.equal(again.statusCode, 202);
    assert.equal((await owner.query('SELECT password_hash FROM auth_identities WHERE user_id=$1', [db.rows[0].id])).rows[0].password_hash, firstHash);
    assert.equal(await runMailBatch(pool, config), 'disabled');
    assert.equal((await owner.query('SELECT status FROM email_outbox')).rows[0].status, 'queued');
    verifyToken = await action(alice.email, 'verify_email');
  });
  await t.test('密码错误与不存在均401；密码正确未验证才403', async () => {
    const wrong = await request('POST', '/auth/login', alice, { email: alice.email, password: '错误密码' });
    const absent = await request('POST', '/auth/login', alice, { email: 'not-exists@restaurant.example', password });
    assert.equal(wrong.statusCode, 401); assert.equal(absent.statusCode, 401);
    assert.equal(wrong.json().code, absent.json().code);
    const unverified = await request('POST', '/auth/login', alice, { email: alice.email, password });
    assert.equal(unverified.statusCode, 403);
    assert.equal(unverified.json().code, 'EMAIL_VERIFICATION_REQUIRED');
  });
  await t.test('动作仅POST消费，验证幂等且不登录，两个真实用户登录', async () => {
    assert.equal((await request('GET', '/auth/verify-email')).statusCode, 404);
    // 动作授权不依赖 Cookie/Origin/CSRF；不是 ambient 授权。
    const verify = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', payload: { token: verifyToken } });
    assert.equal(verify.statusCode, 204); assert.equal(verify.body, ''); assert.equal(verify.headers['set-cookie'], undefined);
    assert.equal((await request('POST', '/auth/verify-email', undefined, { token: verifyToken })).statusCode, 204);
    const outbox = await owner.query('SELECT sensitive_payload_ciphertext FROM email_outbox WHERE recipient_email_normalized=$1', [alice.email.toLowerCase()]);
    assert.equal(outbox.rows[0].sensitive_payload_ciphertext, null);
    alice = await login(alice);
    bob = await register('owner.bob@restaurant.example');
    assert.equal((await request('POST', '/auth/verify-email', undefined, { token: await action(bob.email, 'verify_email') })).statusCode, 204);
    bob = await login(bob);
    assert.equal((await request('GET', '/auth/me', alice)).statusCode, 200);
  });
  await t.test('注册/重发/找回中性，未知字段和密码边界拒绝', async () => {
    const current = await anonymous();
    for (const path of ['/auth/verification-emails', '/auth/password-reset-requests']) {
      const unknown = await request('POST', path, current, { email: 'absent@restaurant.example' });
      const known = await request('POST', path, current, { email: alice.email });
      assert.equal(unknown.statusCode, 202); assert.equal(known.statusCode, 202); assert.deepEqual(known.json(), unknown.json());
    }
    const base = { email: 'invalid@restaurant.example', password, locale: 'en', terms_version: 'terms-v1', accepted_terms: true };
    for (const extra of [{ platform_role: 'admin' }, { role: 'owner' }, { password: 'a'.repeat(129) }, { password: 'a'.repeat(15) }, { locale: 'xx' }, { terms_version: 'old' }]) assert.equal((await request('POST', '/auth/register', current, { ...base, ...extra })).statusCode, 422);
  });
  await t.test('建店并发幂等、owner/audit原子、同键不同内容409', async () => {
    originalBody = { name: ' 测试餐厅 ', primary_locale: 'en' };
    const responses = await Promise.all([request('POST', '/restaurants', alice, originalBody, { 'idempotency-key': key }), request('POST', '/restaurants', alice, originalBody, { 'idempotency-key': key })]);
    for (const result of responses) { assert.equal(result.statusCode, 201, result.body); assert.ok(schemaValidator('Restaurant')(result.json()), result.body); }
    assert.equal(responses[0]!.json().id, responses[1]!.json().id);
    assert.deepEqual(responses.map(r => r.headers['idempotency-replayed']).sort(), ['false', 'true']);
    restaurant = responses[0]!.json(); etag = responses[0]!.headers.etag as string;
    assert.equal(restaurant.name, '测试餐厅'); assert.equal(restaurant.status, 'draft'); assert.equal(restaurant.reservation_enabled, false); assert.equal(restaurant.revision, 1); assert.equal(restaurant.readiness.ready_for_publication, false);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM restaurant_members WHERE restaurant_id=$1', [restaurant.id])).rows[0].n, 1);
    assert.equal((await owner.query("SELECT count(*)::int AS n FROM audit_logs WHERE entity_id=$1 AND action='create_restaurant'", [restaurant.id])).rows[0].n, 1);
    assert.equal((await request('POST', '/restaurants', alice, { ...originalBody, name: '不同内容' }, { 'idempotency-key': key })).statusCode, 409);
    const bobStore = await request('POST', '/restaurants', bob, { name: 'Bob餐厅', primary_locale: 'zh-CN' }, { 'idempotency-key': 'create-bob-2026-0001' });
    assert.equal(bobStore.statusCode, 201);
    assert.equal((await request('PATCH', `/restaurants/${bobStore.json().id}`, bob, { city: 'London' }, { 'if-match': bobStore.headers.etag as string })).statusCode, 200);
  });
  await t.test('事务helper在用户锁等待后拒绝撤销；陈旧快照不可授权', async () => {
    const actor = await login(await anonymous(alice.email));
    const snapshot = await sessionSnapshot(actor);
    const blocker = await owner.connect(), waiter = await pool.connect();
    const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const waiterPid = (await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [snapshot.user.id]);
      await blocker.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [snapshot.sessionId]);
      await waiter.query('BEGIN');
      const denied = assert.rejects(lockAuthenticated(waiter, config, snapshot), { status: 401 });
      await waitForLock(blockerPid, waiterPid);
      await blocker.query('COMMIT');
      await denied;
      await waiter.query('ROLLBACK');
      await assert.rejects(transaction(pool, db => lockAuthenticated(db, config, snapshot)), { status: 401 });
      const active = await sessionSnapshot(alice);
      await assert.rejects(transaction(pool, db => lockAuthenticated(db, config, { ...active, sessionHash: '0'.repeat(64) })), { status: 401 });
      await owner.query("UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [snapshot.sessionId]);
      await owner.query('UPDATE auth_sessions SET revoked_at=NULL WHERE id=$1', [snapshot.sessionId]);
      await assert.rejects(transaction(pool, db => lockAuthenticated(db, config, snapshot)), { status: 401 });
    } finally {
      try { await blocker.query('ROLLBACK'); } finally { blocker.release(); }
      try { await waiter.query('ROLLBACK'); } finally { waiter.release(); }
    }
  });
  await t.test('建店写事务在退出提交后拒绝，未创建餐厅或owner', async () => {
    const actor = await login(await anonymous(alice.email));
    const snapshot = await sessionSnapshot(actor), blocker = await owner.connect();
    const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const pendingKey = 'revocation-boundary-2026-0001';
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [snapshot.user.id]);
      await blocker.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [snapshot.sessionId]);
      const pendingWrite = request('POST', '/restaurants', actor, { name: '不可落库', primary_locale: 'en' }, { 'idempotency-key': pendingKey });
      await waitForLock(blockerPid);
      await blocker.query('COMMIT');
      assert.equal((await pendingWrite).statusCode, 401);
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM restaurants WHERE create_idempotency_key=$1', [pendingKey])).rows[0].n, 0);
    } finally {
      try { await blocker.query('ROLLBACK'); } finally { blocker.release(); }
    }
  });
  await t.test('未登录401，所有跨店读写404且先归属后ETag', async () => {
    assert.equal((await request('GET', `/restaurants/${restaurant.id}`)).statusCode, 401);
    for (const method of ['GET', 'PATCH'] as HTTPMethods[]) assert.equal((await request(method, `/restaurants/${restaurant.id}`, bob, method === 'PATCH' ? { name: '越权' } : undefined)).statusCode, 404);
    assert.equal((await request('GET', `/restaurants/${restaurant.id}/opening-hours`, bob)).statusCode, 404);
    assert.equal((await request('PUT', `/restaurants/${restaurant.id}/opening-hours`, bob, { intervals: [] }, { 'if-match': 'bad' })).statusCode, 404);
    const list = await request('GET', '/restaurants', bob);
    assert.equal(list.statusCode, 200); assert.ok(schemaValidator('RestaurantList')(list.json())); assert.equal(list.json().items.length, 1); assert.notEqual(list.json().items[0].id, restaurant.id);
  });
  await t.test('ETag missing428/格式400；严格资料白名单与有效timezone/currency/locale', async () => {
    assert.equal((await request('PATCH', `/restaurants/${restaurant.id}`, alice, { name: '新名称' })).statusCode, 428);
    for (const match of ['*', `W/${etag}`, 'bad', `${etag},${etag}`]) assert.equal((await request('PATCH', `/restaurants/${restaurant.id}`, alice, { name: '新名称' }, { 'if-match': match })).statusCode, 400);
    for (const body of [{ owner_id: 'other' }, { status: 'active' }, { reservation_enabled: true }, { revision: 99 }, { timezone: 'Europe/Fake' }, { timezone: '+01:00' }, { currency_code: 'ZZZ' }, { primary_locale: 'xx' }, { name: ' ' }, { name: null }, {}]) assert.equal((await request('PATCH', `/restaurants/${restaurant.id}`, alice, body, { 'if-match': etag })).statusCode, 422);
    assert.equal((await request('PUT', `/restaurants/${restaurant.id}/opening-hours`, alice, { intervals: [] }, { 'if-match': etag })).statusCode, 422);
    const update = await request('PATCH', `/restaurants/${restaurant.id}`, alice, { description: ' 商家确认的简介 ', timezone: 'Europe/London', currency_code: 'GBP', contact_email: 'PUBLIC@restaurant.example', city: 'London', country_code: 'GB', address_line1: '1 Example Road' }, { 'if-match': etag });
    assert.equal(update.statusCode, 200, update.body); assert.equal(update.json().description, '商家确认的简介'); assert.equal(update.json().contact_email, 'public@restaurant.example'); etag = update.headers.etag as string;
    const replay = await request('POST', '/restaurants', alice, originalBody, { 'idempotency-key': key });
    assert.equal(replay.statusCode, 201); assert.equal(replay.json().revision, update.json().revision); assert.equal(replay.json().description, update.json().description);
  });
  await t.test('餐厅锁等待后营业段使用新快照，不能用旧空营业段清除timezone', async () => {
    const blocker = await owner.connect();
    const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE', [restaurant.id]);
      await blocker.query(`INSERT INTO opening_hours(id,restaurant_id,weekday,opens_at_local,closes_at_local,closes_day_offset,accepts_requests,sort_order)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id('hours'), restaurant.id, interval.weekday, interval.opens_at_local, interval.closes_at_local, interval.closes_day_offset, interval.accepts_requests, interval.sort_order]);
      const revised = await blocker.query('UPDATE restaurants SET revision=revision+1,updated_at=now() WHERE id=$1 RETURNING revision', [restaurant.id]);
      const nextTag = `"restaurant-${restaurant.id}-v${revised.rows[0].revision}"`;
      const pendingPatch = request('PATCH', `/restaurants/${restaurant.id}`, alice, { timezone: null }, { 'if-match': nextTag });
      await waitForLock(blockerPid);
      await blocker.query('COMMIT');
      const result = await pendingPatch;
      assert.equal(result.statusCode, 422, result.body);
      assert.equal(result.json().details[0].code, 'OPENING_HOURS_REQUIRE_TIMEZONE');
      const persisted = await request('GET', `/restaurants/${restaurant.id}/opening-hours`, alice);
      assert.equal(persisted.headers.etag, nextTag);
      assert.equal(persisted.json().timezone, 'Europe/London');
      assert.deepEqual(persisted.json().intervals, [interval]);
      etag = nextTag;
    } finally {
      try { await blocker.query('ROLLBACK'); } finally { blocker.release(); }
    }
  });
  await t.test('并发相同ETag仅一成功，资料和营业共用revision且不覆盖', async () => {
    const results = await Promise.all([request('PATCH', `/restaurants/${restaurant.id}`, alice, { description: '窗口A' }, { 'if-match': etag }), request('PATCH', `/restaurants/${restaurant.id}`, alice, { description: '窗口B' }, { 'if-match': etag })]);
    assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 412]);
    const oldTag = etag;
    etag = results.find(r => r.statusCode === 200)!.headers.etag as string;
    assert.equal((await request('PUT', `/restaurants/${restaurant.id}/opening-hours`, alice, { intervals: [interval] }, { 'if-match': oldTag })).statusCode, 412);
    const hours = await request('PUT', `/restaurants/${restaurant.id}/opening-hours`, alice, { intervals: [interval] }, { 'if-match': etag });
    assert.equal(hours.statusCode, 200, hours.body); assert.ok(schemaValidator('OpeningHoursView')(hours.json())); assert.deepEqual(hours.json().intervals, [interval]); etag = hours.headers.etag as string;
    const read = await request('GET', `/restaurants/${restaurant.id}`, alice);
    assert.equal(read.headers.etag, etag); assert.equal(read.json().revision, hours.json().restaurant_revision);
  });
  await t.test('周界、跨午夜、duration与最多21段校验，null清空资料', async () => {
    for (const intervals of [[interval, { ...interval, weekday: 1, opens_at_local: '01:00', closes_at_local: '03:00', closes_day_offset: 0 }], [{ ...interval, opens_at_local: '00:00', closes_at_local: '00:01' }], [{ ...interval, closes_at_local: '22:00', closes_day_offset: 0 }], [{ ...interval, opens_at_local: '24:00' }], Array(22).fill(interval)]) assert.equal((await request('PUT', `/restaurants/${restaurant.id}/opening-hours`, alice, { intervals }, { 'if-match': etag })).statusCode, 422);
    assert.equal((await request('PATCH', `/restaurants/${restaurant.id}`, alice, { timezone: null }, { 'if-match': etag })).statusCode, 422);
    const cleared = await request('PATCH', `/restaurants/${restaurant.id}`, alice, { description: null }, { 'if-match': etag });
    assert.equal(cleared.statusCode, 200); assert.equal(cleared.json().description, null); etag = cleared.headers.etag as string;
    const fullDay = { ...interval, weekday: 2, opens_at_local: '00:00', closes_at_local: '00:00', closes_day_offset: 1 };
    const updated = await request('PUT', `/restaurants/${restaurant.id}/opening-hours`, alice, { intervals: [fullDay] }, { 'if-match': etag });
    assert.equal(updated.statusCode, 200); etag = updated.headers.etag as string;
    const clear = await request('PUT', `/restaurants/${restaurant.id}/opening-hours`, alice, { intervals: [] }, { 'if-match': etag });
    assert.equal(clear.statusCode, 200); etag = clear.headers.etag as string;
  });
  await t.test('CSRF/Origin严格拒绝；GET同源证据；JSON错误与速率限制', async () => {
    const fresh = await anonymous();
    assert.equal((await request('GET', '/auth/csrf')).statusCode, 403);
    assert.equal((await request('GET', '/auth/csrf', undefined, undefined, { referer: `${config.appOrigin}/account`, 'sec-fetch-site': 'same-origin' })).statusCode, 200);
    assert.equal((await request('GET', '/auth/csrf', undefined, undefined, { referer: 'https://evil.example/', 'sec-fetch-site': 'same-origin' })).statusCode, 403);
    assert.equal((await request('GET', '/auth/csrf', undefined, undefined, { origin: 'null', referer: `${config.appOrigin}/`, 'sec-fetch-site': 'same-origin' })).statusCode, 403);
    assert.equal((await request('POST', '/auth/login', fresh, { email: alice.email, password }, { origin: 'https://evil.example' })).statusCode, 403);
    assert.equal((await request('POST', '/auth/login', { ...fresh, csrf: 'invalid' }, { email: alice.email, password })).statusCode, 403);
    const other = await anonymous();
    assert.equal((await request('POST', '/auth/login', { ...fresh, csrf: other.csrf }, { email: alice.email, password })).statusCode, 403);
    const missingOrigin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { cookie: fresh.cookie, 'x-csrf-token': fresh.csrf }, payload: { email: alice.email, password } });
    assert.equal(missingOrigin.statusCode, 403);
    assert.equal((await request('POST', '/auth/login', fresh, { email: alice.email, password }, { 'content-type': 'text/plain' })).statusCode, 415);
    const badJson = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: '{' });
    assert.equal(badJson.statusCode, 400);
    const limits = [];
    for (let i = 0; i < 22; i++) limits.push(await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: '127.9.0.1', headers: { origin: 'https://evil.example' }, payload: { email: alice.email, password } }));
    const limited = limits.find(r => r.statusCode === 429);
    assert.ok(limited, '认证限流应生效'); assert.ok(Number(limited.headers['retry-after']) > 0); assert.ok(schemaValidator('Error')(limited.json()), limited.body);
  });
  await t.test('游标签名绑定用户和查询；新连接和新app读到持久数据', async () => {
    for (let i = 0; i < 2; i++) assert.equal((await request('POST', '/restaurants', alice, { name: `分页餐厅${i}`, primary_locale: 'en' }, { 'idempotency-key': `pagination-2026-000${i}` })).statusCode, 201);
    const first = await request('GET', '/restaurants?limit=1', alice);
    assert.equal(first.statusCode, 200); assert.equal(first.json().has_more, true);
    const cursor = encodeURIComponent(first.json().next_cursor);
    const second = await request('GET', `/restaurants?limit=1&cursor=${cursor}`, alice);
    assert.equal(second.statusCode, 200); assert.notEqual(second.json().items[0].id, first.json().items[0].id);
    assert.equal((await request('GET', `/restaurants?limit=1&cursor=${cursor}`, bob)).statusCode, 400);
    assert.equal((await request('GET', `/restaurants?limit=2&cursor=${cursor}`, alice)).statusCode, 400);
    assert.equal((await request('GET', '/restaurants?cursor=forged', alice)).statusCode, 400);
    await app.close(); await pool.end(); pool = await createTestDatabasePool('app', readTestDatabaseScope()); app = createApp({ pool, config }); await app.ready();
    const persisted = await request('GET', `/restaurants/${restaurant.id}`, alice);
    assert.equal(persisted.statusCode, 200); assert.equal(persisted.headers.etag, etag); assert.equal(persisted.json().timezone, 'Europe/London');
    assert.equal((await request('GET', `/restaurants/${restaurant.id}/opening-hours`, alice)).json().intervals.length, 0);
  });
  await t.test('登录轮换旧会话，logout仅撤销当前；logout-all验证密码撤销全部', async () => {
    const original = alice;
    alice = await login(alice);
    assert.notEqual(alice.cookie, original.cookie); assert.notEqual(alice.csrf, original.csrf);
    assert.equal((await request('GET', '/auth/me', original)).statusCode, 401);
    const another = await login(await anonymous(alice.email));
    assert.equal((await request('POST', '/auth/logout', another)).statusCode, 204);
    assert.equal((await request('GET', '/auth/me', another)).statusCode, 401);
    assert.equal((await request('GET', '/auth/me', alice)).statusCode, 200);
    const secondDevice = await login(await anonymous(alice.email));
    assert.equal((await request('POST', '/auth/logout-all', alice, { current_password: '错误密码' })).statusCode, 401);
    assert.equal((await request('POST', '/auth/logout-all', alice, { current_password: password })).statusCode, 204);
    assert.equal((await request('GET', '/auth/me', secondDevice)).statusCode, 401); assert.equal((await request('GET', '/auth/me', alice)).statusCode, 401);
    alice = await login(await anonymous(alice.email));
  });
  await t.test('reset原子改密与全session撤销，一次性消费，不替未验证邮箱验证', async () => {
    const secondDevice = await login(await anonymous(alice.email));
    const token = await action(alice.email, 'reset_password');
    assert.equal((await request('GET', '/auth/me', alice)).statusCode, 200);
    assert.equal((await request('POST', '/auth/password-reset', undefined, { token, new_password: newPassword })).statusCode, 204);
    assert.equal((await request('POST', '/auth/password-reset', undefined, { token, new_password: password })).statusCode, 410);
    assert.equal((await request('GET', '/auth/me', alice)).statusCode, 401); assert.equal((await request('GET', '/auth/me', secondDevice)).statusCode, 401);
    const fresh = await anonymous(alice.email);
    assert.equal((await request('POST', '/auth/login', fresh, { email: alice.email, password })).statusCode, 401);
    alice = await login({ ...fresh, password: newPassword });
    pending = await register('still.pending@restaurant.example');
    assert.equal((await request('POST', '/auth/password-reset-requests', pending, { email: pending.email })).statusCode, 202);
    const pendingToken = await action(pending.email, 'reset_password');
    const concurrent = await Promise.all([request('POST', '/auth/password-reset', undefined, { token: pendingToken, new_password: newPassword }), request('POST', '/auth/password-reset', undefined, { token: pendingToken, new_password: newPassword })]);
    assert.deepEqual(concurrent.map(r => r.statusCode).sort(), [204, 410]);
    const check = await owner.query('SELECT email_verified_at,status FROM users WHERE email_normalized=$1', [pending.email]);
    assert.equal(check.rows[0].email_verified_at, null); assert.equal(check.rows[0].status, 'pending_verification');
    assert.equal((await request('POST', '/auth/login', pending, { email: pending.email, password: newPassword })).statusCode, 403);
  });
  await t.test('过期session、过期/撤销token及封禁用户不可用', async () => {
    const token = await action(pending.email, 'verify_email');
    await owner.query("UPDATE auth_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [digest(config, token, 'verify_email')]);
    assert.equal((await request('POST', '/auth/verify-email', undefined, { token })).statusCode, 410);
    assert.equal((await request('POST', '/auth/verify-email', undefined, { token: 'x'.repeat(43) })).statusCode, 410);
    await owner.query('UPDATE auth_tokens SET revoked_at=now() WHERE token_hash=$1', [digest(config, verifyToken, 'verify_email')]);
    assert.equal((await request('POST', '/auth/verify-email', undefined, { token: verifyToken })).statusCode, 410);
    const bobHash = digest(config, decodeURIComponent(bob.cookie.split('=')[1]!), 'session');
    await owner.query("UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_secret_hash=$1", [bobHash]);
    assert.equal((await request('GET', '/auth/me', bob)).statusCode, 401);
    await owner.query("UPDATE users SET status='suspended' WHERE email_normalized=$1", [alice.email.toLowerCase()]);
    assert.equal((await request('GET', '/auth/me', alice)).statusCode, 401);
    const fresh = await anonymous(alice.email, newPassword);
    assert.equal((await request('POST', '/auth/login', fresh, { email: alice.email, password: '错误密码' })).statusCode, 401);
    const blocked = await request('POST', '/auth/login', fresh, { email: alice.email, password: newPassword });
    assert.equal(blocked.statusCode, 403); assert.equal(blocked.json().code, 'ACCOUNT_UNAVAILABLE');
    await owner.query("UPDATE users SET status='active' WHERE email_normalized=$1", [alice.email.toLowerCase()]);
  });
  await t.test('审计落库失败时建店与资料更新完整回滚', async () => {
    alice = await login(await anonymous(alice.email, newPassword));
    const before = (await request('GET', `/restaurants/${restaurant.id}`, alice)).json();
    await owner.query('REVOKE INSERT ON audit_logs FROM restaurant_test_app');
    try {
      const created = await request('POST', '/restaurants', alice, { name: '不得落库', primary_locale: 'en' }, { 'idempotency-key': 'rollback-store-2026-0001' });
      assert.equal(created.statusCode, 503);
      assert.equal((await owner.query("SELECT count(*)::int AS n FROM restaurants WHERE create_idempotency_key='rollback-store-2026-0001'")).rows[0].n, 0);
      const patched = await request('PATCH', `/restaurants/${restaurant.id}`, alice, { name: '不得覆盖' }, { 'if-match': etag });
      assert.equal(patched.statusCode, 503);
      const current = (await request('GET', `/restaurants/${restaurant.id}`, alice)).json();
      assert.equal(current.name, before.name); assert.equal(current.revision, before.revision);
    } finally { await owner.query('GRANT INSERT ON audit_logs TO restaurant_test_app'); }
  });
  await t.test('outbox租约超时不盲重发，到期清密文，app角色不能DDL或修改审计/初始digest', async () => {
    const task = (await owner.query("SELECT id FROM email_outbox WHERE recipient_email_normalized=$1 AND template_key='verify_email'", [pending.email])).rows[0];
    await owner.query("UPDATE email_outbox SET status='sending',attempt_count=1,lease_token='测试租约',lease_expires_at=now()-interval '1 second' WHERE id=$1", [task.id]);
    assert.equal(await runMailBatch(pool, config), 'disabled');
    const failed = (await owner.query('SELECT status,last_error_code FROM email_outbox WHERE id=$1', [task.id])).rows[0];
    assert.equal(failed.status, 'failed'); assert.equal(failed.last_error_code, 'DELIVERY_UNKNOWN');
    await owner.query("UPDATE email_outbox SET sensitive_payload_expires_at=now()-interval '1 second' WHERE id=$1", [task.id]);
    await runMailBatch(pool, config);
    assert.equal((await owner.query('SELECT sensitive_payload_ciphertext FROM email_outbox WHERE id=$1', [task.id])).rows[0].sensitive_payload_ciphertext, null);
    await assert.rejects(pool.query('CREATE TABLE public.must_not_create(id integer)'), { code: '42501' });
    await assert.rejects(pool.query("UPDATE restaurants SET create_request_fingerprint='tampered' WHERE id=$1", [restaurant.id]), { code: '42501' });
    await assert.rejects(pool.query("UPDATE users SET platform_role='admin' WHERE email_normalized=$1", [alice.email.toLowerCase()]), { code: '42501' });
    await assert.rejects(pool.query("DELETE FROM audit_logs WHERE entity_id=$1", [restaurant.id]), { code: '42501' });
  });
  await t.test('数据库真实不可用返回503，不内存兜底', async () => {
    await pool.end();
    const result = await request('GET', '/auth/registration-policy');
    assert.equal(result.statusCode, 503); assert.ok(!result.body.includes('SELECT'));
    pool = await createTestDatabasePool('app', readTestDatabaseScope());
  });
  assert.equal(Object.keys(contract.paths).length, 14);
});
