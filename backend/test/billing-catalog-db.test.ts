import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { assertAppDatabase, id } from '../src/db.js';
import { migrate } from '../scripts/migrate.js';

const columns = {
  billing_plan_versions: ['id', 'code', 'version', 'name', 'status', 'ai_mode', 'monthly_credits', 'tokens_per_credit', 'allocation_status', 'grant_schedule', 'hosted_site_limit', 'created_at'],
  billing_price_versions: ['id', 'plan_version_id', 'interval', 'amount_minor', 'currency', 'offer_type', 'status', 'tax_policy', 'seed_duration_policy', 'seed_cycles', 'seed_terms', 'created_at'],
  billing_credit_pack_versions: ['id', 'name', 'credits', 'tokens_per_credit', 'amount_minor', 'currency', 'validity_days', 'validity_policy', 'tax_policy', 'status', 'created_at'],
  billing_offer_grants: ['id', 'billing_account_id', 'price_version_id', 'status', 'valid_from', 'valid_end', 'approved_by', 'granted_at', 'revision', 'created_at'],
  billing_subscriptions: ['id', 'billing_account_id', 'plan_version_id', 'price_version_id', 'offer_grant_id', 'provider', 'provider_subscription_id', 'status', 'period_start', 'period_end', 'paid_through', 'cancel_requested_at', 'revision', 'created_at'],
} as const;
type CatalogTable = keyof typeof columns;
const catalogTables = Object.keys(columns) as CatalogTable[];
// 不截断三个目录表；所有目录夹具和状态变更仅存在于最终回滚的事务。
const businessTables = 'ai_calendar_credit_grants,website_content_actions,website_version_sources,billing_subscriptions,billing_offer_grants,ai_quota_ledger,ai_quota_periods,ai_model_calls,billing_accounts,analytics_events,analytics_daily,menu_jobs,menu_drafts,website_publish_actions,website_publications,website_model_calls,website_jobs,website_versions,website_agents,asset_upload_intents,asset_references,assets,reservations,reservation_events,reservation_access_tokens,audit_logs,email_outbox,opening_hours,restaurant_members,auth_tokens,auth_sessions,auth_identities,restaurants,users';
const original010Checksum = '73461c93420bf4cc1af48013b647c27a6ad226fdf396be9a283acac263ae895e';
const seedPlans = ['bpv_000000000000000000000001', 'bpv_000000000000000000000002', 'bpv_000000000000000000000003'];
const seedPrices = Array.from({ length: 7 }, (_, index) => `bpr_${String(index + 1).padStart(24, '0')}`);
let pool: Pool, owner: Pool, ready = false, version = 100;
let initialPlans: unknown[], initialPrices: unknown[];

import { createTestDatabasePools, readTestDatabaseScope } from './database-scope.js';

before(async () => {
  // 先校验两个 URL，再建立连接；不加载 .env、应用配置或任何真实支付/模型密钥。
  const scope = readTestDatabaseScope();
  ({ pool, owner } = await createTestDatabasePools(scope));
  await migrate(owner, 'restaurant_test_app');
  assert.equal((await owner.query("SELECT version FROM schema_migrations WHERE version='011_billing_catalog'")).rowCount, 1,
    '主线程须先将 011_billing_catalog 接入迁移清单');
  await assertAppDatabase(pool);
  await owner.query(`TRUNCATE ${businessTables}`);
  initialPlans = (await pool.query('SELECT * FROM billing_plan_versions ORDER BY id')).rows;
  initialPrices = (await pool.query('SELECT * FROM billing_price_versions ORDER BY id')).rows;
  ready = true;
});
beforeEach(async () => { if (ready) await owner.query(`TRUNCATE ${businessTables}`); });
after(async () => {
  try {
    if (ready) {
      assert.deepEqual((await pool.query('SELECT * FROM billing_plan_versions ORDER BY id')).rows, initialPlans);
      assert.deepEqual((await pool.query('SELECT * FROM billing_price_versions ORDER BY id')).rows, initialPrices);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM billing_credit_pack_versions')).rows[0].n, 0);
      await owner.query(`TRUNCATE ${businessTables}`);
    }
  } finally {
    if (pool) await pool.end();
    if (owner) await owner.end();
  }
});

async function rollback(run: (db: PoolClient) => Promise<void>): Promise<void> {
  const db = await owner.connect();
  try { await db.query('BEGIN'); await run(db); }
  finally { try { await db.query('ROLLBACK'); } finally { db.release(); } }
}
async function rejected(db: PoolClient, run: () => Promise<unknown>, code = '23514'): Promise<void> {
  await db.query('SAVEPOINT rejected_billing_write');
  try { await assert.rejects(run, (error: unknown) => (error as { code?: string }).code === code); }
  finally { await db.query('ROLLBACK TO SAVEPOINT rejected_billing_write'); await db.query('RELEASE SAVEPOINT rejected_billing_write'); }
}
async function insert(db: PoolClient, table: CatalogTable, fields: Record<string, unknown>): Promise<string> {
  const names = Object.keys(fields);
  for (const name of names) assert.ok((columns[table] as readonly string[]).includes(name), '夹具列必须在固定白名单');
  await db.query(`INSERT INTO ${table}(${names.join(',')}) VALUES(${names.map((_, index) => `$${index + 1}`).join(',')})`, Object.values(fields));
  return fields.id as string;
}
async function account(db: PoolClient): Promise<{ userId: string; accountId: string }> {
  const userId = id('usr'), accountId = id('bla');
  await db.query(`INSERT INTO users(id,email,email_normalized,locale,status,email_verified_at,terms_version,terms_accepted_at)
    VALUES($1,$2,$2,'en','active',clock_timestamp(),'fixture-v1',clock_timestamp())`, [userId, `${userId}@example.test`]);
  await db.query('INSERT INTO billing_accounts(id,owner_user_id) VALUES($1,$2)', [accountId, userId]);
  return { userId, accountId };
}
async function plan(db: PoolClient, overrides: Record<string, unknown> = {}): Promise<string> {
  return insert(db, 'billing_plan_versions', { id: id('bpv'), code: 'unlimited', version: ++version, name: '目录测试套餐',
    ai_mode: 'unlimited', monthly_credits: null, allocation_status: 'confirmed', grant_schedule: 'service_month', hosted_site_limit: 1, ...overrides });
}
async function price(db: PoolClient, planId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  return insert(db, 'billing_price_versions', { id: id('bpr'), plan_version_id: planId, interval: 'month', amount_minor: 100,
    tax_policy: 'exclusive', ...overrides });
}
async function pack(db: PoolClient, overrides: Record<string, unknown> = {}): Promise<string> {
  // 纯回滚夹具的金额，不是正式积分包售价。
  return insert(db, 'billing_credit_pack_versions', { id: id('bcp'), name: '回滚测试积分包', credits: 10, amount_minor: 100, ...overrides });
}
async function offer(db: PoolClient, accountId: string, priceId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  return insert(db, 'billing_offer_grants', { id: id('bog'), billing_account_id: accountId, price_version_id: priceId,
    valid_from: new Date(Date.now() - 60_000), valid_end: new Date(Date.now() + 86_400_000), ...overrides });
}
async function subscription(db: PoolClient, accountId: string, planId: string, priceId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  return insert(db, 'billing_subscriptions', { id: id('bsu'), billing_account_id: accountId, plan_version_id: planId,
    price_version_id: priceId, ...overrides });
}
async function activeSeed(db: PoolClient, duration: 'cycles' | 'lifetime' = 'cycles') {
  const planId = await plan(db);
  const standardId = await price(db, planId, { status: 'active' });
  await db.query("UPDATE billing_plan_versions SET status='active' WHERE id=$1", [planId]);
  const priceId = await price(db, planId, { offer_type: 'seed', status: 'active', seed_duration_policy: duration,
    seed_cycles: duration === 'cycles' ? 12 : null, seed_terms: '仅限回滚夹具的明确种子条款' });
  return { planId, standardId, priceId };
}

test('011 精确五表列名、固定三套餐七草稿价及空业务表，无自动赠送', async () => {
  for (const table of catalogTables) {
    const actual = (await owner.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table])).rows.map(row => row.column_name);
    assert.deepEqual(actual, columns[table]);
  }
  const plans = (await pool.query(`SELECT id,code,name,version,status,ai_mode,monthly_credits,tokens_per_credit,
    allocation_status,grant_schedule,hosted_site_limit FROM billing_plan_versions ORDER BY id`)).rows;
  assert.equal(plans.length, 3);
  assert.deepEqual(plans.map(row => [row.id, row.code, row.name, row.ai_mode, row.monthly_credits]), [
    [seedPlans[0], 'maintain', 'Maintain', 'limited', '1000'],
    [seedPlans[1], 'build', 'Build', 'limited', '10000'],
    [seedPlans[2], 'unlimited', 'Unlimited', 'unlimited', null],
  ]);
  for (const row of plans) {
    assert.match(row.id, /^bpv_[A-Za-z0-9_-]{24}$/); assert.equal(row.version, 1); assert.equal(row.status, 'draft');
    assert.equal(row.tokens_per_credit, 100); assert.equal(row.allocation_status, 'proposed');
    assert.equal(row.grant_schedule, 'unconfirmed'); assert.equal(row.hosted_site_limit, null);
  }
  const prices = (await pool.query(`SELECT p.id,v.code,p.interval,p.amount_minor,p.currency,p.offer_type,p.status,
    p.tax_policy,p.seed_duration_policy,p.seed_cycles,p.seed_terms FROM billing_price_versions p
    JOIN billing_plan_versions v ON v.id=p.plan_version_id ORDER BY p.id`)).rows;
  assert.equal(prices.length, 7); assert.deepEqual(prices.map(row => row.id), seedPrices);
  assert.deepEqual(prices.map(row => [row.code, row.interval, row.offer_type, row.amount_minor]), [
    ['maintain', 'month', 'standard', '5900'], ['maintain', 'year', 'standard', '41300'],
    ['build', 'month', 'standard', '9900'], ['build', 'year', 'standard', '69300'],
    ['unlimited', 'month', 'standard', '19900'], ['unlimited', 'year', 'standard', '139300'],
    ['unlimited', 'month', 'seed', '3990'],
  ]);
  for (const row of prices) {
    assert.match(row.id, /^bpr_[A-Za-z0-9_-]{24}$/); assert.equal(row.currency, 'USD'); assert.equal(row.status, 'draft');
    assert.equal(row.tax_policy, 'unconfirmed'); assert.equal(row.seed_duration_policy, 'unconfirmed');
    assert.equal(row.seed_cycles, null); assert.equal(row.seed_terms, null);
  }
  for (const table of ['billing_credit_pack_versions', 'billing_offer_grants', 'billing_subscriptions', 'billing_accounts', 'ai_quota_periods', 'ai_quota_ledger']) {
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
  }
});

test('010 原始 checksum 未改；011 完整清单迁移幂等，不重种目录', async () => {
  for (const [name, expected] of [['010_ai_metering', original010Checksum], ['011_billing_catalog', undefined]] as const) {
    const sql = await readFile(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (expected) assert.equal(checksum, expected, '010 历史迁移必须保持原始字节');
    assert.equal((await owner.query('SELECT checksum FROM schema_migrations WHERE version=$1', [name])).rows[0].checksum, checksum);
  }
  const history = (await owner.query('SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version')).rows;
  await migrate(owner, 'restaurant_test_app');
  assert.deepEqual((await owner.query('SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version')).rows, history);
  assert.deepEqual((await pool.query('SELECT * FROM billing_plan_versions ORDER BY id')).rows, initialPlans);
  assert.deepEqual((await pool.query('SELECT * FROM billing_price_versions ORDER BY id')).rows, initialPrices);
});

test('套餐 NULL 模式、积分比例、安全整数与唯一版本均由真实 DB 约束', async () => {
  await rollback(async db => {
    for (const overrides of [
      { ai_mode: 'limited', monthly_credits: null }, { ai_mode: 'unlimited', monthly_credits: 1000 },
      { ai_mode: 'limited', monthly_credits: 0 }, { ai_mode: 'limited', monthly_credits: -1 },
      { ai_mode: 'limited', monthly_credits: '9007199254740992' }, { tokens_per_credit: 99 },
      { hosted_site_limit: -1 }, { allocation_status: 'unknown' }, { grant_schedule: 'yearly' },
      { code: 'other' }, { version: 0 }, { id: 'bpv_short' }, { name: ' ' },
    ]) await rejected(db, () => plan(db, overrides));
    const planId = await plan(db, { ai_mode: 'limited', monthly_credits: 1000, hosted_site_limit: null });
    const row = (await db.query('SELECT version,monthly_credits,hosted_site_limit FROM billing_plan_versions WHERE id=$1', [planId])).rows[0];
    assert.equal(row.monthly_credits, '1000'); assert.equal(row.hosted_site_limit, null);
    await rejected(db, () => plan(db, { version: row.version }), '23505');
    await plan(db, { ai_mode: 'limited', monthly_credits: '9007199254740991', hosted_site_limit: 0 });
  });
});

test('全部激活门槛：未知限额/积分/年发/税/种子期限都不能激活，完整新版本可以', async () => {
  await rollback(async db => {
    for (const planId of seedPlans) await rejected(db, () => db.query("UPDATE billing_plan_versions SET status='active' WHERE id=$1", [planId]));
    for (const priceId of seedPrices) await rejected(db, () => db.query("UPDATE billing_price_versions SET status='active' WHERE id=$1", [priceId]));
    for (const overrides of [{ hosted_site_limit: null }, { allocation_status: 'proposed' }, { grant_schedule: 'unconfirmed' }]) {
      const planId = await plan(db, overrides);
      await price(db, planId);
      await rejected(db, () => price(db, planId, { interval: 'year', status: 'active' }));
      await rejected(db, () => db.query("UPDATE billing_plan_versions SET status='active' WHERE id=$1", [planId]));
    }
    const planId = await plan(db);
    await rejected(db, () => db.query("UPDATE billing_plan_versions SET status='active' WHERE id=$1", [planId]));
    await rejected(db, () => price(db, planId, { status: 'active', tax_policy: 'unconfirmed' }));
    const priceId = await price(db, planId);
    await db.query("UPDATE billing_price_versions SET status='active' WHERE id=$1", [priceId]);
    await db.query("UPDATE billing_plan_versions SET status='active' WHERE id=$1", [planId]);
    for (const overrides of [{}, { seed_duration_policy: 'cycles', seed_cycles: 12 },
      { seed_duration_policy: 'lifetime' }, { seed_duration_policy: 'cycles', seed_cycles: 0, seed_terms: '明确条款' }]) {
      await rejected(db, () => price(db, planId, { offer_type: 'seed', status: 'active', ...overrides }));
    }
    await price(db, planId, { offer_type: 'seed', status: 'active', seed_duration_policy: 'cycles', seed_cycles: 12, seed_terms: '明确期限条款' });
    await db.query("UPDATE billing_plan_versions SET status='retired' WHERE id=$1", [planId]);
    await rejected(db, () => price(db, planId, { interval: 'year', status: 'active' }));
    const lifetime = await activeSeed(db, 'lifetime');
    assert.equal((await db.query('SELECT seed_cycles FROM billing_price_versions WHERE id=$1', [lifetime.priceId])).rows[0].seed_cycles, null);
  });
});

test('报价金额是正安全整数、币种固定、种子只能归属 Unlimited 月付且报价组合唯一', async () => {
  await rollback(async db => {
    const limitedId = await plan(db, { code: 'maintain', ai_mode: 'limited', monthly_credits: 1000 });
    const unlimitedId = await plan(db);
    for (const overrides of [{ amount_minor: 0 }, { amount_minor: -1 }, { amount_minor: '9007199254740992' },
      { currency: 'EUR' }, { interval: 'week' }, { offer_type: 'unknown' }, { id: 'bpr_short' },
      { seed_duration_policy: 'lifetime', seed_terms: '标准价格不能伪装种子条款' }]) {
      await rejected(db, () => price(db, unlimitedId, overrides));
    }
    await rejected(db, () => price(db, unlimitedId, { amount_minor: '1.5' }), '22P02');
    await rejected(db, () => price(db, id('bpv')), '23503');
    await rejected(db, () => price(db, limitedId, { offer_type: 'seed' }));
    await rejected(db, () => price(db, unlimitedId, { offer_type: 'seed', interval: 'year' }));
    await price(db, unlimitedId, { amount_minor: '9007199254740991' });
    await rejected(db, () => price(db, unlimitedId), '23505');
    await price(db, unlimitedId, { offer_type: 'seed', tax_policy: 'unconfirmed' });
  });
});

test('积分包未知有效期不是永久；显式 never_expires 允许 NULL，激活仍须税条款', async () => {
  await rollback(async db => {
    const packId = await pack(db);
    await rejected(db, () => db.query("UPDATE billing_credit_pack_versions SET status='active' WHERE id=$1", [packId]));
    for (const overrides of [{ credits: 0 }, { credits: '9007199254740992' }, { amount_minor: 0 },
      { amount_minor: '9007199254740992' }, { currency: 'EUR' }, { tokens_per_credit: 101 }, { id: 'bcp_short' },
      { validity_days: 30 }, { validity_policy: 'days' }, { validity_policy: 'never_expires', validity_days: 30 },
      { validity_policy: 'days', validity_days: 0 }, { validity_policy: 'unknown' },
      { status: 'active', validity_policy: 'never_expires' }, { status: 'active', tax_policy: 'exclusive' }]) {
      await rejected(db, () => pack(db, overrides));
    }
    const forever = await pack(db, { validity_policy: 'never_expires', tax_policy: 'inclusive', status: 'active' });
    assert.equal((await db.query('SELECT validity_days FROM billing_credit_pack_versions WHERE id=$1', [forever])).rows[0].validity_days, null);
    const finite = await pack(db, { validity_policy: 'days', validity_days: 30, tax_policy: 'exclusive' });
    await db.query("UPDATE billing_credit_pack_versions SET status='active' WHERE id=$1", [finite]);
  });
});

test('三类版本所有内容不可变，不可删除；draft/active 只可退役且 retired 不复活', async () => {
  await rollback(async db => {
    const planId = await plan(db), priceId = await price(db, planId);
    const packId = await pack(db, { validity_policy: 'never_expires', tax_policy: 'exclusive' });
    const immutableChanges: Array<[CatalogTable, string, Record<string, unknown>]> = [
      ['billing_plan_versions', planId, { id: id('bpv'), code: 'build', version: ++version, name: '篡改名称', ai_mode: 'limited', monthly_credits: 1000,
        tokens_per_credit: 99, allocation_status: 'proposed', grant_schedule: 'unconfirmed', hosted_site_limit: 2, created_at: new Date(0) }],
      ['billing_price_versions', priceId, { id: id('bpr'), plan_version_id: seedPlans[0], interval: 'year', amount_minor: 101, currency: 'EUR',
        offer_type: 'seed', tax_policy: 'inclusive', seed_duration_policy: 'lifetime', seed_cycles: 1, seed_terms: '篡改条款', created_at: new Date(0) }],
      ['billing_credit_pack_versions', packId, { id: id('bcp'), name: '篡改名称', credits: 20, tokens_per_credit: 99, amount_minor: 101, currency: 'EUR',
        validity_days: 30, validity_policy: 'days', tax_policy: 'inclusive', created_at: new Date(0) }],
    ];
    for (const [table, rowId, changes] of immutableChanges) {
      for (const [column, value] of Object.entries(changes)) {
        await rejected(db, () => db.query(`UPDATE ${table} SET ${column}=$2 WHERE id=$1`, [rowId, value]));
      }
      await rejected(db, () => db.query(`DELETE FROM ${table} WHERE id=$1`, [rowId]));
      await db.query(`UPDATE ${table} SET status='draft' WHERE id=$1`, [rowId]);
    }
    await db.query("UPDATE billing_price_versions SET status='active' WHERE id=$1", [priceId]);
    await db.query("UPDATE billing_plan_versions SET status='active' WHERE id=$1", [planId]);
    await db.query("UPDATE billing_credit_pack_versions SET status='active' WHERE id=$1", [packId]);
    for (const [table, rowId] of immutableChanges) {
      await rejected(db, () => db.query(`UPDATE ${table} SET status='draft' WHERE id=$1`, [rowId]));
      await db.query(`UPDATE ${table} SET status='retired' WHERE id=$1`, [rowId]);
      for (const status of ['draft', 'active']) await rejected(db, () => db.query(`UPDATE ${table} SET status=$2 WHERE id=$1`, [rowId, status]));
      await rejected(db, () => db.query(`DELETE FROM ${table} WHERE id=$1`, [rowId]));
    }
    for (const [table, rowId] of [['billing_plan_versions', seedPlans[0]], ['billing_price_versions', seedPrices[0]],
      ['billing_credit_pack_versions', await pack(db)]] as const) {
      await db.query(`UPDATE ${table} SET status='retired' WHERE id=$1`, [rowId]);
      await rejected(db, () => db.query(`UPDATE ${table} SET status='draft' WHERE id=$1`, [rowId]));
    }
  });
});

test('种子授予：同账户一个 pending/approved、审批须明确期限，身份/期限/审批事实冻结且 revision 自动递增', async () => {
  await rollback(async db => {
    const actor = await account(db), other = await account(db), seed = await activeSeed(db);
    await rejected(db, () => offer(db, actor.accountId, seed.standardId));
    const draftPrice = seedPrices[6]!;
    const pendingDraft = await offer(db, actor.accountId, draftPrice);
    await rejected(db, () => db.query("UPDATE billing_offer_grants SET status='approved',approved_by=$2,granted_at=clock_timestamp() WHERE id=$1", [pendingDraft, actor.userId]));
    await db.query("UPDATE billing_offer_grants SET status='ended' WHERE id=$1", [pendingDraft]);
    const grantId = await offer(db, actor.accountId, seed.priceId);
    await rejected(db, () => offer(db, actor.accountId, seed.priceId), '23505');
    await offer(db, other.accountId, seed.priceId);
    for (const [column, value] of Object.entries({ id: id('bog'), billing_account_id: other.accountId, price_version_id: draftPrice,
      valid_from: new Date(0), valid_end: new Date(1), created_at: new Date(0), revision: 100 })) {
      await rejected(db, () => db.query(`UPDATE billing_offer_grants SET ${column}=$2 WHERE id=$1`, [grantId, value]));
    }
    await rejected(db, () => db.query("UPDATE billing_offer_grants SET status='approved' WHERE id=$1", [grantId]));
    await rejected(db, () => db.query("UPDATE billing_offer_grants SET status='approved',approved_by=$2,granted_at=clock_timestamp() WHERE id=$1", [grantId, id('usr')]), '23503');
    await db.query("UPDATE billing_offer_grants SET status='approved',approved_by=$2,granted_at=clock_timestamp() WHERE id=$1", [grantId, actor.userId]);
    const approval = (await db.query('SELECT revision,approved_by,granted_at FROM billing_offer_grants WHERE id=$1', [grantId])).rows[0];
    assert.equal(approval.revision, 2); assert.equal(approval.approved_by, actor.userId); assert.ok(approval.granted_at);
    await db.query("UPDATE billing_offer_grants SET status='approved' WHERE id=$1", [grantId]);
    assert.equal((await db.query('SELECT revision FROM billing_offer_grants WHERE id=$1', [grantId])).rows[0].revision, 2);
    await rejected(db, () => offer(db, actor.accountId, seed.priceId), '23505');
    await rejected(db, () => db.query("UPDATE billing_offer_grants SET status='ended',approved_by=$2 WHERE id=$1", [grantId, other.userId]));
    await db.query("UPDATE billing_offer_grants SET status='ended' WHERE id=$1", [grantId]);
    const ended = (await db.query('SELECT revision,approved_by,granted_at FROM billing_offer_grants WHERE id=$1', [grantId])).rows[0];
    assert.deepEqual(ended, { ...approval, revision: 3 });
    await rejected(db, () => db.query("UPDATE billing_offer_grants SET status='approved' WHERE id=$1", [grantId]));
    await rejected(db, () => db.query('DELETE FROM billing_offer_grants WHERE id=$1', [grantId]));
    await offer(db, actor.accountId, seed.priceId);
  });
});

test('授予 FK、日期范围和有效期模式：cycles 须有 end；lifetime 可显式无 end，NULL pending 不伪造授权', async () => {
  await rollback(async db => {
    const actor = await account(db), seed = await activeSeed(db), lifetime = await activeSeed(db, 'lifetime');
    await rejected(db, () => offer(db, id('bla'), seed.priceId), '23503');
    await rejected(db, () => offer(db, actor.accountId, id('bpr')), '23503');
    for (const overrides of [{ id: 'bog_short' }, { valid_from: null }, { valid_end: new Date(0) }, { revision: 2 },
      { status: 'approved' }, { status: 'pending', approved_by: actor.userId },
      { status: 'approved', approved_by: actor.userId, granted_at: new Date(), valid_end: null }]) {
      await rejected(db, () => offer(db, actor.accountId, seed.priceId, overrides));
    }
    const nullPending = await offer(db, actor.accountId, seed.priceId, { valid_from: null, valid_end: null });
    await rejected(db, () => db.query("UPDATE billing_offer_grants SET status='approved',approved_by=$2,granted_at=clock_timestamp() WHERE id=$1", [nullPending, actor.userId]));
    await db.query("UPDATE billing_offer_grants SET status='ended' WHERE id=$1", [nullPending]);
    await rejected(db, () => offer(db, actor.accountId, lifetime.priceId, { status: 'approved', approved_by: actor.userId, granted_at: new Date() }));
    await offer(db, actor.accountId, lifetime.priceId, { status: 'approved', approved_by: actor.userId, granted_at: new Date(), valid_end: null });
  });
});

test('订阅复合 FK 防套餐/报价错绑；种子须同账号同报价已审批未过期授予', async () => {
  await rollback(async db => {
    const actor = await account(db), other = await account(db), seed = await activeSeed(db), secondSeed = await activeSeed(db);
    await rejected(db, () => subscription(db, actor.accountId, seedPlans[0]!, seed.standardId), '23503');
    await rejected(db, () => subscription(db, id('bla'), seed.planId, seed.standardId), '23503');
    await rejected(db, () => subscription(db, actor.accountId, seed.planId, id('bpr')), '23503');
    await rejected(db, () => subscription(db, actor.accountId, seed.planId, seed.priceId));
    const grantId = await offer(db, actor.accountId, seed.priceId);
    await rejected(db, () => subscription(db, actor.accountId, seed.planId, seed.priceId, { offer_grant_id: grantId }));
    await db.query("UPDATE billing_offer_grants SET status='approved',approved_by=$2,granted_at=clock_timestamp() WHERE id=$1", [grantId, actor.userId]);
    await rejected(db, () => subscription(db, other.accountId, seed.planId, seed.priceId, { offer_grant_id: grantId }), '23503');
    await rejected(db, () => subscription(db, actor.accountId, secondSeed.planId, secondSeed.priceId, { offer_grant_id: grantId }), '23503');
    await rejected(db, () => subscription(db, actor.accountId, seed.planId, seed.standardId, { offer_grant_id: grantId }));
    const subId = await subscription(db, actor.accountId, seed.planId, seed.priceId, { offer_grant_id: grantId });
    assert.equal((await db.query('SELECT paid_through FROM billing_subscriptions WHERE id=$1', [subId])).rows[0].paid_through, null);
    await db.query("UPDATE billing_subscriptions SET status='cancelled' WHERE id=$1", [subId]);
    await db.query("UPDATE billing_offer_grants SET status='ended' WHERE id=$1", [grantId]);
    await rejected(db, () => subscription(db, actor.accountId, seed.planId, seed.priceId, { offer_grant_id: grantId }));
    for (const times of [
      { valid_from: new Date(Date.now() - 120_000), valid_end: new Date(Date.now() - 60_000) },
      { valid_from: new Date(Date.now() + 60_000), valid_end: new Date(Date.now() + 120_000) },
    ]) {
      const invalidGrant = await offer(db, actor.accountId, seed.priceId, { ...times, status: 'approved', approved_by: actor.userId, granted_at: new Date() });
      await rejected(db, () => subscription(db, actor.accountId, seed.planId, seed.priceId, { offer_grant_id: invalidGrant }));
      await db.query("UPDATE billing_offer_grants SET status='ended' WHERE id=$1", [invalidGrant]);
    }
  });
});

test('订阅一个 current 包含 incomplete/active/past_due/suspended，终态保留历史；PayPal ID 唯一且不限定固定长度', async () => {
  await rollback(async db => {
    const actor = await account(db), other = await account(db), planId = await plan(db), priceId = await price(db, planId);
    const subId = await subscription(db, actor.accountId, planId, priceId, { provider_subscription_id: 'I-A' });
    let revision = 1;
    for (const current of ['incomplete', 'active', 'past_due', 'suspended']) {
      if (current !== 'incomplete') {
        await db.query('UPDATE billing_subscriptions SET status=$2 WHERE id=$1', [subId, current]); revision++;
      }
      assert.equal((await db.query('SELECT revision FROM billing_subscriptions WHERE id=$1', [subId])).rows[0].revision, revision);
      for (const competing of ['incomplete', 'active', 'past_due', 'suspended']) {
        await rejected(db, () => subscription(db, actor.accountId, planId, priceId, { status: competing }), '23505');
      }
    }
    await rejected(db, () => subscription(db, other.accountId, planId, priceId, { provider_subscription_id: 'I-A' }), '23505');
    await subscription(db, other.accountId, planId, priceId, { provider_subscription_id: `I-${'A'.repeat(40)}` });
    await db.query("UPDATE billing_subscriptions SET status='cancelled' WHERE id=$1", [subId]);
    const replacement = await subscription(db, actor.accountId, planId, priceId);
    await db.query("UPDATE billing_subscriptions SET status='expired' WHERE id=$1", [replacement]);
    await subscription(db, actor.accountId, planId, priceId);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM billing_subscriptions WHERE billing_account_id=$1', [actor.accountId])).rows[0].n, 3);
    for (const rowId of [subId, replacement]) {
      await rejected(db, () => db.query("UPDATE billing_subscriptions SET status='active' WHERE id=$1", [rowId]));
      await rejected(db, () => db.query('DELETE FROM billing_subscriptions WHERE id=$1', [rowId]));
    }
  });
});

test('订阅 nullable 正周期、支付期限无事实不能写入；identity/所选价格冻结，状态与日期自动 +1', async () => {
  await rollback(async db => {
    const actor = await account(db), other = await account(db), planId = await plan(db), priceId = await price(db, planId);
    for (const overrides of [{ id: 'bsu_short' }, { provider: 'stripe' }, { provider_subscription_id: 'invalid' }, { provider_subscription_id: 'I-' },
      { status: 'unknown' }, { revision: 2 }, { period_start: new Date() }, { period_end: new Date() },
      { period_start: new Date(1), period_end: new Date(1) }, { period_start: new Date(1), period_end: new Date(0) },
      { paid_through: new Date() }]) await rejected(db, () => subscription(db, actor.accountId, planId, priceId, overrides));
    const subId = await subscription(db, actor.accountId, planId, priceId);
    const original = (await db.query('SELECT period_start,period_end,paid_through,revision FROM billing_subscriptions WHERE id=$1', [subId])).rows[0];
    assert.deepEqual(original, { period_start: null, period_end: null, paid_through: null, revision: 1 });
    for (const [column, value] of Object.entries({ id: id('bsu'), billing_account_id: other.accountId, plan_version_id: seedPlans[0],
      price_version_id: seedPrices[0], offer_grant_id: id('bog'), provider: 'other', provider_subscription_id: 'I-B',
      created_at: new Date(0), paid_through: new Date(), revision: 50 })) {
      await rejected(db, () => db.query(`UPDATE billing_subscriptions SET ${column}=$2 WHERE id=$1`, [subId, value]));
    }
    await db.query("UPDATE billing_subscriptions SET status='active',period_start=$2,period_end=$3 WHERE id=$1", [subId, new Date(0), new Date(1000)]);
    assert.equal((await db.query('SELECT revision FROM billing_subscriptions WHERE id=$1', [subId])).rows[0].revision, 2);
    await db.query('UPDATE billing_subscriptions SET cancel_requested_at=$2 WHERE id=$1', [subId, new Date(500)]);
    assert.equal((await db.query('SELECT revision FROM billing_subscriptions WHERE id=$1', [subId])).rows[0].revision, 3);
    await db.query("UPDATE billing_subscriptions SET status='active' WHERE id=$1", [subId]);
    assert.equal((await db.query('SELECT revision FROM billing_subscriptions WHERE id=$1', [subId])).rows[0].revision, 3);
    await rejected(db, () => db.query('UPDATE billing_subscriptions SET period_end=$2 WHERE id=$1', [subId, new Date(0)]));
    await rejected(db, () => db.query('DELETE FROM billing_subscriptions WHERE id=$1', [subId]));
    assert.equal((await db.query('SELECT paid_through FROM billing_subscriptions WHERE id=$1', [subId])).rows[0].paid_through, null);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ai_quota_periods')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ai_quota_ledger')).rows[0].n, 0);
  });
});

test('app/testapp 五表仅 SELECT：无表级/列级写、TRUNCATE、REFERENCES、TRIGGER 或 helper EXECUTE；PUBLIC 无授权', async () => {
  const roles = (await owner.query("SELECT rolname FROM pg_roles WHERE rolname IN ('restaurant_app','restaurant_test_app') ORDER BY rolname")).rows;
  assert.ok(roles.some(row => row.rolname === 'restaurant_test_app'));
  for (const { rolname } of roles) {
    for (const table of catalogTables) {
      assert.equal((await owner.query("SELECT has_table_privilege($1,$2,'SELECT') AS allowed", [rolname, table])).rows[0].allowed, true);
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        assert.equal((await owner.query('SELECT has_table_privilege($1,$2,$3) AS allowed', [rolname, table, privilege])).rows[0].allowed, false);
      }
      for (const column of columns[table]) {
        for (const privilege of ['INSERT', 'UPDATE', 'REFERENCES']) {
          assert.equal((await owner.query('SELECT has_column_privilege($1,$2,$3,$4) AS allowed', [rolname, table, column, privilege])).rows[0].allowed, false);
        }
      }
    }
    for (const signature of ['guard_billing_catalog_version()', 'guard_billing_offer_grant()', 'guard_billing_subscription()']) {
      assert.equal((await owner.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [rolname, signature])).rows[0].allowed, false);
    }
  }
  for (const table of catalogTables) {
    assert.equal((await owner.query(`SELECT EXISTS(SELECT 1 FROM pg_class c
      CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid=$1::regclass AND a.grantee=0) AS allowed`, [table])).rows[0].allowed, false);
    await assert.rejects(() => pool.query(`INSERT INTO ${table}(id) VALUES($1)`, [id('denied')]), { code: '42501' });
    await assert.rejects(() => pool.query(`UPDATE ${table} SET status=status WHERE false`), { code: '42501' });
    await assert.rejects(() => pool.query(`DELETE FROM ${table} WHERE false`), { code: '42501' });
    await assert.rejects(() => pool.query(`TRUNCATE ${table}`), { code: '42501' });
  }
  for (const signature of ['guard_billing_catalog_version()', 'guard_billing_offer_grant()', 'guard_billing_subscription()']) {
    const row = (await owner.query(`SELECT p.prosecdef AS security_definer,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) AS public_allowed
      FROM pg_proc p WHERE p.oid=$1::regprocedure`, [signature])).rows[0];
    assert.deepEqual(row, { security_definer: false, public_allowed: false });
  }
  assert.equal((await owner.query("SELECT has_schema_privilege('restaurant_test_app','public','CREATE') AS allowed")).rows[0].allowed, false);
});
