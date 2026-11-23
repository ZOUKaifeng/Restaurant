import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createDecipheriv, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createRequire } from 'node:module';
import type { FormatsPlugin } from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import { createApp } from '../src/app.js';
import { registerAiUsage } from '../src/ai-usage.js';
import { finishAiCall, startAiCall } from '../src/ai-metering.js';
import type { AiCallStart, AiTokenUsage, AiUsageCalls, AiUsageReport } from '../src/ai-usage-types.js';
import { loadConfig, type Config } from '../src/config.js';
import { assertAppDatabase, id, transaction } from '../src/db.js';
import { migrate } from '../scripts/migrate.js';
import { insertPre012LegacyFixture } from './website-fixtures.js';
import { FLOW_COOKIE, SESSION_COOKIE } from '../src/security.js';

let app: FastifyInstance, pool: Pool, owner: Pool, config: Config, ready = false;
let sequence = 0;
let schemas: Record<string, unknown>, validateReport: ValidateFunction, validateCalls: ValidateFunction,
  validateAccount: ValidateFunction, validateError: ValidateFunction, validateOverflow: ValidateFunction;
const paths = ['/ai/usage', '/ai/usage/calls', '/billing/account'];
const tables = 'ai_calendar_credit_grants,website_content_actions,website_version_sources,billing_subscriptions,billing_offer_grants,ai_quota_ledger,ai_quota_periods,ai_model_calls,billing_accounts,analytics_events,analytics_daily,menu_jobs,menu_drafts,website_publish_actions,website_publications,website_model_calls,website_jobs,website_versions,website_agents,asset_upload_intents,asset_references,assets,reservations,reservation_events,reservation_access_tokens,audit_logs,email_outbox,opening_hours,restaurant_members,auth_tokens,auth_sessions,auth_identities,restaurants,users';
const password = '观测测试-Valid-Password-2026!';
const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
const zero = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
const empty = { calls: 0, known_usage_calls: 0, unknown_usage_calls: 0, pending_calls: 0, ...zero };
const noFilters = { restaurant_id: null, feature: null, origin: null, from: null, to: null };
const noQuota = { configured: false, enforced: false, available_tokens: null, granted_tokens: null, reserved_tokens: null, consumed_tokens: null };
const noLegacy = { aggregate_jobs: 0, known_total_tokens: 0, unknown_usage_jobs: 0 };
interface Actor { id: string; email: string; cookie: string; csrf: string }
interface Anonymous { email: string; cookie: string; csrf: string }

import { createTestDatabasePools, readTestDatabaseScope } from './database-scope.js';
function usageApp(database = pool): FastifyInstance {
  const instance = createApp({ pool: database, config });
  // 在主 app 的插件之后接入；主线程以后注册路由时也不会重复注册。
  instance.register(async routes => {
    if (!instance.hasRoute({ method: 'GET', url: '/api/v1/ai/usage' })) registerAiUsage(routes, database, config);
  });
  return instance;
}
before(async () => {
  const scope = readTestDatabaseScope();
  const { databaseUrl, migrationDatabaseUrl } = scope;
  config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, MIGRATION_DATABASE_URL: migrationDatabaseUrl,
    APP_ORIGIN: 'https://localhost:5173', EMAIL_MODE: 'disabled', STORAGE_MODE: 'local',
    TOKEN_PEPPER: 'ai-usage-fixture-pepper-'.repeat(3), CURSOR_SECRET: 'ai-usage-fixture-cursor-'.repeat(3),
    OUTBOX_ENCRYPTION_KEY: 'b2'.repeat(32) });
  ({ owner, pool } = await createTestDatabasePools(scope));
  await migrate(owner, 'restaurant_test_app');
  await assertAppDatabase(pool);
  await owner.query(`TRUNCATE ${tables}`);
  ready = true;
  const contract = JSON.parse(await readFile(new URL('../contracts/ai-usage.openapi.json', import.meta.url), 'utf8'));
  assert.equal(contract.openapi, '3.1.0');
  // Ajv2020 验证真实 API 返回体；只改写 JSON Pointer 容器，不弱化或重写 response schema。
  schemas = JSON.parse(JSON.stringify(contract.components.schemas).replaceAll('#/components/schemas/', '#/$defs/'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const addFormats = createRequire(import.meta.url)('ajv-formats') as FormatsPlugin;
  addFormats(ajv);
  const compile = (name: string) => ajv.compile({ $defs: schemas, $ref: `#/$defs/${name}` });
  validateReport = compile('AiUsageReport'); validateCalls = compile('AiUsageCalls');
  validateAccount = compile('BillingAccountResponse'); validateError = compile('Error'); validateOverflow = compile('OverflowError');
  app = usageApp(); await app.ready();
});
beforeEach(async () => { if (ready) await owner.query(`TRUNCATE ${tables}`); });
after(async () => {
  try { if (app) await app.close(); if (ready) await owner.query(`TRUNCATE ${tables}`); }
  finally { await Promise.all([pool?.end(), owner?.end()]); }
});
function cookie(response: { headers: Record<string, unknown> }, name: string): string {
  const values = response.headers['set-cookie'];
  const found = (Array.isArray(values) ? values : [values]).find(value => typeof value === 'string' && value.startsWith(`${name}=`));
  assert.equal(typeof found, 'string');
  return (found as string).split(';')[0]!;
}
async function request(method: HTTPMethods, path: string, actor?: Anonymous, payload?: Record<string, unknown>,
  extra: Record<string, string> = {}, instance = app) {
  const headers: Record<string, string> = { ...extra };
  if (actor) { headers.cookie = actor.cookie; headers['x-csrf-token'] = actor.csrf; }
  if (method !== 'GET') headers.origin ??= config.appOrigin;
  if (payload !== undefined) headers['content-type'] ??= 'application/json';
  return instance.inject({ method, url: `/api/v1${path}`, headers, ...(payload === undefined ? {} : { payload }),
    remoteAddress: `127.9.${Math.floor(++sequence / 250)}.${sequence % 250 + 1}` });
}
function valid(validator: ValidateFunction, body: unknown): void {
  assert.ok(validator(body), JSON.stringify(validator.errors));
}
async function register(): Promise<Anonymous> {
  const email = `ai-usage-${randomUUID()}@example.test`;
  const flow = await request('GET', '/auth/csrf', undefined, undefined, { origin: config.appOrigin });
  assert.equal(flow.statusCode, 200, flow.body);
  const anonymous = { email, cookie: cookie(flow, FLOW_COOKIE), csrf: flow.json().csrf_token as string };
  const response = await request('POST', '/auth/register', anonymous,
    { email, password, locale: 'en', terms_version: 'terms-v1', accepted_terms: true });
  assert.equal(response.statusCode, 202, response.body);
  return anonymous;
}
async function actor(): Promise<Actor> {
  const anonymous = await register();
  const row = (await owner.query(`SELECT id,sensitive_payload_ciphertext FROM email_outbox
    WHERE recipient_email_normalized=$1 AND template_key='verify_email' AND sensitive_payload_ciphertext IS NOT NULL`, [anonymous.email])).rows[0];
  assert.ok(row, '真实注册应生成测试邮箱验证 outbox；不运行 SMTP 或读取真实密钥');
  const [version, iv, tag, ciphertext] = row.sensitive_payload_ciphertext.split('.');
  assert.equal(version, 'v1');
  const decoder = createDecipheriv('aes-256-gcm', Buffer.from(config.outboxEncryptionKey, 'hex'), Buffer.from(iv, 'base64url'));
  decoder.setAAD(Buffer.from(row.id)); decoder.setAuthTag(Buffer.from(tag, 'base64url'));
  const token = JSON.parse(Buffer.concat([decoder.update(Buffer.from(ciphertext, 'base64url')), decoder.final()]).toString('utf8')).token;
  const verified = await request('POST', '/auth/verify-email', undefined, { token });
  assert.equal(verified.statusCode, 204, verified.body);
  const login = await request('POST', '/auth/login', anonymous, { email: anonymous.email, password });
  assert.equal(login.statusCode, 200, login.body);
  const uid = (await owner.query('SELECT id FROM users WHERE email_normalized=$1', [anonymous.email])).rows[0].id as string;
  return { id: uid, email: anonymous.email, cookie: cookie(login, SESSION_COOKIE), csrf: login.json().csrf_token as string };
}
async function restaurant(operator: Actor, name = '观测测试餐厅'): Promise<string> {
  const response = await request('POST', '/restaurants', operator, { name, primary_locale: 'en' }, { 'idempotency-key': id('create') });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().id as string;
}
async function website(operator: Actor, rid: string, kind: 'generate' | 'chat' = 'generate', createdAt?: string): Promise<AiCallStart> {
  const jobId = id('wjb'), runner = randomUUID();
  await owner.query(`INSERT INTO website_jobs(id,restaurant_id,requesting_user_id,kind,idempotency_key,request_fingerprint,input,snapshot,
    agent_revision,status,lease_token,lease_expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'running',$10,
    clock_timestamp()+interval '180 seconds',coalesce($11::timestamptz,clock_timestamp()))`,
  [jobId, rid, operator.id, kind, id('job'), 'a'.repeat(64),
    { prompt: '不应输出的原始提示词', user_email: operator.email, image: 'data:image/png;base64,PRIVATE_FIXTURE' },
    { private_payload: '不应输出的快照' }, kind === 'chat' ? 1 : null, runner, createdAt ?? null]);
  return { requestingUserId: operator.id, restaurantId: rid, websiteJobId: jobId, runnerToken: runner, callIndex: 1, model: 'deepseek-flash' };
}
async function menu(operator: Actor, rid: string): Promise<AiCallStart> {
  const assetId = id('ast'), jobId = id('mjb'), runner = randomUUID();
  const source = { id: assetId, mime_type: 'image/png', checksum: 'c'.repeat(64), size_bytes: 100,
    storage_key: `${rid}/${assetId}.png`, storage_backend: 'local' };
  await owner.query(`INSERT INTO assets(id,restaurant_id,kind,original_filename,mime_type,size_bytes,checksum,source_checksum,
    width_px,height_px,rights_confirmed_at,storage_backend,storage_key,upload_idempotency_key,initial_request_fingerprint)
    VALUES($1,$2,'menu_source','fixture.png','image/png',100,$3,$3,10,10,clock_timestamp(),'local',$4,$5,$3)`,
  [assetId, rid, source.checksum, source.storage_key, id('upload')]);
  await owner.query(`INSERT INTO menu_jobs(id,restaurant_id,requesting_user_id,idempotency_key,request_fingerprint,input,sources,
    expected_revision,status,lease_token,lease_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,0,'running',$8,clock_timestamp()+interval '180 seconds')`,
  [jobId, rid, operator.id, id('menu'), 'd'.repeat(64),
    { asset_ids: [assetId], consent_to_ai_processing: true, expected_revision: 0 }, JSON.stringify([source]), runner]);
  return { requestingUserId: operator.id, restaurantId: rid, menuJobId: jobId, runnerToken: runner, callIndex: 1, model: 'deepseek-flash' };
}
async function lockedStart(input: AiCallStart, createdAt?: string): Promise<string> {
  return transaction(createdAt ? owner : pool, async db => {
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [input.requestingUserId]);
    await db.query('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE', [input.restaurantId]);
    await db.query('SELECT id FROM restaurant_members WHERE restaurant_id=$1 AND user_id=$2 FOR UPDATE', [input.restaurantId, input.requestingUserId]);
    await db.query(`SELECT id FROM ${input.websiteJobId ? 'website_jobs' : 'menu_jobs'} WHERE id=$1 FOR UPDATE`, [input.websiteJobId ?? input.menuJobId]);
    if (!createdAt) return startAiCall(db, input);
    // 专用 owner 夹具仅为真实 helper 的 INSERT 指定 PG 微秒创建时钟；不修改已有行或关闭任何 guard。
    const clockDb = { query: (sql: string, values?: unknown[]) => {
      if (!sql.startsWith('INSERT INTO ai_model_calls(')) return db.query(sql, values);
      assert.ok(sql.includes('request_key)') && sql.includes('$9,$10)'));
      return db.query(sql.replace('request_key)', 'request_key,created_at)').replace('$9,$10)', '$9,$10,$11::timestamptz)'), [...values!, createdAt]);
    } } as unknown as PoolClient;
    return startAiCall(clockDb, input);
  });
}
async function finish(input: AiCallStart, counts: AiTokenUsage | null = usage, status: 'completed' | 'failed' = 'completed'): Promise<void> {
  await transaction(pool, db => finishAiCall(db, { ...input, status, usage: counts, elapsedMs: counts === zero ? 0 : 5,
    ...(status === 'failed' ? { errorCode: 'MODEL_FAILED' } : {}) }));
}
async function closeJob(input: AiCallStart, aggregate: unknown = null, versionId: string | null = null): Promise<void> {
  if (input.websiteJobId) await owner.query(`UPDATE website_jobs SET status=$2,lease_token=NULL,lease_expires_at=NULL,
    error_code=$3,usage=$4,result_version_id=$5 WHERE id=$1`,
  [input.websiteJobId, versionId ? 'succeeded' : 'failed', versionId ? null : 'CANCELLED', aggregate === null ? null : JSON.stringify(aggregate), versionId]);
  else await owner.query("UPDATE menu_jobs SET status='failed',lease_token=NULL,lease_expires_at=NULL,error_code='CANCELLED' WHERE id=$1", [input.menuJobId]);
}
async function metered(operator: Actor, rid: string, kind: 'generate' | 'chat' | 'menu' = 'generate',
  counts: AiTokenUsage | null = usage, createdAt?: string): Promise<{ input: AiCallStart; id: string }> {
  const input = kind === 'menu' ? await menu(operator, rid) : await website(operator, rid, kind);
  const callId = await lockedStart(input, createdAt);
  await finish(input, counts); await closeJob(input);
  return { input, id: callId };
}
async function report(operator: Actor, query = '', instance = app): Promise<AiUsageReport> {
  const response = await request('GET', `/ai/usage${query ? `?${query}` : ''}`, operator, undefined, {}, instance);
  assert.equal(response.statusCode, 200, response.body); valid(validateReport, response.json());
  return response.json() as AiUsageReport;
}
async function calls(operator: Actor, query = '', instance = app): Promise<AiUsageCalls> {
  const response = await request('GET', `/ai/usage/calls${query ? `?${query}` : ''}`, operator, undefined, {}, instance);
  assert.equal(response.statusCode, 200, response.body); valid(validateCalls, response.json());
  return response.json() as AiUsageCalls;
}
async function version(rid: string, counts: unknown): Promise<string> {
  const versionId = id('wsv');
  const number = (await owner.query('SELECT coalesce(max(version_number),0)+1 AS n FROM website_versions WHERE restaurant_id=$1', [rid])).rows[0].n;
  await transaction(owner, db => insertPre012LegacyFixture(db, 'pre012 历史聚合只有版本 usage，绝不补造模型调用或来源', () =>
    db.query(`INSERT INTO website_versions(id,restaurant_id,version_number,summary,html,checksum,snapshot,asset_ids,model,usage)
      VALUES($1,$2,$3,'历史聚合夹具','<h1>夹具</h1>',$4,$5,'{}','deepseek-flash',$6)`,
    [versionId, rid, number, 'e'.repeat(64), { restaurant: {}, opening_hours: [], assets: [] }, counts === null ? null : JSON.stringify(counts)])));
  return versionId;
}
async function legacy(operator: Actor, rid: string, counts: unknown, versionUsage?: unknown): Promise<AiCallStart> {
  const input = await website(operator, rid, 'generate', '2000-01-01T00:00:00.000000Z');
  const versionId = versionUsage === undefined ? null : await version(rid, versionUsage);
  await closeJob(input, counts, versionId);
  return input;
}
function resign(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', config.cursorSecret).update(`ai-usage-cursor\0${encoded}`).digest('base64url');
  return `${encoded}.${signature}`;
}
function cursorPayload(cursor: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(cursor.split('.')[0]!, 'base64url').toString('utf8'));
}
async function error(path: string, operator: Actor | undefined, status: number, instance = app): Promise<void> {
  const response = await request('GET', path, operator, undefined, {}, instance);
  assert.equal(response.statusCode, status, response.body); valid(validateError, response.json());
  for (const field of ['items', 'account_totals', 'filtered_totals', 'billing_account']) assert.equal(response.json()[field], undefined);
}

// 本文件只定义真实 PG 测试；由主线程统一运行，不能用缺变量 skip 或假数据库替代。
test('三个 GET 未登录、伪造 cookie 和 Bearer JWT 均 401，真实未验证注册也不可查询', async () => {
  for (const path of paths) {
    await error(path, undefined, 401);
    for (const headers of [{ cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}` }, { authorization: 'Bearer fake.jwt.fixture' }] as Record<string, string>[]) {
      const response = await request('GET', path, undefined, undefined, headers);
      assert.equal(response.statusCode, 401, response.body); valid(validateError, response.json());
    }
  }
  const pending = await register();
  for (const path of paths) {
    const response = await request('GET', path, pending); assert.equal(response.statusCode, 401, response.body);
  }
  const login = await request('POST', '/auth/login', pending, { email: pending.email, password });
  assert.equal(login.statusCode, 403, login.body);
});

test('已验证新用户实际 GET 返回 account null，三接口不建账户、不造额度零余额', async () => {
  const operator = await actor();
  assert.equal((await pool.query('SELECT id FROM billing_accounts WHERE owner_user_id=$1', [operator.id])).rowCount, 0);
  const account = await request('GET', '/billing/account', operator);
  assert.equal(account.statusCode, 200, account.body); valid(validateAccount, account.json());
  assert.deepEqual(account.json(), { mode: 'observation', account: null, payment_enabled: false });
  const summary = await report(operator);
  assert.equal(summary.billing_account, null); assert.deepEqual(summary.quota, noQuota);
  assert.deepEqual(summary.filters, noFilters); assert.deepEqual(summary.account_totals, empty);
  assert.deepEqual(summary.filtered_totals, empty); assert.deepEqual(summary.by_feature, []); assert.deepEqual(summary.legacy, noLegacy);
  assert.deepEqual(await calls(operator), { filters: noFilters, items: [], next_cursor: null });
  for (const table of ['billing_accounts', 'ai_model_calls', 'ai_quota_periods', 'ai_quota_ledger'])
    assert.equal((await owner.query(`SELECT count(*)::text AS n FROM ${table}`)).rows[0].n, '0');
  for (const path of paths) {
    const response = await request('GET', path, operator);
    assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['referrer-policy'], 'no-referrer');
  }
});

test('真实 app 角色必须可读 010 迁移截止时间，测试不得自行提权掩盖生产权限缺口', async () => {
  const permissions = (await pool.query(`SELECT has_column_privilege(current_user,'schema_migrations','version','SELECT') AS version,
    has_column_privilege(current_user,'schema_migrations','applied_at','SELECT') AS applied_at`)).rows[0];
  assert.deepEqual(permissions, { version: true, applied_at: true }, '主线程需接入 schema_migrations(version,applied_at) 最小 SELECT 授权；本测试不 GRANT 或使用 owner 代替生产查询');
  assert.ok((await pool.query("SELECT applied_at FROM schema_migrations WHERE version='010_ai_metering'")).rows[0]);
});

test('已有真实会话的停用、删除或变为未验证用户在每次 GET 重新拒绝 401', async () => {
  const operator = await actor();
  for (const status of ['suspended', 'deleted', 'pending_verification']) {
    await owner.query('UPDATE users SET status=$2,email_verified_at=$3 WHERE id=$1', [operator.id, status, status === 'pending_verification' ? null : new Date()]);
    for (const path of paths) await error(path, operator, 401);
    await owner.query("UPDATE users SET status='active',email_verified_at=clock_timestamp() WHERE id=$1", [operator.id]);
  }
});

test('requireSession 成功后事务前撤销真实 session，三个 GET 的 lockAuthenticated 均拒绝', async () => {
  for (const path of paths) {
    const operator = await actor();
    let revoked = false;
    const database = { query: async (sql: string, values?: unknown[]) => {
      const result = await pool.query(sql, values);
      if (!revoked && sql.includes('FROM auth_sessions s JOIN users u') && result.rows[0]) {
        revoked = true;
        await owner.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [result.rows[0].session_id]);
      }
      return result;
    }, connect: pool.connect.bind(pool) } as unknown as Pool;
    const instance = usageApp(database);
    try { await instance.ready(); await error(path, operator, 401, instance); assert.equal(revoked, true); }
    finally { await instance.close(); }
  }
});

test('两家餐厅三个 feature 共用一个账户，过滤只改变 filtered/by_feature，全账户统计保持不变', async () => {
  const operator = await actor(), first = await restaurant(operator, '第一餐厅'), second = await restaurant(operator, '第二餐厅');
  await metered(operator, first, 'generate'); await metered(operator, second, 'chat'); await metered(operator, second, 'menu');
  const summary = await report(operator);
  assert.deepEqual(summary.account_totals, { calls: 3, known_usage_calls: 3, unknown_usage_calls: 0, pending_calls: 0,
    prompt_tokens: 36, completion_tokens: 24, total_tokens: 60 });
  assert.deepEqual(summary.filtered_totals, summary.account_totals); assert.equal(summary.by_feature.length, 3);
  assert.equal((await pool.query('SELECT id FROM billing_accounts WHERE owner_user_id=$1', [operator.id])).rowCount, 1);
  for (const query of [`restaurant_id=${second}`, 'feature=menu_recognition', 'origin=legacy_import', `restaurant_id=${second}&feature=website_chat&origin=live`]) {
    const filtered = await report(operator, query);
    assert.deepEqual(filtered.account_totals, summary.account_totals); assert.deepEqual(filtered.legacy, summary.legacy);
    assert.ok(filtered.by_feature.every(row => filtered.filters.feature === null || row.feature === filtered.filters.feature));
  }
  const filtered = await report(operator, `restaurant_id=${second}`);
  assert.equal(filtered.filtered_totals.calls, 2); assert.equal(filtered.filtered_totals.total_tokens, 40);
  assert.deepEqual((await calls(operator, `restaurant_id=${first}`)).items.map(item => item.restaurant_name), ['第一餐厅']);
});

test('unknown 与 pending 保持 null，known 零为真实 0；失败已知调用仍进入 known 累计', async () => {
  const operator = await actor(), rid = await restaurant(operator), input = await website(operator, rid);
  const ids: string[] = [];
  for (const index of [1, 2, 3, 4]) {
    const next = { ...input, callIndex: index }; ids.push(await lockedStart(next));
    if (index === 1) await finish(next, zero);
    if (index === 2) await finish(next, null);
    if (index === 4) await finish(next, usage, 'failed');
  }
  const summary = await report(operator);
  assert.deepEqual(summary.account_totals, { calls: 4, known_usage_calls: 2, unknown_usage_calls: 1, pending_calls: 1, ...usage });
  const page = await calls(operator);
  const byId = new Map(page.items.map(item => [item.id, item]));
  assert.equal(byId.get(ids[0]!)!.total_tokens, 0); assert.equal(byId.get(ids[0]!)!.elapsed_ms, 0);
  for (const callId of [ids[1]!, ids[2]!]) {
    const item = byId.get(callId)!;
    for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const) assert.equal(item[field], null);
  }
  assert.equal(byId.get(ids[2]!)!.finished_at, null); assert.equal(byId.get(ids[2]!)!.elapsed_ms, null);
  assert.equal(byId.get(ids[3]!)!.call_status, 'failed'); assert.equal(byId.get(ids[3]!)!.error_code, 'MODEL_FAILED');
});

test('统计所有 SELECT 与鉴权锁共用 REPEATABLE READ，途中真实 finish 不产生混合快照', async () => {
  const operator = await actor(), rid = await restaurant(operator), input = await website(operator, rid);
  await lockedStart(input);
  const statements: string[] = [];
  let changed = false, connections = 0;
  const database = { query: pool.query.bind(pool), connect: async () => {
    connections++;
    const actual = await pool.connect();
    return { query: async (sql: string, values?: unknown[]) => {
      statements.push(sql);
      const result = await actual.query(sql, values);
      if (!changed && sql.includes('AS known_usage_calls') && !sql.includes('GROUP BY')) {
        changed = true;
        await transaction(owner, db => finishAiCall(db, { ...input, status: 'completed', usage, elapsedMs: 5 }));
      }
      return result;
    }, release: () => actual.release() } as unknown as PoolClient;
  } } as unknown as Pool;
  const instance = usageApp(database);
  try {
    await instance.ready(); const summary = await report(operator, '', instance);
    assert.equal(changed, true); assert.equal(connections, 1);
    assert.equal(statements[0], 'BEGIN'); assert.equal(statements[1], 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    assert.ok(statements.some(sql => sql.includes('FROM users WHERE id=$1 FOR NO KEY UPDATE')));
    assert.ok(statements.some(sql => sql.includes('FROM auth_sessions WHERE id=$1 FOR UPDATE')));
    assert.equal(summary.account_totals.pending_calls, 1); assert.equal(summary.filtered_totals.pending_calls, 1);
    assert.equal(summary.by_feature[0]!.pending_calls, 1); assert.equal(summary.account_totals.total_tokens, 0);
    assert.equal((await report(operator)).account_totals.total_tokens, 20);
  } finally { await instance.close(); }
});

test('日期严格成对、日历有效、UTC 含首尾最多366天，允许合法极端年份且拒绝查询数组与额外键', async () => {
  const operator = await actor();
  const invalid = [
    'from=2024-02-30&to=2024-03-01', 'from=2023-02-29&to=2023-03-01', 'from=0000-01-01&to=0000-01-01',
    'from=2024-13-01&to=2024-13-02', 'from=2024-1-01&to=2024-01-02', 'from=2024-06-02&to=2024-06-01',
    'from=2024-01-01&to=2025-01-01', 'from=', 'to=2024-01-01', 'from=2024-01-01', 'from=&to=',
    'from=2024-01-01T00%3A00%3A00Z&to=2024-01-01', 'feature=other', 'origin=other', 'feature=', 'origin=',
    'feature=website_chat&feature=website_generate', 'origin=live&origin=live', 'restaurant_id=x', 'restaurant_id=',
    'from=2024-01-01&from=2024-01-01&to=2024-01-02', 'feature[]=website_chat', 'from[x]=2024-01-01',
    'foo=bar', 'user_id=private', 'billing_account_id=private', 'cost=1',
    `from=${encodeURIComponent("2024-01-01'; SELECT 1;--")}&to=2024-01-01`,
  ];
  for (const query of invalid) for (const path of ['/ai/usage', '/ai/usage/calls']) await error(`${path}?${query}`, operator, 400);
  for (const query of ['from=2024-01-01&to=2024-12-31', 'from=2024-02-29&to=2024-02-29',
    'from=0001-01-01&to=0001-01-02', 'from=9999-12-31&to=9999-12-31']) {
    await report(operator, query); await calls(operator, query);
  }
  for (const query of ['cursor=x', 'limit=1']) await error(`/ai/usage?${query}`, operator, 400);
  for (const query of ['limit=1', 'restaurant_id=x', 'cursor=x', 'from=2024-01-01&to=2024-01-01']) await error(`/billing/account?${query}`, operator, 400);
});

test('calls limit 默认20最大50，安全规范整数且拒绝重复、数组、对象和过长 cursor', async () => {
  const operator = await actor(), rid = await restaurant(operator), input = await website(operator, rid);
  for (let callIndex = 1; callIndex <= 51; callIndex++) await lockedStart({ ...input, callIndex });
  const defaultPage = await calls(operator); assert.equal(defaultPage.items.length, 20); assert.ok(defaultPage.next_cursor);
  const maxPage = await calls(operator, 'limit=50'); assert.equal(maxPage.items.length, 50); assert.ok(maxPage.next_cursor);
  for (const query of ['limit=0', 'limit=51', 'limit=-1', 'limit=1.5', 'limit=1e1', 'limit=01', 'limit=%2B1',
    'limit=9007199254740992', 'limit=Infinity', 'limit=', 'limit=1&limit=1', 'limit[]=1', 'limit[x]=1', 'cursor=',
    `cursor=${'x'.repeat(2049)}`, 'cursor=a&cursor=b']) await error(`/ai/usage/calls?${query}`, operator, 400);
});

test('UTC 日期区间 >=from 且 <to次日，精确微秒边界正确且全账户不受日期筛选影响', async () => {
  const operator = await actor(), rid = await restaurant(operator);
  const times = ['2024-05-31T23:59:59.999999Z', '2024-06-01T00:00:00.000000Z',
    '2024-06-01T23:59:59.999999Z', '2024-06-02T00:00:00.000000Z'];
  for (const at of times) await metered(operator, rid, 'generate', usage, at);
  const query = 'from=2024-06-01&to=2024-06-01';
  const summary = await report(operator, query);
  assert.equal(summary.account_totals.calls, 4); assert.equal(summary.account_totals.total_tokens, 80);
  assert.equal(summary.filtered_totals.calls, 2); assert.equal(summary.filtered_totals.total_tokens, 40);
  assert.deepEqual((await calls(operator, query)).items.map(item => item.created_at), [times[2], times[1]]);
  assert.match(summary.generated_at, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/);
  const all = await report(operator); assert.deepEqual(all.filters, noFilters); assert.equal(all.filtered_totals.calls, 4);
});

test('legacy 独立读取 total-only、零和同餐厅 result usage fallback；无效摘要不假造已知 tokens', async () => {
  const operator = await actor(), rid = await restaurant(operator);
  await metered(operator, rid);
  await legacy(operator, rid, usage);
  await legacy(operator, rid, { total_tokens: 7 });
  await legacy(operator, rid, zero);
  await legacy(operator, rid, null, { total_tokens: 11 });
  await legacy(operator, rid, null, null);
  for (const invalid of [{ total_tokens: '8' }, { total_tokens: -1 }, { total_tokens: 1.5 },
    { total_tokens: Number.MAX_SAFE_INTEGER + 1 }, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 3 },
    { prompt_tokens: '1', completion_tokens: 1, total_tokens: 2 }, {}]) await legacy(operator, rid, invalid);
  // 旧任务 CHECK 已禁止 JSON 字符串作为 usage，不为测试放宽生产约束。
  // j.usage 非 SQL NULL 但无效时，不使用版本的有效 usage 覆盖。
  await legacy(operator, rid, { total_tokens: 'invalid' }, { total_tokens: 999 });
  const summary = await report(operator);
  assert.deepEqual(summary.legacy, { aggregate_jobs: 12, known_total_tokens: 38, unknown_usage_jobs: 9 });
  assert.equal(summary.account_totals.calls, 1); assert.equal(summary.account_totals.total_tokens, 20);
  assert.equal((await calls(operator)).items.length, 1);
});

test('legacy 排除任何 010 调用与 007 逐调用，历史聊天不展开，迁移后无调用失败任务不冒充旧账', async () => {
  const operator = await actor(), rid = await restaurant(operator);
  const live = await website(operator, rid, 'generate', '2000-01-01T00:00:00.000000Z');
  await lockedStart(live); await finish(live); await closeJob(live, { total_tokens: 999 });
  const old007 = await website(operator, rid, 'generate', '2000-01-01T00:00:00.000000Z');
  await owner.query("INSERT INTO website_model_calls(job_id,call_index,runner_token,status,elapsed_ms) VALUES($1,1,$2,'started',0)", [old007.websiteJobId, old007.runnerToken]);
  await owner.query("UPDATE website_model_calls SET status='completed',prompt_tokens=12,completion_tokens=8,total_tokens=20 WHERE job_id=$1", [old007.websiteJobId]);
  await closeJob(old007, { total_tokens: 888 });
  const chat = await website(operator, rid, 'chat', '2000-01-01T00:00:00.000000Z'); await closeJob(chat, { total_tokens: 777 });
  const newFailed = await website(operator, rid); await closeJob(newFailed, { total_tokens: 666 });
  const newVersion = await website(operator, rid); await closeJob(newVersion, null, await version(rid, null));
  await legacy(operator, rid, { total_tokens: 5 });
  const summary = await report(operator);
  assert.deepEqual(summary.legacy, { aggregate_jobs: 1, known_total_tokens: 5, unknown_usage_jobs: 0 });
  assert.equal(summary.account_totals.calls, 1); assert.equal(summary.account_totals.total_tokens, 20);
});

test('legacy 固定全账户不随 restaurant/feature/origin/date filter 改变且不包含其他账户', async () => {
  const operator = await actor(), first = await restaurant(operator), second = await restaurant(operator), other = await actor();
  await metered(operator, first); await legacy(operator, first, { total_tokens: 10 }); await legacy(operator, second, { total_tokens: 15 });
  const otherRid = await restaurant(other); await metered(other, otherRid); await legacy(other, otherRid, { total_tokens: 999 });
  const summary = await report(operator);
  assert.deepEqual(summary.legacy, { aggregate_jobs: 2, known_total_tokens: 25, unknown_usage_jobs: 0 });
  for (const query of [`restaurant_id=${second}`, 'feature=menu_recognition', 'origin=legacy_import', 'from=2024-01-01&to=2024-01-02']) {
    const filtered = await report(operator, query); assert.deepEqual(filtered.legacy, summary.legacy);
    assert.deepEqual(filtered.account_totals, summary.account_totals);
  }
});

test('筛选跨用户、不存在和撤销餐厅统一404；撤权账本保留历史id/job但不暴露名称', async () => {
  const operator = await actor(), other = await actor(), rid = await restaurant(operator, '撤权前名称');
  const recorded = await metered(operator, rid);
  for (const path of ['/ai/usage', '/ai/usage/calls']) {
    await error(`${path}?restaurant_id=${rid}`, other, 404);
    await error(`${path}?restaurant_id=${id('rst')}`, operator, 404);
  }
  await owner.query("UPDATE restaurant_members SET status='revoked' WHERE restaurant_id=$1 AND user_id=$2", [rid, operator.id]);
  await owner.query("UPDATE restaurants SET name='撤权后敏感名称' WHERE id=$1", [rid]);
  for (const path of ['/ai/usage', '/ai/usage/calls']) await error(`${path}?restaurant_id=${rid}`, operator, 404);
  const page = await calls(operator);
  assert.equal(page.items[0]!.id, recorded.id); assert.equal(page.items[0]!.restaurant_id, rid);
  assert.equal(page.items[0]!.job_id, recorded.input.websiteJobId); assert.equal(page.items[0]!.restaurant_name, null);
  assert.equal((await report(operator)).account_totals.total_tokens, 20);
});

test('转移餐厅新 owner 仅看本人账户；旧 owner 保留历史账本名称 null，归档亦不暴露名称', async () => {
  const oldOwner = await actor(), newOwner = await actor(), rid = await restaurant(oldOwner, '原名称');
  const oldCall = await metered(oldOwner, rid); await legacy(oldOwner, rid, { total_tokens: 10 });
  await owner.query("UPDATE restaurant_members SET status='revoked' WHERE restaurant_id=$1 AND user_id=$2", [rid, oldOwner.id]);
  await owner.query("INSERT INTO restaurant_members(id,restaurant_id,user_id,role) VALUES($1,$2,$3,'owner')", [id('mem'), rid, newOwner.id]);
  await owner.query("UPDATE restaurants SET name='新 owner 敏感名称' WHERE id=$1", [rid]);
  const emptyAccount = await report(newOwner, `restaurant_id=${rid}`);
  assert.equal(emptyAccount.billing_account, null); assert.equal(emptyAccount.account_totals.calls, 0); assert.deepEqual(emptyAccount.legacy, noLegacy);
  const newCall = await metered(newOwner, rid, 'chat', { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  const page = await calls(newOwner, `restaurant_id=${rid}`);
  assert.deepEqual(page.items.map(item => item.id), [newCall.id]); assert.equal(page.items[0]!.restaurant_name, '新 owner 敏感名称');
  assert.equal((await report(newOwner, `restaurant_id=${rid}`)).account_totals.total_tokens, 5);
  const oldPage = await calls(oldOwner);
  assert.deepEqual(oldPage.items.map(item => item.id), [oldCall.id]); assert.equal(oldPage.items[0]!.restaurant_name, null);
  assert.deepEqual((await report(oldOwner)).legacy, { aggregate_jobs: 1, known_total_tokens: 10, unknown_usage_jobs: 0 });
  // schema 没有 deleted 状态，账本 FK 禁止物理删除；用现有 archived 软删除语义验证名称隐藏。
  await owner.query("UPDATE restaurants SET status='archived' WHERE id=$1", [rid]);
  assert.equal((await calls(newOwner)).items[0]!.restaurant_name, null);
  await error(`/ai/usage?restaurant_id=${rid}`, newOwner, 409);
});

test('HMAC 游标篡改、跨用户、换完整 filters/limit 均400，不静默重置', async () => {
  const operator = await actor(), other = await actor(), rid = await restaurant(operator), input = await website(operator, rid);
  await lockedStart(input); await lockedStart({ ...input, callIndex: 2 });
  const first = await calls(operator, 'limit=1'); assert.ok(first.next_cursor);
  const cursor = first.next_cursor;
  const value = encodeURIComponent(cursor);
  await error(`/ai/usage/calls?limit=1&cursor=${value}`, other, 400);
  for (const query of ['limit=2', `limit=1&restaurant_id=${rid}`, 'limit=1&feature=website_generate',
    'limit=1&origin=live', 'limit=1&from=2024-01-01&to=2024-01-01']) await error(`/ai/usage/calls?${query}&cursor=${value}`, operator, 400);
  const parts = cursor.split('.') as [string, string];
  const tampered = `${parts[0]}.${parts[1][0] === 'A' ? 'B' : 'A'}${parts[1].slice(1)}`;
  await error(`/ai/usage/calls?limit=1&cursor=${encodeURIComponent(tampered)}`, operator, 400);
  const payload = cursorPayload(cursor);
  for (const change of [{ v: 2 }, { last_id: 'wjb_invalid' }, { last_created_at: '2024-02-30T00:00:00.000001Z' },
    { last_created_at: '2024-01-01T24:00:00.000001Z' }, { extra: 'invalid' }, { filters: { ...noFilters, origin: 'invalid' } }])
    await error(`/ai/usage/calls?limit=1&cursor=${encodeURIComponent(resign({ ...payload, ...change }))}`, operator, 400);
  assert.equal((await calls(operator, `limit=1&cursor=${value}`)).items.length, 1);
});

test('created_at 同毫秒不同微秒和同时间不同id均严格元组倒序分页，不重复不遗漏', async () => {
  const operator = await actor(), rid = await restaurant(operator), input = await website(operator, rid);
  const times = ['2024-06-01T12:00:00.123001Z', '2024-06-01T12:00:00.123002Z', '2024-06-01T12:00:00.123002Z',
    '2024-06-01T12:00:00.123999Z', '2024-06-01T12:00:00.124000Z'];
  for (let index = 0; index < times.length; index++) await lockedStart({ ...input, callIndex: index + 1 }, times[index]);
  const expected = (await pool.query(`SELECT id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
    FROM ai_model_calls ORDER BY created_at DESC,id DESC`)).rows;
  let cursor: string | null = null;
  const seen: string[] = [];
  for (let index = 0; index < times.length; index++) {
    const page = await calls(operator, `limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    assert.equal(page.items.length, 1); assert.equal(page.items[0]!.id, expected[index]!.id);
    assert.equal(page.items[0]!.created_at, expected[index]!.at); seen.push(page.items[0]!.id);
    cursor = page.next_cursor;
    if (index < times.length - 1) {
      assert.ok(cursor); const payload = cursorPayload(cursor);
      assert.equal(payload.last_created_at, expected[index]!.at); assert.equal(payload.last_id, expected[index]!.id);
      assert.equal(payload.v, 1); assert.equal(payload.user_id, operator.id); assert.equal(payload.limit, 1);
      assert.deepEqual(payload.filters, noFilters);
    }
  }
  assert.equal(cursor, null); assert.equal(new Set(seen).size, times.length);
});

test('已有 quota grant 的所有 GET 均不改变 period/ledger，仍返回未配置未强制与全 null', async () => {
  const operator = await actor(), rid = await restaurant(operator); await metered(operator, rid);
  const accountId = (await pool.query('SELECT id FROM billing_accounts WHERE owner_user_id=$1', [operator.id])).rows[0].id;
  const periodId = id('aqp');
  await owner.query(`INSERT INTO ai_quota_periods(id,billing_account_id,kind,starts_at,ends_at,grant_key)
    VALUES($1,$2,'trial',clock_timestamp(),clock_timestamp()+interval '30 days',$3)`, [periodId, accountId, id('grant')]);
  await owner.query("SELECT apply_ai_quota_entry($1,$2,NULL,'grant',$3,100,0,0,'FIXTURE_GRANT',$4)", [periodId, accountId, id('grant'), operator.id]);
  const periods = (await owner.query('SELECT * FROM ai_quota_periods ORDER BY id')).rows;
  const ledger = (await owner.query('SELECT * FROM ai_quota_ledger ORDER BY id')).rows;
  for (const path of paths) { const response = await request('GET', path, operator); assert.equal(response.statusCode, 200, response.body); }
  assert.deepEqual((await report(operator)).quota, noQuota);
  assert.deepEqual((await owner.query('SELECT * FROM ai_quota_periods ORDER BY id')).rows, periods);
  assert.deepEqual((await owner.query('SELECT * FROM ai_quota_ledger ORDER BY id')).rows, ledger);
  for (const status of ['suspended', 'closed']) {
    await owner.query('UPDATE billing_accounts SET status=$2 WHERE id=$1', [accountId, status]);
    const response = await request('GET', '/billing/account', operator); assert.equal(response.statusCode, 200, response.body);
    valid(validateAccount, response.json()); assert.deepEqual(response.json(), { mode: 'observation', account: { id: accountId, status }, payment_enabled: false });
  }
});

test('known 累计超 MAX_SAFE 返回422 AI_USAGE_OVERFLOW，即使 filter 排除了大值也不截断全账户', async () => {
  const operator = await actor(), rid = await restaurant(operator);
  await metered(operator, rid, 'generate', { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 0, total_tokens: Number.MAX_SAFE_INTEGER });
  await metered(operator, rid, 'chat', { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 });
  for (const query of ['', '?feature=menu_recognition', '?origin=legacy_import']) {
    const response = await request('GET', `/ai/usage${query}`, operator);
    assert.equal(response.statusCode, 422, response.body); assert.equal(response.json().code, 'AI_USAGE_OVERFLOW'); valid(validateOverflow, response.json());
  }
  const page = await calls(operator); assert.equal(page.items.length, 2);
  assert.ok(page.items.some(item => item.total_tokens === Number.MAX_SAFE_INTEGER));
});

test('legacy 合法已知 total 聚合超安全整数同样422，不舍入或混入逐调用统计', async () => {
  const operator = await actor(), rid = await restaurant(operator); await metered(operator, rid);
  await legacy(operator, rid, { total_tokens: Number.MAX_SAFE_INTEGER }); await legacy(operator, rid, { total_tokens: 1 });
  const response = await request('GET', '/ai/usage', operator);
  assert.equal(response.statusCode, 422, response.body); valid(validateOverflow, response.json());
  assert.equal((await calls(operator)).items.length, 1);
});

test('实际 API serializer 禁止 prompt/runner/request_key/user/email/dataURL/cost，契约拒绝额外字段与假余额', async () => {
  const operator = await actor(), rid = await restaurant(operator); const recorded = await metered(operator, rid);
  for (const path of paths) {
    const response = await request('GET', path, operator); assert.equal(response.statusCode, 200, response.body);
    for (const value of ['"prompt"', '"input"', '"snapshot"', '"runner_token"', '"request_key"', '"requesting_user_id"', '"user_id"',
      '"email"', '"cost"', 'data:image', 'PRIVATE_FIXTURE', '不应输出的', operator.email, recorded.input.runnerToken]) assert.ok(!response.body.includes(value), value);
    assert.ok(!response.body.includes(`${recorded.input.websiteJobId}:1`));
  }
  const summary = await report(operator), page = await calls(operator);
  assert.equal(validateReport({ ...summary, prompt: '泄露' }), false);
  assert.equal(validateReport({ ...summary, quota: { ...noQuota, available_tokens: 0 } }), false);
  assert.equal(validateCalls({ ...page, items: [{ ...page.items[0], request_key: '泄露' }] }), false);
  assert.equal(validateCalls({ ...page, items: [{ ...page.items[0], usage_status: 'unknown', total_tokens: 0 }] }), false);
  const contract = JSON.parse(await readFile(new URL('../contracts/ai-usage.openapi.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(contract.paths).sort(), paths.map(path => `/api/v1${path}`).sort());
  assert.equal(contract.components.securitySchemes.merchantSession.in, 'cookie');
  assert.equal(contract.components.securitySchemes.merchantSession.name, SESSION_COOKIE);
  assert.ok(schemas.AiUsageReport && schemas.AiUsageCalls);
});
