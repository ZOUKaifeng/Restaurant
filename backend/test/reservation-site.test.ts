import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { loadConfig, type Config } from '../src/config.js';
import { assertAppDatabase, id } from '../src/db.js';
import { migrate } from '../scripts/migrate.js';
import { insertGeneratedWebsiteFixture } from './website-fixtures.js';
import { createSiteApp } from '../src/sites.js';

let app: FastifyInstance, pool: Pool, owner: Pool, config: Config, root: string;
const tables = 'ai_calendar_credit_grants,website_content_actions,website_version_sources,billing_subscriptions,billing_offer_grants,ai_quota_ledger,ai_quota_periods,ai_model_calls,billing_accounts,analytics_events,analytics_daily,reservations,reservation_events,reservation_access_tokens,website_model_calls,menu_jobs,menu_drafts,website_publish_actions,website_publications,website_jobs,website_versions,website_agents,asset_upload_intents,asset_references,assets,audit_logs,email_outbox,opening_hours,restaurant_members,auth_tokens,auth_sessions,auth_identities,restaurants,users';
const slug = `site-reserve-${randomUUID().slice(0, 8)}`;
const tokenPattern = /\/r\/([A-Za-z0-9_-]{43})/;

import { createTestDatabasePools, readTestDatabaseScope } from './database-scope.js';
function tomorrowInNewYork(days = 3): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(Date.now() + days * 86400000));
}
async function seed(rid: string, enabled = true): Promise<void> {
  await owner.query(`INSERT INTO users(id,email,email_normalized,display_name,locale,status,email_verified_at,
    terms_version,terms_accepted_at) VALUES($1,$2,$2,'Site Owner','en','active',now(),'terms-v1',now())`,
  [id('usr'), `${rid}@example.com`]);
  const user = (await owner.query('SELECT id FROM users WHERE email_normalized=$1', [`${rid}@example.com`])).rows[0].id;
  await owner.query(`INSERT INTO restaurants(id,created_by_user_id,create_idempotency_key,create_request_fingerprint,
    slug,name,description,timezone,currency_code,primary_locale,reservation_enabled,reservation_notice,
    privacy_notice_version,status) VALUES($1,$2,$3,$4,$5,'Site Shop','A small test restaurant','America/New_York','USD','en',$6,$7,'privacy-v1','active')`,
  [rid, user, id('create'), 'a'.repeat(64), rid, enabled, 'Requests need restaurant confirmation.']);
  await owner.query(`INSERT INTO restaurant_members(id,restaurant_id,user_id,role,status) VALUES($1,$2,$3,'owner','active')`, [id('mem'), rid, user]);
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    await owner.query(`INSERT INTO opening_hours(id,restaurant_id,weekday,opens_at_local,closes_at_local,
      closes_day_offset,accepts_requests,sort_order) VALUES($1,$2,$3,'10:00','22:00',0,true,0)`, [id('hours'), rid, weekday]);
  }
  const vid = (await insertGeneratedWebsiteFixture(owner, rid, 1)).id;
  await owner.query(`INSERT INTO website_publications(restaurant_id,revision,published_version_id,slug,deployment_mode)
    VALUES($1,1,$2,$3,'local')`, [rid, vid, slug]);
}
before(async () => {
  const scope = readTestDatabaseScope();
  const { databaseUrl, migrationDatabaseUrl } = scope;
  root = await mkdtemp('/tmp/restaurant-reservation-site-');
  config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, MIGRATION_DATABASE_URL: migrationDatabaseUrl,
    APP_ORIGIN: 'https://localhost:5173', EMAIL_MODE: 'disabled', STORAGE_MODE: 'local', STORAGE_LOCAL_ROOT: root,
    SITE_PUBLIC_ORIGIN: 'http://127.0.0.1:4010', SITE_PORT: '4010',
    TOKEN_PEPPER: 'reservation-site-pepper-'.repeat(3), CURSOR_SECRET: 'reservation-site-cursor-'.repeat(3),
    OUTBOX_ENCRYPTION_KEY: 'c3'.repeat(32) });
  ({ owner, pool } = await createTestDatabasePools(scope));
  await migrate(owner, 'restaurant_test_app');
  await assertAppDatabase(pool);
  await owner.query(`TRUNCATE ${tables}`);
  await seed(`rst_${randomUUID().replaceAll('-', '').slice(0, 24)}`);
  app = createSiteApp({ pool, config });
  await app.ready();
});
after(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
  if (owner) { try { await owner.query(`TRUNCATE ${tables}`); } finally { await owner.end(); } }
  if (root) await rm(root, { recursive: true, force: true });
});
function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}
function baseForm(overrides: Record<string, string> = {}): Record<string, string> {
  return { guest_name: 'Site Guest', guest_email: 'guest@example.com', guest_phone: '', party_size: '2',
    local_date: tomorrowInNewYork(), local_time: '18:00', note: 'Window seat if possible',
    privacy_notice_version: 'privacy-v1', privacy_consent: 'true', idempotency_key: `site-key-${randomUUID()}`, ...overrides };
}

test('公开网站注入订位链接，订位页使用可提交的同源表单', async () => {
  const site = await app.inject({ method: 'GET', url: `/s/${slug}` });
  assert.equal(site.statusCode, 200, site.body);
  assert.match(site.body, new RegExp(`/s/${slug}/go/reserve`));
  assert.match(String(site.headers['content-security-policy']), /sandbox/);
  const formPage = await app.inject({ method: 'GET', url: `/s/${slug}/reserve` });
  assert.equal(formPage.statusCode, 200, formPage.body);
  assert.match(formPage.body, /name="guest_name"/);
  assert.match(formPage.body, /name="privacy_notice_version"/);
  assert.match(formPage.body, /name="idempotency_key"/);
  assert.match(String(formPage.headers['content-security-policy']), /form-action 'self'/);
  assert.ok(!String(formPage.headers['content-security-policy']).includes('sandbox'));
});

test('同源表单创建pending申请，幂等重放不新增，成功页给出管理链接', async () => {
  const values = baseForm();
  const response = await app.inject({ method: 'POST', url: `/s/${slug}/reserve`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://127.0.0.1:4010' }, payload: form(values) });
  assert.equal(response.statusCode, 201, response.body);
  assert.match(response.body, /Request received/);
  assert.match(response.body, /Awaiting restaurant confirmation/);
  const token = tokenPattern.exec(response.body)?.[1];
  assert.ok(token);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM reservations')).rows[0].n, 1);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM reservation_events')).rows[0].n, 1);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM reservation_access_tokens')).rows[0].n, 1);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM email_outbox')).rows[0].n, 1);
  const replay = await app.inject({ method: 'POST', url: `/s/${slug}/reserve`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://127.0.0.1:4010' }, payload: form(values) });
  assert.equal(replay.statusCode, 200);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM reservations')).rows[0].n, 1);
});

test('管理页可查看并取消，取消后状态持久', async () => {
  const response = await app.inject({ method: 'POST', url: `/s/${slug}/reserve`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://127.0.0.1:4010' }, payload: form(baseForm()) });
  const token = tokenPattern.exec(response.body)?.[1];
  assert.ok(token);
  const manage = await app.inject({ method: 'GET', url: `/r/${token}` });
  assert.equal(manage.statusCode, 200, manage.body);
  assert.match(manage.body, /Awaiting restaurant confirmation/);
  assert.match(manage.body, new RegExp(`/r/${token}/cancel`));
  const cancel = await app.inject({ method: 'POST', url: `/r/${token}/cancel`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://127.0.0.1:4010' }, payload: form({ expected_revision: '1' }) });
  assert.equal(cancel.statusCode, 303);
  assert.equal(cancel.headers.location, `/r/${token}`);
  const after = await app.inject({ method: 'GET', url: `/r/${token}` });
  assert.equal(after.statusCode, 200);
  assert.match(after.body, /Cancelled/);
  const row = (await owner.query('SELECT status,cancelled_by_type FROM reservations ORDER BY created_at DESC LIMIT 1')).rows[0];
  assert.equal(row.status, 'cancelled');
  assert.equal(row.cancelled_by_type, 'guest');
  const getCancel = await app.inject({ method: 'GET', url: `/r/${token}/cancel` });
  assert.equal(getCancel.statusCode, 404);
});

test('非营业时间、错误隐私版本、未知站点与未开启均不会创建申请', async () => {
  const before = (await owner.query('SELECT count(*)::int AS n FROM reservations')).rows[0].n as number;
  const closed = await app.inject({ method: 'POST', url: `/s/${slug}/reserve`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://127.0.0.1:4010' },
    payload: form(baseForm({ local_time: '03:00' })) });
  assert.equal(closed.statusCode, 422);
  assert.match(closed.body, /not accepting requests/);
  const stale = await app.inject({ method: 'POST', url: `/s/${slug}/reserve`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://127.0.0.1:4010' },
    payload: form(baseForm({ privacy_notice_version: 'old' })) });
  assert.equal(stale.statusCode, 422);
  const missing = await app.inject({ method: 'GET', url: '/s/not-a-real-site/reserve' });
  assert.equal(missing.statusCode, 404);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM reservations')).rows[0].n, before);
});
