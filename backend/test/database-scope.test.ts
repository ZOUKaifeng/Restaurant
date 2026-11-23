import assert from 'node:assert/strict';
import { beforeEach, test, type TestContext } from 'node:test';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { assertWebsiteBackfillApply } from '../scripts/backfill-website-sources.js';
import { assertTestDatabaseConnection, createTestDatabasePool, readTestDatabaseScope,
  type TestDatabaseIdentity, type TestDatabaseScope } from './database-scope.js';

// 本文件不连接真实 PG；任何意外连接立即失败。
beforeEach(t => { (t as TestContext).mock.method(pg.Pool.prototype, 'connect', () => assert.fail('作用域单元测试禁止真实数据库连接')); });
function fixture(port = '55439', major?: string): NodeJS.ProcessEnv {
  return { TEST_DATABASE_URL: `postgresql://restaurant_test_app:fixture-only-app-password@127.0.0.1:${port}/restaurant_test`,
    TEST_MIGRATION_DATABASE_URL: `postgresql://restaurant_test_owner:fixture-only-owner-password@127.0.0.1:${port}/restaurant_test`,
    ...(port === '55439' ? {} : { TEST_PG_PORT: port }), ...(major === undefined ? {} : { TEST_PG_MAJOR: major }) };
}
const keys = ['TEST_DATABASE_URL', 'TEST_MIGRATION_DATABASE_URL'] as const;

test('默认固定 PG16/55439，显式 PG17 可使用 CI 的 55439 或新 55440', () => {
  const scope = readTestDatabaseScope(fixture());
  assert.equal(scope.port, '55439'); assert.equal(scope.major, 16); assert.ok(Object.isFrozen(scope));
  for (const [port, major] of [['55439', '16'], ['55439', '17'], ['55440', '17']]) {
    assert.equal(readTestDatabaseScope(fixture(port, major)).major, Number(major));
  }
  const encoded = fixture();
  encoded.TEST_DATABASE_URL = encoded.TEST_DATABASE_URL!.replace('fixture-only-app-password', 'encoded%3F%23%40password');
  assert.doesNotThrow(() => readTestDatabaseScope(encoded));
});

test('必须同时提供 TEST 连接对，不回退 DATABASE_URL 或开发配置', () => {
  for (const key of keys) {
    const env = fixture(); delete env[key];
    env.DATABASE_URL = fixture().TEST_DATABASE_URL;
    env.MIGRATION_DATABASE_URL = fixture().TEST_MIGRATION_DATABASE_URL;
    assert.throws(() => readTestDatabaseScope(env), /必须显式提供/);
  }
  assert.throws(() => readTestDatabaseScope({}), /必须显式提供/);
});

test('拒绝云端、localhost、IPv6、主机别名及生产/开发/非精确测试库', () => {
  for (const key of keys) {
    for (const host of ['db.cloud.example', 'localhost', '[::1]', '127.0.0.2', '127.1']) {
      const env = fixture(); env[key] = env[key]!.replace('127.0.0.1', host);
      assert.throws(() => readTestDatabaseScope(env), /固定本地测试/);
    }
    for (const database of ['restaurant_prod', 'restaurant_dev', 'postgres', 'restaurant_test_extra', 'restaurant_test/', 'restaurant_%74est']) {
      const env = fixture(); env[key] = env[key]!.replace('/restaurant_test', `/${database}`);
      assert.throws(() => readTestDatabaseScope(env), /固定本地测试/);
    }
  }
});

test('拒绝错误角色、互换角色、缺密码和非 PostgreSQL 协议', () => {
  for (const key of keys) {
    const role = key === 'TEST_DATABASE_URL' ? 'restaurant_test_app' : 'restaurant_test_owner';
    for (const wrong of ['postgres', 'restaurant_app', 'restaurant_owner', 'test_app', 'test_owner',
      key === 'TEST_DATABASE_URL' ? 'restaurant_test_owner' : 'restaurant_test_app']) {
      const env = fixture(); env[key] = env[key]!.replace(role, wrong);
      assert.throws(() => readTestDatabaseScope(env), /固定本地测试/);
    }
    const missing = fixture(); missing[key] = missing[key]!.replace(/:fixture-only-[^@]+@/, ':@');
    assert.throws(() => readTestDatabaseScope(missing), /固定本地测试/);
    const badPassword = fixture(); badPassword[key] = badPassword[key]!.replace(/:fixture-only-[^@]+@/, ':%ZZ@');
    assert.throws(() => readTestDatabaseScope(badPassword), /密码编码/);
    const protocol = fixture(); protocol[key] = protocol[key]!.replace('postgresql:', 'https:');
    assert.throws(() => readTestDatabaseScope(protocol), /固定本地测试/);
  }
});

test('拒绝 query/hash 覆写、空分隔符和 URL 解析归一化绕过', () => {
  for (const key of keys) {
    for (const suffix of ['?host=db.cloud.example', '?dbname=restaurant_prod', '?user=postgres',
      '?options=-c%20role%3Dpostgres', '?port=5432', '?sslmode=require', '#override', '?', '#']) {
      const env = fixture(); env[key] += suffix;
      assert.throws(() => readTestDatabaseScope(env), /query 或 hash/);
    }
    for (const change of [(url: string) => ` ${url}`, (url: string) => url.replace('@127', '@\n127'),
      (url: string) => url.replace('/restaurant_test', '/restaurant_dev/../restaurant_test'),
      (url: string) => url.replace('/restaurant_test', '/restaurant_dev/%2e%2e/restaurant_test')]) {
      const env = fixture(); env[key] = change(env[key]!);
      assert.throws(() => readTestDatabaseScope(env));
    }
  }
});

test('拒绝不匹配连接对、非白名单端口和未明确授权的新 PG17 端口', () => {
  for (const port of ['5432', '55441', '', '055439']) {
    const env = fixture(); env.TEST_PG_PORT = port;
    assert.throws(() => readTestDatabaseScope(env), /TEST_PG_PORT/);
  }
  for (const major of ['', '15', '18', '17.0', '017']) {
    const env = fixture(); env.TEST_PG_MAJOR = major;
    assert.throws(() => readTestDatabaseScope(env), /TEST_PG_MAJOR/);
  }
  for (const major of [undefined, '16']) assert.throws(() => readTestDatabaseScope(fixture('55440', major)), /显式指定/);
  for (const key of keys) {
    const env = fixture(); env[key] = env[key]!.replace(':55439/', ':55440/');
    assert.throws(() => readTestDatabaseScope(env), /固定本地测试/);
  }
  const defaultPort = fixture(); defaultPort.TEST_DATABASE_URL = defaultPort.TEST_DATABASE_URL!.replace(':55439', '');
  assert.throws(() => readTestDatabaseScope(defaultPort), /固定本地测试/);
});

function identity(kind: 'app' | 'owner', version = 160000): TestDatabaseIdentity {
  const role = kind === 'app' ? 'restaurant_test_app' : 'restaurant_test_owner';
  return { database: 'restaurant_test', role, session_role: role, version, rolsuper: false, rolcreatedb: false,
    rolcreaterole: false, rolbypassrls: false, rolreplication: false, rolcanlogin: true, memberships: false,
    ddl: kind === 'owner', owns_objects: kind === 'owner' };
}
function connection(rows: TestDatabaseIdentity[]) {
  return { query: async (sql: string) => {
    assert.match(sql, /^SELECT /); assert.match(sql, /current_database\(\)/); assert.match(sql, /pg_auth_members/);
    assert.ok(!/\b(TRUNCATE|CREATE TABLE|ALTER|DROP|DELETE|UPDATE|INSERT)\b/.test(sql));
    return { rows };
  } };
}

test('连接后校验 PG16/17 精确版本、库名、current_user 和 session_user；owner 可以拥有表', async () => {
  for (const [port, major] of [['55439', '16'], ['55439', '17'], ['55440', '17']]) {
    const scope = readTestDatabaseScope(fixture(port, major));
    for (const kind of ['app', 'owner'] as const) {
      await assertTestDatabaseConnection(connection([identity(kind, Number(major) * 10000 + 4)]), scope, kind);
    }
  }
  const scope = readTestDatabaseScope(fixture());
  await assert.rejects(() => assertTestDatabaseConnection(connection([]), scope, 'app'), /会话身份/);
  for (const kind of ['app', 'owner'] as const) {
    for (const change of [{ database: 'restaurant_dev' }, { database: 'restaurant_prod' }, { role: 'postgres' },
      { session_role: 'postgres' }, { version: 150000 }, { version: 170000 }, { version: 180000 }, { version: 160000.5 }]) {
      await assert.rejects(() => assertTestDatabaseConnection(connection([{ ...identity(kind), ...change }]), scope, kind));
    }
  }
});

test('app/owner 都拒绝管理、复制、角色成员权限；app 额外拒绝 DDL/对象所有权', async () => {
  const scope = readTestDatabaseScope(fixture());
  for (const kind of ['app', 'owner'] as const) {
    for (const key of ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolbypassrls', 'rolreplication', 'memberships'] as const) {
      await assert.rejects(() => assertTestDatabaseConnection(connection([{ ...identity(kind), [key]: true }]), scope, kind), /角色不得/);
    }
    await assert.rejects(() => assertTestDatabaseConnection(connection([{ ...identity(kind), rolcanlogin: false }]), scope, kind), /角色不得/);
  }
  for (const key of ['ddl', 'owns_objects'] as const) {
    await assert.rejects(() => assertTestDatabaseConnection(connection([{ ...identity('app'), [key]: true }]), scope, 'app'), /DDL/);
  }
});

test('池工厂再次验证 scope，不允许伪造的 URL 绕过或连接后失败遗留池', async t => {
  const scope = readTestDatabaseScope(fixture());
  const forged = { ...scope, databaseUrl: scope.databaseUrl.replace('/restaurant_test', '/restaurant_dev') } as TestDatabaseScope;
  await assert.rejects(() => createTestDatabasePool('app', forged), /固定本地测试/);
  const end = t.mock.method(pg.Pool.prototype, 'end', async () => {});
  t.mock.method(pg.Pool.prototype, 'query', async () => ({ rows: [identity('owner')] }));
  await assert.rejects(() => createTestDatabasePool('app', scope), /会话身份/);
  assert.equal(end.mock.callCount(), 1);
});

test('回填 55440 仅允许精确调用方 TEST 连接对和 PG17，生产/开发授权不扩张', () => {
  for (const [port, major] of [['55439', '16'], ['55439', '17'], ['55440', '17']]) {
    const scope = readTestDatabaseScope(fixture(port, major));
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: scope.databaseUrl, MIGRATION_DATABASE_URL: scope.migrationDatabaseUrl,
      APP_ORIGIN: 'https://localhost:5173', EMAIL_MODE: 'disabled', TOKEN_PEPPER: 'scope-fixture-pepper-'.repeat(4),
      CURSOR_SECRET: 'scope-fixture-cursor-'.repeat(4), OUTBOX_ENCRYPTION_KEY: 'b4'.repeat(32) });
    const env = { ...fixture(port, major), WEBSITE_SOURCE_BACKFILL_ALLOW_TEST: 'restaurant_test' };
    assert.doesNotThrow(() => assertWebsiteBackfillApply(config, env));
    assert.throws(() => assertWebsiteBackfillApply(config, {}));
    for (const change of [{ TEST_DATABASE_URL: undefined }, { TEST_MIGRATION_DATABASE_URL: undefined },
      { TEST_DATABASE_URL: `${scope.databaseUrl}?options=-c%20role%3Dpostgres` },
      { TEST_MIGRATION_DATABASE_URL: scope.migrationDatabaseUrl.replace('/restaurant_test', '/restaurant_dev') },
      { WEBSITE_SOURCE_BACKFILL_ALLOW_TEST: undefined }, { TEST_PG_PORT: '5432' }]) {
      assert.throws(() => assertWebsiteBackfillApply(config, { ...env, ...change }));
    }
    assert.throws(() => assertWebsiteBackfillApply({ ...config, nodeEnv: 'production' }, env));
    if (port === '55440') {
      assert.throws(() => assertWebsiteBackfillApply(config, { ...env, TEST_PG_MAJOR: undefined }));
      assert.throws(() => assertWebsiteBackfillApply(config, { ...env, TEST_PG_MAJOR: '16' }));
      const development = { ...config, nodeEnv: 'development' as const,
        databaseUrl: scope.databaseUrl.replace('restaurant_test_app', 'restaurant_app').replace('/restaurant_test', '/restaurant_dev') };
      assert.throws(() => assertWebsiteBackfillApply(development, env));
    }
  }
});
