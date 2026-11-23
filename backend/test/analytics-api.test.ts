import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import type { Pool } from 'pg';
import { createApp } from '../src/app.js';
import Fastify from 'fastify';
import cookiePlugin from '@fastify/cookie';
import { registerAnalytics } from '../src/analytics.js';
import { recordAnalyticsEvent, type AnalyticsContext, type AnalyticsEventType } from '../src/analytics-access.js';
import { loadConfig, type Config } from '../src/config.js';
import { assertAppDatabase, id } from '../src/db.js';
import { migrate } from '../scripts/migrate.js';
import { insertGeneratedWebsiteFixture } from './website-fixtures.js';
import { FLOW_COOKIE, SESSION_COOKIE } from '../src/security.js';
import { newPublicReference } from '../src/reservation-access.js';

let app: FastifyInstance, pool: Pool, owner: Pool, config: Config, ready = false;
let sequence = 0;
const password = '统计夹具-Valid-Password-2026!';
const tables = 'ai_calendar_credit_grants,website_content_actions,website_version_sources,billing_subscriptions,billing_offer_grants,ai_quota_ledger,ai_quota_periods,ai_model_calls,billing_accounts,analytics_events,analytics_daily,reservations,reservation_events,reservation_access_tokens,website_model_calls,menu_jobs,menu_drafts,website_publish_actions,website_publications,website_jobs,website_versions,website_agents,asset_upload_intents,asset_references,assets,audit_logs,email_outbox,opening_hours,restaurant_members,auth_tokens,auth_sessions,auth_identities,restaurants,users';
const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex');
interface Actor { email: string; cookie: string; csrf: string }
interface Shop { rid: string; context: AnalyticsContext }
const zeroStatuses = { pending: 0, confirmed: 0, declined: 0, cancelled: 0 };
const zeroCounts = { requests: 0, party_size: 0, statuses: zeroStatuses };
const zeroTraffic = { page_views: 0, reservation_clicks: 0, reservation_form_views: 0 };

import { createTestDatabasePools, readTestDatabaseScope } from './database-scope.js';
function analyticsApp(appConfig: Config): FastifyInstance {
  const instance = createApp({ pool, config: appConfig });
  // Main app owns route registration. app.ready() completes its plugin initialization.
  return instance;
}
before(async () => {
  const scope = readTestDatabaseScope();
  const { databaseUrl, migrationDatabaseUrl } = scope;
  config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, MIGRATION_DATABASE_URL: migrationDatabaseUrl,
    APP_ORIGIN: 'https://localhost:5173', EMAIL_MODE: 'disabled', STORAGE_MODE: 'local',
    STORAGE_LOCAL_ROOT: '/tmp/restaurant-analytics-api-test-assets', SITE_PUBLIC_ORIGIN: 'http://127.0.0.1:4010',
    SITE_PORT: '4010', TOKEN_PEPPER: 'analytics-api-fixture-pepper-'.repeat(3),
    CURSOR_SECRET: 'analytics-api-fixture-cursor-'.repeat(3), OUTBOX_ENCRYPTION_KEY: 'c3'.repeat(32) });
  ({ owner, pool } = await createTestDatabasePools(scope));
  await migrate(owner, 'restaurant_test_app');
  await assertAppDatabase(pool);
  const schema = (await owner.query(`SELECT to_regclass('public.analytics_events') AS events,
    to_regclass('public.analytics_daily') AS daily`)).rows[0];
  assert.ok(schema.events && schema.daily, '等待主线程接入 009 迁移，不在专项测试绕过迁移');
  // 只清理已验证地址、库名及角色的独立测试数据库，不读取或改写开发用户。
  await owner.query(`TRUNCATE ${tables}`);
  ready = true;
  app = analyticsApp(config);
  await app.ready();
});
after(async () => {
  try {
    if (app) await app.close();
    if (ready) await owner.query(`TRUNCATE ${tables}`);
  } finally { await Promise.all([pool?.end(), owner?.end()]); }
});
function cookie(response: { headers: Record<string, unknown> }, name: string): string {
  const values = response.headers['set-cookie'];
  const found = (Array.isArray(values) ? values : [values]).find(value => typeof value === 'string' && value.startsWith(`${name}=`));
  assert.equal(typeof found, 'string');
  return (found as string).split(';')[0]!;
}
async function request(method: HTTPMethods, path: string, actorValue?: Actor, payload?: Record<string, unknown>,
  extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (actorValue) { headers.cookie = actorValue.cookie; headers['x-csrf-token'] = actorValue.csrf; }
  if (method !== 'GET') headers.origin ??= config.appOrigin;
  if (payload !== undefined) headers['content-type'] ??= 'application/json';
  return app.inject({ method, url: `/api/v1${path}`, headers, ...(payload === undefined ? {} : { payload }),
    remoteAddress: `127.7.${Math.floor(++sequence / 250)}.${sequence % 250 + 1}` });
}
async function actor(): Promise<Actor> {
  const email = `analytics-api-${randomUUID()}@example.com`;
  const flow = await request('GET', '/auth/csrf', undefined, undefined, { origin: config.appOrigin });
  assert.equal(flow.statusCode, 200, flow.body);
  const anonymous = { email, cookie: cookie(flow, FLOW_COOKIE), csrf: flow.json().csrf_token as string };
  const registered = await request('POST', '/auth/register', anonymous,
    { email, password, locale: 'en', terms_version: 'terms-v1', accepted_terms: true });
  assert.equal(registered.statusCode, 202, registered.body);
  const row = (await owner.query(`SELECT id,sensitive_payload_ciphertext FROM email_outbox
    WHERE recipient_email_normalized=$1 AND template_key='verify_email' AND sensitive_payload_ciphertext IS NOT NULL`, [email])).rows[0];
  assert.ok(row, '真实注册应写入测试邮箱验证 outbox，不调用 SMTP');
  const [version, iv, tag, ciphertext] = row.sensitive_payload_ciphertext.split('.');
  assert.equal(version, 'v1');
  const decoder = createDecipheriv('aes-256-gcm', Buffer.from(config.outboxEncryptionKey, 'hex'), Buffer.from(iv, 'base64url'));
  decoder.setAAD(Buffer.from(row.id)); decoder.setAuthTag(Buffer.from(tag, 'base64url'));
  const token = JSON.parse(Buffer.concat([decoder.update(Buffer.from(ciphertext, 'base64url')), decoder.final()]).toString('utf8')).token;
  assert.equal((await request('POST', '/auth/verify-email', undefined, { token })).statusCode, 204);
  const login = await request('POST', '/auth/login', anonymous, { email, password });
  assert.equal(login.statusCode, 200, login.body);
  return { email, cookie: cookie(login, SESSION_COOKIE), csrf: login.json().csrf_token as string };
}
async function shop(operator: Actor, timezone: string | null = 'America/New_York'): Promise<Shop> {
  const created = await request('POST', '/restaurants', operator, { name: '统计测试餐厅', primary_locale: 'en' },
    { 'idempotency-key': id('create') });
  assert.equal(created.statusCode, 201, created.body);
  const rid = created.json().id as string, versionId = id('wsv');
  const slug = `analytics-api-${fingerprint(rid).slice(0, 20)}`;
  await owner.query('UPDATE restaurants SET timezone=$2,reservation_enabled=true WHERE id=$1', [rid, timezone]);
  await insertGeneratedWebsiteFixture(owner, rid, 1, undefined, { versionId });
  await owner.query(`INSERT INTO website_publications(restaurant_id,revision,published_version_id,slug,deployment_mode)
    VALUES($1,1,$2,$3,'local')`, [rid, versionId, slug]);
  return { rid, context: { restaurant_id: rid, version_id: versionId, publication_revision: 1, slug,
    timezone: timezone ?? 'UTC', timezone_fallback: timezone === null, namespace: 'local_test' } };
}
async function seedReservation(fixture: Shop, input: {
  createdAt: string; date: string; timezone?: string; time?: string; startAt?: string;
  partySize?: number; source?: 'website' | 'merchant_manual';
}): Promise<string> {
  const reservationId = id('rsv'), timezone = input.timezone ?? fixture.context.timezone;
  const key = id('idem');
  // 仅插入隔离夹具的初始 pending 事实，状态转换走真实商家 API，绝不关闭数据库守卫。
  await owner.query(`INSERT INTO reservations(id,restaurant_id,public_reference,source,website_version_id,
    guest_name,guest_email,guest_email_normalized,guest_phone,party_size,requested_local_date,requested_local_time,
    timezone_snapshot,requested_start_at,guest_note,internal_note,privacy_notice_version,privacy_notice_shown_at,
    idempotency_key,initial_request_fingerprint,status,revision,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'统计私密姓名','analytics-private@example.com','analytics-private@example.com','+1 212 555 0199',
      $6,$7::date,$8::time,$9::text,COALESCE($10::timestamptz,($7::date+$8::time) AT TIME ZONE $9::text),
      '统计私密顾客备注','统计私密内部备注','privacy-v1',$11::timestamptz,$12,$13,'pending',1,$11::timestamptz,$11::timestamptz)`,
  [reservationId, fixture.rid, newPublicReference(),
    input.source ?? 'website', input.source === 'merchant_manual' ? null : fixture.context.version_id,
    input.partySize ?? 2, input.date, input.time ?? '18:00', timezone, input.startAt ?? null,
    input.createdAt, key, fingerprint(key)]);
  return reservationId;
}
async function decision(operator: Actor, rid: string, reservationId: string, action: 'confirm' | 'decline'): Promise<void> {
  const response = await request('POST', `/restaurants/${rid}/reservations/${reservationId}/decision`, operator,
    { decision: action, expected_revision: 1, ...(action === 'decline' ? { reason: '夹具拒绝原因' } : {}) },
    { 'idempotency-key': id('decide') });
  assert.equal(response.statusCode, 200, response.body);
}
async function cancel(operator: Actor, rid: string, reservationId: string, revision: number): Promise<void> {
  const response = await request('POST', `/restaurants/${rid}/reservations/${reservationId}/cancel`, operator,
    { expected_revision: revision, reason: '夹具取消原因' }, { 'idempotency-key': id('cancel') });
  assert.equal(response.statusCode, 200, response.body);
}
async function record(fixture: Shop, label: string, eventType: AnalyticsEventType = 'page_view',
  at = '2024-06-01T16:00:00.000Z', context = fixture.context): Promise<void> {
  assert.equal(await recordAnalyticsEvent(pool, context, eventType, fingerprint(`${fixture.rid}:${label}`), new Date(at)), true);
}
async function report(operator: Actor, rid: string, query = 'from=2024-06-01&to=2024-06-30') {
  const response = await request('GET', `/restaurants/${rid}/analytics${query ? `?${query}` : ''}`, operator);
  assert.equal(response.statusCode, 200, response.body);
  return response;
}
function expectedDefault(generatedAt: string, timezone: string): { from: string; to: string } {
  const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(generatedAt));
  const value = (kind: string) => parts.find(part => part.type === kind)!.value;
  const to = `${value('year')}-${value('month')}-${value('day')}`;
  return { from: new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10), to };
}
function assertPrivate(body: string): void {
  for (const value of ['统计私密姓名', 'analytics-private@example.com', '+1 212 555 0199',
    '统计私密顾客备注', '统计私密内部备注', '夹具拒绝原因', '夹具取消原因',
    'guest_name', 'guest_email', 'guest_phone', 'guest_note', 'internal_note', 'manage_token',
    'dedupe_key', 'public_reference', 'conversion_rate']) assert.ok(!body.includes(value), value);
}

test('未登录401、跨owner和不存在404、自身成员撤销403，不泄露聚合数据', async () => {
  const operator = await actor(), fixture = await shop(operator), other = await actor();
  await record(fixture, '权限夹具');
  assert.equal((await request('GET', `/restaurants/${fixture.rid}/analytics`)).statusCode, 401);
  for (const namespace of ['local_test', 'production']) {
    const response = await request('GET', `/restaurants/${fixture.rid}/analytics?namespace=${namespace}`, other);
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(response.json().traffic, undefined);
  }
  assert.equal((await request('GET', `/restaurants/${id('rst')}/analytics`, operator)).statusCode, 404);
  await owner.query(`UPDATE restaurant_members SET status='revoked' WHERE restaurant_id=$1
    AND user_id=(SELECT id FROM users WHERE email=$2)`, [fixture.rid, operator.email]);
  const denied = await request('GET', `/restaurants/${fixture.rid}/analytics`, operator);
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json().reservations, undefined);
});

test('严格日历、日期必须成对、含首尾最多366天、命名空间枚举和未知查询字段', async () => {
  const operator = await actor(), fixture = await shop(operator);
  const invalid = [
    'from=2024-02-30&to=2024-03-01', 'from=2023-02-29&to=2023-03-01',
    'from=2024-13-01&to=2024-13-02', 'from=2024-06-31&to=2024-07-01',
    'from=0000-01-01&to=0000-01-02', 'from=2024-1-01&to=2024-01-02',
    'from=2024-06-02&to=2024-06-01', 'from=2024-01-01&to=2025-01-01',
    'from=&to=', 'from=2024-06-01', 'to=2024-06-01', 'namespace=staging', 'namespace=',
    'from=2024-06-01&from=2024-06-02&to=2024-06-03', 'namespace=local_test&namespace=production',
    'from=2024-06-01T00%3A00%3A00Z&to=2024-06-02',
    `from=${encodeURIComponent("2024-06-01'; SELECT pg_sleep(1);--")}&to=2024-06-02`,
    'limit=10', 'status=confirmed', 'timezone=UTC', 'guest_email=private',
  ];
  for (const query of invalid) {
    const response = await request('GET', `/restaurants/${fixture.rid}/analytics?${query}`, operator);
    assert.ok([400, 422].includes(response.statusCode), `${query}: ${response.statusCode} ${response.body}`);
    assert.equal(response.json().traffic, undefined);
  }
  for (const query of ['from=2024-01-01&to=2024-12-31', 'from=2024-02-29&to=2024-02-29',
    'from=0001-01-01&to=0001-01-02', 'from=9999-12-31&to=9999-12-31']) await report(operator, fixture.rid, query);
});

test('空数据是真实零，UV及订阅未知必须null，默认30天由数据库当前时区确定', async () => {
  const operator = await actor(), fixture = await shop(operator, null);
  const response = await report(operator, fixture.rid, ''), result = response.json();
  assert.deepEqual(Object.keys(result).sort(), ['restaurant_id', 'range', 'namespace', 'metric_version', 'generated_at',
    'current_timezone', 'timezone_fallback', 'traffic', 'reservations', 'subscriptions', 'visitors'].sort());
  assert.equal(result.restaurant_id, fixture.rid); assert.equal(result.metric_version, 'v1');
  assert.equal(result.namespace, 'local_test'); assert.equal(result.current_timezone, 'UTC');
  assert.equal(result.timezone_fallback, true);
  assert.equal(new Date(result.generated_at).toISOString(), result.generated_at);
  assert.deepEqual(result.range, expectedDefault(result.generated_at, 'UTC'));
  assert.deepEqual(result.traffic.days, []); assert.deepEqual(result.traffic.totals, zeroTraffic);
  assert.deepEqual(result.traffic.semantics, {
    page_views: 'successful document requests, not people',
    reservation_clicks: 'platform entry redirect opened; not every button click',
    reservation_form_views: 'successful reservation form GET',
  });
  assert.equal(result.reservations.scope, 'all_restaurant_records');
  assert.equal(result.reservations.status_semantics, 'current_status_at_query_time');
  assert.deepEqual(result.reservations.created, { days: [], totals: zeroCounts });
  assert.deepEqual(result.reservations.scheduled, { days: [], totals: zeroCounts });
  assert.deepEqual(result.subscriptions, { available: false, active_count: null, reason: 'SUBSCRIPTIONS_NOT_IMPLEMENTED' });
  assert.deepEqual(result.visitors, { available: false, unique_visitors: null, reason: 'UV_NOT_MEASURED' });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assertPrivate(response.body);
  for (const timezone of ['UTC', 'America/New_York', 'Pacific/Kiritimati']) {
    await owner.query('UPDATE restaurants SET timezone=$2 WHERE id=$1', [fixture.rid, timezone]);
    const current = (await report(operator, fixture.rid, '')).json();
    assert.equal(current.current_timezone, timezone); assert.equal(current.timezone_fallback, false);
    assert.deepEqual(current.range, expectedDefault(current.generated_at, timezone));
  }
});

test('只开放聚合GET，不提供原始事件列表或HTTP重算写入', async () => {
  const operator = await actor(), fixture = await shop(operator);
  assert.equal((await request('GET', `/restaurants/${fixture.rid}/analytics/events`, operator)).statusCode, 404);
  assert.equal((await request('POST', `/restaurants/${fixture.rid}/analytics`, operator, {})).statusCode, 404);
  assert.equal((await request('POST', `/restaurants/${fixture.rid}/analytics/rebuild`, operator, {})).statusCode, 404);
});

test('创建日与预约日独立含首尾筛选，website与manual均计入但其它餐厅不计入', async () => {
  const operator = await actor(), fixture = await shop(operator), other = await shop(operator);
  await seedReservation(fixture, { createdAt: '2024-06-01T03:30:00Z', date: '2024-06-03', partySize: 2 });
  const manual = await seedReservation(fixture, { createdAt: '2024-06-01T16:00:00Z', date: '2024-06-04', partySize: 3, source: 'merchant_manual' });
  const declined = await seedReservation(fixture, { createdAt: '2024-06-04T16:00:00Z', date: '2024-06-05', partySize: 4 });
  await decision(operator, fixture.rid, manual, 'confirm');
  await decision(operator, fixture.rid, declined, 'decline');
  await seedReservation(other, { createdAt: '2024-06-01T16:00:00Z', date: '2024-06-04', partySize: 20 });
  const response = await report(operator, fixture.rid, 'from=2024-06-01&to=2024-06-04'), result = response.json();
  assert.deepEqual(result.reservations.created.days, [
    { date: '2024-06-01', timezone: 'America/New_York', requests: 1, party_size: 3, statuses: { ...zeroStatuses, confirmed: 1 } },
    { date: '2024-06-04', timezone: 'America/New_York', requests: 1, party_size: 4, statuses: { ...zeroStatuses, declined: 1 } },
  ]);
  assert.deepEqual(result.reservations.created.totals, { requests: 2, party_size: 7, statuses: { ...zeroStatuses, confirmed: 1, declined: 1 } });
  assert.deepEqual(result.reservations.scheduled.days, [
    { date: '2024-06-03', timezone: 'America/New_York', requests: 1, party_size: 2, statuses: { ...zeroStatuses, pending: 1 } },
    { date: '2024-06-04', timezone: 'America/New_York', requests: 1, party_size: 3, statuses: { ...zeroStatuses, confirmed: 1 } },
  ]);
  assert.deepEqual(result.reservations.scheduled.totals, { requests: 2, party_size: 5, statuses: { ...zeroStatuses, pending: 1, confirmed: 1 } });
  const midnight = (await report(operator, fixture.rid, 'from=2024-05-31&to=2024-05-31')).json();
  assert.equal(midnight.reservations.created.totals.requests, 1);
  assert.equal(midnight.reservations.scheduled.totals.requests, 0);
  assertPrivate(response.body);
});

test('当前状态随确认与取消实时变化，事件多次追加不能放大请求/人数', async () => {
  const operator = await actor(), fixture = await shop(operator);
  const reservationId = await seedReservation(fixture, { createdAt: '2024-06-01T16:00:00Z', date: '2024-06-02', partySize: 5 });
  const declined = await seedReservation(fixture, { createdAt: '2024-06-01T17:00:00Z', date: '2024-06-02', partySize: 3 });
  for (const stage of ['pending', 'confirmed', 'cancelled'] as const) {
    if (stage === 'confirmed') await decision(operator, fixture.rid, reservationId, 'confirm');
    if (stage === 'cancelled') { await cancel(operator, fixture.rid, reservationId, 2); await decision(operator, fixture.rid, declined, 'decline'); }
    const response = await report(operator, fixture.rid), result = response.json();
    const statuses = stage === 'cancelled' ? { ...zeroStatuses, cancelled: 1, declined: 1 } :
      { ...zeroStatuses, pending: stage === 'pending' ? 2 : 1, confirmed: stage === 'confirmed' ? 1 : 0 };
    for (const kind of ['created', 'scheduled']) {
      assert.deepEqual(result.reservations[kind].totals, { requests: 2, party_size: 8, statuses });
      assert.equal(result.reservations[kind].days.length, 1);
      assert.deepEqual(result.reservations[kind].days[0].statuses, statuses);
    }
    assertPrivate(response.body);
  }
  assert.equal((await owner.query('SELECT count(*) AS n FROM reservation_events WHERE reservation_id=$1', [reservationId])).rows[0].n, '2');
});

test('纽约春秋DST与多时区同日分组冻结，当前时区改变不重写历史', async () => {
  const operator = await actor(), fixture = await shop(operator);
  const cases = [
    { createdAt: '2024-03-10T04:59:59Z', date: '2024-03-11', partySize: 1 },
    { createdAt: '2024-03-10T06:59:00Z', date: '2024-03-11', partySize: 2 },
    { createdAt: '2024-03-10T07:00:00Z', date: '2024-03-11', partySize: 3 },
    { createdAt: '2024-03-10T00:30:00Z', date: '2024-03-11', partySize: 4, timezone: 'Asia/Tokyo' },
    { createdAt: '2024-11-03T05:30:00Z', date: '2024-11-03', time: '01:30', startAt: '2024-11-03T05:30:00Z', partySize: 5 },
    { createdAt: '2024-11-03T06:30:00Z', date: '2024-11-03', time: '01:30', startAt: '2024-11-03T06:30:00Z', partySize: 6 },
  ];
  for (const input of cases) await seedReservation(fixture, input);
  await record(fixture, '春季午夜之前', 'page_view', cases[0]!.createdAt);
  await record(fixture, '春季跳时之后', 'page_view', cases[2]!.createdAt);
  const query = 'from=2024-03-09&to=2024-11-03';
  const previous = (await report(operator, fixture.rid, query)).json();
  assert.deepEqual(previous.reservations.created.days.map((day: { date: string; timezone: string; requests: number; party_size: number }) =>
    [day.date, day.timezone, day.requests, day.party_size]), [
    ['2024-03-09', 'America/New_York', 1, 1], ['2024-03-10', 'America/New_York', 2, 5],
    ['2024-03-10', 'Asia/Tokyo', 1, 4], ['2024-11-03', 'America/New_York', 2, 11],
  ]);
  assert.deepEqual(previous.reservations.scheduled.days.map((day: { date: string; timezone: string; requests: number }) =>
    [day.date, day.timezone, day.requests]), [
    ['2024-03-11', 'America/New_York', 3], ['2024-03-11', 'Asia/Tokyo', 1], ['2024-11-03', 'America/New_York', 2],
  ]);
  await owner.query("UPDATE restaurants SET timezone='Asia/Tokyo' WHERE id=$1", [fixture.rid]);
  const current = (await report(operator, fixture.rid, query)).json();
  assert.equal(current.current_timezone, 'Asia/Tokyo'); assert.equal(current.timezone_fallback, false);
  assert.deepEqual(current.reservations, previous.reservations);
  assert.deepEqual(current.traffic, previous.traffic);
});

test('流量local_test和production分开，跨环境owner可读；订位不随流量namespace过滤', async () => {
  const operator = await actor(), fixture = await shop(operator);
  await seedReservation(fixture, { createdAt: '2024-06-01T16:00:00Z', date: '2024-06-02', partySize: 7, source: 'merchant_manual' });
  await record(fixture, 'local-view-1'); await record(fixture, 'local-view-2');
  await record(fixture, 'local-click', 'reservation_click'); await record(fixture, 'local-form', 'reservation_form_view');
  const productionContext = { ...fixture.context, namespace: 'production' as const };
  await record(fixture, 'production-view', 'page_view', undefined, productionContext);
  const local = (await report(operator, fixture.rid)).json();
  const production = (await report(operator, fixture.rid, 'from=2024-06-01&to=2024-06-30&namespace=production')).json();
  assert.equal(local.namespace, 'local_test'); assert.equal(production.namespace, 'production');
  assert.deepEqual(local.traffic.totals, { page_views: 2, reservation_clicks: 1, reservation_form_views: 1 });
  assert.deepEqual(production.traffic.totals, { ...zeroTraffic, page_views: 1 });
  assert.deepEqual(production.reservations, local.reservations);
  assert.equal(production.reservations.created.totals.party_size, 7);
  // 独立实例仅测试统计路由的默认命名空间；不绕过主应用的生产S3门禁，不声称生产环境已启动。
  const productionApp = Fastify({ logger: false });
  await productionApp.register(cookiePlugin);
  registerAnalytics(productionApp, pool, { ...config, nodeEnv: 'production' });
  try {
    await productionApp.ready();
    const read = async (namespace = '') => productionApp.inject({ method: 'GET',
      url: `/api/v1/restaurants/${fixture.rid}/analytics?from=2024-06-01&to=2024-06-30${namespace ? `&namespace=${namespace}` : ''}`,
      headers: { cookie: operator.cookie } });
    const defaultProduction = await read(), explicitLocal = await read('local_test');
    assert.equal(defaultProduction.statusCode, 200, defaultProduction.body);
    assert.equal(explicitLocal.statusCode, 200, explicitLocal.body);
    assert.equal(defaultProduction.json().namespace, 'production');
    assert.deepEqual(defaultProduction.json().traffic, production.traffic);
    assert.deepEqual(explicitLocal.json().traffic, local.traffic);
  } finally { await productionApp.close(); }
});

test('计数超过int32仍安全，maxsafe可返回但跨日总和溢出明确拒绝', async () => {
  const operator = await actor(), fixture = await shop(operator);
  await record(fixture, 'large'); await record(fixture, 'second-day', 'page_view', '2024-06-02T16:00:00Z');
  await owner.query(`UPDATE analytics_daily SET page_views=3000000000,reservation_clicks=4000000000,
    reservation_form_views=5000000000 WHERE restaurant_id=$1 AND local_date='2024-06-01' AND namespace='local_test'`, [fixture.rid]);
  const large = (await report(operator, fixture.rid, 'from=2024-06-01&to=2024-06-01')).json();
  assert.deepEqual(large.traffic.totals, { page_views: 3000000000, reservation_clicks: 4000000000, reservation_form_views: 5000000000 });
  assert.ok(Object.values(large.traffic.totals).every(value => Number.isSafeInteger(value)));
  await owner.query(`UPDATE analytics_daily SET page_views=9007199254740991 WHERE restaurant_id=$1
    AND local_date='2024-06-01' AND namespace='local_test'`, [fixture.rid]);
  assert.equal((await report(operator, fixture.rid, 'from=2024-06-01&to=2024-06-01')).json().traffic.totals.page_views, Number.MAX_SAFE_INTEGER);
  const overflow = await request('GET', `/restaurants/${fixture.rid}/analytics?from=2024-06-01&to=2024-06-02`, operator);
  assert.equal(overflow.statusCode, 422, overflow.body);
  assert.equal(overflow.json().code, 'ANALYTICS_COUNT_OVERFLOW');
  assert.equal(overflow.json().traffic, undefined);
  await assert.rejects(owner.query(`UPDATE analytics_daily SET page_views=9007199254740992 WHERE restaurant_id=$1`, [fixture.rid]),
    (error: unknown) => (error as { code?: string }).code === '23514');
});
