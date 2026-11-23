import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { assertAppDatabase, id, transaction } from '../src/db.js';
import { insertPre012LegacyFixture, remove012ForMigrationReplay, seedWebsiteQuotaFixture, websiteBillingFixtureState } from './website-fixtures.js';
import { assertWebsiteBackfillApply, backfillWebsiteSources } from '../scripts/backfill-website-sources.js';
import { csrf, digest, secret, SESSION_COOKIE } from '../src/security.js';
import { runWebsiteJobs, type WebsiteJobClient } from '../src/website-worker.js';
import { renderWebsite, type WebsiteSnapshot } from '../src/website-html.js';
import { ownedWebsiteRestaurant, websiteSnapshot, type WebsiteVersion } from '../src/website-access.js';
import { WEBSITE_RENDERER_VERSION, insertWebsiteSource, publicWebsiteContent, readWebsiteSource,
  websiteContentDifferences, websiteContentHash, websiteSourceBindingsAvailable, websiteSourceChecksum, websiteSourceStatus } from '../src/website-source.js';
import type { WebsiteContentVersionPage, WebsiteRawSource } from '../src/website-content-types.js';

let pool: Pool, owner: Pool, app: FastifyInstance, config: Config, ready = false;
let catalogCounts: number[] = [];
const tables = 'ai_calendar_credit_grants,website_content_actions,website_version_sources,billing_subscriptions,billing_offer_grants,ai_quota_ledger,ai_quota_periods,ai_model_calls,billing_accounts,analytics_events,analytics_daily,menu_jobs,menu_drafts,website_publish_actions,website_publications,website_model_calls,website_jobs,website_versions,website_agents,asset_upload_intents,asset_references,assets,reservations,reservation_events,reservation_access_tokens,audit_logs,email_outbox,opening_hours,restaurant_members,auth_tokens,auth_sessions,auth_identities,restaurants,users';
const catalogs = ['billing_plan_versions', 'billing_price_versions', 'billing_credit_pack_versions'];
const raw: WebsiteRawSource = { html_body: '<main><h1>欢迎光临</h1><p>享受美好时刻</p></main>', css: 'main{padding:24px}', summary: '原稿测试' };
function pureSnapshot(): WebsiteSnapshot {
  return { restaurant: { id: 'rst_' + 'a'.repeat(24), name: '源码测试餐厅', description: null, cuisine_type: null,
    address_line1: null, address_line2: null, city: null, region: null, postal_code: null, country_code: null,
    contact_email: null, contact_phone: null, timezone: null, currency: null, primary_locale: 'zh-CN',
    reservation_enabled: false, reservation_notice: null }, opening_hours: [], assets: [], menu: null };
}
interface Actor { uid: string; rid: string; cookie: string; csrf: string }
import { createTestDatabasePools, readTestDatabaseScope } from './database-scope.js';
async function actor(): Promise<Actor> {
  const uid = id('usr'), rid = id('rst'), token = secret(), expires = new Date(Date.now() + 3600000), hash = digest(config, token, 'session');
  await owner.query(`INSERT INTO users(id,email,email_normalized,locale,status,email_verified_at,terms_version,terms_accepted_at)
    VALUES($1,$2,$2,'zh-CN','active',clock_timestamp(),'fixture-v1',clock_timestamp())`, [uid, `${uid}@example.test`]);
  await owner.query(`INSERT INTO auth_sessions(id,user_id,session_secret_hash,expires_at) VALUES($1,$2,$3,$4)`, [id('ses'), uid, hash, expires]);
  await owner.query(`INSERT INTO restaurants(id,created_by_user_id,create_idempotency_key,create_request_fingerprint,slug,name,primary_locale)
    VALUES($1,$2,$3,$4,replace(lower($1::text),'_','-'),'源码测试餐厅','zh-CN')`, [rid, uid, id('create'), 'a'.repeat(64)]);
  await owner.query("INSERT INTO restaurant_members(id,restaurant_id,user_id,role) VALUES($1,$2,$3,'owner')", [id('mem'), rid, uid]);
  return { uid, rid, cookie: `${SESSION_COOKIE}=${token}`, csrf: csrf(config, `session:${hash}`, expires) };
}
async function snapshot(a: Actor): Promise<WebsiteSnapshot> { return websiteSnapshot(pool, await ownedWebsiteRestaurant(pool, a.uid, a.rid), []); }
function version(s: WebsiteSnapshot, number = 1, source = raw, model: string | null = null): WebsiteVersion {
  return { id: id('wsv'), restaurant_id: s.restaurant.id, version_number: number, summary: source.summary,
    ...renderWebsite(source, s), snapshot: s, asset_ids: s.assets.map(a => a.id), model, usage: null, created_at: new Date() };
}
async function insertVersion(db: PoolClient, v: WebsiteVersion): Promise<void> {
  await db.query(`INSERT INTO website_versions(id,restaurant_id,version_number,summary,html,checksum,snapshot,asset_ids,model,usage)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [v.id, v.restaurant_id, v.version_number, v.summary, v.html,
    v.checksum, JSON.stringify(v.snapshot), v.asset_ids, v.model, v.usage]);
}
async function generated(a: Actor, s?: WebsiteSnapshot, source = raw): Promise<WebsiteVersion> {
  const v = version(s ?? await snapshot(a));
  if (source !== raw) Object.assign(v, renderWebsite(source, v.snapshot), { summary: source.summary });
  await transaction(pool, async db => {
    await db.query('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE', [a.rid]);
    const jid = id('wsj');
    await db.query(`INSERT INTO website_jobs(id,restaurant_id,requesting_user_id,kind,idempotency_key,request_fingerprint,input,snapshot)
      VALUES($1,$2,$3,'generate',$4,$5,$6,$7)`, [jid, a.rid, a.uid, id('job'), 'a'.repeat(64), { expected_restaurant_revision: 1 }, JSON.stringify(v.snapshot)]);
    for (const asset of v.snapshot.assets) await db.query(`INSERT INTO asset_references(id,restaurant_id,asset_id,purpose,resource_id)
      VALUES($1,$2,$3,'website_job',$4)`, [id('ref'), a.rid, asset.id, jid]);
    await db.query(`UPDATE website_jobs SET status='running',lease_token=$2,lease_expires_at=clock_timestamp()+interval '180 seconds',agent_draft=$3 WHERE id=$1`,
      [jid, randomUUID(), JSON.stringify(source)]);
    await insertVersion(db, v);
    await insertWebsiteSource(db, v, source, { origin: 'generation', jobId: jid, restaurantRevision: 1, menuRevision: v.snapshot.menu?.revision ?? null });
    await db.query("UPDATE website_jobs SET status='succeeded',result_version_id=$2,lease_token=NULL,lease_expires_at=NULL WHERE id=$1", [jid, v.id]);
  });
  return v;
}
async function refreshed(base: WebsiteVersion, s = base.snapshot, number = base.version_number + 1, source = raw, model: string | null = null): Promise<WebsiteVersion> {
  const v = version(s, number, source, model);
  await transaction(pool, async db => {
    await insertVersion(db, v);
    await insertWebsiteSource(db, v, source, { origin: 'content_refresh', baseVersionId: base.id, restaurantRevision: 1, menuRevision: s.menu?.revision ?? null });
  });
  return v;
}
async function insertRefreshSourceSql(db: PoolClient, v: WebsiteVersion, base: WebsiteVersion,
  publicHash = websiteContentHash(v.snapshot), source = raw, sourceChecksum = websiteSourceChecksum(source)): Promise<void> {
  // 故意直写应用角色授权列，不调用 TS insertWebsiteSource，验证 SQL 自身的约束边界。
  await db.query(`INSERT INTO website_version_sources(restaurant_id,version_id,base_version_id,origin,html_body,css,source_checksum,public_content_hash,restaurant_revision)
    VALUES($1,$2,$3,'content_refresh',$4,$5,$6,$7,1)`, [v.restaurant_id, v.id, base.id, source.html_body, source.css, sourceChecksum, publicHash]);
}
async function rollback(run: (db: PoolClient) => Promise<void>): Promise<void> {
  const db = await owner.connect();
  try { await db.query('BEGIN'); await run(db); } finally { await db.query('ROLLBACK'); db.release(); }
}
async function rejected(db: PoolClient, run: () => Promise<unknown>, code = '23514'): Promise<void> {
  await db.query('SAVEPOINT rejected_write');
  try { await assert.rejects(run, (e: unknown) => (e as { code?: string }).code === code); }
  finally { await db.query('ROLLBACK TO SAVEPOINT rejected_write'); await db.query('RELEASE SAVEPOINT rejected_write'); }
}
async function request(a: Actor, suffix: string, input?: Record<string, unknown>, key = id('publish')) {
  const response = await app.inject({ method: input ? 'POST' : 'GET', url: `/api/v1/restaurants/${a.rid}/website${suffix}`,
    headers: { cookie: a.cookie, origin: config.appOrigin, 'x-csrf-token': a.csrf, 'idempotency-key': key }, ...(input ? { payload: input } : {}) });
  assert.equal(response.headers['cache-control'], 'no-store');
  for (const privateField of ['html_body', 'storage_key', 'lease_token', 'request_fingerprint', 'source_job_id']) assert.ok(!response.body.includes(privateField));
  return response;
}
function publishInput(v: WebsiteVersion, expectedRevision = 0, mode: 'current' | 'historical' = 'current') {
  return { version_id: v.id, expected_revision: expectedRevision, slug: 'source-fixture', expected_checksum: v.checksum,
    expected_public_content_hash: websiteContentHash(v.snapshot), content_mode: mode, review_confirmed: true };
}

test('纯测试：导出哈希契约稳定、原稿按精确字节，不纳入 summary', () => {
  assert.equal(WEBSITE_RENDERER_VERSION, 'website-v1');
  assert.equal(websiteSourceChecksum(raw), createHash('sha256').update(JSON.stringify({ html_body: raw.html_body, css: raw.css })).digest('hex'));
  assert.equal(websiteSourceChecksum({ css: raw.css, html_body: raw.html_body }), websiteSourceChecksum(raw));
  assert.notEqual(websiteSourceChecksum({ ...raw, css: `${raw.css} ` }), websiteSourceChecksum(raw));
});
test('纯测试：公众 hash 去 revision、warnings、review_note，保留菜价和开启时订位提示', () => {
  const s = pureSnapshot();
  s.menu = { revision: 1, data: { categories: [{ name: '主菜', items: [{ name: '测试菜', price_text: '¥18', description: null, review_note: '仅商家审核' }] }], warnings: ['仅商家可见'] } };
  const changed = structuredClone(s); changed.menu!.revision = 4; changed.menu!.data.warnings = [];
  changed.menu!.data.categories[0]!.items[0]!.review_note = '新审核备注'; changed.restaurant.reservation_notice = '关闭时不公开';
  assert.equal(websiteContentHash(s), websiteContentHash(changed)); assert.deepEqual(websiteContentDifferences(s, changed), []);
  assert.ok(!JSON.stringify(publicWebsiteContent(s)).includes('review_note')); assert.ok(!JSON.stringify(publicWebsiteContent(s)).includes('warnings'));
  changed.menu!.data.categories[0]!.items[0]!.price_text = '¥19';
  assert.notEqual(websiteContentHash(s), websiteContentHash(changed));
  assert.deepEqual(websiteContentDifferences(s, changed).map(d => d.field), ['menu']);
  changed.restaurant.reservation_enabled = true; changed.restaurant.reservation_notice = '需确认';
  assert.ok(websiteContentDifferences(s, changed).some(d => d.field === 'reservation'));
});
test('纯测试：资产描述按 id 排序、公众字段差异不伪造菜单 item 身份', () => {
  const s = pureSnapshot(), t = structuredClone(s);
  t.restaurant.name = '新店名'; t.restaurant.description = '新的公开介绍'; t.restaurant.contact_phone = '+123456789';
  t.opening_hours = [{ weekday: 1, opens_at_local: '09:00', closes_at_local: '18:00', closes_day_offset: 0 }];
  assert.deepEqual(websiteContentDifferences(s, t).map(d => d.field), ['name', 'description', 'contact', 'hours']);
  const assets = [id('ast'), id('ast')].map(aid => ({ id: aid, kind: 'logo', mime_type: 'image/png', checksum: 'a'.repeat(64), width_px: 10, height_px: 10 }));
  s.assets = assets; t.assets = [...assets].reverse(); t.restaurant = structuredClone(s.restaurant); t.opening_hours = [];
  assert.equal(websiteContentHash(s), websiteContentHash(t));
});
test('纯测试：事实匹配采用完整 Unicode 词边界，LA 不命中 place，CJK 保留完整事实', () => {
  const s = pureSnapshot(); s.restaurant.city = 'LA';
  for (const html_body of ['<p>A place to gather.</p>', '<p>plateau éla λla la_guide lala</p>', '<p>la&#x327;</p>']) {
    assert.equal(websiteSourceBindingsAvailable({ ...raw, html_body }, s), true, html_body);
  }
  for (const html_body of ['<p>Welcome to LA.</p>', '<p>欢迎来到LA</p>', '<p>ＬＡ</p>']) {
    assert.equal(websiteSourceBindingsAvailable({ ...raw, html_body }, s), false, html_body);
  }
  s.restaurant.city = null; s.restaurant.name = 'Café';
  assert.equal(websiteSourceBindingsAvailable({ ...raw, html_body: '<p>Décaféiné</p>' }, s), true);
  assert.equal(websiteSourceBindingsAvailable({ ...raw, html_body: '<p>Le Cafe&#x301;.</p>' }, s), false);
  s.restaurant.name = '老王小馆'; s.restaurant.city = '上海';
  assert.equal(websiteSourceBindingsAvailable({ ...raw, html_body: '<p>欢迎到老王小馆用餐</p>' }, s), false);
  assert.equal(websiteSourceBindingsAvailable({ ...raw, html_body: '<p>位于上海市</p>' }, s), false);
  assert.equal(websiteSourceBindingsAvailable({ ...raw, html_body: '<p>小馆里感受海风</p>' }, s), true);
});
test('纯测试：裸价须有完整价格及货币上下文，不误封 16:9 或局部金额', () => {
  const s = pureSnapshot();
  for (const price_text of ['16', '$16', '16 USD', '¥16']) {
    s.menu = { revision: 1, data: { categories: [{ name: '主菜', items: [{ name: '测试菜', description: null, price_text, review_note: null }] }], warnings: [] } };
    for (const html_body of ['<p>ratio16:9</p>', '<p>16:9</p>', '<p>16 guests</p>', '<p>$160</p>', '<p>$16.99</p>', '<p>160 USD</p>', '<p>116 USD</p>', '<p>16:9 USD</p>', '<p>focusd16</p>', '<p>16 USDollars</p>', '<p>$16chairs</p>']) {
      assert.equal(websiteSourceBindingsAvailable({ ...raw, html_body }, s), true, `${price_text}: ${html_body}`);
    }
    for (const html_body of ['<p>$16</p>', '<p>16 USD</p>', '<p>USD 16</p>', '<p>今日$16</p>', '<p>16元起</p>', '<p>＄１６</p>', '<p>$16.00</p>', '<p>$16, welcome</p>', '<p title="$16">欢迎</p>']) {
      assert.equal(websiteSourceBindingsAvailable({ ...raw, html_body }, s), false, `${price_text}: ${html_body}`);
    }
  }
});
test('纯测试：电话匹配只拼连续电话文案，不聚合跨文案、段落或属性的无关数字', () => {
  const s = pureSnapshot(); s.restaurant.contact_phone = '+1 (234) 567-8901';
  for (const html_body of ['<p>Call +1 (234) 567-8901.</p>', '<p><span>+1 (234)</span><span> 567-8901</span></p>', '<p title="1 234 567 8901">联系</p>', '<p>电话+1 (234) 567-8901欢迎致电</p>']) {
    assert.equal(websiteSourceBindingsAvailable({ ...raw, html_body }, s), false, html_body);
  }
  for (const html_body of ['<p>1 guest, 234 seats, 567 reviews, 8901 views</p>', '<p>1 234</p><p>567 8901</p>',
    '<p title="1 234" aria-label="567 8901">欢迎</p>', '<p>991234567890199</p>', '<p>12345678901:9</p>']) {
    assert.equal(websiteSourceBindingsAvailable({ ...raw, html_body }, s), true, html_body);
  }
});
test('纯测试：组件自身 title/aria-label/alt 是自由事实，只有替换掉的子内容不检查', () => {
  const s = pureSnapshot(); s.restaurant.name = 'Old Name';
  for (const attr of ['title', 'aria-label', 'alt']) {
    const source = { ...raw, html_body: `<restaurant-name ${attr}="Old Name"/>` };
    assert.equal(websiteSourceBindingsAvailable(source, s), false, attr);
    const next = structuredClone(s); next.restaurant.name = 'New Name';
    const html = renderWebsite(source, next).html;
    assert.ok(html.includes(`${attr}="Old Name"`), 'renderer 确实保留旧属性，基础版本必须阻止刷新');
    assert.ok(html.includes('New Name'));
  }
  assert.equal(websiteSourceBindingsAvailable({ ...raw, html_body: '<restaurant-name title="欢迎">Old Name</restaurant-name>' }, s), true);
});
test('纯测试：公众 JSON 固定字段顺序，中文引号、斜杠和转义按 JSON.stringify 保留', () => {
  const s = pureSnapshot(); s.restaurant.name = '中文 "引号" / 茶\\屋\n𠀀';
  const reordered = structuredClone(s);
  reordered.restaurant = Object.fromEntries(Object.entries(s.restaurant).reverse()) as WebsiteSnapshot['restaurant'];
  assert.equal(websiteContentHash(reordered), websiteContentHash(s));
  const projected = publicWebsiteContent(s);
  assert.deepEqual(Object.keys(projected), ['restaurant', 'opening_hours', 'menu', 'assets']);
  assert.deepEqual(Object.keys(projected.restaurant), ['id', 'name', 'description', 'cuisine_type', 'address_line1', 'address_line2',
    'city', 'region', 'postal_code', 'country_code', 'contact_email', 'contact_phone', 'timezone', 'currency', 'primary_locale',
    'reservation_enabled', 'reservation_notice']);
  const json = JSON.stringify(projected);
  assert.ok(json.includes('中文 \\"引号\\" / 茶\\\\屋\\n𠀀')); assert.ok(!json.includes('\\/'));
  assert.equal(websiteContentHash(s), createHash('sha256').update(json, 'utf8').digest('hex'));
  const source = { ...raw, html_body: '<p title="中文">"引号" / 茶\\屋\n𠀀</p>', css: 'p::before{content:""}' };
  assert.equal(websiteSourceChecksum(source), createHash('sha256').update(JSON.stringify({ html_body: source.html_body, css: source.css }), 'utf8').digest('hex'));
  const rendered = renderWebsite(source, s);
  assert.equal(rendered.checksum, createHash('sha256').update(rendered.html, 'utf8').digest('hex'));
});

describe('隔离 PG：网站原稿、素材及提交守卫', { concurrency: false }, () => {
before(async () => {
  const scope = readTestDatabaseScope();
  const { databaseUrl, migrationDatabaseUrl } = scope;
  config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, MIGRATION_DATABASE_URL: migrationDatabaseUrl,
    APP_ORIGIN: 'https://localhost:5173', EMAIL_MODE: 'disabled', STORAGE_MODE: 'local',
    TOKEN_PEPPER: 'website-source-fixture-pepper-'.repeat(3), CURSOR_SECRET: 'website-source-fixture-cursor-'.repeat(3),
    OUTBOX_ENCRYPTION_KEY: 'b2'.repeat(32) });
  config.website!.apiKey = 'fixture-not-provider-key';
  ({ owner, pool } = await createTestDatabasePools(scope));
  assert.equal((await owner.query('SELECT version FROM schema_migrations WHERE version=$1', ['012_website_content'])).rowCount, 1,
    '主线程先接入并执行完整 migrate 清单，专项测试不旁路追加 012');
  await assertAppDatabase(pool);
  catalogCounts = await Promise.all(catalogs.map(async name => Number((await owner.query(`SELECT count(*) FROM ${name}`)).rows[0].count)));
  await owner.query(`TRUNCATE ${tables}`);
  ready = true;
  app = createApp({ pool, config });
  await app.ready();
  for (const suffix of ['', '/versions', '/versions/:versionId', '/publication']) assert.equal(app.hasRoute({
    method: suffix === '/publication' ? 'POST' : 'GET', url: `/api/v1/restaurants/:restaurantId/website${suffix}` }), true,
    '必须由 root app 注册真实网站路由，测试不补注册或重复注册');
});
beforeEach(async () => { if (ready) await owner.query(`TRUNCATE ${tables}`); });
after(async () => {
  try {
    if (app) await app.close();
    if (ready) {
      await owner.query(`TRUNCATE ${tables}`);
      const afterCounts = await Promise.all(catalogs.map(async name => Number((await owner.query(`SELECT count(*) FROM ${name}`)).rows[0].count)));
      assert.deepEqual(afterCounts, catalogCounts, '不清理或重建目录 seed');
    }
  } finally { await Promise.all([pool?.end(), owner?.end()]); }
});

test('合法缺组件旧稿走 renderer fallback，source 仍 available', async () => {
  const a = await actor(), v = await generated(a);
  const stored = await readWebsiteSource(pool, a.rid, v.id);
  assert.equal(stored?.html_body, raw.html_body); assert.equal(stored?.css, raw.css);
  assert.equal(stored?.source_checksum, websiteSourceChecksum(raw)); assert.equal(stored?.source_job_id !== null, true);
  assert.equal(await websiteSourceStatus(pool, v), 'available');
  assert.equal(await readWebsiteSource(pool, id('rst'), v.id), null);
});
test('原稿含自由菜价、时段、联系方式及普通 tel/mailto 标为 incompatible；组件子树不误报', async () => {
  const a = await actor(), s = await snapshot(a);
  s.restaurant.contact_phone = '+123456789'; s.restaurant.contact_email = 'fixture@example.test';
  s.opening_hours = [{ weekday: 1, opens_at_local: '09:00', closes_at_local: '18:00', closes_day_offset: 0 }];
  s.menu = { revision: 1, data: { categories: [{ name: '主菜', items: [{ name: '测试菜', price_text: '¥18', description: null, review_note: null }] }], warnings: [] } };
  for (const html_body of ['<p>今日价 ¥18</p>', '<p>09:00 营业</p>', '<p>+123456789</p>', '<a href="tel:+123456789">致电</a>',
    '<a href="mailto:fixture@example.test">邮件</a>', '<restaurant-name/><p>09:00</p>']) {
    const source = { ...raw, html_body };
    assert.equal(websiteSourceBindingsAvailable(source, s), false);
  }
  const safe = { ...raw, html_body: '<restaurant-menu><p>旧价 ¥18</p></restaurant-menu><restaurant-contact/><p>欢迎光临</p>' };
  assert.equal(websiteSourceBindingsAvailable(safe, s), true);
  const v = await generated(a, s, { ...raw, html_body: '<p>营业 09:00</p>' });
  assert.equal(await websiteSourceStatus(pool, v), 'incompatible', '可保存有效硬编码原稿，但不可宣称可维护');
});
test('组件旧事实属性阻止改名刷新，不能保留旧 title 却宣称 source available', async () => {
  const a = await actor(), s = await snapshot(a);
  const source = { ...raw, html_body: `<restaurant-name title="${s.restaurant.name}"/>` };
  const base = await generated(a, s, source);
  assert.equal(await websiteSourceStatus(pool, base), 'incompatible');
  const response = await request(a, '/content-previews', { base_version_id: base.id, expected_restaurant_revision: 1,
    expected_menu_revision: 0, expected_public_content_hash: websiteContentHash(s), expected_publication_revision: 0,
    restaurant_patch: { name: '新店名' } });
  assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().code, 'WEBSITE_SOURCE_INCOMPATIBLE');
  assert.equal((await pool.query('SELECT name FROM restaurants WHERE id=$1', [a.rid])).rows[0].name, s.restaurant.name);
  assert.equal((await pool.query('SELECT count(*) FROM website_versions WHERE restaurant_id=$1', [a.rid])).rows[0].count, '1');
  assert.equal((await pool.query('SELECT count(*) FROM website_content_actions WHERE restaurant_id=$1', [a.rid])).rows[0].count, '0');
});
test('应用角色直写伪造 HTML/checksum/原稿 hash，SQL 提交守卫独立拒绝', async () => {
  const a = await actor(), base = await generated(a);
  for (const change of [{ html: `${base.html} ` }, { checksum: 'b'.repeat(64) }]) {
    const bad = { ...version(base.snapshot, 2), ...change };
    await assert.rejects(() => transaction(pool, async db => {
      await insertVersion(db, bad); await insertRefreshSourceSql(db, bad, base);
    }), { code: '23514', message: '网页版本哈希不匹配精确 UTF-8 HTML' });
    assert.equal((await pool.query('SELECT id FROM website_versions WHERE id=$1', [bad.id])).rowCount, 0);
    assert.equal(await readWebsiteSource(pool, a.rid, bad.id), null);
  }
  await assert.rejects(() => transaction(pool, async db => {
    const bad = version(base.snapshot, 2); await insertVersion(db, bad);
    await insertRefreshSourceSql(db, bad, base, websiteContentHash(bad.snapshot), raw, 'b'.repeat(64));
  }), { code: '23514', message: '原稿哈希不匹配精确 HTML/CSS' });
});
test('公众 hash 的 SQL 边界仅格式；合法格式的错误 hash 必须由 TS 标记 incompatible', async () => {
  const a = await actor(), base = await generated(a), v = version(base.snapshot, 2);
  await assert.rejects(() => transaction(pool, async db => {
    await insertVersion(db, v); await insertRefreshSourceSql(db, v, base, 'not-a-sha256');
  }), { code: '23514' });
  const wrongHash = 'f'.repeat(64); assert.notEqual(wrongHash, websiteContentHash(v.snapshot));
  await transaction(pool, async db => {
    await insertVersion(db, v); await insertRefreshSourceSql(db, v, base, wrongHash);
  });
  assert.equal((await readWebsiteSource(pool, a.rid, v.id))!.public_content_hash, wrongHash);
  assert.equal(await websiteSourceStatus(pool, v), 'incompatible', '不声称 SQL 能校验 JSON.stringify 的公众投影');
});
test('应用角色直写 content_refresh，丢弃、替换、重排或改素材快照都不能提交', async () => {
  const a = await actor(), s = await snapshot(a), assets: WebsiteSnapshot['assets'] = [];
  // 隔离 owner 是普通迁移角色；只做合法 INSERT，不关闭触发器、不依赖 superuser。
  for (let n = 0; n < 3; n++) {
    const aid = id('ast'), checksum = String(n + 1).repeat(64);
    await owner.query(`INSERT INTO assets(id,restaurant_id,kind,original_filename,mime_type,size_bytes,checksum,source_checksum,
      width_px,height_px,rights_confirmed_at,storage_backend,storage_key,upload_idempotency_key,initial_request_fingerprint)
      VALUES($1,$2,'restaurant_photo','fixture.png','image/png',10,$3,$3,10,10,clock_timestamp(),'local',$4,$5,$3)`,
    [aid, a.rid, checksum, `${a.rid}/${aid}.png`, id('upload')]);
    assets.push({ id: aid, kind: 'restaurant_photo', mime_type: 'image/png', checksum, width_px: 10, height_px: 10 });
  }
  s.assets = assets.slice(0, 2); const base = await generated(a, s);
  const wrongSnapshots: WebsiteSnapshot[] = [
    { ...s, assets: [] }, { ...s, assets: [s.assets[0]!] }, { ...s, assets: [assets[2]!, s.assets[1]!] },
    { ...s, assets: [...s.assets].reverse() }, { ...s, assets: [{ ...s.assets[0]!, width_px: 11 }, s.assets[1]!] },
  ];
  const wrongVersions = wrongSnapshots.map(saved => version(saved, 2));
  wrongVersions.push({ ...version(s, 2), asset_ids: [s.assets[0]!.id] });
  for (const bad of wrongVersions) {
    await assert.rejects(() => transaction(pool, async db => {
      await insertVersion(db, bad);
      // 合法的丢弃/替换/重排案例补足自身永久引用，拒绝原因必须是与 base 不等，而非缺引用。
      if (bad.snapshot.assets.every(asset => assets.some(saved => JSON.stringify(saved) === JSON.stringify(asset))) &&
          JSON.stringify(bad.asset_ids) === JSON.stringify(bad.snapshot.assets.map(asset => asset.id))) {
        for (const asset of bad.snapshot.assets) await db.query(`INSERT INTO asset_references(id,restaurant_id,asset_id,purpose,resource_id)
          VALUES($1,$2,$3,'website_version',$4)`, [id('ref'), a.rid, asset.id, bad.id]);
      }
      await insertRefreshSourceSql(db, bad, base);
    }), { code: '23514', message: '无 AI 内容更新必须精确保留基础版本素材清单及快照' });
    assert.equal((await pool.query('SELECT id FROM website_versions WHERE id=$1', [bad.id])).rowCount, 0);
    assert.equal((await pool.query("SELECT id FROM asset_references WHERE purpose='website_version' AND resource_id=$1", [bad.id])).rowCount, 0);
  }
  const next = structuredClone(s); next.restaurant.description = '仅改公开介绍';
  const valid = await refreshed(base, next);
  assert.deepEqual(valid.asset_ids, base.asset_ids); assert.deepEqual(valid.snapshot.assets, base.snapshot.assets);
  assert.equal(await websiteSourceStatus(pool, valid), 'available');
});
test('SQL 原稿及版本 checksum 与中文引号、反斜杠、斜杠的 TS UTF-8 字节一致', async () => {
  const a = await actor(), s = await snapshot(a);
  const source = { ...raw, html_body: '<p title="中文">"引号" / 茶\\屋\n𠀀</p>', css: 'p::before{content:""}' };
  const base = await generated(a, s, source), v = version(s, 2, source);
  await transaction(pool, async db => {
    await insertVersion(db, v); await insertRefreshSourceSql(db, v, base, websiteContentHash(s), source);
  });
  assert.equal(await websiteSourceStatus(pool, v), 'available');
});

test('没有原稿绝不从已编译 HTML 推断；新版本 missing 不能提交', async () => {
  const a = await actor(), v = version(await snapshot(a));
  await rollback(async db => {
    await insertVersion(db, v);
    assert.equal(await websiteSourceStatus(db, v), 'missing');
    assert.equal(await readWebsiteSource(db, a.rid, v.id), null);
    await rejected(db, () => db.query('SET CONSTRAINTS ALL IMMEDIATE'));
  });
});
test('readiness 校验编译 HTML、snapshot、原稿 checksum 和 renderer 版本', async () => {
  const a = await actor(), v = await generated(a);
  assert.equal(await websiteSourceStatus(pool, { ...v, html: `${v.html} ` }), 'incompatible');
  const s = structuredClone(v.snapshot); s.restaurant.description = '被替换的快照';
  assert.equal(await websiteSourceStatus(pool, { ...v, snapshot: s }), 'incompatible');
  await rollback(async db => {
    const fresh = version(v.snapshot, 2); await insertVersion(db, fresh);
    const values = [a.rid, fresh.id, raw.html_body, raw.css, 'a'.repeat(64), websiteContentHash(fresh.snapshot), (await readWebsiteSource(pool, a.rid, v.id))!.source_job_id];
    await rejected(db, () => db.query(`INSERT INTO website_version_sources(restaurant_id,version_id,origin,html_body,css,source_checksum,public_content_hash,restaurant_revision,source_job_id)
      VALUES($1,$2,'generation',$3,$4,$5,$6,1,$7)`, values));
    await rejected(db, () => db.query(`INSERT INTO website_version_sources(restaurant_id,version_id,origin,html_body,css,source_checksum,renderer_version,public_content_hash,restaurant_revision,source_job_id)
      VALUES($1,$2,'generation',$3,$4,$5,'website-v2',$6,1,$7)`, [...values.slice(0, 4), websiteSourceChecksum(raw), ...values.slice(5)]));
  });
});
test('应用角色仅可 SELECT/INSERT 指定列，owner 也不能改删 source/actions', async () => {
  const a = await actor(), v = await generated(a);
  for (const table of ['website_version_sources', 'website_content_actions']) {
    const row = (await pool.query(`SELECT has_table_privilege(current_user,$1,'SELECT') AS readable,
      has_table_privilege(current_user,$1,'UPDATE') AS updatable,has_table_privilege(current_user,$1,'DELETE') AS deletable,
      has_column_privilege(current_user,$1,'created_at','INSERT') AS clock_writable`, [table])).rows[0];
    assert.equal(row.readable, true); assert.equal(row.updatable, false); assert.equal(row.deletable, false); assert.equal(row.clock_writable, false);
  }
  await assert.rejects(() => pool.query('UPDATE website_version_sources SET css=$2 WHERE version_id=$1', [v.id, '']), { code: '42501' });
  await assert.rejects(() => pool.query('DELETE FROM website_version_sources WHERE version_id=$1', [v.id]), { code: '42501' });
  await assert.rejects(() => owner.query('UPDATE website_version_sources SET css=$2 WHERE version_id=$1', [v.id, '']), { code: '23514' });
  await assert.rejects(() => owner.query('DELETE FROM website_version_sources WHERE version_id=$1', [v.id]), { code: '23514' });
  const action = [id('wca'), a.rid, a.uid, id('content'), 'a'.repeat(64), v.id, v.id, 0, { ai_called: false }];
  await pool.query(`INSERT INTO website_content_actions(id,restaurant_id,requesting_user_id,idempotency_key,request_fingerprint,base_version_id,result_version_id,base_publication_revision,result)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, action);
  await assert.rejects(() => pool.query(`INSERT INTO website_content_actions(id,restaurant_id,requesting_user_id,idempotency_key,request_fingerprint,base_version_id,result_version_id,base_publication_revision,result)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id('wca'), ...action.slice(1)]), { code: '23505' });
  await assert.rejects(() => owner.query('DELETE FROM website_content_actions WHERE id=$1', [action[0]]), { code: '23514' });
  await assert.rejects(() => owner.query("UPDATE website_content_actions SET result='{}' WHERE id=$1", [action[0]]), { code: '23514' });
});
test('content_refresh 无 AI 用量且精确保留原稿，拒绝改 HTML/CSS、错误 base 和跨店', async () => {
  const a = await actor(), base = await generated(a), s = structuredClone(base.snapshot); s.restaurant.description = '无需 AI 的新介绍';
  const v = await refreshed(base, s);
  assert.equal(v.model, null); assert.equal(v.usage, null);
  assert.equal((await readWebsiteSource(pool, a.rid, v.id))?.origin, 'content_refresh');
  assert.equal((await pool.query('SELECT count(*) FROM ai_model_calls')).rows[0].count, '0');
  await assert.rejects(() => refreshed(v, s, 3, { ...raw, html_body: '<main>修改布局</main>' }), { code: '23514' });
  await assert.rejects(() => refreshed(v, s, 3, { ...raw, css: `${raw.css} ` }), { code: '23514' });
  await assert.rejects(() => refreshed(v, s, 3, raw, 'fake-model'), { code: '23514' });
  await assert.rejects(() => transaction(pool, async db => {
    const usageVersion = { ...version(s, 3), usage: { total_tokens: 0 } }; await insertVersion(db, usageVersion);
    await insertWebsiteSource(db, usageVersion, raw, { origin: 'content_refresh', baseVersionId: v.id, restaurantRevision: 1, menuRevision: null });
  }), { code: '23514' });
  // INSERT 原稿守卫先于 FK 校验，缺少同店基础原稿必须被拒绝，不能删除反向用例。
  await assert.rejects(() => refreshed({ ...v, id: id('wsv') }, s, 3), { code: '23514' });
  const other = await actor(), cross = { ...s, restaurant: { ...s.restaurant, id: other.rid } };
  await assert.rejects(() => refreshed(base, cross, 1), { code: '23514' });
  await rollback(async db => {
    const self = version(s, 3); await insertVersion(db, self);
    await rejected(db, () => insertWebsiteSource(db, self, raw, { origin: 'content_refresh', baseVersionId: self.id, restaurantRevision: 1, menuRevision: null }));
  });
});
test('generation 来源必须同店 generate 成功终态 resultvid，不能借别的任务', async () => {
  const a = await actor(), base = await generated(a), stored = (await readWebsiteSource(pool, a.rid, base.id))!, other = await actor();
  await rollback(async db => {
    const v = version(base.snapshot, 2); await insertVersion(db, v);
    await insertWebsiteSource(db, v, raw, { origin: 'generation', jobId: stored.source_job_id!, restaurantRevision: 1, menuRevision: null });
    await rejected(db, () => db.query('SET CONSTRAINTS ALL IMMEDIATE'));
    const cross = version(base.snapshot, 3); await insertVersion(db, cross);
    await rejected(db, () => db.query(`INSERT INTO website_version_sources(restaurant_id,version_id,origin,html_body,css,source_checksum,public_content_hash,restaurant_revision,source_job_id)
      VALUES($1,$2,'generation',$3,$4,$5,$6,1,$7)`, [other.rid, cross.id, raw.html_body, raw.css, websiteSourceChecksum(raw), websiteContentHash(base.snapshot), stored.source_job_id]), '23503');
  });
});
test('永久 version 引用须匹配清单、ready 和 checksum；应用及 owner 均不可移除', async () => {
  const a = await actor(), aid = id('ast'), s = await snapshot(a), checksum = 'b'.repeat(64);
  await owner.query(`INSERT INTO assets(id,restaurant_id,kind,original_filename,mime_type,size_bytes,checksum,source_checksum,
    width_px,height_px,rights_confirmed_at,storage_backend,storage_key,upload_idempotency_key,initial_request_fingerprint)
    VALUES($1,$2,'logo','fixture.png','image/png',10,$3,$3,10,10,clock_timestamp(),'local',$4,$5,$3)`, [aid, a.rid, checksum, `${a.rid}/${aid}.png`, id('upload')]);
  s.assets = [{ id: aid, kind: 'logo', mime_type: 'image/png', checksum, width_px: 10, height_px: 10 }];
  const v = await generated(a, s);
  assert.equal((await pool.query("SELECT id FROM asset_references WHERE purpose='website_version' AND resource_id=$1", [v.id])).rowCount, 1);
  for (const db of [pool, owner]) {
    await assert.rejects(() => db.query("DELETE FROM asset_references WHERE purpose='website_version' AND resource_id=$1", [v.id]), { code: '23514' });
    await assert.rejects(() => db.query("UPDATE asset_references SET purpose='other' WHERE purpose='website_version' AND resource_id=$1", [v.id]), { code: db === pool ? '42501' : '23514' });
    await assert.rejects(() => db.query(`INSERT INTO asset_references(id,restaurant_id,asset_id,purpose,resource_id) VALUES($1,$2,$3,'website_version',$4)`, [id('ref'), a.rid, aid, id('wsv')]), { code: '23514' });
  }
  await assert.rejects(() => owner.query("UPDATE assets SET status='deleted',revision=revision+1,deleted_at=clock_timestamp() WHERE id=$1", [aid]), { code: '23514' });
  await rollback(async db => {
    const bad = version({ ...s, assets: [{ ...s.assets[0]!, checksum: 'c'.repeat(64) }] }, 2);
    await insertVersion(db, bad);
    await rejected(db, () => insertWebsiteSource(db, bad, raw, { origin: 'content_refresh', baseVersionId: v.id, restaurantRevision: 1, menuRevision: null }));
    const unreferenced = version(s, 3); await insertVersion(db, unreferenced);
    await db.query(`INSERT INTO website_version_sources(restaurant_id,version_id,base_version_id,origin,html_body,css,source_checksum,public_content_hash,restaurant_revision)
      VALUES($1,$2,$3,'content_refresh',$4,$5,$6,$7,1)`, [a.rid, unreferenced.id, v.id, raw.html_body, raw.css, websiteSourceChecksum(raw), websiteContentHash(s)]);
    await rejected(db, () => db.query('SET CONSTRAINTS ALL IMMEDIATE'));
  });
});
test('旧失败 job 仍可释放自己的引用，不能释放成功 job 的旧引用', async () => {
  const a = await actor(), aid = id('ast'), checksum = 'c'.repeat(64);
  await owner.query(`INSERT INTO assets(id,restaurant_id,kind,original_filename,mime_type,size_bytes,checksum,source_checksum,
    width_px,height_px,rights_confirmed_at,storage_backend,storage_key,upload_idempotency_key,initial_request_fingerprint)
    VALUES($1,$2,'logo','fixture.png','image/png',10,$3,$3,10,10,clock_timestamp(),'local',$4,$5,$3)`, [aid, a.rid, checksum, `${a.rid}/${aid}.png`, id('upload')]);
  const jid = id('wsj'), s = await snapshot(a); s.assets = [{ id: aid, kind: 'logo', mime_type: 'image/png', checksum, width_px: 10, height_px: 10 }];
  await pool.query(`INSERT INTO website_jobs(id,restaurant_id,requesting_user_id,kind,idempotency_key,request_fingerprint,input,snapshot)
    VALUES($1,$2,$3,'generate',$4,$5,'{}',$6)`, [jid, a.rid, a.uid, id('job'), 'a'.repeat(64), JSON.stringify(s)]);
  await pool.query("INSERT INTO asset_references(id,restaurant_id,asset_id,purpose,resource_id) VALUES($1,$2,$3,'website_job',$4)", [id('ref'), a.rid, aid, jid]);
  await assert.rejects(() => pool.query("DELETE FROM asset_references WHERE purpose='website_job' AND resource_id=$1", [jid]), { code: '42501' });
  await pool.query("UPDATE website_jobs SET status='failed',error_code='JOB_INTERRUPTED' WHERE id=$1", [jid]);
  assert.equal((await pool.query("DELETE FROM asset_references WHERE purpose='website_job' AND resource_id=$1", [jid])).rowCount, 1);
  const v = await generated(a, s), source = (await readWebsiteSource(pool, a.rid, v.id))!;
  await assert.rejects(() => pool.query("DELETE FROM asset_references WHERE purpose='website_job' AND resource_id=$1", [source.source_job_id]), { code: '42501' });
});
test('第21版本及签名 cursor 稳定，元数据按 published ID 读取且不暴露原稿', async () => {
  const a = await actor(), base = await generated(a);
  assert.equal((await request(a, '/publication', { version_id: base.id, expected_revision: 0, slug: 'source-fixture' })).statusCode, 200);
  for (let n = 2; n <= 21; n++) await refreshed(base, base.snapshot, n);
  const first = await request(a, '/versions?limit=2'); assert.equal(first.statusCode, 200, first.body);
  const page = first.json<WebsiteContentVersionPage>(); assert.equal(page.items[0]!.version_number, 21); assert.equal(page.has_more, true);
  const generation = await request(a, '/generations', { brief: '第21版以后仍可生成', asset_ids: [], public_assets_confirmed: true, expected_restaurant_revision: 1 });
  assert.equal(generation.statusCode, 202, generation.body);
  const next = await request(a, `/versions?limit=2&cursor=${page.next_cursor}`); assert.equal(next.statusCode, 200, next.body);
  assert.deepEqual(next.json<WebsiteContentVersionPage>().items.map(v => v.version_number), [19, 18]);
  assert.equal((await request(a, `/versions?limit=3&cursor=${page.next_cursor}`)).statusCode, 400);
  const tampered = `${page.next_cursor!.slice(0, 10)}x${page.next_cursor!.slice(11)}`;
  assert.equal((await request(a, `/versions?limit=2&cursor=${tampered}`)).statusCode, 400);
  const other = await actor(); assert.equal((await request(other, `/versions?limit=2&cursor=${page.next_cursor}`)).statusCode, 400);
  assert.equal((await request(other, `/versions/${base.id}`)).statusCode, 404);
  const state = (await request(a, '')).json(); assert.equal(state.versions.length, 20); assert.equal(state.publication.published_version_id, base.id);
  assert.ok(!state.versions.some((v: { id: string }) => v.id === base.id));
  const metadata = await request(a, `/versions/${base.id}`); assert.equal(metadata.statusCode, 200); assert.equal(metadata.json().id, base.id);
});
test('content_refresh 必须确认 hash/checksum/current；draft 菜单不能发布', async () => {
  const a = await actor(), base = await generated(a), v = await refreshed(base);
  assert.equal((await request(a, '/publication', { version_id: v.id, expected_revision: 0, slug: 'source-fixture' })).statusCode, 409);
  assert.equal((await request(a, '/publication', { ...publishInput(v), expected_checksum: 'b'.repeat(64) })).statusCode, 409);
  assert.equal((await request(a, '/publication', { ...publishInput(v), expected_public_content_hash: 'b'.repeat(64) })).statusCode, 409);
  await owner.query('INSERT INTO menu_drafts(id,restaurant_id) VALUES($1,$2)', [id('mnd'), a.rid]);
  await owner.query(`UPDATE menu_drafts SET revision=1,status='draft',data=$2 WHERE restaurant_id=$1`, [a.rid,
    { categories: [{ name: '待确认', items: [{ name: '未确认菜', description: null, price_text: '18', review_note: null }] }], warnings: [] }]);
  const denied = await request(a, '/publication', publishInput(v)); assert.equal(denied.statusCode, 409); assert.equal(denied.json().code, 'MENU_CONFIRMATION_REQUIRED');
});
test('发布成功 replay 先返回原结果；historical 不写旧内容回业务库、不回滚停订', async () => {
  const a = await actor(), base = await generated(a), v = await refreshed(base), input = publishInput(v), key = id('publish');
  const applied = await request(a, '/publication', input, key); assert.equal(applied.statusCode, 200, applied.body);
  await owner.query("UPDATE restaurants SET description='当前业务新介绍',revision=revision+1,reservation_enabled=false WHERE id=$1", [a.rid]);
  const replay = await request(a, '/publication', input, key); assert.equal(replay.statusCode, 200); assert.deepEqual(replay.json(), applied.json());
  assert.equal((await request(a, '/publication', publishInput(v, 1))).statusCode, 409);
  const historical = await request(a, '/publication', publishInput(base, 1, 'historical')); assert.equal(historical.statusCode, 200, historical.body);
  const row = (await owner.query('SELECT description,reservation_enabled FROM restaurants WHERE id=$1', [a.rid])).rows[0];
  assert.equal(row.description, '当前业务新介绍'); assert.equal(row.reservation_enabled, false);
  assert.equal((await pool.query('SELECT count(*) FROM ai_model_calls')).rows[0].count, '0');
});
test('worker 新 generation 保存 exact output 与成功 job 同事务，保留真实 unknown usage', async () => {
  const a = await actor(), s = await snapshot(a), jid = id('wsj');
  await pool.query(`INSERT INTO website_jobs(id,restaurant_id,requesting_user_id,kind,idempotency_key,request_fingerprint,input,snapshot)
    VALUES($1,$2,$3,'generate',$4,$5,$6,$7)`, [jid, a.rid, a.uid, id('job'), 'a'.repeat(64), { brief: '测试', expected_restaurant_revision: 1 }, JSON.stringify(s)]);
  const fixture: WebsiteJobClient = { chat: async () => ({ reply: '测试', design_brief: '测试' }),
    generate: async () => ({ ...raw, model: 'deepseek-flash', usage: null }) };
  await runWebsiteJobs(pool, { ...config, website: { ...config.website!, apiKey: 'fixture-not-provider-key' } }, fixture);
  const job = (await pool.query('SELECT status,result_version_id FROM website_jobs WHERE id=$1', [jid])).rows[0];
  assert.equal(job.status, 'succeeded');
  const source = (await readWebsiteSource(pool, a.rid, job.result_version_id))!;
  assert.equal(source.html_body, raw.html_body); assert.equal(source.css, raw.css); assert.equal(source.source_job_id, jid);
  assert.equal((await pool.query('SELECT usage IS NULL AS usage_unknown FROM website_versions WHERE id=$1', [job.result_version_id])).rows[0].usage_unknown, true);
  const calls = (await pool.query('SELECT call_status,usage_status FROM ai_model_calls WHERE website_job_id=$1', [jid])).rows;
  assert.deepEqual(calls, [{ call_status: 'completed', usage_status: 'unknown' }]);
});
test('012 不阻旧无稿版本；真实旧成功稿只补 source/ref，不改 version/job 字节', async () => {
  const a = await actor(), s = await snapshot(a), sql = await readFile(new URL('../migrations/012_website_content.sql', import.meta.url), 'utf8');
  await rollback(async db => {
    // 仅在 owner 回滚事务内重演 012；显式拆除依赖，不关闭 immutable、不提交 DDL 或清理目录。
    await db.query('SAVEPOINT replay_012');
    await remove012ForMigrationReplay(db);
    const unknown = version(s, 1, raw, 'fixture-original-model');
    const exact = version(s, 2, raw, 'fixture-original-model');
    const staleRaw = { ...raw, html_body: '<main>不同的旧任务稿</main>' };
    const inaccurate = version(s, 3, raw, 'fixture-original-model');
    await insertVersion(db, unknown);
    const jobs: string[] = [];
    for (const [v, draft] of [[exact, raw], [inaccurate, staleRaw]] as const) {
      const jid = id('wsj'); jobs.push(jid);
      await db.query(`INSERT INTO website_jobs(id,restaurant_id,requesting_user_id,kind,idempotency_key,request_fingerprint,input,snapshot)
        VALUES($1,$2,$3,'generate',$4,$5,$6,$7)`, [jid, a.rid, a.uid, id('job'), 'a'.repeat(64), { expected_restaurant_revision: 1 }, JSON.stringify(s)]);
      await db.query(`UPDATE website_jobs SET status='running',lease_token=$2,lease_expires_at=clock_timestamp()+interval '180 seconds',agent_draft=$3 WHERE id=$1`,
        [jid, randomUUID(), JSON.stringify(draft)]);
      await insertVersion(db, v);
      await db.query("UPDATE website_jobs SET status='succeeded',result_version_id=$2,lease_token=NULL,lease_expires_at=NULL WHERE id=$1", [jid, v.id]);
    }
    const beforeVersions = (await db.query('SELECT to_jsonb(v) AS value FROM website_versions v WHERE restaurant_id=$1 ORDER BY version_number', [a.rid])).rows;
    const beforeJobs = (await db.query('SELECT to_jsonb(j) AS value FROM website_jobs j WHERE restaurant_id=$1 ORDER BY id', [a.rid])).rows;
    await db.query(sql);
    assert.equal(await websiteSourceStatus(db, unknown), 'missing');
    // dry-run 仅使用 query；同一个真实 PG client 让未提交的迁移夹具可见，不模拟 SQL 或数据库返回值。
    const dryRun = await backfillWebsiteSources(db as unknown as Pool, config);
    assert.equal(dryRun.find(e => e.version_id === unknown.id)?.state, 'no_successful_draft');
    assert.equal(dryRun.find(e => e.version_id === exact.id)?.state, 'would_insert');
    assert.equal(dryRun.find(e => e.version_id === inaccurate.id)?.state, 'incompatible');
    assert.equal((await db.query('SELECT count(*) FROM website_version_sources')).rows[0].count, '0');
    await insertWebsiteSource(db, exact, raw, { origin: 'generation', jobId: jobs[0]!, restaurantRevision: 1, menuRevision: null });
    await db.query('SET CONSTRAINTS ALL IMMEDIATE');
    assert.equal(await websiteSourceStatus(db, exact), 'available');
    assert.deepEqual((await db.query('SELECT to_jsonb(v) AS value FROM website_versions v WHERE restaurant_id=$1 ORDER BY version_number', [a.rid])).rows, beforeVersions);
    assert.deepEqual((await db.query('SELECT to_jsonb(j) AS value FROM website_jobs j WHERE restaurant_id=$1 ORDER BY id', [a.rid])).rows, beforeJobs);
    assert.equal(await websiteSourceStatus(db, unknown), 'missing');
    await db.query('ROLLBACK TO SAVEPOINT replay_012');
    await db.query('RELEASE SAVEPOINT replay_012');
    assert.equal((await db.query("SELECT version FROM schema_migrations WHERE version='012_website_content'")).rowCount, 1);
    assert.equal((await db.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='website_versions'::regclass AND tgname='website_version_source_required'")).rows[0].tgenabled, 'O');
  });
});
test('legacy helper 成功仅保存历史版；失败由 savepoint 回滚恢复 guard 和事务', async () => {
  const a = await actor(), legacy = version(await snapshot(a), 1, raw, 'fixture-pre012-model');
  await transaction(owner, db => insertPre012LegacyFixture(db, 'pre012 无原稿版本必须仍能读取及按旧协议发布', () => insertVersion(db, legacy)));
  assert.equal(await websiteSourceStatus(pool, legacy), 'missing');
  const metadata = await request(a, `/versions/${legacy.id}`);
  assert.equal(metadata.statusCode, 200, metadata.body); assert.equal(metadata.json().origin, 'legacy');
  assert.equal((await request(a, '/publication', { version_id: legacy.id, expected_revision: 0, slug: 'source-fixture' })).statusCode, 200);
  await rollback(async db => {
    const failed = version(legacy.snapshot, 2, raw, 'fixture-pre012-model'), error = new Error('受控 legacy 夹具失败');
    await assert.rejects(() => insertPre012LegacyFixture(db, '测试异常不会遗留关闭的 guard', async () => {
      await insertVersion(db, failed); throw error;
    }), e => e === error);
    assert.equal((await db.query('SELECT id FROM website_versions WHERE id=$1', [failed.id])).rowCount, 0);
    assert.equal((await db.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='website_versions'::regclass AND tgname='website_version_source_required'")).rows[0].tgenabled, 'O');
    await insertVersion(db, failed);
    await rejected(db, () => db.query('SET CONSTRAINTS ALL IMMEDIATE'));
    await rejected(db, () => db.query('UPDATE website_versions SET summary=$2 WHERE id=$1', [legacy.id, '不可改写']));
  });
  await assert.rejects(() => transaction(pool, async db => {
    await insertVersion(db, version(legacy.snapshot, 2, raw, 'fixture-new-model'));
  }), { code: '23514' });
});
test('无 AI 刷新不创建调用或任务，也不预留及消费既有非零余额', async () => {
  const a = await actor(), base = await generated(a);
  await seedWebsiteQuotaFixture(owner, a.uid);
  const beforeBilling = await websiteBillingFixtureState(pool, a.uid);
  assert.equal(beforeBilling.periods[0].available_tokens, '12345');
  const activity = async () => Promise.all(['website_jobs', 'menu_jobs', 'ai_model_calls', 'website_model_calls'].map(async table =>
    (await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count));
  const beforeActivity = await activity(), s = structuredClone(base.snapshot); s.restaurant.description = '无模型的新介绍';
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('禁止无 AI 路径联网调用模型'); };
  try {
    const result = await refreshed(base, s);
    assert.equal(result.model, null); assert.equal(result.usage, null);
    assert.equal((await readWebsiteSource(pool, a.rid, result.id))!.origin, 'content_refresh');
    assert.deepEqual(await websiteBillingFixtureState(pool, a.uid), beforeBilling);
    assert.deepEqual(await activity(), beforeActivity); assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});
test('回填默认 dry-run 且不读取秘密，apply 有独立环境白名单', async () => {
  assert.throws(() => assertWebsiteBackfillApply(config, {}));
  const scope = readTestDatabaseScope();
  const testEnv = { WEBSITE_SOURCE_BACKFILL_ALLOW_TEST: 'restaurant_test', TEST_DATABASE_URL: scope.databaseUrl,
    TEST_MIGRATION_DATABASE_URL: scope.migrationDatabaseUrl, TEST_PG_PORT: scope.port, TEST_PG_MAJOR: String(scope.major) };
  assert.doesNotThrow(() => assertWebsiteBackfillApply(config, testEnv));
  assert.throws(() => assertWebsiteBackfillApply({ ...config, nodeEnv: 'production' }, testEnv));
  const a = await actor(), v = await generated(a), before = (await pool.query('SELECT count(*) FROM website_version_sources')).rows[0].count;
  const report = await backfillWebsiteSources(pool, config);
  assert.equal(report.find(entry => entry.version_id === v.id)?.state, 'already_inserted');
  assert.equal((await pool.query('SELECT count(*) FROM website_version_sources')).rows[0].count, before);
  assert.ok(!JSON.stringify(report).includes('html_body')); assert.ok(!JSON.stringify(report).includes('css'));
  await assert.rejects(() => backfillWebsiteSources(pool, config, true, {}));
});
});
