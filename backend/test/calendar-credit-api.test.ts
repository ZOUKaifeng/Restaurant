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
import { finishAiCall, startAiCall } from '../src/ai-metering.js';
import { grantCurrentCalendarCredits } from '../src/calendar-credits.js';
import type { AiCallStart, AiCallTotals, AiCreditPeriod, AiQuotaView, AiUsageCalls, AiUsageReport } from '../src/ai-usage-types.js';
import type { BillingCatalog, BillingOverview } from '../src/billing-types.js';
import { loadConfig, type Config } from '../src/config.js';
import { assertAppDatabase, id, transaction } from '../src/db.js';
import { FLOW_COOKIE, SESSION_COOKIE } from '../src/security.js';
import { migrate } from '../scripts/migrate.js';
import { createTestDatabasePools, readTestDatabaseScope } from './database-scope.js';

let app: FastifyInstance, pool: Pool, owner: Pool, config: Config, initialized = false, sequence = 0;
let validateReport: ValidateFunction, validateCalls: ValidateFunction, validateOverview: ValidateFunction, validateCatalog: ValidateFunction;
// 只清理隔离测试库业务表；新登记表必须在清单首位，不清理套餐/价格等目录种子或迁移记录。
const tables = 'ai_calendar_credit_grants,website_content_actions,website_version_sources,billing_subscriptions,billing_offer_grants,ai_quota_ledger,ai_quota_periods,ai_model_calls,billing_accounts,analytics_events,analytics_daily,menu_jobs,menu_drafts,website_publish_actions,website_publications,website_model_calls,website_jobs,website_versions,website_agents,asset_upload_intents,asset_references,assets,reservations,reservation_events,reservation_access_tokens,audit_logs,email_outbox,opening_hours,restaurant_members,auth_tokens,auth_sessions,auth_identities,restaurants,users';
const paths = ['/ai/usage', '/ai/usage/calls', '/billing/account', '/billing/overview'];
const password = '自然月API-Valid-Password-2026!';
const noQuota = { configured: false, enforced: false, available_tokens: null, granted_tokens: null, reserved_tokens: null, consumed_tokens: null };
const noCredits = { status: 'not_configured', enforced: false, available: null, reserved: null, consumed: null };
const empty: AiCallTotals = { calls: 0, known_usage_calls: 0, unknown_usage_calls: 0, pending_calls: 0,
  prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
type Report = AiUsageReport & { calendar_month_totals?: { period_id: string; totals: AiCallTotals } };
type Configured = Extract<AiQuotaView, { configured: true }>;
interface Anonymous { email: string; cookie: string; csrf: string }
interface Actor extends Anonymous { id: string }

before(async () => {
  // 缺变量/端点错配必须报错，绝不回退开发库、跳过测试或打印连接凭据。
  const scope = readTestDatabaseScope();
  config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: scope.databaseUrl, MIGRATION_DATABASE_URL: scope.migrationDatabaseUrl,
    APP_ORIGIN: 'https://localhost:5173', EMAIL_MODE: 'disabled', STORAGE_MODE: 'local',
    TOKEN_PEPPER: 'calendar-api-fixture-pepper-'.repeat(3), CURSOR_SECRET: 'calendar-api-fixture-cursor-'.repeat(3),
    OUTBOX_ENCRYPTION_KEY: 'd4'.repeat(32) });
  ({ pool, owner } = await createTestDatabasePools(scope));
  await migrate(owner, 'restaurant_test_app');
  assert.equal((await owner.query("SELECT version FROM schema_migrations WHERE version='013_calendar_test_credits'")).rowCount, 1,
    '主线程必须先将 013 接入正式 migrate；测试不直接执行 SQL 或补授权');
  await assertAppDatabase(pool);
  await owner.query(`TRUNCATE ${tables}`); initialized = true;
  const validators: Record<string, ValidateFunction> = {};
  for (const file of ['ai-usage', 'billing']) {
    const contract = JSON.parse(await readFile(new URL(`../contracts/${file}.openapi.json`, import.meta.url), 'utf8'));
    assert.equal(contract.openapi, '3.1.0');
    const schemas = JSON.parse(JSON.stringify(contract.components.schemas).replaceAll('#/components/schemas/', '#/$defs/'));
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const addFormats = createRequire(import.meta.url)('ajv-formats') as FormatsPlugin;
    addFormats(ajv);
    for (const name of file === 'ai-usage' ? ['AiUsageReport', 'AiUsageCalls'] : ['BillingOverview', 'BillingCatalog']) {
      validators[name] = ajv.compile({ $defs: schemas, $ref: `#/$defs/${name}` });
    }
  }
  validateReport = validators.AiUsageReport!; validateCalls = validators.AiUsageCalls!;
  validateOverview = validators.BillingOverview!; validateCatalog = validators.BillingCatalog!;
  app = createApp({ pool, config }); await app.ready();
  for (const path of paths) assert.ok(app.hasRoute({ method: 'GET', url: `/api/v1${path}` }));
});
beforeEach(async () => { if (initialized) await owner.query(`TRUNCATE ${tables}`); });
after(async () => {
  try { if (app) await app.close(); if (initialized) await owner.query(`TRUNCATE ${tables}`); }
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
    remoteAddress: `127.7.${Math.floor(++sequence / 250)}.${sequence % 250 + 1}` });
}
async function actor(): Promise<Actor> {
  const email = `calendar-api-${randomUUID()}@example.test`;
  const flow = await request('GET', '/auth/csrf', undefined, undefined, { origin: config.appOrigin });
  assert.equal(flow.statusCode, 200, flow.body);
  const anonymous = { email, cookie: cookie(flow, FLOW_COOKIE), csrf: flow.json().csrf_token as string };
  const registration = await request('POST', '/auth/register', anonymous,
    { email, password, locale: 'en', terms_version: 'terms-v1', accepted_terms: true });
  assert.equal(registration.statusCode, 202, registration.body);
  const row = (await owner.query<{ id: string; sensitive_payload_ciphertext: string }>(`SELECT id,sensitive_payload_ciphertext
    FROM email_outbox WHERE recipient_email_normalized=$1 AND template_key='verify_email'
      AND sensitive_payload_ciphertext IS NOT NULL`, [email])).rows[0];
  assert.ok(row, '使用真实注册/验证/登录和 Session，不访问 SMTP 或真实凭据');
  const [version, iv, tag, ciphertext] = row.sensitive_payload_ciphertext.split('.') as [string, string, string, string];
  assert.equal(version, 'v1');
  const decoder = createDecipheriv('aes-256-gcm', Buffer.from(config.outboxEncryptionKey, 'hex'), Buffer.from(iv, 'base64url'));
  decoder.setAAD(Buffer.from(row.id)); decoder.setAuthTag(Buffer.from(tag, 'base64url'));
  const token = JSON.parse(Buffer.concat([decoder.update(Buffer.from(ciphertext, 'base64url')), decoder.final()]).toString('utf8')).token;
  const verification = await request('POST', '/auth/verify-email', undefined, { token });
  assert.equal(verification.statusCode, 204, verification.body);
  const login = await request('POST', '/auth/login', anonymous, { email, password });
  assert.equal(login.statusCode, 200, login.body);
  const uid = (await owner.query<{ id: string }>('SELECT id FROM users WHERE email_normalized=$1', [email])).rows[0]!.id;
  return { id: uid, email, cookie: cookie(login, SESSION_COOKIE), csrf: login.json().csrf_token as string };
}
async function account(operator: Actor): Promise<string> {
  await owner.query('INSERT INTO billing_accounts(id,owner_user_id) VALUES($1,$2) ON CONFLICT(owner_user_id) DO NOTHING', [id('bla'), operator.id]);
  return (await pool.query<{ id: string }>('SELECT id FROM billing_accounts WHERE owner_user_id=$1', [operator.id])).rows[0]!.id;
}
async function fixture(operator: Actor): Promise<AiCallStart> {
  const created = await request('POST', '/restaurants', operator, { name: '自然月测试餐厅', primary_locale: 'en' }, { 'idempotency-key': id('create') });
  assert.equal(created.statusCode, 201, created.body);
  const rid = created.json().id as string, jobId = id('wjb'), runner = randomUUID();
  await owner.query(`INSERT INTO website_jobs(id,restaurant_id,requesting_user_id,kind,idempotency_key,request_fingerprint,
    input,snapshot,status,lease_token,lease_expires_at) VALUES($1,$2,$3,'generate',$4,$5,'{}','{}','running',$6,
    clock_timestamp()+interval '10 minutes')`, [jobId, rid, operator.id, id('job'), 'a'.repeat(64), runner]);
  return { requestingUserId: operator.id, restaurantId: rid, websiteJobId: jobId, runnerToken: runner, callIndex: 1, model: 'deepseek-flash' };
}
async function started(input: AiCallStart, at?: string): Promise<string> {
  return transaction(at ? owner : pool, async db => {
    await db.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [input.requestingUserId]);
    await db.query('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE', [input.restaurantId]);
    await db.query('SELECT id FROM restaurant_members WHERE restaurant_id=$1 AND user_id=$2 FOR UPDATE', [input.restaurantId, input.requestingUserId]);
    await db.query('SELECT id FROM website_jobs WHERE id=$1 FOR UPDATE', [input.websiteJobId]);
    if (!at) return startAiCall(db, input);
    // 仅 owner 隔离 fixture 为真实 start helper 的新 INSERT 提供精确时间；不改旧调用、provider 或 trigger。
    const clockDb = { query: (sql: string, values?: unknown[]) => {
      if (!sql.startsWith('INSERT INTO ai_model_calls(')) return db.query(sql, values);
      assert.ok(sql.includes('request_key)') && sql.includes('$9,$10)'));
      return db.query(sql.replace('request_key)', 'request_key,created_at)').replace('$9,$10)', '$9,$10,$11::timestamptz)'), [...values!, at]);
    } } as unknown as PoolClient;
    return startAiCall(clockDb, input);
  });
}
async function finished(input: AiCallStart, total?: number, failed = false): Promise<void> {
  // 只记录合成的 provider 回调事实，不发请求、不调用真实模型或 worker。
  await transaction(pool, db => finishAiCall(db, { ...input, status: failed ? 'failed' : 'completed', elapsedMs: 3,
    ...(failed ? { errorCode: 'MODEL_FAILED' } : {}),
    ...(total === undefined ? {} : { usage: { prompt_tokens: total, completion_tokens: 0, total_tokens: total } }) }));
}
async function report(operator: Actor, query = '', instance = app): Promise<Report> {
  const response = await request('GET', `/ai/usage${query ? `?${query}` : ''}`, operator, undefined, {}, instance);
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as Report; assert.ok(validateReport(body), JSON.stringify(validateReport.errors)); return body;
}
async function overview(operator: Actor, instance = app): Promise<BillingOverview> {
  const response = await request('GET', '/billing/overview', operator, undefined, {}, instance);
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as BillingOverview; assert.ok(validateOverview(body), JSON.stringify(validateOverview.errors)); return body;
}
async function calls(operator: Actor): Promise<AiUsageCalls> {
  const response = await request('GET', '/ai/usage/calls', operator);
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as AiUsageCalls; assert.ok(validateCalls(body), JSON.stringify(validateCalls.errors)); return body;
}
function microseconds(value: string): bigint {
  assert.match(value, /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  const milliseconds = Date.parse(`${value.slice(0, 23)}Z`);
  assert.ok(Number.isSafeInteger(milliseconds));
  assert.equal(new Date(milliseconds).toISOString(), `${value.slice(0, 23)}Z`);
  return BigInt(milliseconds) * 1000n + BigInt(value.slice(23, 26));
}
function configured(view: AiQuotaView): Configured {
  assert.equal(view.configured, true); if (!view.configured) throw new Error('测试要求显式登记的本月额度');
  for (const key of ['granted_tokens', 'reserved_tokens', 'consumed_tokens', 'available_tokens'] as const) assert.ok(Number.isSafeInteger(view[key]));
  assert.equal(BigInt(view.granted_tokens) - BigInt(view.reserved_tokens) - BigInt(view.consumed_tokens), BigInt(view.available_tokens));
  const period = view.period, start = microseconds(period.starts_at), end = microseconds(period.ends_at), granted = microseconds(period.granted_at);
  assert.ok(start <= granted && granted < end);
  assert.match(period.starts_at, /^\d{4}-\d{2}-01T00:00:00\.000000Z$/);
  const next = new Date(period.starts_at); next.setUTCMonth(next.getUTCMonth() + 1);
  assert.equal(period.ends_at, next.toISOString().replace('.000Z', '.000000Z'));
  assert.deepEqual([period.timezone, period.origin, period.tokens_per_credit, period.auto_renew], ['UTC', 'development_test', 100, false]);
  return view;
}
async function grant(operator: Actor, credits = 10000): Promise<Configured> {
  return configured(await grantCurrentCalendarCredits(owner, operator.id, credits, `calendar-api:${operator.id}:current`));
}
async function entries(callId: string) {
  return (await pool.query('SELECT * FROM ai_quota_ledger WHERE call_id=$1 ORDER BY id', [callId])).rows;
}
async function snapshots(names = ['users', 'auth_sessions', 'billing_accounts', 'ai_calendar_credit_grants', 'ai_quota_periods',
  'ai_quota_ledger', 'ai_model_calls', 'billing_subscriptions', 'billing_offer_grants', 'billing_plan_versions', 'billing_price_versions']) {
  return Promise.all(names.map(async table => (await owner.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows));
}
async function timestamp(at: string, offset: string): Promise<string> {
  return (await owner.query<{ at: string }>(`SELECT to_char(($1::timestamptz+$2::interval) AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`, [at, offset])).rows[0]!.at;
}
async function period(db: PoolClient, accountId: string, uid: string, offset = 0, kind = 'trial'): Promise<AiCreditPeriod> {
  const key = id('fixture'), pid = id('aqp');
  await db.query(`WITH month AS (SELECT date_trunc('month',statement_timestamp() AT TIME ZONE 'UTC')+$4::int*interval '1 month' AS start)
    INSERT INTO ai_quota_periods(id,billing_account_id,kind,starts_at,ends_at,grant_key)
    SELECT $1,$2,$5,start AT TIME ZONE 'UTC',(start+interval '1 month') AT TIME ZONE 'UTC',$3 FROM month`, [pid, accountId, key, offset, kind]);
  await db.query("SELECT apply_ai_quota_entry($1,$2,NULL,'grant',$3,1000000,0,0,'DEVELOPMENT_TEST_GRANT',$4)", [pid, accountId, key, uid]);
  const times = (await db.query<{ starts_at: string; ends_at: string; granted_at: string }>(`SELECT
    to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS starts_at,
    to_char(ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ends_at,
    to_char((starts_at AT TIME ZONE 'UTC')+interval '1 hour','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS granted_at
    FROM ai_quota_periods WHERE id=$1`, [pid])).rows[0]!;
  return { id: pid, ...times, timezone: 'UTC', origin: 'development_test', tokens_per_credit: 100, auto_renew: false };
}

// 本文件由主线程统一串行执行真实 PG 验收；本批只新增并静态检查，不运行 PG。
test('未登记新用户保持原六字段 quota、五字段 credits 和严格报表 shape；GET 不建账户', async () => {
  const operator = await actor(), beforeRows = await snapshots();
  const summary = await report(operator), bill = await overview(operator);
  assert.deepEqual(summary.quota, noQuota); assert.equal(summary.billing_account, null);
  assert.equal(Object.hasOwn(summary, 'calendar_month_totals'), false); assert.deepEqual(summary.account_totals, empty);
  assert.deepEqual(bill.credits, noCredits); assert.equal(bill.account, null); assert.equal(bill.subscription, null);
  assert.equal(bill.payment_enabled, false);
  assert.deepEqual(Object.keys(summary).sort(), ['mode', 'policy_version', 'generated_at', 'billing_account', 'quota', 'filters',
    'account_totals', 'filtered_totals', 'by_feature', 'legacy'].sort());
  assert.equal(validateReport({ ...summary, calendar_month_totals: { period_id: id('aqp'), totals: empty } }), false);
  assert.equal(validateReport({ ...summary, quota: { ...noQuota, available_tokens: 0 } }), false);
  assert.equal(validateOverview({ ...bill, credits: { ...noCredits, granted: null } }), false);
  assert.deepEqual(await snapshots(), beforeRows);
});

test('owner 真实授额10000积分，usage为1000000 raw tokens，billing为10000 credits且不伪造订阅或价格', async () => {
  const operator = await actor(), quota = await grant(operator), summary = await report(operator), bill = await overview(operator);
  assert.deepEqual(summary.quota, quota);
  assert.deepEqual(summary.calendar_month_totals, { period_id: quota.period.id, totals: empty });
  assert.deepEqual(bill.credits, { status: 'development_test', enforced: false, available: 10000, reserved: 0, consumed: 0,
    granted: 10000, period: quota.period });
  assert.equal(bill.subscription, null); assert.equal(bill.payment_enabled, false); assert.equal(bill.mode, 'observation');
  assert.equal(summary.mode, 'observation'); assert.equal(summary.policy_version, 'observation-v1');
  assert.equal((await pool.query('SELECT * FROM ai_model_calls')).rowCount, 0);
  assert.equal((await pool.query('SELECT * FROM ai_quota_ledger')).rowCount, 1);
  assert.equal((await pool.query('SELECT * FROM billing_offer_grants')).rowCount, 0);
  const catalog = await request('GET', '/billing/catalog'); assert.equal(catalog.statusCode, 200, catalog.body);
  assert.ok(validateCatalog(catalog.json()), JSON.stringify(validateCatalog.errors));
  const body = catalog.json() as BillingCatalog; assert.equal(body.payment_enabled, false);
  assert.ok(!catalog.body.includes(quota.period.id));
});

test('授额后真实 start/finish 的100 tokens只扣1积分，重放只一笔consume，不预留且calls仍非金钱chargeable:false', async () => {
  const operator = await actor(), input = await fixture(operator), quota = await grant(operator);
  const callId = await started(input); await finished(input, 100); await finished(input, 100);
  const summary = await report(operator), current = configured(summary.quota), bill = await overview(operator);
  assert.equal(current.available_tokens, 999900); assert.equal(current.consumed_tokens, 100); assert.equal(current.reserved_tokens, 0);
  assert.equal(bill.credits.available, 9999); assert.equal(bill.credits.consumed, 1); assert.equal(bill.credits.reserved, 0);
  assert.deepEqual(summary.calendar_month_totals, { period_id: quota.period.id, totals: { ...empty, calls: 1, known_usage_calls: 1,
    prompt_tokens: 100, total_tokens: 100 } });
  const ledger = await entries(callId); assert.equal(ledger.length, 1);
  assert.equal(ledger[0].entry_type, 'consume'); assert.equal(ledger[0].delta_consumed_tokens, '100');
  assert.equal(ledger[0].delta_reserved_tokens, '0'); assert.equal(ledger[0].period_id, quota.period.id);
  const page = await calls(operator); assert.equal(page.items[0]!.chargeable, false); assert.equal(page.items[0]!.total_tokens, 100);
  assert.deepEqual(Object.keys(page).sort(), ['filters', 'items', 'next_cursor']);
});

test('pending/unknown只计次数不冒充known零；真实known零与失败已知用量进入授额后本月统计', async () => {
  const operator = await actor(), input = await fixture(operator); await grant(operator);
  const unknown = await started(input); await finished(input);
  const pending = await started({ ...input, callIndex: 2 });
  const zero = { ...input, callIndex: 3 }, zeroId = await started(zero); await finished(zero, 0);
  const failed = { ...input, callIndex: 4 }; await started(failed); await finished(failed, 17, true);
  const summary = await report(operator), expected = { ...empty, calls: 4, known_usage_calls: 2, unknown_usage_calls: 1,
    pending_calls: 1, prompt_tokens: 17, total_tokens: 17 };
  assert.deepEqual(summary.account_totals, expected); assert.deepEqual(summary.calendar_month_totals!.totals, expected);
  assert.equal(configured(summary.quota).consumed_tokens, 17); assert.equal((await overview(operator)).credits.consumed, 0.17);
  const page = await calls(operator);
  for (const callId of [unknown, pending]) {
    assert.equal((await entries(callId)).length, 0);
    const row = page.items.find(item => item.id === callId)!;
    assert.equal(row.prompt_tokens, null); assert.equal(row.completion_tokens, null); assert.equal(row.total_tokens, null);
  }
  assert.equal((await entries(zeroId)).length, 1); assert.equal((await entries(zeroId))[0].delta_consumed_tokens, '0');
});

test('授额前known与pending不追扣；旧账户all time仍显示，calendar只计授额后新live且不受filters影响', async () => {
  const operator = await actor(), input = await fixture(operator), oldId = await started(input); await finished(input, 41);
  const pending = { ...input, callIndex: 2 }, pendingId = await started(pending);
  const oldRow = (await pool.query('SELECT * FROM ai_model_calls WHERE id=$1', [oldId])).rows[0];
  await grant(operator); await finished(pending, 53);
  const summary = await report(operator);
  assert.equal(summary.account_totals.total_tokens, 94); assert.equal(summary.account_totals.calls, 2);
  assert.deepEqual(summary.calendar_month_totals!.totals, empty); assert.equal(configured(summary.quota).consumed_tokens, 0);
  assert.deepEqual((await pool.query('SELECT * FROM ai_model_calls WHERE id=$1', [oldId])).rows[0], oldRow);
  assert.equal((await entries(oldId)).length, 0); assert.equal((await entries(pendingId)).length, 0);
  const next = { ...input, callIndex: 3 }; await started(next); await finished(next, 7);
  const current = await report(operator);
  for (const query of ['origin=legacy_import', 'feature=menu_recognition', 'from=2000-01-01&to=2000-01-02', `restaurant_id=${input.restaurantId}`]) {
    const filtered = await report(operator, query);
    assert.deepEqual(filtered.account_totals, current.account_totals); assert.deepEqual(filtered.legacy, current.legacy);
    assert.deepEqual(filtered.calendar_month_totals, current.calendar_month_totals); assert.deepEqual(filtered.quota, current.quota);
    if (!query.startsWith('restaurant_id')) assert.deepEqual(filtered.filtered_totals, empty);
  }
  assert.equal(current.account_totals.total_tokens, 101); assert.equal(current.calendar_month_totals!.totals.total_tokens, 7);
});

test('010普通trial/paid即使有真实grant和当月known调用也不是registered配置，不显示测试余额', async () => {
  for (const kind of ['trial', 'paid']) {
    const operator = await actor(), accountId = await account(operator), input = await fixture(operator);
    await transaction(owner, db => period(db, accountId, operator.id, 0, kind));
    const callId = await started(input); await finished(input, 99);
    const summary = await report(operator), bill = await overview(operator);
    assert.deepEqual(summary.quota, noQuota); assert.deepEqual(bill.credits, noCredits);
    assert.equal(Object.hasOwn(summary, 'calendar_month_totals'), false); assert.equal(summary.account_totals.total_tokens, 99);
    assert.equal((await entries(callId)).length, 0); assert.equal(bill.subscription, null);
  }
  assert.equal((await pool.query('SELECT * FROM ai_calendar_credit_grants')).rowCount, 0);
});

test('跨用户不串读也不自动授额；无账户和已有未配置账户均保持原shape，跨店筛选404', async () => {
  const first = await actor(), second = await actor(), input = await fixture(first), quota = await grant(first);
  assert.deepEqual((await report(second)).quota, noQuota); assert.equal((await overview(second)).account, null);
  const otherInput = await fixture(second), otherId = await started(otherInput); await finished(otherInput, 61);
  const other = await report(second); assert.deepEqual(other.quota, noQuota); assert.equal(other.account_totals.total_tokens, 61);
  assert.equal(Object.hasOwn(other, 'calendar_month_totals'), false); assert.deepEqual((await overview(second)).credits, noCredits);
  assert.equal((await entries(otherId)).length, 0); assert.deepEqual((await report(first)).quota, quota);
  const response = await request('GET', `/ai/usage?restaurant_id=${input.restaurantId}`, second); assert.equal(response.statusCode, 404);
  assert.equal((await pool.query('SELECT * FROM ai_calendar_credit_grants')).rowCount, 1);
  assert.equal((await pool.query("SELECT * FROM ai_quota_ledger WHERE entry_type='grant'")).rowCount, 1);
});

test('真实会话撤销、过期和用户失效均401，不返回额度、周期或账单内容', async () => {
  for (const mode of ['revoked', 'expired', 'unverified', 'suspended']) {
    const operator = await actor(); await grant(operator);
    if (mode === 'revoked') await owner.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE user_id=$1', [operator.id]);
    if (mode === 'expired') await owner.query("UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1", [operator.id]);
    if (mode === 'unverified') await owner.query("UPDATE users SET status='pending_verification',email_verified_at=NULL WHERE id=$1", [operator.id]);
    if (mode === 'suspended') await owner.query("UPDATE users SET status='suspended' WHERE id=$1", [operator.id]);
    for (const path of paths) {
      const response = await request('GET', path, operator); assert.equal(response.statusCode, 401, response.body);
      for (const field of ['quota', 'credits', 'period', 'calendar_month_totals']) assert.equal(Object.hasOwn(response.json(), field), false);
    }
  }
});

test('同周期suspended/closed账户不增加额外quota状态，迟到known仍记录原消费但读取回到旧未配置shape', async () => {
  const operator = await actor(), input = await fixture(operator), accountId = await account(operator), quota = await grant(operator);
  const callId = await started(input);
  await owner.query("UPDATE billing_accounts SET status='suspended' WHERE id=$1", [accountId]); await finished(input, 19);
  assert.equal((await entries(callId))[0].period_id, quota.period.id);
  for (const status of ['suspended', 'closed']) {
    await owner.query('UPDATE billing_accounts SET status=$2 WHERE id=$1', [accountId, status]);
    const summary = await report(operator), bill = await overview(operator);
    assert.deepEqual(summary.quota, noQuota); assert.equal(Object.hasOwn(summary, 'calendar_month_totals'), false);
    assert.deepEqual(bill.credits, noCredits); assert.equal(bill.account!.status, status); assert.equal(summary.account_totals.total_tokens, 19);
  }
});

test('GET只读同一事务accountID且readCalendarQuota只读一次；用户会话、余额周期、登记和目录均不写或续发', async () => {
  const operator = await actor(), input = await fixture(operator), accountId = await account(operator); await grant(operator);
  await started(input); await finished(input, 100);
  const beforeRows = await snapshots(), statements: Array<{ sql: string; values?: unknown[]; transaction: boolean }> = [];
  let connections = 0;
  const database = { query: async (sql: string, values?: unknown[]) => {
    statements.push({ sql, values, transaction: false }); return pool.query(sql, values);
  }, connect: async () => {
    connections++; const actual = await pool.connect();
    return { query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values, transaction: true }); return actual.query(sql, values);
    }, release: () => actual.release() } as unknown as PoolClient;
  } } as unknown as Pool;
  const instance = createApp({ pool: database, config });
  try {
    await instance.ready();
    for (const path of ['/ai/usage', '/billing/overview']) {
      statements.length = 0; connections = 0;
      const response = await request('GET', path, operator, undefined, {}, instance); assert.equal(response.statusCode, 200, response.body);
      assert.equal(connections, 1);
      const reads = statements.filter(item => item.sql.includes('FROM ai_calendar_credit_grants g'));
      assert.equal(reads.length, 1); assert.equal(reads[0]!.transaction, true); assert.deepEqual(reads[0]!.values, [accountId, response.json().generated_at]);
      assert.match(response.json().generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      assert.ok(statements.some(item => item.sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'));
      assert.ok(!statements.some(item => /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|CALL)\b/i.test(item.sql)));
      assert.ok(!statements.some(item => item.sql.includes('apply_ai_quota_entry')));
    }
    for (const path of ['/billing/account', '/billing/catalog', '/ai/usage/calls']) {
      const response = await request('GET', path, operator, undefined, {}, instance); assert.equal(response.statusCode, 200, response.body);
    }
    assert.deepEqual(await snapshots(), beforeRows);
  } finally { await instance.close(); }
});

test('owner新调用时间fixture覆盖授额微秒及UTC月半开边界，不按finish月份算且不修改旧调用', async () => {
  const operator = await actor(), input = await fixture(operator), quota = await grant(operator), p = quota.period;
  const cases = [
    { at: await timestamp(p.starts_at, '-1 microsecond'), included: false }, { at: p.starts_at, included: false },
    { at: await timestamp(p.granted_at, '-1 microsecond'), included: false }, { at: p.granted_at, included: true },
    { at: await timestamp(p.ends_at, '-1 microsecond'), included: true }, { at: p.ends_at, included: false },
  ];
  for (let index = 0; index < cases.length; index++) {
    const item = cases[index]!, current = { ...input, callIndex: index + 1 }, callId = await started(current, item.at);
    await finished(current, 1); assert.equal((await entries(callId)).length, item.included ? 1 : 0);
  }
  const summary = await report(operator), current = configured(summary.quota);
  assert.equal(summary.account_totals.calls, 6); assert.equal(summary.account_totals.total_tokens, 6);
  assert.deepEqual(summary.calendar_month_totals!.totals, { ...empty, calls: 2, known_usage_calls: 2, prompt_tokens: 2, total_tokens: 2 });
  assert.equal(current.consumed_tokens, 2); assert.equal((await overview(operator)).credits.consumed, 0.02);
});

test('旧月登记仅owner显式历史fixture；月后unknown补known扣原周期，当前GET无配置、不删除历史也不续发', async () => {
  const operator = await actor(), input = await fixture(operator), accountId = await account(operator);
  const p = await transaction(owner, async db => {
    const prior = await period(db, accountId, operator.id, -1);
    await db.query('INSERT INTO ai_calendar_credit_grants(period_id,billing_account_id,actor_user_id,granted_at) VALUES($1,$2,$3,$4::timestamptz)',
      [prior.id, accountId, operator.id, prior.granted_at]); return prior;
  });
  const callId = await started(input, await timestamp(p.granted_at, '1 microsecond'));
  await finished(input); assert.equal((await entries(callId)).length, 0); await finished(input, 77);
  assert.equal((await entries(callId))[0].period_id, p.id);
  const beforeRows = await snapshots(), summary = await report(operator), bill = await overview(operator);
  assert.deepEqual(summary.quota, noQuota); assert.deepEqual(bill.credits, noCredits);
  assert.equal(Object.hasOwn(summary, 'calendar_month_totals'), false); assert.equal(summary.account_totals.total_tokens, 77);
  assert.deepEqual(await snapshots(), beforeRows);
  await assert.rejects(() => grantCurrentCalendarCredits(owner, operator.id, 10000, id('nextmonth')), /一次 trial/);
  assert.equal((await pool.query('SELECT * FROM ai_calendar_credit_grants')).rowCount, 1);
  assert.equal((await pool.query("SELECT * FROM ai_quota_ledger WHERE entry_type='expire'")).rowCount, 0);
});

test('未来月授额登记被真实guard拒绝并回滚；app不能授额且失败不残留账户或登记', async () => {
  const operator = await actor(), accountId = await account(operator), beforeRows = await snapshots();
  await assert.rejects(() => transaction(owner, async db => {
    const future = await period(db, accountId, operator.id, 1);
    await db.query('INSERT INTO ai_calendar_credit_grants(period_id,billing_account_id,actor_user_id,granted_at) VALUES($1,$2,$3,$4::timestamptz)',
      [future.id, accountId, operator.id, future.granted_at]);
  }), { code: '23514' });
  assert.deepEqual(await snapshots(), beforeRows); assert.deepEqual((await report(operator)).quota, noQuota);
  const other = await actor();
  await assert.rejects(() => grantCurrentCalendarCredits(pool, other.id, 10000, id('denied')), { code: '42501' });
  assert.equal((await pool.query('SELECT id FROM billing_accounts WHERE owner_user_id=$1', [other.id])).rowCount, 0);
  assert.equal((await pool.query('SELECT * FROM ai_calendar_credit_grants')).rowCount, 0);
  assert.equal((await pool.query('SELECT * FROM ai_quota_periods')).rowCount, 0);
});

test('signed负余额不启用hard limit，billing按/100展示小数且严格oneOf拒绝缺period/granted及混合false结构', async () => {
  const operator = await actor(), input = await fixture(operator); await grant(operator, 1);
  await started(input); await finished(input, 101);
  const next = { ...input, callIndex: 2 }; await started(next); await finished(next, 1);
  const summary = await report(operator), quota = configured(summary.quota), bill = await overview(operator);
  assert.equal(quota.available_tokens, -2); assert.equal(quota.consumed_tokens, 102); assert.equal(quota.enforced, false);
  assert.equal(bill.credits.available, -0.02); assert.equal(bill.credits.consumed, 1.02); assert.equal(bill.payment_enabled, false);
  const { period: ignoredPeriod, ...withoutPeriod } = quota; assert.ok(ignoredPeriod);
  assert.equal(validateReport({ ...summary, quota: withoutPeriod }), false);
  if (bill.credits.status !== 'development_test') throw new Error('测试要求真实测试积分');
  const { granted: ignoredGranted, ...withoutGranted } = bill.credits; assert.equal(ignoredGranted, 1);
  assert.equal(validateOverview({ ...bill, credits: withoutGranted }), false);
  assert.equal(validateReport({ ...summary, quota: { ...quota, reserved_tokens: -1 } }), false);
  assert.equal(validateReport({ ...summary, quota: { ...quota, available_tokens: Number.MAX_SAFE_INTEGER + 1 } }), false);
  assert.equal(validateReport({ ...summary, quota: { ...noQuota, period: quota.period } }), false);
  assert.equal(validateOverview({ ...bill, credits: { ...noCredits, period: quota.period } }), false);
  assert.equal(validateOverview({ ...bill, payment_enabled: true }), false);
  assert.equal(validateReport({ ...summary, calendar_month_totals: { ...summary.calendar_month_totals, extra: 1 } }), false);
  assert.equal(validateReport({ ...summary, calendar_month_totals: { period_id: quota.period.id, totals: { ...empty, total_tokens: -1 } } }), false);
  for (const mutation of [{ timezone: 'Asia/Shanghai' }, { origin: 'paid' }, { auto_renew: true }, { tokens_per_credit: 1 },
    { starts_at: '2026-01-02T00:00:00.000000Z' }, { granted_at: '2026-01-01T00:00:00.000Z' }]) {
    assert.equal(validateReport({ ...summary, quota: { ...quota, period: { ...quota.period, ...mutation } } }), false);
    assert.equal(validateOverview({ ...bill, credits: { ...bill.credits, period: { ...quota.period, ...mutation } } }), false);
  }
});
