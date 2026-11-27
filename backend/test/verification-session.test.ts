import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createDecipheriv, randomUUID } from 'node:crypto';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { assertAppDatabase, id } from '../src/db.js';
import {
  digest, FLOW_COOKIE, hashPassword, readRegistrationProof, registrationProofCookie,
  REGISTRATION_COOKIE, SESSION_COOKIE, validCsrf, type RegistrationProof,
} from '../src/security.js';
import { validateSchema } from '../src/validation.js';
import { migrate } from '../scripts/migrate.js';
import { createTestDatabasePools, readTestDatabaseScope } from './database-scope.js';

const tables = 'ai_calendar_credit_grants,website_content_actions,website_version_sources,billing_subscriptions,billing_offer_grants,ai_quota_ledger,ai_quota_periods,ai_model_calls,billing_accounts,analytics_events,analytics_daily,website_model_calls,menu_jobs,menu_drafts,website_publish_actions,website_publications,website_jobs,website_versions,website_agents,asset_references,asset_upload_intents,assets,reservations,reservation_events,reservation_access_tokens,audit_logs,email_outbox,opening_hours,restaurant_members,auth_tokens,auth_sessions,auth_identities,restaurants,users';
const password = '验证测试-Valid-Password-2026!';
const replacementPassword = '验证测试-Replacement-Password-2026!';
const accepted = { message: '如该请求符合条件，我们将向对应邮箱发送说明。' };
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
let sequence = 0;
let pool: Pool, owner: Pool, app: FastifyInstance, config: Config;

interface Browser { cookie: string; csrf: string }
interface Action {
  userId: string; tokenId: string; outboxId: string; token: string; expires: Date;
}
interface Fixture extends Action {
  email: string; browser: Browser; proof: RegistrationProof; registrationHeader: string;
}
interface LoginBody {
  user: { id: string; email: string; display_name: string; locale: string; status: string; email_verified_at: string; created_at: string };
  session_expires_at: string; csrf_token: string;
}

async function request(method: HTTPMethods, path: string, browser?: Browser, payload?: Record<string, unknown>,
  overrides: Record<string, string | undefined> = {}, target = app) {
  const headers: Record<string, string> = { origin: config.appOrigin };
  if (browser) { headers.cookie = browser.cookie; headers['x-csrf-token'] = browser.csrf; }
  if (payload !== undefined) headers['content-type'] = 'application/json';
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete headers[name]; else headers[name] = value;
  }
  const response = await target.inject({ method, url: `/api/v1${path}`, headers,
    ...(payload === undefined ? {} : { payload }),
    remoteAddress: `127.18.${Math.floor(++sequence / 250)}.${sequence % 250 + 1}` });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.ok(response.headers['x-request-id']);
  return response;
}
type InjectResponse = Awaited<ReturnType<typeof request>>;

function setCookies(response: InjectResponse): string[] {
  const values = response.headers['set-cookie'];
  return values === undefined ? [] : Array.isArray(values) ? values : [values];
}
function setCookie(response: InjectResponse, name: string): string | undefined {
  return setCookies(response).find(value => value.startsWith(`${name}=`));
}
function cookieValue(header: string): string {
  const pair = header.split(';')[0]!;
  return decodeURIComponent(pair.slice(pair.indexOf('=') + 1));
}
function cookiePair(name: string, value: string): string { return `${name}=${encodeURIComponent(value)}`; }
function cookieAttributes(header: string): string[] { return header.split(';').slice(1).map(value => value.trim().toLowerCase()); }
function assertSecureCookie(header: string): void {
  const attributes = cookieAttributes(header);
  assert.ok(attributes.includes('path=/'));
  assert.ok(attributes.includes('secure'));
  assert.ok(attributes.includes('httponly'));
  assert.ok(attributes.includes('samesite=lax'));
  assert.ok(!attributes.some(value => value.startsWith('domain=')));
}
function assertNoSessionCookie(response: InjectResponse): void {
  assert.ok(setCookie(response, SESSION_COOKIE) === undefined, '响应不得设置会话 cookie');
}
function withProof(browser: Browser, raw: string | null): Browser {
  const cookies = browser.cookie.split('; ').filter(value => !value.startsWith(`${REGISTRATION_COOKIE}=`));
  if (raw !== null) cookies.push(cookiePair(REGISTRATION_COOKIE, raw));
  return { ...browser, cookie: cookies.join('; ') };
}
async function freshBrowser(): Promise<Browser> {
  const response = await request('GET', '/auth/csrf');
  assert.equal(response.statusCode, 200);
  const header = setCookie(response, FLOW_COOKIE);
  assert.ok(header !== undefined, '匿名浏览器应取得 authflow cookie');
  assertSecureCookie(header);
  validateSchema('CsrfResponse', response.json());
  return { cookie: cookiePair(FLOW_COOKIE, cookieValue(header)), csrf: response.json().csrf_token as string };
}
async function latestAction(email: string, purpose = 'verify_email'): Promise<Action> {
  const result = await owner.query(`SELECT t.id AS token_id,t.user_id,t.token_hash,t.expires_at,
    o.id AS outbox_id,o.sensitive_payload_ciphertext AS ciphertext
    FROM auth_tokens t JOIN email_outbox o ON o.auth_token_id=t.id
    WHERE o.recipient_email_normalized=$1 AND t.purpose=$2 ORDER BY t.created_at DESC,t.id DESC LIMIT 1`, [email, purpose]);
  assert.equal(result.rowCount, 1);
  const row = result.rows[0]!;
  assert.ok(typeof row.ciphertext === 'string', '测试动作应仍有可解密密文');
  const [version, iv, tag, ciphertext] = (row.ciphertext as string).split('.');
  assert.equal(version, 'v1');
  assert.ok(iv && tag && ciphertext, '动作密文格式有效');
  const decoder = createDecipheriv('aes-256-gcm', Buffer.from(config.outboxEncryptionKey, 'hex'), Buffer.from(iv, 'base64url'));
  decoder.setAAD(Buffer.from(row.outbox_id));
  decoder.setAuthTag(Buffer.from(tag, 'base64url'));
  const decoded = JSON.parse(Buffer.concat([decoder.update(Buffer.from(ciphertext, 'base64url')), decoder.final()]).toString('utf8'));
  assert.ok(typeof decoded.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(decoded.token), '动作令牌格式有效');
  assert.ok(row.token_hash === digest(config, decoded.token, purpose), '密文动作与数据库令牌绑定');
  return { userId: row.user_id, tokenId: row.token_id, outboxId: row.outbox_id, token: decoded.token, expires: row.expires_at };
}
async function register(email = `verification-${randomUUID()}@example.test`): Promise<Fixture> {
  const policy = await request('GET', '/auth/registration-policy');
  assert.equal(policy.statusCode, 200);
  const browser = await freshBrowser();
  const response = await request('POST', '/auth/register', browser, {
    email, password, display_name: '验证测试商家', locale: 'en',
    terms_version: policy.json().terms_version, accepted_terms: true,
  });
  assert.equal(response.statusCode, 202);
  assert.ok(JSON.stringify(response.json()) === JSON.stringify(accepted), '响应只包含原中性 accepted 消息');
  assertNoSessionCookie(response);
  assert.equal(setCookies(response).length, 1);
  const registrationHeader = setCookie(response, REGISTRATION_COOKIE);
  assert.ok(registrationHeader !== undefined, '注册应颁发独立的注册证明');
  assertSecureCookie(registrationHeader);
  assert.ok(cookieAttributes(registrationHeader).includes('max-age=86400'));
  const raw = cookieValue(registrationHeader), proof = readRegistrationProof(config, raw);
  assert.ok(proof !== null, '注册证明签名及期限有效');
  const action = await latestAction(email);
  assert.equal(proof.userId, action.userId);
  assert.equal(proof.tokenId, action.tokenId);
  assert.equal(proof.expires.getTime(), Math.floor(action.expires.getTime() / 1000) * 1000);
  const identity = (await owner.query('SELECT password_hash FROM auth_identities WHERE user_id=$1', [action.userId])).rows[0]!;
  assert.ok(proof.credential === digest(config, `${action.userId}\0${email}\0${identity.password_hash}`, 'registration-credential'),
    '注册证明绑定用户、邮箱及当前密码凭据');
  assert.deepEqual(Object.keys(proof).sort(), ['credential', 'expires', 'tokenId', 'userId']);
  for (const value of [email, password, identity.password_hash, action.token]) {
    assert.ok(!raw.includes(value), '注册证明不得包含邮箱、密码、密码哈希或邮件明文令牌');
  }
  return { ...action, email, browser: withProof(browser, raw), proof, registrationHeader };
}
async function sessionCount(userId: string): Promise<number> {
  return (await owner.query('SELECT count(*)::int AS n FROM auth_sessions WHERE user_id=$1', [userId])).rows[0]!.n;
}
async function auditCount(userId: string, action: string): Promise<number> {
  return (await owner.query('SELECT count(*)::int AS n FROM audit_logs WHERE actor_user_id=$1 AND action=$2', [userId, action])).rows[0]!.n;
}
async function snapshot(userId: string): Promise<string> {
  const queries = [
    'SELECT * FROM users WHERE id=$1 ORDER BY id',
    'SELECT * FROM auth_identities WHERE user_id=$1 ORDER BY id',
    'SELECT * FROM auth_tokens WHERE user_id=$1 ORDER BY id',
    'SELECT * FROM auth_sessions WHERE user_id=$1 ORDER BY id',
    'SELECT * FROM email_outbox WHERE user_id=$1 ORDER BY id',
    'SELECT * FROM audit_logs WHERE actor_user_id=$1 ORDER BY id',
  ];
  return JSON.stringify(await Promise.all(queries.map(async sql => (await owner.query(sql, [userId])).rows)));
}
async function assertVerified(action: Action, sessions = 0): Promise<void> {
  const user = (await owner.query('SELECT status,email_verified_at,last_login_at FROM users WHERE id=$1', [action.userId])).rows[0]!;
  assert.equal(user.status, 'active');
  assert.ok(user.email_verified_at instanceof Date);
  assert.equal(Boolean(user.last_login_at), sessions > 0);
  const token = (await owner.query('SELECT used_at,revoked_at FROM auth_tokens WHERE id=$1', [action.tokenId])).rows[0]!;
  assert.ok(token.used_at instanceof Date);
  assert.equal(token.revoked_at, null);
  const outbox = (await owner.query('SELECT status,sensitive_payload_ciphertext,attempt_count FROM email_outbox WHERE id=$1', [action.outboxId])).rows[0]!;
  assert.equal(outbox.status, 'cancelled');
  assert.ok(outbox.sensitive_payload_ciphertext === null);
  assert.equal(outbox.attempt_count, 0);
  assert.equal(await sessionCount(action.userId), sessions);
  assert.equal(await auditCount(action.userId, 'verify_email'), 1);
  assert.equal(await auditCount(action.userId, 'login'), sessions);
}
async function loginResult(response: InjectResponse, fixture: Fixture): Promise<{ browser: Browser; body: LoginBody; sessionId: string }> {
  assert.equal(response.statusCode, 200);
  const body = response.json<LoginBody>();
  validateSchema('LoginResponse', body);
  assert.equal(body.user.id, fixture.userId);
  assert.equal(body.user.email, fixture.email);
  assert.equal(body.user.status, 'active');
  const header = setCookie(response, SESSION_COOKIE);
  assert.ok(header !== undefined, '成功续会话应设置新的会话 cookie');
  assertSecureCookie(header);
  assert.ok(cookieAttributes(header).includes('max-age=86400'));
  const raw = cookieValue(header);
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(raw), '会话 cookie 是独立随机秘密');
  assert.ok(raw !== fixture.token, '会话秘密不复用邮件令牌');
  const hash = digest(config, raw, 'session');
  const result = await owner.query('SELECT id,user_id,expires_at,revoked_at FROM auth_sessions WHERE session_secret_hash=$1', [hash]);
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0]!.user_id, fixture.userId);
  assert.equal(result.rows[0]!.revoked_at, null);
  assert.equal(result.rows[0]!.expires_at.toISOString(), body.session_expires_at);
  assert.ok(validCsrf(config, `session:${hash}`, body.csrf_token), '响应 CSRF 绑定新会话及期限');
  for (const name of [FLOW_COOKIE, REGISTRATION_COOKIE]) {
    const cleared = setCookie(response, name);
    assert.ok(cleared !== undefined && cookieValue(cleared) === '', '成功后清除注册及匿名流程 cookie');
    assertSecureCookie(cleared);
  }
  return { browser: { cookie: cookiePair(SESSION_COOKIE, raw), csrf: body.csrf_token }, body, sessionId: result.rows[0]!.id };
}
async function continueSession(fixture: Fixture) {
  const response = await request('POST', '/auth/verify-email', fixture.browser, { token: fixture.token, continue_session: true });
  return loginResult(response, fixture);
}
async function ageToken(action: Action): Promise<void> {
  await owner.query("UPDATE auth_tokens SET created_at=now()-interval '61 seconds' WHERE id=$1", [action.tokenId]);
}
function wrappedPool(intercept: (client: PoolClient, sql: string, values: unknown[] | undefined) => Promise<void>): Pool {
  return {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql: string, values?: unknown[]) => { await intercept(client, sql, values); return client.query(sql, values); },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
}
async function withApp(testPool: Pool, run: (target: FastifyInstance) => Promise<void>): Promise<void> {
  const target = createApp({ pool: testPool, config });
  try { await target.ready(); await run(target); } finally { await target.close(); }
}

// 敏感状态仅作布尔比较，断言失败时不输出 cookie、密码、令牌或密文。
describe('邮箱验证与注册浏览器续会话真实 PostgreSQL 集成', { concurrency: false }, () => {
  let databaseReady = false;
  before(async () => {
    globalThis.fetch = async () => { networkAttempts++; throw new Error('验证测试禁止网络 fetch'); };
    const scope = readTestDatabaseScope();
    config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: scope.databaseUrl, MIGRATION_DATABASE_URL: scope.migrationDatabaseUrl,
      APP_ORIGIN: 'https://localhost:5173', TOKEN_PEPPER: 'verification-fixture-pepper-'.repeat(4),
      CURSOR_SECRET: 'verification-fixture-cursor-'.repeat(4), OUTBOX_ENCRYPTION_KEY: 'b6'.repeat(32), EMAIL_MODE: 'disabled' });
    ({ owner, pool } = await createTestDatabasePools(scope));
    await migrate(owner, 'restaurant_test_app');
    await assertAppDatabase(pool);
    databaseReady = true;
    app = createApp({ pool, config });
    await app.ready();
    assert.equal(config.emailMode, 'disabled');
  });
  beforeEach(async () => { await owner.query(`TRUNCATE ${tables}`); });
  after(async () => {
    try {
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
    } finally {
      globalThis.fetch = originalFetch;
      assert.equal(networkAttempts, 0, '所有验证、重发及登录场景均不得调用网络 fetch');
    }
  });

  test('同注册浏览器显式续会话返回 LoginResponse，新 cookie 可访问 me 并执行 CSRF 写请求', async () => {
    const fixture = await register();
    const login = await continueSession(fixture);
    await assertVerified(fixture, 1);
    const me = await request('GET', '/auth/me', { ...login.browser, csrf: '' }, undefined, { origin: undefined, 'x-csrf-token': undefined });
    assert.equal(me.statusCode, 200);
    assert.deepEqual(me.json(), { user: login.body.user, session_expires_at: login.body.session_expires_at });
    const before = await snapshot(fixture.userId);
    const write = await request('POST', '/auth/password-reset-requests', login.browser, { email: 'no-account@example.test' });
    assert.equal(write.statusCode, 202);
    assert.ok(JSON.stringify(write.json()) === JSON.stringify(accepted), '响应只包含原中性 accepted 消息');
    assertNoSessionCookie(write);
    assert.ok(await snapshot(fixture.userId) === before, '有效会话 CSRF 写请求不改动不存在邮箱对应的状态');
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM email_outbox')).rows[0]!.n, 1);
    const staleCsrf = await request('POST', '/auth/password-reset-requests', { ...login.browser, csrf: fixture.browser.csrf }, { email: 'no-account@example.test' });
    assert.equal(staleCsrf.statusCode, 403);
  });

  for (const flag of ['缺省', 'false'] as const) {
    test(`${flag} continue_session 保持 token-only 204 兼容，不要求 Origin 或 CSRF，不创建会话`, async () => {
      const fixture = await register();
      const response = await request('POST', '/auth/verify-email', flag === 'false' ? fixture.browser : undefined,
        { token: fixture.token, ...(flag === 'false' ? { continue_session: false } : {}) }, { origin: undefined, 'x-csrf-token': undefined });
      assert.equal(response.statusCode, 204);
      assert.ok(response.body === '', '204 响应体必须为空');
      assert.equal(setCookies(response).length, 0);
      await assertVerified(fixture);
    });
  }

  test('另一浏览器新 authflow 即使有邮件令牌和有效 CSRF，也只验证为 204，不自动登录', async () => {
    const fixture = await register(), other = await freshBrowser();
    const response = await request('POST', '/auth/verify-email', other, { token: fixture.token, continue_session: true });
    assert.equal(response.statusCode, 204);
    assert.equal(setCookies(response).length, 0);
    await assertVerified(fixture);
    assert.equal((await request('GET', '/auth/me', other)).statusCode, 401);
  });

  const rejectedWrites: { name: string; headers: Record<string, string | undefined> }[] = [
    { name: '缺少 CSRF', headers: { 'x-csrf-token': undefined } },
    { name: '错误 CSRF', headers: { 'x-csrf-token': 'invalid-csrf' } },
    { name: '缺少 Origin', headers: { origin: undefined } },
    { name: '错误 Origin', headers: { origin: 'https://other.example.test' } },
    { name: '缺少 authflow cookie', headers: { cookie: undefined } },
  ];
  for (const scenario of rejectedWrites) {
    test(`显式续会话${scenario.name} 返回 403，用户、动作、队列和审计均无副作用`, async () => {
      const fixture = await register(), before = await snapshot(fixture.userId);
      const response = await request('POST', '/auth/verify-email', fixture.browser,
        { token: fixture.token, continue_session: true }, scenario.headers);
      assert.equal(response.statusCode, 403);
      assert.equal(setCookies(response).length, 0);
      assert.ok(await snapshot(fixture.userId) === before, '403 必须发生在验证事务之前');
      assert.equal(await sessionCount(fixture.userId), 0);
    });
  }

  test('另一 authflow 搭配原注册 CSRF 返回 403，不消费验证令牌', async () => {
    const fixture = await register(), other = await freshBrowser(), before = await snapshot(fixture.userId);
    const response = await request('POST', '/auth/verify-email', { ...other, csrf: fixture.browser.csrf }, { token: fixture.token, continue_session: true });
    assert.equal(response.statusCode, 403);
    assertNoSessionCookie(response);
    assert.ok(await snapshot(fixture.userId) === before, 'CSRF 不得跨 authflow 复用');
  });

  const invalidProofs = ['缺失', '格式无效', '签名篡改', '过期', '错误用户 ID', '错误令牌 ID', '错误凭据'] as const;
  for (const variant of invalidProofs) {
    test(`注册证明${variant}：有效邮件动作仍验证为 204，但不创建登录`, async () => {
      const fixture = await register();
      const original = cookieValue(fixture.registrationHeader);
      let raw: string | null = original;
      if (variant === '缺失') raw = null;
      else if (variant === '格式无效') raw = 'invalid%proof.with+special/characters=';
      else if (variant === '签名篡改') raw = `${original.slice(0, -1)}${original.endsWith('0') ? '1' : '0'}`;
      else {
        const changes: Partial<RegistrationProof> = variant === '过期' ? { expires: new Date(Date.now() - 2000) }
          : variant === '错误用户 ID' ? { userId: id('usr') }
          : variant === '错误令牌 ID' ? { tokenId: id('tok') }
          : { credential: digest(config, 'wrong-fixture-credential', 'registration-credential') };
        raw = registrationProofCookie(config, { ...fixture.proof, ...changes });
        assert.equal(readRegistrationProof(config, raw) !== null, variant !== '过期');
      }
      if (variant === '格式无效' || variant === '签名篡改') assert.ok(readRegistrationProof(config, raw) === null);
      const response = await request('POST', '/auth/verify-email', withProof(fixture.browser, raw), { token: fixture.token, continue_session: true });
      assert.equal(response.statusCode, 204);
      assert.equal(setCookies(response).length, 0);
      await assertVerified(fixture);
    });
  }

  test('注册后当前密码凭据改变：旧证明只可验证邮件，不可自动登录', async () => {
    const fixture = await register(), hash = await hashPassword(replacementPassword);
    await owner.query('UPDATE auth_identities SET password_hash=$1,credential_changed_at=now(),updated_at=now() WHERE user_id=$2', [hash, fixture.userId]);
    const response = await request('POST', '/auth/verify-email', fixture.browser, { token: fixture.token, continue_session: true });
    assert.equal(response.statusCode, 204);
    assertNoSessionCookie(response);
    await assertVerified(fixture);
    const current = (await owner.query('SELECT password_hash FROM auth_identities WHERE user_id=$1', [fixture.userId])).rows[0]!;
    assert.ok(current.password_hash === hash, '验证不得回写旧密码凭据');
  });

  const unavailable = [
    { name: '暂停用户', sql: "UPDATE users SET status='suspended' WHERE id=$1", target: 'user' },
    { name: '删除用户', sql: "UPDATE users SET status='deleted' WHERE id=$1", target: 'user' },
    { name: '过期动作', sql: "UPDATE auth_tokens SET expires_at=now()-interval '1 second' WHERE id=$1", target: 'token' },
    { name: '撤销动作', sql: 'UPDATE auth_tokens SET revoked_at=now() WHERE id=$1', target: 'token' },
    { name: '邮箱改变', sql: "UPDATE users SET email='changed@example.test',email_normalized='changed@example.test' WHERE id=$1", target: 'user' },
    { name: '动作目的错误', sql: "UPDATE auth_tokens SET purpose='reset_password',token_hash=$2 WHERE id=$1", target: 'purpose' },
  ] as const;
  for (const scenario of unavailable) {
    test(`${scenario.name} 返回 410，不设置会话且不改变验证状态`, async () => {
      const fixture = await register();
      await owner.query(scenario.sql, scenario.target === 'user' ? [fixture.userId]
        : scenario.target === 'purpose' ? [fixture.tokenId, digest(config, fixture.token, 'reset_password')] : [fixture.tokenId]);
      const before = await snapshot(fixture.userId);
      const response = await request('POST', '/auth/verify-email', fixture.browser, { token: fixture.token, continue_session: true });
      assert.equal(response.statusCode, 410);
      assert.equal(setCookies(response).length, 0);
      assert.ok(await snapshot(fixture.userId) === before, '不可用动作不得写验证、登录或清理状态');
      assert.equal(await sessionCount(fixture.userId), 0);
    });
  }

  test('重复注册 202 的证明 cookie 长度与属性相同，dummy 不能登录且旧凭据和单一账号不变', async () => {
    const fixture = await register(), other = await freshBrowser(), before = await snapshot(fixture.userId);
    const response = await request('POST', '/auth/register', other, { email: fixture.email, password: replacementPassword,
      display_name: '另一注册请求', locale: 'en', terms_version: 'terms-v1', accepted_terms: true });
    assert.equal(response.statusCode, 202);
    assert.ok(JSON.stringify(response.json()) === JSON.stringify(accepted), '响应只包含原中性 accepted 消息');
    assertNoSessionCookie(response);
    assert.equal(setCookies(response).length, 1);
    const header = setCookie(response, REGISTRATION_COOKIE);
    assert.ok(header !== undefined);
    assertSecureCookie(header);
    assert.equal(header.length, fixture.registrationHeader.length);
    assert.deepEqual(cookieAttributes(header), cookieAttributes(fixture.registrationHeader));
    const raw = cookieValue(header), dummy = readRegistrationProof(config, raw);
    assert.ok(dummy !== null, '重复注册仍返回有效的中性证明形状');
    assert.notEqual(dummy.userId, fixture.userId);
    assert.notEqual(dummy.tokenId, fixture.tokenId);
    assert.ok(!raw.includes(fixture.email), '证明不能暴露请求邮箱是否已存在');
    assert.ok(await snapshot(fixture.userId) === before, '重复注册不得替换旧密码哈希或新增令牌、审计');
    for (const table of ['users', 'auth_identities', 'auth_tokens', 'email_outbox']) {
      assert.equal((await owner.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n, 1);
    }
    const verified = await request('POST', '/auth/verify-email', withProof(other, raw), { token: fixture.token, continue_session: true });
    assert.equal(verified.statusCode, 204);
    assertNoSessionCookie(verified);
    await assertVerified(fixture);
  });

  test('60 秒内重发返回原中性 accepted，不重绑证明或新增排队动作', async () => {
    const fixture = await register(), before = await snapshot(fixture.userId);
    const response = await request('POST', '/auth/verification-emails', fixture.browser, { email: fixture.email });
    assert.equal(response.statusCode, 202);
    assert.ok(JSON.stringify(response.json()) === JSON.stringify(accepted), '响应只包含原中性 accepted 消息');
    assert.equal(setCookies(response).length, 0);
    assert.ok(await snapshot(fixture.userId) === before, 'queueAction 返回 null 时必须保持原状态');
  });

  test('原有效注册证明重发绑定新令牌，保留原到期时间不延长，旧 failed 队列原样保留', async () => {
    const fixture = await register();
    await ageToken(fixture);
    await owner.query("UPDATE email_outbox SET status='failed',attempt_count=1,last_error_code='DELIVERY_UNKNOWN' WHERE id=$1", [fixture.outboxId]);
    const legacyBefore = JSON.stringify((await owner.query('SELECT * FROM email_outbox WHERE id=$1', [fixture.outboxId])).rows[0]);
    const resendStarted = Date.now();
    const response = await request('POST', '/auth/verification-emails', fixture.browser, { email: fixture.email });
    assert.equal(response.statusCode, 202);
    assert.ok(JSON.stringify(response.json()) === JSON.stringify(accepted), '响应只包含原中性 accepted 消息');
    assertNoSessionCookie(response);
    const header = setCookie(response, REGISTRATION_COOKIE);
    assert.ok(header !== undefined);
    assertSecureCookie(header);
    assert.equal(setCookies(response).length, 1);
    const proof = readRegistrationProof(config, cookieValue(header));
    assert.ok(proof !== null);
    const next = await latestAction(fixture.email);
    assert.notEqual(next.tokenId, fixture.tokenId);
    assert.ok(next.token !== fixture.token, '重发必须创建独立新令牌');
    assert.equal(proof.userId, fixture.proof.userId);
    assert.equal(proof.tokenId, next.tokenId);
    assert.ok(proof.credential === fixture.proof.credential, '重绑不改变注册凭据');
    assert.equal(proof.expires.getTime(), fixture.proof.expires.getTime());
    assert.ok(next.expires.getTime() > proof.expires.getTime(), '新邮件期限不得延长旧浏览器证明期限');
    const maxAge = Number(cookieAttributes(header).find(value => value.startsWith('max-age='))?.slice('max-age='.length));
    assert.ok(maxAge > 0 && maxAge <= 86400 && maxAge <= Math.floor((proof.expires.getTime() - resendStarted) / 1000));
    assert.ok(JSON.stringify((await owner.query('SELECT * FROM email_outbox WHERE id=$1', [fixture.outboxId])).rows[0]) === legacyBefore,
      '旧 failed DELIVERY_UNKNOWN 邮件不得清密文、改状态或重试');
    const oldToken = (await owner.query('SELECT used_at,revoked_at FROM auth_tokens WHERE id=$1', [fixture.tokenId])).rows[0]!;
    assert.equal(oldToken.used_at, null);
    assert.ok(oldToken.revoked_at instanceof Date);
    assert.equal((await request('POST', '/auth/verify-email', fixture.browser, { token: fixture.token, continue_session: true })).statusCode, 410);
    const rebound = { ...fixture, ...next, proof, registrationHeader: header, browser: withProof(fixture.browser, cookieValue(header)) };
    await continueSession(rebound);
    await assertVerified(next, 1);
    assert.ok(JSON.stringify((await owner.query('SELECT * FROM email_outbox WHERE id=$1', [fixture.outboxId])).rows[0]) === legacyBefore);
  });

  test('缩短的有效证明在重发后仍保持原短期限，不能恢复 24 小时浏览器权限', async () => {
    const fixture = await register();
    await ageToken(fixture);
    const proof = { ...fixture.proof, expires: new Date(Math.floor(Date.now() / 1000) * 1000 + 300000) };
    const response = await request('POST', '/auth/verification-emails', withProof(fixture.browser, registrationProofCookie(config, proof)), { email: fixture.email });
    assert.equal(response.statusCode, 202);
    assert.ok(JSON.stringify(response.json()) === JSON.stringify(accepted), '响应只包含原中性 accepted 消息');
    const header = setCookie(response, REGISTRATION_COOKIE);
    assert.ok(header !== undefined);
    const rebound = readRegistrationProof(config, cookieValue(header));
    assert.ok(rebound !== null);
    assert.equal(rebound.expires.getTime(), proof.expires.getTime());
    assert.equal(rebound.tokenId, (await latestAction(fixture.email)).tokenId);
    const maxAge = Number(cookieAttributes(header).find(value => value.startsWith('max-age='))?.slice('max-age='.length));
    assert.ok(maxAge > 0 && maxAge <= 300, '重发 cookie Max-Age 只允许原剩余期限');
  });

  test('匿名新浏览器重发可以排队但拿不到注册证明，验证新邮件仍不得登录', async () => {
    const fixture = await register(), other = await freshBrowser();
    await ageToken(fixture);
    const response = await request('POST', '/auth/verification-emails', other, { email: fixture.email });
    assert.equal(response.statusCode, 202);
    assert.ok(JSON.stringify(response.json()) === JSON.stringify(accepted), '响应只包含原中性 accepted 消息');
    assert.equal(setCookies(response).length, 0);
    const next = await latestAction(fixture.email);
    assert.notEqual(next.tokenId, fixture.tokenId);
    const oldOutbox = (await owner.query('SELECT status,sensitive_payload_ciphertext,attempt_count FROM email_outbox WHERE id=$1', [fixture.outboxId])).rows[0]!;
    assert.equal(oldOutbox.status, 'cancelled');
    assert.ok(oldOutbox.sensitive_payload_ciphertext === null);
    assert.equal(oldOutbox.attempt_count, 0);
    const verification = await request('POST', '/auth/verify-email', other, { token: next.token, continue_session: true });
    assert.equal(verification.statusCode, 204);
    assertNoSessionCookie(verification);
    await assertVerified(next);
  });

  test('匿名重发后的新令牌也不能搭配旧注册证明自动登录', async () => {
    const fixture = await register(), other = await freshBrowser();
    await ageToken(fixture);
    assert.equal((await request('POST', '/auth/verification-emails', other, { email: fixture.email })).statusCode, 202);
    const next = await latestAction(fixture.email);
    const response = await request('POST', '/auth/verify-email', fixture.browser, { token: next.token, continue_session: true });
    assert.equal(response.statusCode, 204);
    assertNoSessionCookie(response);
    await assertVerified(next);
  });

  test('不存在的邮箱重发和找回均只返回 accepted，不排队、不发证明', async () => {
    const browser = await freshBrowser();
    for (const path of ['/auth/verification-emails', '/auth/password-reset-requests']) {
      const response = await request('POST', path, browser, { email: 'no-account@example.test' });
      assert.equal(response.statusCode, 202);
      assert.ok(JSON.stringify(response.json()) === JSON.stringify(accepted), '响应只包含原中性 accepted 消息');
      assert.equal(setCookies(response).length, 0);
    }
    for (const table of ['users', 'auth_tokens', 'auth_sessions', 'email_outbox', 'audit_logs']) {
      assert.equal((await owner.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n, 0);
    }
  });

  test('密码找回维持原 accepted 响应体，排队 reset_password 且不返回内部 proof 包装', async () => {
    const fixture = await register();
    assert.equal((await request('POST', '/auth/verify-email', undefined, { token: fixture.token })).statusCode, 204);
    const response = await request('POST', '/auth/password-reset-requests', fixture.browser, { email: fixture.email });
    assert.equal(response.statusCode, 202);
    assert.ok(JSON.stringify(response.json()) === JSON.stringify(accepted), '响应只包含原中性 accepted 消息');
    assert.equal(setCookies(response).length, 0);
    const reset = await latestAction(fixture.email, 'reset_password');
    assert.equal(reset.userId, fixture.userId);
    assert.notEqual(reset.tokenId, fixture.tokenId);
    assert.equal(await sessionCount(fixture.userId), 0);
    const before = await snapshot(fixture.userId);
    const throttled = await request('POST', '/auth/password-reset-requests', fixture.browser, { email: fixture.email });
    assert.equal(throttled.statusCode, 202);
    assert.ok(JSON.stringify(throttled.json()) === JSON.stringify(accepted), '找回限流仍只返回原中性 accepted 消息');
    assert.equal(setCookies(throttled).length, 0);
    assert.ok(await snapshot(fixture.userId) === before);
  });

  test('已使用令牌无 SESSION cookie 重试为 204，不再创建会话、审计或更改已验证状态', async () => {
    const fixture = await register();
    await continueSession(fixture);
    const before = await snapshot(fixture.userId);
    const retry = await request('POST', '/auth/verify-email', fixture.browser, { token: fixture.token, continue_session: true });
    assert.equal(retry.statusCode, 204);
    assert.equal(setCookies(retry).length, 0);
    assert.ok(await snapshot(fixture.userId) === before, '已使用令牌不能补建第二个会话');
    const legacyRetry = await request('POST', '/auth/verify-email', undefined, { token: fixture.token }, { origin: undefined });
    assert.equal(legacyRetry.statusCode, 204);
    assert.equal(setCookies(legacyRetry).length, 0);
    assert.ok(await snapshot(fixture.userId) === before, 'token-only 重试同样不得新增副作用');
    await assertVerified(fixture, 1);
  });

  test('已使用令牌搭配同账号当前 SESSION 和 CSRF 返回原会话 200，不设置 SESSION、不新增记录', async () => {
    const fixture = await register(), login = await continueSession(fixture), before = await snapshot(fixture.userId);
    const retry = await request('POST', '/auth/verify-email', login.browser, { token: fixture.token, continue_session: true });
    assert.equal(retry.statusCode, 200);
    validateSchema('LoginResponse', retry.json());
    assertNoSessionCookie(retry);
    assert.ok(JSON.stringify(retry.json()) === JSON.stringify(login.body), '续会话返回原用户、原期限和原 CSRF');
    assert.ok(await snapshot(fixture.userId) === before, '匹配的当前会话重试不得新增登录或延长期限');
    assert.equal(await sessionCount(fixture.userId), 1);
    assert.equal((await request('GET', '/auth/me', login.browser)).statusCode, 200);
  });

  test('登录另一账号时目标证明只验证目标邮件为 204，原账号 me 与会话保持且不被撤销', async () => {
    const other = await register(), login = await continueSession(other), fixture = await register();
    const otherBefore = await snapshot(other.userId);
    const browser = { cookie: `${login.browser.cookie}; ${fixture.browser.cookie}`, csrf: login.browser.csrf };
    const response = await request('POST', '/auth/verify-email', browser, { token: fixture.token, continue_session: true });
    assert.equal(response.statusCode, 204);
    assert.equal(setCookies(response).length, 0);
    await assertVerified(fixture);
    assert.ok(await snapshot(other.userId) === otherBefore, '验证另一账号不得撤销或替换当前账号会话');
    const me = await request('GET', '/auth/me', login.browser);
    assert.equal(me.statusCode, 200);
    assert.deepEqual(me.json(), { user: login.body.user, session_expires_at: login.body.session_expires_at });
    assert.equal((await owner.query('SELECT revoked_at FROM auth_sessions WHERE id=$1', [login.sessionId])).rows[0]!.revoked_at, null);
  });

  test('logout 后重放原证明和已使用邮件令牌为 204，不复活撤销会话', async () => {
    const fixture = await register(), login = await continueSession(fixture);
    const logout = await request('POST', '/auth/logout', login.browser);
    assert.equal(logout.statusCode, 204);
    const cleared = setCookie(logout, SESSION_COOKIE);
    assert.ok(cleared !== undefined && cookieValue(cleared) === '');
    const before = await snapshot(fixture.userId);
    for (const cookie of [fixture.browser.cookie, `${fixture.browser.cookie}; ${login.browser.cookie}`]) {
      const replay = await request('POST', '/auth/verify-email', { cookie, csrf: fixture.browser.csrf }, { token: fixture.token, continue_session: true });
      assert.equal(replay.statusCode, 204);
      assert.equal(setCookies(replay).length, 0);
      assert.ok(await snapshot(fixture.userId) === before, '退出后的重放不得恢复或创建会话');
    }
    assert.equal(await sessionCount(fixture.userId), 1);
    assert.ok((await owner.query('SELECT revoked_at FROM auth_sessions WHERE id=$1', [login.sessionId])).rows[0]!.revoked_at instanceof Date);
    assert.equal((await request('GET', '/auth/me', login.browser)).statusCode, 401);
  });

  test('两个相同注册证明显式续会话并发进入事务，只返回一个 200、一个 204 且会话只有一条', async () => {
    const fixture = await register();
    let arrivals = 0, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const pids = new Set<number>();
    const concurrentPool = wrappedPool(async (client, sql) => {
      if (!/^SELECT user_id FROM auth_tokens\b/i.test(sql.trim())) return;
      pids.add((await client.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
      if (++arrivals === 2) release();
      await barrier;
    });
    await withApp(concurrentPool, async target => {
      const timer = setTimeout(release, 5000);
      const requests = [1, 2].map(() => request('POST', '/auth/verify-email', fixture.browser, { token: fixture.token, continue_session: true }, {}, target));
      try {
        const responses = await Promise.all(requests);
        assert.equal(arrivals, 2);
        assert.equal(pids.size, 2);
        assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 204]);
        const success = responses.find(response => response.statusCode === 200)!;
        const noLogin = responses.find(response => response.statusCode === 204)!;
        await loginResult(success, fixture);
        assert.equal(setCookies(noLogin).length, 0);
        await assertVerified(fixture, 1);
      } finally { clearTimeout(timer); release(); await Promise.allSettled(requests); }
    });
  });

  test('当前会话在 requireWrite 读取后被撤销，锁内复核返回 401，不返回失效会话', async () => {
    const fixture = await register(), login = await continueSession(fixture);
    let revoked = 0, afterRevocation = '';
    const racingPool = wrappedPool(async (_client, sql) => {
      if (!/^SELECT user_id FROM auth_tokens\b/i.test(sql.trim())) return;
      revoked++;
      await owner.query('UPDATE auth_sessions SET revoked_at=now(),updated_at=now() WHERE id=$1', [login.sessionId]);
      afterRevocation = await snapshot(fixture.userId);
    });
    await withApp(racingPool, async target => {
      const response = await request('POST', '/auth/verify-email', login.browser, { token: fixture.token, continue_session: true }, {}, target);
      assert.equal(revoked, 1);
      assert.equal(response.statusCode, 401);
      assert.equal(setCookies(response).length, 0);
      assert.ok(await snapshot(fixture.userId) === afterRevocation, '锁内会话复核失败不得修改验证或复活登录');
    });
    assert.equal(await sessionCount(fixture.userId), 1);
    assert.equal((await request('GET', '/auth/me', login.browser)).statusCode, 401);
  });

  test('邮件令牌锁等待跨过到期边界后必须返回 410，不能用锁前时间确认', async () => {
    const fixture = await register();
    const blocker = await owner.connect();
    let pending: Promise<InjectResponse> | undefined;
    try {
      await owner.query("UPDATE auth_tokens SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [fixture.tokenId]);
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM auth_tokens WHERE id=$1 FOR UPDATE', [fixture.tokenId]);
      pending = request('POST', '/auth/verify-email', fixture.browser, { token: fixture.token, continue_session: true });
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        if ((await owner.query("SELECT 1 FROM pg_stat_activity WHERE usename='restaurant_test_app' AND $1::int=ANY(pg_blocking_pids(pid))", [pid])).rowCount) { blocked = true; break; }
      }
      assert.ok(blocked, '请求必须确实等待令牌行锁');
      await blocker.query('SELECT pg_sleep(GREATEST(0,extract(epoch FROM expires_at-clock_timestamp()))+0.02) FROM auth_tokens WHERE id=$1', [fixture.tokenId]);
      await blocker.query('COMMIT');
      const response = await pending;
      assert.equal(response.statusCode, 410);
      assert.equal(setCookies(response).length, 0);
      assert.equal(await sessionCount(fixture.userId), 0);
      assert.equal((await owner.query('SELECT used_at FROM auth_tokens WHERE id=$1', [fixture.tokenId])).rows[0].used_at, null);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await Promise.allSettled([pending]); }
  });

  test('重发等待用户锁直到原注册证明过期时，只排新邮件，不重设或延长注册证明', async () => {
    const fixture = await register();
    await owner.query("UPDATE auth_tokens SET created_at=now()-interval '2 minutes' WHERE id=$1", [fixture.tokenId]);
    const expires = new Date(Date.now() + 2000);
    const browser = withProof(fixture.browser, registrationProofCookie(config, { ...fixture.proof, expires }));
    const blocker = await owner.connect();
    let pending: Promise<InjectResponse> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [fixture.userId]);
      pending = request('POST', '/auth/verification-emails', browser, { email: fixture.email });
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        if ((await owner.query("SELECT 1 FROM pg_stat_activity WHERE usename='restaurant_test_app' AND $1::int=ANY(pg_blocking_pids(pid))", [pid])).rowCount) { blocked = true; break; }
      }
      assert.ok(blocked, '重发必须确实等待用户行锁');
      await blocker.query('SELECT pg_sleep(GREATEST(0,extract(epoch FROM $1::timestamptz-clock_timestamp()))+0.02)', [expires]);
      await blocker.query('COMMIT');
      const response = await pending;
      assert.equal(response.statusCode, 202);
      assert.equal(setCookies(response).length, 0);
      assert.notEqual((await latestAction(fixture.email)).tokenId, fixture.tokenId);
      assert.equal(await sessionCount(fixture.userId), 0);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await Promise.allSettled([pending]); }
  });

  test('auth_sessions INSERT 失败原子回滚用户验证、令牌使用、队列清理及审计，不设置 cookie', async () => {
    const fixture = await register(), before = await snapshot(fixture.userId);
    let rejectedInserts = 0;
    const failingPool = wrappedPool(async (_client, sql) => {
      if (/^INSERT INTO auth_sessions\b/i.test(sql.trim())) {
        rejectedInserts++;
        throw new Error('验证测试专用会话写入失败');
      }
    });
    await withApp(failingPool, async target => {
      const response = await request('POST', '/auth/verify-email', fixture.browser, { token: fixture.token, continue_session: true }, {}, target);
      assert.equal(response.statusCode, 503);
      assert.equal(rejectedInserts, 1);
      assert.equal(setCookies(response).length, 0);
      assert.ok(await snapshot(fixture.userId) === before, '会话 INSERT 失败应回滚全部验证与登录副作用');
      assert.equal(await sessionCount(fixture.userId), 0);
      assert.equal(await auditCount(fixture.userId, 'verify_email'), 0);
      assert.equal(await auditCount(fixture.userId, 'login'), 0);
    });
    await continueSession(fixture);
    await assertVerified(fixture, 1);
  });
});
