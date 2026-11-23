import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createDecipheriv, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import { createApp } from '../src/app.js';
import { registerBilling } from '../src/billing.js';
import type { BillingCatalog, BillingOverview } from '../src/billing-types.js';
import { loadConfig, type Config } from '../src/config.js';
import { assertAppDatabase, id } from '../src/db.js';
import { migrate } from '../scripts/migrate.js';
import { FLOW_COOKIE, SESSION_COOKIE } from '../src/security.js';

let app: FastifyInstance, pool: Pool, owner: Pool, config: Config, ready = false, sequence = 0;
let validateCatalog: ValidateFunction, validateOverview: ValidateFunction, validateError: ValidateFunction;
const paths = ['/billing/catalog', '/billing/overview'];
// 目录种子不 TRUNCATE；目录变体和状态修改只存在于最终 ROLLBACK 的 owner 夹具事务。
const tables = 'ai_calendar_credit_grants,website_content_actions,website_version_sources,billing_subscriptions,billing_offer_grants,ai_quota_ledger,ai_quota_periods,ai_model_calls,billing_accounts,analytics_events,analytics_daily,menu_jobs,menu_drafts,website_publish_actions,website_publications,website_model_calls,website_jobs,website_versions,website_agents,asset_upload_intents,asset_references,assets,reservations,reservation_events,reservation_access_tokens,audit_logs,email_outbox,opening_hours,restaurant_members,auth_tokens,auth_sessions,auth_identities,restaurants,users';
const password = '账单测试-Valid-Password-2026!';
const noCredits = { status: 'not_configured', enforced: false, available: null, reserved: null, consumed: null };
const seed = { plan_code: 'unlimited', amount_minor: 3990, interval: 'month', requires_approval: true, duration_status: 'unconfirmed', purchasable: false };
const seededPlan = (n: number) => `bpv_${String(n).padStart(24, '0')}`;
const seededPrice = (n: number) => `bpr_${String(n).padStart(24, '0')}`;
interface Anonymous { email: string; cookie: string; csrf: string }
interface Actor extends Anonymous { id: string }

import { createTestDatabasePools, readTestDatabaseScope } from './database-scope.js';
function billingApp(database = pool, settings = config): FastifyInstance {
  const instance = createApp({ pool: database, config: settings });
  instance.register(async routes => {
    const catalog = instance.hasRoute({ method: 'GET', url: '/api/v1/billing/catalog' });
    const overview = instance.hasRoute({ method: 'GET', url: '/api/v1/billing/overview' });
    assert.equal(catalog, overview, '主 app 应同时注册两个只读账单路由');
    if (!catalog) registerBilling(routes, database, settings);
  });
  return instance;
}
before(async () => {
  const scope = readTestDatabaseScope();
  const { databaseUrl, migrationDatabaseUrl } = scope;
  config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, MIGRATION_DATABASE_URL: migrationDatabaseUrl,
    APP_ORIGIN: 'https://localhost:5173', EMAIL_MODE: 'disabled', STORAGE_MODE: 'local',
    TOKEN_PEPPER: 'billing-fixture-pepper-'.repeat(3), CURSOR_SECRET: 'billing-fixture-cursor-'.repeat(3),
    OUTBOX_ENCRYPTION_KEY: 'c3'.repeat(32) });
  ({ owner, pool } = await createTestDatabasePools(scope));
  await migrate(owner, 'restaurant_test_app');
  await assertAppDatabase(pool);
  assert.ok((await owner.query("SELECT version FROM schema_migrations WHERE version='011_billing_catalog'")).rows[0],
    '主线程须接入 011 迁移；本文件不自行执行迁移 SQL 或提权');
  await owner.query(`TRUNCATE ${tables}`); ready = true;
  const contract = JSON.parse(await readFile(new URL('../contracts/billing.openapi.json', import.meta.url), 'utf8'));
  assert.equal(contract.openapi, '3.1.0');
  const schemas = JSON.parse(JSON.stringify(contract.components.schemas).replaceAll('#/components/schemas/', '#/$defs/'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const addFormats = createRequire(import.meta.url)('ajv-formats') as FormatsPlugin;
  addFormats(ajv);
  const compile = (name: string) => ajv.compile({ $defs: schemas, $ref: `#/$defs/${name}` });
  validateCatalog = compile('BillingCatalog'); validateOverview = compile('BillingOverview'); validateError = compile('Error');
  app = billingApp(); await app.ready();
});
beforeEach(async () => { if (ready) await owner.query(`TRUNCATE ${tables}`); });
after(async () => {
  try { if (app) await app.close(); if (ready) await owner.query(`TRUNCATE ${tables}`); }
  finally { await Promise.all([pool?.end(), owner?.end()]); }
});
function cookie(response: { headers: Record<string, unknown> }, name: string): string {
  const values = response.headers['set-cookie'];
  const found = (Array.isArray(values) ? values : [values]).find(value => typeof value === 'string' && value.startsWith(`${name}=`));
  assert.equal(typeof found, 'string'); return (found as string).split(';')[0]!;
}
async function request(method: HTTPMethods, path: string, actor?: Anonymous, payload?: Record<string, unknown>,
  extra: Record<string, string> = {}, instance = app) {
  const headers: Record<string, string> = { ...extra };
  if (actor) { headers.cookie = actor.cookie; headers['x-csrf-token'] = actor.csrf; }
  if (method !== 'GET') headers.origin ??= config.appOrigin;
  if (payload !== undefined) headers['content-type'] ??= 'application/json';
  return instance.inject({ method, url: `/api/v1${path}`, headers, ...(payload === undefined ? {} : { payload }),
    remoteAddress: `127.8.${Math.floor(++sequence / 250)}.${sequence % 250 + 1}` });
}
function valid(validator: ValidateFunction, body: unknown): void { assert.ok(validator(body), JSON.stringify(validator.errors)); }
async function register(): Promise<Anonymous> {
  const email = `billing-${randomUUID()}@example.test`;
  const flow = await request('GET', '/auth/csrf', undefined, undefined, { origin: config.appOrigin });
  assert.equal(flow.statusCode, 200, flow.body);
  const anonymous = { email, cookie: cookie(flow, FLOW_COOKIE), csrf: flow.json().csrf_token as string };
  const registered = await request('POST', '/auth/register', anonymous,
    { email, password, locale: 'en', terms_version: 'terms-v1', accepted_terms: true });
  assert.equal(registered.statusCode, 202, registered.body); return anonymous;
}
async function actor(): Promise<Actor> {
  const anonymous = await register();
  const row = (await owner.query(`SELECT id,sensitive_payload_ciphertext FROM email_outbox
    WHERE recipient_email_normalized=$1 AND template_key='verify_email' AND sensitive_payload_ciphertext IS NOT NULL`, [anonymous.email])).rows[0];
  assert.ok(row, '真实注册须生成测试邮箱 outbox；不运行 SMTP 或读取真实 secret');
  const [version, iv, tag, ciphertext] = row.sensitive_payload_ciphertext.split('.');
  assert.equal(version, 'v1');
  const decoder = createDecipheriv('aes-256-gcm', Buffer.from(config.outboxEncryptionKey, 'hex'), Buffer.from(iv, 'base64url'));
  decoder.setAAD(Buffer.from(row.id)); decoder.setAuthTag(Buffer.from(tag, 'base64url'));
  const token = JSON.parse(Buffer.concat([decoder.update(Buffer.from(ciphertext, 'base64url')), decoder.final()]).toString('utf8')).token;
  const verified = await request('POST', '/auth/verify-email', undefined, { token }); assert.equal(verified.statusCode, 204, verified.body);
  const login = await request('POST', '/auth/login', anonymous, { email: anonymous.email, password });
  assert.equal(login.statusCode, 200, login.body);
  const uid = (await owner.query('SELECT id FROM users WHERE email_normalized=$1', [anonymous.email])).rows[0].id as string;
  return { id: uid, email: anonymous.email, cookie: cookie(login, SESSION_COOKIE), csrf: login.json().csrf_token as string };
}
async function account(operator: Actor): Promise<string> {
  const accountId = id('bla');
  await owner.query('INSERT INTO billing_accounts(id,owner_user_id) VALUES($1,$2)', [accountId, operator.id]); return accountId;
}
async function catalog(instance = app): Promise<BillingCatalog> {
  const response = await request('GET', '/billing/catalog', undefined, undefined, {}, instance);
  assert.equal(response.statusCode, 200, response.body); valid(validateCatalog, response.json()); return response.json();
}
async function overview(operator: Actor, instance = app): Promise<BillingOverview> {
  const response = await request('GET', '/billing/overview', operator, undefined, {}, instance);
  assert.equal(response.statusCode, 200, response.body); valid(validateOverview, response.json()); return response.json();
}
async function error(path: string, operator: Actor | undefined, status: number, instance = app): Promise<void> {
  const response = await request('GET', path, operator, undefined, {}, instance);
  assert.equal(response.statusCode, status, response.body); valid(validateError, response.json());
  for (const field of ['account', 'subscription', 'seed_eligibility', 'plans', 'credits']) assert.equal(response.json()[field], undefined);
}
async function snapshot(table: string): Promise<unknown[]> {
  return (await owner.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`)).rows;
}

// 仅用于变体状态读取：owner 夹具遵守真实 CHECK/trigger，所有注册、登录与 requireSession 仍走真实 app pool。
// 提前 BEGIN 同一 RR 级别以放入未提交夹具；路由的 SET（包括 READ ONLY）原样执行，COMMIT 改为真实 ROLLBACK。
// 这些 owner 状态模拟不构成应用角色权限或真实支付验收；权限和普通路由测试均使用默认 app 角色。
async function withFixture(prepare: (db: PoolClient) => Promise<void>, run: (instance: FastifyInstance) => Promise<void>): Promise<void> {
  const plans = await snapshot('billing_plan_versions'), prices = await snapshot('billing_price_versions');
  let setupError: unknown, preparations = 0;
  const database = { query: pool.query.bind(pool), connect: async () => {
    const actual = await owner.connect();
    return { query: async (sql: string, values?: unknown[]) => {
      if (sql === 'BEGIN') {
        const result = await actual.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        try { preparations++; await prepare(actual); } catch (failure) { setupError = failure; throw failure; }
        return result;
      }
      return actual.query(sql === 'COMMIT' ? 'ROLLBACK' : sql, values);
    }, release: () => actual.release() } as unknown as PoolClient;
  } } as unknown as Pool;
  const instance = billingApp(database);
  try { await instance.ready(); await run(instance); assert.equal(preparations, 1); }
  finally {
    await instance.close();
    assert.deepEqual(await snapshot('billing_plan_versions'), plans);
    assert.deepEqual(await snapshot('billing_price_versions'), prices);
    if (setupError) throw setupError;
  }
}
async function seedPrice(db: PoolClient): Promise<string> {
  const planId = id('bpv'), priceId = id('bpr');
  await db.query(`INSERT INTO billing_plan_versions(id,code,version,name,ai_mode,monthly_credits,allocation_status,grant_schedule,hosted_site_limit)
    VALUES($1,'unlimited',2,'仅测试 Unlimited','unlimited',NULL,'confirmed','service_month',1)`, [planId]);
  for (const [interval, amount] of [['month', 19900], ['year', 139300]])
    await db.query(`INSERT INTO billing_price_versions(id,plan_version_id,interval,amount_minor,status,tax_policy)
      VALUES($1,$2,$3,$4,'active','exclusive')`, [id('bpr'), planId, interval, amount]);
  await db.query(`INSERT INTO billing_price_versions(id,plan_version_id,interval,amount_minor,offer_type,status,tax_policy,seed_duration_policy,seed_cycles,seed_terms)
    VALUES($1,$2,'month',3990,'seed','active','exclusive','cycles',12,'仅测试审批条款，不是真实支付')`, [priceId, planId]);
  await db.query("UPDATE billing_plan_versions SET status='active' WHERE id=$1", [planId]);
  return priceId;
}

// 主线程统一运行真实 PG 测试；本批不运行本文件，不缺变量 skip，也不使用假数据库。
test('公开目录无需 me/会话，三套餐六标准价加一私有种子价，金额按 minor unit 原样返回', async () => {
  const summary = await catalog();
  assert.deepEqual(summary.plans.map(plan => plan.code), ['maintain', 'build', 'unlimited']);
  assert.deepEqual(summary.plans.map(plan => plan.prices.map(price => [price.interval, price.amount_minor])),
    [[['month', 5900], ['year', 41300]], [['month', 9900], ['year', 69300]], [['month', 19900], ['year', 139300]]]);
  assert.deepEqual(summary.plans.map(plan => plan.ai.monthly_credits), [1000, 10000, null]);
  assert.deepEqual(summary.plans.map(plan => plan.ai.mode), ['limited', 'limited', 'unlimited']);
  for (const plan of summary.plans) {
    assert.equal(plan.status, 'draft'); assert.equal(plan.version, 1); assert.equal(plan.hosted_site_limit, null);
    assert.equal(plan.ai.tokens_per_credit, 100); assert.equal(plan.ai.allocation_status, 'proposed'); assert.equal(plan.ai.grant_schedule, 'unconfirmed');
    assert.equal(plan.prices.length, 2); assert.ok(plan.prices.every(price => price.currency === 'USD' && price.status === 'draft'));
  }
  assert.equal((await pool.query('SELECT id FROM billing_price_versions')).rowCount, 7);
  assert.deepEqual(summary.seed_offer, seed); assert.equal(summary.payment_enabled, false);
  assert.deepEqual(summary.credit_packs, []); assert.equal(summary.addons_status, 'not_configured');
  const response = await request('GET', '/billing/catalog', undefined, undefined, { cookie: `${SESSION_COOKIE}=invalid` });
  assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer'); assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.ok(!response.body.includes(seededPrice(7)));
});

test('overview 未登录、伪造 cookie、Bearer 和真实未验证注册均不可访问', async () => {
  await error('/billing/overview', undefined, 401);
  for (const headers of [{ cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}` }, { authorization: 'Bearer fake.jwt.fixture' }] as Record<string, string>[]) {
    const response = await request('GET', '/billing/overview', undefined, undefined, headers);
    assert.equal(response.statusCode, 401, response.body); valid(validateError, response.json());
  }
  const pending = await register();
  assert.equal((await request('GET', '/billing/overview', pending)).statusCode, 401);
  assert.equal((await request('POST', '/auth/login', pending, { email: pending.email, password })).statusCode, 403);
});

test('已验证新用户返回 account/subscription null，完整 null 额度且零业务写入、用户和会话不变', async () => {
  const operator = await actor();
  const names = ['users', 'auth_sessions', 'billing_accounts', 'billing_offer_grants', 'billing_subscriptions', 'ai_model_calls', 'ai_quota_periods', 'ai_quota_ledger'];
  const beforeRows = await Promise.all(names.map(snapshot));
  const summary = await overview(operator);
  assert.equal(summary.schema_version, 'billing-overview-v1'); assert.equal(summary.mode, 'observation');
  assert.equal(summary.payment_enabled, false); assert.equal(summary.account, null); assert.equal(summary.subscription, null);
  assert.equal(summary.seed_eligibility, 'not_granted'); assert.deepEqual(summary.credits, noCredits);
  assert.equal(summary.addons_status, 'not_configured');
  assert.match(summary.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  assert.deepEqual(await Promise.all(names.map(snapshot)), beforeRows);
  const legacy = await request('GET', '/billing/account', operator);
  assert.equal(legacy.statusCode, 200, legacy.body);
  assert.deepEqual(legacy.json(), { mode: 'observation', account: null, payment_enabled: false });
});

test('两位 owner 的账户、订阅及种子审批绝不串读，公开目录不暴露任何资格或提供商标识', async () => {
  const first = await actor(), second = await actor(), firstId = await account(first), secondId = await account(second);
  const subscriptionId = id('bsu'), grantId = id('bog');
  await owner.query(`INSERT INTO billing_subscriptions(id,billing_account_id,plan_version_id,price_version_id,provider_subscription_id,status)
    VALUES($1,$2,$3,$4,'I-PRIVATEFIXTURE','incomplete')`, [subscriptionId, secondId, seededPlan(2), seededPrice(3)]);
  await owner.query('INSERT INTO billing_offer_grants(id,billing_account_id,price_version_id) VALUES($1,$2,$3)', [grantId, secondId, seededPrice(7)]);
  const beforeRows = await snapshot('billing_subscriptions');
  const firstView = await overview(first), secondView = await overview(second);
  assert.deepEqual(firstView.account, { id: firstId, status: 'active' }); assert.equal(firstView.subscription, null); assert.equal(firstView.seed_eligibility, 'not_granted');
  assert.deepEqual(secondView.account, { id: secondId, status: 'active' }); assert.equal(secondView.subscription?.id, subscriptionId); assert.equal(secondView.seed_eligibility, 'pending');
  for (const path of paths) {
    const response = await request('GET', path, first); assert.equal(response.statusCode, 200, response.body);
    for (const value of [secondId, subscriptionId, grantId, second.email, second.id, 'I-PRIVATEFIXTURE', 'provider_subscription_id', 'approved_by', 'granted_at', 'valid_end'])
      assert.ok(!response.body.includes(value), value);
  }
  assert.deepEqual(await snapshot('billing_subscriptions'), beforeRows);
  for (const status of ['suspended', 'closed']) {
    await owner.query('UPDATE billing_accounts SET status=$2 WHERE id=$1', [firstId, status]);
    assert.deepEqual((await overview(first)).account, { id: firstId, status });
  }
});

test('严格拒绝所有查询、重复键、数组、额外身份和价格覆盖，不提供结账或重定向', async () => {
  const operator = await actor();
  for (const query of ['x=1', 'restaurant_id=x', 'billing_account_id=x', 'user_id=x', 'plan_id=x', 'price_id=x',
    'price_version_id=x', 'interval=year', 'limit=1', 'x=1&x=2', 'x[]=1', 'x[y]=1', 'seed=true', '=x', 'x=']) {
    await error(`/billing/catalog?${query}`, undefined, 400); await error(`/billing/overview?${query}`, operator, 400);
  }
  for (const path of ['/billing/checkout', '/billing/subscriptions', '/billing/credit-packs/checkout', ...paths]) {
    const response = await request('POST', path, operator, {}); assert.equal(response.statusCode, 404, response.body);
    assert.equal(response.headers.location, undefined);
  }
});

test('每次读取重新校验真实用户，以及 requireSession 后撤销的会话', async () => {
  const operator = await actor();
  for (const status of ['suspended', 'deleted', 'pending_verification']) {
    await owner.query('UPDATE users SET status=$2,email_verified_at=$3 WHERE id=$1', [operator.id, status, status === 'pending_verification' ? null : new Date()]);
    await error('/billing/overview', operator, 401);
    await owner.query("UPDATE users SET status='active',email_verified_at=clock_timestamp() WHERE id=$1", [operator.id]);
  }
  let revoked = false;
  const database = { query: async (sql: string, values?: unknown[]) => {
    const result = await pool.query(sql, values);
    if (!revoked && sql.includes('FROM auth_sessions s JOIN users u') && result.rows[0]) {
      revoked = true; await owner.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [result.rows[0].session_id]);
    }
    return result;
  }, connect: pool.connect.bind(pool) } as unknown as Pool;
  const instance = billingApp(database);
  try { await instance.ready(); await error('/billing/overview', operator, 401, instance); assert.equal(revoked, true); }
  finally { await instance.close(); }
});

test('应用角色具有五表 SELECT 而没有业务写权限，真实路由只发 SELECT 与事务控制', async () => {
  for (const table of ['billing_plan_versions', 'billing_price_versions', 'billing_credit_pack_versions', 'billing_offer_grants', 'billing_subscriptions']) {
    const row = (await pool.query(`SELECT has_table_privilege(current_user,$1,'SELECT') AS read,
      has_table_privilege(current_user,$1,'INSERT,UPDATE,DELETE,TRUNCATE') AS write`, [table])).rows[0];
    assert.deepEqual(row, { read: true, write: false });
  }
  const operator = await actor(), statements: string[] = [];
  const database = { query: async (sql: string, values?: unknown[]) => { statements.push(sql); return pool.query(sql, values); },
    connect: async () => {
      const actual = await pool.connect();
      return { query: async (sql: string, values?: unknown[]) => { statements.push(sql); return actual.query(sql, values); }, release: () => actual.release() } as unknown as PoolClient;
    } } as unknown as Pool;
  const instance = billingApp(database);
  try {
    await instance.ready(); await catalog(instance);
    assert.ok(statements.includes('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'));
    assert.ok(!statements.some(sql => sql.includes('auth_sessions') || sql.includes('billing_offer_grants')));
    statements.length = 0; await overview(operator, instance);
    assert.ok(statements.includes('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'));
    assert.ok(statements.some(sql => sql.includes('FROM users WHERE id=$1 FOR NO KEY UPDATE')));
    assert.ok(statements.some(sql => sql.includes('FROM auth_sessions WHERE id=$1 FOR UPDATE')));
    assert.ok(!statements.some(sql => /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|CALL)\b/i.test(sql)));
  } finally { await instance.close(); }
});

test('目录选择每个 code 最新未退役版本、保持排序，draft 或未来 active 价格仍不启用支付', async () => {
  const settings = Object.assign({}, config, { paymentEnabled: true, paypal: { enabled: true, clientId: 'synthetic-only', clientSecret: 'synthetic-only' } });
  const configured = billingApp(pool, settings);
  try { await configured.ready(); assert.equal((await catalog(configured)).payment_enabled, false); }
  finally { await configured.close(); }
  const replacement = id('bpv'), retired = id('bpv');
  await withFixture(async db => {
    await db.query(`INSERT INTO billing_plan_versions(id,code,version,name,ai_mode,monthly_credits) VALUES
      ($1,'build',2,'新版 Build','limited',10000),($2,'build',3,'已退役 Build','limited',10000)`, [replacement, retired]);
    await db.query("UPDATE billing_plan_versions SET status='retired' WHERE id=$1", [retired]);
    for (const [interval, amount] of [['month', 9900], ['year', 69300]])
      await db.query('INSERT INTO billing_price_versions(id,plan_version_id,interval,amount_minor) VALUES($1,$2,$3,$4)', [id('bpr'), replacement, interval, amount]);
    await seedPrice(db);
  }, async instance => {
    const view = await catalog(instance); assert.deepEqual(view.plans.map(plan => plan.code), ['maintain', 'build', 'unlimited']);
    assert.equal(view.plans[1]!.id, replacement); assert.equal(view.plans[1]!.version, 2);
    assert.ok(!JSON.stringify(view).includes(retired)); assert.equal(view.payment_enabled, false); assert.deepEqual(view.seed_offer, seed);
    assert.ok(view.plans.every(plan => plan.prices.length === 2));
    assert.equal(view.plans[2]!.status, 'active'); assert.ok(view.plans[2]!.prices.every(price => price.status === 'active'));
    assert.equal(view.plans[2]!.ai.allocation_status, 'confirmed'); assert.equal(view.plans[2]!.ai.grant_schedule, 'service_month');
  });
});

test('配置积分包只标记 draft，active 夹具也不产生支付、额度强制或零余额', async () => {
  const operator = await actor(), packId = id('bcp');
  for (const endpoint of ['catalog', 'overview'] as const) {
    await withFixture(async db => {
      await db.query(`INSERT INTO billing_credit_pack_versions(id,name,credits,amount_minor,validity_policy,tax_policy,status)
        VALUES($1,'仅测试积分包',500,1000,'never_expires','inclusive','active')`, [packId]);
    }, async instance => {
      const summary = endpoint === 'catalog' ? await catalog(instance) : await overview(operator, instance);
      assert.equal(summary.addons_status, 'draft'); assert.equal(summary.payment_enabled, false);
      if ('credit_packs' in summary) {
        assert.deepEqual(summary.credit_packs, [{ id: packId, name: '仅测试积分包', credits: 500, amount_minor: 1000,
          tokens_per_credit: 100, currency: 'USD', validity_days: null, validity_policy: 'never_expires', status: 'active' }]);
      } else assert.deepEqual(summary.credits, noCredits);
    });
  }
});

test('有界种子 pending/approved/未来/到期/ended 仅是资格，不冒充已付或 Unlimited 权限', async () => {
  const operator = await actor(), accountId = await account(operator);
  for (const [status, from, end, expected] of [
    ['pending', null, null, 'pending'], ['approved', '2000-01-01', '2099-01-01', 'approved'],
    ['approved', '2098-01-01', '2099-01-01', 'pending'], ['approved', '2000-01-01', '2001-01-01', 'ended'],
    ['ended', null, null, 'ended'],
  ] as const) {
    await withFixture(async db => {
      const priceId = await seedPrice(db), grantId = id('bog');
      await db.query(`INSERT INTO billing_offer_grants(id,billing_account_id,price_version_id,status,valid_from,valid_end,approved_by,granted_at)
        VALUES($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7,CASE WHEN $7::text IS NULL THEN NULL ELSE clock_timestamp() END)`,
      [grantId, accountId, priceId, status === 'ended' ? 'pending' : status, from, end, status === 'approved' ? operator.id : null]);
      if (status === 'ended') await db.query("UPDATE billing_offer_grants SET status='ended' WHERE id=$1", [grantId]);
    }, async instance => {
      const view = await overview(operator, instance); assert.equal(view.seed_eligibility, expected);
      assert.equal(view.subscription, null); assert.deepEqual(view.credits, noCredits); assert.equal(view.payment_enabled, false);
    });
  }
});

test('只展示本人 current 或最后终止订阅，完整 null/UTC 微秒，不把 active 状态模拟当作支付受理', async () => {
  const operator = await actor(), accountId = await account(operator), subscriptionId = id('bsu');
  // owner 仅插入 011 允许的订阅状态夹具；没有 payment 表或任何真实支付事实，paid_through 始终 null。
  await owner.query(`INSERT INTO billing_subscriptions(id,billing_account_id,plan_version_id,price_version_id,status,period_start,period_end)
    VALUES($1,$2,$3,$4,'active','2026-01-01T00:00:00.123456Z','2026-02-01T00:00:00.123456Z')`,
  [subscriptionId, accountId, seededPlan(1), seededPrice(1)]);
  let view = await overview(operator);
  assert.deepEqual(view.subscription, { id: subscriptionId, plan_id: seededPlan(1), plan_code: 'maintain', plan_name: 'Maintain',
    price_id: seededPrice(1), interval: 'month', amount_minor: 5900, currency: 'USD', status: 'active',
    period_start: '2026-01-01T00:00:00.123456Z', period_end: '2026-02-01T00:00:00.123456Z', paid_through: null,
    cancel_requested_at: null, revision: 1 });
  assert.deepEqual(view.credits, noCredits); assert.equal(view.payment_enabled, false);
  await owner.query("UPDATE billing_subscriptions SET status='cancelled',cancel_requested_at='2026-01-15T00:00:00.654321Z' WHERE id=$1", [subscriptionId]);
  view = await overview(operator); assert.equal(view.subscription?.status, 'cancelled'); assert.equal(view.subscription?.revision, 2);
  const currentId = id('bsu'), latestEnded = id('bsu');
  await owner.query(`INSERT INTO billing_subscriptions(id,billing_account_id,plan_version_id,price_version_id,status,created_at) VALUES
    ($1,$3,$4,$5,'incomplete','2000-01-01'),($2,$3,$4,$5,'expired','2099-01-01')`,
  [currentId, latestEnded, accountId, seededPlan(2), seededPrice(4)]);
  view = await overview(operator); assert.equal(view.subscription?.id, currentId); assert.equal(view.subscription?.interval, 'year');
  assert.equal(view.subscription?.paid_through, null); assert.deepEqual(view.credits, noCredits);
  await owner.query("UPDATE billing_subscriptions SET status='expired' WHERE id=$1", [currentId]);
  assert.equal((await overview(operator)).subscription?.id, latestEnded);
});

test('overview 鉴权、账户、订阅共享一个 REPEATABLE READ 快照，途中新订阅不会混入本次结果', async () => {
  const operator = await actor(), accountId = await account(operator);
  let changed = false, connections = 0;
  const database = { query: pool.query.bind(pool), connect: async () => {
    connections++; const actual = await pool.connect();
    return { query: async (sql: string, values?: unknown[]) => {
      const result = await actual.query(sql, values);
      if (!changed && sql === 'SELECT id,status FROM billing_accounts WHERE owner_user_id=$1') {
        changed = true;
        await owner.query('INSERT INTO billing_subscriptions(id,billing_account_id,plan_version_id,price_version_id) VALUES($1,$2,$3,$4)',
          [id('bsu'), accountId, seededPlan(1), seededPrice(1)]);
      }
      return result;
    }, release: () => actual.release() } as unknown as PoolClient;
  } } as unknown as Pool;
  const instance = billingApp(database);
  try {
    await instance.ready(); assert.equal((await overview(operator, instance)).subscription, null);
    assert.equal(changed, true); assert.equal(connections, 1); assert.equal((await overview(operator)).subscription?.status, 'incomplete');
  } finally { await instance.close(); }
});

test('真实 PG 序列化冲突统一 503，错误不泄露 SQL、账户、身份或支付内容', async () => {
  const operator = await actor(); let conflicted = false;
  const database = { query: pool.query.bind(pool), connect: async () => {
    const actual = await pool.connect();
    return { query: async (sql: string, values?: unknown[]) => {
      const result = await actual.query(sql, values);
      if (!conflicted && sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ') {
        conflicted = true;
        await actual.query('SELECT id FROM users WHERE id=$1', [operator.id]);
        await owner.query("UPDATE users SET display_name='并发夹具' WHERE id=$1", [operator.id]);
      }
      return result;
    }, release: () => actual.release() } as unknown as PoolClient;
  } } as unknown as Pool;
  const instance = billingApp(database);
  try {
    await instance.ready(); const response = await request('GET', '/billing/overview', operator, undefined, {}, instance);
    assert.equal(response.statusCode, 503, response.body); valid(validateError, response.json()); assert.equal(conflicted, true);
    for (const value of ['SELECT', '40001', operator.id, operator.email, 'subscription']) assert.ok(!response.body.includes(value));
  } finally { await instance.close(); }
});

test('安全整数上界精确序列化，超界由真实 PG 约束拦截，不关闭 trigger 或强塞非法数据', async () => {
  const packId = id('bcp');
  await withFixture(async db => {
    await db.query('SAVEPOINT overflow_check');
    await assert.rejects(db.query('INSERT INTO billing_credit_pack_versions(id,name,credits,amount_minor) VALUES($1,$2,$3,1)',
      [packId, '超界夹具', '9007199254740992']), (failure: unknown) => (failure as { code?: string }).code === '23514');
    await db.query('ROLLBACK TO SAVEPOINT overflow_check');
    await db.query('INSERT INTO billing_credit_pack_versions(id,name,credits,amount_minor) VALUES($1,$2,$3,$3)',
      [packId, '安全上界夹具', '9007199254740991']);
  }, async instance => {
    const view = await catalog(instance); assert.equal(view.credit_packs[0]!.credits, Number.MAX_SAFE_INTEGER);
    assert.equal(view.credit_packs[0]!.amount_minor, Number.MAX_SAFE_INTEGER); assert.equal(view.payment_enabled, false);
  });
});

test('实际 quota ledger 有 grant 仍返回 not_configured 与全 null，不把观察 tokens 兑换为余额', async () => {
  const operator = await actor(), accountId = await account(operator), periodId = id('aqp');
  await owner.query(`INSERT INTO ai_quota_periods(id,billing_account_id,kind,starts_at,ends_at,grant_key)
    VALUES($1,$2,'trial',clock_timestamp(),clock_timestamp()+interval '30 days',$3)`, [periodId, accountId, id('grant')]);
  await owner.query("SELECT apply_ai_quota_entry($1,$2,NULL,'grant',$3,100,0,0,'FIXTURE_GRANT',$4)", [periodId, accountId, id('grant'), operator.id]);
  const periods = await snapshot('ai_quota_periods'), ledger = await snapshot('ai_quota_ledger');
  assert.deepEqual((await overview(operator)).credits, noCredits);
  assert.deepEqual(await snapshot('ai_quota_periods'), periods); assert.deepEqual(await snapshot('ai_quota_ledger'), ledger);
});

test('OpenAPI 完整对应共享类型，禁止额外字段、假余额和 payment true，只有两个 GET 与 Cookieauth', async () => {
  const operator = await actor(), summary = await catalog(), view = await overview(operator);
  assert.equal(validateCatalog({ ...summary, seed_eligibility: 'approved' }), false);
  assert.equal(validateCatalog({ ...summary, payment_enabled: true }), false);
  assert.equal(validateCatalog({ ...summary, seed_offer: { ...seed, price_id: seededPrice(7) } }), false);
  assert.equal(validateOverview({ ...view, credits: { ...noCredits, available: 0 } }), false);
  assert.equal(validateOverview({ ...view, account: { id: 'fixture', status: 'active', owner_user_id: operator.id } }), false);
  assert.equal(validateOverview({ ...view, subscription: { status: 'active' } }), false);
  assert.equal(validateOverview({ ...view, payment_enabled: true }), false);
  assert.equal(validateOverview({ ...view, generated_at: '2026-01-01T00:00:00.123Z' }), true);
  const contract = JSON.parse(await readFile(new URL('../contracts/billing.openapi.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(contract.paths).sort(), paths.map(path => `/api/v1${path}`).sort());
  assert.deepEqual(contract.paths['/api/v1/billing/catalog'].get.security, []);
  assert.equal(contract.components.securitySchemes.merchantSession.in, 'cookie');
  assert.equal(contract.components.securitySchemes.merchantSession.name, SESSION_COOKIE);
  for (const path of Object.values(contract.paths) as Record<string, unknown>[]) assert.deepEqual(Object.keys(path), ['get']);
});
