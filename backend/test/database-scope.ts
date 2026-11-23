import type { Pool } from 'pg';
import { createPool } from '../src/db.js';

const appRole = 'restaurant_test_app';
const ownerRole = 'restaurant_test_owner';
export type TestDatabaseScope = Readonly<{
  databaseUrl: string;
  migrationDatabaseUrl: string;
  port: '55439' | '55440';
  major: 16 | 17;
}>;
export type TestDatabaseIdentity = {
  database: string;
  role: string;
  session_role: string;
  version: number;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolbypassrls: boolean;
  rolreplication: boolean;
  rolcanlogin: boolean;
  memberships: boolean;
  ddl: boolean;
  owns_objects: boolean;
};
type TestConnection = { query(sql: string): Promise<{ rows: TestDatabaseIdentity[] }> };

export function readTestDatabaseScope(env: NodeJS.ProcessEnv = process.env): TestDatabaseScope {
  const port = env.TEST_PG_PORT ?? '55439';
  if (port !== '55439' && port !== '55440') throw new Error('TEST_PG_PORT 只允许 55439 或 55440');
  const major = env.TEST_PG_MAJOR ?? '16';
  if (major !== '16' && major !== '17') throw new Error('TEST_PG_MAJOR 必须为 16 或 17');
  if (port === '55440' && env.TEST_PG_MAJOR !== '17') throw new Error('55440 必须显式指定 TEST_PG_MAJOR=17');
  function endpoint(key: 'TEST_DATABASE_URL' | 'TEST_MIGRATION_DATABASE_URL', role: string): URL {
    const value = env[key];
    if (!value) throw new Error(`必须显式提供 ${key}；禁止默认连接、开发库或跳过测试`);
    if (/[\s\\?#]/u.test(value)) throw new Error(`${key} 不得含空白、反斜杠、query 或 hash`);
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`${key} 不是有效测试数据库 URL`); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
        url.port !== port || url.pathname !== '/restaurant_test' || url.username !== role || !url.password ||
        value.slice(value.lastIndexOf('@') + 1) !== `127.0.0.1:${port}/restaurant_test` || url.search || url.hash) throw new Error(`${key} 必须使用固定本地测试端点、库名、角色及非空密码`);
    try { if (!decodeURIComponent(url.password)) throw new Error(); }
    catch { throw new Error(`${key} 密码编码无效`); }
    return url;
  }
  // 两个地址全部验证通过后才能创建任何连接。
  const app = endpoint('TEST_DATABASE_URL', appRole);
  const owner = endpoint('TEST_MIGRATION_DATABASE_URL', ownerRole);
  if (app.hostname !== owner.hostname || app.port !== owner.port || app.pathname !== owner.pathname) {
    throw new Error('应用和迁移连接必须指向同一测试端点与数据库');
  }
  return Object.freeze({ databaseUrl: app.href, migrationDatabaseUrl: owner.href, port, major: Number(major) as 16 | 17 });
}

export async function assertTestDatabaseConnection(db: TestConnection, scope: TestDatabaseScope, kind: 'app' | 'owner'): Promise<void> {
  const { rows } = await db.query(`SELECT current_database() AS database,current_user AS role,session_user AS session_role,
    current_setting('server_version_num')::int AS version,
    r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,r.rolreplication,r.rolcanlogin,
    EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS memberships,
    (has_database_privilege(current_user,current_database(),'CREATE') OR
      EXISTS(SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND has_schema_privilege(current_user,oid,'CREATE'))) AS ddl,
    (EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relowner=r.oid) OR
      EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND p.proowner=r.oid)) AS owns_objects
    FROM pg_roles r WHERE r.rolname=current_user`);
  const row = rows[0], role = kind === 'app' ? appRole : ownerRole;
  if (!row || row.database !== 'restaurant_test' || row.role !== role || row.session_role !== role) {
    throw new Error('连接后的测试数据库或会话身份不匹配');
  }
  const major = Math.floor(row.version / 10000);
  if (!Number.isInteger(row.version) || (major !== 16 && major !== 17) || major !== scope.major) {
    throw new Error('测试数据库必须为与 TEST_PG_MAJOR 一致的 PostgreSQL 16/17');
  }
  if (row.rolcanlogin !== true || [row.rolsuper, row.rolcreatedb, row.rolcreaterole, row.rolbypassrls,
    row.rolreplication, row.memberships].some(value => value !== false)) {
    throw new Error('测试角色不得具有管理、复制、绕过 RLS 或其他角色成员权限');
  }
  if (kind === 'app' && (row.ddl !== false || row.owns_objects !== false)) {
    throw new Error('测试应用角色不得具有 DDL 权限或拥有数据库对象');
  }
  // owner 允许迁移 DDL 和拥有表，但不能拥有集群管理权限。
}

export async function createTestDatabasePool(kind: 'app' | 'owner', scope: TestDatabaseScope): Promise<Pool> {
  const validated = readTestDatabaseScope({ TEST_DATABASE_URL: scope.databaseUrl,
    TEST_MIGRATION_DATABASE_URL: scope.migrationDatabaseUrl, TEST_PG_PORT: scope.port, TEST_PG_MAJOR: String(scope.major) });
  const pool = createPool(kind === 'app' ? validated.databaseUrl : validated.migrationDatabaseUrl);
  try { await assertTestDatabaseConnection(pool, validated, kind); return pool; }
  catch (error) { await pool.end(); throw error; }
}

export async function createTestDatabasePools(scope: TestDatabaseScope): Promise<{ pool: Pool; owner: Pool }> {
  const pool = await createTestDatabasePool('app', scope);
  try { return { pool, owner: await createTestDatabasePool('owner', scope) }; }
  catch (error) { await pool.end(); throw error; }
}
