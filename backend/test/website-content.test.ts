import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { assertAppDatabase, id, transaction } from '../src/db.js';
import { csrf, digest, secret, SESSION_COOKIE } from '../src/security.js';
import { insertPre012LegacyFixture, seedWebsiteQuotaFixture, websiteBillingFixtureState } from './website-fixtures.js';
import { applyMenuDraft } from '../src/menu-content.js';
import { normalizeMenuData, type MenuData } from '../src/menu-data.js';
import { normalizeOpeningHours, readRestaurantContent, restaurantContentFields } from '../src/restaurant-content.js';
import { websiteSnapshot, publicationView, type WebsiteVersion } from '../src/website-access.js';
import { renderWebsite, WebsiteValidationError, type WebsiteSnapshot } from '../src/website-html.js';
import { insertWebsiteSource, readWebsiteSource, websiteContentHash, websiteContentDifferences, websiteSourceStatus } from '../src/website-source.js';
import type { WebsiteContentPreviewInput, WebsiteContentPreviewResult, WebsiteEditableContent,
  WebsiteWorkbenchReport, WebsiteRawSource } from '../src/website-content-types.js';

const specification = JSON.parse(await readFile(new URL('../contracts/website-content.openapi.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
const addFormats = createRequire(import.meta.url)('ajv-formats') as typeof import('ajv-formats').default;
addFormats(ajv); ajv.addKeyword({ keyword: 'components', valid: true });
ajv.addSchema({ $id: 'content-test', components: specification.components });
const validators = new Map<string, ValidateFunction>();
for (const name of Object.keys(specification.components.schemas)) validators.set(name,
  ajv.compile({ $ref: `content-test#/components/schemas/${name}` }));
function conforms(name: string, value: unknown): void {
  const validate = validators.get(name)!;
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
}
const hours: WebsiteEditableContent['opening_hours'] = [{ weekday: 1, opens_at_local: '09:00', closes_at_local: '18:00',
  closes_day_offset: 0, accepts_requests: true, sort_order: 0 }];
const menu: MenuData = { categories: [{ name: '主菜', items: [{ name: '测试菜', description: '新鲜烹调', price_text: '¥18',
  review_note: '商家内部核对备注' }] }], warnings: ['保留原识别提醒'] };
const raw: WebsiteRawSource = { html_body: '<main><h1><restaurant-name/></h1><restaurant-description/><restaurant-hours/><restaurant-menu/><restaurant-contact/></main>',
  css: 'main{padding:24px}', summary: '确定性测试设计' };
const sampleInput: WebsiteContentPreviewInput = { base_version_id: 'wsv_' + 'a'.repeat(24), expected_restaurant_revision: 1,
  expected_menu_revision: 0, expected_public_content_hash: 'a'.repeat(64), expected_publication_revision: 0 };

test('纯契约：所有响应 schema 严格编译，菜单联合输入与 canonical 字段拒绝额外属性', () => {
  assert.equal(specification.openapi, '3.1.0');
  assert.deepEqual(Object.keys(specification.components.schemas.RestaurantPatchInput.properties).sort(), [...restaurantContentFields].sort());
  conforms('WebsiteContentPreviewInput', sampleInput);
  conforms('WebsiteContentPreviewInput', { ...sampleInput, menu_data: menu, menu_review_confirmed: true, opening_hours: hours });
  for (const extra of [{ html_body: raw.html_body }, { snapshot: {} }, { menu_data: menu }, { menu_review_confirmed: true },
    { menu_data: menu, menu_review_confirmed: false }, { restaurant_patch: { cuisine_type: '别名' } },
    { restaurant_patch: { owner_id: 'other' } }, { restaurant_patch: {} }, { opening_hours: [{ ...hours[0], extra: true }] },
    { expected_menu_revision: 0.5 }, { expected_public_content_hash: 'invalid' }]) {
    assert.equal(validators.get('WebsiteContentPreviewInput')!({ ...sampleInput, ...extra }), false);
  }
  const legacy = { id: sampleInput.base_version_id, restaurant_id: 'rst_' + 'b'.repeat(24), version_number: 1,
    summary: '历史版', created_at: new Date().toISOString(), checksum: 'a'.repeat(64), asset_ids: [],
    source_status: 'missing', origin: 'legacy', base_version_id: null, public_content_hash: null };
  conforms('WebsiteContentVersion', legacy);
  assert.equal(validators.get('WebsiteContentVersion')!({ ...legacy, html_body: '不得公开' }), false);
});
test('纯契约：营业段语义及完整菜单限制，公开差异不包含内部备注和 warnings', () => {
  assert.throws(() => normalizeOpeningHours([{ ...hours[0], opens_at_local: '19:00', closes_at_local: '18:00' }]));
  assert.throws(() => normalizeOpeningHours([hours[0], hours[0]]));
  assert.throws(() => normalizeMenuData({ ...menu, unknown: true }));
  const many = { categories: [{ name: '主菜', items: Array.from({ length: 81 }, () => menu.categories[0]!.items[0]) }], warnings: [] };
  assert.throws(() => normalizeMenuData(many));
  const snapshot: WebsiteSnapshot = { restaurant: { id: 'rst_' + 'b'.repeat(24), name: '店名', description: null,
    cuisine_type: null, address_line1: null, address_line2: null, city: null, region: null, postal_code: null,
    country_code: null, contact_email: null, contact_phone: null, timezone: 'UTC', currency: null, primary_locale: 'zh-CN',
    reservation_enabled: false, reservation_notice: null }, opening_hours: [], assets: [], menu: { revision: 1, data: menu } };
  const changed = structuredClone(snapshot); changed.menu!.revision++;
  changed.menu!.data.warnings = []; changed.menu!.data.categories[0]!.items[0]!.review_note = '新的内部备注';
  assert.equal(websiteContentHash(snapshot), websiteContentHash(changed));
  assert.deepEqual(websiteContentDifferences(snapshot, changed), []);
  assert.equal(publicationView({ nodeEnv: 'production', website: { publicOrigin: 'http://localhost:4174' } } as Config,
    { revision: 1, published_version_id: sampleInput.base_version_id, slug: 'fixture' }).url, null);
});

interface Actor { uid: string; rid: string; cookie: string; csrf: string }
import { createTestDatabasePools, readTestDatabaseScope } from './database-scope.js';
// 只由主线程在已准备 012 的隔离 PG 上串行运行；不迁移、不清空任何表，不触碰目录 seed。
describe('隔离 PG：网站工作台与无 AI 内容预览', { concurrency: false }, () => {
  let pool: Pool, owner: Pool, app: FastifyInstance, config: Config, sequence = 0;
  const catalogTables = ['billing_plan_versions', 'billing_price_versions', 'billing_credit_pack_versions'];
  let catalogHashes: string[] = [];
  const catalogs = () => Promise.all(catalogTables.map(async table => createHash('sha256').update(JSON.stringify(
    (await owner.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows)).digest('hex')));
  before(async () => {
    const scope = readTestDatabaseScope();
    const { databaseUrl, migrationDatabaseUrl } = scope;
    config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, MIGRATION_DATABASE_URL: migrationDatabaseUrl,
      APP_ORIGIN: 'https://localhost:5173', EMAIL_MODE: 'disabled', STORAGE_MODE: 'local',
      TOKEN_PEPPER: 'website-content-pepper-'.repeat(4), CURSOR_SECRET: 'website-content-cursor-'.repeat(4), OUTBOX_ENCRYPTION_KEY: 'd2'.repeat(32) });
    config.website!.apiKey = undefined;
    ({ owner, pool } = await createTestDatabasePools(scope));
    await assertAppDatabase(pool);
    assert.equal((await owner.query('SELECT version FROM schema_migrations WHERE version=$1', ['012_website_content'])).rowCount, 1,
      '由主线程先完成迁移，本测试不隐式执行 DDL 或 migrate');
    catalogHashes = await catalogs();
    app = createApp({ pool, config });
    await app.ready();
    for (const [method, suffix] of [['GET', '/workbench'], ['POST', '/content-previews'], ['POST', '/publication'], ['GET', '/versions/:versionId']] as const) {
      assert.equal(app.hasRoute({ method, url: `/api/v1/restaurants/:restaurantId/website${suffix}` }), true,
        '必须由 root app 注册路由，专项测试不补注册或重复注册');
    }
  });
  after(async () => {
    try { if (app) await app.close(); if (catalogHashes.length) assert.deepEqual(await catalogs(), catalogHashes, '目录 seed 字节不变'); }
    finally { await Promise.all([pool?.end(), owner?.end()]); }
  });
  async function actor(withMenu = true): Promise<Actor> {
    const uid = id('usr'), rid = id('rst'), token = secret(), expires = new Date(Date.now() + 3600000), hash = digest(config, token, 'session');
    await owner.query(`INSERT INTO users(id,email,email_normalized,locale,status,email_verified_at,terms_version,terms_accepted_at)
      VALUES($1,$2,$2,'zh-CN','active',clock_timestamp(),'content-fixture-v1',clock_timestamp())`, [uid, `${uid}@example.test`]);
    await owner.query('INSERT INTO auth_sessions(id,user_id,session_secret_hash,expires_at) VALUES($1,$2,$3,$4)', [id('ses'), uid, hash, expires]);
    await owner.query(`INSERT INTO restaurants(id,created_by_user_id,create_idempotency_key,create_request_fingerprint,slug,
      name,description,cuisine_label,country_code,city,address_line1,contact_email,phone,timezone,currency_code,primary_locale)
      VALUES($1,$2,$3,$4,replace(lower($1::text),'_','-'),'内容测试餐厅','现场烹饪','当季菜','CN','测试市','测试街一号',
      'fixture@example.test','+8613800000000','Asia/Shanghai','CNY','zh-CN')`, [rid, uid, id('create'), 'a'.repeat(64)]);
    await owner.query("INSERT INTO restaurant_members(id,restaurant_id,user_id,role) VALUES($1,$2,$3,'owner')", [id('mem'), rid, uid]);
    await owner.query(`INSERT INTO opening_hours(id,restaurant_id,weekday,opens_at_local,closes_at_local,closes_day_offset,accepts_requests,sort_order)
      VALUES($1,$2,1,'09:00','18:00',0,true,0)`, [id('hours'), rid]);
    if (withMenu) {
      await owner.query('INSERT INTO menu_drafts(id,restaurant_id) VALUES($1,$2)', [id('mnd'), rid]);
      await owner.query(`UPDATE menu_drafts SET data=$2,status='confirmed',revision=revision+1,confirmed_at=clock_timestamp() WHERE restaurant_id=$1`, [rid, JSON.stringify(menu)]);
    }
    return { uid, rid, cookie: `${SESSION_COOKIE}=${token}`, csrf: csrf(config, `session:${hash}`, expires) };
  }
  async function asset(a: Actor, kind = 'menu_source'): Promise<string> {
    const aid = id('ast'), checksum = 'c'.repeat(64);
    await owner.query(`INSERT INTO assets(id,restaurant_id,kind,original_filename,mime_type,size_bytes,checksum,source_checksum,
      width_px,height_px,rights_confirmed_at,storage_backend,storage_key,upload_idempotency_key,initial_request_fingerprint)
      VALUES($1,$2,$3,'fixture.png','image/png',10,$4,$4,10,10,clock_timestamp(),'local',$5,$6,$4)`,
    [aid, a.rid, kind, checksum, `${a.rid}/${aid}.png`, id('upload')]);
    return aid;
  }
  async function saveVersion(db: PoolClient, v: WebsiteVersion): Promise<void> {
    await db.query(`INSERT INTO website_versions(id,restaurant_id,version_number,summary,html,checksum,snapshot,asset_ids,model,usage)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [v.id, v.restaurant_id, v.version_number, v.summary, v.html,
      v.checksum, JSON.stringify(v.snapshot), v.asset_ids, v.model, v.usage]);
  }
  async function generated(a: Actor, source = raw, assetIds: string[] = []): Promise<WebsiteVersion> {
    return transaction(pool, async db => {
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [a.uid]);
      const row = await readRestaurantContent(db, a.rid);
      await db.query('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE', [a.rid]);
      const snapshot = await websiteSnapshot(db, row, assetIds, true);
      const number = Number((await db.query('SELECT COALESCE(max(version_number),0)+1 AS n FROM website_versions WHERE restaurant_id=$1', [a.rid])).rows[0].n);
      const v: WebsiteVersion = { id: id('wsv'), restaurant_id: a.rid, version_number: number, summary: source.summary,
        ...renderWebsite(source, snapshot), snapshot, asset_ids: snapshot.assets.map(s => s.id), model: 'fixture-original-model', usage: null, created_at: new Date() };
      const jid = id('wsj');
      await db.query(`INSERT INTO website_jobs(id,restaurant_id,requesting_user_id,kind,idempotency_key,request_fingerprint,input,snapshot)
        VALUES($1,$2,$3,'generate',$4,$5,$6,$7)`, [jid, a.rid, a.uid, id('job'), 'a'.repeat(64),
        JSON.stringify({ brief: '测试原稿', expected_restaurant_revision: row.revision }), JSON.stringify(snapshot)]);
      for (const saved of snapshot.assets) await db.query(`INSERT INTO asset_references(id,restaurant_id,asset_id,purpose,resource_id)
        VALUES($1,$2,$3,'website_job',$4)`, [id('ref'), a.rid, saved.id, jid]);
      await db.query(`UPDATE website_jobs SET status='running',lease_token=$2,lease_expires_at=clock_timestamp()+interval '180 seconds',agent_draft=$3 WHERE id=$1`,
        [jid, randomUUID(), JSON.stringify(source)]);
      await saveVersion(db, v);
      await insertWebsiteSource(db, v, source, { origin: 'generation', jobId: jid, restaurantRevision: row.revision, menuRevision: snapshot.menu?.revision ?? null });
      await db.query("UPDATE website_jobs SET status='succeeded',result_version_id=$2,lease_token=NULL,lease_expires_at=NULL WHERE id=$1", [jid, v.id]);
      await db.query('SET CONSTRAINTS ALL IMMEDIATE');
      return v;
    });
  }
  async function call(a: Actor, suffix: string, payload?: unknown, key = id('content'), targetRid = a.rid) {
    const response = await app.inject({ method: payload === undefined ? 'GET' : 'POST', url: `/api/v1/restaurants/${targetRid}/website${suffix}`,
      headers: { cookie: a.cookie, origin: config.appOrigin, 'x-csrf-token': a.csrf, 'idempotency-key': key },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      remoteAddress: `127.11.${Math.floor(++sequence / 250)}.${sequence % 250 + 1}` });
    assert.equal(response.headers['cache-control'], 'no-store');
    for (const field of ['html_body', 'storage_key', 'lease_token', 'request_fingerprint', 'source_job_id', 'created_by_user_id', 'session_secret_hash']) {
      assert.ok(!response.body.includes(field), `响应不泄露 ${field}`);
    }
    if (response.statusCode >= 400) conforms('Error', response.json());
    return response;
  }
  async function report(a: Actor, vid?: string): Promise<WebsiteWorkbenchReport> {
    const response = await call(a, `/workbench${vid ? `?base_version_id=${vid}` : ''}`);
    assert.equal(response.statusCode, 200, response.body); conforms('WebsiteWorkbenchReport', response.json());
    return response.json<WebsiteWorkbenchReport>();
  }
  function previewBody(r: WebsiteWorkbenchReport, changes: Partial<WebsiteContentPreviewInput> = {}): WebsiteContentPreviewInput {
    return { base_version_id: r.editing_version!.id, expected_restaurant_revision: r.content.restaurant_revision,
      expected_menu_revision: r.content.menu.revision, expected_public_content_hash: r.current_public_content_hash,
      expected_publication_revision: r.publication.revision, ...changes };
  }
  async function counts(a: Actor) {
    const tables = ['website_jobs', 'menu_jobs', 'ai_model_calls', 'website_agents'];
    const rows = await Promise.all(tables.map(async table => Number((await pool.query(`SELECT count(*) AS n FROM ${table} WHERE restaurant_id=$1`, [a.rid])).rows[0].n)));
    const ledger = (await pool.query(`SELECT count(*) AS n FROM ai_quota_ledger l JOIN billing_accounts b
      ON b.id=l.billing_account_id WHERE b.owner_user_id=$1`, [a.uid])).rows[0].n;
    return { activity: [...rows, Number(ledger)], billing: await websiteBillingFixtureState(pool, a.uid) };
  }
  async function state(a: Actor) {
    return { restaurant: await readRestaurantContent(pool, a.rid),
      menu: (await pool.query('SELECT revision,status,data,source_asset_ids,confirmed_at FROM menu_drafts WHERE restaurant_id=$1', [a.rid])).rows,
      counts: await Promise.all(['website_versions', 'website_version_sources', 'website_content_actions', 'audit_logs'].map(async table =>
        Number((await (table === 'audit_logs' ? owner : pool).query(`SELECT count(*) AS n FROM ${table} WHERE restaurant_id=$1`, [a.rid])).rows[0].n))) };
  }
  async function publish(a: Actor, v: WebsiteVersion): Promise<void> {
    const slug = `content-${createHash('sha256').update(a.rid).digest('hex').slice(0, 24)}`;
    const response = await call(a, '/publication', { version_id: v.id, expected_revision: 0, slug });
    assert.equal(response.statusCode, 200, response.body);
  }
  test('无菜单与空营业段的 GET 不初始化任何数据；人工输入可一次创建并确认菜单', async () => {
    const a = await actor(false); await owner.query('DELETE FROM opening_hours WHERE restaurant_id=$1', [a.rid]);
    const before = await state(a), activity = await counts(a), r = await report(a);
    assert.equal(r.editing_version, null); assert.deepEqual(r.content.opening_hours, []);
    assert.deepEqual(r.content.menu, { revision: 0, status: 'empty', data: { categories: [], warnings: [] } });
    assert.deepEqual(r.blockers, ['WEBSITE_BASE_REQUIRED']); assert.equal(r.model_configured, false);
    assert.deepEqual(await state(a), before); assert.deepEqual(await counts(a), activity);
    assert.equal((await pool.query('SELECT restaurant_id FROM website_publications WHERE restaurant_id=$1', [a.rid])).rowCount, 0);
    await generated(a);
    const response = await call(a, '/content-previews', previewBody(await report(a), { menu_data: menu, menu_review_confirmed: true }));
    assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().content.menu.status, 'confirmed');
    assert.equal(response.json().content.menu.revision, 1); assert.deepEqual(response.json().content.menu.data, menu);
  });
  test('成功修改菜价和营业段：精确原稿、NULL 模型用量、永久引用、无 AI 或任务和自动发布', async () => {
    const a = await actor(), aid = await asset(a), v = await generated(a, raw, [aid]);
    const r = await report(a); assert.equal(r.model_configured, false); assert.deepEqual(r.blockers, []);
    assert.deepEqual(Object.keys(r.content.restaurant).sort(), [...restaurantContentFields].sort());
    await seedWebsiteQuotaFixture(owner, a.uid);
    const original = await readWebsiteSource(pool, a.rid, v.id), activity = await counts(a);
    assert.equal(activity.billing.periods[0].available_tokens, '12345', '使用非零真实投影验证不预留、不扣余额');
    const data = structuredClone(menu); data.categories[0]!.items[0]!.price_text = '¥22';
    let httpCalls = 0; const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { httpCalls++; throw new Error('无 AI 路径禁止 provider HTTP'); };
    let response;
    try { response = await call(a, '/content-previews', previewBody(r, { menu_data: data, menu_review_confirmed: true,
      restaurant_patch: { description: '新的公开介绍' }, opening_hours: [{ ...hours[0]!, closes_at_local: '20:00', accepts_requests: false, sort_order: 2 }] })); }
    finally { globalThis.fetch = originalFetch; }
    assert.equal(response.statusCode, 200, response.body); conforms('WebsiteContentPreviewResult', response.json());
    const result = response.json<WebsiteContentPreviewResult>();
    assert.equal(result.ai_called, false); assert.equal(result.changed, true); assert.equal(result.version.origin, 'content_refresh');
    assert.equal(result.content.restaurant_revision, r.content.restaurant_revision + 1);
    assert.equal(result.content.menu.revision, r.content.menu.revision + 1); assert.equal(result.content.menu.status, 'confirmed');
    assert.deepEqual(result.content.menu.data, data); assert.equal(result.content.opening_hours[0]!.accepts_requests, false);
    assert.deepEqual(result.warnings, ['MENU_FILE_MAY_BE_OUTDATED']); assert.equal(httpCalls, 0); assert.deepEqual(await counts(a), activity);
    const stored = (await readWebsiteSource(pool, a.rid, result.version.id))!;
    assert.equal(stored.html_body, original!.html_body); assert.equal(stored.css, original!.css); assert.equal(stored.source_checksum, original!.source_checksum);
    assert.equal(stored.base_version_id, v.id); assert.equal(stored.source_job_id, null);
    const candidate = (await pool.query<WebsiteVersion>('SELECT * FROM website_versions WHERE id=$1', [result.version.id])).rows[0]!;
    assert.equal(candidate.model, null); assert.equal(candidate.usage, null); assert.equal(await websiteSourceStatus(pool, candidate), 'available');
    assert.ok(candidate.html.includes('¥22')); assert.ok(candidate.html.includes('20:00')); assert.deepEqual(candidate.asset_ids, v.asset_ids);
    assert.deepEqual(candidate.snapshot.menu!.data, data);
    const restoredReview = await report(a, candidate.id);
    assert.deepEqual(restoredReview.saved_differences, result.differences);
    assert.deepEqual(restoredReview.differences, []);
    assert.equal(restoredReview.editing_version!.id, candidate.id);
    assert.deepEqual((await pool.query("SELECT asset_id FROM asset_references WHERE purpose='website_version' AND resource_id=$1", [candidate.id])).rows, [{ asset_id: aid }]);
    assert.equal((await pool.query('SELECT published_version_id FROM website_publications WHERE restaurant_id=$1', [a.rid])).rowCount, 0);
    assert.equal((await pool.query('SELECT html FROM website_versions WHERE id=$1', [v.id])).rows[0].html, v.html);
    assert.equal((await pool.query('SELECT source_asset_ids FROM menu_drafts WHERE restaurant_id=$1', [a.rid])).rows[0].source_asset_ids.length, 0);
  });
  test('人工修改保留非空识别来源与成功识别任务的永久引用', async () => {
    const a = await actor(), aid = await asset(a), jid = id('mnj');
    await transaction(pool, async db => {
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [a.uid]);
      await db.query('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE', [a.rid]);
      const sources = [{ id: aid, mime_type: 'image/png', checksum: 'c'.repeat(64), size_bytes: 10,
        storage_key: `${a.rid}/${aid}.png`, storage_backend: 'local' }];
      await db.query(`INSERT INTO menu_jobs(id,restaurant_id,requesting_user_id,idempotency_key,request_fingerprint,input,sources,expected_revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,1)`, [jid, a.rid, a.uid, id('job'), 'a'.repeat(64),
        JSON.stringify({ asset_ids: [aid], consent_to_ai_processing: true, expected_revision: 1 }), JSON.stringify(sources)]);
      await db.query(`INSERT INTO asset_references(id,restaurant_id,asset_id,purpose,resource_id) VALUES($1,$2,$3,'menu_job',$4)`, [id('ref'), a.rid, aid, jid]);
      await db.query("UPDATE menu_jobs SET status='running',lease_token=$2,lease_expires_at=clock_timestamp()+interval '180 seconds' WHERE id=$1", [jid, randomUUID()]);
      await db.query(`UPDATE menu_drafts SET source_asset_ids=$2,revision=revision+1,updated_at=clock_timestamp() WHERE restaurant_id=$1`, [a.rid, [aid]]);
      await db.query("UPDATE menu_jobs SET status='succeeded',result_revision=2,lease_token=NULL,lease_expires_at=NULL WHERE id=$1", [jid]);
    });
    await generated(a); const r = await report(a), data = structuredClone(menu);
    data.categories[0]!.items[0]!.price_text = '¥26';
    const response = await call(a, '/content-previews', previewBody(r, { menu_data: data, menu_review_confirmed: true }));
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual((await pool.query('SELECT source_asset_ids FROM menu_drafts WHERE restaurant_id=$1', [a.rid])).rows[0].source_asset_ids, [aid]);
    assert.equal((await pool.query("SELECT id FROM asset_references WHERE purpose='menu_job' AND resource_id=$1", [jid])).rowCount, 1);
  });
  test('相同 key 重放原回执先于修订检查，异正文 409；不返回新鲜拼装状态', async () => {
    const a = await actor(), v = await generated(a), r = await report(a), body = previewBody(r, { restaurant_patch: { description: '已保存的新介绍' } }), key = id('content');
    const first = await call(a, '/content-previews', body, key); assert.equal(first.statusCode, 200, first.body);
    const before = await state(a);
    await owner.query("UPDATE restaurants SET description='另一窗口的当前介绍',revision=revision+1 WHERE id=$1", [a.rid]);
    await publish(a, v);
    const replay = await call(a, '/content-previews', JSON.parse(JSON.stringify(body)), key);
    assert.equal(replay.statusCode, 200, replay.body); assert.equal(replay.headers['idempotency-replayed'], 'true'); assert.deepEqual(replay.json(), first.json());
    assert.equal((await state(a)).counts[2], before.counts[2]);
    const conflict = await call(a, '/content-previews', { ...body, restaurant_patch: { description: '异正文' } }, key);
    assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().code, 'IDEMPOTENCY_CONFLICT');
  });
  test('不同 key 的完全相同公开候选复用；内部备注保存但不伪造公开变化', async () => {
    const a = await actor(), v = await generated(a), r = await report(a), changedMenu = structuredClone(menu);
    changedMenu.categories[0]!.items[0]!.price_text = '¥25';
    const first = await call(a, '/content-previews', previewBody(r, { menu_data: changedMenu, menu_review_confirmed: true }));
    assert.equal(first.statusCode, 200, first.body);
    const result = first.json<WebsiteContentPreviewResult>();
    const next = await call(a, '/content-previews', previewBody(await report(a, v.id), { menu_data: changedMenu, menu_review_confirmed: true }));
    assert.equal(next.statusCode, 200, next.body); assert.equal(next.json().version.id, result.version.id);
    assert.equal(next.json().content.menu.revision, result.content.menu.revision + 1);
    assert.equal((await pool.query('SELECT id FROM website_versions WHERE restaurant_id=$1', [a.rid])).rowCount, 2);
    const b = await actor(), base = await generated(b), current = await report(b), data = structuredClone(menu);
    data.categories[0]!.items[0]!.review_note = '只修改内部备注'; data.warnings = ['新的内部提醒'];
    const note = await call(b, '/content-previews', previewBody(current, { menu_data: data, menu_review_confirmed: true }));
    assert.equal(note.statusCode, 200, note.body); assert.equal(note.json().version.id, base.id);
    assert.equal(note.json().changed, false); assert.deepEqual(note.json().differences, []); assert.deepEqual(note.json().content.menu.data, data);
    assert.equal(note.json().public_content_hash, current.current_public_content_hash);
    assert.equal((await pool.query('SELECT id FROM website_versions WHERE restaurant_id=$1', [b.rid])).rowCount, 1);
    assert.equal((await pool.query('SELECT id FROM website_content_actions WHERE restaurant_id=$1', [b.rid])).rowCount, 1);
  });
  test('非法时间、缺失人工确认、空菜单、未知字段均不留下组合写入或版本', async () => {
    const a = await actor(); await generated(a); const r = await report(a), before = await state(a);
    const changes = [
      { restaurant_patch: { description: '不得保存' }, opening_hours: [{ ...hours[0], closes_at_local: '08:00' }] },
      { restaurant_patch: { description: '不得保存' }, menu_data: menu },
      { restaurant_patch: { description: '不得保存' }, menu_data: { categories: [], warnings: [] }, menu_review_confirmed: true },
      { restaurant_patch: { cuisine_type: '禁止别名' } }, { restaurant_patch: { phone: '+8613800000000', secret: '不回显秘密' } },
      { menu_review_confirmed: true }, { menu_data: { ...menu, unknown: true }, menu_review_confirmed: true }
    ];
    for (const change of changes) {
      const response = await call(a, '/content-previews', { ...previewBody(r), ...change });
      assert.equal(response.statusCode, 422, response.body); assert.ok(!response.body.includes('不回显秘密'));
      assert.deepEqual(await state(a), before);
    }
  });
  test('严格正文、幂等键、CSRF 和 1 MiB 上限在事务前拒绝，错误不回显输入', async () => {
    const a = await actor(); await generated(a); const r = await report(a), before = await state(a);
    const missing = { ...previewBody(r) } as Record<string, unknown>; delete missing.expected_menu_revision;
    assert.equal((await call(a, '/content-previews', missing)).statusCode, 422);
    assert.equal((await call(a, '/content-previews', previewBody(r), 'short')).statusCode, 400);
    const denied = await app.inject({ method: 'POST', url: `/api/v1/restaurants/${a.rid}/website/content-previews`,
      headers: { cookie: a.cookie, origin: config.appOrigin, 'idempotency-key': id('content') }, payload: previewBody(r) });
    assert.equal(denied.statusCode, 403); conforms('Error', denied.json());
    const large = await call(a, '/content-previews', { ...previewBody(r), secret: 'x'.repeat(1024 * 1024) });
    assert.equal(large.statusCode, 413); assert.ok(large.body.length < 2000);
    assert.deepEqual(await state(a), before);
  });
  test('合法最大菜单使 renderer 失败时，已写入的资料与确认菜单也完整回滚', async () => {
    const a = await actor(), longRaw = { ...raw, html_body: `<main><p>${'x'.repeat(100000)}</p><restaurant-menu/></main>` };
    await generated(a, longRaw); const r = await report(a), before = await state(a);
    const large = { categories: [{ name: '最大菜单', items: Array.from({ length: 80 }, () => ({ name: '菜'.repeat(200),
      description: '描述'.repeat(500), price_text: '¥18', review_note: null })) }], warnings: [] };
    normalizeMenuData(large);
    const current = await websiteSnapshot(pool, await readRestaurantContent(pool, a.rid), []);
    assert.throws(() => renderWebsite(longRaw, { ...current, menu: { revision: 2, data: large } }), WebsiteValidationError);
    const failed = await call(a, '/content-previews', previewBody(r, { restaurant_patch: { description: '应回滚' }, menu_data: large, menu_review_confirmed: true }));
    assert.equal(failed.statusCode, 422, failed.body); assert.equal(failed.json().code, 'WEBSITE_CONTENT_INVALID');
    assert.deepEqual(await state(a), before);
  });
  test('餐厅、菜单、公开 hash、发布修订冲突有独立状态码且不写数据', async () => {
    const a = await actor(); await generated(a); const r = await report(a), before = await state(a);
    for (const [field, value, status, code] of [
      ['expected_restaurant_revision', 0, 412, 'RESTAURANT_REVISION_CONFLICT'],
      ['expected_menu_revision', 0, 409, 'MENU_REVISION_CONFLICT'],
      ['expected_public_content_hash', 'f'.repeat(64), 409, 'PUBLIC_CONTENT_HASH_CONFLICT'],
      ['expected_publication_revision', 1, 409, 'PUBLICATION_REVISION_CONFLICT']
    ] as const) {
      const response = await call(a, '/content-previews', { ...previewBody(r), [field]: value });
      assert.equal(response.statusCode, status, response.body); assert.equal(response.json().code, code); assert.deepEqual(await state(a), before);
    }
  });
  test('当前未确认菜单只读保留完整 draft，公开 hash 使用 null，预览不得静默删原菜单', async () => {
    const a = await actor(), v = await generated(a);
    await transaction(pool, async db => {
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [a.uid]); await db.query('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE', [a.rid]);
      await applyMenuDraft(db, a.rid, menu, 1, { actorId: a.uid, requestId: randomUUID() });
    });
    const r = await report(a), current = await websiteSnapshot(pool, await readRestaurantContent(pool, a.rid), []);
    assert.equal(current.menu, null); assert.equal(r.current_public_content_hash, websiteContentHash(current));
    assert.equal(r.content.menu.status, 'draft'); assert.deepEqual(r.content.menu.data, menu); assert.ok(r.blockers.includes('MENU_UNCONFIRMED'));
    const before = await state(a), denied = await call(a, '/content-previews', previewBody(r, { opening_hours: [{ ...hours[0]!, closes_at_local: '19:00' }] }));
    assert.equal(denied.statusCode, 422); assert.equal(denied.json().code, 'MENU_CONFIRMATION_REQUIRED'); assert.deepEqual(await state(a), before);
    const confirmed = await call(a, '/content-previews', previewBody(r, { menu_data: menu, menu_review_confirmed: true }));
    assert.equal(confirmed.statusCode, 200, confirmed.body); assert.equal(confirmed.json().version.id, v.id); assert.equal(confirmed.json().changed, false);
    assert.equal(confirmed.json().content.menu.status, 'confirmed');
  });
  test('published、latest、editing 独立按 ID；第21版不替换默认发布基版', async () => {
    const a = await actor(), first = await generated(a); await publish(a, first);
    const versions = [first]; for (let n = 2; n <= 21; n++) versions.push(await generated(a));
    const r = await report(a); assert.equal(r.published_version!.id, first.id); assert.equal(r.editing_version!.id, first.id);
    assert.equal(r.latest_version!.id, versions.at(-1)!.id);
    const explicit = await report(a, versions[2]!.id); assert.equal(explicit.editing_version!.id, versions[2]!.id);
    assert.equal(explicit.published_version!.id, first.id); assert.equal(explicit.latest_version!.version_number, 21);
    const response = await call(a, '/content-previews', previewBody(r, { restaurant_patch: { description: '第22版内容' } }));
    assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().version.version_number, 22);
    for (const query of ['?unknown=1', `?base_version_id=${first.id}&base_version_id=${first.id}`, '?base_version_id=invalid']) {
      assert.equal((await call(a, `/workbench${query}`)).statusCode, 400);
    }
  });
  test('缺少源码的迁移前旧版及硬编码时段版：允许只读，保留基版，禁止内容预览', async () => {
    const a = await actor(), snapshot = await websiteSnapshot(pool, await readRestaurantContent(pool, a.rid), []);
    const legacy: WebsiteVersion = { id: id('wsv'), restaurant_id: a.rid, version_number: 1, summary: raw.summary,
      ...renderWebsite(raw, snapshot), snapshot, asset_ids: [], model: 'fixture-legacy-model', usage: null, created_at: new Date() };
    await transaction(owner, db => insertPre012LegacyFixture(db, 'pre012 无原稿版本必须只读且禁止内容预览', () => saveVersion(db, legacy)));
    const missing = await report(a); assert.equal(missing.editing_version!.id, legacy.id);
    assert.equal(missing.editing_version!.source_status, 'missing'); assert.equal(missing.editing_version!.origin, 'legacy');
    assert.equal(missing.editing_version!.public_content_hash, null); assert.ok(missing.blockers.includes('WEBSITE_SOURCE_MISSING'));
    const before = await state(a), denied = await call(a, '/content-previews', previewBody(missing));
    assert.equal(denied.statusCode, 409); assert.equal(denied.json().code, 'WEBSITE_SOURCE_MISSING'); assert.deepEqual(await state(a), before);
    const b = await actor(), fixed = await generated(b, { ...raw, html_body: '<main><p>营业 09:00</p></main>' });
    const incompatible = await report(b); assert.equal(incompatible.editing_version!.id, fixed.id);
    assert.equal(incompatible.editing_version!.source_status, 'incompatible'); assert.ok(incompatible.blockers.includes('WEBSITE_SOURCE_INCOMPATIBLE'));
    const response = await call(b, '/content-previews', previewBody(incompatible)); assert.equal(response.statusCode, 409); assert.equal(response.json().code, 'WEBSITE_SOURCE_INCOMPATIBLE');
  });
  test('运行中的网站及菜单识别任务不阻只读，但阻组合保存；有 AI 配置也不调用模型', async () => {
    const a = await actor(); await generated(a); const r = await report(a), jid = id('wsj');
    await pool.query(`INSERT INTO website_jobs(id,restaurant_id,requesting_user_id,kind,idempotency_key,request_fingerprint,input,snapshot)
      VALUES($1,$2,$3,'generate',$4,$5,'{}',$6)`, [jid, a.rid, a.uid, id('job'), 'a'.repeat(64), JSON.stringify(await websiteSnapshot(pool, await readRestaurantContent(pool, a.rid), []))]);
    await pool.query("UPDATE website_jobs SET status='running',lease_token=$2,lease_expires_at=clock_timestamp()+interval '180 seconds' WHERE id=$1", [jid, randomUUID()]);
    assert.ok((await report(a)).blockers.includes('WEBSITE_JOB_BUSY'));
    const busy = await call(a, '/content-previews', previewBody(r)); assert.equal(busy.statusCode, 409); assert.equal(busy.json().code, 'WEBSITE_JOB_BUSY');
    await pool.query("UPDATE website_jobs SET status='failed',error_code='JOB_INTERRUPTED',lease_token=NULL,lease_expires_at=NULL WHERE id=$1", [jid]);
    const mjid = id('mnj'), aid = await asset(a);
    await pool.query(`INSERT INTO menu_jobs(id,restaurant_id,requesting_user_id,idempotency_key,request_fingerprint,input,sources,expected_revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,1)`, [mjid, a.rid, a.uid, id('job'), 'a'.repeat(64),
      JSON.stringify({ asset_ids: [aid], consent_to_ai_processing: true, expected_revision: 1 }),
      JSON.stringify([{ id: aid, mime_type: 'image/png', checksum: 'c'.repeat(64), size_bytes: 10, storage_key: `${a.rid}/${aid}.png`, storage_backend: 'local' }])]);
    await pool.query(`INSERT INTO asset_references(id,restaurant_id,asset_id,purpose,resource_id) VALUES($1,$2,$3,'menu_job',$4)`, [id('ref'), a.rid, aid, mjid]);
    await pool.query("UPDATE menu_jobs SET status='running',lease_token=$2,lease_expires_at=clock_timestamp()+interval '180 seconds' WHERE id=$1", [mjid, randomUUID()]);
    assert.ok((await report(a)).blockers.includes('MENU_JOB_BUSY'));
    const mbusy = await call(a, '/content-previews', previewBody(r)); assert.equal(mbusy.statusCode, 409); assert.equal(mbusy.json().code, 'MENU_JOB_BUSY');
    await pool.query("UPDATE menu_jobs SET status='failed',error_code='JOB_INTERRUPTED',lease_token=NULL,lease_expires_at=NULL WHERE id=$1", [mjid]);
    await seedWebsiteQuotaFixture(owner, a.uid); const activity = await counts(a);
    config.website!.apiKey = 'fixture-unused-key';
    const originalFetch = globalThis.fetch; let httpCalls = 0;
    globalThis.fetch = async () => { httpCalls++; throw new Error('不得调用模型'); };
    try {
      assert.equal((await report(a)).model_configured, true);
      const response = await call(a, '/content-previews', previewBody(await report(a), { restaurant_patch: { description: '有配置仍不用模型' } }));
      assert.equal(response.statusCode, 200, response.body); assert.equal(httpCalls, 0);
      assert.equal(response.json().ai_called, false); assert.deepEqual(await counts(a), activity);
    } finally { config.website!.apiKey = undefined; globalThis.fetch = originalFetch; }
  });
  test('跨用户、跨店基版拒绝，未授权读写不泄露餐厅正文', async () => {
    const a = await actor(), b = await actor(), av = await generated(a), bv = await generated(b), r = await report(a);
    assert.equal((await call(b, '/workbench', undefined, id('content'), a.rid)).statusCode, 404);
    assert.equal((await call(b, '/content-previews', previewBody(r), id('content'), a.rid)).statusCode, 404);
    assert.equal((await call(a, `/workbench?base_version_id=${bv.id}`)).statusCode, 404);
    const denied = await call(a, '/content-previews', previewBody(r, { base_version_id: bv.id })); assert.equal(denied.statusCode, 404);
    assert.equal((await call(b, `/versions/${av.id}`)).statusCode, 404);
    const unauthenticated = await app.inject({ method: 'GET', url: `/api/v1/restaurants/${a.rid}/website/workbench` });
    assert.equal(unauthenticated.statusCode, 401); conforms('Error', unauthenticated.json()); assert.ok(!unauthenticated.body.includes('内容测试餐厅'));
  });
  test('受控 active 餐厅复用旧 PATCH/PUT 和菜单服务，不改 API 属性或重复递增', async () => {
    const a = await actor(); await owner.query("UPDATE restaurants SET status='active' WHERE id=$1", [a.rid]);
    const headers = { cookie: a.cookie, origin: config.appOrigin, 'x-csrf-token': a.csrf, 'if-match': `"restaurant-${a.rid}-v1"` };
    const patch = await app.inject({ method: 'PATCH', url: `/api/v1/restaurants/${a.rid}`, headers, payload: { cuisine_label: '新的菜系', phone: '+8613900000000' } });
    assert.equal(patch.statusCode, 200, patch.body); assert.equal(patch.json().revision, 2); assert.equal(patch.json().cuisine_label, '新的菜系');
    assert.equal(patch.json().phone, '+8613900000000'); assert.equal(patch.json().cuisine_type, undefined);
    const same = await app.inject({ method: 'PATCH', url: `/api/v1/restaurants/${a.rid}`, headers: { ...headers, 'if-match': patch.headers.etag }, payload: { cuisine_label: '新的菜系' } });
    assert.equal(same.statusCode, 200, same.body); assert.equal(same.json().revision, 2);
    const replaced = await app.inject({ method: 'PUT', url: `/api/v1/restaurants/${a.rid}/opening-hours`, headers: { ...headers, 'if-match': patch.headers.etag }, payload: { intervals: [{ ...hours[0]!, closes_at_local: '21:00' }] } });
    assert.equal(replaced.statusCode, 200, replaced.body); assert.equal(replaced.json().restaurant_revision, 3); assert.equal(replaced.json().intervals[0].closes_at_local, '21:00');
    const edited = await app.inject({ method: 'PATCH', url: `/api/v1/restaurants/${a.rid}/menu`, headers, payload: { data: menu, expected_revision: 1 } });
    assert.equal(edited.statusCode, 200, edited.body); assert.equal(edited.json().revision, 2); assert.equal(edited.json().status, 'draft');
    const confirmed = await app.inject({ method: 'POST', url: `/api/v1/restaurants/${a.rid}/menu/confirm`, headers, payload: { expected_revision: 2, confirmed: true } });
    assert.equal(confirmed.statusCode, 200, confirmed.body); assert.equal(confirmed.json().revision, 3); assert.equal(confirmed.json().status, 'confirmed');
    assert.equal(confirmed.json().confirmed_at === null, false); assert.deepEqual(confirmed.json().source_asset_ids, []);
  });
  test('组合清空时段与时区按最终状态验证；仅时段变化也没有 SQL 空 SET', async () => {
    const a = await actor(); await generated(a); const r = await report(a);
    const response = await call(a, '/content-previews', previewBody(r, { restaurant_patch: { timezone: null }, opening_hours: [] }));
    assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().content.restaurant.timezone, null);
    assert.deepEqual(response.json().content.opening_hours, []); assert.equal(response.json().content.restaurant_revision, 2);
    const filled = await call(a, '/content-previews', previewBody(await report(a), { restaurant_patch: { timezone: 'UTC' }, opening_hours: hours }));
    assert.equal(filled.statusCode, 200, filled.body); assert.equal(filled.json().content.restaurant_revision, 3);
  });
  test('并发发布先持有餐厅锁，旧 publication revision 不能在锁等待后创建候选', async () => {
    const a = await actor(), v = await generated(a); await publish(a, v); const r = await report(a), before = await state(a);
    const db = await owner.connect(); let pending: ReturnType<typeof call> | undefined;
    try {
      await db.query('BEGIN'); await db.query('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE', [a.rid]);
      pending = call(a, '/content-previews', previewBody(r, { restaurant_patch: { description: '并发时不得保存' } }));
      await db.query('UPDATE website_publications SET revision=revision+1 WHERE restaurant_id=$1', [a.rid]); await db.query('COMMIT');
      const response = await pending; assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().code, 'PUBLICATION_REVISION_CONFLICT');
      assert.deepEqual(await state(a), before);
    } finally { await db.query('ROLLBACK'); db.release(); if (pending) await pending; }
  });
  test('永久引用和 source 延迟约束在提交时仍强制完整 manifest，不受内容路径绕过', async () => {
    const a = await actor(), aid = await asset(a, 'logo'), v = await generated(a, raw, [aid]), r = await report(a);
    const response = await call(a, '/content-previews', previewBody(r, { restaurant_patch: { description: '新资料' } }));
    assert.equal(response.statusCode, 200, response.body);
    const rid = response.json().version.id;
    await assert.rejects(() => owner.query("DELETE FROM asset_references WHERE purpose='website_version' AND resource_id=$1", [rid]), { code: '23514' });
    await assert.rejects(() => transaction(pool, async db => {
      const invalid: WebsiteVersion = { ...v, id: id('wsv'), version_number: 3, model: null, usage: null };
      await saveVersion(db, invalid);
    }), { code: '23514' });
    assert.equal((await pool.query('SELECT id FROM website_versions WHERE restaurant_id=$1', [a.rid])).rowCount, 2);
  });
  function reviewedPublication(v: WebsiteContentPreviewResult['version'], revision = 0, mode = 'current') {
    return { version_id: v.id, expected_revision: revision, slug: 'unused-placeholder', expected_checksum: v.checksum,
      expected_public_content_hash: v.public_content_hash, content_mode: mode, review_confirmed: true };
  }
  async function candidate(a: Actor) {
    const base = await generated(a), r = await report(a);
    const response = await call(a, '/content-previews', previewBody(r, { restaurant_patch: { description: '待审核公开介绍' } }));
    assert.equal(response.statusCode, 200, response.body);
    return { base, result: response.json<WebsiteContentPreviewResult>() };
  }
  test('候选发布完整 review/hash/checksum 缺一不可，失败不留指针或发布回执', async () => {
    const a = await actor(), { result } = await candidate(a), before = await state(a);
    const input = { ...reviewedPublication(result.version), slug: `review-${createHash('sha256').update(a.rid).digest('hex').slice(0, 24)}` };
    for (const field of ['expected_checksum', 'expected_public_content_hash', 'content_mode', 'review_confirmed']) {
      const partial = { ...input } as Record<string, unknown>; delete partial[field];
      const response = await call(a, '/publication', partial);
      assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().code, 'WEBSITE_CONTENT_REVIEW_REQUIRED');
      assert.deepEqual(await state(a), before);
      assert.equal((await pool.query('SELECT * FROM website_publications WHERE restaurant_id=$1', [a.rid])).rowCount, 0);
      assert.equal((await pool.query('SELECT * FROM website_publish_actions WHERE restaurant_id=$1', [a.rid])).rowCount, 0);
    }
    for (const [field, code] of [['expected_checksum', 'WEBSITE_CHECKSUM_CONFLICT'], ['expected_public_content_hash', 'WEBSITE_PUBLIC_CONTENT_CONFLICT']] as const) {
      const response = await call(a, '/publication', { ...input, [field]: 'f'.repeat(64) });
      assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().code, code);
      assert.deepEqual(await state(a), before);
    }
  });
  test('人工审核的当前候选发布成功，hash 对应业务快照，不调用 AI 或扣余额', async () => {
    const a = await actor(), { result } = await candidate(a); await seedWebsiteQuotaFixture(owner, a.uid);
    const activity = await counts(a), input = { ...reviewedPublication(result.version), slug: `current-${createHash('sha256').update(a.rid).digest('hex').slice(0, 24)}` };
    const originalFetch = globalThis.fetch; let httpCalls = 0;
    globalThis.fetch = async () => { httpCalls++; throw new Error('人工发布禁止调用模型'); };
    try {
      const published = await call(a, '/publication', input); assert.equal(published.statusCode, 200, published.body);
      assert.equal(published.json().published_version_id, result.version.id); assert.equal(published.json().revision, 1);
      const snapshot = await websiteSnapshot(pool, await readRestaurantContent(pool, a.rid), []);
      assert.equal(websiteContentHash(snapshot), input.expected_public_content_hash);
      const afterActivity = await counts(a);
      assert.deepEqual(afterActivity.billing, activity.billing); assert.deepEqual(afterActivity.activity.slice(0, 3), activity.activity.slice(0, 3));
      assert.equal(httpCalls, 0);
    } finally { globalThis.fetch = originalFetch; }
  });
  test('候选生成后当前业务 hash 变化，current 拒绝旧候选且不回写业务数据', async () => {
    const a = await actor(), { result } = await candidate(a);
    await owner.query("UPDATE restaurants SET description='另一窗口当前介绍',revision=revision+1 WHERE id=$1", [a.rid]);
    const before = await state(a), activity = await counts(a);
    const response = await call(a, '/publication', { ...reviewedPublication(result.version), slug: `stale-${createHash('sha256').update(a.rid).digest('hex').slice(0, 24)}` });
    assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().code, 'WEBSITE_PUBLIC_CONTENT_CONFLICT');
    assert.deepEqual(await state(a), before); assert.deepEqual(await counts(a), activity);
    assert.equal((await pool.query('SELECT * FROM website_publications WHERE restaurant_id=$1', [a.rid])).rowCount, 0);
  });
  test('historical 仍校验候选 hash 和 checksum，仅移指针不回滚资料及停订开关', async () => {
    const a = await actor(), { result } = await candidate(a); await seedWebsiteQuotaFixture(owner, a.uid);
    await owner.query("UPDATE restaurants SET description='历史发布也必须保留当前介绍',reservation_enabled=false,revision=revision+1 WHERE id=$1", [a.rid]);
    const row = await readRestaurantContent(pool, a.rid), billing = await websiteBillingFixtureState(pool, a.uid);
    const input = { ...reviewedPublication(result.version, 0, 'historical'), slug: `history-${createHash('sha256').update(a.rid).digest('hex').slice(0, 24)}` };
    for (const [field, code] of [['expected_checksum', 'WEBSITE_CHECKSUM_CONFLICT'], ['expected_public_content_hash', 'WEBSITE_PUBLIC_CONTENT_CONFLICT']] as const) {
      const denied = await call(a, '/publication', { ...input, [field]: 'e'.repeat(64) });
      assert.equal(denied.statusCode, 409, denied.body); assert.equal(denied.json().code, code);
    }
    const response = await call(a, '/publication', input); assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().published_version_id, result.version.id);
    assert.deepEqual(await readRestaurantContent(pool, a.rid), row);
    assert.deepEqual(await websiteBillingFixtureState(pool, a.uid), billing);
  });
  test('发布同 key 先重放原回执，修改审核正文不能借重放避开 hash 校验', async () => {
    const a = await actor(), { result } = await candidate(a);
    const key = id('publish'), input = { ...reviewedPublication(result.version), slug: `replay-${createHash('sha256').update(a.rid).digest('hex').slice(0, 24)}` };
    const first = await call(a, '/publication', input, key); assert.equal(first.statusCode, 200, first.body);
    await owner.query("UPDATE restaurants SET description='发布后的当前内容',revision=revision+1 WHERE id=$1", [a.rid]);
    const before = await state(a), activity = await counts(a);
    const replay = await call(a, '/publication', JSON.parse(JSON.stringify(input)), key);
    assert.equal(replay.statusCode, 200, replay.body); assert.deepEqual(replay.json(), first.json());
    const changed = await call(a, '/publication', { ...input, expected_public_content_hash: 'd'.repeat(64) }, key);
    assert.equal(changed.statusCode, 409, changed.body); assert.equal(changed.json().code, 'IDEMPOTENCY_CONFLICT');
    assert.deepEqual(await state(a), before); assert.deepEqual(await counts(a), activity);
    assert.equal((await pool.query('SELECT * FROM website_publish_actions WHERE restaurant_id=$1', [a.rid])).rowCount, 1);
  });
});
