import pg from 'pg';
import { readTestDatabaseScope } from './database-scope.js';

// 仅创建一次性 CI 服务，不允许本地开发服务或其他数据库。
if (process.env.CI !== 'true') throw new Error('CI fixture is only for an isolated CI service');
const scope = readTestDatabaseScope();
if (scope.port !== '55439' || !['16', '17'].includes(process.env.TEST_PG_MAJOR ?? '')) throw new Error('CI 必须明确指定 PG16/17 和 55439');
const adminUrl = process.env.CI_DATABASE_ADMIN_URL ?? '';
const url = new URL(adminUrl);
if (/[\s\\?#]/u.test(adminUrl) || !['postgres:', 'postgresql:'].includes(url.protocol) || !url.password ||
    url.hostname !== '127.0.0.1' || url.port !== scope.port || url.username !== 'postgres' || url.pathname !== '/postgres') throw new Error('Invalid dedicated CI database');
const owner = process.env.CI_TEST_OWNER_PASSWORD, app = process.env.CI_TEST_APP_PASSWORD;
if (!owner || !app || !/^[A-Za-z0-9_-]{20,}$/.test(owner) || !/^[A-Za-z0-9_-]{20,}$/.test(app)) throw new Error('Invalid CI-only role secrets');
if (decodeURIComponent(new URL(scope.databaseUrl).password) !== app ||
    decodeURIComponent(new URL(scope.migrationDatabaseUrl).password) !== owner) throw new Error('CI 角色密码必须与 TEST 连接对一致');
const pool = new pg.Pool({ connectionString: url.href });
try {
  const identity = (await pool.query(`SELECT current_database() AS database,current_user AS role,
    current_setting('server_version_num')::int AS version`)).rows[0];
  if (!identity || identity.database !== 'postgres' || identity.role !== 'postgres' ||
      Math.floor(identity.version / 10000) !== scope.major) throw new Error('拒绝初始化不匹配的 CI 服务');
  await pool.query(`CREATE ROLE restaurant_test_owner LOGIN PASSWORD '${owner}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  await pool.query(`CREATE ROLE restaurant_test_app LOGIN PASSWORD '${app}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  await pool.query('CREATE DATABASE restaurant_test OWNER restaurant_test_owner');
  await pool.query('REVOKE ALL ON DATABASE restaurant_test FROM PUBLIC');
  await pool.query('GRANT CONNECT ON DATABASE restaurant_test TO restaurant_test_owner,restaurant_test_app');
  console.log('Isolated CI database prepared with separate owner/application roles.');
} finally { await pool.end(); }
