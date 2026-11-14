import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import type { Pool } from 'pg';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { assertAppDatabase, createPool, id, transaction } from '../src/db.js';
import { migrate } from '../scripts/migrate.js';
import { FLOW_COOKIE, SESSION_COOKIE } from '../src/security.js';
import { registerMenus } from '../src/menu.js';
import { runMenuJobs, type MenuRecognizer } from '../src/menu-worker.js';
import { readConfirmedMenu, readMenuDraft, type MenuJob, type MenuState } from '../src/menu-access.js';
import { normalizeMenuData, type MenuData } from '../src/menu-data.js';
import { runWebsiteJobs, type WebsiteJobClient } from '../src/website-worker.js';
import type { WebsiteJob, WebsiteVersion } from '../src/website-access.js';
import type { Config } from '../src/config.js';

let app: FastifyInstance, pool: Pool, owner: Pool, config: Config, root: string;
let sequence = 0;
const tables = 'website_model_calls,menu_jobs,menu_drafts,website_publish_actions,website_publications,website_jobs,website_versions,website_agents,asset_upload_intents,asset_references,assets,reservations,reservation_events,reservation_access_tokens,audit_logs,email_outbox,opening_hours,restaurant_members,auth_tokens,auth_sessions,auth_identities,restaurants,users';
const password = '菜单测试-Valid-Password-2026!';
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
  instance.register(async routes => {
    if (!routes.hasRoute({ method: 'GET', url: '/api/v1/restaurants/:restaurantId/menu' })) registerMenus(routes, pool, value);
  });
  await instance.ready();
  return instance;
}
before(async () => {
  const databaseUrl = testUrl('TEST_DATABASE_URL', 'restaurant_test_app');
  const migrationDatabaseUrl = testUrl('TEST_MIGRATION_DATABASE_URL', 'restaurant_test_owner');
  root = await mkdtemp('/tmp/restaurant-menu-test-');
  // 仅合成测试配置，不读取 .env.*，不使用真实供应商密钥。
  config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, MIGRATION_DATABASE_URL: migrationDatabaseUrl,
    APP_ORIGIN: 'https://localhost:5173', EMAIL_MODE: 'disabled', STORAGE_MODE: 'local', STORAGE_LOCAL_ROOT: root,
    TOKEN_PEPPER: 'menu-fixture-pepper-'.repeat(3), CURSOR_SECRET: 'menu-fixture-cursor-'.repeat(3), OUTBOX_ENCRYPTION_KEY: 'a2'.repeat(32) });
  config.website = { apiKey: 'fixture-only-not-a-provider-key', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
    publicOrigin: 'http://127.0.0.1:4010', port: 4010, host: '127.0.0.1' };
  owner = createPool(migrationDatabaseUrl); pool = createPool(databaseUrl);
  assert.deepEqual((await owner.query('SELECT current_database() AS db,current_user AS role')).rows[0], { db: 'restaurant_test', role: 'restaurant_test_owner' });
  await migrate(owner, 'restaurant_test_app');
  // 主集成尚未加入 005 时也使用原迁移锁与校验表，不修改迁移器。
  const sql = await readFile(new URL('../migrations/005_menu_vision.sql', import.meta.url), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  await transaction(owner, async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('merchant-core-migrations'))");
    const applied = (await db.query("SELECT checksum FROM schema_migrations WHERE version='005_menu_vision'")).rows[0];
    if (applied) assert.equal(applied.checksum, checksum);
    else {
      await db.query(sql);
      await db.query("INSERT INTO schema_migrations(version,checksum) VALUES('005_menu_vision',$1)", [checksum]);
    }
  });
  await assertAppDatabase(pool);
  await owner.query(`TRUNCATE ${tables}`);
  app = await application();
});
after(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
  if (owner) {
    try {
      const check = (await owner.query('SELECT current_database() AS db,current_user AS role')).rows[0];
      assert.deepEqual(check, { db: 'restaurant_test', role: 'restaurant_test_owner' });
      if ((await owner.query("SELECT to_regclass('public.menu_jobs') AS present")).rows[0].present) await owner.query(`TRUNCATE ${tables}`);
    } finally { await owner.end(); }
  }
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
    remoteAddress: `127.4.${Math.floor(++sequence / 250)}.${sequence % 250 + 1}` });
  assert.equal(response.headers['cache-control'], 'no-store');
  for (const forbidden of ['storage_key', 'storage_backend', 'lease_token', 'request_fingerprint', 'data:image', 'usage', config.website!.apiKey!]) assert.ok(!response.body.includes(forbidden));
  return response;
}
async function actor(email: string): Promise<Actor> {
  const flow = await request('GET', '/auth/csrf', undefined, undefined, { origin: config.appOrigin });
  assert.equal(flow.statusCode, 200, flow.body);
  const anonymous = { email, cookie: cookie(flow, FLOW_COOKIE), csrf: flow.json().csrf_token };
  const registered = await request('POST', '/auth/register', anonymous, { email, password, locale: 'en', terms_version: 'terms-v1', accepted_terms: true });
  assert.equal(registered.statusCode, 202, registered.body);
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
function path(rid: string, suffix = ''): string { return `/restaurants/${rid}/menu${suffix}`; }
async function state(rid: string, actor: Actor): Promise<MenuState> {
  const response = await request('GET', path(rid), actor);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
function recognize(rid: string, actor: Actor, assetIds: string[], expected = 0, key = id('recognize')) {
  return request('POST', path(rid, '/recognitions'), actor, { asset_ids: assetIds, consent_to_ai_processing: true, expected_revision: expected }, { 'idempotency-key': key });
}
function edit(rid: string, actor: Actor, data: MenuData, expected: number) { return request('PATCH', path(rid), actor, { data, expected_revision: expected }); }
function confirm(rid: string, actor: Actor, expected: number) { return request('POST', path(rid, '/confirm'), actor, { expected_revision: expected, confirmed: true }); }
async function upload(rid: string, actor: Actor, mime: 'image/jpeg' | 'image/png' | 'application/pdf' = 'image/png', kind = 'menu_source', supplied?: Buffer) {
  let bytes: Buffer;
  if (supplied) bytes = supplied;
  else if (mime === 'application/pdf') {
    const pdf = await PDFDocument.create(); pdf.addPage([120, 100]); bytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
  } else {
    const image = sharp({ create: { width: 12, height: 8, channels: 3, background: mime === 'image/png' ? '#789abc' : '#aabbcc' } });
    bytes = await (mime === 'image/png' ? image.png() : image.jpeg()).toBuffer();
  }
  const extension = mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'pdf';
  const response = await request('POST', `/restaurants/${rid}/assets?kind=${kind}&original_filename=menu.${extension}&rights_confirmed=true`, actor, bytes,
    { 'content-type': mime, 'idempotency-key': id('upload') });
  assert.equal(response.statusCode, 201, response.body);
  const asset = (await owner.query('SELECT * FROM assets WHERE id=$1', [response.json().id])).rows[0];
  const stored = await readFile(join(root, asset.storage_key));
  assert.equal(createHash('sha256').update(stored).digest('hex'), asset.checksum);
  assert.equal(stored.length, asset.size_bytes);
  return { id: response.json().id as string, bytes: stored, asset };
}
const recognizedData: MenuData = { categories: [{ name: '招牌', items: [
  { name: '面条', description: null, price_text: null, review_note: '价格模糊，请人工核对' },
  { name: '汤', description: '每日现煮', price_text: '12', review_note: null },
] }], warnings: ['请逐项核对识别结果；来源未注明币种'] };
const fixtureRecognizer: MenuRecognizer = async (_config, images) => {
  assert.ok(images.length >= 1 && images.length <= 4);
  for (const image of images) {
    assert.ok(Buffer.isBuffer(image.bytes));
    const metadata = await sharp(image.bytes).metadata();
    assert.equal(metadata.format, image.mime_type === 'image/png' ? 'png' : 'jpeg');
  }
  return { data: structuredClone(recognizedData), model: 'deepseek-flash', usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
};
const fixtureWebsite: WebsiteJobClient = {
  chat: async () => ({ reply: '测试设计回答', design_brief: '测试设计' }),
  generate: async () => ({ html_body: '<section><h1>测试餐厅</h1></section>', css: 'section{padding:2rem}', summary: '测试快照',
    model: 'deepseek-flash', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
};
async function completed(rid: string, actor: Actor, assets: string[], expected = 0) {
  const accepted = await recognize(rid, actor, assets, expected);
  assert.equal(accepted.statusCode, 202, accepted.body);
  assert.equal(await runMenuJobs(pool, config, fixtureRecognizer), 1);
  assert.equal((await state(rid, actor)).jobs[0]!.status, 'succeeded');
  return accepted.json().job_id as string;
}
async function storedJob(jid: string): Promise<MenuJob> { return (await owner.query<MenuJob>('SELECT * FROM menu_jobs WHERE id=$1', [jid])).rows[0]!; }

test('真实 PostgreSQL 菜单视觉识别、人工编辑、确认与来源保护', async t => {
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('菜单测试禁止真实网络及计费模型调用'); });
  const alice = await actor('menu.alice@restaurant.example'), bob = await actor('menu.bob@restaurant.example');
  const rid = await restaurant(alice, '菜单餐厅'), otherRid = await restaurant(bob, '另一位商家餐厅');
  const first = await upload(rid, alice), second = await upload(rid, alice, 'image/jpeg');
  let successfulJob: string;
  await t.test('GET 空状态不创建草稿，不泄露私有字段，归属与认证正确', async () => {
    assert.deepEqual(await state(rid, alice), { draft: null, jobs: [], model: 'deepseek-flash', model_configured: true, input_mode: 'vision', pdf_supported: false });
    assert.equal((await owner.query('SELECT id FROM menu_drafts WHERE restaurant_id=$1', [rid])).rowCount, 0);
    assert.equal((await request('GET', path(rid))).statusCode, 401);
    assert.equal((await request('GET', path(rid), bob)).statusCode, 404);
    assert.equal((await request('GET', path(rid, '?unknown=1'), alice)).statusCode, 400);
    assert.equal(await readMenuDraft(pool, rid), null); assert.equal(await readConfirmedMenu(pool, rid), null);
  });
  await t.test('严格字段、1..4图片、明确同意、CSRF、幂等键与revision校验', async () => {
    const normal = { asset_ids: [first.id], consent_to_ai_processing: true, expected_revision: 0 };
    for (const input of [{ ...normal, unknown: true }, { ...normal, consent_to_ai_processing: false }, { ...normal, consent_to_ai_processing: 'true' },
      { ...normal, accepted_terms: true }, { ...normal, expected_revision: -1 }, { ...normal, expected_revision: null }, { ...normal, expected_revision: '0' },
      { ...normal, asset_ids: [] }, { ...normal, asset_ids: Array.from({ length: 5 }, () => id('ast')) }, { ...normal, asset_ids: [first.id, first.id] }]) {
      assert.equal((await request('POST', path(rid, '/recognitions'), alice, input, { 'idempotency-key': id('test') })).statusCode, 422);
    }
    assert.equal((await request('POST', path(rid, '/recognitions'), alice, normal)).statusCode, 400);
    assert.equal((await request('POST', path(rid, '/recognitions'), { ...alice, csrf: '' }, normal, { 'idempotency-key': id('test') })).statusCode, 403);
    assert.equal((await request('POST', path(rid, '/recognitions'), alice, normal, { 'idempotency-key': id('test'), origin: 'https://evil.example' })).statusCode, 403);
    assert.equal((await recognize(rid, bob, [first.id])).statusCode, 404);
    assert.equal((await recognize(otherRid, bob, [first.id])).statusCode, 404);
    assert.equal((await recognize(rid, alice, [id('ast')])).statusCode, 404);
    const photo = await upload(rid, alice, 'image/png', 'restaurant_photo');
    assert.equal((await recognize(rid, alice, [photo.id])).statusCode, 422);
    const pdf = await upload(rid, alice, 'application/pdf');
    const rejected = await recognize(rid, alice, [pdf.id]);
    assert.equal(rejected.statusCode, 422); assert.equal(rejected.json().code, 'PDF_MENU_UNSUPPORTED');
    assert.equal((await owner.query('SELECT id FROM menu_jobs WHERE restaurant_id=$1', [rid])).rowCount, 0);
    assert.equal((await owner.query('SELECT id FROM menu_drafts WHERE restaurant_id=$1', [rid])).rowCount, 0);
  });
  await t.test('真实大图单张10MiB、合计20MiB边界，失败不创建任务或引用', async () => {
    const large = await sharp(randomBytes(1700 * 1700 * 3), { raw: { width: 1700, height: 1700, channels: 3 } }).png().toBuffer();
    assert.ok(large.length < 10 * 1024 * 1024 && large.length * 3 > 20 * 1024 * 1024);
    const images = [];
    for (let i = 0; i < 3; i++) images.push(await upload(rid, alice, 'image/png', 'menu_source', large));
    const rejected = await recognize(rid, alice, images.map(image => image.id));
    assert.equal(rejected.statusCode, 413); assert.equal(rejected.json().code, 'MENU_IMAGES_TOO_LARGE');
    assert.equal((await owner.query('SELECT id FROM menu_jobs WHERE restaurant_id=$1', [rid])).rowCount, 0);
    const oversized = await request('POST', `/restaurants/${rid}/assets?kind=menu_source&original_filename=menu.png&rights_confirmed=true`, alice, Buffer.alloc(10 * 1024 * 1024 + 1),
      { 'content-type': 'image/png', 'idempotency-key': id('upload') });
    assert.equal(oversized.statusCode, 413);
  });
  await t.test('缺模型配置不创建任务，GET、编辑和人工确认仍可使用', async () => {
    await app.close(); app = await application({ ...config, website: { ...config.website!, apiKey: undefined } });
    try {
      assert.equal((await state(rid, alice)).model_configured, false);
      const response = await recognize(rid, alice, [first.id]);
      assert.equal(response.statusCode, 503); assert.equal(response.json().code, 'AI_NOT_CONFIGURED');
    } finally { await app.close(); app = await application(); }
  });
  await t.test('两张真实编码图片到worker，接受不改菜单，来源快照与引用原子保存', async () => {
    const key = id('recognize');
    const accepted = await recognize(rid, alice, [second.id, first.id], 0, key);
    assert.equal(accepted.statusCode, 202, accepted.body); successfulJob = accepted.json().job_id;
    const queued = await state(rid, alice);
    assert.deepEqual(queued.draft, { revision: 0, status: 'empty', data: { categories: [], warnings: [] }, source_asset_ids: [], confirmed_at: null });
    assert.equal((await recognize(rid, alice, [first.id])).json().code, 'MENU_JOB_BUSY');
    assert.equal((await edit(rid, alice, recognizedData, 0)).json().code, 'MENU_JOB_BUSY');
    assert.equal((await confirm(rid, alice, 0)).json().code, 'MENU_JOB_BUSY');
    const websiteBusy = await request('POST', `/restaurants/${rid}/website/generations`, alice,
      { brief: '菜单入队时禁止生成网页', asset_ids: [], public_assets_confirmed: true, expected_restaurant_revision: 1, expected_menu_revision: 0 },
      { 'idempotency-key': id('generate') });
    assert.equal(websiteBusy.statusCode, 409); assert.equal(websiteBusy.json().code, 'MENU_JOB_BUSY');
    assert.equal((await owner.query('SELECT id FROM website_jobs WHERE restaurant_id=$1', [rid])).rowCount, 0);
    const saved = await storedJob(successfulJob);
    assert.deepEqual(saved.input.asset_ids, [second.id, first.id]);
    assert.deepEqual(Object.keys(saved.sources[0]!).sort(), ['id', 'mime_type', 'checksum', 'size_bytes', 'storage_key', 'storage_backend'].sort());
    assert.equal((await request('DELETE', `/restaurants/${rid}/assets/${first.id}`, alice, undefined, { 'if-match': `"asset-${first.id}-v1"` })).json().code, 'ASSET_IN_USE');
    await app.close(); await pool.end(); pool = createPool(config.databaseUrl); app = await application();
    const inspect: MenuRecognizer = async (value, images) => {
      assert.deepEqual(images.map(image => image.mime_type), ['image/jpeg', 'image/png']);
      assert.deepEqual(images[0]!.bytes, second.bytes); assert.deepEqual(images[1]!.bytes, first.bytes);
      assert.deepEqual(images.map(image => createHash('sha256').update(image.bytes).digest('hex')), saved.sources.map(source => source.checksum));
      return fixtureRecognizer(value, images);
    };
    assert.equal(await runMenuJobs(pool, config, inspect), 1);
    const done = await state(rid, alice);
    assert.equal(done.draft!.revision, 1); assert.equal(done.draft!.status, 'draft'); assert.deepEqual(done.draft!.data, recognizedData);
    assert.deepEqual(done.draft!.source_asset_ids, [second.id, first.id]); assert.equal(done.jobs[0]!.result_revision, 1);
    await assert.rejects(readConfirmedMenu(pool, rid), { code: 'MENU_CONFIRM_REQUIRED' });
    assert.equal((await recognize(rid, alice, [second.id, first.id], 0, key)).json().job_id, successfulJob);
    assert.equal((await recognize(rid, alice, [first.id, second.id], 0, key)).json().code, 'IDEMPOTENCY_CONFLICT');
    const changed = structuredClone(recognizedData); changed.categories[0]!.items[0]!.name = '人工修正面条';
    assert.equal((await edit(rid, alice, changed, 1)).statusCode, 200);
    assert.equal((await edit(rid, alice, recognizedData, 1)).json().code, 'MENU_REVISION_CONFLICT');
    assert.equal((await confirm(rid, alice, 2)).statusCode, 200);
    const confirmed = (await state(rid, alice)).draft!;
    assert.equal(confirmed.status, 'confirmed'); assert.equal(confirmed.revision, 3); assert.ok(confirmed.confirmed_at);
    assert.equal(confirmed.data.categories[0]!.items[0]!.price_text, null);
    assert.ok(confirmed.data.categories[0]!.items[0]!.review_note); assert.deepEqual(confirmed.data.warnings, recognizedData.warnings);
    assert.deepEqual(await readConfirmedMenu(pool, rid), { revision: 3, data: changed });
    assert.equal((await confirm(rid, alice, 2)).json().code, 'MENU_REVISION_CONFLICT');
    assert.deepEqual((await confirm(rid, alice, 3)).json(), confirmed);
    assert.equal((await recognize(rid, alice, [second.id, first.id], 0, key)).json().job_id, successfulJob);
    assert.equal((await owner.query("SELECT id FROM asset_references WHERE purpose='menu_job' AND resource_id=$1", [successfulJob])).rowCount, 2);
  });
  await t.test('422空确认，PATCH强字段与CSRF，1MiB允许完整80项多字节描述，不伪造价格', async () => {
    const emptyRid = await restaurant(bob, '空菜单店');
    assert.equal((await confirm(emptyRid, bob, 0)).json().code, 'MENU_EMPTY');
    assert.equal((await edit(emptyRid, bob, { categories: [], warnings: [] }, 0)).statusCode, 200);
    assert.equal((await confirm(emptyRid, bob, 1)).json().code, 'MENU_EMPTY');
    const data: MenuData = { categories: [{ name: '大菜单', items: Array.from({ length: 80 }, (_, i) => ({ name: `菜${i}`, description: '𠮷'.repeat(900), price_text: null, review_note: null })) }], warnings: [] };
    assert.ok(Buffer.byteLength(JSON.stringify({ data, expected_revision: 1 })) > 32768);
    assert.equal((await edit(emptyRid, bob, data, 1)).statusCode, 200);
    assert.equal((await confirm(emptyRid, bob, 2)).statusCode, 200);
    assert.equal((await request('PATCH', path(emptyRid), bob, { data: { ...data, secret: true }, expected_revision: 3 })).json().code, 'MENU_DATA_INVALID');
    assert.equal((await request('PATCH', path(emptyRid), bob, { data, expected_revision: 3, unknown: true })).statusCode, 422);
    assert.equal((await request('PATCH', path(emptyRid), { ...bob, csrf: '' }, { data, expected_revision: 3 })).statusCode, 403);
    assert.equal((await request('POST', path(emptyRid, '/confirm'), bob, { expected_revision: 3, confirmed: false })).statusCode, 422);
    assert.equal((await request('POST', path(emptyRid, '/confirm'), { ...bob, csrf: '' }, { expected_revision: 3, confirmed: true })).statusCode, 403);
    assert.equal((await request('PATCH', path(emptyRid), bob, { data: { categories: [], warnings: ['x'.repeat(1100000)] }, expected_revision: 3 })).statusCode, 413);
  });
  await t.test('402及非法模型输出保留旧confirmed，失败只释放自己的引用与安全错误码', async () => {
    const previous = (await state(rid, alice)).draft!;
    const newSource = await upload(rid, alice);
    const accepted = await recognize(rid, alice, [newSource.id], previous.revision); assert.equal(accepted.statusCode, 202);
    const failing: MenuRecognizer = async () => { throw Object.assign(new Error('禁止泄漏菜单、私有来源与密钥'), { status: 402 }); };
    assert.equal(await runMenuJobs(pool, config, failing), 1);
    const failed = await state(rid, alice);
    assert.deepEqual(failed.draft, previous); assert.equal(failed.jobs[0]!.error_code, 'AI_BALANCE_INSUFFICIENT');
    assert.equal((await owner.query('SELECT id FROM asset_references WHERE resource_id=$1', [accepted.json().job_id])).rowCount, 0);
    assert.equal((await owner.query('SELECT id FROM asset_references WHERE resource_id=$1', [successfulJob])).rowCount, 2);
    assert.deepEqual(await readFile(join(root, newSource.asset.storage_key)), newSource.bytes);
    const invalid = await recognize(rid, alice, [newSource.id], previous.revision); assert.equal(invalid.statusCode, 202);
    const wrong: MenuRecognizer = async () => ({ data: { ...recognizedData, unexpected: '不可进入菜单' } as MenuData, model: 'deepseek-flash', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    assert.equal(await runMenuJobs(pool, config, wrong), 1);
    assert.equal((await state(rid, alice)).jobs[0]!.error_code, 'AI_OUTPUT_INVALID'); assert.deepEqual((await state(rid, alice)).draft, previous);
    assert.equal(await runMenuJobs(pool, config, failing), 0);
  });
  await t.test('新识别可替换当前来源，成功旧来源与网页历史不清理', async () => {
    const previous = (await state(rid, alice)).draft!;
    const replacement = await upload(rid, alice);
    await completed(rid, alice, [replacement.id], previous.revision);
    assert.deepEqual((await state(rid, alice)).draft!.source_asset_ids, [replacement.id]);
    assert.equal((await owner.query('SELECT id FROM asset_references WHERE resource_id=$1', [successfulJob])).rowCount, 2);
    assert.equal((await request('DELETE', `/restaurants/${rid}/assets/${first.id}`, alice, undefined, { 'if-match': `"asset-${first.id}-v1"` })).statusCode, 409);
    assert.equal((await confirm(rid, alice, previous.revision + 1)).statusCode, 200);
  });
  await t.test('不存在、校验和篡改与任意失败来源均在付费前失败', async () => {
    const previous = (await state(rid, alice)).draft!;
    for (const mode of ['missing', 'corrupt', 'metadata'] as const) {
      const source = await upload(rid, alice), filename = join(root, source.asset.storage_key), held = filename + '.held';
      const selected = mode === 'missing' ? [first.id, source.id] : [source.id];
      const accepted = await recognize(rid, alice, selected, previous.revision); assert.equal(accepted.statusCode, 202);
      if (mode === 'missing') await rename(filename, held);
      else if (mode === 'corrupt') await writeFile(filename, Buffer.alloc(source.bytes.length, 0));
      else await owner.query('UPDATE assets SET checksum=$2 WHERE id=$1', [source.id, '0'.repeat(64)]);
      let calls = 0;
      try {
        assert.equal(await runMenuJobs(pool, config, async (...args) => { calls++; return fixtureRecognizer(...args); }), 1);
        assert.equal(calls, 0); assert.equal((await state(rid, alice)).jobs[0]!.error_code, 'MENU_SOURCE_UNAVAILABLE');
        assert.deepEqual((await state(rid, alice)).draft, previous);
      } finally {
        if (mode === 'missing') await rename(held, filename);
        else if (mode === 'corrupt') await writeFile(filename, source.bytes);
        else await owner.query('UPDATE assets SET checksum=$2 WHERE id=$1', [source.id, source.asset.checksum]);
      }
    }
  });
  await t.test('过期租约只失败不重试，已撤销owner或账号不调用provider', async () => {
    const source = await upload(rid, alice), expected = (await state(rid, alice)).draft!.revision;
    const accepted = await recognize(rid, alice, [source.id], expected); assert.equal(accepted.statusCode, 202);
    await owner.query("UPDATE menu_jobs SET status='running',lease_token=$2,lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [accepted.json().job_id, randomUUID()]);
    let calls = 0;
    const noPaid: MenuRecognizer = async (...args) => { calls++; return fixtureRecognizer(...args); };
    assert.equal(await runMenuJobs(pool, config, noPaid), 1); assert.equal(calls, 0);
    assert.equal((await state(rid, alice)).jobs[0]!.error_code, 'JOB_INTERRUPTED');
    assert.equal(await runMenuJobs(pool, config, noPaid), 0);
    const revoke = await recognize(rid, alice, [source.id], expected); assert.equal(revoke.statusCode, 202);
    await owner.query("UPDATE restaurant_members SET status='revoked' WHERE restaurant_id=$1", [rid]);
    try {
      assert.equal(await runMenuJobs(pool, config, noPaid), 1); assert.equal(calls, 0);
      assert.equal((await storedJob(revoke.json().job_id)).error_code, 'MENU_CONTEXT_REVOKED');
    } finally { await owner.query("UPDATE restaurant_members SET status='active' WHERE restaurant_id=$1", [rid]); }
  });
  await t.test('模型调用不占行锁，完成前revision或owner改变丢弃结果', async () => {
    const source = await upload(rid, alice), previous = (await state(rid, alice)).draft!;
    const accepted = await recognize(rid, alice, [source.id], previous.revision); assert.equal(accepted.statusCode, 202);
    const change: MenuRecognizer = async (...args) => {
      await transaction(owner, async db => {
        await db.query("SET LOCAL lock_timeout='500ms'");
        await db.query('SELECT id FROM users WHERE email_normalized=$1 FOR UPDATE', [alice.email]);
        await db.query('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE', [rid]);
        await db.query('UPDATE menu_drafts SET revision=revision+1 WHERE restaurant_id=$1', [rid]);
      });
      return fixtureRecognizer(...args);
    };
    assert.equal(await runMenuJobs(pool, config, change), 1);
    assert.equal((await state(rid, alice)).jobs[0]!.error_code, 'MENU_CONTEXT_CHANGED');
    assert.deepEqual((await state(rid, alice)).draft!.data, previous.data);
    const revoke = await recognize(rid, alice, [source.id], previous.revision + 1); assert.equal(revoke.statusCode, 202);
    const disable: MenuRecognizer = async (...args) => {
      await owner.query("UPDATE users SET status='suspended' WHERE email_normalized=$1", [alice.email]);
      return fixtureRecognizer(...args);
    };
    try {
      assert.equal(await runMenuJobs(pool, config, disable), 1);
      assert.equal((await storedJob(revoke.json().job_id)).error_code, 'MENU_CONTEXT_REVOKED');
    } finally { await owner.query("UPDATE users SET status='active' WHERE email_normalized=$1", [alice.email]); }
  });
  await t.test('引用保存失败整体回滚，失败审计失败不半释放来源', async () => {
    const atomicRid = await restaurant(bob, '菜单原子事务店'), source = await upload(atomicRid, bob);
    await owner.query('REVOKE INSERT ON asset_references FROM restaurant_test_app');
    try {
      assert.equal((await recognize(atomicRid, bob, [source.id])).statusCode, 503);
      assert.equal((await owner.query('SELECT id FROM menu_jobs WHERE restaurant_id=$1', [atomicRid])).rowCount, 0);
      assert.equal(await readMenuDraft(pool, atomicRid), null);
    } finally { await owner.query('GRANT INSERT ON asset_references TO restaurant_test_app'); }
    const accepted = await recognize(atomicRid, bob, [source.id]); assert.equal(accepted.statusCode, 202);
    await owner.query('REVOKE INSERT ON audit_logs FROM restaurant_test_app');
    const failing: MenuRecognizer = async () => { throw Object.assign(new Error('不可泄漏'), { status: 402 }); };
    try {
      await assert.rejects(runMenuJobs(pool, config, failing), { code: '42501' });
      assert.equal((await storedJob(accepted.json().job_id)).status, 'running');
      assert.equal((await owner.query('SELECT id FROM asset_references WHERE resource_id=$1', [accepted.json().job_id])).rowCount, 1);
      assert.equal((await readMenuDraft(pool, atomicRid))!.revision, 0);
    } finally { await owner.query('GRANT INSERT ON audit_logs TO restaurant_test_app'); }
    // 保留中断的 running 夹具，终态由真实租约恢复协议处理；after 统一清空独立测试库。
  });
  await t.test('空识别结果仅成为draft，不能确认或制造替代菜单', async () => {
    const emptyRid = await restaurant(bob, '识别为空店'), source = await upload(emptyRid, bob);
    const accepted = await request('POST', path(emptyRid, '/recognitions'), bob, { asset_ids: [source.id], consent_to_ai_processing: true }, { 'idempotency-key': id('recognize') });
    assert.equal(accepted.statusCode, 202); assert.equal((await storedJob(accepted.json().job_id)).expected_revision, 0);
    const empty: MenuRecognizer = async () => ({ data: { categories: [], warnings: ['图片无法辨认，请人工填写'] }, model: 'deepseek-flash', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    assert.equal(await runMenuJobs(pool, config, empty), 1);
    assert.equal((await state(emptyRid, bob)).draft!.status, 'draft');
    assert.deepEqual((await state(emptyRid, bob)).draft!.data.categories, []);
    assert.equal((await confirm(emptyRid, bob, 1)).json().code, 'MENU_EMPTY');
  });
  await t.test('菜单及网页worker共享两个全局槽位，第三runner不能计费', async () => {
    const concurrent = await actor('menu.concurrent@restaurant.example');
    const rids = await Promise.all(['并发菜单甲', '并发菜单乙', '并发菜单丙'].map(name => restaurant(concurrent, name)));
    for (const value of rids) { const source = await upload(value, concurrent); assert.equal((await recognize(value, concurrent, [source.id])).statusCode, 202); }
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    const slow: MenuRecognizer = async (...args) => { entered(); await gate; return fixtureRecognizer(...args); };
    const guard = await pool.connect();
    await guard.query('SELECT pg_advisory_lock(771042,1)');
    const running = runMenuJobs(pool, config, slow);
    try {
      await ready;
      assert.equal(await runMenuJobs(pool, config, fixtureRecognizer), 0);
      assert.equal(await runWebsiteJobs(pool, config, fixtureWebsite), 0);
    } finally {
      release(); await guard.query('SELECT pg_advisory_unlock(771042,1)'); guard.release();
    }
    assert.equal(await running, 1);
    assert.equal(await runMenuJobs(pool, config, fixtureRecognizer), 1);
    assert.equal(await runMenuJobs(pool, config, fixtureRecognizer), 1);
  });
  await t.test('确认菜单到网页端到端：文字价格快照、内部备注隔离、历史版本冻结且不读取源图片', async () => {
    const merchant = await actor('menu.website-e2e@restaurant.example'), webRid = await restaurant(merchant, '菜单网页闭环店');
    const png = await upload(webRid, merchant), jpg = await upload(webRid, merchant, 'image/jpeg');
    await completed(webRid, merchant, [png.id, jpg.id]);
    const firstData = structuredClone(recognizedData);
    const item = firstData.categories[0]!.items[0]!;
    item.name = '招牌手工面'; item.price_text = '¥18.50 / 碗'; item.review_note = '内部复核标记：原图价格已人工核对';
    firstData.warnings = ['内部警告标记：不应展示给网站访客'];
    const edited = await edit(webRid, merchant, firstData, 1);
    assert.equal(edited.statusCode, 200, edited.body);
    const draftRevision = edited.json().revision as number;
    const generationBody = { brief: '展示已经人工确认的菜单', asset_ids: [], public_assets_confirmed: true, expected_restaurant_revision: 1 };
    const unconfirmed = await request('POST', `/restaurants/${webRid}/website/generations`, merchant,
      { ...generationBody, expected_menu_revision: draftRevision }, { 'idempotency-key': id('generate') });
    assert.equal(unconfirmed.statusCode, 409); assert.equal(unconfirmed.json().code, 'MENU_CONFIRM_REQUIRED');
    assert.equal((await owner.query('SELECT id FROM website_jobs WHERE restaurant_id=$1', [webRid])).rowCount, 0);
    const draftWebsite = await request('GET', `/restaurants/${webRid}/website`, merchant);
    assert.equal(draftWebsite.statusCode, 200, draftWebsite.body);
    assert.equal(draftWebsite.json().menu_recognition_enabled, true);
    assert.deepEqual(draftWebsite.json().menu, { revision: draftRevision, status: 'draft', item_count: 2 });
    const confirmed = await confirm(webRid, merchant, draftRevision);
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    const firstRevision = confirmed.json().revision as number;
    let expectedMenu = await readConfirmedMenu(pool, webRid);
    assert.deepEqual(expectedMenu, { revision: firstRevision, data: firstData });
    const confirmedWebsite = await request('GET', `/restaurants/${webRid}/website`, merchant);
    assert.equal(confirmedWebsite.statusCode, 200, confirmedWebsite.body);
    assert.deepEqual(confirmedWebsite.json().menu, { revision: firstRevision, status: 'confirmed', item_count: 2 });
    let calls = 0;
    const menuWebsite: WebsiteJobClient = { ...fixtureWebsite, generate: async (_config, brief, snapshot) => {
      calls++;
      assert.equal(brief, generationBody.brief);
      assert.deepEqual(snapshot.menu, expectedMenu);
      assert.deepEqual(snapshot.assets, []);
      const serialized = JSON.stringify(snapshot);
      for (const forbidden of [png.id, jpg.id, 'storage_key', 'storage_backend', 'data:image', '"bytes"']) assert.ok(!serialized.includes(forbidden));
      // 只返回布局占位组件；菜名和价格必须由真实 renderer 从确认快照填充。
      return { html_body: '<section><h1><restaurant-name></restaurant-name></h1><restaurant-menu></restaurant-menu></section>',
        css: 'section{padding:2rem}', summary: '已确认菜单测试网站', model: 'deepseek-flash',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    } };
    const hidden: Array<{ filename: string; held: string }> = [];
    try {
      // 暂移两张真实上传图片：入队、快照、runner 与预览均应只使用结构化菜单。
      for (const source of [png, jpg]) {
        const filename = join(root, source.asset.storage_key), held = filename + '.held';
        await rename(filename, held); hidden.push({ filename, held });
      }
      const firstAccepted = await request('POST', `/restaurants/${webRid}/website/generations`, merchant,
        { ...generationBody, expected_menu_revision: firstRevision }, { 'idempotency-key': id('generate') });
      assert.equal(firstAccepted.statusCode, 202, firstAccepted.body);
      const queued = (await owner.query<WebsiteJob>('SELECT * FROM website_jobs WHERE id=$1', [firstAccepted.json().job_id])).rows[0]!;
      assert.equal(queued.status, 'queued'); assert.deepEqual(queued.input, { ...generationBody, expected_menu_revision: firstRevision });
      assert.deepEqual(queued.snapshot.menu, { revision: firstRevision, data: firstData });
      assert.deepEqual(queued.snapshot.assets, []);
      assert.equal(await runWebsiteJobs(pool, config, menuWebsite), 1);
      const firstJob = (await owner.query<WebsiteJob>('SELECT * FROM website_jobs WHERE id=$1', [queued.id])).rows[0]!;
      assert.equal(firstJob.status, 'succeeded'); assert.ok(firstJob.result_version_id);
      const firstVersion = (await owner.query<WebsiteVersion>('SELECT * FROM website_versions WHERE id=$1', [firstJob.result_version_id])).rows[0]!;
      assert.deepEqual(firstVersion.snapshot.menu, { revision: firstRevision, data: firstData });
      assert.deepEqual(firstVersion.snapshot.assets, []); assert.deepEqual(firstVersion.asset_ids, []);
      assert.equal(createHash('sha256').update(firstVersion.html).digest('hex'), firstVersion.checksum);
      const firstPreview = await request('GET', `/restaurants/${webRid}/website/versions/${firstVersion.id}/preview`, merchant);
      assert.equal(firstPreview.statusCode, 200, firstPreview.body);
      assert.equal(firstPreview.json().html, firstVersion.html); assert.equal(firstPreview.json().checksum, firstVersion.checksum);
      assert.deepEqual(firstPreview.json().assets, []);
      assert.ok(firstVersion.html.includes(item.name)); assert.ok(firstVersion.html.includes(`<span class="site-menu-price">${item.price_text}</span>`));
      assert.ok(firstVersion.html.includes('<span class="site-menu-price">12</span>'));
      assert.ok(firstVersion.html.includes(`data-menu-revision="${firstRevision}"`));
      for (const internal of [item.review_note!, ...firstData.warnings, 'review_note', 'warnings']) {
        assert.ok(!firstVersion.html.includes(internal)); assert.ok(!firstPreview.body.includes(internal));
      }
      const nextData = structuredClone(firstData), nextPrice = '¥23.75 / 碗';
      nextData.categories[0]!.items[0]!.price_text = nextPrice;
      const updated = await edit(webRid, merchant, nextData, firstRevision);
      assert.equal(updated.statusCode, 200, updated.body);
      const nextConfirmed = await confirm(webRid, merchant, updated.json().revision);
      assert.equal(nextConfirmed.statusCode, 200, nextConfirmed.body);
      const nextRevision = nextConfirmed.json().revision as number;
      expectedMenu = await readConfirmedMenu(pool, webRid);
      assert.deepEqual(expectedMenu, { revision: nextRevision, data: nextData });
      const stale = await request('POST', `/restaurants/${webRid}/website/generations`, merchant,
        { ...generationBody, expected_menu_revision: firstRevision }, { 'idempotency-key': id('generate') });
      assert.equal(stale.statusCode, 409); assert.equal(stale.json().code, 'MENU_REVISION_CONFLICT');
      assert.equal((await owner.query('SELECT id FROM website_jobs WHERE restaurant_id=$1', [webRid])).rowCount, 1);
      const nextAccepted = await request('POST', `/restaurants/${webRid}/website/generations`, merchant,
        { ...generationBody, expected_menu_revision: nextRevision }, { 'idempotency-key': id('generate') });
      assert.equal(nextAccepted.statusCode, 202, nextAccepted.body);
      assert.equal(await runWebsiteJobs(pool, config, menuWebsite), 1); assert.equal(calls, 2);
      const nextJob = (await owner.query<WebsiteJob>('SELECT * FROM website_jobs WHERE id=$1', [nextAccepted.json().job_id])).rows[0]!;
      assert.equal(nextJob.status, 'succeeded'); assert.ok(nextJob.result_version_id);
      const nextVersion = (await owner.query<WebsiteVersion>('SELECT * FROM website_versions WHERE id=$1', [nextJob.result_version_id])).rows[0]!;
      assert.notEqual(nextVersion.id, firstVersion.id);
      assert.deepEqual(nextVersion.snapshot.menu, { revision: nextRevision, data: nextData });
      assert.deepEqual(nextVersion.snapshot.assets, []); assert.deepEqual(nextVersion.asset_ids, []);
      assert.equal(createHash('sha256').update(nextVersion.html).digest('hex'), nextVersion.checksum);
      assert.notEqual(nextVersion.checksum, firstVersion.checksum);
      const nextPreview = await request('GET', `/restaurants/${webRid}/website/versions/${nextVersion.id}/preview`, merchant);
      assert.equal(nextPreview.statusCode, 200, nextPreview.body);
      assert.equal(nextPreview.json().html, nextVersion.html); assert.equal(nextPreview.json().checksum, nextVersion.checksum);
      assert.ok(nextPreview.json().html.includes(item.name)); assert.ok(nextPreview.json().html.includes(nextPrice));
      assert.ok(!nextPreview.json().html.includes(item.price_text!));
      for (const internal of [item.review_note!, ...firstData.warnings, 'review_note', 'warnings']) assert.ok(!nextPreview.body.includes(internal));
      const oldVersion = (await owner.query<WebsiteVersion>('SELECT * FROM website_versions WHERE id=$1', [firstVersion.id])).rows[0]!;
      assert.deepEqual(oldVersion, firstVersion);
      assert.deepEqual((await owner.query<WebsiteJob>('SELECT * FROM website_jobs WHERE id=$1', [firstJob.id])).rows[0], firstJob);
      const oldPreview = await request('GET', `/restaurants/${webRid}/website/versions/${firstVersion.id}/preview`, merchant);
      assert.equal(oldPreview.statusCode, 200, oldPreview.body);
      assert.deepEqual(oldPreview.json(), firstPreview.json());
      assert.ok(oldPreview.json().html.includes(item.price_text!)); assert.ok(!oldPreview.json().html.includes(nextPrice));
    } finally {
      for (const source of hidden.reverse()) await rename(source.held, source.filename);
    }
  });
  await t.test('网页busy拒识别但允许编辑确认，菜单变更不修改既有网页行', async () => {
    const webRid = await restaurant(bob, '冻结网站店'), source = await upload(webRid, bob);
    const photo = await upload(webRid, bob, 'image/png', 'restaurant_photo');
    assert.equal((await edit(webRid, bob, recognizedData, 0)).statusCode, 200);
    assert.equal((await confirm(webRid, bob, 1)).statusCode, 200);
    const generation = await request('POST', `/restaurants/${webRid}/website/generations`, bob, { brief: '仅测试页面快照', asset_ids: [photo.id], public_assets_confirmed: true, expected_restaurant_revision: 1 }, { 'idempotency-key': id('generate') });
    assert.equal(generation.statusCode, 202, generation.body);
    assert.equal((await recognize(webRid, bob, [source.id], 2)).json().code, 'WEBSITE_JOB_BUSY');
    assert.equal((await edit(webRid, bob, recognizedData, 2)).statusCode, 200);
    assert.equal((await confirm(webRid, bob, 3)).statusCode, 200);
    assert.equal(await runWebsiteJobs(pool, config, fixtureWebsite), 1);
    const before = (await owner.query('SELECT * FROM website_versions WHERE restaurant_id=$1 ORDER BY id', [webRid])).rows;
    const jobs = (await owner.query('SELECT * FROM website_jobs WHERE restaurant_id=$1 ORDER BY id', [webRid])).rows;
    assert.ok(before.length > 0);
    assert.equal((await edit(webRid, bob, recognizedData, 4)).statusCode, 200);
    assert.equal((await confirm(webRid, bob, 5)).statusCode, 200);
    assert.deepEqual((await owner.query('SELECT * FROM website_versions WHERE restaurant_id=$1 ORDER BY id', [webRid])).rows, before);
    assert.deepEqual((await owner.query('SELECT * FROM website_jobs WHERE restaurant_id=$1 ORDER BY id', [webRid])).rows, jobs);
    await assert.rejects(pool.query("DELETE FROM asset_references WHERE purpose='website_job' AND resource_id=$1", [generation.json().job_id]), { code: '42501' });
    const next = await request('POST', `/restaurants/${webRid}/website/generations`, bob, { brief: '网页引用失败恢复测试', asset_ids: [photo.id], public_assets_confirmed: true, expected_restaurant_revision: 1 }, { 'idempotency-key': id('generate') });
    assert.equal(next.statusCode, 202);
    const failure: WebsiteJobClient = { ...fixtureWebsite, generate: async () => { throw Object.assign(new Error('不可泄漏'), { status: 402 }); } };
    assert.equal(await runWebsiteJobs(pool, config, failure), 1);
    assert.equal((await owner.query('SELECT id FROM asset_references WHERE resource_id=$1', [next.json().job_id])).rowCount, 0);
    assert.equal((await owner.query("SELECT id FROM asset_references WHERE purpose='website_job' AND resource_id=$1", [generation.json().job_id])).rowCount, 1);
    assert.deepEqual((await owner.query('SELECT * FROM website_versions WHERE restaurant_id=$1 ORDER BY id', [webRid])).rows, before);
  });
  await t.test('每日菜单+网页合计30，锁用户防跨店并发越额，满额可重放', async () => {
    const quotaActor = await actor('menu.quota@restaurant.example');
    const quotaRid = await restaurant(quotaActor, '共享配额甲'), nextRid = await restaurant(quotaActor, '共享配额乙');
    const source = await upload(quotaRid, quotaActor), nextSource = await upload(nextRid, quotaActor);
    const key = id('quota'), accepted = await recognize(quotaRid, quotaActor, [source.id], 0, key);
    assert.equal(accepted.statusCode, 202); assert.equal(await runMenuJobs(pool, config, fixtureRecognizer), 1);
    const original = await storedJob(accepted.json().job_id);
    for (let i = 0; i < 28; i++) await owner.query(`INSERT INTO website_jobs(id,restaurant_id,requesting_user_id,kind,status,idempotency_key,request_fingerprint,input,snapshot,error_code)
      VALUES($1,$2,$3,'generate','failed',$4,$5,'{}','{}','AI_PROVIDER_UNAVAILABLE')`, [id('wsj'), quotaRid, original.requesting_user_id, id('quota'), '0'.repeat(64)]);
    const results = await Promise.all([recognize(quotaRid, quotaActor, [source.id], 1), recognize(nextRid, quotaActor, [nextSource.id])]);
    assert.deepEqual(results.map(response => response.statusCode).sort(), [202, 429]);
    assert.equal(results.find(response => response.statusCode === 429)!.json().code, 'MENU_DAILY_LIMIT');
    assert.equal((await recognize(quotaRid, quotaActor, [source.id], 0, key)).json().job_id, original.id);
    assert.equal(await runMenuJobs(pool, config, fixtureRecognizer), 1);
    assert.equal((await recognize(nextRid, quotaActor, [nextSource.id], (await state(nextRid, quotaActor)).draft?.revision ?? 0)).statusCode, 429);
    const websiteLimited = await request('POST', `/restaurants/${nextRid}/website/generations`, quotaActor,
      { brief: '混合菜单和网页任务共享额度', asset_ids: [], public_assets_confirmed: true, expected_restaurant_revision: 1 },
      { 'idempotency-key': id('generate') });
    assert.equal(websiteLimited.statusCode, 429); assert.equal(websiteLimited.json().code, 'WEBSITE_DAILY_LIMIT');
    assert.equal((await owner.query('SELECT id FROM website_jobs WHERE restaurant_id=$1', [nextRid])).rowCount, 0);
  });
  await t.test('仅菜单任务已满30次也阻止本店与跨店网页生成，原菜单任务仍能重放', async () => {
    const merchant = await actor('menu.website-quota@restaurant.example');
    const menuRid = await restaurant(merchant, '菜单额度已满店'), otherRid = await restaurant(merchant, '同用户无菜单店');
    const source = await upload(menuRid, merchant), key = id('quota');
    const accepted = await recognize(menuRid, merchant, [source.id], 0, key);
    assert.equal(accepted.statusCode, 202, accepted.body);
    assert.equal(await runMenuJobs(pool, config, fixtureRecognizer), 1);
    const confirmed = await confirm(menuRid, merchant, 1);
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    const original = await storedJob(accepted.json().job_id);
    for (let i = 0; i < 29; i++) await owner.query(`INSERT INTO menu_jobs(id,restaurant_id,requesting_user_id,status,idempotency_key,request_fingerprint,input,sources,expected_revision,error_code)
      VALUES($1,$2,$3,'failed',$4,$5,$6,$7,0,'AI_PROVIDER_UNAVAILABLE')`,
      [id('mnj'), menuRid, original.requesting_user_id, id('quota'), '0'.repeat(64), JSON.stringify(original.input), JSON.stringify(original.sources)]);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM menu_jobs WHERE requesting_user_id=$1', [original.requesting_user_id])).rows[0].n, 30);
    for (const [targetRid, revision] of [[menuRid, confirmed.json().revision], [otherRid, 0]] as const) {
      const limited = await request('POST', `/restaurants/${targetRid}/website/generations`, merchant,
        { brief: '菜单额度满后禁止网页计费', asset_ids: [], public_assets_confirmed: true, expected_restaurant_revision: 1, expected_menu_revision: revision },
        { 'idempotency-key': id('generate') });
      assert.equal(limited.statusCode, 429); assert.equal(limited.json().code, 'WEBSITE_DAILY_LIMIT');
    }
    assert.equal((await owner.query('SELECT id FROM website_jobs WHERE requesting_user_id=$1', [original.requesting_user_id])).rowCount, 0);
    const replay = await recognize(menuRid, merchant, [source.id], 0, key);
    assert.equal(replay.statusCode, 202, replay.body); assert.equal(replay.json().job_id, original.id); assert.equal(replay.json().status, 'succeeded');
    assert.equal((await readMenuDraft(pool, menuRid))!.revision, confirmed.json().revision);
  });
  await t.test('每店200任务上限仍可重放，权限保护原输入和成功来源引用', async () => {
    const capActor = await actor('menu.cap@restaurant.example'), capRid = await restaurant(capActor, '菜单任务上限店');
    const source = await upload(capRid, capActor), key = id('cap');
    const accepted = await recognize(capRid, capActor, [source.id], 0, key); assert.equal(accepted.statusCode, 202);
    assert.equal(await runMenuJobs(pool, config, fixtureRecognizer), 1);
    const original = await storedJob(accepted.json().job_id);
    for (let i = 0; i < 199; i++) await owner.query(`INSERT INTO menu_jobs(id,restaurant_id,requesting_user_id,status,idempotency_key,request_fingerprint,input,sources,expected_revision,error_code,created_at)
      VALUES($1,$2,$3,'failed',$4,$5,$6,$7,0,'AI_PROVIDER_UNAVAILABLE',clock_timestamp()-interval '2 days')`, [id('mnj'), capRid, original.requesting_user_id, id('cap'), '0'.repeat(64), JSON.stringify(original.input), JSON.stringify(original.sources)]);
    assert.equal((await recognize(capRid, capActor, [source.id], 1)).json().code, 'MENU_JOB_LIMIT');
    assert.equal((await recognize(capRid, capActor, [source.id], 0, key)).json().job_id, original.id);
    await assert.rejects(pool.query("UPDATE menu_jobs SET input='{}' WHERE id=$1", [original.id]), { code: '42501' });
    await assert.rejects(pool.query("UPDATE menu_jobs SET sources='[]' WHERE id=$1", [original.id]), { code: '42501' });
    await assert.rejects(owner.query("UPDATE menu_jobs SET input='{}' WHERE id=$1", [original.id]), { code: '23514' });
    await assert.rejects(pool.query("UPDATE menu_jobs SET status='queued' WHERE id=$1", [original.id]), { code: '23514' });
    await assert.rejects(pool.query('DELETE FROM menu_jobs WHERE id=$1', [original.id]), { code: '42501' });
    await assert.rejects(pool.query("DELETE FROM asset_references WHERE purpose='menu_job' AND resource_id=$1", [original.id]), { code: '42501' });
    await assert.rejects(pool.query("INSERT INTO asset_references(id,restaurant_id,asset_id,purpose,resource_id) VALUES($1,$2,$3,'menu_job',$4)", [id('ref'), capRid, source.id, id('mnj')]), { code: '42501' });
    assert.equal((await owner.query("SELECT id FROM audit_logs WHERE entity_type='menu' AND action='menu_recognition_requested' AND restaurant_id=$1", [capRid])).rowCount, 1);
    assert.ok((await owner.query("SELECT id FROM audit_logs WHERE entity_type='menu' AND id LIKE 'aud_%' LIMIT 1")).rowCount);
  });
});

test('菜单模型与人工数据统一严格字段边界', () => {
  assert.deepEqual(normalizeMenuData(recognizedData), recognizedData);
  assert.throws(() => normalizeMenuData({ ...recognizedData, currency: '自动伪造币种' }), { code: 'MENU_DATA_INVALID' });
  assert.throws(() => normalizeMenuData({ ...recognizedData, currency: '自动伪造币种' }, true), { code: 'AI_OUTPUT_INVALID' });
  const many = { categories: [{ name: '菜单', items: Array.from({ length: 81 }, () => recognizedData.categories[0]!.items[0]!) }], warnings: [] };
  assert.throws(() => normalizeMenuData(many), { code: 'MENU_DATA_INVALID' });
});
