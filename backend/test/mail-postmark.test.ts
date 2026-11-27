import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createDecipheriv, randomUUID } from 'node:crypto';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { assertAppDatabase, id } from '../src/db.js';
import { runMailBatch } from '../src/mail-worker.js';
import { renderAccountMail } from '../src/mail-templates.js';
import { digest, encryptAction, FLOW_COOKIE, secret } from '../src/security.js';
import { migrate } from '../scripts/migrate.js';
import { createTestDatabasePools, readTestDatabaseScope } from './database-scope.js';

const tables = 'ai_calendar_credit_grants,website_content_actions,website_version_sources,billing_subscriptions,billing_offer_grants,ai_quota_ledger,ai_quota_periods,ai_model_calls,billing_accounts,analytics_events,analytics_daily,website_model_calls,menu_jobs,menu_drafts,website_publish_actions,website_publications,website_jobs,website_versions,website_agents,asset_references,asset_upload_intents,assets,reservations,reservation_events,reservation_access_tokens,audit_logs,email_outbox,opening_hours,restaurant_members,auth_tokens,auth_sessions,auth_identities,restaurants,users';
const password = '邮件测试-Valid-Password-2026!';
const providerId = '12345678-1234-4234-8234-123456789abc';
const serverToken = 'integration-only-postmark-token';
const from = 'sender@example.test';
const originalFetch = globalThis.fetch;
let unmockedFetchAttempts = 0;
let sequence = 0;
let pool: Pool, owner: Pool, app: FastifyInstance, config: Config;

interface Actor { email: string; cookie: string; csrf: string }
interface Outbox {
  id: string; template_key: string; recipient_email: string; recipient_email_normalized: string;
  recipient_email_key: string; user_id: string | null; auth_token_id: string | null;
  restaurant_id: string | null; reservation_id: string | null; payload: Record<string, unknown>;
  status: string; attempt_count: number; max_attempts: number;
  sensitive_payload_ciphertext: string | null; sensitive_payload_expires_at: Date;
  provider_message_id: string | null; accepted_at: Date | null; last_error_code: string | null;
  lease_token: string | null; lease_expires_at: Date | null; updated_at: Date;
}

function fixtureEnv(): NodeJS.ProcessEnv {
  const scope = readTestDatabaseScope();
  return { NODE_ENV: 'test', DATABASE_URL: scope.databaseUrl, MIGRATION_DATABASE_URL: scope.migrationDatabaseUrl,
    TOKEN_PEPPER: 'mail-postmark-fixture-pepper-'.repeat(4),
    CURSOR_SECRET: 'mail-postmark-fixture-cursor-'.repeat(4), OUTBOX_ENCRYPTION_KEY: 'a4'.repeat(32),
    APP_ORIGIN: 'https://localhost:5173', EMAIL_MODE: 'postmark', POSTMARK_SERVER_TOKEN: serverToken, SMTP_FROM: from };
}

before(() => {
  globalThis.fetch = async () => {
    unmockedFetchAttempts++;
    throw new Error('集成测试禁止未注入的网络请求');
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(unmockedFetchAttempts, 0, '全部邮件批次必须显式注入 fetch，真实请求为零');
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}
function successResponse(): Response {
  return jsonResponse({ ErrorCode: 0, MessageID: providerId, Message: 'OK' });
}
function mockedFetch(handler: typeof fetch = async () => successResponse()) {
  const calls: { input: Parameters<typeof fetch>[0]; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return handler(input, init);
  };
  return { fetcher, calls };
}
function forbiddenFetch() {
  return mockedFetch(async () => { throw new Error('此场景不得尝试发送邮件'); });
}
function assertRequest(fake: ReturnType<typeof mockedFetch>, row: Outbox, subject?: string, text?: string) {
  assert.equal(fake.calls.length, 1);
  const { input, init } = fake.calls[0]!;
  assert.equal(input, 'https://api.postmarkapp.com/email');
  assert.equal(init?.method, 'POST');
  assert.equal(init?.redirect, 'error');
  assert.ok(init?.signal instanceof AbortSignal);
  assert.deepEqual(Object.fromEntries(new Headers(init.headers)), {
    'content-type': 'application/json', accept: 'application/json', 'x-postmark-server-token': serverToken,
  });
  const body = JSON.parse(String(init.body));
  assert.deepEqual(body, {
    From: from, To: row.recipient_email, Subject: subject ?? body.Subject, TextBody: text ?? body.TextBody,
    ...(['verify_email', 'reset_password'].includes(row.template_key) ? { HtmlBody: body.HtmlBody } : {}),
    Headers: [{ Name: 'Message-ID', Value: `<${row.id}@localhost>` }],
    MessageStream: 'outbound', TrackOpens: false, TrackLinks: 'None',
  });
  assert.equal(String(init.body).includes(serverToken), false, '供应商令牌不得进入邮件正文');
  if (['verify_email', 'reset_password'].includes(row.template_key)) {
    assert.equal(typeof body.HtmlBody, 'string');
    assert.match(body.HtmlBody, /<html lang="en">/);
    assert.match(body.HtmlBody, /Table Folk/);
  }
  return body as { From: string; To: string; Subject: string; TextBody: string; HtmlBody?: string };
}
async function outbox(outboxId: string): Promise<Outbox> {
  const result = await owner.query<Outbox>('SELECT * FROM email_outbox WHERE id=$1', [outboxId]);
  assert.equal(result.rowCount, 1);
  return result.rows[0]!;
}
async function queued(email: string, template = 'verify_email'): Promise<Outbox> {
  const result = await owner.query<Outbox>(`SELECT * FROM email_outbox
    WHERE recipient_email_normalized=$1 AND template_key=$2 ORDER BY created_at DESC,id DESC`, [email.toLowerCase(), template]);
  assert.equal(result.rowCount, 1);
  const row = result.rows[0]!;
  assert.equal(row.status, 'queued');
  assert.equal(row.attempt_count, 0);
  assert.equal(row.max_attempts, 1);
  assert.equal(row.recipient_email, email.toLowerCase());
  assert.equal(row.recipient_email_normalized, email.toLowerCase());
  assert.equal(row.recipient_email_key, digest(config, email.toLowerCase(), 'email'));
  assert.ok(row.sensitive_payload_expires_at > new Date());
  return row;
}
async function actionToken(row: Outbox, purpose: 'verify_email' | 'reset_password'): Promise<string> {
  assert.ok(row.sensitive_payload_ciphertext);
  const [version, iv, tag, ciphertext] = row.sensitive_payload_ciphertext.split('.');
  assert.equal(version, 'v1');
  assert.ok(iv && tag && ciphertext);
  const decoder = createDecipheriv('aes-256-gcm', Buffer.from(config.outboxEncryptionKey, 'hex'), Buffer.from(iv, 'base64url'));
  decoder.setAAD(Buffer.from(row.id));
  decoder.setAuthTag(Buffer.from(tag, 'base64url'));
  const data = JSON.parse(Buffer.concat([decoder.update(Buffer.from(ciphertext, 'base64url')), decoder.final()]).toString('utf8'));
  assert.match(data.token, /^[A-Za-z0-9_-]{43}$/);
  const tokenRow = (await owner.query('SELECT * FROM auth_tokens WHERE id=$1', [row.auth_token_id])).rows[0];
  assert.ok(tokenRow);
  assert.equal(tokenRow.purpose, purpose);
  assert.equal(tokenRow.user_id, row.user_id);
  assert.equal(tokenRow.target_email_normalized, row.recipient_email_normalized);
  assert.equal(tokenRow.token_hash, digest(config, data.token, purpose));
  assert.equal(JSON.stringify(row.payload).includes(data.token), false);
  return data.token as string;
}
async function assertAccepted(initial: Outbox): Promise<Outbox> {
  const row = await outbox(initial.id);
  assert.ok(row.accepted_at instanceof Date);
  assert.deepEqual(row, { ...initial, status: 'accepted', attempt_count: initial.attempt_count + 1,
    provider_message_id: providerId, accepted_at: row.accepted_at, sensitive_payload_ciphertext: null,
    lease_token: null, lease_expires_at: null, last_error_code: null, updated_at: row.updated_at });
  assert.notEqual(row.provider_message_id, `<${row.id}@localhost>`);
  return row;
}
async function assertFailed(initial: Outbox, code: string): Promise<Outbox> {
  const row = await outbox(initial.id);
  assert.deepEqual(row, { ...initial, status: 'failed', attempt_count: initial.attempt_count + 1,
    last_error_code: code, lease_token: null, lease_expires_at: null, updated_at: row.updated_at });
  assert.equal(row.accepted_at, null);
  assert.equal(row.provider_message_id, null);
  return row;
}
async function assertCancelled(initial: Outbox) {
  const row = await outbox(initial.id);
  assert.deepEqual(row, { ...initial, status: 'cancelled', sensitive_payload_ciphertext: null, updated_at: row.updated_at });
  assert.equal(row.attempt_count, 0);
  assert.equal(row.accepted_at, null);
  assert.equal(row.provider_message_id, null);
}
async function request(method: HTTPMethods, path: string, actor?: Actor, payload?: Record<string, unknown>) {
  const headers: Record<string, string> = { origin: config.appOrigin };
  if (actor) { headers.cookie = actor.cookie; headers['x-csrf-token'] = actor.csrf; }
  if (payload !== undefined) headers['content-type'] = 'application/json';
  const response = await app.inject({ method, url: `/api/v1${path}`, headers,
    ...(payload === undefined ? {} : { payload }),
    remoteAddress: `127.9.${Math.floor(++sequence / 250)}.${sequence % 250 + 1}` });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.ok(response.headers['x-request-id']);
  return response;
}
async function register(email = `owner-${randomUUID()}@example.test`): Promise<Actor> {
  const policy = await request('GET', '/auth/registration-policy');
  assert.equal(policy.statusCode, 200);
  const flow = await request('GET', '/auth/csrf');
  assert.equal(flow.statusCode, 200);
  const values = flow.headers['set-cookie'];
  const cookie = (Array.isArray(values) ? values : [values]).find(value => typeof value === 'string' && value.startsWith(`${FLOW_COOKIE}=`));
  assert.equal(typeof cookie, 'string');
  assert.match(cookie as string, /HttpOnly/i);
  assert.match(cookie as string, /Secure/i);
  assert.match(cookie as string, /SameSite=Lax/i);
  assert.doesNotMatch(cookie as string, /Domain=/i);
  const actor = { email, cookie: (cookie as string).split(';')[0]!, csrf: flow.json().csrf_token as string };
  const response = await request('POST', '/auth/register', actor, { email, password, display_name: ' 邮件测试商家 ',
    locale: 'en', terms_version: policy.json().terms_version, accepted_terms: true });
  assert.equal(response.statusCode, 202, response.body);
  const registeredCookies = response.headers['set-cookie'];
  const headers = Array.isArray(registeredCookies) ? registeredCookies : [registeredCookies];
  assert.ok(headers.some(value => typeof value === 'string' && value.startsWith('__Host-restaurant_registration=')));
  assert.ok(headers.every(value => typeof value === 'string' && !value.startsWith('__Host-restaurant_session=')));
  return actor;
}
function pinnedPool(client: PoolClient): Pool {
  // 两个 worker 固定使用已验证应用池的不同物理连接；事务的 release 不归还外层借用。
  return { query: client.query.bind(client), connect: async () => ({ query: client.query.bind(client), release() {} }) } as unknown as Pool;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('并发测试未到达预期屏障')), 5000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

test('Postmark 最小配置只需 server token 和 SMTP_FROM，不依赖其他 SMTP 字段', () => {
  const env = fixtureEnv();
  for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS']) assert.equal(env[key], undefined);
  const minimal = loadConfig(env);
  assert.equal(minimal.nodeEnv, 'test');
  assert.equal(minimal.emailMode, 'postmark');
  assert.equal(minimal.smtp, undefined);
  assert.deepEqual(minimal.postmark, { serverToken, from });
});

test('缺少 Postmark token 在加载配置阶段失败，不创建数据库连接或执行出站请求', () => {
  const env = fixtureEnv();
  delete env.POSTMARK_SERVER_TOKEN;
  let downstreamCalls = 0;
  assert.throws(() => {
    loadConfig(env);
    downstreamCalls++;
  }, { message: '缺少配置 POSTMARK_SERVER_TOKEN' });
  assert.equal(downstreamCalls, 0);
  assert.equal(unmockedFetchAttempts, 0);
});

describe('Postmark 邮件队列真实 PostgreSQL 集成', { concurrency: false }, () => {
  let databaseReady = false;
  before(async () => {
    config = loadConfig(fixtureEnv());
    ({ owner, pool } = await createTestDatabasePools(readTestDatabaseScope()));
    await migrate(owner, 'restaurant_test_app');
    await assertAppDatabase(pool);
    databaseReady = true;
    app = createApp({ pool, config });
    await app.ready();
  });
  beforeEach(async () => { await owner.query(`TRUNCATE ${tables}`); });
  after(async () => {
    try { if (app) await app.close(); }
    finally {
      try { if (pool) await pool.end(); }
      finally {
        if (owner) {
          try { if (databaseReady) await owner.query(`TRUNCATE ${tables}`); }
          finally { await owner.end(); }
        }
      }
    }
  });

  test('HTTP 注册排队并经 HTTPS 接受，fragment 验证链接可消费为 204，第二批次 idle', async () => {
    const actor = await register('Owner.Name+Postmark@example.test');
    const initial = await queued(actor.email);
    const user = (await owner.query('SELECT * FROM users WHERE id=$1', [initial.user_id])).rows[0];
    assert.equal(user.email, actor.email.toLowerCase());
    assert.equal(user.status, 'pending_verification');
    assert.equal(user.display_name, '邮件测试商家');
    const token = await actionToken(initial, 'verify_email');
    const url = new URL('/auth/verify', config.appOrigin);
    url.hash = `token=${encodeURIComponent(token)}`;
    const fake = mockedFetch();
    assert.equal(await runMailBatch(pool, config, fake.fetcher), 'accepted');
    const expected = renderAccountMail('verify_email', url);
    const body = assertRequest(fake, initial, 'Verify your email — Table Folk', expected.text);
    assert.equal(body.HtmlBody, expected.html);
    assert.equal((await owner.query('SELECT status FROM users WHERE id=$1', [initial.user_id])).rows[0].status, 'pending_verification');
    const link = new URL(body.TextBody.split('\n').find(line => line.startsWith('https://'))!);
    assert.equal(link.origin, config.appOrigin);
    assert.equal(link.pathname, '/auth/verify');
    assert.equal(link.search, '');
    assert.equal(link.username, '');
    assert.equal(link.password, '');
    assert.equal(new URLSearchParams(link.hash.slice(1)).get('token'), token);
    const accepted = await assertAccepted(initial);
    assert.equal(await runMailBatch(pool, config, fake.fetcher), 'idle');
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(await outbox(initial.id), accepted);
    const verified = await request('POST', '/auth/verify-email', undefined, { token });
    assert.equal(verified.statusCode, 204);
    assert.equal(verified.body, '');
    assert.equal(verified.headers['set-cookie'], undefined);
    assert.equal((await owner.query('SELECT status FROM users WHERE id=$1', [initial.user_id])).rows[0].status, 'active');
  });

  test('真实 HTTP 找回流程使用 reset_password token，完整重置邮件与供应商 ID 落库一致', async () => {
    const actor = await register();
    const verification = await queued(actor.email);
    const verifyToken = await actionToken(verification, 'verify_email');
    assert.equal((await request('POST', '/auth/verify-email', undefined, { token: verifyToken })).statusCode, 204);
    const reset = await request('POST', '/auth/password-reset-requests', actor, { email: actor.email });
    assert.equal(reset.statusCode, 202);
    const initial = await queued(actor.email, 'reset_password');
    const token = await actionToken(initial, 'reset_password');
    const url = new URL('/auth/reset', config.appOrigin);
    url.hash = `token=${encodeURIComponent(token)}`;
    const fake = mockedFetch();
    assert.equal(await runMailBatch(pool, config, fake.fetcher), 'accepted');
    const expected = renderAccountMail('reset_password', url);
    const body = assertRequest(fake, initial, 'Reset your password — Table Folk', expected.text);
    assert.equal(body.HtmlBody, expected.html);
    const accepted = await assertAccepted(initial);
    assert.equal(await runMailBatch(pool, config, fake.fetcher), 'idle');
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(await outbox(initial.id), accepted);
    const changed = await request('POST', '/auth/password-reset', undefined, { token, new_password: '邮件测试-New-Password-2026!' });
    assert.equal(changed.statusCode, 204);
    assert.ok((await owner.query('SELECT used_at FROM auth_tokens WHERE id=$1', [initial.auth_token_id])).rows[0].used_at);
  });

  const failures: { name: string; code: string; respond: (privateMessage: string) => Response | Promise<Response> }[] = [
    { name: 'HTTP 401', code: 'POSTMARK_AUTH_REJECTED', respond: message => jsonResponse({ Message: message }, 401) },
    { name: 'HTTP 422 / 412 未批准', code: 'POSTMARK_ACCOUNT_NOT_APPROVED', respond: message => jsonResponse({ ErrorCode: 412, Message: message }, 422) },
    { name: 'HTTP 422 / 413 未批准', code: 'POSTMARK_ACCOUNT_NOT_APPROVED', respond: message => jsonResponse({ ErrorCode: 413, Message: message }, 422) },
    { name: 'HTTP 422 / 406 收件人停用', code: 'POSTMARK_RECIPIENT_INACTIVE', respond: message => jsonResponse({ ErrorCode: 406, Message: message }, 422) },
    { name: 'HTTP 422 / 1235 stream 拒绝', code: 'POSTMARK_STREAM_REJECTED', respond: message => jsonResponse({ ErrorCode: 1235, Message: message }, 422) },
    { name: 'HTTP 422 / 1236 stream 拒绝', code: 'POSTMARK_STREAM_REJECTED', respond: message => jsonResponse({ ErrorCode: 1236, Message: message }, 422) },
    { name: 'HTTP 422 普通请求拒绝', code: 'POSTMARK_REQUEST_REJECTED', respond: message => jsonResponse({ ErrorCode: 300, Message: message }, 422) },
    { name: 'HTTP 429', code: 'POSTMARK_RATE_LIMITED', respond: message => jsonResponse({ Message: message }, 429) },
    { name: 'HTTP 500', code: 'DELIVERY_UNKNOWN', respond: message => jsonResponse({ Message: message }, 500) },
    { name: '网络异常', code: 'DELIVERY_UNKNOWN', respond: async message => { throw new Error(message); } },
    { name: '无效 JSON', code: 'DELIVERY_UNKNOWN', respond: message => new Response(`not-json ${message}`, { status: 200 }) },
    { name: '无效供应商 UUID', code: 'DELIVERY_UNKNOWN', respond: message => jsonResponse({ ErrorCode: 0, MessageID: message }) },
    { name: '缺少 ErrorCode', code: 'DELIVERY_UNKNOWN', respond: message => jsonResponse({ MessageID: providerId, Message: message }) },
    { name: 'HTTP 200 非零 ErrorCode', code: 'DELIVERY_UNKNOWN', respond: message => jsonResponse({ ErrorCode: 412, MessageID: providerId, Message: message }) },
    { name: 'HTTP 204 不构成接受', code: 'DELIVERY_UNKNOWN', respond: () => new Response(null, { status: 204 }) },
  ];
  for (const scenario of failures) {
    test(`${scenario.name} 仅记录安全失败码，后续批次不自动重试`, async () => {
      const actor = await register();
      const initial = await queued(actor.email);
      const token = await actionToken(initial, 'verify_email');
      const privateMessage = `${serverToken} ${actor.email} ${token} 外部响应正文不得进入错误码`;
      const fake = mockedFetch(async () => scenario.respond(privateMessage));
      assert.equal(await runMailBatch(pool, config, fake.fetcher), 'failed');
      assertRequest(fake, initial);
      const failed = await assertFailed(initial, scenario.code);
      for (const value of [serverToken, actor.email, token, privateMessage]) {
        assert.equal(failed.last_error_code!.includes(value), false, '错误码不得泄露供应商响应、邮箱或令牌');
      }
      assert.equal(await runMailBatch(pool, config, fake.fetcher), 'idle');
      assert.equal(fake.calls.length, 1);
      assert.deepEqual(await outbox(initial.id), failed);
    });
  }

  for (const variant of ['无效密文格式', '解密密钥不匹配', 'outbox AAD 不匹配', '解密后的 token 格式无效'] as const) {
    test(`${variant} 在 fetch 前失败且不重试`, async () => {
      const actor = await register();
      const queuedRow = await queued(actor.email);
      let workerConfig = config;
      if (variant === '解密密钥不匹配') workerConfig = { ...config, outboxEncryptionKey: 'b5'.repeat(32) };
      else {
        const value = variant === '无效密文格式' ? 'v0.invalid'
          : encryptAction(config, variant === 'outbox AAD 不匹配' ? id('other_mail') : queuedRow.id,
            variant === '解密后的 token 格式无效' ? 'invalid-token' : secret());
        await owner.query('UPDATE email_outbox SET sensitive_payload_ciphertext=$1 WHERE id=$2', [value, queuedRow.id]);
      }
      const initial = await outbox(queuedRow.id), fake = forbiddenFetch();
      assert.equal(await runMailBatch(pool, workerConfig, fake.fetcher), 'failed');
      const failed = await assertFailed(initial, 'INVALID_ENCRYPTED_PAYLOAD');
      assert.equal(await runMailBatch(pool, workerConfig, fake.fetcher), 'idle');
      assert.equal(fake.calls.length, 0);
      assert.deepEqual(await outbox(initial.id), failed);
    });
  }

  const cancellations: { name: string; sql: string; target: 'outbox' | 'token' | 'user' }[] = [
    { name: '敏感密文过期', sql: "UPDATE email_outbox SET sensitive_payload_expires_at=now()-interval '1 second' WHERE id=$1", target: 'outbox' },
    { name: '动作令牌过期', sql: "UPDATE auth_tokens SET expires_at=now()-interval '1 second' WHERE id=$1", target: 'token' },
    { name: '动作令牌撤销', sql: 'UPDATE auth_tokens SET revoked_at=now() WHERE id=$1', target: 'token' },
    { name: '动作令牌已使用', sql: 'UPDATE auth_tokens SET used_at=now() WHERE id=$1', target: 'token' },
    { name: '用户暂停', sql: "UPDATE users SET status='suspended' WHERE id=$1", target: 'user' },
    { name: '用户邮箱与 token 目标不一致', sql: "UPDATE users SET email='changed@example.test',email_normalized='changed@example.test' WHERE id=$1", target: 'user' },
  ];
  for (const scenario of cancellations) {
    test(`${scenario.name} 的 queued 邮件取消并清除密文，不调用 fetch`, async () => {
      const actor = await register(), queuedRow = await queued(actor.email);
      await owner.query(scenario.sql, [scenario.target === 'outbox' ? queuedRow.id : scenario.target === 'token' ? queuedRow.auth_token_id : queuedRow.user_id]);
      const initial = await outbox(queuedRow.id), fake = forbiddenFetch();
      assert.equal(await runMailBatch(pool, config, fake.fetcher), 'idle');
      await assertCancelled(initial);
      assert.equal(await runMailBatch(pool, config, fake.fetcher), 'idle');
      assert.equal(fake.calls.length, 0);
    });
  }

  test('disabled 仍执行过期、撤销和陈旧租约清理，保留有效队列且不发送', async () => {
    const active = await queued((await register()).email);
    const expired = await queued((await register()).email);
    const revoked = await queued((await register()).email);
    const stale = await queued((await register()).email);
    await owner.query("UPDATE email_outbox SET sensitive_payload_expires_at=now()-interval '1 second' WHERE id=$1", [expired.id]);
    await owner.query('UPDATE auth_tokens SET revoked_at=now() WHERE id=$1', [revoked.auth_token_id]);
    await owner.query(`UPDATE email_outbox SET status='sending',attempt_count=1,lease_token='fixture-stale-lease',
      lease_expires_at=now()-interval '1 second' WHERE id=$1`, [stale.id]);
    const expiredBefore = await outbox(expired.id), revokedBefore = await outbox(revoked.id), staleBefore = await outbox(stale.id);
    const disabled: Config = { ...config, emailMode: 'disabled', postmark: undefined, smtp: undefined };
    const fake = forbiddenFetch();
    assert.equal(await runMailBatch(pool, disabled, fake.fetcher), 'disabled');
    assert.deepEqual(await outbox(active.id), active);
    await assertCancelled(expiredBefore);
    await assertCancelled(revokedBefore);
    const staleAfter = await outbox(stale.id);
    assert.deepEqual(staleAfter, { ...staleBefore, status: 'failed', last_error_code: 'DELIVERY_UNKNOWN',
      lease_token: null, lease_expires_at: null, updated_at: staleAfter.updated_at });
    assert.equal(await runMailBatch(pool, disabled, fake.fetcher), 'disabled');
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(await outbox(stale.id), staleAfter);
    assert.equal(config.emailMode, 'postmark');
    assert.deepEqual(config.postmark, { serverToken, from });
  });

  test('旧 failed DELIVERY_UNKNOWN 保持不变，其他 queued 正常接受后仍不重发旧邮件', async () => {
    const legacy = await queued((await register()).email);
    await owner.query("UPDATE email_outbox SET status='failed',attempt_count=1,last_error_code='DELIVERY_UNKNOWN' WHERE id=$1", [legacy.id]);
    const legacyBefore = await outbox(legacy.id), initial = await queued((await register()).email);
    const fake = mockedFetch();
    assert.equal(await runMailBatch(pool, config, fake.fetcher), 'accepted');
    assertRequest(fake, initial);
    await assertAccepted(initial);
    assert.deepEqual(await outbox(legacy.id), legacyBefore);
    assert.equal(await runMailBatch(pool, config, fake.fetcher), 'idle');
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(await outbox(legacy.id), legacyBefore);
  });

  test('真实 PostgreSQL SKIP LOCKED 跳过被其他连接锁住的唯一 queued 邮件', async () => {
    const initial = await queued((await register()).email), blocker = await owner.connect();
    const fake = mockedFetch();
    let batch: ReturnType<typeof runMailBatch> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM email_outbox WHERE id=$1 FOR UPDATE', [initial.id]);
      batch = runMailBatch(pool, config, fake.fetcher);
      assert.equal(await bounded(batch), 'idle');
      assert.equal(fake.calls.length, 0);
      assert.deepEqual(await outbox(initial.id), initial);
    } finally {
      try { await blocker.query('ROLLBACK'); }
      finally {
        blocker.release();
        if (batch) await Promise.allSettled([batch]);
      }
    }
    assert.equal(await runMailBatch(pool, config, fake.fetcher), 'accepted');
    assertRequest(fake, initial);
    await assertAccepted(initial);
  });

  test('两个不同物理连接并发运行只领取一次，发送未完成时另一个 worker idle', async () => {
    const initial = await queued((await register()).email);
    const firstClient = await pool.connect(), secondClient = await pool.connect();
    const entered = gate(), finish = gate();
    const fake = mockedFetch(async () => { entered.release(); await finish.promise; return successResponse(); });
    let firstBatch: Promise<string> | undefined, secondBatch: Promise<string> | undefined;
    try {
      const firstPid = (await firstClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const secondPid = (await secondClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      assert.notEqual(firstPid, secondPid);
      firstBatch = runMailBatch(pinnedPool(firstClient), config, fake.fetcher);
      await bounded(Promise.race([entered.promise, firstBatch.then(() => { throw new Error('第一批次未进入发送屏障'); })]));
      const sending = await outbox(initial.id);
      assert.equal(sending.status, 'sending');
      assert.equal(sending.attempt_count, 1);
      secondBatch = runMailBatch(pinnedPool(secondClient), config, fake.fetcher);
      assert.equal(await bounded(secondBatch), 'idle');
      assert.equal(fake.calls.length, 1);
      finish.release();
      assert.equal(await firstBatch, 'accepted');
      assertRequest(fake, initial);
      await assertAccepted(initial);
      assert.equal(await runMailBatch(pool, config, fake.fetcher), 'idle');
      assert.equal(fake.calls.length, 1);
    } finally {
      finish.release();
      try { await Promise.allSettled([firstBatch, secondBatch].filter((batch): batch is Promise<string> => batch !== undefined)); }
      finally { firstClient.release(); secondClient.release(); }
    }
  });

  test('fetch 回调可从 owner 连接观察 sending 并立即取得行锁，HTTP 期间不持有数据库锁', async () => {
    const initial = await queued((await register()).email);
    const observer = await owner.connect();
    let observed = false;
    const fake = mockedFetch(async () => {
      await observer.query('BEGIN');
      try {
        const visible = (await observer.query<Outbox>('SELECT * FROM email_outbox WHERE id=$1 FOR UPDATE NOWAIT', [initial.id])).rows[0]!;
        assert.equal(visible.status, 'sending');
        assert.equal(visible.attempt_count, 1);
        assert.equal(visible.accepted_at, null);
        assert.ok(visible.lease_token);
        assert.ok(visible.lease_expires_at && visible.lease_expires_at > new Date());
        observed = true;
      } finally { await observer.query('ROLLBACK'); }
      return successResponse();
    });
    try {
      assert.equal(await runMailBatch(pool, config, fake.fetcher), 'accepted');
      assert.equal(observed, true);
      assertRequest(fake, initial);
      await assertAccepted(initial);
    } finally { observer.release(); }
  });

  test('供应商已接受但 accepted UPDATE 失败，记录 DELIVERY_UNKNOWN 而非 accepted，不再次领取', async () => {
    const initial = await queued((await register()).email);
    let rejectedAcceptedUpdates = 0;
    const failingPool = {
      connect: pool.connect.bind(pool),
      query: (sql: string, values?: unknown[]) => {
        if (/^UPDATE\s+email_outbox\s+SET\s+status='accepted'/i.test(sql.trim())) {
          rejectedAcceptedUpdates++;
          return Promise.reject(new Error('测试专用 accepted 写入失败'));
        }
        return pool.query(sql, values);
      },
    } as unknown as Pool;
    const fake = mockedFetch();
    assert.equal(await runMailBatch(failingPool, config, fake.fetcher), 'failed');
    assert.equal(rejectedAcceptedUpdates, 1);
    assertRequest(fake, initial);
    const failed = await assertFailed(initial, 'DELIVERY_UNKNOWN');
    assert.equal(await runMailBatch(failingPool, config, fake.fetcher), 'idle');
    assert.equal(await runMailBatch(pool, config, fake.fetcher), 'idle');
    assert.equal(rejectedAcceptedUpdates, 1);
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(await outbox(initial.id), failed);
  });

  test('供应商接受后租约已丢失导致 accepted UPDATE 零行，不能返回成功或重新发送', async () => {
    const initial = await queued((await register()).email);
    const fake = mockedFetch(async () => {
      await owner.query(`UPDATE email_outbox SET status='failed',last_error_code='DELIVERY_UNKNOWN',
        lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1`, [initial.id]);
      return successResponse();
    });
    assert.equal(await runMailBatch(pool, config, fake.fetcher), 'failed');
    assert.equal(fake.calls.length, 1);
    const row = await outbox(initial.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.last_error_code, 'DELIVERY_UNKNOWN');
    assert.equal(row.accepted_at, null);
    assert.equal(await runMailBatch(pool, config, fake.fetcher), 'idle');
    assert.equal(fake.calls.length, 1);
  });

  const reservationTemplates = [
    { key: 'reservation_received', subject: 'We received your reservation request', intro: 'We received your reservation request. It is a request only and is not confirmed until the restaurant responds.' },
    { key: 'reservation_confirmed', subject: 'The restaurant confirmed your reservation', intro: 'The restaurant confirmed your reservation.' },
    { key: 'reservation_declined', subject: 'The restaurant could not accept this reservation request', intro: 'The restaurant could not accept this reservation request.' },
    { key: 'reservation_cancelled', subject: 'This reservation has been cancelled', intro: 'This reservation has been cancelled.' },
  ];
  async function reservationFixture() {
    const actor = await register(), verification = await queued(actor.email);
    const token = await actionToken(verification, 'verify_email');
    assert.equal((await request('POST', '/auth/verify-email', undefined, { token })).statusCode, 204);
    const rid = id('rst'), reservationId = id('res');
    await owner.query(`INSERT INTO restaurants(id,created_by_user_id,create_idempotency_key,create_request_fingerprint,slug,name,primary_locale)
      VALUES($1,$2,$3,$4,$5,'邮件测试餐厅','en')`, [rid, verification.user_id, id('create'), 'f'.repeat(64), `mail-${randomUUID()}`]);
    const recipient = 'guest@example.test';
    const payload = { version: 1, reference: 'MAIL2026', local_date: '2026-12-24', local_time: '18:30', party_size: 4, restaurant_name: '邮件测试餐厅' };
    await owner.query(`INSERT INTO reservations(id,restaurant_id,public_reference,source,guest_name,guest_email,guest_email_normalized,
      party_size,requested_local_date,requested_local_time,timezone_snapshot,requested_start_at,
      privacy_notice_version,privacy_notice_shown_at,idempotency_key,initial_request_fingerprint)
      VALUES($1,$2,$3,'merchant_manual','邮件测试顾客',$4,$4,$5,$6,$7,'Europe/London','2026-12-24T18:30:00Z',
        'privacy-v1',now(),$8,$9)`, [reservationId, rid, payload.reference, recipient, payload.party_size,
      payload.local_date, payload.local_time, id('reserve'), 'e'.repeat(64)]);
    return { rid, reservationId, recipient, payload };
  }
  async function reservationOutbox(fixture: Awaited<ReturnType<typeof reservationFixture>>, template: string, token: string | null = null) {
    const outboxId = id('mail');
    await owner.query(`INSERT INTO email_outbox(id,restaurant_id,reservation_id,category,template_key,template_version,
      recipient_email,recipient_email_normalized,recipient_email_key,payload,sensitive_payload_ciphertext,
      sensitive_payload_expires_at,dedupe_key)
      VALUES($1,$2,$3,'transactional',$4,'v1',$5,$5,$6,$7,$8,now()+interval '30 days',$9)`,
    [outboxId, fixture.rid, fixture.reservationId, template, fixture.recipient, digest(config, fixture.recipient, 'email'),
      JSON.stringify(fixture.payload), token ? encryptAction(config, outboxId, token) : null, `${template}:${fixture.reservationId}:v1`]);
    const row = await outbox(outboxId);
    assert.equal(row.user_id, null);
    assert.equal(row.auth_token_id, null);
    assert.equal(row.status, 'queued');
    assert.equal(row.attempt_count, 0);
    return row;
  }

  test('四种订位模板混合队列无需 auth token 或密文，完整正文与持久化字段逐条一致', async () => {
    const fixture = await reservationFixture();
    const rows = await Promise.all(reservationTemplates.map(template => reservationOutbox(fixture, template.key)));
    const fake = mockedFetch();
    const seen = new Set<string>();
    for (let index = 0; index < rows.length; index++) {
      assert.equal(await runMailBatch(pool, config, fake.fetcher), 'accepted');
      const call = fake.calls[index]!;
      const message = JSON.parse(String(call.init?.body));
      const initial = rows.find(row => message.Headers[0].Value === `<${row.id}@localhost>`);
      assert.ok(initial);
      assert.equal(seen.has(initial.id), false);
      seen.add(initial.id);
      const template = reservationTemplates.find(value => value.key === initial.template_key)!;
      assertRequest({ fetcher: fake.fetcher, calls: [call] }, initial, `${template.subject} (MAIL2026)`,
        `${template.intro}\nReference: MAIL2026\nDate/time: 2026-12-24 18:30\nParty size: 4\nUse the link in your confirmation email to view status.\nIf you did not make this request, please ignore this email.`);
      await assertAccepted(initial);
    }
    assert.equal(seen.size, 4);
    const accepted = await Promise.all(rows.map(row => outbox(row.id)));
    assert.equal(await runMailBatch(pool, config, fake.fetcher), 'idle');
    assert.equal(fake.calls.length, 4);
    assert.deepEqual(await Promise.all(rows.map(row => outbox(row.id))), accepted);
  });

  test('订位 received 密文正确绑定 outbox ID，生成独立站状态链接并在接受后清除', async () => {
    const fixture = await reservationFixture(), token = secret();
    const initial = await reservationOutbox(fixture, 'reservation_received', token);
    assert.ok(initial.sensitive_payload_ciphertext);
    assert.equal(JSON.stringify(initial.payload).includes(token), false);
    const url = new URL(`/r/${encodeURIComponent(token)}`, config.website!.publicOrigin);
    const fake = mockedFetch();
    assert.equal(await runMailBatch(pool, config, fake.fetcher), 'accepted');
    const body = assertRequest(fake, initial, 'We received your reservation request (MAIL2026)',
      `We received your reservation request. It is a request only and is not confirmed until the restaurant responds.\nReference: MAIL2026\nDate/time: 2026-12-24 18:30\nParty size: 4\nView status or cancel: ${url.href}\nIf you did not make this request, please ignore this email.`);
    const link = new URL(body.TextBody.split('\n')[4]!.replace('View status or cancel: ', ''));
    assert.equal(link.origin, config.website!.publicOrigin);
    assert.equal(link.pathname, `/r/${token}`);
    assert.equal(link.search, '');
    assert.equal(link.hash, '');
    await assertAccepted(initial);
    assert.equal(await runMailBatch(pool, config, fake.fetcher), 'idle');
    assert.equal(fake.calls.length, 1);
  });

  test('空队列返回 idle，不调用 fetch', async () => {
    const fake = forbiddenFetch();
    assert.equal(await runMailBatch(pool, config, fake.fetcher), 'idle');
    assert.equal(fake.calls.length, 0);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM email_outbox')).rows[0].n, 0);
  });
});
