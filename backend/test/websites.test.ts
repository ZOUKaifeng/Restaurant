import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import type { Pool } from 'pg';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { assertAppDatabase, createPool, id, transaction } from '../src/db.js';
import { migrate } from '../scripts/migrate.js';
import { FLOW_COOKIE, SESSION_COOKIE } from '../src/security.js';
import { registerWebsites } from '../src/website.js';
import { createSiteApp } from '../src/sites.js';
import { runWebsiteJobs, type WebsiteJobClient } from '../src/website-worker.js';
import { readPublicWebsite, type WebsiteRuntimeConfig } from '../src/website-access.js';
import { runWebsiteAgent } from '../src/website-react.js';
import type { WebsiteAgentObservation, WebsiteToolCall } from '../src/website-agent-types.js';

let app: FastifyInstance, pool: Pool, owner: Pool, config: WebsiteRuntimeConfig, root: string;
let sequence = 0;
const tables = 'menu_jobs,menu_drafts,website_publish_actions,website_publications,website_model_calls,website_jobs,website_versions,website_agents,asset_upload_intents,asset_references,assets,reservations,reservation_events,reservation_access_tokens,audit_logs,email_outbox,opening_hours,restaurant_members,auth_tokens,auth_sessions,auth_identities,restaurants,users';
const password = '网页测试-Valid-Password-2026!';
interface Actor { email: string; cookie: string; csrf: string }
function testUrl(key: string, role: string): string {
  const value = process.env[key];
  assert.ok(value, `必须提供真实 ${key}，禁止跳过或连接开发数据库`);
  const url = new URL(value);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55439');
  assert.equal(url.pathname, '/restaurant_test'); assert.equal(decodeURIComponent(url.username), role);
  return value;
}
async function application(value = config): Promise<FastifyInstance> {
  const instance = createApp({ pool, config: value });
  // 主 Agent 集成 app 后仍可运行；未集成时只给测试实例注册真实路由。
  instance.register(async routes => {
    if (!routes.hasRoute({ method: 'GET', url: '/api/v1/restaurants/:restaurantId/website' })) registerWebsites(routes, pool, value);
  });
  await instance.ready();
  return instance;
}
before(async () => {
  const databaseUrl = testUrl('TEST_DATABASE_URL', 'restaurant_test_app');
  const migrationDatabaseUrl = testUrl('TEST_MIGRATION_DATABASE_URL', 'restaurant_test_owner');
  root = await mkdtemp('/tmp/restaurant-websites-test-');
  // 显式合成测试配置，不读取 .env.* 或任何真实模型密钥。
  config = { ...loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, MIGRATION_DATABASE_URL: migrationDatabaseUrl,
    APP_ORIGIN: 'https://localhost:5173', EMAIL_MODE: 'disabled', STORAGE_MODE: 'local', STORAGE_LOCAL_ROOT: root,
    TOKEN_PEPPER: 'website-fixture-pepper-'.repeat(3), CURSOR_SECRET: 'website-fixture-cursor-'.repeat(3), OUTBOX_ENCRYPTION_KEY: 'a1'.repeat(32) }),
    website: { apiKey: 'fixture-only-not-a-provider-key', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
      publicOrigin: 'http://127.0.0.1:4010', port: 4010, host: '127.0.0.1' } };
  owner = createPool(migrationDatabaseUrl); pool = createPool(databaseUrl);
  await migrate(owner, 'restaurant_test_app');
  // 本测试支持尚未修改迁移清单的分工状态；使用同一迁移锁及校验表，不修改 migrate 文件。
  for (const version of ['004_websites', '006_website_react', '007_website_usage']) {
    const sql = await readFile(new URL(`../migrations/${version}.sql`, import.meta.url), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    await transaction(owner, async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('merchant-core-migrations'))");
      const applied = (await db.query('SELECT checksum FROM schema_migrations WHERE version=$1', [version])).rows[0];
      if (applied) assert.equal(applied.checksum, checksum);
      else {
        await db.query(sql);
        await db.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [version, checksum]);
      }
    });
  }
  await assertAppDatabase(pool);
  await owner.query(`TRUNCATE ${tables}`);
  app = await application();
});
after(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
  if (owner) { try { await owner.query(`TRUNCATE ${tables}`); } finally { await owner.end(); } }
  if (root) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      assert.ok(entry.isDirectory()); assert.match(entry.name, /^rst_[A-Za-z0-9_-]{24}$/);
      const path = join(root, entry.name);
      for (const file of await readdir(path)) { assert.match(file, /^ast_[A-Za-z0-9_-]{24}\.(png|jpg|pdf)$/); await unlink(join(path, file)); }
      await rmdir(path);
    }
    await rmdir(root);
  }
});
function cookie(response: { headers: Record<string, unknown> }, name: string): string {
  const values = response.headers['set-cookie'];
  const found = (Array.isArray(values) ? values : [values]).find(value => typeof value === 'string' && value.startsWith(`${name}=`));
  assert.equal(typeof found, 'string');
  return (found as string).split(';')[0]!;
}
async function request(method: HTTPMethods, path: string, actor?: Actor, payload?: Buffer | Record<string, unknown>, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (actor) { headers.cookie = actor.cookie; headers['x-csrf-token'] = actor.csrf; }
  if (method !== 'GET') headers.origin ??= config.appOrigin;
  if (payload !== undefined) headers['content-type'] ??= 'application/json';
  const response = await app.inject({ method, url: `/api/v1${path}`, headers, ...(payload === undefined ? {} : { payload }),
    remoteAddress: `127.3.${Math.floor(++sequence / 250)}.${sequence % 250 + 1}` });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.ok(!response.body.includes(config.website!.apiKey!));
  assert.ok(!response.body.includes('storage_key') && !response.body.includes('lease_token') && !response.body.includes('request_fingerprint'));
  assert.ok(!response.body.includes('agent_draft') && !response.body.includes('html_body'));
  return response;
}
async function actor(email: string): Promise<Actor> {
  const flow = await request('GET', '/auth/csrf', undefined, undefined, { origin: config.appOrigin });
  assert.equal(flow.statusCode, 200, flow.body);
  const anonymous = { email, cookie: cookie(flow, FLOW_COOKIE), csrf: flow.json().csrf_token };
  const registration = await request('POST', '/auth/register', anonymous, { email, password, locale: 'en', terms_version: 'terms-v1', accepted_terms: true });
  assert.equal(registration.statusCode, 202, registration.body);
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
async function restaurant(actor: Actor, name: string): Promise<string> {
  const response = await request('POST', '/restaurants', actor, { name, primary_locale: 'en' }, { 'idempotency-key': id('create') });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().id;
}
function path(rid: string, suffix = ''): string { return `/restaurants/${rid}/website${suffix}`; }
async function state(rid: string, actor: Actor) {
  const response = await request('GET', path(rid), actor); assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
function generation(rid: string, actor: Actor, assetIds: string[] = [], brief = '清爽的餐厅介绍网站', key = id('generate'), expectedRevision = 1) {
  return request('POST', path(rid, '/generations'), actor, { brief, asset_ids: assetIds, public_assets_confirmed: true,
    expected_restaurant_revision: expectedRevision }, { 'idempotency-key': key });
}
function publish(rid: string, actor: Actor, vid: string, expectedRevision: number, slug?: string, key = id('publish')) {
  return request('POST', path(rid, '/publication'), actor, { version_id: vid, expected_revision: expectedRevision,
    ...(slug === undefined ? {} : { slug }) }, { 'idempotency-key': key });
}
const fixtureClient: WebsiteJobClient = {
  chat: async (_config, messages, snapshot) => {
    assert.ok(messages.length <= 20); assert.equal(snapshot.assets.length, 0);
    assert.ok(!JSON.stringify(snapshot).includes('storage_key'));
    return { reply: '请确认喜欢的配色和视觉风格。', design_brief: '自然清爽、移动端优先' };
  },
  generate: async (_config, brief, snapshot) => {
    assert.ok(brief.length > 0); assert.ok(snapshot.assets.length <= 8);
    assert.ok(!JSON.stringify(snapshot).includes('storage_key'));
    const images = snapshot.assets.filter(asset => asset.mime_type !== 'application/pdf')
      .map(asset => `<restaurant-image data-asset-id="${asset.id}"></restaurant-image>`).join('');
    const menu = snapshot.assets.filter(asset => asset.mime_type === 'application/pdf')
      .map(() => '<restaurant-menu></restaurant-menu>').join('');
    return { html_body: `<section class="hero"><h1>欢迎光临</h1><p>发现我们的餐厅</p>${images}${menu}</section>`,
      css: '.hero{padding:2rem;color:#264536}', summary: '清爽餐厅页面', model: 'deepseek-flash', usage: { prompt_tokens: 100, completion_tokens: 23, total_tokens: 123 } };
  },
};
async function completedGeneration(rid: string, actor: Actor, assets: string[] = []): Promise<string> {
  const accepted = await generation(rid, actor, assets); assert.equal(accepted.statusCode, 202, accepted.body);
  assert.equal(await runWebsiteJobs(pool, config, fixtureClient), 1);
  const job = await request('GET', path(rid, `/jobs/${accepted.json().job_id}`), actor);
  assert.equal(job.json().status, 'succeeded', job.body);
  return job.json().result_version_id;
}

test('真实 PostgreSQL 网页任务、生成、预览和本地发布闭环', async t => {
  // 所有网络调用一律失败；仅通过显式测试客户端替代计费模型，不替代数据库或 renderer。
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('网页集成测试禁止真实网络及模型调用'); });
  const alice = await actor('website.alice@restaurant.example'), bob = await actor('website.bob@restaurant.example');
  const rid = await restaurant(alice, '网页餐厅'), otherRid = await restaurant(bob, '其它餐厅');
  const sameOwnerRid = await restaurant(alice, '同商家第二店');
  let aid: string, firstVersion: string, secondVersion: string;
  await t.test('GET 不懒创建，空状态准确，认证和配置字段不泄密', async () => {
    const initial = await state(rid, alice);
    assert.deepEqual(initial.agent, { id: null, revision: 0, messages: [], design_brief: '' });
    assert.deepEqual(initial.versions, []); assert.deepEqual(initial.jobs, []);
    assert.deepEqual(initial.publication, { revision: 0, published_version_id: null, slug: null, url: null, deployment_mode: 'local' });
    assert.equal(initial.model, 'deepseek-flash'); assert.equal(initial.model_configured, true);
    assert.equal(initial.menu_recognition_enabled, true);
    assert.equal((await owner.query('SELECT id FROM website_agents WHERE restaurant_id=$1', [rid])).rowCount, 0);
    assert.equal((await request('GET', path(rid))).statusCode, 401);
    assert.equal((await request('GET', path(rid), bob)).statusCode, 404);
  });
  await t.test('严格未知字段、确认、CSRF、幂等键与输入上限', async () => {
    const normal = { brief: '生成网页', asset_ids: [], public_assets_confirmed: true, expected_restaurant_revision: 1 };
    for (const payload of [{ ...normal, unknown: '禁止' }, { ...normal, public_assets_confirmed: false },
      { ...normal, public_assets_confirmed: 'true' }, { ...normal, brief: 'x'.repeat(3001) }, { ...normal, asset_ids: Array(9).fill(id('ast')) }]) {
      assert.equal((await request('POST', path(rid, '/generations'), alice, payload, { 'idempotency-key': id('test') })).statusCode, 422);
    }
    assert.equal((await request('POST', path(rid, '/messages'), alice, { message: 'x'.repeat(2001), expected_revision: 0 }, { 'idempotency-key': id('test') })).statusCode, 422);
    assert.equal((await request('POST', path(rid, '/messages'), alice, { message: '询问', expected_revision: 0, secret: true }, { 'idempotency-key': id('test') })).statusCode, 422);
    assert.equal((await request('POST', path(rid, '/publication'), alice, { version_id: id('wsv'), expected_revision: 0, cloud: true }, { 'idempotency-key': id('test') })).statusCode, 422);
    assert.equal((await request('POST', path(rid, '/generations'), { ...alice, csrf: '' }, normal, { 'idempotency-key': id('test') })).statusCode, 403);
    assert.equal((await request('POST', path(rid, '/generations'), alice, normal)).statusCode, 400);
    assert.equal((await request('POST', path(rid, '/generations'), alice, normal, { 'idempotency-key': id('test'), origin: 'https://evil.example' })).statusCode, 403);
    assert.equal((await owner.query('SELECT id FROM website_jobs WHERE restaurant_id=$1', [rid])).rowCount, 0);
  });
  await t.test('缺密钥付费接口503且不建任务，GET仍可用', async () => {
    await app.close(); app = await application({ ...config, website: { ...config.website!, apiKey: undefined } });
    try {
      const response = await generation(rid, alice); assert.equal(response.statusCode, 503); assert.equal(response.json().code, 'AI_NOT_CONFIGURED');
      const chat = await request('POST', path(rid, '/messages'), alice, { message: '帮助设计', expected_revision: 0 }, { 'idempotency-key': id('chat') });
      assert.equal(chat.statusCode, 503); assert.equal(chat.json().code, 'AI_NOT_CONFIGURED');
      assert.equal((await state(rid, alice)).model_configured, false);
      assert.equal((await owner.query('SELECT id FROM website_jobs WHERE restaurant_id=$1', [rid])).rowCount, 0);
    } finally { await app.close(); app = await application(); }
  });
  await t.test('聊天入队递增、重放原始输入、忙碌冲突和完成上下文', async () => {
    const key = id('chat'), input = { message: '希望绿色清爽，有菜单入口', expected_revision: 0 };
    const accepted = await request('POST', path(rid, '/messages'), alice, input, { 'idempotency-key': key });
    assert.equal(accepted.statusCode, 202, accepted.body); assert.equal(accepted.json().status, 'queued');
    assert.equal((await state(rid, alice)).agent.revision, 1);
    assert.equal((await generation(rid, alice)).json().code, 'WEBSITE_JOB_BUSY');
    assert.equal((await request('POST', path(rid, '/messages'), alice, { ...input, message: '改变内容' }, { 'idempotency-key': key })).statusCode, 409);
    assert.equal(await runWebsiteJobs(pool, config, fixtureClient), 1);
    const done = await state(rid, alice);
    assert.equal(done.agent.revision, 2); assert.equal(done.agent.messages.length, 2); assert.equal(done.agent.messages[1].role, 'assistant');
    assert.equal(done.agent.design_brief, '自然清爽、移动端优先');
    const replay = await request('POST', path(rid, '/messages'), alice, input, { 'idempotency-key': key });
    assert.equal(replay.statusCode, 202); assert.equal(replay.json().job_id, accepted.json().job_id); assert.equal(replay.json().status, 'succeeded');
    const stale = await request('POST', path(rid, '/messages'), alice, input, { 'idempotency-key': id('chat') });
    assert.equal(stale.statusCode, 409); assert.equal(stale.json().code, 'AGENT_REVISION_CONFLICT');
  });
  await t.test('真实上传素材，伪造选择404、重复选择422、餐厅旧revision412', async () => {
    const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#789abc' } }).png().toBuffer();
    const uploaded = await request('POST', `/restaurants/${rid}/assets?kind=restaurant_photo&original_filename=photo.png&rights_confirmed=true`, alice, bytes,
      { 'content-type': 'image/png', 'idempotency-key': id('upload') });
    assert.equal(uploaded.statusCode, 201, uploaded.body); aid = uploaded.json().id;
    assert.equal((await generation(rid, alice, [id('ast')])).statusCode, 404);
    assert.equal((await generation(sameOwnerRid, alice, [aid])).statusCode, 404);
    assert.equal((await generation(otherRid, bob, [aid])).statusCode, 404);
    assert.equal((await generation(rid, alice, [aid, aid])).statusCode, 422);
    const stale = await generation(rid, alice, [aid], '生成', id('test'), 0);
    assert.equal(stale.statusCode, 412); assert.equal(stale.json().code, 'RESTAURANT_REVISION_CONFLICT');
  });
  await t.test('任务跨连接重启持久，锁内引用阻止删除，原始brief及白名单快照', async () => {
    const brief = '  原始设计需求不得trim  ', key = id('generate');
    const accepted = await generation(rid, alice, [aid], brief, key); assert.equal(accepted.statusCode, 202, accepted.body);
    const stored = (await owner.query('SELECT * FROM website_jobs WHERE id=$1', [accepted.json().job_id])).rows[0];
    assert.equal(stored.input.brief, brief); assert.deepEqual(stored.input.asset_ids, [aid]);
    assert.deepEqual(Object.keys(stored.snapshot.assets[0]).sort(), ['id', 'kind', 'mime_type', 'checksum', 'width_px', 'height_px'].sort());
    assert.equal(stored.snapshot.restaurant.currency, null); assert.equal(stored.snapshot.restaurant.name, '网页餐厅');
    const blocked = await request('DELETE', `/restaurants/${rid}/assets/${aid}`, alice, undefined, { 'if-match': `"asset-${aid}-v1"` });
    assert.equal(blocked.statusCode, 409); assert.equal(blocked.json().code, 'ASSET_IN_USE');
    await app.close(); await pool.end(); pool = createPool(config.databaseUrl); app = await application();
    assert.equal((await state(rid, alice)).jobs[0].status, 'queued');
    assert.equal(await runWebsiteJobs(pool, config, fixtureClient), 1);
    const done = await request('GET', path(rid, `/jobs/${stored.id}`), alice); assert.equal(done.json().status, 'succeeded', done.body);
    firstVersion = done.json().result_version_id;
    const replay = await generation(rid, alice, [aid], brief, key);
    assert.equal(replay.statusCode, 202); assert.equal(replay.json().job_id, stored.id); assert.equal(replay.json().status, 'succeeded');
    assert.equal((await generation(rid, alice, [aid], brief.trim(), key)).statusCode, 409);
    assert.equal((await owner.query("SELECT id FROM asset_references WHERE purpose='website_job' AND resource_id=$1", [stored.id])).rowCount, 1);
  });
  await t.test('生成幂等指纹不随餐厅资料revision变化，复用旧输入仍返回原任务', async () => {
    const replayRid = await restaurant(bob, '资料变更重放店'), key = id('generate');
    const accepted = await generation(replayRid, bob, [], '原始需求', key); assert.equal(accepted.statusCode, 202);
    assert.equal(await runWebsiteJobs(pool, config, fixtureClient), 1);
    const changed = await request('PATCH', `/restaurants/${replayRid}`, bob, { name: '新餐厅名' }, { 'if-match': `"restaurant-${replayRid}-v1"` });
    assert.equal(changed.statusCode, 200, changed.body); assert.equal(changed.json().revision, 2);
    const replay = await generation(replayRid, bob, [], '原始需求', key);
    assert.equal(replay.statusCode, 202); assert.equal(replay.json().job_id, accepted.json().job_id);
    assert.equal((await generation(replayRid, bob)).statusCode, 412);
  });
  await t.test('预览只返回JSON，HTML校验、素材清单和版本私密字段不外泄', async () => {
    const preview = await request('GET', path(rid, `/versions/${firstVersion}/preview`), alice);
    assert.equal(preview.statusCode, 200, preview.body); assert.match(preview.headers['content-type'] as string, /application\/json/);
    assert.ok(preview.json().html.includes(`__SITE_ASSET_${aid}__`)); assert.ok(preview.json().html.includes('网页餐厅'));
    assert.equal(createHash('sha256').update(preview.json().html).digest('hex'), preview.json().checksum);
    assert.deepEqual(preview.json().assets.map((item: { id: string }) => item.id), [aid]);
    const version = (await state(rid, alice)).versions[0];
    assert.deepEqual(Object.keys(version).sort(), ['id', 'restaurant_id', 'version_number', 'summary', 'created_at', 'checksum', 'asset_ids'].sort());
    assert.equal((await request('GET', path(sameOwnerRid, `/versions/${firstVersion}/preview`), alice)).statusCode, 404);
    assert.equal((await request('GET', path(rid, `/versions/${firstVersion}/preview`), bob)).statusCode, 404);
    assert.equal((await request('GET', path(otherRid, `/jobs/${(await state(rid, alice)).jobs[0].id}`), bob)).statusCode, 404);
    const saved = (await owner.query('SELECT checksum FROM assets WHERE id=$1', [aid])).rows[0].checksum;
    await owner.query('UPDATE assets SET checksum=$2 WHERE id=$1', [aid, '0'.repeat(64)]);
    try { assert.equal((await request('GET', path(rid, `/versions/${firstVersion}/preview`), alice)).statusCode, 404); }
    finally { await owner.query('UPDATE assets SET checksum=$2 WHERE id=$1', [aid, saved]); }
  });
  await t.test('发布唯一稳定slug、幂等持久动作、选历史版本回滚', async () => {
    assert.equal((await publish(rid, alice, firstVersion, 0)).statusCode, 422);
    for (const slug of ['admin', 'api', 'auth', 'www', 'Aaa', 'ab', 'a'.repeat(51), '-abc']) assert.equal((await publish(rid, alice, firstVersion, 0, slug)).statusCode, 422);
    const key = id('publish');
    const initial = await publish(rid, alice, firstVersion, 0, 'website-alice', key); assert.equal(initial.statusCode, 200, initial.body);
    assert.equal(initial.json().url, 'http://127.0.0.1:4010/s/website-alice');
    assert.equal((await readPublicWebsite(pool, 'website-alice'))!.version_id, firstVersion);
    secondVersion = await completedGeneration(rid, alice, [aid]);
    assert.equal((await publish(rid, alice, secondVersion, 0)).statusCode, 409);
    assert.equal((await publish(rid, alice, secondVersion, 1, 'changed-slug')).json().code, 'WEBSITE_SLUG_IMMUTABLE');
    const switched = await publish(rid, alice, secondVersion, 1); assert.equal(switched.statusCode, 200, switched.body);
    assert.equal(switched.json().revision, 2); assert.equal((await readPublicWebsite(pool, 'website-alice'))!.version_id, secondVersion);
    const replay = await publish(rid, alice, firstVersion, 0, 'website-alice', key);
    assert.deepEqual(replay.json(), initial.json()); assert.equal((await state(rid, alice)).publication.revision, 2);
    assert.equal((await publish(rid, alice, secondVersion, 0, 'website-alice', key)).statusCode, 409);
    const rollback = await publish(rid, alice, firstVersion, 2); assert.equal(rollback.statusCode, 200, rollback.body);
    assert.equal(rollback.json().revision, 3); assert.equal((await readPublicWebsite(pool, 'website-alice'))!.version_id, firstVersion);
    assert.equal((await state(rid, alice)).versions.length, 2);
    const otherVersion = await completedGeneration(otherRid, bob);
    const conflict = await publish(otherRid, bob, otherVersion, 0, 'website-alice');
    assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().code, 'WEBSITE_SLUG_CONFLICT');
    assert.equal((await publish(sameOwnerRid, alice, firstVersion, 0, 'website-third')).statusCode, 404);
    assert.equal((await owner.query("SELECT id FROM audit_logs WHERE restaurant_id=$1 AND action='website_publish'", [rid])).rowCount, 3);
  });
  await t.test('独立只读站点仅公开当前版本素材，拒绝未发布文件和管理接口', async () => {
    const sites = createSiteApp({ pool, config });
    try {
      await sites.ready();
      const page = await sites.inject('/s/website-alice');
      assert.equal(page.statusCode, 200, page.body);
      assert.match(page.headers['content-security-policy'] as string, /script-src 'none'/);
      assert.match(page.headers['content-security-policy'] as string, /sandbox/);
      assert.match(page.headers['x-robots-tag'] as string, /noindex/);
      assert.ok(page.body.includes(`/media/${aid}?version=${firstVersion}`));
      assert.ok(!page.body.includes('__SITE_ASSET_') && !page.body.includes('storage_key'));
      const media = await sites.inject(`/s/website-alice/media/${aid}?version=${firstVersion}`);
      assert.equal(media.statusCode, 200);
      assert.match(media.headers['content-type'] as string, /image\/png/);
      assert.equal((await sites.inject(`/s/website-alice/media/${aid}?version=${secondVersion}`)).statusCode, 404);
      assert.equal((await sites.inject(`/s/website-alice/media/${id('ast')}?version=${firstVersion}`)).statusCode, 404);
      assert.equal((await sites.inject('/api/v1/auth/me')).statusCode, 404);
      assert.equal((await sites.inject({ url: '/s/website-alice', headers: { host: 'evil.example' } })).statusCode, 403);
      assert.equal((await sites.inject({ method: 'POST', url: '/s/website-alice' })).statusCode, 405);
    } finally { await sites.close(); }
  });
  await t.test('发布前真实素材读取失败保留原站点指针', async () => {
    const asset = (await owner.query('SELECT storage_key FROM assets WHERE id=$1', [aid])).rows[0];
    const source = join(root, asset.storage_key), held = source + '.held';
    await rename(source, held);
    try {
      const failed = await publish(rid, alice, secondVersion, 3);
      assert.equal(failed.statusCode, 503);
      assert.equal((await state(rid, alice)).publication.published_version_id, firstVersion);
      assert.equal((await state(rid, alice)).publication.revision, 3);
    } finally { await rename(held, source); }
  });
  await t.test('发布审计失败时指针与幂等历史一同回滚', async () => {
    const before = (await owner.query('SELECT count(*)::int AS n FROM website_publish_actions WHERE restaurant_id=$1', [rid])).rows[0].n;
    await owner.query('REVOKE INSERT ON audit_logs FROM restaurant_test_app');
    try {
      const failed = await publish(rid, alice, secondVersion, 3); assert.equal(failed.statusCode, 503);
      assert.equal((await state(rid, alice)).publication.revision, 3);
      assert.equal((await readPublicWebsite(pool, 'website-alice'))!.version_id, firstVersion);
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM website_publish_actions WHERE restaurant_id=$1', [rid])).rows[0].n, before);
    } finally { await owner.query('GRANT INSERT ON audit_logs TO restaurant_test_app'); }
  });
  await t.test('生产及同后台origin一律拒绝发布，不伪称云发布', async () => {
    const productionConfig: WebsiteRuntimeConfig = { ...config, nodeEnv: 'production', storageMode: 's3',
      s3: { region: 'us-east-1', bucket: 'synthetic-fixture-bucket', forcePathStyle: false } };
    for (const value of [productionConfig, { ...config, website: { ...config.website!, publicOrigin: config.appOrigin } }]) {
      await app.close(); app = await application(value);
      try {
        const result = await publish(rid, alice, firstVersion, 3);
        assert.equal(result.statusCode, 503); assert.equal(result.json().code, 'PUBLIC_DEPLOYMENT_UNCONFIGURED');
        assert.equal((await state(rid, alice)).publication.deployment_mode, 'unconfigured');
      } finally { await app.close(); app = await application(); }
    }
  });
  await t.test('402失败释放引用且保留源文件，无假模板与敏感错误', async () => {
    const failRid = await restaurant(alice, '模型失败店');
    const bytes = await sharp({ create: { width: 5, height: 5, channels: 3, background: '#223344' } }).png().toBuffer();
    const uploaded = await request('POST', `/restaurants/${failRid}/assets?kind=logo&original_filename=logo.png&rights_confirmed=true`, alice, bytes,
      { 'content-type': 'image/png', 'idempotency-key': id('upload') });
    assert.equal(uploaded.statusCode, 201); const failAid = uploaded.json().id;
    const accepted = await generation(failRid, alice, [failAid]); assert.equal(accepted.statusCode, 202);
    const failing: WebsiteJobClient = { ...fixtureClient, generate: async () => { throw Object.assign(new Error('不得记录真实响应和秘密内容'), { status: 402 }); } };
    assert.equal(await runWebsiteJobs(pool, config, failing), 1);
    const job = await request('GET', path(failRid, `/jobs/${accepted.json().job_id}`), alice);
    assert.equal(job.json().status, 'failed'); assert.equal(job.json().error_code, 'AI_BALANCE_INSUFFICIENT');
    assert.equal((await state(failRid, alice)).versions.length, 0);
    assert.equal((await owner.query('SELECT id FROM asset_references WHERE resource_id=$1', [accepted.json().job_id])).rowCount, 0);
    const source = (await owner.query('SELECT storage_key,status FROM assets WHERE id=$1', [failAid])).rows[0];
    assert.equal(source.status, 'ready'); assert.ok((await readFile(join(root, source.storage_key))).length > 0);
    assert.equal((await request('GET', `/restaurants/${failRid}/assets/${failAid}`, alice)).json().can_delete, true);
    assert.equal(await runWebsiteJobs(pool, config, failing), 0);
  });
  await t.test('过期running标记JOB_INTERRUPTED，不自动重试计费', async () => {
    const leaseRid = await restaurant(alice, '租约中断店');
    const accepted = await generation(leaseRid, alice); assert.equal(accepted.statusCode, 202);
    await owner.query("UPDATE website_jobs SET status='running',lease_token=$2,lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [accepted.json().job_id, randomUUID()]);
    let calls = 0;
    const noRetry: WebsiteJobClient = { ...fixtureClient, generate: async (...args) => { calls++; return fixtureClient.generate(...args); } };
    assert.equal(await runWebsiteJobs(pool, config, noRetry), 1); assert.equal(calls, 0);
    assert.equal((await state(leaseRid, alice)).jobs[0].error_code, 'JOB_INTERRUPTED');
    assert.equal(await runWebsiteJobs(pool, config, noRetry), 0);
  });
  await t.test('模型调用不占行锁，账号中途暂停后丢弃结果', async () => {
    const revokeRid = await restaurant(alice, '撤销生成店');
    const accepted = await generation(revokeRid, alice); assert.equal(accepted.statusCode, 202);
    const userId = (await owner.query('SELECT id FROM users WHERE email_normalized=$1', [alice.email])).rows[0].id;
    const revoked: WebsiteJobClient = { ...fixtureClient, generate: async (...args) => {
      await transaction(owner, async db => {
        await db.query("SET LOCAL lock_timeout='500ms'");
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
        await db.query('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE', [revokeRid]);
        await db.query("UPDATE users SET status='suspended' WHERE id=$1", [userId]);
      });
      return fixtureClient.generate(...args);
    } };
    try {
      assert.equal(await runWebsiteJobs(pool, config, revoked), 1);
      const row = (await owner.query('SELECT status,error_code FROM website_jobs WHERE id=$1', [accepted.json().job_id])).rows[0];
      assert.equal(row.status, 'failed'); assert.equal(row.error_code, 'WEBSITE_CONTEXT_REVOKED');
      assert.equal((await owner.query('SELECT id FROM website_versions WHERE restaurant_id=$1', [revokeRid])).rowCount, 0);
      assert.equal(await readPublicWebsite(pool, 'website-alice'), null);
    } finally { await owner.query("UPDATE users SET status='active' WHERE id=$1", [userId]); }
  });
  await t.test('聊天完成仅接受原始上下文，消息最多24条且模型只取20条', async () => {
    const chatRid = await restaurant(alice, '聊天上下文店');
    const messages = Array.from({ length: 24 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `消息${i}` }));
    await owner.query('INSERT INTO website_agents(id,restaurant_id,messages,revision) VALUES($1,$2,$3,24)', [id('wsa'), chatRid, JSON.stringify(messages)]);
    const accepted = await request('POST', path(chatRid, '/messages'), alice, { message: '最后一条', expected_revision: 24 }, { 'idempotency-key': id('chat') });
    assert.equal(accepted.statusCode, 202);
    const change: WebsiteJobClient = { ...fixtureClient, chat: async (...args) => {
      assert.equal(args[1].length, 20);
      await owner.query('UPDATE website_agents SET revision=revision+1 WHERE restaurant_id=$1', [chatRid]);
      return fixtureClient.chat(...args);
    } };
    assert.equal(await runWebsiteJobs(pool, config, change), 1);
    const current = await state(chatRid, alice);
    assert.equal(current.jobs[0].error_code, 'AGENT_CONTEXT_CHANGED'); assert.equal(current.agent.messages.length, 24);
    assert.equal(current.agent.messages.at(-1).role, 'user');
  });
  await t.test('数据库全局两个runner槽位，第三调用不计费，完成后释放连接', async () => {
    const concurrent = await actor('website.concurrent@restaurant.example');
    const concurrentRids = await Promise.all(['甲店', '乙店', '丙店'].map(name => restaurant(concurrent, name)));
    for (const value of concurrentRids) assert.equal((await generation(value, concurrent)).statusCode, 202);
    let entered = 0, release!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { reached = resolve; });
    const slow: WebsiteJobClient = { ...fixtureClient, generate: async (...args) => {
      if (++entered === 2) reached();
      await gate;
      return fixtureClient.generate(...args);
    } };
    const first = runWebsiteJobs(pool, config, slow);
    // 第一调用已入模型，第二调用再领取不同任务，避免同一候选的正常竞争导致空跑。
    while (entered < 1) await new Promise<void>(resolve => setImmediate(resolve));
    const second = runWebsiteJobs(pool, config, slow);
    try {
      await ready;
      assert.equal(await runWebsiteJobs(pool, config, slow), 0); assert.equal(entered, 2);
    } finally { release(); }
    assert.deepEqual(await Promise.all([first, second]), [1, 1]);
    assert.equal(await runWebsiteJobs(pool, config, fixtureClient), 1);
    for (let i = 0; i < 12; i++) assert.equal(await runWebsiteJobs(pool, config, fixtureClient), 0);
  });
  await t.test('每用户滚动24小时30个任务限制，满额可重放既有任务', async () => {
    const quotaActor = await actor('website.quota@restaurant.example'), quotaRid = await restaurant(quotaActor, '每日配额店');
    const first = await generation(quotaRid, quotaActor, [], '额度测试', 'website-quota-replay-0001');
    assert.equal(first.statusCode, 202); assert.equal(await runWebsiteJobs(pool, config, fixtureClient), 1);
    const original = (await owner.query('SELECT * FROM website_jobs WHERE id=$1', [first.json().job_id])).rows[0];
    for (let i = 0; i < 29; i++) await owner.query(`INSERT INTO website_jobs(id,restaurant_id,requesting_user_id,kind,status,idempotency_key,request_fingerprint,input,snapshot,error_code)
      VALUES($1,$2,$3,'generate','failed',$4,$5,$6,$7,'AI_PROVIDER_UNAVAILABLE')`,
    [id('wsj'), quotaRid, original.requesting_user_id, id('quota'), original.request_fingerprint, original.input, original.snapshot]);
    const limited = await generation(quotaRid, quotaActor);
    assert.equal(limited.statusCode, 429); assert.equal(limited.json().code, 'WEBSITE_DAILY_LIMIT');
    assert.equal((await generation(quotaRid, quotaActor, [], '额度测试', 'website-quota-replay-0001')).json().job_id, original.id);
  });
  await t.test('20个不可变版本上限拒绝新任务，不清理历史', async () => {
    const versionRid = await restaurant(bob, '版本上限店');
    const originalId = await completedGeneration(versionRid, bob);
    for (let number = 2; number <= 20; number++) await owner.query(`INSERT INTO website_versions(id,restaurant_id,version_number,summary,html,checksum,snapshot,asset_ids,model,usage)
      SELECT $1,restaurant_id,$2,summary,html,checksum,snapshot,asset_ids,model,usage FROM website_versions WHERE id=$3`, [id('wsv'), number, originalId]);
    const limited = await generation(versionRid, bob); assert.equal(limited.statusCode, 409); assert.equal(limited.json().code, 'WEBSITE_VERSION_LIMIT');
    assert.equal((await state(versionRid, bob)).versions.length, 20);
    assert.equal((await state(versionRid, bob)).jobs.length, 1);
  });
  await t.test('权限与触发器保护不可变HTML/snapshot/发布动作及原始任务输入', async () => {
    await assert.rejects(pool.query("UPDATE website_versions SET html='篡改' WHERE id=$1", [firstVersion]), { code: '42501' });
    await assert.rejects(owner.query("UPDATE website_versions SET snapshot='{}' WHERE id=$1", [firstVersion]), { code: '23514' });
    await assert.rejects(owner.query('DELETE FROM website_versions WHERE id=$1', [firstVersion]), { code: '23514' });
    await assert.rejects(pool.query("UPDATE website_jobs SET input='{}' WHERE restaurant_id=$1", [rid]), { code: '42501' });
    await assert.rejects(pool.query("UPDATE website_publish_actions SET result='{}' WHERE restaurant_id=$1", [rid]), { code: '42501' });
    await assert.rejects(owner.query("UPDATE website_publish_actions SET result='{}' WHERE restaurant_id=$1", [rid]), { code: '23514' });
    await assert.rejects(pool.query("UPDATE website_jobs SET status='queued' WHERE restaurant_id=$1", [rid]), { code: '23514' });
    assert.equal((await request('DELETE', `/restaurants/${rid}/assets/${aid}`, alice, undefined, { 'if-match': `"asset-${aid}-v1"` })).statusCode, 409);
  });
});

function nativeCall(name: string, args: unknown = {}): WebsiteToolCall {
  return { id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}
const reactDraft = {
  html_body: '<main><h1><restaurant-name></restaurant-name></h1><restaurant-description></restaurant-description><restaurant-address></restaurant-address><restaurant-contact></restaurant-contact><restaurant-hours></restaurant-hours><restaurant-menu></restaurant-menu></main>',
  css: 'main{padding:2rem}', summary: '工具式生成页面',
};
const reactPlan = (status: string) => ({ items: [{ id: 'layout', title: '生成并真实校验', status }] });

test('真实 PostgreSQL ReAct 逐步进度跨连接持久，私有草稿不返回 API，终态和租约不可篡改', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('进度测试禁止真实模型网络请求'));
  const alice = await actor('website.react.progress@restaurant.example');
  const rid = await restaurant(alice, '进度餐厅');
  const accepted = await generation(rid, alice); assert.equal(accepted.statusCode, 202);
  const jobId = accepted.json().job_id;
  const rounds = [
    [nativeCall('update_plan', reactPlan('pending')), nativeCall('read_context'), nativeCall('write_draft', { ...reactDraft, html_body: '<main>\n<script>不允许</script></main>' }), nativeCall('validate_draft')],
    [nativeCall('read_context'), nativeCall('write_draft', reactDraft), nativeCall('validate_draft'), nativeCall('update_plan', reactPlan('completed'))],
    [nativeCall('finish')],
  ];
  const durable: WebsiteAgentObservation[] = []; let calls = 0;
  const client: WebsiteJobClient = { ...fixtureClient,
    generate: async () => assert.fail('注入 react 后不应执行单次 generate'),
    react: async (value, brief, snapshot, observe) => runWebsiteAgent(value, brief, snapshot, async observation => {
      await observe(observation);
      // 使用另一真实连接确认回调提交，不仅检查内存事件。
      const stored = (await owner.query(`SELECT progress,trace,agent_draft,usage,status,
        extract(epoch FROM lease_expires_at-clock_timestamp())::float8 AS remaining FROM website_jobs WHERE id=$1`, [jobId])).rows[0];
      assert.equal(stored.status, 'running'); assert.deepEqual(stored.progress, observation.progress);
      assert.deepEqual(stored.trace.at(-1), observation.event); assert.ok(stored.trace.length <= 40);
      assert.deepEqual(stored.usage, { model_calls: observation.progress.model_calls, total_tokens: observation.progress.total_tokens,
        prompt_tokens: observation.progress.prompt_tokens, completion_tokens: observation.progress.completion_tokens,
        elapsed_ms: observation.progress.elapsed_ms, unknown_usage_calls: observation.event.action === 'model_call_started' ? 1 : 0 });
      assert.ok(stored.remaining > 80 && stored.remaining <= 190);
      if (observation.event.model_call) {
        const metric = (await owner.query('SELECT * FROM website_model_calls WHERE job_id=$1 AND call_index=$2', [jobId, observation.event.model_call.index])).rows[0];
        assert.equal(metric.status, observation.event.model_call.status);
        assert.equal(metric.total_tokens, observation.event.model_call.total_tokens === null ? null : String(observation.event.model_call.total_tokens));
      }
      if (observation.draft) assert.deepEqual(stored.agent_draft, observation.draft);
      const view = await request('GET', path(rid, `/jobs/${jobId}`), alice);
      assert.equal(view.statusCode, 200, view.body); assert.deepEqual(view.json().progress, stored.progress);
      assert.deepEqual(view.json().trace, stored.trace);
      assert.ok(!view.body.includes('不允许') && !view.body.includes('html_body'));
      if (observation.event.action === 'model_call_started' && calls === 0) {
        await assert.rejects(owner.query("UPDATE website_jobs SET lease_expires_at=clock_timestamp()+interval '48 hours' WHERE id=$1", [jobId]), { code: '23514' });
        await assert.rejects(owner.query("UPDATE website_jobs SET lease_expires_at=clock_timestamp()+interval '30 seconds' WHERE id=$1", [jobId]), { code: '23514' });
        const before = (await owner.query('SELECT lease_token,lease_expires_at FROM website_jobs WHERE id=$1', [jobId])).rows[0];
        await owner.query("UPDATE website_jobs SET lease_expires_at=clock_timestamp()+interval '185 seconds' WHERE id=$1", [jobId]);
        const heartbeat = (await owner.query('SELECT lease_token,lease_expires_at FROM website_jobs WHERE id=$1', [jobId])).rows[0];
        assert.equal(heartbeat.lease_token, before.lease_token); assert.ok(heartbeat.lease_expires_at >= before.lease_expires_at);
        await assert.rejects(owner.query('UPDATE website_jobs SET lease_token=$2 WHERE id=$1', [jobId, randomUUID()]), { code: '23514' });
        await assert.rejects(owner.query("UPDATE website_jobs SET input='{}' WHERE id=$1", [jobId]), { code: '23514' });
        await assert.rejects(owner.query("UPDATE website_jobs SET created_at=created_at+interval '1 second' WHERE id=$1", [jobId]), { code: '23514' });
      }
      durable.push(structuredClone(observation));
    }, async () => {
      assert.ok(calls < rounds.length);
      return { message: { role: 'assistant', content: null, tool_calls: rounds[calls++]! }, usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
    }),
  };
  assert.equal(await runWebsiteJobs(pool, config, client), 1); assert.equal(calls, 3);
  const stored = (await owner.query('SELECT * FROM website_jobs WHERE id=$1', [jobId])).rows[0];
  assert.equal(stored.status, 'succeeded'); assert.equal(stored.progress.phase, 'ready');
  assert.equal(stored.progress.total_tokens, 360); assert.equal(stored.lease_token, null); assert.equal(stored.lease_expires_at, null);
  const phases = new Set(durable.map(observation => observation.progress.phase));
  for (const phase of ['planning', 'writing', 'checking', 'repairing', 'ready'] as const) assert.ok(phases.has(phase));
  const version = (await owner.query('SELECT html,checksum,usage FROM website_versions WHERE id=$1', [stored.result_version_id])).rows[0];
  assert.equal(createHash('sha256').update(version.html).digest('hex'), version.checksum);
  assert.deepEqual(version.usage, { prompt_tokens: 300, completion_tokens: 60, total_tokens: 360 });
  assert.ok(!version.html.includes('<restaurant-name>') && version.html.includes('进度餐厅'));
  const publicJob = await request('GET', path(rid, `/jobs/${jobId}`), alice);
  assert.equal(publicJob.json().progress.phase, 'ready'); assert.ok(!publicJob.body.includes('agent_draft'));
  assert.ok(!JSON.stringify((await state(rid, alice)).jobs).includes('html_body'));
  await assert.rejects(pool.query("UPDATE website_jobs SET progress='{}' WHERE id=$1", [jobId]), { code: '23514' });
  await assert.rejects(owner.query("UPDATE website_jobs SET trace='[]' WHERE id=$1", [jobId]), { code: '23514' });
  assert.equal(await runWebsiteJobs(pool, config, client), 0);
});

test('真实 PostgreSQL 中途撤销 owner 权限：下次 observe 原子失败、保留诊断、释放引用且不再 external call', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('撤权测试禁止真实网络请求'));
  const alice = await actor('website.react.revoked@restaurant.example'), rid = await restaurant(alice, '撤权进度餐厅');
  const bytes = await sharp({ create: { width: 6, height: 6, channels: 3, background: '#456789' } }).png().toBuffer();
  const uploaded = await request('POST', `/restaurants/${rid}/assets?kind=logo&original_filename=logo.png&rights_confirmed=true`, alice, bytes,
    { 'content-type': 'image/png', 'idempotency-key': id('upload') });
  assert.equal(uploaded.statusCode, 201); const aid = uploaded.json().id;
  const accepted = await generation(rid, alice, [aid]); assert.equal(accepted.statusCode, 202);
  const jobId = accepted.json().job_id;
  let calls = 0, lastDiagnostics: WebsiteAgentObservation['progress']['diagnostics'] = [];
  const client: WebsiteJobClient = { ...fixtureClient, react: async (value, brief, snapshot, observe) => runWebsiteAgent(value, brief, snapshot, async observation => {
    if (observation.event.action === 'model_call_started' && calls === 1) {
      await transaction(owner, async db => {
        await db.query("SET LOCAL lock_timeout='500ms'");
        const user = (await db.query('SELECT requesting_user_id FROM website_jobs WHERE id=$1', [jobId])).rows[0].requesting_user_id;
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user]);
        await db.query('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE', [rid]);
        await db.query("UPDATE restaurant_members SET status='revoked' WHERE restaurant_id=$1 AND user_id=$2", [rid, user]);
      });
    }
    await observe(observation);
    if (observation.event.action === 'validate_draft') lastDiagnostics = structuredClone(observation.progress.diagnostics);
  }, async () => {
    calls++;
    assert.equal(calls, 1, '撤权后的观察必须在任何下一次外部请求前阻断');
    return { message: { role: 'assistant', content: null, tool_calls: [nativeCall('update_plan', reactPlan('pending')),
      nativeCall('write_draft', { ...reactDraft, html_body: '<main><script>禁止</script></main>' }), nativeCall('validate_draft')] },
    usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } };
  }) };
  try {
    assert.equal(await runWebsiteJobs(pool, config, client), 1); assert.equal(calls, 1);
    const stored = (await owner.query('SELECT * FROM website_jobs WHERE id=$1', [jobId])).rows[0];
    assert.equal(stored.status, 'failed'); assert.equal(stored.error_code, 'WEBSITE_CONTEXT_REVOKED');
    assert.equal(stored.progress.phase, 'failed'); assert.ok(lastDiagnostics.length > 0);
    assert.deepEqual(stored.progress.diagnostics, lastDiagnostics); assert.equal(stored.lease_token, null);
    assert.equal((await owner.query('SELECT id FROM asset_references WHERE resource_id=$1', [jobId])).rowCount, 0);
    assert.equal((await owner.query('SELECT id FROM website_versions WHERE restaurant_id=$1', [rid])).rowCount, 0);
    assert.equal((await request('GET', path(rid, `/jobs/${jobId}`), alice)).statusCode, 404);
    assert.equal(await runWebsiteJobs(pool, config, client), 0);
  } finally { await owner.query("UPDATE restaurant_members SET status='active' WHERE restaurant_id=$1", [rid]); }
});

test('真实 PostgreSQL ReAct 最终 checksum 仍验证，损坏结果不写入版本且失败阶段不遗失校验诊断', async () => {
  const alice = await actor('website.react.checksum@restaurant.example'), rid = await restaurant(alice, '校验和进度餐厅');
  const accepted = await generation(rid, alice); assert.equal(accepted.statusCode, 202);
  const jobId = accepted.json().job_id;
  const client: WebsiteJobClient = { ...fixtureClient, react: async (value, brief, snapshot, observe) => {
    const output = await runWebsiteAgent(value, brief, snapshot, observe, async () => ({ message: { role: 'assistant', content: null,
      tool_calls: [nativeCall('update_plan', reactPlan('completed')), nativeCall('write_draft', reactDraft), nativeCall('validate_draft'), nativeCall('finish')] },
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    return { ...output, checksum: '0'.repeat(64) };
  } };
  assert.equal(await runWebsiteJobs(pool, config, client), 1);
  const stored = (await owner.query('SELECT status,error_code,progress FROM website_jobs WHERE id=$1', [jobId])).rows[0];
  assert.equal(stored.status, 'failed'); assert.equal(stored.error_code, 'WEBSITE_CHECKSUM_INVALID');
  assert.equal(stored.progress.phase, 'failed'); assert.deepEqual(stored.progress.diagnostics, []);
  assert.equal((await owner.query('SELECT id FROM website_versions WHERE restaurant_id=$1', [rid])).rowCount, 0);
});

async function usage(rid: string, jobId: string, who: Actor) {
  const response = await request('GET', path(rid, `/jobs/${jobId}/usage`), who);
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(!response.body.includes('runner_token'));
  return response.json();
}
function cancel(rid: string, jobId: string, who: Actor) {
  return request('POST', path(rid, `/jobs/${jobId}/cancel`), who, { confirmed: true });
}

test('真实 PostgreSQL 完整调用历史超过 trace 40 与累计 60k，安全返回数值及不可重写账单', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('用量测试禁止真实模型网络请求'));
  const alice = await actor('website.metrics.history@restaurant.example'), rid = await restaurant(alice, '完整计量餐厅');
  const accepted = await generation(rid, alice); assert.equal(accepted.statusCode, 202);
  const jobId = accepted.json().job_id;
  let calls = 0;
  const client: WebsiteJobClient = { ...fixtureClient, react: async (value, brief, snapshot, observe) => runWebsiteAgent(value, brief, snapshot, observe, async () => {
    const tool_calls = ++calls <= 45 ? [nativeCall('read_context')] : [nativeCall('update_plan', reactPlan('completed')),
      nativeCall('write_draft', reactDraft), nativeCall('validate_draft'), nativeCall('finish')];
    assert.ok(calls <= 46);
    return { message: { role: 'assistant', content: null, tool_calls }, usage: { prompt_tokens: 2000, completion_tokens: 1000, total_tokens: 3000 } };
  }) };
  assert.equal(await runWebsiteJobs(pool, config, client), 1); assert.equal(calls, 46);
  const result = await usage(rid, jobId, alice);
  assert.equal(result.calls.length, 46); assert.equal(result.unknown_usage_calls, 0);
  assert.deepEqual(result.totals, { prompt_tokens: 92000, completion_tokens: 46000, total_tokens: 138000 });
  assert.deepEqual(result.calls.map((call: { index: number }) => call.index), Array.from({ length: 46 }, (_, index) => index + 1));
  for (const call of result.calls) {
    assert.equal(call.status, 'completed'); assert.equal(call.prompt_tokens, 2000); assert.equal(call.completion_tokens, 1000);
    assert.equal(call.total_tokens, 3000); assert.ok(Number.isSafeInteger(call.elapsed_ms) && call.elapsed_ms >= 0);
    assert.equal(call.error_code, null);
    assert.deepEqual(Object.keys(call).sort(), ['index', 'status', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'elapsed_ms', 'error_code'].sort());
  }
  const stored = (await owner.query('SELECT status,trace,usage FROM website_jobs WHERE id=$1', [jobId])).rows[0];
  assert.equal(stored.status, 'succeeded'); assert.equal(stored.trace.length, 40);
  assert.equal(stored.usage.model_calls, 46); assert.equal(stored.usage.total_tokens, 138000);
  await assert.rejects(owner.query("UPDATE website_model_calls SET status='failed',error_code='AI_TIMEOUT' WHERE job_id=$1 AND call_index=1", [jobId]), { code: '23514' });
  await assert.rejects(pool.query('UPDATE website_model_calls SET runner_token=$2 WHERE job_id=$1', [jobId, randomUUID()]), { code: '42501' });
  await assert.rejects(pool.query('DELETE FROM website_model_calls WHERE job_id=$1', [jobId]), { code: '42501' });
  await assert.rejects(owner.query('DELETE FROM website_model_calls WHERE job_id=$1', [jobId]), { code: '23514' });
  const finished = await cancel(rid, jobId, alice); assert.equal(finished.statusCode, 409); assert.equal(finished.json().code, 'JOB_ALREADY_FINISHED');
  assert.equal(await runWebsiteJobs(pool, config, client), 0);
});

test('真实 PostgreSQL 网络失败未知用量为 NULL，附有效账单的失败仍计费，真实零不算未知', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('失败计量测试禁止真实网络请求'));
  const alice = await actor('website.metrics.failure@restaurant.example');
  for (const known of [false, true]) {
    const rid = await restaurant(alice, known ? '失败附账单店' : '网络未知店');
    const accepted = await generation(rid, alice); assert.equal(accepted.statusCode, 202);
    const jobId = accepted.json().job_id;
    let calls = 0;
    const client: WebsiteJobClient = { ...fixtureClient, react: async (value, brief, snapshot, observe) => runWebsiteAgent(value, brief, snapshot, observe, async () => {
      if (++calls === 1) return { message: { role: 'assistant', content: null, tool_calls: [nativeCall('read_context')] },
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
      throw Object.assign(new Error('绝不能保存提供方正文或秘密'), { status: 504,
        ...(known ? { usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } } : {}) });
    }) };
    assert.equal(await runWebsiteJobs(pool, config, client), 1); assert.equal(calls, 2);
    const result = await usage(rid, jobId, alice);
    assert.equal(result.calls.length, 2); assert.equal(result.calls[0].status, 'completed'); assert.equal(result.calls[0].total_tokens, 0);
    const failed = result.calls[1]; assert.equal(failed.status, 'failed'); assert.equal(failed.error_code, 'AI_TIMEOUT');
    assert.equal(failed.prompt_tokens, known ? 11 : null); assert.equal(failed.completion_tokens, known ? 7 : null); assert.equal(failed.total_tokens, known ? 18 : null);
    assert.equal(result.unknown_usage_calls, known ? 0 : 1);
    assert.deepEqual(result.totals, known ? { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    const row = (await owner.query('SELECT status,error_code,usage FROM website_jobs WHERE id=$1', [jobId])).rows[0];
    assert.equal(row.status, 'failed'); assert.equal(row.error_code, 'AI_TIMEOUT'); assert.equal(row.usage.unknown_usage_calls, known ? 0 : 1);
    assert.equal((await cancel(rid, jobId, alice)).statusCode, 409);
    assert.equal(await runWebsiteJobs(pool, config, client), 0);
  }
});

test('真实 PostgreSQL queued 取消授权、CSRF、确认和幂等审计，不触发提供方', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('取消测试禁止真实网络请求'));
  const alice = await actor('website.metrics.cancelqueued@restaurant.example'), bob = await actor('website.metrics.cancelother@restaurant.example');
  const rid = await restaurant(alice, '队列取消店'), otherRid = await restaurant(bob, '其它取消店'), sameRid = await restaurant(alice, '同商家其它店');
  const accepted = await generation(rid, alice); assert.equal(accepted.statusCode, 202);
  const jobId = accepted.json().job_id;
  assert.equal((await request('GET', path(rid, `/jobs/${jobId}/usage`))).statusCode, 401);
  assert.equal((await request('GET', path(rid, `/jobs/${jobId}/usage`), bob)).statusCode, 404);
  assert.equal((await request('GET', path(otherRid, `/jobs/${jobId}/usage`), bob)).statusCode, 404);
  assert.equal((await request('GET', path(sameRid, `/jobs/${jobId}/usage`), alice)).statusCode, 404);
  assert.equal((await cancel(rid, jobId, bob)).statusCode, 404); assert.equal((await cancel(sameRid, jobId, alice)).statusCode, 404);
  assert.equal((await cancel(rid, jobId, { ...alice, csrf: '' })).statusCode, 403);
  assert.equal((await request('POST', path(rid, `/jobs/${jobId}/cancel`), alice, { confirmed: false })).statusCode, 422);
  assert.equal((await request('POST', path(rid, `/jobs/${jobId}/cancel`), alice, { confirmed: true, unknown: true })).statusCode, 422);
  assert.equal((await request('POST', path(rid, `/jobs/${jobId}/cancel`), alice, { confirmed: true }, { origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await owner.query('SELECT status FROM website_jobs WHERE id=$1', [jobId])).rows[0].status, 'queued');
  const first = await cancel(rid, jobId, alice); assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json(), { job_id: jobId, status: 'failed' });
  assert.equal((await request('GET', path(rid, `/jobs/${jobId}`), alice)).json().progress.phase, 'failed');
  assert.deepEqual((await cancel(rid, jobId, alice)).json(), first.json());
  const result = await usage(rid, jobId, alice); assert.deepEqual(result.calls, []); assert.equal(result.unknown_usage_calls, 0);
  assert.deepEqual(result.totals, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  assert.equal((await owner.query("SELECT id FROM audit_logs WHERE entity_id=$1 AND action='website_job_failed'", [jobId])).rowCount, 1);
  assert.equal(await runWebsiteJobs(pool, config, { ...fixtureClient, generate: async () => assert.fail('已取消队列不得发出模型请求') }), 0);
});

test('真实 PostgreSQL 活跃请求取消后补记原始账单，但不复活、不覆盖进度、不写 HTML 且释放引用', { timeout: 15000 }, async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('活跃取消测试禁止真实网络请求'));
  const alice = await actor('website.metrics.cancelactive@restaurant.example'), rid = await restaurant(alice, '活跃取消店');
  const bytes = await sharp({ create: { width: 6, height: 6, channels: 3, background: '#456789' } }).png().toBuffer();
  const uploaded = await request('POST', `/restaurants/${rid}/assets?kind=logo&original_filename=logo.png&rights_confirmed=true`, alice, bytes,
    { 'content-type': 'image/png', 'idempotency-key': id('upload') });
  assert.equal(uploaded.statusCode, 201); const aid = uploaded.json().id;
  const accepted = await generation(rid, alice, [aid]); assert.equal(accepted.statusCode, 202);
  const jobId = accepted.json().job_id;
  let ready!: () => void, release!: () => void, calls = 0;
  const entered = new Promise<void>(resolve => { ready = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const client: WebsiteJobClient = { ...fixtureClient, react: async (value, brief, snapshot, observe) => runWebsiteAgent(value, brief, snapshot, observe, async () => {
    calls++; ready(); await gate;
    return { message: { role: 'assistant', content: null, tool_calls: [nativeCall('write_draft', reactDraft)] },
      usage: { prompt_tokens: 32900, completion_tokens: 59, total_tokens: 32959 } };
  }) };
  const running = runWebsiteJobs(pool, config, client);
  let canceled: Record<string, unknown> | undefined;
  try {
    await entered;
    const before = await usage(rid, jobId, alice);
    assert.equal(before.calls[0].status, 'started'); assert.equal(before.calls[0].total_tokens, null); assert.equal(before.unknown_usage_calls, 1);
    const response = await cancel(rid, jobId, alice); assert.equal(response.statusCode, 200, response.body);
    canceled = (await owner.query('SELECT status,error_code,progress,trace,agent_draft,usage,lease_token,lease_expires_at FROM website_jobs WHERE id=$1', [jobId])).rows[0];
    assert.equal(canceled!.status, 'failed'); assert.equal(canceled!.error_code, 'AGENT_CANCELLED');
    assert.equal(canceled!.lease_token, null); assert.equal(canceled!.lease_expires_at, null);
    assert.equal((await owner.query('SELECT id FROM asset_references WHERE resource_id=$1', [jobId])).rowCount, 0);
  } finally { release(); }
  assert.equal(await running, 1); assert.equal(calls, 1);
  const saved = (await owner.query('SELECT status,error_code,progress,trace,agent_draft,usage,lease_token,lease_expires_at FROM website_jobs WHERE id=$1', [jobId])).rows[0];
  assert.deepEqual(saved, canceled);
  const result = await usage(rid, jobId, alice);
  assert.equal(result.calls.length, 1); assert.equal(result.calls[0].status, 'completed'); assert.equal(result.calls[0].error_code, null);
  assert.deepEqual(result.totals, { prompt_tokens: 32900, completion_tokens: 59, total_tokens: 32959 }); assert.equal(result.unknown_usage_calls, 0);
  assert.equal((await owner.query('SELECT id FROM website_versions WHERE restaurant_id=$1', [rid])).rowCount, 0);
  assert.equal((await owner.query("SELECT id FROM audit_logs WHERE entity_id=$1 AND action='website_job_failed'", [jobId])).rowCount, 1);
  assert.equal((await cancel(rid, jobId, alice)).statusCode, 200);
  assert.equal((await request('GET', `/restaurants/${rid}/assets/${aid}`, alice)).json().can_delete, true);
  assert.equal(await runWebsiteJobs(pool, config, client), 0);
});

test('真实 PostgreSQL 请求中账号暂停仍保留账单，拒绝业务结果和后续计费调用', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('暂停补账测试禁止真实网络请求'));
  const alice = await actor('website.metrics.suspended@restaurant.example'), rid = await restaurant(alice, '暂停补账店');
  const accepted = await generation(rid, alice); assert.equal(accepted.statusCode, 202);
  const jobId = accepted.json().job_id, userId = (await owner.query('SELECT requesting_user_id FROM website_jobs WHERE id=$1', [jobId])).rows[0].requesting_user_id;
  let calls = 0;
  const client: WebsiteJobClient = { ...fixtureClient, react: async (value, brief, snapshot, observe) => runWebsiteAgent(value, brief, snapshot, observe, async () => {
    calls++;
    await owner.query("UPDATE users SET status='suspended' WHERE id=$1", [userId]);
    return { message: { role: 'assistant', content: null, tool_calls: [nativeCall('write_draft', reactDraft)] },
      usage: { prompt_tokens: 100, completion_tokens: 23, total_tokens: 123 } };
  }) };
  try {
    assert.equal(await runWebsiteJobs(pool, config, client), 1); assert.equal(calls, 1);
    const job = (await owner.query('SELECT status,error_code,agent_draft,progress FROM website_jobs WHERE id=$1', [jobId])).rows[0];
    assert.equal(job.status, 'failed'); assert.equal(job.error_code, 'WEBSITE_CONTEXT_REVOKED'); assert.equal(job.agent_draft, null); assert.equal(job.progress.phase, 'failed');
    const call = (await owner.query('SELECT status,total_tokens FROM website_model_calls WHERE job_id=$1', [jobId])).rows[0];
    assert.equal(call.status, 'completed'); assert.equal(call.total_tokens, '123');
    assert.equal((await owner.query('SELECT id FROM website_versions WHERE restaurant_id=$1', [rid])).rowCount, 0);
  } finally { await owner.query("UPDATE users SET status='active' WHERE id=$1", [userId]); }
  assert.deepEqual((await usage(rid, jobId, alice)).totals, { prompt_tokens: 100, completion_tokens: 23, total_tokens: 123 });
  assert.equal(await runWebsiteJobs(pool, config, client), 0);
});

test('真实 PostgreSQL 重放 started 拒绝再次调用提供方，错误码 AI_USAGE_INVALID 保留', async () => {
  const alice = await actor('website.metrics.replay@restaurant.example'), rid = await restaurant(alice, '阻止调用重放店');
  const accepted = await generation(rid, alice); assert.equal(accepted.statusCode, 202);
  const jobId = accepted.json().job_id;
  let calls = 0;
  const client: WebsiteJobClient = { ...fixtureClient, react: async (value, brief, snapshot, observe) => runWebsiteAgent(value, brief, snapshot, async observation => {
    await observe(observation);
    if (observation.event.action === 'model_call_started') await observe(observation);
  }, async () => { calls++; assert.fail('重放 started 必须在提供方调用前停止'); }) };
  assert.equal(await runWebsiteJobs(pool, config, client), 1); assert.equal(calls, 0);
  const job = (await owner.query('SELECT status,error_code FROM website_jobs WHERE id=$1', [jobId])).rows[0];
  assert.equal(job.status, 'failed'); assert.equal(job.error_code, 'AI_USAGE_INVALID');
  const result = await usage(rid, jobId, alice); assert.equal(result.calls.length, 1); assert.equal(result.calls[0].status, 'failed'); assert.equal(result.unknown_usage_calls, 1);
});

test('真实 PostgreSQL 007 计量约束、原 runner、过期/聊天租约和 legacy 明确未知', async t => {
  const alice = await actor('website.metrics.constraints@restaurant.example'), rid = await restaurant(alice, '约束计量店');
  const accepted = await generation(rid, alice); assert.equal(accepted.statusCode, 202);
  const jobId = accepted.json().job_id;
  const client: WebsiteJobClient = { ...fixtureClient, react: async (value, brief, snapshot, observe) => runWebsiteAgent(value, brief, snapshot, async observation => {
    await observe(observation);
    if (observation.event.action !== 'model_call_started') return;
    const token = (await owner.query('SELECT lease_token FROM website_jobs WHERE id=$1', [jobId])).rows[0].lease_token;
    await assert.rejects(owner.query("INSERT INTO website_model_calls(job_id,call_index,runner_token,status) VALUES($1,2,$2,'completed')", [jobId, token]), { code: '23514' });
    await assert.rejects(owner.query("INSERT INTO website_model_calls(job_id,call_index,runner_token,status) VALUES($1,2,$2,'started')", [jobId, randomUUID()]), { code: '23514' });
    await assert.rejects(owner.query("INSERT INTO website_model_calls(job_id,call_index,runner_token,status) VALUES($1,0,$2,'started')", [jobId, token]), { code: '23514' });
    for (const [prompt, completion, total] of [[null, null, null], [1, null, 1], [-1, 2, 1], [1, 2, 4], ['9007199254740992', 0, '9007199254740992']]) {
      await assert.rejects(owner.query("UPDATE website_model_calls SET status='completed',prompt_tokens=$2,completion_tokens=$3,total_tokens=$4 WHERE job_id=$1 AND call_index=1", [jobId, prompt, completion, total]), { code: '23514' });
    }
    await assert.rejects(owner.query('UPDATE website_model_calls SET runner_token=$2 WHERE job_id=$1 AND call_index=1', [jobId, randomUUID()]), { code: '23514' });
  }, async () => ({ message: { role: 'assistant', content: null, tool_calls: [nativeCall('update_plan', reactPlan('completed')),
    nativeCall('write_draft', reactDraft), nativeCall('validate_draft'), nativeCall('finish')] }, usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })) };
  t.mock.method(globalThis, 'fetch', async () => assert.fail('约束测试禁止真实网络请求'));
  assert.equal(await runWebsiteJobs(pool, config, client), 1);
  assert.equal((await usage(rid, jobId, alice)).totals.total_tokens, 3);
  const original = (await owner.query('SELECT * FROM website_jobs WHERE id=$1', [jobId])).rows[0];
  const legacyId = id('wsj');
  await owner.query(`INSERT INTO website_jobs(id,restaurant_id,requesting_user_id,kind,status,idempotency_key,request_fingerprint,input,snapshot,error_code,progress,usage)
    VALUES($1,$2,$3,'generate','failed',$4,$5,$6,$7,'JOB_INTERRUPTED',$8,$9)`,
  [legacyId, rid, original.requesting_user_id, id('legacy'), original.request_fingerprint, original.input, original.snapshot,
    { phase: 'failed', model_calls: 5, total_tokens: 32959 }, { model_calls: 5, total_tokens: 32959 }]);
  const legacy = await usage(rid, legacyId, alice);
  assert.deepEqual(legacy.calls, []); assert.deepEqual(legacy.totals, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  assert.equal(legacy.unknown_usage_calls, 5);
  assert.deepEqual(legacy.legacy_summary, { model_calls: 5, total_tokens: 32959, prompt_tokens: null, completion_tokens: null });
  const next = await generation(rid, alice); assert.equal(next.statusCode, 202);
  const expiredId = next.json().job_id;
  await owner.query("UPDATE website_jobs SET status='running',lease_token=$2,lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expiredId, randomUUID()]);
  await assert.rejects(owner.query("UPDATE website_jobs SET lease_expires_at=clock_timestamp()+interval '180 seconds' WHERE id=$1", [expiredId]), { code: '23514' });
  assert.equal(await runWebsiteJobs(pool, config, client), 1);
  assert.equal((await owner.query('SELECT error_code FROM website_jobs WHERE id=$1', [expiredId])).rows[0].error_code, 'JOB_INTERRUPTED');
  const chat = await request('POST', path(rid, '/messages'), alice, { message: '询问风格', expected_revision: 0 }, { 'idempotency-key': id('chat') });
  assert.equal(chat.statusCode, 202);
  await owner.query("UPDATE website_jobs SET status='running',lease_token=$2,lease_expires_at=clock_timestamp()+interval '60 seconds' WHERE id=$1", [chat.json().job_id, randomUUID()]);
  await assert.rejects(owner.query("UPDATE website_jobs SET lease_expires_at=clock_timestamp()+interval '180 seconds' WHERE id=$1", [chat.json().job_id]), { code: '23514' });
  assert.equal((await cancel(rid, chat.json().job_id, alice)).statusCode, 200);
});

test('真实 PostgreSQL 累计超出 JS 安全整数拒绝返回伪数值，仍保留逐次已知账单', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('安全整数测试禁止真实网络请求'));
  const alice = await actor('website.metrics.safeinteger@restaurant.example'), rid = await restaurant(alice, '数值边界店');
  const accepted = await generation(rid, alice); assert.equal(accepted.statusCode, 202);
  const jobId = accepted.json().job_id;
  let calls = 0;
  const client: WebsiteJobClient = { ...fixtureClient, react: async (value, brief, snapshot, observe) => runWebsiteAgent(value, brief, snapshot, observe, async () => {
    const total = ++calls === 1 ? Number.MAX_SAFE_INTEGER : 1;
    return { message: { role: 'assistant', content: null, tool_calls: [nativeCall('read_context')] },
      usage: { prompt_tokens: total, completion_tokens: 0, total_tokens: total } };
  }) };
  assert.equal(await runWebsiteJobs(pool, config, client), 1); assert.equal(calls, 2);
  const job = (await owner.query('SELECT status,error_code FROM website_jobs WHERE id=$1', [jobId])).rows[0];
  assert.equal(job.status, 'failed'); assert.equal(job.error_code, 'AI_USAGE_INVALID');
  const records = (await owner.query('SELECT status,total_tokens FROM website_model_calls WHERE job_id=$1 ORDER BY call_index', [jobId])).rows;
  assert.deepEqual(records, [{ status: 'completed', total_tokens: String(Number.MAX_SAFE_INTEGER) }, { status: 'failed', total_tokens: '1' }]);
  const response = await request('GET', path(rid, `/jobs/${jobId}/usage`), alice);
  assert.equal(response.statusCode, 503); assert.equal(response.json().code, 'AI_USAGE_INVALID');
  assert.equal(await runWebsiteJobs(pool, config, client), 0);
});

test('真实 PostgreSQL 调用账单与 progress 原子提交，存储失败重提同一观察不重发网络', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('原子观察测试禁止真实网络请求'));
  const alice = await actor('website.metrics.atomic@restaurant.example'), rid = await restaurant(alice, '原子账单店');
  const accepted = await generation(rid, alice); assert.equal(accepted.statusCode, 202);
  const jobId = accepted.json().job_id;
  let calls = 0, checked = false;
  const client: WebsiteJobClient = { ...fixtureClient, react: async (value, brief, snapshot, observe) => runWebsiteAgent(value, brief, snapshot, async observation => {
    if (observation.event.action === 'model_call_completed') {
      const before = (await owner.query('SELECT progress,trace,usage FROM website_jobs WHERE id=$1', [jobId])).rows[0];
      await owner.query('REVOKE UPDATE(usage) ON website_jobs FROM restaurant_test_app');
      try {
        await assert.rejects(observe(observation), { code: '42501' });
        const call = (await owner.query('SELECT status,total_tokens FROM website_model_calls WHERE job_id=$1 AND call_index=1', [jobId])).rows[0];
        assert.deepEqual(call, { status: 'started', total_tokens: null });
        assert.deepEqual((await owner.query('SELECT progress,trace,usage FROM website_jobs WHERE id=$1', [jobId])).rows[0], before);
        checked = true;
      } finally { await owner.query('GRANT UPDATE(usage) ON website_jobs TO restaurant_test_app'); }
    }
    await observe(observation);
  }, async () => {
    calls++;
    return { message: { role: 'assistant', content: null, tool_calls: [nativeCall('update_plan', reactPlan('completed')),
      nativeCall('write_draft', reactDraft), nativeCall('validate_draft'), nativeCall('finish')] }, usage: { prompt_tokens: 100, completion_tokens: 23, total_tokens: 123 } };
  }) };
  assert.equal(await runWebsiteJobs(pool, config, client), 1); assert.equal(calls, 1); assert.equal(checked, true);
  assert.deepEqual((await usage(rid, jobId, alice)).totals, { prompt_tokens: 100, completion_tokens: 23, total_tokens: 123 });
  assert.equal((await owner.query('SELECT status FROM website_jobs WHERE id=$1', [jobId])).rows[0].status, 'succeeded');
});
