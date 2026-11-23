import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { loadConfig } from '../src/config.js';
import { assertAppDatabase, id, transaction, type Database } from '../src/db.js';
import { migrate } from '../scripts/migrate.js';
import { createTestDatabasePools, readTestDatabaseScope } from './database-scope.js';
import { finishAiCall, startAiCall } from '../src/ai-metering.js';
import { grantCurrentCalendarCredits, readCalendarQuota } from '../src/calendar-credits.js';
import { assertCalendarCreditEnvironment, parseCalendarCreditArgs } from '../scripts/grant-calendar-credits.js';
import type { AiCallStart, AiQuotaView } from '../src/ai-usage-types.js';

let pool: Pool, owner: Pool, initialized = false;
const tables = 'ai_calendar_credit_grants,website_content_actions,website_version_sources,billing_subscriptions,billing_offer_grants,ai_quota_ledger,ai_quota_periods,ai_model_calls,billing_accounts,analytics_events,analytics_daily,menu_jobs,menu_drafts,website_publish_actions,website_publications,website_model_calls,website_jobs,website_versions,website_agents,asset_upload_intents,asset_references,assets,reservations,reservation_events,reservation_access_tokens,audit_logs,email_outbox,opening_hours,restaurant_members,auth_tokens,auth_sessions,auth_identities,restaurants,users';
before(async () => {
  const scope = readTestDatabaseScope();
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: scope.databaseUrl, MIGRATION_DATABASE_URL: scope.migrationDatabaseUrl,
    APP_ORIGIN: 'https://localhost:5173', EMAIL_MODE: 'disabled', STORAGE_MODE: 'local',
    TOKEN_PEPPER: 'calendar-fixture-pepper-'.repeat(3), CURSOR_SECRET: 'calendar-fixture-cursor-'.repeat(3),
    OUTBOX_ENCRYPTION_KEY: 'c1'.repeat(32) });
  ({ pool, owner } = await createTestDatabasePools({ ...scope, databaseUrl: config.databaseUrl,
    migrationDatabaseUrl: config.migrationDatabaseUrl! }));
  await migrate(owner, 'restaurant_test_app');
  assert.equal((await owner.query("SELECT version FROM schema_migrations WHERE version='013_calendar_test_credits'")).rowCount, 1,
    '主线程须先把 013 纳入正式 migrate 清单');
  assert.equal((await owner.query("SELECT version FROM schema_migrations WHERE version='014_calendar_credit_guards'")).rowCount, 1,
    '主线程须把追加的 014 纳入正式 migrate 清单；禁止改动已执行 013');
  await assertAppDatabase(pool);
  await owner.query(`TRUNCATE ${tables}`);
  initialized = true;
});
beforeEach(async () => { await owner.query(`TRUNCATE ${tables}`); });
after(async () => {
  if (pool) await pool.end();
  if (owner) { try { if (initialized) await owner.query(`TRUNCATE ${tables}`); } finally { await owner.end(); } }
});

async function user(): Promise<string> {
  const uid = id('usr');
  await owner.query(`INSERT INTO users(id,email,email_normalized,locale,status,email_verified_at,terms_version,terms_accepted_at)
    VALUES($1,$2,$2,'en','active',clock_timestamp(),'fixture-v1',clock_timestamp())`, [uid, `${uid}@example.test`]);
  return uid;
}
async function fixture(uid = ''): Promise<{ input: AiCallStart; accountId: string }> {
  uid ||= await user();
  await owner.query('INSERT INTO billing_accounts(id,owner_user_id) VALUES($1,$2) ON CONFLICT(owner_user_id) DO NOTHING', [id('bla'), uid]);
  const accountId = (await owner.query<{ id: string }>('SELECT id FROM billing_accounts WHERE owner_user_id=$1', [uid])).rows[0]!.id;
  const rid = id('rst'), jobId = id('wjb'), runner = randomUUID();
  await owner.query(`INSERT INTO restaurants(id,created_by_user_id,create_idempotency_key,create_request_fingerprint,slug,name,primary_locale)
    VALUES($1,$2,$3,$4,replace(lower($1::text),'_','-'),'自然月积分测试餐厅','en')`, [rid, uid, id('create'), 'a'.repeat(64)]);
  await owner.query("INSERT INTO restaurant_members(id,restaurant_id,user_id,role) VALUES($1,$2,$3,'owner')", [id('mem'), rid, uid]);
  await owner.query(`INSERT INTO website_jobs(id,restaurant_id,requesting_user_id,kind,idempotency_key,request_fingerprint,input,snapshot,
    status,lease_token,lease_expires_at) VALUES($1,$2,$3,'generate',$4,$5,'{}','{}','running',$6,clock_timestamp()+interval '10 minutes')`,
  [jobId, rid, uid, id('job'), 'b'.repeat(64), runner]);
  return { accountId, input: { requestingUserId: uid, restaurantId: rid, websiteJobId: jobId,
    runnerToken: runner, callIndex: 1, model: 'deepseek-flash' } };
}
async function started(input: AiCallStart, createdAt?: string): Promise<string> {
  return transaction(createdAt ? owner : pool, async db => {
    await db.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [input.requestingUserId]);
    await db.query('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE', [input.restaurantId]);
    await db.query('SELECT id FROM restaurant_members WHERE restaurant_id=$1 AND user_id=$2 FOR UPDATE', [input.restaurantId, input.requestingUserId]);
    await db.query('SELECT id FROM website_jobs WHERE id=$1 FOR UPDATE', [input.websiteJobId]);
    if (!createdAt) return startAiCall(db, input);
    // owner 只构造隔离 fixture 的调用时间；不关闭 010 守卫、不调用真实模型。
    const callId = id('aic');
    await db.query(`INSERT INTO ai_model_calls(id,billing_account_id,requesting_user_id,restaurant_id,website_job_id,
      feature,model,call_index,runner_token,request_key,created_at)
      SELECT $1,a.id,$2,$3,$4,'website_generate',$5,$6,$7,$8,$9::timestamptz FROM billing_accounts a WHERE a.owner_user_id=$2`,
    [callId, input.requestingUserId, input.restaurantId, input.websiteJobId, input.model, input.callIndex, input.runnerToken,
      `${input.websiteJobId}:${input.callIndex}`, createdAt]);
    return callId;
  });
}
async function finished(input: AiCallStart, total?: number, failed = false): Promise<void> {
  await transaction(pool, db => finishAiCall(db, { ...input, status: failed ? 'failed' : 'completed', elapsedMs: 3,
    ...(failed ? { errorCode: 'AGENT_CANCELLED' } : {}),
    ...(total === undefined ? {} : { usage: { prompt_tokens: total, completion_tokens: 0, total_tokens: total } }) }));
}
function configured(view: AiQuotaView): Extract<AiQuotaView, { configured: true }> {
  assert.equal(view.configured, true);
  if (!view.configured) throw new Error('测试要求已登记额度');
  return view;
}
async function entries(callId?: string, db: Database = pool) {
  return (await db.query('SELECT * FROM ai_quota_ledger WHERE ($1::text IS NULL OR call_id=$1) ORDER BY id', [callId ?? null])).rows;
}
async function call(callId: string) { return (await pool.query('SELECT * FROM ai_model_calls WHERE id=$1', [callId])).rows[0]; }
async function append(db: Database, periodId: string, accountId: string, uid: string, key: string, type = 'grant',
  callId: string | null = null, granted = '1000000', reserved = '0', consumed = '0', reason = 'DEVELOPMENT_TEST_GRANT') {
  return (await db.query<{ id: string }>(`SELECT apply_ai_quota_entry($1,$2,$3,$4,$5,$6::bigint,$7::bigint,$8::bigint,$9,$10) AS id`,
    [periodId, accountId, callId, type, key, granted, reserved, consumed, reason, uid])).rows[0]!.id;
}
async function period(accountId: string, key: string, offset = 0, kind = 'trial', short = false) {
  return (await owner.query<{ id: string; starts_at: string; ends_at: string; granted_at: string }>(`WITH month AS (
    SELECT date_trunc('month',statement_timestamp() AT TIME ZONE 'UTC')+$4::int*interval '1 month' AS start),
    inserted AS (INSERT INTO ai_quota_periods(id,billing_account_id,kind,starts_at,ends_at,grant_key)
      SELECT $1,$2,$5,start AT TIME ZONE 'UTC',
        (start+CASE WHEN $6 THEN interval '1 day' ELSE interval '1 month' END) AT TIME ZONE 'UTC',$3 FROM month RETURNING *)
    SELECT id,to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS starts_at,
      to_char(ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ends_at,
      to_char((starts_at AT TIME ZONE 'UTC')+interval '1 hour','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS granted_at FROM inserted`,
    [id('aqp'), accountId, key, offset, kind, short])).rows[0]!;
}
async function register(db: Database, periodId: string, accountId: string, uid: string, at?: string): Promise<void> {
  await db.query(`INSERT INTO ai_calendar_credit_grants(period_id,billing_account_id,actor_user_id,granted_at)
    VALUES($1,$2,$3,coalesce($4::timestamptz,clock_timestamp()))`, [periodId, accountId, uid, at ?? null]);
}
async function historicalGrant(input: AiCallStart, accountId: string) {
  const key = id('history'), p = await period(accountId, key, -1);
  await append(owner, p.id, accountId, input.requestingUserId, key);
  // 仅 owner 隔离 fixture 显式提供旧月已发生的时间；正式 CLI 没有历史时间参数。
  await register(owner, p.id, accountId, input.requestingUserId, p.granted_at);
  return p;
}
async function timestamp(at: string, interval: string): Promise<string> {
  return (await owner.query<{ at: string }>(`SELECT to_char(($1::timestamptz+$2::interval) AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`, [at, interval])).rows[0]!.at;
}
async function rollback(run: (db: PoolClient) => Promise<void>): Promise<void> {
  const db = await owner.connect();
  try { await db.query('BEGIN'); await run(db); } finally { await db.query('ROLLBACK'); db.release(); }
}
const empty: AiQuotaView = { configured: false, enforced: false, available_tokens: null, granted_tokens: null,
  reserved_tokens: null, consumed_tokens: null };

test('未登记账户及 null 的额度读取只读、不创建账户、不推断零额度', async () => {
  const uid = await user();
  assert.deepEqual(await readCalendarQuota(pool, null), empty);
  assert.equal((await pool.query('SELECT id FROM billing_accounts WHERE owner_user_id=$1', [uid])).rowCount, 0);
  const { accountId } = await fixture(uid), key = id('undocumented'), p = await period(accountId, key);
  await append(owner, p.id, accountId, uid, key);
  const beforeRows = await entries();
  await transaction(pool, async db => { await db.query('SET TRANSACTION READ ONLY'); assert.deepEqual(await readCalendarQuota(db, accountId), empty); });
  assert.deepEqual(await entries(), beforeRows);
  assert.equal((await pool.query('SELECT * FROM ai_calendar_credit_grants')).rowCount, 0);
});

test('10000 积分真实授额为 1000000 tokens；UTC 自然月、六位微秒、不建套餐或 AI 调用', async () => {
  const uid = await user(), key = `local-test:${uid}:current`;
  const result = configured(await grantCurrentCalendarCredits(owner, uid, 10000, key));
  assert.equal(result.granted_tokens, 1000000); assert.equal(result.available_tokens, 1000000);
  assert.equal(result.reserved_tokens, 0); assert.equal(result.consumed_tokens, 0); assert.equal(result.enforced, false);
  assert.match(result.period.id, /^aqp_[A-Za-z0-9_-]{24}$/);
  assert.match(result.period.starts_at, /^\d{4}-\d{2}-01T00:00:00\.000000Z$/);
  assert.match(result.period.ends_at, /^\d{4}-\d{2}-01T00:00:00\.000000Z$/);
  assert.match(result.period.granted_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  assert.deepEqual([result.period.timezone, result.period.origin, result.period.tokens_per_credit, result.period.auto_renew],
    ['UTC', 'development_test', 100, false]);
  assert.deepEqual((await owner.query(`SELECT starts_at=(date_trunc('month',statement_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS valid,
    ends_at=((date_trunc('month',statement_timestamp() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC') AS valid_end,
    kind FROM ai_quota_periods WHERE id=$1`, [result.period.id])).rows[0], { valid: true, valid_end: true, kind: 'trial' });
  for (const table of ['ai_model_calls', 'billing_subscriptions', 'billing_offer_grants']) assert.equal((await pool.query(`SELECT * FROM ${table}`)).rowCount, 0);
  assert.equal((await entries()).length, 1);
});

test('同 key 并发重试复用周期与授额；不同金额或新 key 不能多发 trial', async () => {
  const uid = await user(), key = id('grant');
  const results = await Promise.all([grantCurrentCalendarCredits(owner, uid, 10000, key), grantCurrentCalendarCredits(owner, uid, 10000, key)]);
  assert.deepEqual(results[0], results[1]);
  await assert.rejects(() => grantCurrentCalendarCredits(owner, uid, 9999, key), /幂等键/);
  await assert.rejects(() => grantCurrentCalendarCredits(owner, uid, 10000, id('different')), /一次 trial/);
  assert.equal((await entries()).length, 1); assert.equal((await pool.query('SELECT * FROM ai_calendar_credit_grants')).rowCount, 1);
});

test('跨用户复用授额 key 拒绝；只消费当前归属账户的新调用', async () => {
  const first = await fixture(), second = await fixture(), key = id('grant');
  await grantCurrentCalendarCredits(owner, first.input.requestingUserId, 10000, key);
  await assert.rejects(() => grantCurrentCalendarCredits(owner, second.input.requestingUserId, 10000, key), /幂等键/);
  await started(second.input); await finished(second.input, 71);
  assert.deepEqual(await readCalendarQuota(pool, second.accountId), empty);
  assert.equal(configured(await readCalendarQuota(pool, first.accountId)).consumed_tokens, 0);
});

test('同账户跨餐厅并发 known 消费锁同一 period，两个真实 total 均不丢失', async () => {
  const first = await fixture(), second = await fixture(first.input.requestingUserId);
  await grantCurrentCalendarCredits(owner, first.input.requestingUserId, 10000, id('grant'));
  const ids = await Promise.all([started(first.input), started(second.input)]);
  await Promise.all([finished(first.input, 17), finished(second.input, 19)]);
  const view = configured(await readCalendarQuota(pool, first.accountId));
  assert.equal(view.consumed_tokens, 36); assert.equal(view.available_tokens, 999964);
  for (const callId of ids) assert.equal((await entries(callId)).length, 1);
});

test('授额拒绝不存在、未验证、停用用户及关闭账户；错误全部回滚', async () => {
  await assert.rejects(() => grantCurrentCalendarCredits(owner, id('usr'), 10000, id('grant')), /活跃用户/);
  const uid = await user();
  await owner.query("UPDATE users SET status='pending_verification',email_verified_at=NULL WHERE id=$1", [uid]);
  await assert.rejects(() => grantCurrentCalendarCredits(owner, uid, 10000, id('grant')), /活跃用户/);
  await owner.query("UPDATE users SET status='active',email_verified_at=clock_timestamp() WHERE id=$1", [uid]);
  const { accountId } = await fixture(uid);
  await owner.query("UPDATE billing_accounts SET status='closed' WHERE id=$1", [accountId]);
  await assert.rejects(() => grantCurrentCalendarCredits(owner, uid, 10000, id('grant')), /活跃归属账户/);
  assert.equal((await pool.query('SELECT * FROM ai_quota_periods')).rowCount, 0);
});

test('授额拒绝小数、零、负数、非安全整数及乘 100 溢出，未产生任何账户', async () => {
  const uid = await user();
  for (const amount of [0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, Math.floor(Number.MAX_SAFE_INTEGER / 100) + 1]) {
    await assert.rejects(() => grantCurrentCalendarCredits(owner, uid, amount, id('grant')), /安全正整数/);
  }
  await assert.rejects(() => grantCurrentCalendarCredits(owner, uid, 10000, 'x'.repeat(129)), /幂等键/);
  assert.equal((await pool.query('SELECT * FROM billing_accounts')).rowCount, 0);
});

test('授额 helper 和 CLI 拒绝 calendar-test: 保留命名空间且不创建任何账户', async () => {
  const uid = await user(), key = `calendar-test:${id('aic')}`;
  await assert.rejects(() => grantCurrentCalendarCredits(owner, uid, 10000, key), /消费专用幂等命名空间/);
  assert.throws(() => parseCalendarCreditArgs(['--user-id', uid, '--credits', '10000', '--key', key]), /消费专用幂等命名空间/);
  assert.equal((await pool.query('SELECT * FROM billing_accounts')).rowCount, 0);
  assert.equal((await pool.query('SELECT * FROM ai_quota_periods')).rowCount, 0); assert.equal((await entries()).length, 0);
});

test('owner 直接写入保留前缀 grant_key 和真实 grant 后，SQL 仍拒绝登记', async () => {
  const { input, accountId } = await fixture(), key = `calendar-test:${id('aic')}`, p = await period(accountId, key);
  await append(owner, p.id, accountId, input.requestingUserId, key);
  await assert.rejects(() => register(owner, p.id, accountId, input.requestingUserId),
    (error: unknown) => (error as { code: string }).code === '23514' && (error as Error).message.includes('消费专用幂等命名空间'));
  assert.equal((await pool.query('SELECT * FROM ai_calendar_credit_grants')).rowCount, 0);
  assert.deepEqual(await readCalendarQuota(pool, accountId), empty);
});

test('consume 遇其他 period 的授额幂等键冲突必须报错，不能静默完成后漏账', async () => {
  const { input, accountId } = await fixture(); await grantCurrentCalendarCredits(owner, input.requestingUserId, 10000, id('grant'));
  const callId = await started(input), other = await fixture(), key = `calendar-test:${callId}`;
  const p = await period(other.accountId, key, 0, 'paid');
  // 未登记旧周期允许 owner 原始账本动作；新消费只忽略同 call 的 consume 冲突。
  await append(owner, p.id, other.accountId, other.input.requestingUserId, key);
  const beforeRows = await entries(), beforeCall = await call(callId);
  await assert.rejects(() => finished(input, 43), { code: '23505' });
  assert.deepEqual(await call(callId), beforeCall); assert.deepEqual(await entries(), beforeRows);
  assert.equal((await entries(callId)).length, 0); assert.equal(configured(await readCalendarQuota(pool, accountId)).consumed_tokens, 0);
});

test('unknown 迟到 known 遇其他非 consume 幂等冲突保留原 unknown，事实与投影原子回滚', async () => {
  const { input, accountId } = await fixture(), view = configured(await grantCurrentCalendarCredits(owner, input.requestingUserId, 10000, id('grant')));
  const callId = await started(input); await finished(input, undefined, true);
  await append(owner, view.period.id, accountId, input.requestingUserId, `calendar-test:${callId}`,
    'adjust', null, '100', '0', '0', 'FIXTURE_ENTRY');
  const beforeRows = await entries(), beforeCall = await call(callId), beforeQuota = await readCalendarQuota(pool, accountId);
  await assert.rejects(() => finished(input, 47), { code: '23505' });
  assert.deepEqual(await call(callId), beforeCall); assert.deepEqual(await entries(), beforeRows);
  assert.deepEqual(await readCalendarQuota(pool, accountId), beforeQuota); assert.equal((await entries(callId)).length, 0);
});

test('expectedMonth 与锁后 PG 当前 UTC 月不一致时回滚，不能自动改授下个月', async () => {
  const uid = await user(), key = id('grant');
  const months = (await owner.query<{ current: string; previous: string }>(`WITH month AS (
    SELECT date_trunc('month',statement_timestamp() AT TIME ZONE 'UTC') AS start)
    SELECT to_char(start,'YYYY-MM') AS current,to_char(start-interval '1 month','YYYY-MM') AS previous FROM month`)).rows[0]!;
  await assert.rejects(() => grantCurrentCalendarCredits(owner, uid, 10000, key, months.previous), /预期授额月份已变化/);
  for (const table of ['billing_accounts', 'ai_quota_periods', 'ai_quota_ledger', 'ai_calendar_credit_grants']) {
    assert.equal((await pool.query(`SELECT * FROM ${table}`)).rowCount, 0);
  }
  for (const invalid of ['2026-00', '2026-13', '2026-1', 'not-a-month']) {
    await assert.rejects(() => grantCurrentCalendarCredits(owner, uid, 10000, key, invalid), /YYYY-MM/);
  }
  const view = configured(await grantCurrentCalendarCredits(owner, uid, 10000, key, months.current));
  assert.equal(view.period.starts_at.slice(0, 7), months.current);
  assert.deepEqual(await grantCurrentCalendarCredits(owner, uid, 10000, key, months.current), view);
  await assert.rejects(() => grantCurrentCalendarCredits(owner, uid, 10000, key, months.previous), /预期授额月份已变化/);
  assert.equal((await entries()).length, 1);
});

test('显式 PG 时间锚点控制 UTC 月和授额半开边界；只读查询不改历史或生成续发', async () => {
  const { input, accountId } = await fixture(), p = await historicalGrant(input, accountId), history = await entries();
  assert.deepEqual(await readCalendarQuota(pool, accountId), empty);
  const beforeGrant = await timestamp(p.granted_at, '-1 microsecond'), beforeEnd = await timestamp(p.ends_at, '-1 microsecond');
  await transaction(pool, async db => {
    await db.query('SET TRANSACTION READ ONLY'); await db.query("SET LOCAL TIME ZONE 'Pacific/Kiritimati'");
    assert.deepEqual(await readCalendarQuota(db, accountId, p.starts_at), empty);
    assert.deepEqual(await readCalendarQuota(db, accountId, beforeGrant), empty);
    const atGrant = configured(await readCalendarQuota(db, accountId, p.granted_at));
    assert.equal(atGrant.period.starts_at, p.starts_at); assert.equal(atGrant.period.ends_at, p.ends_at);
    assert.equal(atGrant.period.granted_at, p.granted_at); assert.equal(atGrant.granted_tokens, 1000000);
    assert.deepEqual(await readCalendarQuota(db, accountId, beforeEnd), atGrant);
    assert.deepEqual(await readCalendarQuota(db, accountId, p.ends_at), empty);
    assert.deepEqual(await readCalendarQuota(db, null, p.granted_at), empty);
  });
  assert.deepEqual(await entries(), history); assert.equal((await pool.query('SELECT * FROM ai_calendar_credit_grants')).rowCount, 1);
});

test('登记后 100 tokens 只消费 1 积分；投影与 consume ledger 严格守恒且仍非收费', async () => {
  const { input, accountId } = await fixture();
  const grant = configured(await grantCurrentCalendarCredits(owner, input.requestingUserId, 10000, id('grant')));
  const callId = await started(input); await finished(input, 100);
  const view = configured(await readCalendarQuota(pool, accountId)), row = (await entries(callId))[0];
  assert.equal(view.available_tokens, 999900); assert.equal(view.consumed_tokens, 100); assert.equal(view.reserved_tokens, 0);
  assert.equal(row.period_id, grant.period.id); assert.equal(row.entry_type, 'consume'); assert.equal(row.delta_consumed_tokens, '100');
  assert.equal(row.delta_granted_tokens, '0'); assert.equal(row.delta_reserved_tokens, '0');
  assert.equal(row.idempotency_key, `calendar-test:${callId}`); assert.equal(row.reason_code, 'DEVELOPMENT_TEST_USAGE');
  assert.match(row.id, /^aql_[A-Za-z0-9_-]{24}$/);
  assert.equal((await call(callId)).chargeable, false); assert.equal((await call(callId)).policy_version, 'observation-v1');
  const sums = (await pool.query(`SELECT sum(delta_granted_tokens)::text AS granted,sum(delta_reserved_tokens)::text AS reserved,
    sum(delta_consumed_tokens)::text AS consumed FROM ai_quota_ledger WHERE period_id=$1`, [grant.period.id])).rows[0];
  assert.deepEqual(sums, { granted: '1000000', reserved: '0', consumed: '100' });
});

test('known 零创建真实零 consume；unknown 和 pending 不虚构零、不预留', async () => {
  const { input, accountId } = await fixture(); await grantCurrentCalendarCredits(owner, input.requestingUserId, 10000, id('grant'));
  const zero = await started(input); await finished(input, 0);
  const unknownInput = { ...input, callIndex: 2 }, unknown = await started(unknownInput); await finished(unknownInput);
  const pending = await started({ ...input, callIndex: 3 });
  assert.equal((await entries(zero)).length, 1); assert.equal((await entries(zero))[0].delta_consumed_tokens, '0');
  assert.equal((await entries(unknown)).length, 0); assert.equal((await entries(pending)).length, 0);
  assert.equal((await call(unknown)).total_tokens, null); assert.equal((await call(pending)).total_tokens, null);
  assert.equal(configured(await readCalendarQuota(pool, accountId)).available_tokens, 1000000);
});

test('failed/取消调用已知用量仍计；撤权与停用账户后迟到已发生用量仍入原周期', async () => {
  const { input, accountId } = await fixture(); const grant = configured(await grantCurrentCalendarCredits(owner, input.requestingUserId, 10000, id('grant')));
  const callId = await started(input);
  await owner.query("UPDATE website_jobs SET status='failed',lease_token=NULL,lease_expires_at=NULL,error_code='AGENT_CANCELLED' WHERE id=$1", [input.websiteJobId]);
  await owner.query("UPDATE restaurant_members SET status='revoked' WHERE restaurant_id=$1", [input.restaurantId]);
  await owner.query("UPDATE users SET status='suspended' WHERE id=$1", [input.requestingUserId]);
  await owner.query("UPDATE billing_accounts SET status='suspended' WHERE id=$1", [accountId]);
  await finished(input, 17, true);
  assert.equal((await entries(callId))[0].delta_consumed_tokens, '17');
  assert.equal((await owner.query('SELECT consumed_tokens FROM ai_quota_periods WHERE id=$1', [grant.period.id])).rows[0].consumed_tokens, '17');
  assert.deepEqual(await readCalendarQuota(pool, accountId), empty);
});

test('重复与并发 finish、known 同值 UPDATE 幂等，仅一笔消费；known 不同总量 DB 拒绝', async () => {
  const { input, accountId } = await fixture(); await grantCurrentCalendarCredits(owner, input.requestingUserId, 10000, id('grant'));
  const callId = await started(input);
  await Promise.all([finished(input, 23), finished(input, 23)]);
  await pool.query("UPDATE ai_model_calls SET usage_status='known' WHERE id=$1", [callId]);
  await finished(input, 999);
  assert.equal((await entries(callId)).length, 1); assert.equal(configured(await readCalendarQuota(pool, accountId)).consumed_tokens, 23);
  await assert.rejects(() => pool.query('UPDATE ai_model_calls SET prompt_tokens=24,total_tokens=24 WHERE id=$1', [callId]), { code: '23514' });
});

test('unknown 并发迟到 known 只补一次，原 status/finished 保持，消费取真实 total', async () => {
  const { input, accountId } = await fixture(); await grantCurrentCalendarCredits(owner, input.requestingUserId, 10000, id('grant'));
  const callId = await started(input); await finished(input, undefined, true); const prior = await call(callId);
  await Promise.all([finished(input, 37), finished(input, 37)]);
  const next = await call(callId);
  for (const field of ['call_status', 'finished_at', 'elapsed_ms', 'error_code']) assert.deepEqual(next[field], prior[field]);
  assert.equal((await entries(callId)).length, 1); assert.equal(configured(await readCalendarQuota(pool, accountId)).consumed_tokens, 37);
});

test('授额前已知及 pending 调用不追扣，旧事实逐字段保持且仅新调用消费', async () => {
  const { input, accountId } = await fixture(), oldKnown = await started(input); await finished(input, 41);
  const pendingInput = { ...input, callIndex: 2 }, oldPending = await started(pendingInput), old = await call(oldKnown);
  await grantCurrentCalendarCredits(owner, input.requestingUserId, 10000, id('grant'));
  await finished(pendingInput, 53);
  // known 同值重放也不能让授额前的调用进入消费。
  await pool.query("UPDATE ai_model_calls SET usage_status='known' WHERE id=$1", [oldKnown]);
  assert.deepEqual(await call(oldKnown), old); assert.equal((await entries(oldKnown)).length, 0); assert.equal((await entries(oldPending)).length, 0);
  const next = { ...input, callIndex: 3 }, nextId = await started(next); await finished(next, 7);
  assert.equal((await entries(nextId)).length, 1); assert.equal(configured(await readCalendarQuota(pool, accountId)).consumed_tokens, 7);
});

test('余额允许负数且小于 1 积分的真实消费不取整、不触发硬 quota', async () => {
  const { input, accountId } = await fixture(); await grantCurrentCalendarCredits(owner, input.requestingUserId, 1, id('grant'));
  await started(input); await finished(input, 101);
  const next = { ...input, callIndex: 2 }; await started(next); await finished(next, 1);
  const view = configured(await readCalendarQuota(pool, accountId));
  assert.equal(view.granted_tokens, 100); assert.equal(view.consumed_tokens, 102); assert.equal(view.available_tokens, -2); assert.equal(view.enforced, false);
});

test('MAX_SAFE 边界消费与负余额精确；超出原 numeric 上界原子回滚 known 状态和 ledger', async () => {
  const { input, accountId } = await fixture(), amount = Math.floor(Number.MAX_SAFE_INTEGER / 100);
  await grantCurrentCalendarCredits(owner, input.requestingUserId, amount, id('grant'));
  await started(input); await finished(input, Number.MAX_SAFE_INTEGER);
  const view = configured(await readCalendarQuota(pool, accountId));
  assert.equal(view.granted_tokens, Number(BigInt(amount) * 100n)); assert.equal(view.consumed_tokens, Number.MAX_SAFE_INTEGER);
  assert.equal(view.available_tokens, -91);
  const next = { ...input, callIndex: 2 }, nextId = await started(next);
  await assert.rejects(() => finished(next, 1), { code: '23514' });
  assert.equal((await call(nextId)).usage_status, 'pending'); assert.equal((await entries(nextId)).length, 0);
});

test('旧月 unknown 月后补 known 消费原周期；读取本月为未配置、历史不删除且不自动续发', async () => {
  const { input, accountId } = await fixture(), p = await historicalGrant(input, accountId);
  const callId = await started(input, await timestamp(p.granted_at, '1 second'));
  await finished(input); assert.equal((await entries(callId)).length, 0);
  await Promise.all([finished(input, 77), finished(input, 77)]);
  await pool.query("UPDATE ai_model_calls SET usage_status='known' WHERE id=$1", [callId]);
  assert.equal((await entries(callId))[0].period_id, p.id); assert.equal((await entries(callId)).length, 1);
  assert.equal((await entries(callId))[0].delta_consumed_tokens, '77');
  const history = await entries(); assert.deepEqual(await readCalendarQuota(pool, accountId), empty); assert.deepEqual(await entries(), history);
  assert.equal((await pool.query('SELECT * FROM ai_calendar_credit_grants')).rowCount, 1);
  assert.equal((await pool.query("SELECT * FROM ai_quota_ledger WHERE entry_type='expire'")).rowCount, 0);
  await assert.rejects(() => grantCurrentCalendarCredits(owner, input.requestingUserId, 10000, id('nextmonth')), /一次 trial/);
});

test('调用 created_at 半开边界含 granted_at、排除授额前微秒与月末，不按 finish 月归属', async () => {
  const { input, accountId } = await fixture(), p = await historicalGrant(input, accountId);
  const cases = [{ at: p.granted_at, consume: true }, { at: await timestamp(p.granted_at, '-1 microsecond'), consume: false },
    { at: await timestamp(p.ends_at, '-1 microsecond'), consume: true }, { at: p.ends_at, consume: false },
    { at: p.starts_at, consume: false }];
  for (let index = 0; index < cases.length; index++) {
    const item = cases[index]!, current = { ...input, callIndex: index + 1 }, callId = await started(current, item.at);
    await finished(current, 1); assert.equal((await entries(callId)).length, item.consume ? 1 : 0);
  }
  assert.equal((await pool.query('SELECT consumed_tokens FROM ai_quota_periods WHERE id=$1', [p.id])).rows[0].consumed_tokens, '2');
});

test('旧 legacy_import known 即使映射月份一致也不消费，重放保持历史非收费', async () => {
  const { input, accountId } = await fixture(), p = await historicalGrant(input, accountId);
  await rollback(async db => {
    // 仅回滚事务重演 010 导入前的安装顺序；新消费守卫始终启用。
    await db.query('ALTER TABLE ai_model_calls DISABLE TRIGGER ai_model_call_guard');
    const callId = id('aic'), at = await timestamp(p.granted_at, '1 second');
    await db.query(`INSERT INTO ai_model_calls(id,billing_account_id,requesting_user_id,restaurant_id,website_job_id,
      feature,model,call_index,runner_token,request_key,origin,legacy_source_key,call_status,usage_status,
      prompt_tokens,completion_tokens,total_tokens,elapsed_ms,created_at,finished_at,received_at)
      VALUES($1,$2,$3,$4,$5,'website_generate','legacy-unknown',1,$6,$7,'legacy_import',$8,'completed','known',
        83,0,83,1,$9::timestamptz,$9::timestamptz,$9::timestamptz)`,
    [callId, accountId, input.requestingUserId, input.restaurantId, input.websiteJobId, input.runnerToken,
      `${input.websiteJobId}:1`, `website_model_calls:${input.websiteJobId}:1`, at]);
    await db.query('ALTER TABLE ai_model_calls ENABLE TRIGGER ai_model_call_guard');
    const original = (await db.query('SELECT * FROM ai_model_calls WHERE id=$1', [callId])).rows[0];
    await db.query("UPDATE ai_model_calls SET usage_status='known' WHERE id=$1", [callId]);
    assert.deepEqual((await db.query('SELECT * FROM ai_model_calls WHERE id=$1', [callId])).rows[0], original);
    assert.equal((await entries(callId, db)).length, 0); assert.equal(original.chargeable, false);
  });
});

test('自然月读取不受 PG 会话时区影响；显式授额仍按 UTC 当前月', async () => {
  const { input, accountId } = await fixture(); const view = await grantCurrentCalendarCredits(owner, input.requestingUserId, 10000, id('grant'));
  await transaction(pool, async db => {
    await db.query("SET LOCAL TIME ZONE 'Pacific/Kiritimati'"); assert.deepEqual(await readCalendarQuota(db, accountId), view);
    await db.query("SET LOCAL TIME ZONE 'America/Los_Angeles'"); assert.deepEqual(await readCalendarQuota(db, accountId), view);
  });
});

test('登记拒绝 paid、短周期、无真实 grant、grant 金额不是完整积分及半开范围外 timestamp', async () => {
  for (const mode of ['paid', 'short', 'missing', 'fraction', 'before', 'end', 'future'] as const) {
    const { input, accountId } = await fixture(), key = id('invalid');
    const p = await period(accountId, key, mode === 'future' ? 1 : -1, mode === 'paid' ? 'paid' : 'trial', mode === 'short');
    if (mode !== 'missing') await append(owner, p.id, accountId, input.requestingUserId, key, 'grant', null, mode === 'fraction' ? '101' : '1000000');
    const at = mode === 'before' ? await timestamp(p.starts_at, '-1 microsecond') : mode === 'end' ? p.ends_at : p.granted_at;
    await assert.rejects(() => register(owner, p.id, accountId, input.requestingUserId, at), { code: '23514' });
  }
  assert.equal((await pool.query('SELECT * FROM ai_calendar_credit_grants')).rowCount, 0);
});

test('登记不可改变周期、时区、origin、100 换算、auto_renew 和 actor；跨用户及篡改投影拒绝', async () => {
  const { input, accountId } = await fixture(), other = await fixture();
  const view = configured(await grantCurrentCalendarCredits(owner, input.requestingUserId, 10000, id('grant')));
  for (const [column, value] of Object.entries({ period_id: id('aqp'), billing_account_id: other.accountId,
    timezone: 'Asia/Shanghai', tokens_per_credit: 1, origin: 'paid', auto_renew: true, actor_user_id: other.input.requestingUserId,
    granted_at: view.period.starts_at })) {
    await assert.rejects(() => owner.query(`UPDATE ai_calendar_credit_grants SET ${column}=$2 WHERE period_id=$1`, [view.period.id, value]), { code: '23514' });
  }
  await assert.rejects(() => owner.query('DELETE FROM ai_calendar_credit_grants WHERE period_id=$1', [view.period.id]), { code: '23514' });
  await assert.rejects(() => register(owner, view.period.id, accountId, other.input.requestingUserId), { code: '23514' });
  await assert.rejects(() => owner.query('UPDATE ai_quota_periods SET consumed_tokens=1 WHERE id=$1', [view.period.id]), { code: '23514' });
  await assert.rejects(() => owner.query("UPDATE ai_quota_periods SET ends_at=ends_at+interval '1 day' WHERE id=$1", [view.period.id]), { code: '23514' });
});

test('伪造 consume 的总量、reason、key、actor、period/call 归属拒绝；直接重复依然唯一', async () => {
  const { input, accountId } = await fixture(), other = await fixture();
  const view = configured(await grantCurrentCalendarCredits(owner, input.requestingUserId, 10000, id('grant')));
  const callId = await started(input); await finished(input, 29);
  const insert = async (db: Database, changes: Record<string, unknown> = {}) => {
    const fields = { id: id('aql'), period_id: view.period.id, billing_account_id: accountId, call_id: callId,
      entry_type: 'consume', idempotency_key: `calendar-test:${callId}`, delta_granted_tokens: 0, delta_reserved_tokens: 0,
      delta_consumed_tokens: 29, reason_code: 'DEVELOPMENT_TEST_USAGE', actor_user_id: input.requestingUserId, ...changes };
    await db.query(`INSERT INTO ai_quota_ledger(${Object.keys(fields).join(',')}) VALUES(${Object.keys(fields).map((_, index) => `$${index + 1}`).join(',')})`, Object.values(fields));
  };
  for (const changes of [{ delta_consumed_tokens: 30 }, { delta_granted_tokens: 1 }, { delta_reserved_tokens: 1 },
    { reason_code: 'FORGED_USAGE' }, { idempotency_key: id('fake') }, { actor_user_id: other.input.requestingUserId },
    { billing_account_id: other.accountId }, { period_id: id('aqp') }, { call_id: null }]) {
    await assert.rejects(() => insert(owner, changes), { code: '23514' });
  }
  await assert.rejects(() => insert(owner), { code: '23505' });
  assert.equal((await entries(callId)).length, 1);
});

test('登记周期在调用消费前就禁止 reserve/settle/release，真实 known 仍可直接消费', async () => {
  const { input, accountId } = await fixture(); const view = configured(await grantCurrentCalendarCredits(owner, input.requestingUserId, 10000, id('grant')));
  const consumed = await started(input); await finished(input, 5);
  await assert.rejects(() => append(owner, view.period.id, accountId, input.requestingUserId, id('reserve'), 'reserve', consumed, '0', '1', '0', 'FIXTURE_ENTRY'), { code: '23514' });
  const pending = { ...input, callIndex: 2 }, callId = await started(pending);
  for (const action of ['reserve', 'settle', 'release']) {
    await assert.rejects(() => append(owner, view.period.id, accountId, input.requestingUserId, id(action), action, callId,
      '0', action === 'reserve' ? '10' : '-10', action === 'settle' ? '5' : '0', 'FIXTURE_ENTRY'),
    (error: unknown) => (error as { code: string; message: string }).code === '23514' &&
      (error as Error).message.includes('已登记 development_test'));
  }
  assert.equal((await call(callId)).usage_status, 'pending'); assert.equal((await entries(callId)).length, 0);
  await finished(pending, 5); assert.equal((await entries(callId)).length, 1);
  assert.equal(configured(await readCalendarQuota(pool, accountId)).consumed_tokens, 10);
  const bounds = (await owner.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid='ai_quota_ledger'::regclass AND contype='c'`)).rows;
  for (const field of ['delta_granted_tokens', 'delta_reserved_tokens', 'delta_consumed_tokens']) {
    assert.ok(bounds.some(row => row.definition.includes(field) && row.definition.includes('9007199254740991') && !row.definition.includes('entry_type')));
  }
});

test('登记周期混合动作在隐式 call FK 等锁前拒绝，另一事务持有 call 行锁不成环', async () => {
  const { input, accountId } = await fixture(), view = configured(await grantCurrentCalendarCredits(owner, input.requestingUserId, 10000, id('grant')));
  const callId = await started(input);
  await transaction(pool, async db => {
    await db.query('SELECT id FROM ai_model_calls WHERE id=$1 FOR UPDATE', [callId]);
    for (const action of ['reserve', 'settle', 'release']) {
      await rollback(async writer => {
        await writer.query("SET LOCAL lock_timeout='500ms'");
        await assert.rejects(() => append(writer, view.period.id, accountId, input.requestingUserId, id(action), action, callId,
          '0', action === 'reserve' ? '1' : '-1', action === 'settle' ? '1' : '0', 'FIXTURE_ENTRY'),
        (error: unknown) => (error as { code: string }).code === '23514' && (error as Error).message.includes('已登记 development_test'));
      });
    }
  });
  await finished(input, 3); assert.equal((await entries(callId)).length, 1);
});

test('未登记普通 trial/paid 保留原 reserve/settle/release、预留不足及精确关闭约束', async () => {
  for (const kind of ['trial', 'paid']) {
    const { input, accountId } = await fixture(), key = id('ordinary'), p = await period(accountId, key, 0, kind);
    await append(owner, p.id, accountId, input.requestingUserId, key);
    const callId = await started(input);
    await assert.rejects(() => append(owner, p.id, accountId, input.requestingUserId, id('reserve'), 'reserve', callId,
      '0', '1000001', '0', 'FIXTURE_ENTRY'), { code: '23514' });
    await append(owner, p.id, accountId, input.requestingUserId, id('reserve'), 'reserve', callId, '0', '10', '0', 'FIXTURE_ENTRY');
    await finished(input, 5);
    await assert.rejects(() => append(owner, p.id, accountId, input.requestingUserId, id('settle'), 'settle', callId,
      '0', '-9', '5', 'FIXTURE_ENTRY'), { code: '23514' });
    await append(owner, p.id, accountId, input.requestingUserId, id('settle'), 'settle', callId, '0', '-10', '5', 'FIXTURE_ENTRY');
    await assert.rejects(() => append(owner, p.id, accountId, input.requestingUserId, id('release'), 'release', callId,
      '0', '-10', '0', 'FIXTURE_ENTRY'), { code: '23514' });
    const second = { ...input, callIndex: 2 }, secondId = await started(second);
    await append(owner, p.id, accountId, input.requestingUserId, id('reserve'), 'reserve', secondId, '0', '10', '0', 'FIXTURE_ENTRY');
    await append(owner, p.id, accountId, input.requestingUserId, id('release'), 'release', secondId, '0', '-10', '0', 'FIXTURE_ENTRY');
    assert.equal((await pool.query("SELECT * FROM ai_quota_ledger WHERE entry_type='consume' AND period_id=$1", [p.id])).rowCount, 0);
    assert.deepEqual((await pool.query('SELECT reserved_tokens,consumed_tokens,available_tokens FROM ai_quota_periods WHERE id=$1', [p.id])).rows[0],
      { reserved_tokens: '0', consumed_tokens: '5', available_tokens: '999995' });
    assert.deepEqual(await readCalendarQuota(pool, accountId), empty);
  }
});

test('未登记的旧 trial/paid 账户与真实 known 调用保持观察模式，不锁 quota 行或产生消费', async () => {
  const { input, accountId } = await fixture(), key = id('legacy'), p = await period(accountId, key, 0, 'paid');
  await append(owner, p.id, accountId, input.requestingUserId, key);
  await started(input); const beforeRows = await entries();
  await transaction(pool, async db => {
    await finishAiCall(db, { ...input, status: 'completed', elapsedMs: 1, usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } });
    assert.equal((await db.query(`SELECT relation FROM pg_locks WHERE pid=pg_backend_pid()
      AND relation IN ('ai_quota_periods'::regclass,'ai_quota_ledger'::regclass)`)).rowCount, 0);
  });
  assert.deepEqual(await entries(), beforeRows); assert.deepEqual(await readCalendarQuota(pool, accountId), empty);
});

test('app 仅 SELECT 登记表、无列写入或 owner 函数 EXECUTE，PUBLIC 同样撤销', async () => {
  const { input, accountId } = await fixture(), view = configured(await grantCurrentCalendarCredits(owner, input.requestingUserId, 10000, id('grant')));
  const functions = ['guard_ai_calendar_credit_grant()', 'guard_ai_calendar_consume()', 'book_ai_calendar_consumption()',
    'apply_ai_quota_entry(text,text,text,text,text,bigint,bigint,bigint,text,text)'];
  const roles = (await owner.query("SELECT rolname FROM pg_roles WHERE rolname IN ('restaurant_app','restaurant_test_app')")).rows;
  for (const { rolname } of roles) {
    const permissions = (await owner.query(`SELECT has_table_privilege($1,'ai_calendar_credit_grants','SELECT') AS read,
      has_table_privilege($1,'ai_calendar_credit_grants','INSERT,UPDATE,DELETE,TRUNCATE') AS write`, [rolname])).rows[0];
    assert.deepEqual(permissions, { read: true, write: false });
    for (const column of ['period_id', 'billing_account_id', 'timezone', 'tokens_per_credit', 'origin', 'actor_user_id', 'granted_at', 'auto_renew']) {
      assert.equal((await owner.query("SELECT has_column_privilege($1,'ai_calendar_credit_grants',$2,'INSERT,UPDATE') AS allowed", [rolname, column])).rows[0].allowed, false);
    }
    for (const signature of functions) assert.equal((await owner.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [rolname, signature])).rows[0].allowed, false);
  }
  for (const signature of functions) assert.equal((await owner.query(`SELECT EXISTS(SELECT 1 FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS allowed`, [signature])).rows[0].allowed, false);
  await assert.rejects(() => register(pool, view.period.id, accountId, input.requestingUserId), { code: '42501' });
  await assert.rejects(() => pool.query('UPDATE ai_calendar_credit_grants SET auto_renew=false'), { code: '42501' });
  await assert.rejects(() => pool.query('SELECT book_ai_calendar_consumption()'), { code: '42501' });
  await assert.rejects(() => append(pool, view.period.id, accountId, input.requestingUserId, id('denied')), { code: '42501' });
  await assert.rejects(() => grantCurrentCalendarCredits(pool, input.requestingUserId, 10000, id('denied')), { code: '42501' });
});

test('授额与消费锁顺序不等旧 call；FK KEY SHARE 兼容授额 user/account 非键锁', async () => {
  const { input, accountId } = await fixture(), key = id('grant'), p = await period(accountId, key);
  const callId = await started(input);
  await transaction(pool, async db => {
    await db.query('SELECT id FROM ai_model_calls WHERE id=$1 FOR UPDATE', [callId]);
    await grantCurrentCalendarCredits(owner, input.requestingUserId, 10000, key).then(
      () => assert.fail('未登记的既有 key 不得重用'), error => assert.match(error.message, /幂等键/));
  });
  await append(owner, p.id, accountId, input.requestingUserId, key); await register(owner, p.id, accountId, input.requestingUserId);
  const next = { ...input, callIndex: 2 }, nextId = await started(next);
  await transaction(owner, async db => {
    await db.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [input.requestingUserId]);
    await db.query('SELECT id FROM billing_accounts WHERE id=$1 FOR NO KEY UPDATE', [accountId]);
    await finished(next, 1);
  });
  assert.equal((await entries(nextId)).length, 1);
});

test('CLI 默认 dry-run、仅 10000 积分与显式稳定 key；生产、测试库、远程和错配端点禁止', async () => {
  const uid = id('usr'), args = ['--user-id', uid, '--credits', '10000', '--key', `local-test:${uid}:month`];
  assert.deepEqual(parseCalendarCreditArgs(args), { userId: uid, credits: 10000, key: args[5], apply: false });
  assert.equal(parseCalendarCreditArgs([...args, '--apply']).apply, true);
  for (const invalid of [[], [...args, '--apply', '--apply'], [...args, '--unknown'], ['--user-id', uid, '--credits', '10000'],
    ['--user-id', uid, '--credits', '9999', '--key', 'key'], [...args, '--credits', '10000']]) assert.throws(() => parseCalendarCreditArgs(invalid));
  // 连接均为合成测试字符串，绝不读取或打印真实连接配置。
  const local = { nodeEnv: 'development' as const,
    databaseUrl: 'postgres://restaurant_app:fixture@127.0.0.1:55439/restaurant_dev',
    migrationDatabaseUrl: 'postgres://restaurant_owner:fixture@127.0.0.1:55439/restaurant_dev' };
  assert.doesNotThrow(() => assertCalendarCreditEnvironment(local));
  for (const changes of [{ nodeEnv: 'production' as const }, { nodeEnv: 'test' as const }, { migrationDatabaseUrl: undefined },
    { databaseUrl: local.databaseUrl.replace('restaurant_dev', 'restaurant_test') },
    { databaseUrl: local.databaseUrl.replace('127.0.0.1', 'example.test') },
    { migrationDatabaseUrl: local.migrationDatabaseUrl.replace('127.0.0.1', 'localhost') },
    { databaseUrl: local.databaseUrl + '?options=ignored' }, { databaseUrl: local.databaseUrl.replace('55439', '55440') }]) {
    assert.throws(() => assertCalendarCreditEnvironment({ ...local, ...changes }));
  }
  await rollback(async db => { await db.query('SET TRANSACTION READ ONLY'); assert.deepEqual(await readCalendarQuota(db, null), empty); });
});
