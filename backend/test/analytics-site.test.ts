import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest, InjectOptions, LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { loadConfig, type Config } from '../src/config.js';
import { assertAppDatabase, id } from '../src/db.js';
import { migrate } from '../scripts/migrate.js';
import { insertGeneratedWebsiteFixture } from './website-fixtures.js';
import { createSiteApp } from '../src/sites.js';
import { createAssetStore } from '../src/asset-storage.js';
import { tokenHash } from '../src/reservation-access.js';
import { ApiError } from '../src/errors.js';
import { analyticsRequestEligible, issueAnalyticsContext, verifyAnalyticsContext } from '../src/analytics-site.js';
import type { AnalyticsContext, AnalyticsNamespace } from '../src/analytics-access.js';

interface Fixture { restaurantId: string; userId: string; slug: string; versionId: string; context: AnalyticsContext }
interface Metrics { page_views: number; reservation_clicks: number; reservation_form_views: number }
interface EventReply { recorded?: boolean; duplicate_or_stale?: boolean; reason?: string; code?: string }
type SignedContext = AnalyticsContext & { nonce: string; expires_at: number };
type Headers = Record<string, string | undefined>;
type RequestOptions = Omit<InjectOptions, 'headers'> & { headers?: Headers };
type JsonRow = Record<string, unknown>;

let app: FastifyInstance | undefined, pool: Pool, owner: Pool, config: Config, root: string;
let fixture: Fixture, ready = false, address = 0, fixtureReservations = 0;
let beforeSend: ((request: FastifyRequest) => Promise<void>) | undefined;
const completions = new Map<string, () => void>();
const tables = 'ai_calendar_credit_grants,website_content_actions,website_version_sources,billing_subscriptions,billing_offer_grants,ai_quota_ledger,ai_quota_periods,ai_model_calls,billing_accounts,analytics_events,analytics_daily,reservations,reservation_events,reservation_access_tokens,website_model_calls,menu_jobs,menu_drafts,website_publish_actions,website_publications,website_jobs,website_versions,website_agents,asset_upload_intents,asset_references,assets,audit_logs,email_outbox,opening_hours,restaurant_members,auth_tokens,auth_sessions,auth_identities,restaurants,users';
const publicOrigin = 'http://127.0.0.1:4010';
const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15';
const lifetime = 15 * 60 * 1000;
const zero: Metrics = { page_views: 0, reservation_clicks: 0, reservation_form_views: 0 };
const source = { html_body: '<main><restaurant-name/><restaurant-description/><restaurant-reservation/></main>', css: '', summary: '统计测试夹具' };
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const invalidContext = (error: unknown): boolean => error instanceof ApiError && error.status === 403 && error.code === 'ANALYTICS_CONTEXT_INVALID';

import { createTestDatabasePools, readTestDatabaseScope } from './database-scope.js';

async function seed(): Promise<Fixture> {
  const restaurantId = id('rst'), userId = id('usr'), slug = `analytics-site-${hash(restaurantId).slice(0, 16)}`;
  await owner.query(`INSERT INTO users(id,email,email_normalized,display_name,locale,status,email_verified_at,
    terms_version,terms_accepted_at) VALUES($1,$2,$2,'统计测试所有者','en','active',now(),'terms-v1',now())`,
  [userId, `${userId}@example.com`]);
  await owner.query(`INSERT INTO restaurants(id,created_by_user_id,create_idempotency_key,create_request_fingerprint,
    slug,name,description,timezone,currency_code,primary_locale,reservation_enabled,reservation_notice,
    privacy_notice_version,status) VALUES($1,$2,$3,$4,$5,'统计测试餐厅','独立测试夹具','America/New_York','USD','en',true,
    'Requests need restaurant confirmation.','privacy-v1','active')`,
  [restaurantId, userId, id('create'), hash(restaurantId), slug]);
  await owner.query(`INSERT INTO restaurant_members(id,restaurant_id,user_id,role,status)
    VALUES($1,$2,$3,'owner','active')`, [id('mem'), restaurantId, userId]);
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    await owner.query(`INSERT INTO opening_hours(id,restaurant_id,weekday,opens_at_local,closes_at_local,
      closes_day_offset,accepts_requests,sort_order) VALUES($1,$2,$3,'00:00','00:00',1,true,0)`,
    [id('hours'), restaurantId, weekday]);
  }
  const versionId = await version(restaurantId, 1);
  await owner.query(`INSERT INTO website_publications(restaurant_id,revision,published_version_id,slug,deployment_mode)
    VALUES($1,1,$2,$3,'local')`, [restaurantId, versionId, slug]);
  return { restaurantId, userId, slug, versionId, context: { restaurant_id: restaurantId, version_id: versionId,
    publication_revision: 1, slug, timezone: 'America/New_York', timezone_fallback: false, namespace: 'local_test' } };
}

async function version(restaurantId: string, number: number): Promise<string> {
  return (await insertGeneratedWebsiteFixture(owner, restaurantId, number, source)).id;
}

before(async () => {
  const scope = readTestDatabaseScope();
  const { databaseUrl, migrationDatabaseUrl } = scope;
  root = await mkdtemp('/tmp/restaurant-analytics-site-');
  config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, MIGRATION_DATABASE_URL: migrationDatabaseUrl,
    APP_ORIGIN: 'https://localhost:5173', EMAIL_MODE: 'disabled', STORAGE_MODE: 'local', STORAGE_LOCAL_ROOT: root,
    SITE_PUBLIC_ORIGIN: publicOrigin, SITE_PORT: '4010', TOKEN_PEPPER: 'analytics-site-test-pepper-'.repeat(3),
    CURSOR_SECRET: 'analytics-site-test-cursor-'.repeat(3), OUTBOX_ENCRYPTION_KEY: 'c4'.repeat(32) });
  ({ owner, pool } = await createTestDatabasePools(scope));
  await migrate(owner, 'restaurant_test_app');
  await assertAppDatabase(pool);
  for (const [db, role] of [[pool, 'restaurant_test_app'], [owner, 'restaurant_test_owner']] as const) {
    const row = (await db.query<{ role: string; database: string }>(
      'SELECT current_user AS role,current_database() AS database')).rows[0]!;
    assert.deepEqual(row, { role, database: 'restaurant_test' });
  }
  ready = true;
  await owner.query(`TRUNCATE ${tables}`);
});

beforeEach(async () => {
  if (!ready) return;
  if (app) { await app.close(); app = undefined; }
  assert.equal(completions.size, 0, '上一测试的统计钩子必须已完成');
  beforeSend = undefined; fixtureReservations = 0;
  await owner.query(`TRUNCATE ${tables}`);
  fixture = await seed();
  app = createSiteApp({ pool, config });
  app.addHook('onSend', async (request, _reply, payload) => {
    if (beforeSend) await beforeSend(request);
    return payload;
  });
  // 排在业务 onResponse 后，避免 inject 返回时真实 PG 写入仍未提交；无需 sleep 或无界轮询。
  app.addHook('onResponse', async request => {
    const marker = request.headers['x-test-completion-id'];
    if (typeof marker === 'string') completions.get(marker)?.();
  });
  await app.ready();
});

afterEach(async () => {
  if (!ready) return;
  beforeSend = undefined;
  assert.equal(completions.size, 0);
  const row = (await owner.query<{ reservations: number; events: number; mail: number; model_calls: number }>(`SELECT
    (SELECT count(*)::int FROM reservations) AS reservations,
    (SELECT count(*)::int FROM reservation_events) AS events,
    (SELECT count(*)::int FROM email_outbox) AS mail,
    (SELECT count(*)::int FROM website_model_calls) AS model_calls`)).rows[0]!;
  assert.deepEqual(row, { reservations: fixtureReservations, events: 0, mail: 0, model_calls: 0 },
    '不提交真实订位，不排队邮件，不调用模型；所有基础夹具仅由 owner SQL 创建');
});

after(async () => {
  try {
    if (app) await app.close();
    if (ready) await owner.query(`TRUNCATE ${tables}`);
  } finally {
    await Promise.all([pool?.end(), owner?.end()]);
    if (root) await rm(root, { recursive: true, force: true });
  }
});

async function request(options: RequestOptions): Promise<LightMyRequestResponse> {
  assert.ok(app);
  const marker = randomUUID();
  // 显式保留 undefined，否则 light-my-request 会补默认 UA，无法覆盖真实无 UA 请求。
  const headers: Headers = { host: '127.0.0.1:4010', origin: publicOrigin, 'user-agent': userAgent, ...options.headers };
  if (headers.origin === undefined) delete headers.origin;
  headers['x-test-completion-id'] = marker;
  const finished = new Promise<void>(resolve => completions.set(marker, resolve));
  address += 1;
  try {
    const response = await app.inject({ ...options, headers,
      remoteAddress: options.remoteAddress ?? `192.0.2.${1 + address % 250}` });
    await finished;
    return response;
  } finally { completions.delete(marker); }
}
function get(suffix = '', headers: Headers = {}, target = fixture): Promise<LightMyRequestResponse> {
  return request({ method: 'GET', url: `/s/${target.slug}${suffix}`, headers });
}
function post(context: string, eventId: string = randomUUID(), options: Partial<RequestOptions> = {}, target = fixture): Promise<LightMyRequestResponse> {
  return request({ method: 'POST', url: `/s/${target.slug}/events`,
    payload: { context, event: 'reservation_click', event_id: eventId }, ...options,
    headers: { 'content-type': 'application/json', ...options.headers } });
}
function signedHeader(response: LightMyRequestResponse): string {
  const token = response.headers['x-site-analytics-context'];
  assert.equal(typeof token, 'string');
  assert.match(token as string, /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
  return token as string;
}
function decode(token: string): SignedContext {
  return JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as SignedContext;
}
async function counts(namespace: AnalyticsNamespace = 'local_test', restaurantId = fixture.restaurantId): Promise<Metrics> {
  const events = (await owner.query<Metrics>(`SELECT count(*) FILTER (WHERE event_type='page_view')::int AS page_views,
    count(*) FILTER (WHERE event_type='reservation_click')::int AS reservation_clicks,
    count(*) FILTER (WHERE event_type='reservation_form_view')::int AS reservation_form_views
    FROM analytics_events WHERE restaurant_id=$1 AND namespace=$2`, [restaurantId, namespace])).rows[0]!;
  const daily = (await owner.query<Metrics>(`SELECT COALESCE(sum(page_views),0)::int AS page_views,
    COALESCE(sum(reservation_clicks),0)::int AS reservation_clicks,
    COALESCE(sum(reservation_form_views),0)::int AS reservation_form_views
    FROM analytics_daily WHERE restaurant_id=$1 AND namespace=$2`, [restaurantId, namespace])).rows[0]!;
  assert.deepEqual(daily, events, '事件与日汇总必须完全一致');
  return events;
}
async function snapshot(): Promise<{ events: JsonRow[]; daily: JsonRow[] }> {
  return {
    events: (await owner.query<{ row: JsonRow }>('SELECT to_jsonb(e) AS row FROM analytics_events e ORDER BY id')).rows.map(row => row.row),
    daily: (await owner.query<{ row: JsonRow }>(`SELECT to_jsonb(d) AS row FROM analytics_daily d
      ORDER BY restaurant_id,namespace,local_date,timezone_snapshot,timezone_fallback`)).rows.map(row => row.row),
  };
}
function rejected(response: LightMyRequestResponse): void {
  assert.ok(response.statusCode >= 400 && response.statusCode < 500, `${response.statusCode}: ${response.body}`);
  assert.equal(response.headers['x-site-analytics-context'], undefined);
}

// 只有数据库所有者创建测试夹具；每个测试独立清空完整关联表，业务采集使用最小权限应用角色。
test('已发布 GET 仅记录一次 page_view，并返回无密钥的绑定签名上下文', async () => {
  const start = Date.now(), response = await get();
  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.body, /class="site-reservation-link"/);
  assert.ok(response.body.includes(`href="/s/${fixture.slug}/go/reserve"`));
  const token = signedHeader(response), context = decode(token), [body, signature] = token.split('.');
  assert.equal(signature, createHmac('sha256', config.tokenPepper).update(`site_analytics_context\0${body}`).digest('hex'));
  const { nonce, expires_at, ...bound } = context;
  assert.deepEqual(bound, fixture.context);
  assert.match(nonce, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.ok(expires_at >= start + lifetime && expires_at <= Date.now() + lifetime);
  assert.deepEqual(verifyAnalyticsContext(token, fixture.slug, config), context);
  for (const secret of [config.tokenPepper, config.cursorSecret, config.outboxEncryptionKey]) {
    assert.ok(!token.includes(secret) && !JSON.stringify(context).includes(secret) && !response.body.includes(secret));
  }
  assert.deepEqual(await counts(), { ...zero, page_views: 1 });
});

test('HEAD、素材 GET 和 token 管理 GET 即便成功也不产生任何统计', async () => {
  for (const suffix of ['', '/reserve', '/go/reserve']) {
    const response = await request({ method: 'HEAD', url: `/s/${fixture.slug}${suffix}` });
    assert.equal(response.statusCode, suffix === '/go/reserve' ? 303 : 200);
    assert.equal(response.body, '');
    assert.equal(response.headers['x-site-analytics-context'], undefined);
  }
  const assetId = id('ast'), bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=', 'base64');
  const checksum = hash(bytes), storageKey = `${fixture.restaurantId}/${assetId}.png`;
  const store = createAssetStore(config);
  try { await store.put(storageKey, bytes, 'image/png'); } finally { store.close(); }
  await owner.query(`INSERT INTO assets(id,restaurant_id,kind,original_filename,mime_type,size_bytes,checksum,source_checksum,
    width_px,height_px,rights_confirmed_at,storage_backend,storage_key,upload_idempotency_key,initial_request_fingerprint)
    VALUES($1,$2,'restaurant_photo','fixture.png','image/png',$3,$4,$4,1,1,now(),'local',$5,$6,$4)`,
  [assetId, fixture.restaurantId, bytes.length, checksum, storageKey, id('upload')]);
  const assetVersion = (await insertGeneratedWebsiteFixture(owner, fixture.restaurantId, 2, source, { assetIds: [assetId] })).id;
  await owner.query('UPDATE website_publications SET published_version_id=$2,revision=revision+1 WHERE restaurant_id=$1',
    [fixture.restaurantId, assetVersion]);
  const asset = await get(`/media/${assetId}?version=${assetVersion}`);
  assert.equal(asset.statusCode, 200, asset.body);
  assert.deepEqual(asset.rawPayload, bytes);
  assert.equal(asset.headers['x-site-analytics-context'], undefined);
  const missingAsset = await get(`/media/${id('ast')}?version=${assetVersion}`);
  assert.equal(missingAsset.statusCode, 404);

  // 仅 SQL 插入合成管理夹具，不走订位创建 API，不创建事件或邮件。
  const reservationId = id('rsv'), manageToken = randomBytes(32).toString('base64url');
  await owner.query(`INSERT INTO reservations(id,restaurant_id,public_reference,source,website_version_id,guest_name,
    guest_email,guest_email_normalized,party_size,requested_local_date,requested_local_time,timezone_snapshot,
    requested_start_at,privacy_notice_version,privacy_notice_shown_at,idempotency_key,initial_request_fingerprint)
    VALUES($1,$2,'FIXTURE01','website',$3,'统计管理夹具','fixture@example.com','fixture@example.com',2,
    '2030-01-02','18:00','America/New_York','2030-01-02T23:00:00Z','privacy-v1',now(),$4,$5)`,
  [reservationId, fixture.restaurantId, fixture.versionId, id('reserve'), hash(reservationId)]);
  fixtureReservations = 1;
  await owner.query(`INSERT INTO reservation_access_tokens(id,restaurant_id,reservation_id,token_hash,expires_at)
    VALUES($1,$2,$3,$4,now()+interval '1 day')`, [id('rtk'), fixture.restaurantId, reservationId, tokenHash(config, manageToken)]);
  const manage = await request({ method: 'GET', url: `/r/${manageToken}` });
  assert.equal(manage.statusCode, 200, manage.body);
  assert.match(manage.body, /Awaiting restaurant confirmation/);
  assert.equal(manage.headers['x-site-analytics-context'], undefined);
  const unknown = await request({ method: 'GET', url: `/r/${randomBytes(32).toString('base64url')}` });
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(await counts(), zero);
});

test('go/reserve 只允许固定真实订位目标，未知查询或重定向参数拒绝且不计数', async () => {
  const response = await get('/go/reserve');
  assert.equal(response.statusCode, 303, response.body);
  assert.equal(response.headers.location, `/s/${fixture.slug}/reserve`);
  signedHeader(response);
  assert.deepEqual(await counts(), { ...zero, reservation_clicks: 1 });
  const before = await snapshot();
  for (const query of ['?next=%2Foutside', '?url=%2F%2Fexample.com', '?redirect=https%3A%2F%2Fexample.com',
    '?restaurant_id=other', '?version_id=other', '?unknown=1']) {
    const bad = await get(`/go/reserve${query}`);
    assert.equal(bad.statusCode, 404);
    assert.equal(bad.headers.location, undefined);
    assert.equal(bad.headers['x-site-analytics-context'], undefined);
  }
  assert.deepEqual(await snapshot(), before);
});

test('首页、跳转及成功订位表单 GET 的三个计数完整，表单不创建申请', async () => {
  assert.equal((await get()).statusCode, 200);
  assert.equal((await get('/go/reserve')).statusCode, 303);
  const form = await get('/reserve');
  assert.equal(form.statusCode, 200, form.body);
  signedHeader(form);
  assert.match(form.body, new RegExp(`action="/s/${fixture.slug}/reserve"`));
  assert.match(form.body, /name="privacy_notice_version" value="privacy-v1"/);
  assert.match(form.body, /name="guest_name"/);
  assert.deepEqual(await counts(), { page_views: 1, reservation_clicks: 1, reservation_form_views: 1 });
  const rows = (await owner.query<{ version_id: string; publication_revision: number; metric_version: string; timezone_snapshot: string;
    timezone_fallback: boolean; consistent: boolean }>(`SELECT version_id,publication_revision,metric_version,timezone_snapshot,
    timezone_fallback,local_date=(occurred_at AT TIME ZONE timezone_snapshot)::date AS consistent FROM analytics_events`)).rows;
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => row.version_id === fixture.versionId && row.publication_revision === 1 && row.metric_version === 'v1'
    && row.timezone_snapshot === 'America/New_York' && !row.timezone_fallback && row.consistent));
});

test('DNT/GPC、机器人或无 UA、预览/后台来源、测试标识、预取和商家 cookie 全部排除', async () => {
  const token = signedHeader(await get()), before = await snapshot();
  const exclusions: Array<{ label: string; headers: Headers }> = [
    { label: 'DNT', headers: { dnt: '1' } }, { label: 'GPC', headers: { 'sec-gpc': '1' } },
    { label: '无 UA', headers: { 'user-agent': undefined } }, { label: '空 UA', headers: { 'user-agent': '' } },
    ...['Googlebot/2.1', 'HeadlessChrome/130.0', 'curl/8.7.1', 'Preview/1.0', 'python-requests/2.0'].map(ua =>
      ({ label: ua, headers: { 'user-agent': ua } })),
    { label: '后台 Origin', headers: { origin: config.appOrigin } },
    { label: '后台 Referer', headers: { referer: `${config.appOrigin}/restaurants/preview` } },
    { label: '无效 Referer', headers: { referer: 'invalid-referer' } },
    { label: '测试请求', headers: { 'x-analytics-test': '1' } },
    { label: 'prefetch', headers: { purpose: 'prefetch' } }, { label: 'prerender', headers: { 'sec-purpose': 'prefetch;prerender' } },
    { label: '商家会话', headers: { cookie: 'theme=light; __Host-restaurant_session=fixture' } },
    { label: '商家鉴权流程', headers: { cookie: '__Host-restaurant_authflow=fixture' } },
  ];
  for (const { label, headers } of exclusions) {
    const eligibleHeaders: FastifyRequest['headers'] = { host: '127.0.0.1:4010', origin: publicOrigin, 'user-agent': userAgent, ...headers };
    assert.equal(analyticsRequestEligible({ method: 'GET', headers: eligibleHeaders }, config), false, label);
    for (const suffix of ['', '/go/reserve', '/reserve']) {
      const response = await get(suffix, headers);
      assert.equal(response.statusCode, suffix === '/go/reserve' ? 303 : 200, label);
      assert.equal(response.headers['x-site-analytics-context'], undefined, label);
    }
    const click = await post(token, randomUUID(), { headers });
    if (headers.origin === config.appOrigin) assert.equal(click.statusCode, 403, label);
    else {
      assert.equal(click.statusCode, 202, `${label}: ${click.body}`);
      assert.equal(click.json<EventReply>().recorded, false, label);
      assert.equal(click.json<EventReply>().reason, 'EXCLUDED_REQUEST', label);
    }
  }
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await counts(), { ...zero, page_views: 1 });
});

test('localhost 正常访问仅进入 local_test，生产签名与本地签名不能跨命名空间', async () => {
  const response = await get('', { host: 'localhost:4010' }), token = signedHeader(response);
  assert.equal(response.statusCode, 200);
  assert.equal(decode(token).namespace, 'local_test');
  assert.equal(analyticsRequestEligible({ method: 'GET', headers: { 'user-agent': userAgent } }, config), true);
  assert.deepEqual(await counts(), { ...zero, page_views: 1 });
  assert.deepEqual(await counts('production'), zero);
  const production: Config = { ...config, nodeEnv: 'production' };
  const productionToken = issueAnalyticsContext({ ...fixture.context, namespace: 'production' }, production);
  assert.throws(() => verifyAnalyticsContext(token, fixture.slug, production), invalidContext);
  assert.throws(() => verifyAnalyticsContext(productionToken, fixture.slug, config), invalidContext);
  rejected(await post(productionToken));
  assert.throws(() => createSiteApp({ pool, config: production }), /不允许生产模式/);
  const health = await request({ method: 'GET', url: '/health/ready' });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json<{ analytics_namespace: string }>().analytics_namespace, 'local_test');
  assert.deepEqual(await counts('production'), zero);
});

test('合法同源三字段 POST 202，重放不双算，去重严格按 nonce 加 UUID', async () => {
  const token = signedHeader(await get()), eventId = randomUUID();
  const first = await post(token, eventId);
  assert.equal(first.statusCode, 202, first.body);
  assert.equal(first.json<EventReply>().recorded, true);
  const before = await snapshot(), replay = await post(token, eventId);
  assert.equal(replay.statusCode, 202, replay.body);
  assert.equal(replay.json<EventReply>().recorded, false);
  assert.deepEqual(await snapshot(), before);
  const repeated = await Promise.all(Array.from({ length: 5 }, (_, index) => post(token, index % 2 ? eventId.toUpperCase() : eventId)));
  assert.ok(repeated.every(response => response.statusCode === 202 && response.json<EventReply>().recorded === false));
  assert.deepEqual(await snapshot(), before);
  assert.equal((await post(token, randomUUID())).json<EventReply>().recorded, true);
  const otherToken = signedHeader(await get());
  assert.notEqual(decode(token).nonce, decode(otherToken).nonce);
  assert.equal((await post(otherToken, eventId)).json<EventReply>().recorded, true);
  const dedupe = hash(`client:${decode(token).nonce}:${eventId}`);
  const rows = (await owner.query<{ dedupe_key: string }>("SELECT dedupe_key FROM analytics_events WHERE event_type='reservation_click'")).rows;
  assert.equal(rows.length, 3);
  assert.ok(rows.some(row => row.dedupe_key === dedupe));
  assert.deepEqual(await counts(), { ...zero, page_views: 2, reservation_clicks: 3 });
});

test('并发首次提交同一个 signed nonce 与 UUID 仅一次 recorded=true', async () => {
  const token = signedHeader(await get()), eventId = randomUUID();
  const results = await Promise.all(Array.from({ length: 6 }, () => post(token, eventId)));
  assert.ok(results.every(response => response.statusCode === 202), results.map(response => response.body).join('\n'));
  assert.equal(results.filter(response => response.json<EventReply>().recorded === true).length, 1);
  assert.equal(results.filter(response => response.json<EventReply>().recorded === false).length, 5);
  assert.deepEqual(await counts(), { ...zero, page_views: 1, reservation_clicks: 1 });
});

test('签名篡改、过期、跨 slug、错误密钥或签名用途拒绝且不写入', async () => {
  const token = signedHeader(await get()), other = await seed(), before = await snapshot();
  const [body, signature] = token.split('.') as [string, string];
  const tamperedBody = Buffer.from(JSON.stringify({ ...decode(token), restaurant_id: other.restaurantId })).toString('base64url');
  const expired = issueAnalyticsContext(fixture.context, config, Date.now() - lifetime - 1);
  const wrongKey = issueAnalyticsContext(fixture.context, { ...config, tokenPepper: 'wrong-test-pepper-'.repeat(4) });
  const wrongPurpose = `${body}.${createHmac('sha256', config.tokenPepper).update(`authflow\0${body}`).digest('hex')}`;
  for (const invalid of [`${tamperedBody}.${signature}`, `${body}.${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`,
    expired, wrongKey, wrongPurpose, 'unsigned-context']) rejected(await post(invalid));
  rejected(await post(token, randomUUID(), {}, other));
  for (const patch of [{ restaurant_id: other.restaurantId }, { version_id: other.versionId },
    { publication_revision: 2 }]) {
    const boundToWrongPublication = issueAnalyticsContext({ ...fixture.context, ...patch }, config);
    const stale = await post(boundToWrongPublication);
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json<EventReply>().code, 'ANALYTICS_CONTEXT_STALE');
  }
  assert.deepEqual(await snapshot(), before);
});

test('上下文 TTL 精确为十五分钟，截止瞬间、未来签发或超长 token 拒绝', async () => {
  const now = Date.now(), token = issueAnalyticsContext(fixture.context, config, now);
  assert.equal(decode(token).expires_at, now + lifetime);
  assert.equal(verifyAnalyticsContext(token, fixture.slug, config, now + lifetime - 1).expires_at, now + lifetime);
  assert.throws(() => verifyAnalyticsContext(token, fixture.slug, config, now + lifetime), invalidContext);
  assert.throws(() => verifyAnalyticsContext(token, fixture.slug, config, now - 1), invalidContext);
  rejected(await post('a'.repeat(2049)));
  assert.deepEqual(await counts(), zero);
});

test('POST 仅接受 JSON 固定三字段与 UUID，未知敏感字段及任意餐厅/版本参数拒绝', async () => {
  const token = signedHeader(await get()), before = await snapshot();
  const valid = { context: token, event: 'reservation_click', event_id: randomUUID() };
  const invalidBodies: unknown[] = [{}, [], { context: token, event: 'reservation_click' },
    { ...valid, event: 'page_view' }, { ...valid, context: 42 }, { ...valid, event_id: '' },
    { ...valid, event_id: 123 }, { ...valid, event_id: 'not-a-uuid-but-more-than-sixteen-characters' }];
  for (const key of ['restaurant_id', 'rid', 'version_id', 'version', 'publication_revision', 'unknown',
    'guest_name', 'email', 'phone', 'ip', 'user_agent', 'raw_url', 'headers']) {
    invalidBodies.push({ ...valid, [key]: 'sensitive-test-marker' });
  }
  for (const payload of invalidBodies) rejected(await post(token, randomUUID(), { payload: JSON.stringify(payload) }));
  rejected(await post(token, randomUUID(), { headers: { 'content-type': 'text/plain' }, payload: JSON.stringify(valid) }));
  for (const query of ['?rid=other', '?version=other', '?unknown=1']) {
    rejected(await post(token, randomUUID(), { url: `/s/${fixture.slug}/events${query}` }));
  }
  assert.deepEqual(await snapshot(), before);
});

test('POST 必须精确站点同源，缺失 Origin、后台 Origin、外站或 cross-site 全部拒绝', async () => {
  const token = signedHeader(await get()), before = await snapshot();
  for (const headers of [{ origin: undefined }, { origin: config.appOrigin }, { origin: 'null' },
    { origin: 'http://127.0.0.1:4011' }, { origin: 'http://localhost:4010' },
    { origin: publicOrigin, 'sec-fetch-site': 'cross-site' }]) {
    const response = await post(token, randomUUID(), { headers });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json<EventReply>().code, 'ANALYTICS_ORIGIN_INVALID');
  }
  rejected(await post(token, randomUUID(), { headers: { host: 'example.com:4010' } }));
  assert.deepEqual(await snapshot(), before);
});

test('不存在、未发布、失去 owner、餐厅停用或用户失效时页面与旧 signed POST 都不计', async () => {
  const token = signedHeader(await get()), before = await snapshot();
  for (const suffix of ['', '/reserve', '/go/reserve']) {
    const response = await request({ method: 'GET', url: `/s/no-such-analytics-site${suffix}` });
    assert.equal(response.statusCode, 404); rejected(response);
  }
  const missing = await post(token, randomUUID(), { url: '/s/no-such-analytics-site/events' });
  rejected(missing);
  const unavailable: Array<{ label: string; change: () => Promise<unknown>; restore: () => Promise<unknown> }> = [
    { label: '未发布', change: () => owner.query('DELETE FROM website_publications WHERE restaurant_id=$1', [fixture.restaurantId]),
      restore: () => owner.query(`INSERT INTO website_publications(restaurant_id,revision,published_version_id,slug,deployment_mode)
        VALUES($1,1,$2,$3,'local')`, [fixture.restaurantId, fixture.versionId, fixture.slug]) },
    { label: '缺少 owner', change: () => owner.query('DELETE FROM restaurant_members WHERE restaurant_id=$1', [fixture.restaurantId]),
      restore: () => owner.query(`INSERT INTO restaurant_members(id,restaurant_id,user_id,role,status)
        VALUES($1,$2,$3,'owner','active')`, [id('mem'), fixture.restaurantId, fixture.userId]) },
    { label: 'owner 已撤销', change: () => owner.query("UPDATE restaurant_members SET status='revoked' WHERE restaurant_id=$1", [fixture.restaurantId]),
      restore: () => owner.query("UPDATE restaurant_members SET status='active' WHERE restaurant_id=$1", [fixture.restaurantId]) },
    { label: '餐厅停用', change: () => owner.query("UPDATE restaurants SET status='suspended' WHERE id=$1", [fixture.restaurantId]),
      restore: () => owner.query("UPDATE restaurants SET status='active' WHERE id=$1", [fixture.restaurantId]) },
    { label: '用户停用', change: () => owner.query("UPDATE users SET status='suspended' WHERE id=$1", [fixture.userId]),
      restore: () => owner.query("UPDATE users SET status='active' WHERE id=$1", [fixture.userId]) },
    { label: '用户未验证', change: () => owner.query("UPDATE users SET status='pending_verification',email_verified_at=NULL WHERE id=$1", [fixture.userId]),
      restore: () => owner.query("UPDATE users SET status='active',email_verified_at=now() WHERE id=$1", [fixture.userId]) },
  ];
  for (const state of unavailable) {
    try {
      await state.change();
      for (const suffix of ['', '/go/reserve', '/reserve']) {
        const response = await get(suffix);
        assert.equal(response.statusCode, 404, state.label); rejected(response);
      }
      const stale = await post(token);
      assert.equal(stale.statusCode, 409, `${state.label}: ${stale.body}`);
      assert.equal(stale.json<EventReply>().code, 'ANALYTICS_CONTEXT_STALE');
    } finally { await state.restore(); }
    assert.deepEqual(await snapshot(), before, state.label);
  }
});

test('关闭订位仍可计首页 PV，但跳转/表单及已签名点击均失效', async () => {
  const token = signedHeader(await get());
  await owner.query('UPDATE restaurants SET reservation_enabled=false WHERE id=$1', [fixture.restaurantId]);
  assert.equal((await get()).statusCode, 200);
  for (const suffix of ['/reserve', '/go/reserve']) {
    const response = await get(suffix);
    assert.equal(response.statusCode, 404); rejected(response);
  }
  const stale = await post(token);
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json<EventReply>().code, 'ANALYTICS_CONTEXT_STALE');
  assert.deepEqual(await counts(), { ...zero, page_views: 2 });
});

test('旧版本及同版本重新发布的旧 revision 返回 409，不归入当前新版本', async () => {
  const oldToken = signedHeader(await get()), newVersion = await version(fixture.restaurantId, 2), before = await snapshot();
  await owner.query('UPDATE website_publications SET published_version_id=$2,revision=revision+1 WHERE restaurant_id=$1',
    [fixture.restaurantId, newVersion]);
  const stale = await post(oldToken);
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json<EventReply>().code, 'ANALYTICS_CONTEXT_STALE');
  assert.deepEqual(await snapshot(), before);
  const nextToken = signedHeader(await get());
  assert.equal(decode(nextToken).version_id, newVersion);
  assert.equal(decode(nextToken).publication_revision, 2);
  assert.equal((await post(nextToken)).json<EventReply>().recorded, true);
  const nextBefore = await snapshot();
  await owner.query('UPDATE website_publications SET revision=revision+1 WHERE restaurant_id=$1', [fixture.restaurantId]);
  const oldRevision = await post(nextToken);
  assert.equal(oldRevision.statusCode, 409);
  assert.equal(oldRevision.json<EventReply>().code, 'ANALYTICS_CONTEXT_STALE');
  assert.deepEqual(await snapshot(), nextBefore);
  const current = signedHeader(await get());
  assert.equal(decode(current).publication_revision, 3);
  assert.equal((await post(current)).json<EventReply>().recorded, true);
  assert.deepEqual(await counts(), { ...zero, page_views: 3, reservation_clicks: 2 });
});

test('页面已生成后 publication 晚变更，onResponse 不得把 old context 写入 new version', async () => {
  const newVersion = await version(fixture.restaurantId, 2);
  beforeSend = async request => {
    if (request.method !== 'GET' || request.url !== `/s/${fixture.slug}`) return;
    beforeSend = undefined;
    await owner.query('UPDATE website_publications SET published_version_id=$2,revision=revision+1 WHERE restaurant_id=$1',
      [fixture.restaurantId, newVersion]);
  };
  const oldPage = await get(), oldToken = signedHeader(oldPage);
  assert.equal(oldPage.statusCode, 200, oldPage.body);
  assert.equal(decode(oldToken).version_id, fixture.versionId);
  assert.equal(decode(oldToken).publication_revision, 1);
  assert.deepEqual(await counts(), zero);
  const stale = await post(oldToken);
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json<EventReply>().code, 'ANALYTICS_CONTEXT_STALE');
  const current = signedHeader(await get());
  assert.equal(decode(current).version_id, newVersion);
  assert.equal((await post(current)).json<EventReply>().recorded, true);
  const rows = (await owner.query<{ version_id: string; publication_revision: number }>(
    'SELECT version_id,publication_revision FROM analytics_events')).rows;
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.version_id === newVersion && row.publication_revision === 2));
  assert.deepEqual(await counts(), { ...zero, page_views: 1, reservation_clicks: 1 });
});

test('统计事件表或日汇总表缺失不影响真实首页 200，恢复表名后可继续采集', async () => {
  for (const table of ['analytics_events', 'analytics_daily'] as const) {
    // 仅在已验证的独立测试库临时改名并 finally 恢复；不 DROP、不关闭触发器、不动开发库。
    await owner.query(`ALTER TABLE public.${table} RENAME TO ${table}_site_test_unavailable`);
    try {
      const response = await get();
      assert.equal(response.statusCode, 200, response.body);
      assert.match(response.body, /统计测试餐厅/);
      const token = signedHeader(response), click = await post(token);
      assert.equal(click.statusCode, 503, click.body);
      assert.equal(click.json<EventReply>().code, 'ANALYTICS_UNAVAILABLE');
    } finally { await owner.query(`ALTER TABLE public.${table}_site_test_unavailable RENAME TO ${table}`); }
    assert.equal((await get()).statusCode, 200);
  }
  assert.deepEqual(await counts(), { ...zero, page_views: 2 });
});

test('server-only 采集不注入业务脚本或放开网络 CSP，链接及落库 JSON 不泄露 token/IP/UA/PII', async () => {
  const referer = `${publicOrigin}/synthetic-referrer-marker`, cookie = 'theme=privacy-cookie-marker';
  const page = await get('', { referer, cookie }), token = signedHeader(page), eventId = randomUUID();
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes(`class="site-reservation-link" href="/s/${fixture.slug}/go/reserve"`));
  assert.doesNotMatch(page.body, /<script\b|fetch\s*\(|sendBeacon|XMLHttpRequest|\/events\b|__SITE_RESERVE__/i);
  // 合法版本已经包含 renderer 的事实/服务 footer；统计不得追加新的 footer。
  const savedHtml = (await pool.query<{ html: string }>('SELECT html FROM website_versions WHERE id=$1', [fixture.versionId])).rows[0]!.html;
  assert.equal((page.body.match(/<footer\b/gi) ?? []).length, (savedHtml.match(/<footer\b/gi) ?? []).length);
  assert.ok(!page.body.includes(token));
  const csp = String(page.headers['content-security-policy']);
  assert.match(csp, /(?:^|;\s*)script-src 'none'(?:;|$)/);
  assert.match(csp, /(?:^|;\s*)connect-src 'none'(?:;|$)/);
  assert.match(csp, /sandbox/);
  const form = await get('/reserve');
  assert.doesNotMatch(form.body, /<script\b|sendBeacon|\/events\b/i);
  assert.match(String(form.headers['content-security-policy']), /script-src 'none'/);
  assert.match(String(form.headers['content-security-policy']), /form-action 'self'/);
  const click = await post(token, eventId, { headers: { referer, cookie }, remoteAddress: '192.0.2.240' });
  assert.equal(click.statusCode, 202);
  assert.equal(click.json<EventReply>().recorded, true);
  const rows = await snapshot(), serialized = JSON.stringify(rows), context = decode(token);
  for (const marker of [token, context.nonce, eventId, userAgent, '192.0.2.240', publicOrigin, referer,
    cookie, `${fixture.userId}@example.com`, fixture.userId, `/s/${fixture.slug}`, config.tokenPepper]) {
    assert.ok(!serialized.includes(marker), `落库不得保存 ${marker === token ? '原始上下文 token' : '请求或个人标识'}`);
    assert.ok(!JSON.stringify(click.json<EventReply>()).includes(marker));
  }
  const columns = (await owner.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='analytics_events' ORDER BY ordinal_position`)).rows.map(row => row.column_name);
  assert.deepEqual(columns, ['id', 'restaurant_id', 'version_id', 'publication_revision', 'namespace', 'metric_version',
    'event_type', 'occurred_at', 'local_date', 'timezone_snapshot', 'timezone_fallback', 'dedupe_key', 'created_at']);
  const dailyColumns = (await owner.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='analytics_daily' ORDER BY ordinal_position`)).rows.map(row => row.column_name);
  assert.deepEqual(dailyColumns, ['restaurant_id', 'namespace', 'metric_version', 'local_date', 'timezone_snapshot',
    'timezone_fallback', 'page_views', 'reservation_clicks', 'reservation_form_views', 'updated_at']);
  assert.ok(rows.events.every(row => typeof row.dedupe_key === 'string' && /^[a-f0-9]{64}$/.test(row.dedupe_key)));
  assert.deepEqual(await counts(), { page_views: 1, reservation_clicks: 1, reservation_form_views: 1 });
});
