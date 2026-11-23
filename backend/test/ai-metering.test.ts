import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { loadConfig } from '../src/config.js';
import { assertAppDatabase, id, transaction, type Database } from '../src/db.js';
import { migrate } from '../scripts/migrate.js';
import { remove012ForMigrationReplay } from './website-fixtures.js';
import { closeInterruptedAiCalls, ensureBillingAccount, finishAiCall, startAiCall } from '../src/ai-metering.js';
import type { AiCallStart, AiCallFinish } from '../src/ai-usage-types.js';

let pool: Pool, owner: Pool;
const tables = 'ai_calendar_credit_grants,website_content_actions,website_version_sources,billing_subscriptions,billing_offer_grants,ai_quota_ledger,ai_quota_periods,ai_model_calls,billing_accounts,analytics_events,analytics_daily,menu_jobs,menu_drafts,website_publish_actions,website_publications,website_model_calls,website_jobs,website_versions,website_agents,asset_upload_intents,asset_references,assets,reservations,reservation_events,reservation_access_tokens,audit_logs,email_outbox,opening_hours,restaurant_members,auth_tokens,auth_sessions,auth_identities,restaurants,users';
import { createTestDatabasePools, readTestDatabaseScope } from './database-scope.js';
before(async () => {
  const scope = readTestDatabaseScope();
  const { databaseUrl, migrationDatabaseUrl } = scope;
  // 与 websites 相同的独立 PG 约束，配置全部合成，不读取 .env 或真实模型密钥。
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, MIGRATION_DATABASE_URL: migrationDatabaseUrl,
    APP_ORIGIN: 'https://localhost:5173', EMAIL_MODE: 'disabled', STORAGE_MODE: 'local',
    TOKEN_PEPPER: 'ai-metering-fixture-pepper-'.repeat(3), CURSOR_SECRET: 'ai-metering-fixture-cursor-'.repeat(3),
    OUTBOX_ENCRYPTION_KEY: 'a1'.repeat(32) });
  ({ pool, owner } = await createTestDatabasePools({ ...scope, databaseUrl: config.databaseUrl,
    migrationDatabaseUrl: config.migrationDatabaseUrl! }));
  await migrate(owner, 'restaurant_test_app');
  await assertAppDatabase(pool);
  await owner.query(`TRUNCATE ${tables}`);
});
beforeEach(async () => { await owner.query(`TRUNCATE ${tables}`); });
after(async () => {
  if (pool) await pool.end();
  if (owner) { try { await owner.query(`TRUNCATE ${tables}`); } finally { await owner.end(); } }
});

async function user(db: Database = owner): Promise<string> {
  const userId = id('usr');
  await db.query(`INSERT INTO users(id,email,email_normalized,locale,status,email_verified_at,terms_version,terms_accepted_at)
    VALUES($1,$2,$2,'en','active',clock_timestamp(),'fixture-v1',clock_timestamp())`, [userId, `${userId}@example.test`]);
  return userId;
}
async function restaurant(userId: string, db: Database = owner): Promise<string> {
  const rid = id('rst');
  await db.query(`INSERT INTO restaurants(id,created_by_user_id,create_idempotency_key,create_request_fingerprint,slug,name,primary_locale)
    VALUES($1,$2,$3,$4,replace(lower($1::text),'_','-'),'计量测试餐厅','en')`, [rid, userId, id('create'), 'a'.repeat(64)]);
  await db.query("INSERT INTO restaurant_members(id,restaurant_id,user_id,role) VALUES($1,$2,$3,'owner')", [id('mem'), rid, userId]);
  return rid;
}
async function website(userId: string, rid: string, kind: 'chat' | 'generate' = 'generate', db: Database = owner,
  status: 'queued' | 'running' = 'running', expired = false): Promise<AiCallStart> {
  const jobId = id('wjb'), runner = randomUUID();
  await db.query(`INSERT INTO website_jobs(id,restaurant_id,requesting_user_id,kind,idempotency_key,request_fingerprint,input,snapshot,
    agent_revision,status,lease_token,lease_expires_at) VALUES($1,$2,$3,$4,$5,$6,'{}','{}',$7,$8,$9,
      CASE WHEN $8='running' THEN clock_timestamp()+$10::interval END)`,
  [jobId, rid, userId, kind, id('job'), 'b'.repeat(64), kind === 'chat' ? 1 : null, status, status === 'running' ? runner : null,
    expired ? '-1 second' : '180 seconds']);
  return { requestingUserId: userId, restaurantId: rid, websiteJobId: jobId, runnerToken: runner, callIndex: 1, model: 'deepseek-flash' };
}
async function menu(userId: string, rid: string): Promise<AiCallStart> {
  const assetId = id('ast'), jobId = id('mjb'), runner = randomUUID();
  const source = { id: assetId, mime_type: 'image/png', checksum: 'c'.repeat(64), size_bytes: 100,
    storage_key: `${rid}/${assetId}.png`, storage_backend: 'local' };
  await owner.query(`INSERT INTO assets(id,restaurant_id,kind,original_filename,mime_type,size_bytes,checksum,source_checksum,
    width_px,height_px,rights_confirmed_at,storage_backend,storage_key,upload_idempotency_key,initial_request_fingerprint)
    VALUES($1,$2,'menu_source','fixture.png','image/png',100,$3,$3,10,10,clock_timestamp(),'local',$4,$5,$3)`,
  [assetId, rid, source.checksum, source.storage_key, id('upload')]);
  await owner.query(`INSERT INTO menu_jobs(id,restaurant_id,requesting_user_id,idempotency_key,request_fingerprint,input,sources,
    expected_revision,status,lease_token,lease_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,0,'running',$8,clock_timestamp()+interval '180 seconds')`,
  [jobId, rid, userId, id('menu'), 'd'.repeat(64), { asset_ids: [assetId], consent_to_ai_processing: true, expected_revision: 0 }, JSON.stringify([source]), runner]);
  return { requestingUserId: userId, restaurantId: rid, menuJobId: jobId, runnerToken: runner, callIndex: 1, model: 'deepseek-flash' };
}
async function fixture(kind: 'generate' | 'chat' | 'menu' = 'generate'): Promise<AiCallStart> {
  const uid = await user(), rid = await restaurant(uid);
  return kind === 'menu' ? menu(uid, rid) : website(uid, rid, kind);
}
async function lockedStart(input: AiCallStart): Promise<string> {
  return transaction(pool, async db => {
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [input.requestingUserId]);
    await db.query('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE', [input.restaurantId]);
    await db.query('SELECT id FROM restaurant_members WHERE restaurant_id=$1 AND user_id=$2 FOR UPDATE', [input.restaurantId, input.requestingUserId]);
    await db.query(`SELECT id FROM ${input.websiteJobId ? 'website_jobs' : 'menu_jobs'} WHERE id=$1 FOR UPDATE`, [input.websiteJobId ?? input.menuJobId]);
    return startAiCall(db, input);
  });
}
async function finish(input: AiCallFinish): Promise<void> { await transaction(pool, db => finishAiCall(db, input)); }
async function call(callId: string) { return (await pool.query('SELECT * FROM ai_model_calls WHERE id=$1', [callId])).rows[0]; }
async function rawStart(db: Database, input: AiCallStart, overrides: Record<string, unknown> = {}): Promise<void> {
  const account = (await owner.query('SELECT id FROM billing_accounts WHERE owner_user_id=$1', [input.requestingUserId])).rows[0]
    ?? await transaction(owner, db => ensureBillingAccount(db, input.requestingUserId));
  const fields: Record<string, unknown> = { id: id('aic'), billing_account_id: account.id, requesting_user_id: input.requestingUserId,
    restaurant_id: input.restaurantId, website_job_id: input.websiteJobId ?? null, menu_job_id: input.menuJobId ?? null,
    feature: input.menuJobId ? 'menu_recognition' : 'website_generate', model: input.model, call_index: input.callIndex,
    runner_token: input.runnerToken, request_key: `${input.websiteJobId ?? input.menuJobId}:${input.callIndex}`, ...overrides };
  await db.query(`INSERT INTO ai_model_calls(${Object.keys(fields).join(',')}) VALUES(${Object.keys(fields).map((_, index) => `$${index + 1}`).join(',')})`, Object.values(fields));
}
async function rollback(run: (db: PoolClient) => Promise<void>): Promise<void> {
  const db = await owner.connect();
  try { await db.query('BEGIN'); await run(db); } finally { await db.query('ROLLBACK'); db.release(); }
}
async function rejected(db: PoolClient, run: () => Promise<unknown>, code = '23514'): Promise<void> {
  await db.query('SAVEPOINT rejected_write');
  try { await assert.rejects(run, (error: unknown) => (error as { code?: string }).code === code); }
  finally { await db.query('ROLLBACK TO SAVEPOINT rejected_write'); await db.query('RELEASE SAVEPOINT rejected_write'); }
}
const zero = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };

test('新用户 GET 式 SELECT 不建账户；首次调用建唯一账户且 started 为全空 pending', async () => {
  const input = await fixture();
  assert.equal((await pool.query('SELECT id FROM billing_accounts WHERE owner_user_id=$1', [input.requestingUserId])).rowCount, 0);
  const callId = await lockedStart(input), row = await call(callId);
  assert.match(callId, /^aic_[A-Za-z0-9_-]{24}$/); assert.match(row.billing_account_id, /^bla_[A-Za-z0-9_-]{24}$/);
  assert.equal(row.call_status, 'started'); assert.equal(row.usage_status, 'pending');
  for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'finished_at', 'received_at', 'elapsed_ms', 'error_code']) assert.equal(row[field], null);
  assert.equal(row.request_key, `${input.websiteJobId}:1`); assert.equal(row.origin, 'live'); assert.equal(row.chargeable, false);
  assert.equal(row.provider, 'deepseek'); assert.equal(row.policy_version, 'observation-v1');
  assert.equal(await lockedStart(input), callId);
  const account = await transaction(pool, db => ensureBillingAccount(db, input.requestingUserId));
  assert.deepEqual(account, { id: row.billing_account_id, status: 'active' });
  assert.equal((await pool.query('SELECT id FROM billing_accounts')).rowCount, 1);
  assert.equal((await pool.query('SELECT id FROM ai_model_calls')).rowCount, 1);
  assert.equal((await pool.query('SELECT id FROM ai_quota_periods')).rowCount, 0);
  assert.equal((await pool.query('SELECT id FROM ai_quota_ledger')).rowCount, 0);
});

test('两家餐厅、三个真实任务 feature 共用店主账户；suspended/closed 不阻止观察调用', async () => {
  const input = await fixture('chat'), first = await lockedStart(input);
  const rid = await restaurant(input.requestingUserId), secondInput = await website(input.requestingUserId, rid);
  const accountId = (await call(first)).billing_account_id;
  await owner.query("UPDATE billing_accounts SET status='suspended' WHERE id=$1", [accountId]);
  const second = await lockedStart(secondInput);
  await owner.query("UPDATE billing_accounts SET status='closed' WHERE id=$1", [accountId]);
  const thirdInput = await menu(input.requestingUserId, rid), third = await lockedStart(thirdInput);
  assert.equal((await call(first)).feature, 'website_chat'); assert.equal((await call(second)).feature, 'website_generate');
  assert.equal((await call(third)).feature, 'menu_recognition');
  for (const callId of [first, second, third]) assert.equal((await call(callId)).billing_account_id, accountId);
  assert.equal((await pool.query('SELECT id FROM billing_accounts')).rowCount, 1);
});

test('DB start guard 拒绝非 running、过期租约、错误 runner、未验证或撤权店主及停用餐厅', async () => {
  const uid = await user();
  const queued = await website(uid, await restaurant(uid), 'generate', owner, 'queued');
  const expired = await website(uid, await restaurant(uid), 'generate', owner, 'running', true);
  const valid = await website(uid, await restaurant(uid));
  await transaction(pool, db => ensureBillingAccount(db, uid));
  for (const input of [queued, expired, { ...valid, runnerToken: randomUUID() }]) await assert.rejects(() => rawStart(owner, input), { code: '23514' });
  await owner.query("UPDATE users SET status='pending_verification',email_verified_at=NULL WHERE id=$1", [uid]);
  await assert.rejects(() => rawStart(owner, valid), { code: '23514' });
  await owner.query("UPDATE users SET status='active',email_verified_at=clock_timestamp() WHERE id=$1", [uid]);
  await owner.query("UPDATE restaurant_members SET status='revoked' WHERE restaurant_id=$1", [valid.restaurantId]);
  await assert.rejects(() => rawStart(owner, valid), { code: '23514' });
  await owner.query("UPDATE restaurant_members SET status='active' WHERE restaurant_id=$1", [valid.restaurantId]);
  await owner.query("UPDATE restaurants SET status='suspended' WHERE id=$1", [valid.restaurantId]);
  await assert.rejects(() => rawStart(owner, valid), { code: '23514' });
  await owner.query("UPDATE restaurants SET status='draft' WHERE id=$1", [valid.restaurantId]);
  await assert.rejects(() => rawStart(owner, valid, { feature: 'website_chat' }), { code: '23514' });
  await assert.rejects(() => rawStart(owner, valid, { origin: 'legacy_import', legacy_source_key: `website_model_calls:${valid.websiteJobId}:1` }), { code: '23514' });
  await assert.rejects(() => rawStart(owner, valid, { call_status: 'completed', usage_status: 'known', ...zero, elapsed_ms: 0,
    finished_at: new Date(), received_at: new Date() }), { code: '23514' });
  assert.equal((await pool.query('SELECT id FROM ai_model_calls')).rowCount, 0);
});

test('复合 FK 独立拒绝跨 user/restaurant/account/job，两个任务 FK 必须恰好一个', async () => {
  const input = await fixture(), other = await fixture(), menuInput = await menu(input.requestingUserId, input.restaurantId);
  const account = await transaction(pool, db => ensureBillingAccount(db, input.requestingUserId));
  const otherAccount = await transaction(pool, db => ensureBillingAccount(db, other.requestingUserId));
  await rollback(async db => {
    // 仅在可回滚测试事务内关闭新 guard，证明复合 FK 本身而不是权限 guard 防错绑。
    await db.query('ALTER TABLE ai_model_calls DISABLE TRIGGER ai_model_call_guard');
    await rejected(db, () => rawStart(db, input, { restaurant_id: other.restaurantId }), '23503');
    await rejected(db, () => rawStart(db, input, { requesting_user_id: other.requestingUserId, billing_account_id: otherAccount.id }), '23503');
    await rejected(db, () => rawStart(db, input, { billing_account_id: otherAccount.id }), '23503');
    await rejected(db, () => rawStart(db, input, { website_job_id: other.websiteJobId, request_key: `${other.websiteJobId}:1` }), '23503');
    await rejected(db, () => rawStart(db, menuInput, { restaurant_id: other.restaurantId }), '23503');
    await rejected(db, () => rawStart(db, menuInput, { requesting_user_id: other.requestingUserId, billing_account_id: otherAccount.id }), '23503');
    await rejected(db, () => rawStart(db, input, { menu_job_id: menuInput.menuJobId }));
    await rejected(db, () => rawStart(db, input, { website_job_id: null }));
    await rejected(db, () => rawStart(db, input, { request_key: 'fake:1' }));
    await rejected(db, () => rawStart(db, input, { runner_token: null }));
    await rejected(db, () => rawStart(db, input, { chargeable: true }));
    await rejected(db, () => rawStart(db, input, { provider: 'other' }));
    await rejected(db, () => rawStart(db, input, { model: 'x'.repeat(101) }));
    await rejected(db, () => rawStart(db, input, { call_index: 0, request_key: `${input.websiteJobId}:0` }));
    assert.equal(account.id, (await db.query('SELECT id FROM billing_accounts WHERE owner_user_id=$1', [input.requestingUserId])).rows[0].id);
  });
});

test('相同 logical job:index 重复 start 返回同 id；不同 runner/model/身份不能接管', async () => {
  const input = await fixture(), callId = await lockedStart(input);
  assert.equal(await lockedStart({ ...input, runnerToken: input.runnerToken.toUpperCase() }), callId);
  await assert.rejects(() => lockedStart({ ...input, runnerToken: randomUUID() }), /runner/);
  await assert.rejects(() => lockedStart({ ...input, model: 'other-model' }), /模型/);
  await assert.rejects(() => lockedStart({ ...input, restaurantId: 'rst_invalid_identity_test' }), /identity/);
  await assert.rejects(() => rawStart(owner, input), { code: '23505' });
  await assert.rejects(() => lockedStart({ ...input, menuJobId: id('mjb') }), /identity/);
  await assert.rejects(() => lockedStart({ ...input, callIndex: 1.5 }), /identity/);
  assert.equal((await pool.query('SELECT id FROM ai_model_calls')).rowCount, 1);
});

test('known 的零 tokens 与 unknown 严格区分；failed 也可有 known 用量', async () => {
  const input = await fixture(), first = await lockedStart(input);
  await finish({ ...input, status: 'completed', usage: zero, elapsedMs: 0 });
  const known = await call(first);
  assert.equal(known.usage_status, 'known'); assert.equal(known.total_tokens, '0'); assert.ok(known.received_at);
  const next = { ...input, callIndex: 2 }, second = await lockedStart(next);
  await finish({ ...next, status: 'completed', usage: null, elapsedMs: 15 });
  const unknown = await call(second);
  assert.equal(unknown.usage_status, 'unknown'); assert.equal(unknown.total_tokens, null); assert.equal(unknown.received_at, null); assert.ok(unknown.finished_at);
  const failedInput = { ...input, callIndex: 3 }, failedId = await lockedStart(failedInput);
  await finish({ ...failedInput, status: 'failed', usage, elapsedMs: 25, errorCode: 'MODEL_FAILED' });
  assert.equal((await call(failedId)).usage_status, 'known'); assert.equal((await call(failedId)).error_code, 'MODEL_FAILED');
  await assert.rejects(() => finish({ ...input, status: 'completed', usage: { ...usage, total_tokens: 0 }, elapsedMs: 1 }), /安全/);
  await assert.rejects(() => finish({ ...input, status: 'completed', usage: { ...usage, prompt_tokens: Number.MAX_SAFE_INTEGER + 1 }, elapsedMs: 1 }), /安全/);
  await assert.rejects(() => finish({ ...input, status: 'completed', elapsedMs: -1 }), /结算/);
  await assert.rejects(() => finish({ ...input, status: 'failed', elapsedMs: 1, errorCode: 'unsafe error text' }), /结算/);
});

test('原 runner 结算不受任务 succeeded/failed、过期租约、用户撤权影响；错误 runner 拒绝', async () => {
  for (const jobStatus of ['succeeded', 'failed'] as const) {
    const input = await fixture(), callId = await lockedStart(input);
    await owner.query(`UPDATE website_jobs SET status=$2,lease_token=NULL,lease_expires_at=NULL,error_code=$3 WHERE id=$1`,
      [input.websiteJobId, jobStatus, jobStatus === 'failed' ? 'CANCELLED' : null]);
    await owner.query("UPDATE users SET status='suspended' WHERE id=$1", [input.requestingUserId]);
    await owner.query("UPDATE restaurant_members SET status='revoked' WHERE restaurant_id=$1", [input.restaurantId]);
    await assert.rejects(() => finish({ ...input, runnerToken: randomUUID(), status: 'completed', usage, elapsedMs: 20 }), /runner/);
    await finish({ ...input, status: 'completed', usage, elapsedMs: 20 });
    assert.equal((await call(callId)).total_tokens, '20');
  }
  const menuInput = await fixture('menu'), menuCall = await lockedStart(menuInput);
  await owner.query("UPDATE menu_jobs SET status='failed',lease_token=NULL,lease_expires_at=NULL,error_code='CANCELLED' WHERE id=$1", [menuInput.menuJobId]);
  await owner.query("UPDATE restaurant_members SET status='revoked' WHERE restaurant_id=$1", [menuInput.restaurantId]);
  await finish({ ...menuInput, status: 'failed', usage, elapsedMs: 10, errorCode: 'MODEL_FAILED' });
  assert.equal((await call(menuCall)).total_tokens, '20');
  const expiredInput = await fixture(), expiredCall = await lockedStart(expiredInput);
  // 不使用等待或并发命令；测试事务把自己的旧 guard 暂时关闭来构造已过期事实。
  await rollback(async db => {
    await db.query('ALTER TABLE website_jobs DISABLE TRIGGER website_job_guard');
    await db.query("UPDATE website_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expiredInput.websiteJobId]);
    await finishAiCall(db, { ...expiredInput, status: 'completed', usage, elapsedMs: 10 });
    assert.equal((await db.query('SELECT total_tokens FROM ai_model_calls WHERE id=$1', [expiredCall])).rows[0].total_tokens, '20');
  });
});

test('终态 unknown 仅原 runner 可一次补 known，保留 terminal status/error/elapsed/finished', async () => {
  for (const status of ['completed', 'failed'] as const) {
    const input = await fixture(), callId = await lockedStart(input);
    await finish({ ...input, status, elapsedMs: 55, ...(status === 'failed' ? { errorCode: 'CANCELLED' } : {}) });
    const beforeRow = await call(callId);
    await assert.rejects(() => finish({ ...input, runnerToken: randomUUID(), status: 'completed', usage, elapsedMs: 99 }), /runner/);
    await finish({ ...input, status: status === 'completed' ? 'failed' : 'completed', usage, elapsedMs: 99,
      ...(status === 'completed' ? { errorCode: 'MODEL_FAILED' } : {}) });
    const afterRow = await call(callId);
    for (const field of ['call_status', 'error_code', 'elapsed_ms', 'finished_at']) assert.deepEqual(afterRow[field], beforeRow[field]);
    assert.equal(afterRow.usage_status, 'known'); assert.equal(afterRow.total_tokens, '20'); assert.ok(afterRow.received_at >= afterRow.finished_at);
    await finish({ ...input, status: 'failed', usage: zero, elapsedMs: 1, errorCode: 'MODEL_FAILED' });
    assert.deepEqual(await call(callId), afterRow);
  }
});

test('completed 后 failed 及终态重复 finish 不覆写；未知重复不伪造零，禁止复活', async () => {
  const input = await fixture(), callId = await lockedStart(input);
  await finish({ ...input, status: 'completed', usage, elapsedMs: 25 });
  const row = await call(callId);
  for (const status of ['completed', 'failed'] as const) {
    await finish({ ...input, status, usage: zero, elapsedMs: 99, ...(status === 'failed' ? { errorCode: 'CANCELLED' } : {}) });
    assert.deepEqual(await call(callId), row);
  }
  assert.equal(await lockedStart(input), callId);
  await assert.rejects(() => owner.query("UPDATE ai_model_calls SET call_status='started',usage_status='pending',prompt_tokens=NULL,completion_tokens=NULL,total_tokens=NULL,elapsed_ms=NULL,finished_at=NULL,received_at=NULL WHERE id=$1", [callId]), { code: '23514' });
  const unknownInput = { ...input, callIndex: 2 }, unknownId = await lockedStart(unknownInput);
  await finish({ ...unknownInput, status: 'failed', elapsedMs: 7, errorCode: 'CANCELLED' });
  const unknown = await call(unknownId);
  await finish({ ...unknownInput, status: 'completed', elapsedMs: 999 });
  assert.deepEqual(await call(unknownId), unknown);
  await assert.rejects(() => finish({ ...input, callIndex: 3, status: 'completed', usage, elapsedMs: 1 }), /尚未开始/);
});

test('失联 started：网页和菜单来源 failed/succeeded 均结为 unknown，不改任务或 007', async () => {
  for (const kind of ['generate', 'chat', 'menu'] as const) {
    for (const status of ['failed', 'succeeded'] as const) {
      const input = await fixture(kind), callId = await lockedStart(input);
      const table = input.websiteJobId ? 'website_jobs' : 'menu_jobs', jobId = input.websiteJobId ?? input.menuJobId;
      await owner.query(`UPDATE ${table} SET status=$2,lease_token=NULL,lease_expires_at=NULL,error_code=$3
        ${input.menuJobId ? ',result_revision=CASE WHEN $2=\'succeeded\' THEN expected_revision+1 END' : ''} WHERE id=$1`,
      [jobId, status, status === 'failed' ? 'MODEL_FAILED' : null]);
      const jobBefore = (await pool.query(`SELECT * FROM ${table} WHERE id=$1`, [jobId])).rows[0];
      const beforeRow = await call(callId);
      assert.equal(await closeInterruptedAiCalls(pool), 1);
      const row = await call(callId);
      assert.equal(row.call_status, 'failed'); assert.equal(row.usage_status, 'unknown'); assert.equal(row.error_code, 'JOB_INTERRUPTED');
      assert.ok(row.finished_at >= row.created_at);
      for (const field of ['elapsed_ms', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'received_at']) assert.equal(row[field], null);
      for (const field of ['id', 'billing_account_id', 'requesting_user_id', 'restaurant_id', 'website_job_id', 'menu_job_id',
        'runner_token', 'model', 'request_key', 'created_at', 'origin', 'chargeable']) assert.deepEqual(row[field], beforeRow[field]);
      assert.deepEqual((await pool.query(`SELECT * FROM ${table} WHERE id=$1`, [jobId])).rows[0], jobBefore);
    }
  }
  assert.equal((await pool.query('SELECT * FROM website_model_calls')).rowCount, 0);
});

test('失联 started：运行租约已过期才能结清，elapsed 保持 null，冻结来源仍 running', async () => {
  const inputs = [await fixture(), await fixture('menu')];
  const callIds = await Promise.all(inputs.map(lockedStart));
  await rollback(async db => {
    // 仅在最终回滚的测试事务构造过期来源；不等待、不永久改动 guard。
    await db.query('ALTER TABLE website_jobs DISABLE TRIGGER website_job_guard');
    await db.query('ALTER TABLE menu_jobs DISABLE TRIGGER menu_job_guard');
    for (const input of inputs) {
      await db.query(`UPDATE ${input.websiteJobId ? 'website_jobs' : 'menu_jobs'}
        SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [input.websiteJobId ?? input.menuJobId]);
    }
    await db.query('ALTER TABLE website_jobs ENABLE TRIGGER website_job_guard');
    await db.query('ALTER TABLE menu_jobs ENABLE TRIGGER menu_job_guard');
    const nested = { connect: async () => ({
      query: (sql: string, values?: unknown[]) => db.query(sql === 'BEGIN' ? 'SAVEPOINT reconcile_expired' :
        sql === 'COMMIT' ? 'RELEASE SAVEPOINT reconcile_expired' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT reconcile_expired' : sql, values),
      release: () => undefined,
    }) } as unknown as Pool;
    const jobsBefore = await Promise.all(inputs.map(async input => (await db.query(`SELECT * FROM
      ${input.websiteJobId ? 'website_jobs' : 'menu_jobs'} WHERE id=$1`, [input.websiteJobId ?? input.menuJobId])).rows[0]));
    assert.equal(await closeInterruptedAiCalls(nested), 2);
    assert.equal(await closeInterruptedAiCalls(nested), 0);
    for (let index = 0; index < inputs.length; index++) {
      const row = (await db.query('SELECT * FROM ai_model_calls WHERE id=$1', [callIds[index]])).rows[0];
      assert.equal(row.call_status, 'failed'); assert.equal(row.usage_status, 'unknown'); assert.equal(row.error_code, 'JOB_INTERRUPTED');
      assert.equal(row.elapsed_ms, null); assert.equal(row.total_tokens, null); assert.equal(row.received_at, null);
      assert.ok(row.finished_at >= row.created_at);
      const input = inputs[index]!;
      assert.deepEqual((await db.query(`SELECT * FROM ${input.websiteJobId ? 'website_jobs' : 'menu_jobs'} WHERE id=$1`,
        [input.websiteJobId ?? input.menuJobId])).rows[0], jobsBefore[index]);
    }
  });
  for (const callId of callIds) assert.equal((await call(callId)).call_status, 'started');
});

test('失联结清不因撤权独自关调用：有效 running、queued 和既有终态全部保持原样', async () => {
  const input = await fixture(), activeId = await lockedStart(input);
  const known = { ...input, callIndex: 2 }, knownId = await lockedStart(known);
  await finish({ ...known, status: 'completed', usage, elapsedMs: 5 });
  const unknown = { ...input, callIndex: 3 }, unknownId = await lockedStart(unknown);
  await finish({ ...unknown, status: 'failed', elapsedMs: 7, errorCode: 'MODEL_FAILED' });
  const menuInput = await fixture('menu'), activeMenu = await lockedStart(menuInput);
  await owner.query("UPDATE restaurant_members SET status='revoked' WHERE restaurant_id=$1", [input.restaurantId]);
  const queuedUser = await user();
  await website(queuedUser, await restaurant(queuedUser), 'generate', owner, 'queued');
  const ids = [activeId, knownId, unknownId, activeMenu], beforeRows = await Promise.all(ids.map(call));
  assert.equal(await closeInterruptedAiCalls(pool), 0);
  assert.deepEqual(await Promise.all(ids.map(call)), beforeRows);
  await owner.query("UPDATE website_jobs SET status='failed',lease_token=NULL,lease_expires_at=NULL,error_code='MODEL_FAILED' WHERE id=$1", [input.websiteJobId]);
  assert.equal(await closeInterruptedAiCalls(pool), 1);
  assert.deepEqual(await call(knownId), beforeRows[1]);
  assert.deepEqual(await call(unknownId), beforeRows[2]);
  assert.deepEqual(await call(activeMenu), beforeRows[3]);
});

test('两次失联 reconcile 幂等：只改变 started，一次终态时间与空用量不覆写', async () => {
  const input = await fixture(), firstId = await lockedStart(input), secondId = await lockedStart({ ...input, callIndex: 2 });
  await owner.query("UPDATE website_jobs SET status='failed',lease_token=NULL,lease_expires_at=NULL,error_code='JOB_INTERRUPTED' WHERE id=$1", [input.websiteJobId]);
  assert.equal(await closeInterruptedAiCalls(pool), 2);
  const rows = await Promise.all([firstId, secondId].map(call));
  assert.equal(await closeInterruptedAiCalls(pool), 0);
  assert.deepEqual(await Promise.all([firstId, secondId].map(call)), rows);
});

test('撤权 job failed → unknown → 原 runner 迟到 known：保留失联终态且错误 runner 不能接管', async () => {
  for (const kind of ['generate', 'menu'] as const) {
    const input = await fixture(kind), callId = await lockedStart(input);
    await owner.query("UPDATE users SET status='suspended' WHERE id=$1", [input.requestingUserId]);
    await owner.query("UPDATE restaurant_members SET status='revoked' WHERE restaurant_id=$1", [input.restaurantId]);
    const table = input.websiteJobId ? 'website_jobs' : 'menu_jobs', jobId = input.websiteJobId ?? input.menuJobId;
    await owner.query(`UPDATE ${table} SET status='failed',lease_token=NULL,lease_expires_at=NULL,error_code='AGENT_CANCELLED' WHERE id=$1`, [jobId]);
    const jobBefore = (await pool.query(`SELECT * FROM ${table} WHERE id=$1`, [jobId])).rows[0];
    assert.equal(await closeInterruptedAiCalls(pool), 1);
    const interrupted = await call(callId);
    assert.equal(interrupted.call_status, 'failed'); assert.equal(interrupted.usage_status, 'unknown');
    assert.equal(interrupted.error_code, 'AGENT_CANCELLED'); assert.equal(interrupted.elapsed_ms, null);
    await assert.rejects(() => finish({ ...input, runnerToken: randomUUID(), status: 'completed', usage, elapsedMs: 999 }), /runner/);
    assert.deepEqual(await call(callId), interrupted);
    await finish({ ...input, status: 'completed', usage, elapsedMs: 999 });
    const received = await call(callId);
    for (const field of Object.keys(interrupted).filter(field => !['usage_status', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'received_at'].includes(field))) {
      assert.deepEqual(received[field], interrupted[field]);
    }
    assert.equal(received.usage_status, 'known'); assert.equal(received.prompt_tokens, '12');
    assert.equal(received.completion_tokens, '8'); assert.equal(received.total_tokens, '20'); assert.ok(received.received_at >= received.finished_at);
    await assert.rejects(() => finish({ ...input, runnerToken: randomUUID(), status: 'failed', usage: zero, elapsedMs: 1 }), /runner/);
    await finish({ ...input, status: 'failed', usage: zero, elapsedMs: 1, errorCode: 'MODEL_FAILED' });
    assert.equal(await closeInterruptedAiCalls(pool), 0);
    assert.deepEqual(await call(callId), received);
    assert.deepEqual((await pool.query(`SELECT * FROM ${table} WHERE id=$1`, [jobId])).rows[0], jobBefore);
  }
});

test('失联结清 limit 50 且 SKIP LOCKED；旧 user/job/quota 行被锁时不反序锁定或消费', async () => {
  const input = await fixture(), firstId = await lockedStart(input);
  const callIds = [firstId];
  for (let callIndex = 2; callIndex <= 52; callIndex++) callIds.push(await lockedStart({ ...input, callIndex }));
  const accountId = (await call(firstId)).billing_account_id, periodId = await period(accountId);
  await entry(periodId, accountId, null, 'grant', id('grant'), [100, 0, 0], input.requestingUserId);
  await owner.query("UPDATE website_jobs SET status='failed',lease_token=NULL,lease_expires_at=NULL,error_code='JOB_INTERRUPTED' WHERE id=$1", [input.websiteJobId]);
  const quotaBefore = (await pool.query('SELECT * FROM ai_quota_periods WHERE id=$1', [periodId])).rows[0];
  const ledgerBefore = (await pool.query('SELECT * FROM ai_quota_ledger ORDER BY id')).rows;
  await transaction(owner, async db => {
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [input.requestingUserId]);
    await db.query('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE', [input.restaurantId]);
    await db.query('SELECT id FROM restaurant_members WHERE restaurant_id=$1 FOR UPDATE', [input.restaurantId]);
    await db.query('SELECT id FROM website_jobs WHERE id=$1 FOR UPDATE', [input.websiteJobId]);
    await db.query('SELECT id FROM ai_quota_periods WHERE id=$1 FOR UPDATE', [periodId]);
    await db.query('SELECT id FROM ai_quota_ledger FOR UPDATE');
    await db.query('SELECT id FROM ai_model_calls WHERE id=$1 FOR UPDATE', [firstId]);
    assert.equal(await closeInterruptedAiCalls(pool), 50);
    assert.equal((await call(firstId)).call_status, 'started');
    assert.equal(await closeInterruptedAiCalls(pool), 1);
    assert.equal(await closeInterruptedAiCalls(pool), 0);
  });
  assert.equal(await closeInterruptedAiCalls(pool), 1);
  assert.equal(await closeInterruptedAiCalls(pool), 0);
  for (const callId of callIds) assert.equal((await call(callId)).usage_status, 'unknown');
  assert.deepEqual((await pool.query('SELECT * FROM ai_quota_periods WHERE id=$1', [periodId])).rows[0], quotaBefore);
  assert.deepEqual((await pool.query('SELECT * FROM ai_quota_ledger ORDER BY id')).rows, ledgerBefore);
});

test('数据库不可删除或修改 identity/model/account/created_at；counts 安全且三项一致', async () => {
  const input = await fixture(), callId = await lockedStart(input), other = await fixture();
  const otherAccount = await transaction(pool, db => ensureBillingAccount(db, other.requestingUserId));
  for (const [column, value] of Object.entries({ id: id('aic'), billing_account_id: otherAccount.id, requesting_user_id: other.requestingUserId,
    restaurant_id: other.restaurantId, website_job_id: other.websiteJobId, call_index: 2, runner_token: randomUUID(), request_key: 'fake:1',
    model: 'other', feature: 'website_chat', origin: 'legacy_import', policy_version: 'future', created_at: new Date(0) })) {
    await assert.rejects(() => owner.query(`UPDATE ai_model_calls SET ${column}=$2 WHERE id=$1`, [callId, value]), { code: '23514' });
  }
  await assert.rejects(() => owner.query('DELETE FROM ai_model_calls WHERE id=$1', [callId]), { code: '23514' });
  const accountId = (await call(callId)).billing_account_id;
  await assert.rejects(() => owner.query('UPDATE billing_accounts SET owner_user_id=$2 WHERE id=$1', [accountId, other.requestingUserId]), { code: '23514' });
  await assert.rejects(() => owner.query('DELETE FROM billing_accounts WHERE id=$1', [accountId]), { code: '23514' });
  for (const tokens of [[null, 0, 0], [1, 1, 1], [-1, 1, 0], ['9007199254740992', 0, '9007199254740992']]) {
    await assert.rejects(() => owner.query(`UPDATE ai_model_calls SET call_status='completed',usage_status='known',
      prompt_tokens=$2,completion_tokens=$3,total_tokens=$4,elapsed_ms=1,finished_at=statement_timestamp(),received_at=statement_timestamp() WHERE id=$1`,
    [callId, ...tokens]), { code: '23514' });
  }
  await assert.rejects(() => rawStart(owner, { ...input, callIndex: 2 }, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }), { code: '23514' });
});

test('010 真实迁移导入 007 并幂等：逐调用原 counts、legacy 非收费，不展开旧聚合', async () => {
  await rollback(async db => {
    // 仅在 owner 回滚事务的 savepoint 内重演 009 → 010 → 011 → 012 → 013 → 014，显式拆除依赖。
    await db.query('SAVEPOINT replay_010');
    await db.query('DROP TRIGGER ai_model_call_calendar_consumption ON ai_model_calls');
    await db.query('DROP TRIGGER ai_quota_ledger_calendar_guard ON ai_quota_ledger');
    await db.query('DROP TRIGGER ai_calendar_credit_grant_guard ON ai_calendar_credit_grants');
    await db.query('DROP TABLE ai_calendar_credit_grants');
    await db.query('DROP FUNCTION book_ai_calendar_consumption(),guard_ai_calendar_consume(),guard_ai_calendar_credit_grant()');
    await db.query("DELETE FROM schema_migrations WHERE version IN ('013_calendar_test_credits','014_calendar_credit_guards')");
    await remove012ForMigrationReplay(db);
    await db.query(`DROP TABLE billing_subscriptions,billing_offer_grants,billing_price_versions,
      billing_credit_pack_versions,billing_plan_versions`);
    await db.query('DROP FUNCTION guard_billing_catalog_version(),guard_billing_offer_grant(),guard_billing_subscription()');
    await db.query("DELETE FROM schema_migrations WHERE version='011_billing_catalog'");
    await db.query('DROP TABLE ai_quota_ledger,ai_quota_periods,ai_model_calls,billing_accounts');
    await db.query(`DROP FUNCTION guard_billing_account(),guard_ai_model_call(),guard_ai_quota_period(),guard_ai_quota_ledger(),project_ai_quota_entry(),
      apply_ai_quota_entry(text,text,text,text,text,bigint,bigint,bigint,text,text)`);
    await db.query('ALTER TABLE website_jobs DROP CONSTRAINT website_jobs_ai_identity');
    await db.query('ALTER TABLE menu_jobs DROP CONSTRAINT menu_jobs_ai_identity');
    await db.query("DELETE FROM schema_migrations WHERE version='010_ai_metering'");
    const uid = await user(db), rid = await restaurant(uid, db), input = await website(uid, rid, 'generate', db);
    for (const index of [1, 2, 3, 4]) {
      await db.query("INSERT INTO website_model_calls(job_id,call_index,runner_token,status,elapsed_ms) VALUES($1,$2,$3,'started',0)", [input.websiteJobId, index, input.runnerToken]);
    }
    await db.query(`UPDATE website_model_calls SET status='completed',prompt_tokens=0,completion_tokens=0,total_tokens=0,elapsed_ms=2,
      updated_at=clock_timestamp() WHERE job_id=$1 AND call_index=1`, [input.websiteJobId]);
    await db.query(`UPDATE website_model_calls SET status='failed',prompt_tokens=12,completion_tokens=8,total_tokens=20,elapsed_ms=3,
      error_code='MODEL_FAILED',updated_at=clock_timestamp() WHERE job_id=$1 AND call_index=2`, [input.websiteJobId]);
    await db.query(`UPDATE website_model_calls SET status='failed',elapsed_ms=4,error_code='CANCELLED',updated_at=clock_timestamp()
      WHERE job_id=$1 AND call_index=3`, [input.websiteJobId]);
    await db.query("UPDATE website_jobs SET status='succeeded',lease_token=NULL,lease_expires_at=NULL,usage=$2 WHERE id=$1", [input.websiteJobId, usage]);
    const aggregate = await website(uid, await restaurant(uid, db), 'generate', db);
    await db.query("UPDATE website_jobs SET status='succeeded',lease_token=NULL,lease_expires_at=NULL,usage=$2 WHERE id=$1", [aggregate.websiteJobId, usage]);
    // migrate 自身仍执行完整清单与 checksum；事务边界映射成 savepoint，最终全部回滚。
    const nested = { connect: async () => ({
      query: (sql: string, values?: unknown[]) => db.query(sql === 'BEGIN' ? 'SAVEPOINT replay_migrate' :
        sql === 'COMMIT' ? 'RELEASE SAVEPOINT replay_migrate' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT replay_migrate' : sql, values),
      release: () => undefined,
    }) } as unknown as Pool;
    await migrate(nested, 'restaurant_test_app');
    const sql012 = await readFile(new URL('../migrations/012_website_content.sql', import.meta.url), 'utf8');
    assert.equal((await db.query("SELECT checksum FROM schema_migrations WHERE version='012_website_content'")).rows[0].checksum,
      createHash('sha256').update(sql012).digest('hex'), '重演必须由完整 migrate 重建 012');
    const sql013 = await readFile(new URL('../migrations/013_calendar_test_credits.sql', import.meta.url), 'utf8');
    assert.equal((await db.query("SELECT checksum FROM schema_migrations WHERE version='013_calendar_test_credits'")).rows[0].checksum,
      createHash('sha256').update(sql013).digest('hex'), '重演必须由完整 migrate 重建 013');
    const sql014 = await readFile(new URL('../migrations/014_calendar_credit_guards.sql', import.meta.url), 'utf8');
    assert.equal((await db.query("SELECT checksum FROM schema_migrations WHERE version='014_calendar_credit_guards'")).rows[0].checksum,
      createHash('sha256').update(sql014).digest('hex'), '重演必须重新应用自然月消费守卫');
    assert.equal((await db.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='website_versions'::regclass AND tgname='website_version_source_required'")).rows[0].tgenabled, 'O');
    const rows = (await db.query('SELECT * FROM ai_model_calls ORDER BY call_index')).rows;
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(row.origin, 'legacy_import'); assert.equal(row.chargeable, false); assert.equal(row.feature, 'website_generate');
      assert.equal(row.model, 'legacy-unknown'); assert.equal(row.runner_token, input.runnerToken);
      assert.equal(row.legacy_source_key, `website_model_calls:${input.websiteJobId}:${row.call_index}`);
      const source = (await db.query('SELECT * FROM website_model_calls WHERE job_id=$1 AND call_index=$2', [input.websiteJobId, row.call_index])).rows[0];
      for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'error_code', 'created_at']) assert.deepEqual(row[key], source[key]);
      assert.equal(row.call_status, source.status);
    }
    assert.equal(rows[0].usage_status, 'known'); assert.equal(rows[0].total_tokens, '0');
    assert.equal(rows[1].usage_status, 'known'); assert.equal(rows[1].total_tokens, '20');
    assert.equal(rows[2].usage_status, 'unknown'); assert.equal(rows[2].total_tokens, null);
    assert.equal(rows[3].usage_status, 'pending'); assert.equal(rows[3].finished_at, null); assert.equal(rows[3].elapsed_ms, null);
    assert.equal((await db.query('SELECT id FROM ai_model_calls WHERE website_job_id=$1', [aggregate.websiteJobId])).rowCount, 0);
    const accounts = (await db.query('SELECT * FROM billing_accounts ORDER BY id')).rows;
    await migrate(nested, 'restaurant_test_app');
    assert.deepEqual((await db.query('SELECT * FROM ai_model_calls ORDER BY call_index')).rows, rows);
    assert.deepEqual((await db.query('SELECT * FROM billing_accounts ORDER BY id')).rows, accounts);
    const sql = await readFile(new URL('../migrations/010_ai_metering.sql', import.meta.url), 'utf8');
    assert.equal((await db.query("SELECT checksum FROM schema_migrations WHERE version='010_ai_metering'")).rows[0].checksum, createHash('sha256').update(sql).digest('hex'));
    assert.equal((await db.query("SELECT tgname FROM pg_trigger WHERE tgrelid='website_model_calls'::regclass AND NOT tgisinternal")).rows[0].tgname, 'website_model_call_guard');
    assert.equal((await db.query('SELECT id FROM ai_quota_periods')).rowCount, 0);
    await db.query("UPDATE schema_migrations SET checksum='changed' WHERE version='010_ai_metering'");
    await assert.rejects(() => migrate(nested, 'restaurant_test_app'), /已执行迁移被修改/);
    await db.query('ROLLBACK TO SAVEPOINT replay_010');
    await db.query('RELEASE SAVEPOINT replay_010');
    assert.equal((await db.query("SELECT version FROM schema_migrations WHERE version='013_calendar_test_credits'")).rowCount, 1);
    assert.equal((await db.query("SELECT version FROM schema_migrations WHERE version='012_website_content'")).rowCount, 1);
    assert.equal((await db.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='website_versions'::regclass AND tgname='website_version_source_required'")).rows[0].tgenabled, 'O');
  });
});

async function period(accountId: string, kind: 'trial' | 'paid' = 'trial'): Promise<string> {
  const periodId = id('aqp');
  await owner.query(`INSERT INTO ai_quota_periods(id,billing_account_id,kind,starts_at,ends_at,grant_key)
    VALUES($1,$2,$3,clock_timestamp(),clock_timestamp()+interval '30 days',$4)`, [periodId, accountId, kind, id('grant')]);
  return periodId;
}
async function entry(periodId: string, accountId: string, callId: string | null, type: string, key: string, deltas: number[], actor: string,
  db: Database = owner, reason = 'FIXTURE_ENTRY'): Promise<string> {
  return (await db.query(`SELECT apply_ai_quota_entry($1,$2,$3,$4,$5,$6::bigint,$7::bigint,$8::bigint,$9,$10) AS id`,
    [periodId, accountId, callId, type, key, ...deltas, reason, actor])).rows[0].id;
}
async function balances(periodId: string): Promise<string[]> {
  const row = (await pool.query('SELECT granted_tokens,reserved_tokens,consumed_tokens,available_tokens FROM ai_quota_periods WHERE id=$1', [periodId])).rows[0];
  return [row.granted_tokens, row.reserved_tokens, row.consumed_tokens, row.available_tokens];
}

test('已配置 quota 的观察调用既不锁 quota/ledger，也不预留或消费', async () => {
  const input = await fixture(), account = await transaction(pool, db => ensureBillingAccount(db, input.requestingUserId));
  const periodId = await period(account.id);
  await entry(periodId, account.id, null, 'grant', id('grant'), [100, 0, 0], input.requestingUserId);
  const snapshot = (await owner.query('SELECT * FROM ai_quota_periods WHERE id=$1', [periodId])).rows[0];
  await transaction(pool, async db => {
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [input.requestingUserId]);
    await db.query('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE', [input.restaurantId]);
    await db.query('SELECT id FROM restaurant_members WHERE restaurant_id=$1 AND user_id=$2 FOR UPDATE', [input.restaurantId, input.requestingUserId]);
    await db.query('SELECT id FROM website_jobs WHERE id=$1 FOR UPDATE', [input.websiteJobId]);
    await startAiCall(db, input);
    await finishAiCall(db, { ...input, status: 'completed', usage, elapsedMs: 5 });
    const locks = await db.query(`SELECT relation FROM pg_locks WHERE pid=pg_backend_pid() AND relation IN
      ('ai_quota_periods'::regclass,'ai_quota_ledger'::regclass)`);
    assert.equal(locks.rowCount, 0);
  });
  assert.deepEqual((await pool.query('SELECT * FROM ai_quota_periods WHERE id=$1', [periodId])).rows[0], snapshot);
  assert.equal((await pool.query('SELECT id FROM ai_quota_ledger')).rowCount, 1);
});

test('trial/paid 周期边界、grant_key 唯一与安全整数约束', async () => {
  const input = await fixture(), account = await transaction(pool, db => ensureBillingAccount(db, input.requestingUserId));
  const periodId = await period(account.id), row = (await owner.query('SELECT * FROM ai_quota_periods WHERE id=$1', [periodId])).rows[0];
  await assert.rejects(() => owner.query(`INSERT INTO ai_quota_periods(id,billing_account_id,kind,starts_at,ends_at,grant_key)
    VALUES($1,$2,'paid',clock_timestamp(),clock_timestamp()+interval '1 day',$3)`, [id('aqp'), account.id, row.grant_key]), { code: '23505' });
  await assert.rejects(() => owner.query(`INSERT INTO ai_quota_periods(id,billing_account_id,kind,starts_at,ends_at,grant_key)
    VALUES($1,$2,'trial',statement_timestamp(),statement_timestamp(),$3)`, [id('aqp'), account.id, id('grant')]), { code: '23514' });
  await assert.rejects(() => entry(periodId, account.id, null, 'grant', id('grant'), [Number.MAX_SAFE_INTEGER + 1, 0, 0], input.requestingUserId), { code: '23514' });
  await assert.rejects(() => period(account.id, 'trial'), { code: '23505' });
  const paidId = await period(account.id, 'paid');
  assert.equal((await pool.query('SELECT kind FROM ai_quota_periods WHERE id=$1', [paidId])).rows[0].kind, 'paid');
});

test('owner grant/reserve/settle/release/adjust/expire 与投影守恒；同 key 同 body 不二次消费，负 available 合法', async () => {
  const input = await fixture(), callId = await lockedStart(input), accountId = (await call(callId)).billing_account_id;
  const periodId = await period(accountId), uid = input.requestingUserId;
  assert.deepEqual(await balances(periodId), ['0', '0', '0', '0']);
  const grantKey = id('grant'), grantId = await entry(periodId, accountId, null, 'grant', grantKey, [100, 0, 0], uid);
  assert.match(grantId, /^aql_[A-Za-z0-9_-]{24}$/);
  assert.equal(await entry(periodId, accountId, null, 'grant', grantKey, [100, 0, 0], uid), grantId);
  assert.deepEqual(await balances(periodId), ['100', '0', '0', '100']);
  const reserveKey = id('reserve'), reserveId = await entry(periodId, accountId, callId, 'reserve', reserveKey, [0, 40, 0], uid);
  assert.equal(await entry(periodId, accountId, callId, 'reserve', reserveKey, [0, 40, 0], uid), reserveId);
  assert.deepEqual(await balances(periodId), ['100', '40', '0', '60']);
  const settleKey = id('settle'), settleId = await entry(periodId, accountId, callId, 'settle', settleKey, [0, -40, 120], uid);
  assert.equal(await entry(periodId, accountId, callId, 'settle', settleKey, [0, -40, 120], uid), settleId);
  assert.deepEqual(await balances(periodId), ['100', '0', '120', '-20']);
  await assert.rejects(() => entry(periodId, accountId, callId, 'settle', id('again'), [0, -40, 120], uid), { code: '23514' });
  const nextInput = { ...input, callIndex: 2 }, nextId = await lockedStart(nextInput);
  await assert.rejects(() => entry(periodId, accountId, nextId, 'reserve', id('reserve'), [0, 1, 0], uid), { code: '23514' });
  await entry(periodId, accountId, null, 'adjust', id('adjust'), [50, 0, 0], uid);
  await entry(periodId, accountId, nextId, 'reserve', id('reserve'), [0, 30, 0], uid);
  await entry(periodId, accountId, nextId, 'release', id('release'), [0, -30, 0], uid);
  await entry(periodId, accountId, null, 'expire', id('expire'), [-10, 0, 0], uid);
  assert.deepEqual(await balances(periodId), ['140', '0', '120', '20']);
  const sums = (await pool.query(`SELECT sum(delta_granted_tokens)::text AS granted,sum(delta_reserved_tokens)::text AS reserved,
    sum(delta_consumed_tokens)::text AS consumed FROM ai_quota_ledger WHERE period_id=$1`, [periodId])).rows[0];
  assert.deepEqual([sums.granted, sums.reserved, sums.consumed], ['140', '0', '120']);
  assert.equal((await pool.query('SELECT id FROM ai_quota_ledger')).rowCount, 7);
  const snapshot = (await pool.query('SELECT * FROM ai_quota_periods WHERE id=$1', [periodId])).rows[0];
  await finish({ ...input, status: 'completed', usage, elapsedMs: 5 });
  assert.deepEqual((await pool.query('SELECT * FROM ai_quota_periods WHERE id=$1', [periodId])).rows[0], snapshot);
});

test('同账号两店并发预留只能消费同一个共享池一次', async () => {
  const input = await fixture(), firstId = await lockedStart(input);
  const second = await website(input.requestingUserId, await restaurant(input.requestingUserId));
  const secondId = await lockedStart(second), accountId = (await call(firstId)).billing_account_id;
  assert.equal((await call(secondId)).billing_account_id, accountId);
  const periodId = await period(accountId);
  await entry(periodId, accountId, null, 'grant', id('grant'), [50, 0, 0], input.requestingUserId);
  const results = await Promise.allSettled([firstId, secondId].map(callId =>
    entry(periodId, accountId, callId, 'reserve', id('reserve'), [0, 40, 0], input.requestingUserId)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejection = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejection.reason.code, '23514');
  assert.deepEqual(await balances(periodId), ['50', '40', '0', '10']);
});

test('ledger 幂等键异 body 报错、跨 account/period/call 防错绑、禁止负投影及账本篡改', async () => {
  const input = await fixture(), callId = await lockedStart(input), accountId = (await call(callId)).billing_account_id;
  const other = await fixture(), otherId = await lockedStart(other), otherAccountId = (await call(otherId)).billing_account_id;
  const periodId = await period(accountId), otherPeriod = await period(otherAccountId, 'paid'), uid = input.requestingUserId;
  const key = id('grant');
  await entry(periodId, accountId, null, 'grant', key, [10, 0, 0], uid);
  for (const args of [
    [periodId, accountId, null, 'grant', key, [11, 0, 0], uid],
    [periodId, accountId, null, 'grant', key, [10, 0, 0], other.requestingUserId],
    [otherPeriod, otherAccountId, null, 'grant', key, [10, 0, 0], uid],
  ] as const) await assert.rejects(() => entry(args[0], args[1], args[2], args[3], args[4], [...args[5]], args[6]), { code: '23514' });
  await assert.rejects(() => entry(periodId, accountId, null, 'grant', key, [10, 0, 0], uid, owner, 'OTHER_REASON'), { code: '23514' });
  await assert.rejects(() => entry(periodId, otherAccountId, null, 'grant', id('grant'), [1, 0, 0], uid), { code: '23503' });
  await assert.rejects(() => entry(periodId, accountId, otherId, 'reserve', id('reserve'), [0, 1, 0], uid), { code: '23503' });
  await assert.rejects(() => entry(periodId, accountId, null, 'grant', id('grant'), [1, 0, 0], id('usr')), { code: '23503' });
  await assert.rejects(() => entry(periodId, accountId, null, 'expire', id('expire'), [-11, 0, 0], uid), { code: '23514' });
  await assert.rejects(() => entry(periodId, accountId, null, 'grant', id('huge'), [Number.MAX_SAFE_INTEGER, 0, 0], uid), { code: '23514' });
  await entry(periodId, accountId, callId, 'reserve', id('reserve'), [0, 2, 0], uid);
  await assert.rejects(() => entry(periodId, accountId, callId, 'reserve', id('again'), [0, 2, 0], uid), { code: '23505' });
  await assert.rejects(() => entry(periodId, accountId, callId, 'settle', id('bad'), [0, -3, 1], uid), { code: '23514' });
  await assert.rejects(() => owner.query('UPDATE ai_quota_periods SET granted_tokens=999 WHERE id=$1', [periodId]), { code: '23514' });
  await assert.rejects(() => owner.query('UPDATE ai_quota_periods SET billing_account_id=$2 WHERE id=$1', [periodId, otherAccountId]), { code: '23514' });
  await assert.rejects(() => owner.query('DELETE FROM ai_quota_periods WHERE id=$1', [periodId]), { code: '23514' });
  await assert.rejects(() => owner.query("UPDATE ai_quota_ledger SET reason_code='OTHER_REASON' WHERE idempotency_key=$1", [key]), { code: '23514' });
  await assert.rejects(() => owner.query('DELETE FROM ai_quota_ledger WHERE idempotency_key=$1', [key]), { code: '23514' });
  assert.deepEqual(await balances(periodId), ['10', '2', '0', '8']);
});

test('owner 直接 append ledger 仍强制更新 projection；初始化余额不能脱离 ledger', async () => {
  const input = await fixture(), callId = await lockedStart(input), accountId = (await call(callId)).billing_account_id;
  const periodId = await period(accountId);
  await owner.query(`INSERT INTO ai_quota_ledger(id,period_id,billing_account_id,entry_type,idempotency_key,
    delta_granted_tokens,delta_reserved_tokens,delta_consumed_tokens,reason_code,actor_user_id)
    VALUES($1,$2,$3,'grant',$4,30,0,0,'FIXTURE_ENTRY',$5)`, [id('aql'), periodId, accountId, id('grant'), input.requestingUserId]);
  assert.deepEqual(await balances(periodId), ['30', '0', '0', '30']);
  await assert.rejects(() => owner.query(`INSERT INTO ai_quota_periods(id,billing_account_id,kind,starts_at,ends_at,grant_key,granted_tokens)
    VALUES($1,$2,'paid',clock_timestamp(),clock_timestamp()+interval '1 day',$3,50)`, [id('aqp'), accountId, id('grant')]), { code: '23514' });
});

test('app/testapp 列级权限：账户无 UPDATE，call 仅结算，quota 只 SELECT，owner 独占 function EXECUTE', async () => {
  const input = await fixture(), callId = await lockedStart(input), accountId = (await call(callId)).billing_account_id;
  const periodId = await period(accountId);
  const roles = (await owner.query("SELECT rolname FROM pg_roles WHERE rolname IN ('restaurant_app','restaurant_test_app') ORDER BY rolname")).rows;
  assert.ok(roles.some(row => row.rolname === 'restaurant_test_app'));
  const signature = 'apply_ai_quota_entry(text,text,text,text,text,bigint,bigint,bigint,text,text)';
  for (const { rolname } of roles) {
    for (const table of ['billing_accounts', 'ai_model_calls', 'ai_quota_periods', 'ai_quota_ledger']) {
      const permissions = (await owner.query(`SELECT has_table_privilege($1,$2,'SELECT') AS read,
        has_table_privilege($1,$2,'UPDATE') AS update_all,has_table_privilege($1,$2,'DELETE') AS delete_rows,
        has_table_privilege($1,$2,'TRUNCATE') AS truncate_rows`, [rolname, table])).rows[0];
      assert.deepEqual(permissions, { read: true, update_all: false, delete_rows: false, truncate_rows: false });
    }
    for (const column of ['id', 'owner_user_id']) assert.equal((await owner.query("SELECT has_column_privilege($1,'billing_accounts',$2,'INSERT') AS allowed", [rolname, column])).rows[0].allowed, true);
    for (const column of ['id', 'owner_user_id', 'status', 'created_at']) assert.equal((await owner.query("SELECT has_column_privilege($1,'billing_accounts',$2,'UPDATE') AS allowed", [rolname, column])).rows[0].allowed, false);
    for (const column of ['call_status', 'usage_status', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'elapsed_ms', 'error_code', 'finished_at', 'received_at']) {
      assert.equal((await owner.query("SELECT has_column_privilege($1,'ai_model_calls',$2,'UPDATE') AS allowed", [rolname, column])).rows[0].allowed, true);
      assert.equal((await owner.query("SELECT has_column_privilege($1,'ai_model_calls',$2,'INSERT') AS allowed", [rolname, column])).rows[0].allowed, false);
    }
    for (const column of ['model', 'runner_token', 'billing_account_id', 'created_at', 'origin', 'chargeable', 'request_key']) assert.equal((await owner.query("SELECT has_column_privilege($1,'ai_model_calls',$2,'UPDATE') AS allowed", [rolname, column])).rows[0].allowed, false);
    for (const table of ['ai_quota_periods', 'ai_quota_ledger']) assert.equal((await owner.query("SELECT has_table_privilege($1,$2,'INSERT') AS allowed", [rolname, table])).rows[0].allowed, false);
    assert.equal((await owner.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS allowed', [rolname, signature])).rows[0].allowed, false);
  }
  assert.equal((await owner.query('SELECT has_function_privilege(current_user,$1,\'EXECUTE\') AS allowed', [signature])).rows[0].allowed, true);
  assert.equal((await owner.query(`SELECT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS allowed`, [signature])).rows[0].allowed, false);
  await assert.rejects(() => pool.query("UPDATE billing_accounts SET status='closed' WHERE id=$1", [accountId]), { code: '42501' });
  await assert.rejects(() => pool.query("UPDATE ai_model_calls SET model='other' WHERE id=$1", [callId]), { code: '42501' });
  await assert.rejects(() => pool.query('DELETE FROM ai_model_calls WHERE id=$1', [callId]), { code: '42501' });
  await assert.rejects(() => pool.query('UPDATE ai_quota_periods SET granted_tokens=100 WHERE id=$1', [periodId]), { code: '42501' });
  await assert.rejects(() => entry(periodId, accountId, null, 'grant', id('denied'), [100, 0, 0], input.requestingUserId, pool), { code: '42501' });
  await assert.rejects(() => rawStart(pool, { ...input, callIndex: 2 }, { call_status: 'failed' }), { code: '42501' });
  assert.deepEqual(await balances(periodId), ['0', '0', '0', '0']);
});
