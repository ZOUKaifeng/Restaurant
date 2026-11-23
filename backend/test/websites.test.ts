import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import fsPromises, { mkdtemp, readFile, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import type { Pool } from 'pg';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { assertAppDatabase, id, transaction } from '../src/db.js';
import { migrate } from '../scripts/migrate.js';
import { FLOW_COOKIE, SESSION_COOKIE } from '../src/security.js';
import { insertGeneratedWebsiteFixture } from './website-fixtures.js';
import { createSiteApp } from '../src/sites.js';
import { runWebsiteJobs, type WebsiteJobClient } from '../src/website-worker.js';
import { readPublicWebsite, type WebsiteRuntimeConfig } from '../src/website-access.js';
import { runWebsiteAgent } from '../src/website-react.js';
import type { WebsiteAgentObservation, WebsiteToolCall, WebsiteToolMessage, WebsiteVisionImage } from '../src/website-agent-types.js';
import { finishAiCall } from '../src/ai-metering.js';
import type { AiCallTotals, AiTokenUsage } from '../src/ai-usage-types.js';

let app: FastifyInstance, pool: Pool, owner: Pool, config: WebsiteRuntimeConfig, root: string;
let sequence = 0;
const tables = 'ai_calendar_credit_grants,website_content_actions,website_version_sources,billing_subscriptions,billing_offer_grants,ai_quota_ledger,ai_quota_periods,ai_model_calls,billing_accounts,analytics_events,analytics_daily,menu_jobs,menu_drafts,website_publish_actions,website_publications,website_model_calls,website_jobs,website_versions,website_agents,asset_upload_intents,asset_references,assets,reservations,reservation_events,reservation_access_tokens,audit_logs,email_outbox,opening_hours,restaurant_members,auth_tokens,auth_sessions,auth_identities,restaurants,users';
const password = '网页测试-Valid-Password-2026!';
interface Actor { email: string; cookie: string; csrf: string }
import { createTestDatabasePool, createTestDatabasePools, readTestDatabaseScope } from './database-scope.js';
async function application(value = config): Promise<FastifyInstance> {
  const instance = createApp({ pool, config: value });
  await instance.ready();
  assert.equal(instance.hasRoute({ method: 'GET', url: '/api/v1/restaurants/:restaurantId/website' }), true, '主 app 必须注册网站路由');
  return instance;
}
before(async () => {
  const scope = readTestDatabaseScope();
  const { databaseUrl, migrationDatabaseUrl } = scope;
  root = await mkdtemp('/tmp/restaurant-websites-test-');
  // 显式合成测试配置，不读取 .env.* 或任何真实模型密钥。
  config = { ...loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, MIGRATION_DATABASE_URL: migrationDatabaseUrl,
    APP_ORIGIN: 'https://localhost:5173', EMAIL_MODE: 'disabled', STORAGE_MODE: 'local', STORAGE_LOCAL_ROOT: root,
    TOKEN_PEPPER: 'website-fixture-pepper-'.repeat(3), CURSOR_SECRET: 'website-fixture-cursor-'.repeat(3), OUTBOX_ENCRYPTION_KEY: 'a1'.repeat(32) }),
    website: { apiKey: 'fixture-only-not-a-provider-key', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
      publicOrigin: 'http://127.0.0.1:4010', port: 4010, host: '127.0.0.1' } };
  ({ owner, pool } = await createTestDatabasePools(scope));
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
async function aiCalls(jobId: string, expected: Array<{ status: 'started' | 'completed' | 'failed'; usage: AiTokenUsage | null; error?: string }>) {
  const job = (await owner.query('SELECT * FROM website_jobs WHERE id=$1', [jobId])).rows[0];
  assert.ok(job);
  const result = await owner.query('SELECT * FROM ai_model_calls WHERE website_job_id=$1 ORDER BY call_index', [jobId]);
  assert.equal(result.rowCount, expected.length, '010 行数必须等于真实单次/原生循环调用数');
  const accounts = (await owner.query('SELECT id FROM billing_accounts WHERE owner_user_id=$1', [job.requesting_user_id])).rows;
  if (expected.length) assert.equal(accounts.length, 1);
  for (const [index, call] of result.rows.entries()) {
    const wanted = expected[index]!;
    assert.equal(call.billing_account_id, accounts[0].id); assert.equal(call.requesting_user_id, job.requesting_user_id);
    assert.equal(call.restaurant_id, job.restaurant_id); assert.equal(call.website_job_id, jobId); assert.equal(call.menu_job_id, null);
    assert.equal(call.feature, job.kind === 'chat' ? 'website_chat' : 'website_generate');
    assert.equal(call.model, 'deepseek-flash'); assert.equal(call.provider, 'deepseek'); assert.equal(call.policy_version, 'observation-v1');
    assert.equal(call.origin, 'live'); assert.equal(call.chargeable, false); assert.equal(call.legacy_source_key, null);
    assert.equal(call.call_index, index + 1); assert.equal(call.request_key, `${jobId}:${index + 1}`);
    assert.match(call.runner_token, /^[0-9a-f-]{36}$/); if (job.lease_token) assert.equal(call.runner_token, job.lease_token);
    assert.equal(call.call_status, wanted.status);
    assert.equal(call.usage_status, wanted.status === 'started' ? 'pending' : wanted.usage === null ? 'unknown' : 'known');
    assert.deepEqual([call.prompt_tokens, call.completion_tokens, call.total_tokens], wanted.usage === null ? [null, null, null] :
      [String(wanted.usage.prompt_tokens), String(wanted.usage.completion_tokens), String(wanted.usage.total_tokens)]);
    assert.equal(call.error_code, wanted.error ?? null);
    if (wanted.status === 'started') { assert.equal(call.finished_at, null); assert.equal(call.elapsed_ms, null); }
    else { assert.ok(call.finished_at >= call.created_at); assert.equal(typeof call.elapsed_ms, 'string'); assert.ok(Number.isSafeInteger(Number(call.elapsed_ms)) && Number(call.elapsed_ms) >= 0); }
    if (wanted.usage === null) assert.equal(call.received_at, null); else assert.ok(call.received_at >= call.finished_at);
  }
  return result.rows;
}
async function aiTotals(who: Actor, expected: AiCallTotals): Promise<void> {
  const response = await request('GET', '/ai/usage', who); assert.equal(response.statusCode, 200, response.body);
  const report = response.json(); assert.equal(report.mode, 'observation'); assert.deepEqual(report.account_totals, expected);
  assert.deepEqual(report.filtered_totals, expected);
  const uid = (await owner.query('SELECT id FROM users WHERE email_normalized=$1', [who.email])).rows[0].id;
  const actual = (await owner.query(`SELECT count(*)::int AS calls,
    (count(*) FILTER (WHERE usage_status='known'))::int AS known_usage_calls,
    (count(*) FILTER (WHERE usage_status='unknown'))::int AS unknown_usage_calls,
    (count(*) FILTER (WHERE usage_status='pending'))::int AS pending_calls,
    coalesce(sum(prompt_tokens),0)::text AS prompt_tokens,coalesce(sum(completion_tokens),0)::text AS completion_tokens,
    coalesce(sum(total_tokens),0)::text AS total_tokens FROM ai_model_calls WHERE requesting_user_id=$1`, [uid])).rows[0];
  assert.deepEqual(Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, Number(value)])), expected);
  assert.deepEqual(report.quota, { configured: false, enforced: false, available_tokens: null, granted_tokens: null, reserved_tokens: null, consumed_tokens: null });
  for (const table of ['ai_quota_periods', 'ai_quota_ledger']) assert.equal((await owner.query(
    `SELECT count(*)::int AS n FROM ${table} q JOIN billing_accounts a ON a.id=q.billing_account_id WHERE a.owner_user_id=$1`, [uid])).rows[0].n, 0);
}
async function completedGeneration(rid: string, actor: Actor, assets: string[] = []): Promise<string> {
  const accepted = await generation(rid, actor, assets); assert.equal(accepted.statusCode, 202, accepted.body);
  assert.equal(await runWebsiteJobs(pool, config, fixtureClient), 1);
  const job = await request('GET', path(rid, `/jobs/${accepted.json().job_id}`), actor);
  assert.equal(job.json().status, 'succeeded', job.body);
  await aiCalls(accepted.json().job_id, [{ status: 'completed', usage: { prompt_tokens: 100, completion_tokens: 23, total_tokens: 123 } }]);
  assert.deepEqual((await usage(rid, accepted.json().job_id, actor)).totals, { prompt_tokens: 100, completion_tokens: 23, total_tokens: 123 });
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
    const metric = await aiCalls(accepted.json().job_id, [{ status: 'completed', usage: null }]);
    assert.equal((await owner.query('SELECT job_id FROM website_model_calls WHERE job_id=$1', [accepted.json().job_id])).rowCount, 0);
    const replay = await request('POST', path(rid, '/messages'), alice, input, { 'idempotency-key': key });
    assert.equal(replay.statusCode, 202); assert.equal(replay.json().job_id, accepted.json().job_id); assert.equal(replay.json().status, 'succeeded');
    const stale = await request('POST', path(rid, '/messages'), alice, input, { 'idempotency-key': id('chat') });
    assert.equal(stale.statusCode, 409); assert.equal(stale.json().code, 'AGENT_REVISION_CONFLICT');
    assert.deepEqual(await aiCalls(accepted.json().job_id, [{ status: 'completed', usage: null }]), metric);
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
    await app.close(); await pool.end(); pool = await createTestDatabasePool('app', readTestDatabaseScope()); app = await application();
    assert.equal((await state(rid, alice)).jobs[0].status, 'queued');
    assert.equal(await runWebsiteJobs(pool, config, fixtureClient), 1);
    const done = await request('GET', path(rid, `/jobs/${stored.id}`), alice); assert.equal(done.json().status, 'succeeded', done.body);
    firstVersion = done.json().result_version_id;
    await aiCalls(stored.id, [{ status: 'completed', usage: { prompt_tokens: 100, completion_tokens: 23, total_tokens: 123 } }]);
    assert.deepEqual((await usage(rid, stored.id, alice)).totals, { prompt_tokens: 100, completion_tokens: 23, total_tokens: 123 });
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
    await aiCalls(accepted.json().job_id, [{ status: 'failed', usage: null, error: 'AI_BALANCE_INSUFFICIENT' }]);
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
    await aiCalls(accepted.json().job_id, []);
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
      await aiCalls(accepted.json().job_id, [{ status: 'completed', usage: { prompt_tokens: 100, completion_tokens: 23, total_tokens: 123 } }]);
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
    await aiCalls(accepted.json().job_id, [{ status: 'completed', usage: null }]);
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
    await aiTotals(concurrent, { calls: 3, known_usage_calls: 3, unknown_usage_calls: 0, pending_calls: 0,
      prompt_tokens: 300, completion_tokens: 69, total_tokens: 369 });
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
    await aiTotals(quotaActor, { calls: 1, known_usage_calls: 1, unknown_usage_calls: 0, pending_calls: 0,
      prompt_tokens: 100, completion_tokens: 23, total_tokens: 123 });
  });
  await t.test('21个不可变版本后仍可成功生成第22版，不清理历史', async () => {
    const versionActor = await actor('website.versions@restaurant.example'), versionRid = await restaurant(versionActor, '版本历史店');
    const originalId = await completedGeneration(versionRid, versionActor);
    const original = (await owner.query('SELECT * FROM website_versions WHERE id=$1', [originalId])).rows[0];
    const raw = (await owner.query('SELECT html_body,css FROM website_version_sources WHERE version_id=$1', [originalId])).rows[0];
    for (let number = 2; number <= 21; number++) await insertGeneratedWebsiteFixture(owner, versionRid, number,
      { ...raw, summary: original.summary }, { snapshot: original.snapshot, model: original.model, usage: original.usage });
    const accepted = await generation(versionRid, versionActor); assert.equal(accepted.statusCode, 202, accepted.body);
    assert.equal(await runWebsiteJobs(pool, config, fixtureClient), 1);
    const job = (await owner.query('SELECT status,result_version_id FROM website_jobs WHERE id=$1', [accepted.json().job_id])).rows[0];
    assert.equal(job.status, 'succeeded');
    assert.equal((await owner.query('SELECT version_number FROM website_versions WHERE id=$1', [job.result_version_id])).rows[0].version_number, 22);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM website_versions WHERE restaurant_id=$1', [versionRid])).rows[0].n, 22);
    assert.deepEqual((await owner.query('SELECT * FROM website_versions WHERE id=$1', [originalId])).rows[0], original);
    assert.equal((await state(versionRid, versionActor)).versions.length, 20, '旧工作台只取最近20条，不是存储上限');
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

test('真实 PostgreSQL 新独立 actor：单次 JSON 缺 usage 成功、已知 chat 及发送前失败不伪造累计', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('JSON 观察计量测试禁止真实网络和模型调用'));
  const who = await actor('website.observation.json@restaurant.example');
  const firstRid = await restaurant(who, '单次未知用量店'), secondRid = await restaurant(who, '单次已知对话店');
  const generated = await generation(firstRid, who); assert.equal(generated.statusCode, 202, generated.body);
  const missing: WebsiteJobClient = { ...fixtureClient, generate: async (...args) => ({ ...await fixtureClient.generate(...args), usage: null }) };
  assert.equal(await runWebsiteJobs(pool, config, missing), 1);
  const job = (await owner.query('SELECT * FROM website_jobs WHERE id=$1', [generated.json().job_id])).rows[0];
  assert.equal(job.status, 'succeeded'); assert.ok(job.result_version_id);
  const version = (await owner.query('SELECT html,usage FROM website_versions WHERE id=$1', [job.result_version_id])).rows[0];
  assert.ok(version.html.includes('单次未知用量店')); assert.equal(version.usage, null);
  const firstCalls = await aiCalls(job.id, [{ status: 'completed', usage: null }]);
  // 007 的约束不同，明确保留 failed/unknown；它不改变 010 completed 或业务成功。
  assert.deepEqual((await owner.query('SELECT status,prompt_tokens,completion_tokens,total_tokens,error_code FROM website_model_calls WHERE job_id=$1', [job.id])).rows,
    [{ status: 'failed', prompt_tokens: null, completion_tokens: null, total_tokens: null, error_code: 'AI_USAGE_UNAVAILABLE' }]);
  const chat = await request('POST', path(secondRid, '/messages'), who, { message: '偏好自然配色', expected_revision: 0 }, { 'idempotency-key': id('chat') });
  assert.equal(chat.statusCode, 202, chat.body);
  const known: WebsiteJobClient = { ...fixtureClient, chat: async (...args) => ({ ...await fixtureClient.chat(...args),
    usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } }) };
  assert.equal(await runWebsiteJobs(pool, config, known), 1); assert.equal((await state(secondRid, who)).agent.messages.at(-1).role, 'assistant');
  const chatCalls = await aiCalls(chat.json().job_id, [{ status: 'completed', usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } }]);
  assert.equal(chatCalls[0].billing_account_id, firstCalls[0].billing_account_id);
  assert.equal((await owner.query('SELECT job_id FROM website_model_calls WHERE job_id=$1', [chat.json().job_id])).rowCount, 0);
  await t.test('显式发送 hook 前本地失败，零调用行', async () => {
    const accepted = await generation(firstRid, who); assert.equal(accepted.statusCode, 202, accepted.body);
    const localFailure: WebsiteJobClient = { ...fixtureClient, generate: async (_value, _brief, _snapshot, _beforeSend) => {
      throw Object.assign(new Error('合成本地校验失败，未发送'), { code: 'AI_CONFIGURATION_INVALID' });
    } };
    assert.equal(await runWebsiteJobs(pool, config, localFailure), 1);
    const failed = (await owner.query('SELECT status,error_code FROM website_jobs WHERE id=$1', [accepted.json().job_id])).rows[0];
    assert.deepEqual(failed, { status: 'failed', error_code: 'AI_CONFIGURATION_INVALID' });
    await aiCalls(accepted.json().job_id, []);
    assert.equal((await owner.query('SELECT job_id FROM website_model_calls WHERE job_id=$1', [accepted.json().job_id])).rowCount, 0);
  });
  await t.test('chat beforeSend 内撤权，paid 未执行，零调用行', async () => {
    const accepted = await request('POST', path(secondRid, '/messages'), who, { message: '发送前复核', expected_revision: 2 }, { 'idempotency-key': id('chat') });
    assert.equal(accepted.statusCode, 202, accepted.body); let paid = 0;
    const denied: WebsiteJobClient = { ...fixtureClient, chat: async (_value, _messages, _snapshot, beforeSend) => {
      assert.ok(beforeSend); await owner.query("UPDATE restaurant_members SET status='revoked' WHERE restaurant_id=$1", [secondRid]);
      await beforeSend(); paid++; return fixtureClient.chat(_value, _messages, _snapshot);
    } };
    try {
      assert.equal(await runWebsiteJobs(pool, config, denied), 1); assert.equal(paid, 0);
      assert.deepEqual((await owner.query('SELECT status,error_code FROM website_jobs WHERE id=$1', [accepted.json().job_id])).rows[0],
        { status: 'failed', error_code: 'WEBSITE_CONTEXT_REVOKED' });
      await aiCalls(accepted.json().job_id, []);
    } finally { await owner.query("UPDATE restaurant_members SET status='active' WHERE restaurant_id=$1", [secondRid]); }
  });
  await aiTotals(who, { calls: 2, known_usage_calls: 1, unknown_usage_calls: 1, pending_calls: 0,
    prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 });
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
        const current = observation.event.model_call;
        await aiCalls(jobId, Array.from({ length: current.index }, (_, index) => ({
          status: index + 1 === current.index ? current.status : 'completed',
          usage: index + 1 === current.index && current.status === 'started' ? null : { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        })));
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
    await aiCalls(jobId, [{ status: 'completed', usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } }]);
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
  await aiCalls(jobId, [{ status: 'completed', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }]);
});

async function usage(rid: string, jobId: string, who: Actor) {
  const response = await request('GET', path(rid, `/jobs/${jobId}/usage`), who);
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(!response.body.includes('runner_token'));
  const result = response.json();
  // 007 业务断言保持原样；同时核对 010 的逐调用事实，绝不从聚合制造调用。
  await aiCalls(jobId, result.calls.map((call: { status: 'started' | 'completed' | 'failed'; prompt_tokens: number | null;
    completion_tokens: number | null; total_tokens: number | null; error_code: string | null }) => ({
    status: call.status, usage: call.total_tokens === null ? null : {
      prompt_tokens: call.prompt_tokens!, completion_tokens: call.completion_tokens!, total_tokens: call.total_tokens },
    ...(call.error_code === null ? {} : { error: call.error_code }),
  })));
  return result;
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

test('真实 PostgreSQL 新独立 actor：取消后 owner 更换，completed 回调抛错再 failed 仍保持 known 原归属且不复活', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('取消换主补账测试禁止真实网络和模型调用'));
  const original = await actor('website.observation.original@restaurant.example');
  const replacement = await actor('website.observation.replacement@restaurant.example');
  const rid = await restaurant(original, '取消换主补账店');
  const accepted = await generation(rid, original); assert.equal(accepted.statusCode, 202, accepted.body);
  const jobId = accepted.json().job_id;
  const oldUid = (await owner.query('SELECT requesting_user_id FROM website_jobs WHERE id=$1', [jobId])).rows[0].requesting_user_id;
  const nextUid = (await owner.query('SELECT id FROM users WHERE email_normalized=$1', [replacement.email])).rows[0].id;
  const known = { prompt_tokens: 21, completion_tokens: 8, total_tokens: 29 };
  let calls = 0, completedRejected = false, failedRejected = false;
  let canceled: unknown, completedRows: Awaited<ReturnType<typeof aiCalls>> | undefined;
  const client: WebsiteJobClient = { ...fixtureClient, react: async (value, brief, snapshot, observe) =>
    runWebsiteAgent(value, brief, snapshot, async observation => {
      if (!['model_call_completed', 'model_call_failed'].includes(observation.event.action)) { await observe(observation); return; }
      await assert.rejects(observe(observation), { code: 'AGENT_CANCELLED' });
      const rows = await aiCalls(jobId, [{ status: 'completed', usage: known }]);
      if (observation.event.action === 'model_call_completed') { completedRejected = true; completedRows = rows; }
      else { failedRejected = true; assert.deepEqual(rows, completedRows); }
      throw Object.assign(new Error('合成取消回调拒绝'), { code: 'AGENT_CANCELLED' });
    }, async () => {
      assert.equal(++calls, 1, '已取消且换主后不得发起下一调用');
      await aiCalls(jobId, [{ status: 'started', usage: null }]);
      const canceledResponse = await cancel(rid, jobId, original); assert.equal(canceledResponse.statusCode, 200, canceledResponse.body);
      canceled = (await owner.query('SELECT * FROM website_jobs WHERE id=$1', [jobId])).rows[0];
      await transaction(owner, async db => {
        await db.query('SELECT id FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [[oldUid, nextUid]]);
        await db.query('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE', [rid]);
        await db.query("UPDATE restaurant_members SET status='revoked' WHERE restaurant_id=$1 AND user_id=$2", [rid, oldUid]);
        await db.query("INSERT INTO restaurant_members(id,restaurant_id,user_id,role,status) VALUES($1,$2,$3,'owner','active')", [id('mem'), rid, nextUid]);
      });
      return { message: { role: 'assistant', content: null, tool_calls: [nativeCall('read_context')] }, usage: known };
    }) };
  assert.equal(await runWebsiteJobs(pool, config, client), 1); assert.equal(calls, 1);
  assert.equal(completedRejected, true); assert.equal(failedRejected, true);
  assert.deepEqual((await owner.query('SELECT * FROM website_jobs WHERE id=$1', [jobId])).rows[0], canceled);
  const rows = await aiCalls(jobId, [{ status: 'completed', usage: known }]); assert.deepEqual(rows, completedRows);
  assert.equal(rows[0].requesting_user_id, oldUid);
  const account = (await owner.query('SELECT owner_user_id FROM billing_accounts WHERE id=$1', [rows[0].billing_account_id])).rows[0];
  assert.equal(account.owner_user_id, oldUid);
  assert.equal((await owner.query('SELECT id FROM billing_accounts WHERE owner_user_id=$1', [nextUid])).rowCount, 0);
  assert.equal((await owner.query('SELECT id FROM website_versions WHERE restaurant_id=$1', [rid])).rowCount, 0);
  assert.equal((await owner.query("SELECT id FROM audit_logs WHERE entity_id=$1 AND action='website_job_failed'", [jobId])).rowCount, 1);
  assert.equal((await request('GET', path(rid, `/jobs/${jobId}`), original)).statusCode, 404);
  await aiTotals(original, { calls: 1, known_usage_calls: 1, unknown_usage_calls: 0, pending_calls: 0, ...known });
  await aiTotals(replacement, { calls: 0, known_usage_calls: 0, unknown_usage_calls: 0, pending_calls: 0,
    prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  assert.equal((await owner.query('SELECT id FROM billing_accounts WHERE owner_user_id=$1', [nextUid])).rowCount, 0, '只读统计不懒建新 owner 账户');
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
  await aiCalls(expiredId, []);
  await aiCalls(legacyId, []);
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
  await aiCalls(jobId, [
    { status: 'completed', usage: { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 0, total_tokens: Number.MAX_SAFE_INTEGER } },
    { status: 'failed', usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 }, error: 'AI_USAGE_INVALID' },
  ]);
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
        await aiCalls(jobId, [{ status: 'started', usage: null }]);
        assert.deepEqual((await owner.query('SELECT progress,trace,usage FROM website_jobs WHERE id=$1', [jobId])).rows[0], before);
        checked = true;
      } finally { await owner.query('GRANT UPDATE(usage) ON website_jobs TO restaurant_test_app'); }
    }
    await observe(observation);
    if (observation.event.action === 'model_call_completed') {
      const committed = (await owner.query('SELECT progress,trace,usage FROM website_jobs WHERE id=$1', [jobId])).rows[0];
      await observe(structuredClone(observation));
      assert.deepEqual((await owner.query('SELECT progress,trace,usage FROM website_jobs WHERE id=$1', [jobId])).rows[0], committed);
      await aiCalls(jobId, [{ status: 'completed', usage: { prompt_tokens: 100, completion_tokens: 23, total_tokens: 123 } }]);
    }
  }, async () => {
    calls++;
    return { message: { role: 'assistant', content: null, tool_calls: [nativeCall('update_plan', reactPlan('completed')),
      nativeCall('write_draft', reactDraft), nativeCall('validate_draft'), nativeCall('finish')] }, usage: { prompt_tokens: 100, completion_tokens: 23, total_tokens: 123 } };
  }) };
  assert.equal(await runWebsiteJobs(pool, config, client), 1); assert.equal(calls, 1); assert.equal(checked, true);
  assert.deepEqual((await usage(rid, jobId, alice)).totals, { prompt_tokens: 100, completion_tokens: 23, total_tokens: 123 });
  assert.equal((await owner.query('SELECT status FROM website_jobs WHERE id=$1', [jobId])).rows[0].status, 'succeeded');
});

function photoGeneration(rid: string, who: Actor, assetIds: string[], key = id('generate')) {
  return request('POST', path(rid, '/generations'), who, { brief: '按授权照片设计，菜单只读人工确认文字', asset_ids: assetIds,
    public_assets_confirmed: true, image_vision_confirmed: true, expected_restaurant_revision: 1 }, { 'idempotency-key': key });
}
async function websitePhoto(rid: string, who: Actor, kind = 'restaurant_photo', mime = 'image/png', width = 80, height = 40, color = '#dc1428'): Promise<string> {
  const image = sharp({ create: { width, height, channels: 3, background: color } });
  const bytes = await (mime === 'image/png' ? image.png() : image.jpeg()).toBuffer();
  const response = await request('POST', `/restaurants/${rid}/assets?kind=${kind}&original_filename=fixture.${mime === 'image/png' ? 'png' : 'jpg'}&rights_confirmed=true`, who, bytes,
    { 'content-type': mime, 'idempotency-key': id('upload') });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().width_px, width); assert.equal(response.json().height_px, height);
  return response.json().id;
}
async function websiteMenuPdf(rid: string, who: Actor): Promise<string> {
  const pdf = await PDFDocument.create(); pdf.addPage([120, 100]);
  const response = await request('POST', `/restaurants/${rid}/assets?kind=menu_source&original_filename=menu.pdf&rights_confirmed=true`, who,
    Buffer.from(await pdf.save({ useObjectStreams: false })), { 'content-type': 'application/pdf', 'idempotency-key': id('upload') });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().id;
}
function noWebsitePixels(value: unknown): void {
  assert.doesNotMatch(JSON.stringify(value), /data:image\/|storage_key/i);
}
function websiteFileReads(t: TestContext): string[] {
  const reads: string[] = [], original = fsPromises.open, canonicalRoot = realpathSync(root);
  // 观察真实本地读取而不替代存储、校验或 sharp；兼容 macOS /tmp → /private/tmp。
  const probe = t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof fsPromises.open>) => {
    const filename = args[0];
    if (typeof filename === 'string' && filename.startsWith(`${canonicalRoot}/`) && /\/ast_[A-Za-z0-9_-]{24}\.(png|jpg|pdf)$/.test(filename)) reads.push(filename);
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { probe.mock.restore(); syncBuiltinESMExports(); });
  return reads;
}
const photoCallUsage = { prompt_tokens: 100, completion_tokens: 23, total_tokens: 123 };
function photoReactFixture() {
  const calls: WebsiteToolMessage[][] = [], received: WebsiteVisionImage[][] = [];
  const client: WebsiteJobClient = { ...fixtureClient, generate: async () => assert.fail('照片 fixture 必须运行真实 ReAct'),
    react: async (value, brief, snapshot, observe, exchange, signal, images = []) => {
      assert.equal(exchange, undefined, 'worker 不得传入真实提供方 exchange');
      received.push(structuredClone(images)); noWebsitePixels(snapshot);
      const draft = { ...reactDraft, html_body: reactDraft.html_body.replace('</main>', snapshot.assets.filter(asset => asset.kind !== 'menu_source')
        .map(asset => `<restaurant-image data-asset-id="${asset.id}"></restaurant-image>`).join('') + '</main>') };
      const rounds = [[nativeCall('read_context'), nativeCall('update_plan', reactPlan('completed')), nativeCall('write_draft', draft), nativeCall('validate_draft')], [nativeCall('finish')]];
      let round = 0;
      return runWebsiteAgent(value, brief, snapshot, async observation => { noWebsitePixels(observation); await observe(observation); }, async (_value, messages) => {
        assert.ok(round < rounds.length, '真实校验必须成功，不允许 fixture 无限重试');
        calls.push(structuredClone(messages));
        return { message: { role: 'assistant', content: null, tool_calls: rounds[round++]! }, usage: { ...photoCallUsage } };
      }, signal, images);
    } };
  return { client, calls, received };
}
async function photoFailure(rid: string, jobId: string, who: Actor, code: string) {
  const job = (await owner.query('SELECT status,error_code,result_version_id,lease_token,lease_expires_at,input,snapshot,trace,progress,agent_draft FROM website_jobs WHERE id=$1', [jobId])).rows[0];
  assert.equal(job.status, 'failed'); assert.equal(job.error_code, code); assert.equal(job.result_version_id, null);
  assert.equal(job.lease_token, null); assert.equal(job.lease_expires_at, null); noWebsitePixels(job);
  assert.equal((await owner.query('SELECT id FROM website_versions WHERE restaurant_id=$1', [rid])).rowCount, 0);
  // Failure compensation only releases this restaurant's references; it must not
  // delete another tenant's rows, even when an owner fixture corrupted a resource id.
  assert.equal((await owner.query("SELECT id FROM asset_references WHERE restaurant_id=$2 AND purpose='website_job' AND resource_id=$1", [jobId, rid])).rowCount, 0);
  return usage(rid, jobId, who);
}

test('真实 PostgreSQL 照片许可可选但 false/null/string/畸形均 422，拒绝请求不建任务', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('照片授权测试禁止真实网络'));
  const who = await actor('website.photo.consent@restaurant.example'), rid = await restaurant(who, '照片许可店');
  const aid = await websitePhoto(rid, who), reads = websiteFileReads(t);
  for (const consent of [false, null, 'true', 1, {}, []]) {
    const response = await request('POST', path(rid, '/generations'), who, { brief: '许可必须准确', asset_ids: [aid], public_assets_confirmed: true,
      image_vision_confirmed: consent, expected_restaurant_revision: 1 }, { 'idempotency-key': id('generate') });
    assert.equal(response.statusCode, 422, response.body);
  }
  assert.equal((await owner.query('SELECT id FROM website_jobs WHERE restaurant_id=$1', [rid])).rowCount, 0);
  assert.equal((await owner.query('SELECT id FROM asset_references WHERE restaurant_id=$1', [rid])).rowCount, 0);
  assert.equal(await runWebsiteJobs(pool, config, { ...fixtureClient, generate: async () => assert.fail('非法许可不得计费') }), 0);
  assert.deepEqual(reads, []);
});

test('真实 PostgreSQL 旧请求带照片只用元数据，legacy/ReAct 均不读像素；opt-in legacy 明确失败', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('旧客户端兼容测试禁止真实网络'));
  const who = await actor('website.photo.legacy@restaurant.example'), rid = await restaurant(who, '旧照片集成店');
  const aid = await websitePhoto(rid, who), reads = websiteFileReads(t);
  let legacyCalls = 0;
  const oldClient: WebsiteJobClient = { ...fixtureClient, generate: async (...args) => { legacyCalls++; return fixtureClient.generate(...args); } };
  const old = await generation(rid, who, [aid]); assert.equal(old.statusCode, 202, old.body);
  assert.equal(await runWebsiteJobs(pool, config, oldClient), 1); assert.equal(legacyCalls, 1);
  const stored = (await owner.query('SELECT status,input,snapshot FROM website_jobs WHERE id=$1', [old.json().job_id])).rows[0];
  assert.equal(stored.status, 'succeeded'); assert.equal(Object.hasOwn(stored.input, 'image_vision_confirmed'), false); noWebsitePixels(stored);
  assert.equal(stored.snapshot.assets[0].id, aid);
  const react = photoReactFixture(), next = await generation(rid, who, [aid]); assert.equal(next.statusCode, 202, next.body);
  assert.equal(await runWebsiteJobs(pool, config, react.client), 1); assert.equal(react.calls.length, 2); assert.deepEqual(react.received, [[]]);
  assert.equal((await owner.query('SELECT status FROM website_jobs WHERE id=$1', [next.json().job_id])).rows[0].status, 'succeeded');
  assert.deepEqual((await usage(rid, next.json().job_id, who)).totals, { prompt_tokens: 200, completion_tokens: 46, total_tokens: 246 });
  for (const messages of react.calls) { noWebsitePixels(messages); assert.equal(typeof messages[1]!.content, 'string'); }
  const optIn = await photoGeneration(rid, who, [aid]); assert.equal(optIn.statusCode, 202, optIn.body);
  assert.equal(await runWebsiteJobs(pool, config, oldClient), 1); assert.equal(legacyCalls, 1);
  const failed = (await owner.query('SELECT status,error_code,result_version_id FROM website_jobs WHERE id=$1', [optIn.json().job_id])).rows[0];
  assert.deepEqual(failed, { status: 'failed', error_code: 'WEBSITE_IMAGE_SOURCE_UNAVAILABLE', result_version_id: null });
  assert.deepEqual((await usage(rid, optIn.json().job_id, who)).calls, []);
  assert.equal((await owner.query("SELECT id FROM asset_references WHERE purpose='website_job' AND resource_id=$1", [optIn.json().job_id])).rowCount, 0);
  assert.deepEqual(reads, []);
});

test('真实 PostgreSQL 入队冻结视觉许可，幂等 true/缺省双向变更 409，不改旧 helper', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('照片幂等测试禁止真实网络'));
  const who = await actor('website.photo.idempotency@restaurant.example');
  for (const confirmed of [true, false]) await t.test(confirmed ? 'true 重放不能去掉许可' : '旧缺省重放不能追加许可', async () => {
    const rid = await restaurant(who, confirmed ? '冻结照片许可店' : '冻结旧输入店'), aid = await websitePhoto(rid, who), key = id('generate');
    const normal = { brief: '冻结原始照片需求', asset_ids: [aid], public_assets_confirmed: true, expected_restaurant_revision: 1 };
    const input = confirmed ? { ...normal, image_vision_confirmed: true } : normal;
    const accepted = await request('POST', path(rid, '/generations'), who, input, { 'idempotency-key': key }); assert.equal(accepted.statusCode, 202, accepted.body);
    const jobId = accepted.json().job_id, saved = (await owner.query('SELECT input,request_fingerprint,snapshot FROM website_jobs WHERE id=$1', [jobId])).rows[0];
    assert.deepEqual(saved.input, input); noWebsitePixels(saved);
    const replay = await request('POST', path(rid, '/generations'), who, input, { 'idempotency-key': key });
    assert.equal(replay.statusCode, 202); assert.equal(replay.json().job_id, jobId);
    const changed = confirmed ? normal : { ...normal, image_vision_confirmed: true };
    assert.equal((await request('POST', path(rid, '/generations'), who, changed, { 'idempotency-key': key })).statusCode, 409);
    await assert.rejects(owner.query('UPDATE website_jobs SET input=$2::jsonb WHERE id=$1', [jobId, JSON.stringify(changed)]), { code: '23514' });
    await assert.rejects(pool.query('UPDATE website_jobs SET input=$2::jsonb WHERE id=$1', [jobId, JSON.stringify(changed)]), { code: '42501' });
    await assert.rejects(owner.query("UPDATE website_jobs SET snapshot=jsonb_set(snapshot,'{assets,0,checksum}',to_jsonb($2::text)) WHERE id=$1", [jobId, '0'.repeat(64)]), { code: '23514' });
    const fixture = photoReactFixture(); assert.equal(await runWebsiteJobs(pool, config, fixture.client), 1); assert.equal(fixture.calls.length, 2);
    const doneReplay = await request('POST', path(rid, '/generations'), who, input, { 'idempotency-key': key });
    assert.equal(doneReplay.statusCode, 202); assert.equal(doneReplay.json().status, 'succeeded'); assert.equal(doneReplay.json().job_id, jobId);
    assert.equal((await request('POST', path(rid, '/generations'), who, changed, { 'idempotency-key': key })).statusCode, 409);
    assert.deepEqual((await owner.query('SELECT input,request_fingerprint,snapshot FROM website_jobs WHERE id=$1', [jobId])).rows[0], saved);
    assert.equal((await owner.query('SELECT id FROM website_jobs WHERE restaurant_id=$1', [rid])).rowCount, 1);
  });
});

test('真实 PostgreSQL opt-in PNG/JPEG 三种照片真实缩图，ReAct 两轮保图、确认菜单不变及站点真实资源映射', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('照片闭环禁止真实网络和计费模型'));
  const who = await actor('website.photo.lifecycle@restaurant.example'), rid = await restaurant(who, '真实照片餐厅');
  const fixtures = [
    { kind: 'logo', mime: 'image/png', width: 80, height: 40, color: '#dc1428', pixels: [220, 20, 40] },
    { kind: 'restaurant_photo', mime: 'image/jpeg', width: 2560, height: 1280, color: '#14c83c', pixels: [20, 200, 60] },
    { kind: 'dish_photo', mime: 'image/png', width: 40, height: 80, color: '#143cdc', pixels: [20, 60, 220] },
  ];
  const photos: Array<(typeof fixtures)[number] & { id: string }> = [];
  for (const fixture of fixtures) photos.push({ ...fixture, id: await websitePhoto(rid, who, fixture.kind, fixture.mime, fixture.width, fixture.height, fixture.color) });
  const menuImage = await websitePhoto(rid, who, 'menu_source'), pdfId = await websiteMenuPdf(rid, who);
  const unselected = await websitePhoto(rid, who, 'restaurant_photo', 'image/jpeg', 60, 30, '#aabbcc');
  const menuData = { categories: [{ name: '人工确认菜单', items: [{ name: '已确认菜品', description: '人工确认描述', price_text: '12.50', review_note: null }] }], warnings: [] };
  await owner.query(`INSERT INTO menu_drafts(id,restaurant_id,revision,status,data,confirmed_at) VALUES($1,$2,1,'confirmed',$3,clock_timestamp())`, [id('mnd'), rid, menuData]);
  const menuBefore = (await owner.query('SELECT * FROM menu_drafts WHERE restaurant_id=$1', [rid])).rows[0];
  const assetIds = [photos[2]!.id, pdfId, photos[0]!.id, photos[1]!.id], accepted = await photoGeneration(rid, who, assetIds);
  assert.equal(accepted.statusCode, 202, accepted.body); const jobId = accepted.json().job_id;
  const frozen = (await owner.query('SELECT input,snapshot FROM website_jobs WHERE id=$1', [jobId])).rows[0];
  assert.equal(frozen.input.image_vision_confirmed, true); assert.deepEqual(frozen.snapshot.menu, { revision: 1, data: menuData }); noWebsitePixels(frozen);
  const reads = websiteFileReads(t), fixture = photoReactFixture();
  assert.equal(await runWebsiteJobs(pool, config, fixture.client), 1); assert.equal(fixture.calls.length, 2); assert.equal(fixture.received.length, 1);
  const images = fixture.received[0]!;
  assert.deepEqual(images.map(image => image.asset_id), frozen.snapshot.assets.filter((asset: { kind: string }) => asset.kind !== 'menu_source').map((asset: { id: string }) => asset.id));
  assert.deepEqual(reads.map(filename => filename.split('/').at(-1)!.split('.')[0]).sort(), photos.map(photo => photo.id).sort());
  for (const image of images) {
    const original = photos.find(photo => photo.id === image.asset_id)!;
    assert.deepEqual(Object.keys(image).sort(), ['asset_id', 'mime_type', 'data_url', 'width_px', 'height_px'].sort());
    assert.equal(image.mime_type, 'image/jpeg'); assert.match(image.data_url, /^data:image\/jpeg;base64,/);
    const bytes = Buffer.from(image.data_url.slice('data:image/jpeg;base64,'.length), 'base64'), metadata = await sharp(bytes).metadata();
    const ratio = Math.min(1, 1280 / Math.max(original.width, original.height));
    assert.equal(image.width_px, original.width * ratio); assert.equal(image.height_px, original.height * ratio);
    assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.width, image.width_px); assert.equal(metadata.height, image.height_px);
    assert.equal(metadata.exif, undefined); assert.equal(metadata.icc, undefined); assert.ok(bytes.length <= 160 * 1024);
    const pixel = await sharp(bytes).extract({ left: Math.floor(image.width_px / 2), top: Math.floor(image.height_px / 2), width: 1, height: 1 }).raw().toBuffer();
    for (let channel = 0; channel < 3; channel++) assert.ok(Math.abs(pixel[channel]! - original.pixels[channel]!) <= 8, '缩图必须保留该 ID 对应的真实像素');
  }
  const firstUser = fixture.calls[0]![1]!, nextUser = fixture.calls[1]![1]!;
  assert.equal(firstUser.role, 'user'); assert.ok(Array.isArray(firstUser.content)); assert.deepEqual(nextUser, firstUser);
  assert.deepEqual(firstUser.content.filter(part => part.type === 'image_url').map(part => part.image_url.url), images.map(image => image.data_url));
  const bindings = firstUser.content.filter(part => part.type === 'text').slice(1).map(part => JSON.parse(part.text));
  assert.deepEqual(bindings, images.map(image => ({ asset_id: image.asset_id, kind: photos.find(photo => photo.id === image.asset_id)!.kind, width_px: image.width_px, height_px: image.height_px })));
  assert.equal(fixture.calls[1]!.filter(message => message.role === 'assistant').length, 1);
  const toolFeedback = fixture.calls[1]!.filter(message => message.role === 'tool'); assert.equal(toolFeedback.length, 4); noWebsitePixels(toolFeedback);
  const context = JSON.parse(toolFeedback[0]!.content);
  assert.deepEqual(context.facts.vision.available_asset_ids, images.map(image => image.asset_id));
  assert.equal(context.facts.menu.data.categories[0].items[0].name, '已确认菜品');
  for (const excluded of [menuImage, pdfId, unselected]) assert.ok(!images.some(image => image.asset_id === excluded));
  const job = (await owner.query('SELECT * FROM website_jobs WHERE id=$1', [jobId])).rows[0];
  assert.equal(job.status, 'succeeded'); noWebsitePixels(job); assert.deepEqual(job.input, frozen.input); assert.deepEqual(job.snapshot, frozen.snapshot);
  const version = (await owner.query('SELECT html,checksum,snapshot,asset_ids,usage FROM website_versions WHERE id=$1', [job.result_version_id])).rows[0];
  noWebsitePixels(version); assert.equal(createHash('sha256').update(version.html).digest('hex'), version.checksum);
  assert.deepEqual(version.snapshot, frozen.snapshot); assert.deepEqual(version.asset_ids, frozen.snapshot.assets.map((asset: { id: string }) => asset.id));
  assert.deepEqual(version.usage, { prompt_tokens: 200, completion_tokens: 46, total_tokens: 246 });
  assert.deepEqual((await owner.query('SELECT * FROM menu_drafts WHERE restaurant_id=$1', [rid])).rows[0], menuBefore);
  assert.equal((await owner.query('SELECT id FROM menu_jobs WHERE restaurant_id=$1', [rid])).rowCount, 0);
  const metrics = await usage(rid, jobId, who); assert.equal(metrics.calls.length, 2); assert.equal(metrics.unknown_usage_calls, 0);
  assert.deepEqual(metrics.totals, version.usage);
  for (const call of metrics.calls) { assert.equal(call.status, 'completed'); assert.equal(call.total_tokens, photoCallUsage.total_tokens); }
  const expectedCalls = [{ status: 'completed' as const, usage: photoCallUsage }, { status: 'completed' as const, usage: photoCallUsage }];
  const originalCalls = await aiCalls(jobId, expectedCalls);
  // 对真实 worker 创建的两行重复 finish；不伪造 started，也不修改 007 或业务状态。
  for (const call of originalCalls) await transaction(pool, async db => {
    const identity = { requestingUserId: call.requesting_user_id, restaurantId: rid, websiteJobId: jobId,
      runnerToken: call.runner_token as string, callIndex: call.call_index as number };
    await finishAiCall(db, { ...identity, status: 'completed', usage: photoCallUsage, elapsedMs: Number(call.elapsed_ms) });
    await finishAiCall(db, { ...identity, status: 'failed', usage: null, elapsedMs: 0, errorCode: 'AGENT_CANCELLED' });
  });
  assert.deepEqual(await aiCalls(jobId, expectedCalls), originalCalls);
  assert.deepEqual((await usage(rid, jobId, who)).totals, version.usage);
  await aiTotals(who, { calls: 2, known_usage_calls: 2, unknown_usage_calls: 0, pending_calls: 0,
    prompt_tokens: 200, completion_tokens: 46, total_tokens: 246 });
  assert.deepEqual((await owner.query('SELECT * FROM website_jobs WHERE id=$1', [jobId])).rows[0], job);
  const preview = await request('GET', path(rid, `/versions/${job.result_version_id}/preview`), who); assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().html, version.html); assert.equal(preview.json().checksum, version.checksum); noWebsitePixels(preview.json());
  assert.equal((await owner.query("SELECT id FROM asset_references WHERE purpose='website_job' AND resource_id=$1", [jobId])).rowCount, assetIds.length);
  for (const photo of photos) {
    assert.ok(version.html.includes(`__SITE_ASSET_${photo.id}__`));
    const blocked = await request('DELETE', `/restaurants/${rid}/assets/${photo.id}`, who, undefined, { 'if-match': `"asset-${photo.id}-v1"` });
    assert.equal(blocked.statusCode, 409); assert.equal(blocked.json().code, 'ASSET_IN_USE');
    await assert.rejects(pool.query("DELETE FROM asset_references WHERE resource_id=$1 AND asset_id=$2", [jobId, photo.id]), { code: '42501' });
    const previewAsset = preview.json().assets.find((asset: { id: string }) => asset.id === photo.id);
    assert.equal(previewAsset.mime_type, photo.mime); assert.equal(previewAsset.content_url, `/api/v1/restaurants/${rid}/assets/${photo.id}/content`);
    const content = await request('GET', previewAsset.content_url.slice('/api/v1'.length), who); assert.equal(content.statusCode, 200);
    const checksum = frozen.snapshot.assets.find((asset: { id: string }) => asset.id === photo.id).checksum;
    assert.equal(createHash('sha256').update(content.rawPayload).digest('hex'), checksum);
  }
  assert.equal((await publish(rid, who, job.result_version_id, 0, 'photo-lifecycle')).statusCode, 200);
  const sites = createSiteApp({ pool, config });
  try {
    await sites.ready(); const page = await sites.inject('/s/photo-lifecycle'); assert.equal(page.statusCode, 200, page.body); noWebsitePixels(page.body);
    for (const photo of photos) {
      const url = `/s/photo-lifecycle/media/${photo.id}?version=${job.result_version_id}`;
      assert.ok(page.body.includes(url)); assert.ok(!page.body.includes(`__SITE_ASSET_${photo.id}__`));
      const media = await sites.inject(url); assert.equal(media.statusCode, 200); assert.match(media.headers['content-type'] as string, new RegExp(photo.mime));
      const checksum = frozen.snapshot.assets.find((asset: { id: string }) => asset.id === photo.id).checksum;
      assert.equal(createHash('sha256').update(media.rawPayload).digest('hex'), checksum);
      const metadata = await sharp(media.rawPayload).metadata(); assert.equal(metadata.width, photo.width); assert.equal(metadata.height, photo.height);
    }
    assert.equal((await sites.inject(`/s/photo-lifecycle/media/${unselected}?version=${job.result_version_id}`)).statusCode, 404);
    assert.equal((await sites.inject(`/s/photo-lifecycle/media/${menuImage}?version=${job.result_version_id}`)).statusCode, 404);
  } finally { await sites.close(); }
});

test('真实 PostgreSQL opt-in 空选图、菜单 PNG、菜单 PDF 均不读或外发像素', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('无视觉输入测试禁止真实网络'));
  const who = await actor('website.photo.exclusions@restaurant.example');
  for (const selection of ['empty', 'menu_png', 'menu_pdf']) await t.test(selection, async sub => {
    const rid = await restaurant(who, `排除视觉 ${selection}`);
    const ids = selection === 'empty' ? [] : [selection === 'menu_pdf' ? await websiteMenuPdf(rid, who) : await websitePhoto(rid, who, 'menu_source')];
    const reads = websiteFileReads(sub), accepted = await photoGeneration(rid, who, ids); assert.equal(accepted.statusCode, 202, accepted.body);
    const fixture = photoReactFixture(); assert.equal(await runWebsiteJobs(pool, config, fixture.client), 1);
    assert.equal(fixture.calls.length, 2); assert.deepEqual(fixture.received, [[]]); assert.deepEqual(reads, []);
    for (const messages of fixture.calls) { noWebsitePixels(messages); assert.equal(typeof messages[1]!.content, 'string'); }
    assert.equal((await owner.query('SELECT status FROM website_jobs WHERE id=$1', [accepted.json().job_id])).rows[0].status, 'succeeded');
  });
});

test('真实 PostgreSQL 照片物理缺失、冻结 checksum 变更、引用删除/跨店及失效 rights 在 exchange 前失败', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('图源故障测试禁止真实网络'));
  const who = await actor('website.photo.sources@restaurant.example');
  for (const change of ['missing_file', 'checksum', 'reference_deleted', 'reference_other_restaurant', 'rights_infinite']) await t.test(change, async sub => {
    const rid = await restaurant(who, `照片故障 ${change}`), aid = await websitePhoto(rid, who);
    const otherRid = change === 'reference_other_restaurant' ? await restaurant(who, '跨店引用目标') : undefined;
    const otherAid = otherRid ? await websitePhoto(otherRid, who) : undefined;
    const accepted = await photoGeneration(rid, who, [aid]); assert.equal(accepted.statusCode, 202, accepted.body);
    const jobId = accepted.json().job_id, saved = (await owner.query('SELECT input,snapshot FROM website_jobs WHERE id=$1', [jobId])).rows[0];
    const asset = (await owner.query('SELECT storage_key,checksum,rights_confirmed_at FROM assets WHERE id=$1', [aid])).rows[0];
    const source = join(root, asset.storage_key), held = source + '.held';
    const reads = websiteFileReads(sub), fixture = photoReactFixture();
    try {
      if (change === 'missing_file') await rename(source, held);
      else if (change === 'checksum') await owner.query('UPDATE assets SET checksum=$2 WHERE id=$1', [aid, '0'.repeat(64)]);
      else if (change === 'reference_deleted') await owner.query("DELETE FROM asset_references WHERE resource_id=$1 AND asset_id=$2", [jobId, aid]);
      else if (change === 'reference_other_restaurant') {
        await assert.rejects(owner.query('UPDATE asset_references SET restaurant_id=$3,asset_id=$4 WHERE resource_id=$1 AND asset_id=$2',
          [jobId, aid, otherRid, otherAid]), { code: '23514' }, '正常 owner 写入同样必须受不可覆写守卫约束');
        await transaction(owner, async db => {
          await db.query('SAVEPOINT corrupt_reference_fixture');
          try {
            assert.deepEqual((await db.query('SELECT current_user AS role,current_database() AS database')).rows[0],
              { role: 'restaurant_test_owner', database: 'restaurant_test' });
            assert.equal((await db.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='asset_references'::regclass AND tgname='website_asset_reference_guard'")).rows[0].tgenabled, 'O');
            // 明确模拟历史损坏引用；只关闭此 UPDATE 守卫，其他 FK、素材守卫及 worker 校验保持真实。
            await db.query('ALTER TABLE asset_references DISABLE TRIGGER website_asset_reference_guard');
            await db.query('UPDATE asset_references SET restaurant_id=$3,asset_id=$4 WHERE resource_id=$1 AND asset_id=$2', [jobId, aid, otherRid, otherAid]);
            await db.query('ALTER TABLE asset_references ENABLE TRIGGER website_asset_reference_guard');
            await db.query('RELEASE SAVEPOINT corrupt_reference_fixture');
          } catch (error) {
            await db.query('ROLLBACK TO SAVEPOINT corrupt_reference_fixture');
            await db.query('RELEASE SAVEPOINT corrupt_reference_fixture');
            throw error;
          }
        });
        assert.equal((await owner.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='asset_references'::regclass AND tgname='website_asset_reference_guard'")).rows[0].tgenabled, 'O');
      }
      else await owner.query("UPDATE assets SET rights_confirmed_at='infinity'::timestamptz WHERE id=$1", [aid]);
      assert.equal(await runWebsiteJobs(pool, config, fixture.client), 1); assert.deepEqual(fixture.received, []); assert.deepEqual(fixture.calls, []);
      const result = await photoFailure(rid, jobId, who, 'WEBSITE_IMAGE_SOURCE_UNAVAILABLE'); assert.deepEqual(result.calls, []);
      if (change === 'reference_other_restaurant') assert.equal((await owner.query('SELECT id FROM asset_references WHERE restaurant_id=$1 AND asset_id=$2 AND resource_id=$3', [otherRid, otherAid, jobId])).rowCount, 1, '补偿不能删除另一餐厅的引用');
      assert.deepEqual(result.totals, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }); assert.equal(result.unknown_usage_calls, 0);
      assert.equal(reads.length, change === 'missing_file' ? 1 : 0);
      assert.deepEqual((await owner.query('SELECT input,snapshot FROM website_jobs WHERE id=$1', [jobId])).rows[0], saved);
    } finally {
      if (change === 'missing_file') await rename(held, source);
      if (change === 'checksum') await owner.query('UPDATE assets SET checksum=$2 WHERE id=$1', [aid, asset.checksum]);
      if (change === 'rights_infinite') await owner.query('UPDATE assets SET rights_confirmed_at=$2 WHERE id=$1', [aid, asset.rights_confirmed_at]);
      if (change === 'reference_other_restaurant') await owner.query('DELETE FROM asset_references WHERE resource_id=$1', [jobId]);
    }
    assert.ok((await readFile(source)).length > 0, '失败只释放引用，不能删除商家原图');
    assert.equal(await runWebsiteJobs(pool, config, fixture.client), 0);
  });
});

test('真实 PostgreSQL 照片 rights NULL、安全撤销与非上传 origin 被数据库硬约束拒绝，不放宽约束', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('照片硬约束测试禁止真实网络'));
  const who = await actor('website.photo.constraints@restaurant.example'), rid = await restaurant(who, '照片安全约束店'), aid = await websitePhoto(rid, who);
  const before = (await owner.query('SELECT rights_confirmed_at,safety_status,origin FROM assets WHERE id=$1', [aid])).rows[0];
  await assert.rejects(owner.query('UPDATE assets SET rights_confirmed_at=NULL WHERE id=$1', [aid]), { code: '23502' });
  await assert.rejects(owner.query("UPDATE assets SET safety_status='pending' WHERE id=$1", [aid]), { code: '23514' });
  await assert.rejects(owner.query("UPDATE assets SET origin='remote' WHERE id=$1", [aid]), { code: '23514' });
  assert.deepEqual((await owner.query('SELECT rights_confirmed_at,safety_status,origin FROM assets WHERE id=$1', [aid])).rows[0], before);
  assert.equal((await owner.query('SELECT id FROM website_jobs WHERE restaurant_id=$1', [rid])).rowCount, 0);
});

test('真实 PostgreSQL 照片准备后首次调用及两次模型调用之间复核图源，阻止下一 exchange 且不丢已知用量', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('照片逐调用守卫测试禁止真实网络'));
  const who = await actor('website.photo.callguards@restaurant.example');
  for (const callIndex of [1, 2]) await t.test(`第 ${callIndex} 次 started 前图源改变`, async sub => {
    const rid = await restaurant(who, `照片第 ${callIndex} 次守卫店`), aid = await websitePhoto(rid, who);
    const accepted = await photoGeneration(rid, who, [aid]); assert.equal(accepted.statusCode, 202, accepted.body);
    const jobId = accepted.json().job_id, checksum = (await owner.query('SELECT checksum FROM assets WHERE id=$1', [aid])).rows[0].checksum;
    const reads = websiteFileReads(sub), fixture = photoReactFixture(); let changed = false;
    const client: WebsiteJobClient = { ...fixture.client, react: async (value, brief, snapshot, observe, exchange, signal, images) =>
      fixture.client.react!(value, brief, snapshot, async observation => {
        if (observation.event.action === 'model_call_started' && observation.event.model_call!.index === callIndex) {
          assert.equal(fixture.calls.length, callIndex - 1); assert.equal(reads.length, 1);
          await transaction(owner, async db => {
            await db.query("SET LOCAL lock_timeout='500ms'");
            await db.query('UPDATE assets SET checksum=$2 WHERE id=$1', [aid, 'f'.repeat(64)]);
          });
          changed = true;
        }
        await observe(observation);
      }, exchange, signal, images) };
    try {
      assert.equal(await runWebsiteJobs(pool, config, client), 1); assert.equal(changed, true);
      assert.equal(fixture.calls.length, callIndex - 1); assert.equal(fixture.received[0]!.length, 1); assert.equal(reads.length, 1);
      const result = await photoFailure(rid, jobId, who, 'WEBSITE_IMAGE_SOURCE_UNAVAILABLE');
      assert.equal(result.calls.length, callIndex - 1); assert.equal(result.unknown_usage_calls, 0);
      assert.deepEqual(result.totals, callIndex === 1 ? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } : photoCallUsage);
      if (callIndex === 2) { assert.equal(result.calls[0].status, 'completed'); assert.equal(result.calls[0].total_tokens, 123); }
      assert.equal(await runWebsiteJobs(pool, config, client), 0);
    } finally { await owner.query('UPDATE assets SET checksum=$2 WHERE id=$1', [aid, checksum]); }
  });
});

test('真实 PostgreSQL 照片 ReAct 返回后 finish 再查引用，丢弃 HTML 但保留两次调用账单', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('照片最终守卫测试禁止真实网络'));
  const who = await actor('website.photo.finishguard@restaurant.example'), rid = await restaurant(who, '照片最终引用守卫店'), aid = await websitePhoto(rid, who);
  const accepted = await photoGeneration(rid, who, [aid]); assert.equal(accepted.statusCode, 202, accepted.body);
  const jobId = accepted.json().job_id, reads = websiteFileReads(t), fixture = photoReactFixture(); let returned = false;
  const client: WebsiteJobClient = { ...fixture.client, react: async (...args) => {
    const result = await fixture.client.react!(...args); assert.ok(result.html.includes(`__SITE_ASSET_${aid}__`));
    await owner.query('DELETE FROM asset_references WHERE resource_id=$1 AND asset_id=$2', [jobId, aid]); returned = true;
    return result;
  } };
  assert.equal(await runWebsiteJobs(pool, config, client), 1); assert.equal(returned, true); assert.equal(reads.length, 1); assert.equal(fixture.calls.length, 2);
  const result = await photoFailure(rid, jobId, who, 'WEBSITE_IMAGE_SOURCE_UNAVAILABLE');
  assert.equal(result.calls.length, 2); assert.equal(result.unknown_usage_calls, 0);
  assert.deepEqual(result.totals, { prompt_tokens: 200, completion_tokens: 46, total_tokens: 246 });
  assert.ok(result.calls.every((call: { status: string }) => call.status === 'completed'));
  assert.equal(await runWebsiteJobs(pool, config, client), 0);
});

test('真实 PostgreSQL opt-in 照片 queued confirmed 取消，无文件读取、exchange 或假计费', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('照片队列取消测试禁止真实网络'));
  const who = await actor('website.photo.cancelqueued@restaurant.example'), rid = await restaurant(who, '授权照片取消店'), aid = await websitePhoto(rid, who);
  const accepted = await photoGeneration(rid, who, [aid]); assert.equal(accepted.statusCode, 202, accepted.body);
  const jobId = accepted.json().job_id, reads = websiteFileReads(t), fixture = photoReactFixture();
  const cancelled = await cancel(rid, jobId, who); assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.deepEqual((await cancel(rid, jobId, who)).json(), cancelled.json());
  assert.equal(await runWebsiteJobs(pool, config, fixture.client), 0); assert.deepEqual(reads, []); assert.deepEqual(fixture.received, []); assert.deepEqual(fixture.calls, []);
  const result = await photoFailure(rid, jobId, who, 'AGENT_CANCELLED'); assert.deepEqual(result.calls, []);
  assert.equal(result.unknown_usage_calls, 0); assert.deepEqual(result.totals, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  assert.equal((await owner.query("SELECT id FROM audit_logs WHERE entity_id=$1 AND action='website_job_failed'", [jobId])).rowCount, 1);
});

test('真实 PostgreSQL 暂停照片 runner 后账号暂停或 owner 撤权，迟到第 1 次 usage 保留且不再外发', { timeout: 15000 }, async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('照片暂停撤权测试禁止真实网络'));
  for (const reason of ['suspended', 'owner_revoked']) await t.test(reason, async sub => {
    const who = await actor(`website.photo.paused.${reason}@restaurant.example`), rid = await restaurant(who, `暂停照片 ${reason}`), aid = await websitePhoto(rid, who);
    const accepted = await photoGeneration(rid, who, [aid]); assert.equal(accepted.statusCode, 202, accepted.body);
    const jobId = accepted.json().job_id, userId = (await owner.query('SELECT requesting_user_id FROM website_jobs WHERE id=$1', [jobId])).rows[0].requesting_user_id;
    const reads = websiteFileReads(sub); let entered!: () => void, release!: () => void, calls = 0;
    const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const client: WebsiteJobClient = { ...fixtureClient, generate: async () => assert.fail('授权照片不能落回 legacy'),
      react: async (value, brief, snapshot, observe, exchange, signal, images) => {
        assert.equal(exchange, undefined); assert.equal(images!.length, 1); assert.equal(images![0]!.asset_id, aid);
        return runWebsiteAgent(value, brief, snapshot, observe, async (_value, messages) => {
          calls++; assert.equal(calls, 1, '撤权后不得第二次 exchange');
          const user = messages[1]!; assert.equal(user.role, 'user'); assert.ok(Array.isArray(user.content));
          assert.equal(user.content.filter(part => part.type === 'image_url').length, 1);
          entered(); await gate;
          return { message: { role: 'assistant', content: null, tool_calls: [nativeCall('read_context')] }, usage: { ...photoCallUsage } };
        }, signal, images);
      } };
    const running = runWebsiteJobs(pool, config, client);
    try {
      await Promise.race([ready, running.then(() => assert.fail('照片 runner 必须先进入 fixture exchange'))]);
      assert.equal(reads.length, 1);
      const started = await usage(rid, jobId, who); assert.equal(started.calls.length, 1); assert.equal(started.calls[0].status, 'started'); assert.equal(started.unknown_usage_calls, 1);
      await transaction(owner, async db => {
        await db.query("SET LOCAL lock_timeout='500ms'");
        if (reason === 'suspended') await db.query("UPDATE users SET status='suspended' WHERE id=$1", [userId]);
        else await db.query("UPDATE restaurant_members SET status='revoked' WHERE restaurant_id=$1 AND user_id=$2", [rid, userId]);
      });
      release(); assert.equal(await running, 1); assert.equal(calls, 1); assert.equal(reads.length, 1);
      const failed = (await owner.query('SELECT status,error_code,agent_draft,trace,snapshot FROM website_jobs WHERE id=$1', [jobId])).rows[0];
      assert.equal(failed.status, 'failed'); assert.equal(failed.error_code, 'WEBSITE_CONTEXT_REVOKED'); assert.equal(failed.agent_draft, null); noWebsitePixels(failed);
      assert.equal((await request('GET', path(rid, `/jobs/${jobId}`), who)).statusCode, reason === 'suspended' ? 401 : 404);
    } finally {
      release(); await running;
      if (reason === 'suspended') await owner.query("UPDATE users SET status='active' WHERE id=$1", [userId]);
      else await owner.query("UPDATE restaurant_members SET status='active' WHERE restaurant_id=$1 AND user_id=$2", [rid, userId]);
    }
    const result = await photoFailure(rid, jobId, who, 'WEBSITE_CONTEXT_REVOKED');
    assert.equal(result.calls.length, 1); assert.equal(result.calls[0].status, 'completed'); assert.equal(result.unknown_usage_calls, 0); assert.deepEqual(result.totals, photoCallUsage);
    assert.equal(await runWebsiteJobs(pool, config, client), 0);
  });
});
