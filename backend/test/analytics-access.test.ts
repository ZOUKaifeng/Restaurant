import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createHash } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import { assertAppDatabase, id } from '../src/db.js';
import { ApiError } from '../src/errors.js';
import { migrate } from '../scripts/migrate.js';
import { insertGeneratedWebsiteFixture } from './website-fixtures.js';
import { metricVersion, readAnalyticsDays, rebuildAnalyticsDays, recordAnalyticsEvent,
  type AnalyticsContext, type AnalyticsEventType, type AnalyticsNamespace } from '../src/analytics-access.js';

let pool: Pool, owner: Pool, ready = false;
let fixture: { context: AnalyticsContext; userId: string };
const tables = 'ai_calendar_credit_grants,website_content_actions,website_version_sources,billing_subscriptions,billing_offer_grants,ai_quota_ledger,ai_quota_periods,ai_model_calls,billing_accounts,analytics_events,analytics_daily,reservations,reservation_events,reservation_access_tokens,website_model_calls,menu_jobs,menu_drafts,website_publish_actions,website_publications,website_jobs,website_versions,website_agents,asset_upload_intents,asset_references,assets,audit_logs,email_outbox,opening_hours,restaurant_members,auth_tokens,auth_sessions,auth_identities,restaurants,users';
const instant = new Date('2024-06-01T16:00:00.000Z');
const key = (value: string): string => createHash('sha256').update(value).digest('hex');
const apiError = (status: number, code: string) => (error: unknown): boolean =>
  error instanceof ApiError && error.status === status && error.code === code;
const pgError = (code: string) => (error: unknown): boolean => (error as { code?: string }).code === code;

import { createTestDatabasePool, createTestDatabasePools, readTestDatabaseScope } from './database-scope.js';
async function version(rid: string, number: number): Promise<string> {
  return (await insertGeneratedWebsiteFixture(owner, rid, number)).id;
}
async function seed(timezone: string | null = 'America/New_York'): Promise<typeof fixture> {
  const rid = id('rst'), userId = id('usr'), slug = `analytics-${key(rid).slice(0, 20)}`;
  await owner.query(`INSERT INTO users(id,email,email_normalized,display_name,locale,status,email_verified_at,terms_version,terms_accepted_at)
    VALUES($1,$2,$2,'Fixture Owner','en','active',now(),'terms-v1',now())`, [userId, `${userId}@example.com`]);
  await owner.query(`INSERT INTO restaurants(id,created_by_user_id,create_idempotency_key,create_request_fingerprint,
    slug,name,timezone,currency_code,primary_locale,status) VALUES($1,$2,$3,$4,$5,'测试餐厅',$6,'USD','en','active')`,
  [rid, userId, id('create'), key(rid), slug, timezone]);
  await owner.query('UPDATE restaurants SET reservation_enabled=true WHERE id=$1', [rid]);
  await owner.query(`INSERT INTO restaurant_members(id,restaurant_id,user_id,role,status) VALUES($1,$2,$3,'owner','active')`,
    [id('mem'), rid, userId]);
  const vid = await version(rid, 1);
  await owner.query(`INSERT INTO website_publications(restaurant_id,revision,published_version_id,slug,deployment_mode)
    VALUES($1,1,$2,$3,'local')`, [rid, vid, slug]);
  return { userId, context: { restaurant_id: rid, version_id: vid, publication_revision: 1, slug,
    timezone: timezone ?? 'UTC', timezone_fallback: timezone === null, namespace: 'local_test' } };
}
before(async () => {
  const scope = readTestDatabaseScope();
  ({ owner, pool } = await createTestDatabasePools(scope));
  await migrate(owner, 'restaurant_test_app');
  await assertAppDatabase(pool);
  const schema = (await owner.query("SELECT to_regclass('public.analytics_events') AS events,to_regclass('public.analytics_daily') AS daily")).rows[0];
  assert.ok(schema.events && schema.daily, '等待主 agent 将 009_analytics 加入迁移选择器，不在专项测试绕过迁移');
  ready = true;
  await owner.query(`TRUNCATE ${tables}`);
});
beforeEach(async () => {
  if (!ready) return;
  await owner.query(`TRUNCATE ${tables}`);
  fixture = await seed();
});
after(async () => {
  try { if (ready) await owner.query(`TRUNCATE ${tables}`); }
  finally { await Promise.all([pool?.end(), owner?.end()]); }
});
async function record(label: string, type: AnalyticsEventType = 'page_view', context = fixture.context,
  at = instant): Promise<boolean> {
  return recordAnalyticsEvent(pool, context, type, key(label), at);
}
async function days(context = fixture.context, from = '2024-06-01', to = from) {
  return readAnalyticsDays(pool, context.restaurant_id, context.namespace, from, to);
}
async function rawEvent(overrides: Record<string, unknown> = {}): Promise<void> {
  const c = fixture.context;
  const row = { id: id('aev'), restaurant_id: c.restaurant_id, version_id: c.version_id, publication_revision: 1,
    namespace: c.namespace, metric_version: 'v1', event_type: 'page_view', occurred_at: instant,
    local_date: '2024-06-01', timezone_snapshot: c.timezone, timezone_fallback: false, dedupe_key: key(id('raw')), ...overrides };
  await owner.query(`INSERT INTO analytics_events(id,restaurant_id,version_id,publication_revision,namespace,metric_version,
    event_type,occurred_at,local_date,timezone_snapshot,timezone_fallback,dedupe_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, Object.values(row));
}
async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, '未观察到预期的数据库锁等待');
    await yieldTurn();
  }
}
async function waitAdvisory(rid: string, count: number): Promise<void> {
  await waitUntil(async () => Number((await owner.query(`SELECT count(*) AS n FROM pg_locks
    WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND objid=(hashtext('analytics:' || $1)::bigint & 4294967295)`, [rid])).rows[0].n) >= count);
}
async function waitBlockedBy(pid: number): Promise<void> {
  await waitUntil(async () => (await owner.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
    WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting`, [pid])).rows[0].waiting);
}

// 真实 PG，只有基础夹具由 owner 创建；业务操作全部经过最小权限应用角色。
test('三个固定事件口径及不同摘要正确累计，重试只保留第一次事实', async () => {
  assert.equal(metricVersion, 'v1');
  assert.equal(await record('pv-1'), true); assert.equal(await record('pv-2'), true);
  assert.equal(await record('click', 'reservation_click'), true);
  assert.equal(await record('form', 'reservation_form_view'), true);
  const before = (await owner.query('SELECT * FROM analytics_events WHERE dedupe_key=$1', [key('pv-1')])).rows[0];
  const aggregate = (await owner.query('SELECT updated_at FROM analytics_daily')).rows[0];
  assert.equal(await record('pv-1', 'page_view', fixture.context, new Date('2024-06-02T16:00:00Z')), false);
  assert.deepEqual((await owner.query('SELECT * FROM analytics_events WHERE dedupe_key=$1', [key('pv-1')])).rows[0], before);
  assert.deepEqual((await owner.query('SELECT updated_at FROM analytics_daily')).rows[0], aggregate);
  assert.equal(before.occurred_at.toISOString(), instant.toISOString());
  assert.equal(before.metric_version, 'v1');
  assert.ok(Math.abs(before.created_at.getTime() - Date.now()) < 60000);
  assert.deepEqual(await days(), { days: [{ date: '2024-06-01', timezone: 'America/New_York', timezone_fallback: false,
    page_views: 2, reservation_clicks: 1, reservation_form_views: 1 }],
  totals: { page_views: 2, reservation_clicks: 1, reservation_form_views: 1 } });
});

test('永久去重跨事件类型和版本，类型或当前新版本冲突返回409', async () => {
  await record('permanent');
  await assert.rejects(record('permanent', 'reservation_click'), apiError(409, 'ANALYTICS_EVENT_CONFLICT'));
  const vid = await version(fixture.context.restaurant_id, 2);
  await owner.query(`UPDATE website_publications SET published_version_id=$2,revision=revision+1 WHERE restaurant_id=$1`,
    [fixture.context.restaurant_id, vid]);
  const next = { ...fixture.context, version_id: vid, publication_revision: 2 };
  await assert.rejects(record('permanent', 'page_view', next), apiError(409, 'ANALYTICS_EVENT_CONFLICT'));
  assert.equal(await record('stale-context'), false);
  assert.equal(await record('new-key', 'page_view', next), true);
  assert.equal((await days()).totals.page_views, 2);
  assert.equal((await owner.query('SELECT count(*) AS n FROM analytics_events')).rows[0].n, '2');
});

test('同版本重新发布允许幂等重试，旧revision无效', async () => {
  await record('same-version');
  await owner.query('UPDATE website_publications SET revision=revision+1 WHERE restaurant_id=$1', [fixture.context.restaurant_id]);
  assert.equal(await record('same-version'), false);
  assert.equal(await record('same-version', 'page_view', { ...fixture.context, publication_revision: 2 },
    new Date('2024-06-03T00:00:00Z')), false);
  assert.equal((await owner.query('SELECT publication_revision FROM analytics_events')).rows[0].publication_revision, 1);
  assert.equal((await days()).totals.page_views, 1);
});

test('去重scope只包含餐厅和命名空间，不跨租户或命名空间', async () => {
  const other = await seed(), production = { ...fixture.context, namespace: 'production' as const };
  assert.equal(await record('shared'), true);
  assert.equal(await record('shared', 'reservation_click', production), true);
  assert.equal(await record('shared', 'reservation_form_view', other.context), true);
  assert.equal((await days()).totals.page_views, 1);
  assert.equal((await days(production)).totals.reservation_clicks, 1);
  assert.equal((await days(other.context)).totals.reservation_form_views, 1);
});

test('午夜及春秋DST按冻结IANA时区计算，UTC保存不受会话时区影响', async () => {
  const cases = [
    ['2024-03-10T04:59:59.999Z', '2024-03-09', '23:59'],
    ['2024-03-10T05:00:00.000Z', '2024-03-10', '00:00'],
    ['2024-03-10T06:59:00.000Z', '2024-03-10', '01:59'],
    ['2024-03-10T07:00:00.000Z', '2024-03-10', '03:00'],
    ['2024-11-03T05:30:00.000Z', '2024-11-03', '01:30'],
    ['2024-11-03T06:30:00.000Z', '2024-11-03', '01:30'],
  ];
  for (const [at] of cases) await record(at!, 'page_view', fixture.context, new Date(at!));
  const db = await pool.connect();
  try {
    await db.query('BEGIN'); await db.query("SET LOCAL TIME ZONE 'Asia/Tokyo'");
    const rows = (await db.query(`SELECT occurred_at,to_char(local_date,'YYYY-MM-DD') AS day,
      to_char(occurred_at AT TIME ZONE timezone_snapshot,'HH24:MI') AS wall,
      local_date=(occurred_at AT TIME ZONE timezone_snapshot)::date AS consistent FROM analytics_events ORDER BY occurred_at`)).rows;
    assert.deepEqual(rows.map(row => [row.occurred_at.toISOString(), row.day, row.wall]), cases);
    assert.ok(rows.every(row => row.consistent));
    const report = await readAnalyticsDays(db, fixture.context.restaurant_id, 'local_test', '2024-03-09', '2024-11-03');
    assert.deepEqual(report.days.map(day => [day.date, day.page_views]), [['2024-03-09', 1], ['2024-03-10', 3], ['2024-11-03', 2]]);
    assert.equal(report.totals.page_views, 6);
  } finally { await db.query('ROLLBACK'); db.release(); }
});

test('NULL时区回退UTC与显式UTC分组区分，切换时区重建不改历史', async () => {
  const fallback = await seed(null);
  await record('fallback', 'page_view', fallback.context, new Date('2024-06-01T00:01:00Z'));
  await owner.query("UPDATE restaurants SET timezone='UTC' WHERE id=$1", [fallback.context.restaurant_id]);
  const explicit = { ...fallback.context, timezone_fallback: false };
  assert.equal(await record('old-fallback', 'page_view', fallback.context), false);
  assert.equal(await record('fallback', 'page_view', explicit), false);
  await record('explicit', 'reservation_click', explicit);
  const expected = await days(explicit);
  assert.deepEqual(expected.days.map(day => [day.timezone, day.timezone_fallback]), [['UTC', false], ['UTC', true]]);
  await owner.query("UPDATE restaurants SET timezone='America/New_York' WHERE id=$1", [fallback.context.restaurant_id]);
  await rebuildAnalyticsDays(pool, fallback.context.restaurant_id, 'local_test', '2024-06-01', '2024-06-01');
  assert.deepEqual(await days(explicit), expected);
});

test('无效事件/命名空间/摘要/日期/真实IANA时区统一返回422且不插入', async () => {
  for (const patch of [
    { namespace: 'staging' }, { publication_revision: 0 }, { publication_revision: 1.5 },
    { publication_revision: 2147483648 }, { restaurant_id: '' }, { version_id: '' }, { slug: '../site' },
    { timezone: 'America/Not_A_Zone' }, { timezone: '+01:00' }, { timezone: 'UTC+01' },
    { timezone: 'posix/America/New_York' }, { timezone_fallback: 'true' },
  ]) await assert.rejects(record('invalid', 'page_view', { ...fixture.context, ...patch } as AnalyticsContext),
    apiError(422, 'ANALYTICS_CONTEXT_INVALID'));
  await assert.rejects(record('invalid-type', 'subscribe' as AnalyticsEventType), apiError(422, 'ANALYTICS_CONTEXT_INVALID'));
  for (const digest of ['request-id', 'a'.repeat(63), 'A'.repeat(64), 'x'.repeat(64)])
    await assert.rejects(recordAnalyticsEvent(pool, fixture.context, 'page_view', digest, instant), apiError(422, 'ANALYTICS_CONTEXT_INVALID'));
  await assert.rejects(record('date', 'page_view', fixture.context, new Date(NaN)), apiError(422, 'ANALYTICS_CONTEXT_INVALID'));
  await assert.rejects(record('date', 'page_view', fixture.context, '2024-06-01' as unknown as Date), apiError(422, 'ANALYTICS_CONTEXT_INVALID'));
  assert.equal((await owner.query('SELECT count(*) AS n FROM analytics_events')).rows[0].n, '0');
});

test('过期发布/slug/版本/时区/fallback及未知餐厅返回false', async () => {
  for (const patch of [{ publication_revision: 2 }, { version_id: id('wsv') }, { slug: 'other-valid-slug' },
    { timezone: 'Europe/Paris' }, { timezone: 'UTC', timezone_fallback: true }, { timezone_fallback: true }, { restaurant_id: id('rst') }])
    assert.equal(await record('stale', 'page_view', { ...fixture.context, ...patch }), false);
  await owner.query("UPDATE restaurants SET status='draft' WHERE id=$1", [fixture.context.restaurant_id]);
  assert.equal(await record('draft'), true);
  for (const status of ['suspended', 'archived']) {
    await owner.query('UPDATE restaurants SET status=$2 WHERE id=$1', [fixture.context.restaurant_id, status]);
    assert.equal(await record(status), false);
  }
  assert.equal((await days()).totals.page_views, 1);
});

test('无当前发布、非活跃owner/member或未验证用户不计数', async () => {
  await owner.query("UPDATE restaurant_members SET status='revoked' WHERE restaurant_id=$1", [fixture.context.restaurant_id]);
  assert.equal(await record('revoked'), false);
  await owner.query("UPDATE restaurant_members SET status='active' WHERE restaurant_id=$1", [fixture.context.restaurant_id]);
  await owner.query("UPDATE users SET status='suspended' WHERE id=$1", [fixture.userId]);
  assert.equal(await record('suspended-user'), false);
  await owner.query("UPDATE users SET status='pending_verification',email_verified_at=NULL WHERE id=$1", [fixture.userId]);
  assert.equal(await record('unverified'), false);
  await owner.query("UPDATE users SET status='active',email_verified_at=now() WHERE id=$1", [fixture.userId]);
  await owner.query('DELETE FROM website_publications WHERE restaurant_id=$1', [fixture.context.restaurant_id]);
  assert.equal(await record('unpublished'), false);
  assert.deepEqual((await days()).totals, { page_views: 0, reservation_clicks: 0, reservation_form_views: 0 });
});

test('等待餐厅/发布/成员/用户行锁后重新验证，不用锁前旧状态插入', async () => {
  for (const entity of ['restaurant', 'publication', 'member', 'user']) {
    const f = await seed(), db = await owner.connect();
    let pending: Promise<boolean> | undefined;
    try {
      await db.query('BEGIN');
      const pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      if (entity === 'restaurant') await db.query('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE', [f.context.restaurant_id]);
      if (entity === 'publication') await db.query('SELECT restaurant_id FROM website_publications WHERE restaurant_id=$1 FOR UPDATE', [f.context.restaurant_id]);
      if (entity === 'member') await db.query('SELECT id FROM restaurant_members WHERE restaurant_id=$1 FOR UPDATE', [f.context.restaurant_id]);
      if (entity === 'user') await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [f.userId]);
      pending = record(entity, 'page_view', f.context);
      await waitBlockedBy(pid);
      if (entity === 'restaurant') await db.query("UPDATE restaurants SET status='suspended' WHERE id=$1", [f.context.restaurant_id]);
      if (entity === 'publication') await db.query('UPDATE website_publications SET revision=revision+1 WHERE restaurant_id=$1', [f.context.restaurant_id]);
      if (entity === 'member') await db.query("UPDATE restaurant_members SET status='revoked' WHERE restaurant_id=$1", [f.context.restaurant_id]);
      if (entity === 'user') await db.query("UPDATE users SET status='suspended' WHERE id=$1", [f.userId]);
      await db.query('COMMIT');
      assert.equal(await pending, false, entity);
    } finally { await db.query('ROLLBACK'); db.release(); await pending?.catch(() => {}); }
  }
  assert.equal((await owner.query('SELECT count(*) AS n FROM analytics_events')).rows[0].n, '0');
});

test('等待餐厅锁时关闭订位会丢弃点击，但正常PV仍可写入', async () => {
  const db = await owner.connect();
  let pending: Promise<boolean> | undefined;
  try {
    await db.query('BEGIN');
    const pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await db.query('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE', [fixture.context.restaurant_id]);
    pending = record('closed-during-wait', 'reservation_click');
    await waitBlockedBy(pid);
    await db.query('UPDATE restaurants SET reservation_enabled=false WHERE id=$1', [fixture.context.restaurant_id]);
    await db.query('COMMIT');
    assert.equal(await pending, false);
    assert.equal(await record('closed-form', 'reservation_form_view'), false);
    assert.equal(await record('closed-pv'), true);
    assert.deepEqual((await days()).totals, { page_views: 1, reservation_clicks: 0, reservation_form_views: 0 });
  } finally { await db.query('ROLLBACK'); db.release(); await pending?.catch(() => {}); }
});

test('事件数据库只追加、最小列权限及新函数无PUBLIC执行/提权', async () => {
  await record('immutable');
  await assert.rejects(owner.query("UPDATE analytics_events SET event_type='reservation_click'"), pgError('23514'));
  await assert.rejects(owner.query('DELETE FROM analytics_events'), pgError('23514'));
  await assert.rejects(pool.query("UPDATE analytics_events SET event_type='reservation_click'"), pgError('42501'));
  await assert.rejects(pool.query('DELETE FROM analytics_events'), pgError('42501'));
  await assert.rejects(pool.query('TRUNCATE analytics_events'), pgError('42501'));
  await assert.rejects(pool.query(`INSERT INTO analytics_events(id,created_at) VALUES($1,now())`, [id('aev')]), pgError('42501'));
  const permissions = (await owner.query(`SELECT
    has_column_privilege('restaurant_test_app','analytics_events','id','SELECT') AS event_select,
    has_column_privilege('restaurant_test_app','analytics_events','dedupe_key','INSERT') AS event_insert,
    has_column_privilege('restaurant_test_app','analytics_events','created_at','INSERT') AS created_insert,
    has_table_privilege('restaurant_test_app','analytics_events','UPDATE') AS event_update,
    has_table_privilege('restaurant_test_app','analytics_events','DELETE') AS event_delete,
    has_table_privilege('restaurant_test_app','analytics_daily','DELETE') AS daily_delete,
    has_column_privilege('restaurant_test_app','analytics_daily','page_views','UPDATE') AS daily_update`)).rows[0];
  assert.deepEqual(permissions, { event_select: true, event_insert: true, created_insert: false,
    event_update: false, event_delete: false, daily_delete: true, daily_update: true });
  const functions = (await owner.query(`SELECT p.proname,p.prosecdef,
    EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner)))
      WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('guard_analytics_timezone','guard_analytics_event') ORDER BY p.proname`)).rows;
  assert.equal(functions.length, 2);
  assert.ok(functions.every(row => !row.prosecdef && !row.public_execute));
});

test('复合版本FK及本地日期/有限UTC时刻/时区/固定口径约束生效', async () => {
  const other = await seed();
  await assert.rejects(rawEvent({ version_id: other.context.version_id }), pgError('23503'));
  for (const patch of [
    { local_date: '2024-06-02' }, { timezone_snapshot: 'Unknown/Nowhere' }, { timezone_snapshot: 'UTC+01' },
    { occurred_at: 'infinity' }, { timezone_fallback: true }, { metric_version: 'v2' }, { namespace: 'unknown' },
    { event_type: 'subscribe' }, { dedupe_key: 'raw-request' }, { publication_revision: 0 },
  ]) await assert.rejects(rawEvent(patch), pgError('23514'));
  assert.equal((await owner.query('SELECT count(*) AS n FROM analytics_events')).rows[0].n, '0');
  await rawEvent({ timezone_snapshot: 'America/New_York' });
  assert.equal((await owner.query('SELECT count(*) AS n FROM analytics_events')).rows[0].n, '1');
});

test('历史时区别名按当前 PG 目录接受或拒绝，事件和日汇总都不绕过时区守卫', async t => {
  const timezone = 'US/Eastern';
  // Trixie 的 tzdata-legacy 是可选包，不能假定每个 PG 安装都有历史别名。
  const known = (await owner.query(`SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=$1) AS known`, [timezone])).rows[0].known;
  assert.equal(typeof known, 'boolean');
  t.diagnostic(`pg_timezone_names: US/Eastern=${known ? 'present' : 'absent'}`);
  const daily = () => owner.query(`INSERT INTO analytics_daily
    (restaurant_id,namespace,local_date,timezone_snapshot,timezone_fallback)
    VALUES($1,'local_test','2024-06-01',$2,false)`, [fixture.context.restaurant_id, timezone]);
  if (known) {
    await rawEvent({ timezone_snapshot: timezone });
    await daily();
    const event = (await owner.query('SELECT timezone_snapshot,local_date::text FROM analytics_events')).rows;
    assert.deepEqual(event, [{ timezone_snapshot: timezone, local_date: '2024-06-01' }]);
    assert.deepEqual((await owner.query('SELECT timezone_snapshot FROM analytics_daily')).rows,
      [{ timezone_snapshot: timezone }]);
  } else {
    await assert.rejects(rawEvent({ timezone_snapshot: timezone }), pgError('23514'));
    await assert.rejects(daily(), pgError('23514'));
    assert.equal((await owner.query('SELECT count(*) AS n FROM analytics_events')).rows[0].n, '0');
    assert.equal((await owner.query('SELECT count(*) AS n FROM analytics_daily')).rows[0].n, '0');
  }
});

test('事件表仅契约列，不包含IP/UA/URL/token/用户或联系方式', async () => {
  const columns = (await owner.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='analytics_events' ORDER BY ordinal_position`)).rows.map(row => row.column_name);
  assert.deepEqual(columns, ['id', 'restaurant_id', 'version_id', 'publication_revision', 'namespace', 'metric_version',
    'event_type', 'occurred_at', 'local_date', 'timezone_snapshot', 'timezone_fallback', 'dedupe_key', 'created_at']);
  await record('仅传不可逆摘要');
  const event = (await owner.query('SELECT * FROM analytics_events')).rows[0];
  assert.equal(event.dedupe_key, key('仅传不可逆摘要'));
  assert.ok(!JSON.stringify(event).includes('仅传不可逆摘要'));
});

test('读取保持bigint安全整数，包括超过int32的计数及总和溢出拒绝', async () => {
  await record('large'); await record('another-day', 'page_view', fixture.context, new Date('2024-06-02T16:00:00Z'));
  await owner.query("UPDATE analytics_daily SET page_views=3000000000 WHERE local_date='2024-06-01'");
  assert.equal((await days()).totals.page_views, 3000000000);
  await owner.query("UPDATE analytics_daily SET page_views=9007199254740991 WHERE local_date='2024-06-01'");
  assert.equal((await days()).totals.page_views, Number.MAX_SAFE_INTEGER);
  await assert.rejects(days(fixture.context, '2024-06-01', '2024-06-02'), apiError(422, 'ANALYTICS_COUNT_OVERFLOW'));
  for (const count of ['-1', '9007199254740992'])
    await assert.rejects(owner.query('UPDATE analytics_daily SET reservation_clicks=$1', [count]), pgError('23514'));
});

test('增量超过maxsafe时整笔回滚，事件不遗留；已存在重试不触发溢出', async () => {
  await record('first');
  await owner.query('UPDATE analytics_daily SET page_views=9007199254740991');
  await assert.rejects(record('overflow'), pgError('23514'));
  assert.equal((await owner.query('SELECT count(*) AS n FROM analytics_events')).rows[0].n, '1');
  assert.equal((await owner.query('SELECT count(*) AS n FROM analytics_events WHERE dedupe_key=$1', [key('overflow')])).rows[0].n, '0');
  assert.equal(await record('first'), false);
  assert.equal((await days()).totals.page_views, Number.MAX_SAFE_INTEGER);
});

test('范围重建修复损坏汇总、清空无事件旧日、重复稳定且隔离租户命名空间和日期', async () => {
  const other = await seed(), production = { ...fixture.context, namespace: 'production' as const };
  await record('pv-a'); await record('pv-b'); await record('click', 'reservation_click'); await record('form', 'reservation_form_view');
  await record('outside', 'page_view', fixture.context, new Date('2024-05-31T16:00:00Z'));
  await record('prod', 'reservation_click', production); await record('tenant', 'reservation_form_view', other.context);
  const expected = await days(), prodBefore = await days(production), tenantBefore = await days(other.context);
  await owner.query('UPDATE analytics_daily SET page_views=99,reservation_clicks=88,reservation_form_views=77 WHERE restaurant_id=$1 AND namespace=$2',
    [fixture.context.restaurant_id, 'local_test']);
  await owner.query(`INSERT INTO analytics_daily(restaurant_id,namespace,metric_version,local_date,timezone_snapshot,timezone_fallback,page_views)
    VALUES($1,'local_test','v1','2024-06-02','America/New_York',false,7)`, [fixture.context.restaurant_id]);
  const eventsBefore = (await owner.query('SELECT * FROM analytics_events ORDER BY id')).rows;
  await rebuildAnalyticsDays(pool, fixture.context.restaurant_id, 'local_test', '2024-06-01', '2024-06-02');
  assert.deepEqual(await days(fixture.context, '2024-06-01', '2024-06-02'), expected);
  assert.equal((await owner.query("SELECT count(*) AS n FROM analytics_daily WHERE restaurant_id=$1 AND namespace='local_test' AND local_date='2024-06-02'",
    [fixture.context.restaurant_id])).rows[0].n, '0');
  assert.equal((await days(fixture.context, '2024-05-31')).totals.page_views, 99);
  assert.deepEqual(await days(production), prodBefore); assert.deepEqual(await days(other.context), tenantBefore);
  await rebuildAnalyticsDays(pool, fixture.context.restaurant_id, 'local_test', '2024-06-01', '2024-06-02');
  assert.deepEqual(await days(), expected);
  assert.deepEqual((await owner.query('SELECT * FROM analytics_events ORDER BY id')).rows, eventsBefore);
});

test('真日历和最多366个含首尾日，不接受反序/全量/注入范围，未知餐厅404', async () => {
  await record('preserved');
  const invalid: [string, string][] = [
    ['2024-02-30', '2024-03-01'], ['2023-02-29', '2023-03-01'], ['2024-13-01', '2024-13-02'],
    ['2024-06-02', '2024-06-01'], ['', ''], ['0000-01-01', '0000-01-02'],
    ['2024-1-01', '2024-01-02'], ['2024-01-01', '2025-01-01'], ["2024-06-01'; DELETE FROM analytics_daily;--", '2024-06-02'],
  ];
  for (const [from, to] of invalid) {
    await assert.rejects(rebuildAnalyticsDays(pool, fixture.context.restaurant_id, 'local_test', from, to), apiError(422, 'ANALYTICS_CONTEXT_INVALID'));
    await assert.rejects(readAnalyticsDays(pool, fixture.context.restaurant_id, 'local_test', from, to), apiError(422, 'ANALYTICS_CONTEXT_INVALID'));
  }
  await assert.rejects(rebuildAnalyticsDays(pool, fixture.context.restaurant_id, 'other' as AnalyticsNamespace,
    '2024-06-01', '2024-06-01'), apiError(422, 'ANALYTICS_CONTEXT_INVALID'));
  await assert.rejects(rebuildAnalyticsDays(pool, id('rst'), 'local_test', '2024-06-01', '2024-06-01'), apiError(404, 'NOT_FOUND'));
  await assert.rejects(readAnalyticsDays(pool, id('rst'), 'local_test', '2024-06-01', '2024-06-01'), apiError(404, 'NOT_FOUND'));
  await rebuildAnalyticsDays(pool, fixture.context.restaurant_id, 'local_test', '2024-01-01', '2024-12-31');
  assert.equal((await days()).totals.page_views, 1);
  assert.deepEqual(await days(fixture.context, '0001-01-01', '0001-01-02'),
    { days: [], totals: { page_views: 0, reservation_clicks: 0, reservation_form_views: 0 } });
  assert.deepEqual(await days(fixture.context, '2024-06-02', '2024-06-03'),
    { days: [], totals: { page_views: 0, reservation_clicks: 0, reservation_form_views: 0 } });
});

test('重建删除后读取事件失败会ROLLBACK，旧聚合完整保留', async () => {
  await record('rollback');
  await owner.query('UPDATE analytics_daily SET page_views=23');
  const previous = (await owner.query('SELECT * FROM analytics_daily')).rows;
  const blocker = await owner.connect(), timedPool = await createTestDatabasePool('app', readTestDatabaseScope());
  let setup: PoolClient | undefined;
  try {
    setup = await timedPool.connect(); await setup.query("SET statement_timeout='200ms'"); setup.release(); setup = undefined;
    await blocker.query('BEGIN'); await blocker.query('LOCK TABLE analytics_events IN ACCESS EXCLUSIVE MODE');
    await assert.rejects(rebuildAnalyticsDays(timedPool, fixture.context.restaurant_id, 'local_test', '2024-06-01', '2024-06-01'), pgError('57014'));
    assert.deepEqual((await owner.query('SELECT * FROM analytics_daily')).rows, previous);
  } finally { setup?.release(); await blocker.query('ROLLBACK'); blocker.release(); await timedPool.end(); }
  await rebuildAnalyticsDays(pool, fixture.context.restaurant_id, 'local_test', '2024-06-01', '2024-06-01');
  assert.equal((await days()).totals.page_views, 1);
});

test('并发同摘要只插一次，不同摘要均不丢失且汇总准确', async () => {
  const duplicates = await Promise.all(Array.from({ length: 12 }, () => record('concurrent-same')));
  assert.equal(duplicates.filter(Boolean).length, 1);
  const unique = await Promise.all(Array.from({ length: 12 }, (_, index) => record(`unique-${index}`)));
  assert.ok(unique.every(Boolean));
  assert.equal((await owner.query('SELECT count(*) AS n FROM analytics_events')).rows[0].n, '13');
  assert.equal((await days()).totals.page_views, 13);
});

test('采集与重建共用餐厅事务锁，两种排队顺序都不漏事件', async () => {
  await record('baseline');
  for (const recordFirst of [true, false]) {
    const blocker = await owner.connect(), pending: Promise<unknown>[] = [];
    try {
      await blocker.query('BEGIN');
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext('analytics:' || $1))", [fixture.context.restaurant_id]);
      const add = () => record(`ordered-${recordFirst}`);
      const rebuild = () => rebuildAnalyticsDays(pool, fixture.context.restaurant_id, 'local_test', '2024-06-01', '2024-06-01');
      pending.push(recordFirst ? add() : rebuild());
      await waitAdvisory(fixture.context.restaurant_id, 1);
      pending.push(recordFirst ? rebuild() : add());
      await waitAdvisory(fixture.context.restaurant_id, 2);
      await blocker.query('COMMIT');
      await Promise.all(pending);
      assert.equal((await days()).totals.page_views, recordFirst ? 2 : 3);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await Promise.allSettled(pending); }
  }
  const count = (await owner.query('SELECT count(*) AS n FROM analytics_events')).rows[0].n;
  assert.equal(count, '3'); assert.equal((await days()).totals.page_views, Number(count));
});

test('餐厅锁不会阻塞其他租户，生产与本地命名空间重建互不清除', async () => {
  const other = await seed(), production = { ...fixture.context, namespace: 'production' as const };
  await record('local'); await record('production', 'reservation_click', production);
  const blocker = await owner.connect();
  let queued: Promise<void> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query("SELECT pg_advisory_xact_lock(hashtext('analytics:' || $1))", [fixture.context.restaurant_id]);
    queued = rebuildAnalyticsDays(pool, fixture.context.restaurant_id, 'production', '2024-06-01', '2024-06-01');
    await waitAdvisory(fixture.context.restaurant_id, 1);
    assert.equal(await record('unblocked-tenant', 'reservation_form_view', other.context), true);
    assert.equal((await days(other.context)).totals.reservation_form_views, 1);
    await blocker.query('COMMIT'); await queued;
  } finally { await blocker.query('ROLLBACK'); blocker.release(); await queued?.catch(() => {}); }
  assert.equal((await days()).totals.page_views, 1);
  assert.equal((await days(production)).totals.reservation_clicks, 1);
});
