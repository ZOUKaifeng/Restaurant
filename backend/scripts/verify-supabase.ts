import pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertAppDatabase, databaseConnectionOptions } from '../src/db.js';

export const PROJECT_REF = 'borhtrnfawsvadknqdqv';
export const SESSION_HOST = 'aws-0-us-west-2.pooler.supabase.com';
export const OWNER_ROLE = 'restaurant_owner';
export const APP_ROLE = 'restaurant_app';
export const API_ROLES = ['anon', 'authenticated', 'service_role'] as const;
export const MIGRATION_VERSIONS = [
  '001_merchant_core', '002_assets', '003_asset_upload_intents', '004_websites',
  '005_menu_vision', '006_website_react', '007_website_usage', '008_reservations',
  '009_analytics', '010_ai_metering', '011_billing_catalog', '012_website_content', '013_calendar_test_credits', '014_calendar_credit_guards',
] as const;
export const BACKEND_DIRECTORY = fileURLToPath(new URL(
  existsSync(new URL('../migrations/', import.meta.url)) ? '../' : '../../', import.meta.url,
));
export const SECRET_FILE = new URL('.env.supabase.local', pathToFileURL(`${BACKEND_DIRECTORY}/`));
export const QUOTA_SIGNATURE = 'public.apply_ai_quota_entry(text,text,text,text,text,bigint,bigint,bigint,text,text)';
export const MANUAL_PENDING = {
  dataApiDisabled: false, dataApiStatus: 'pending', sslEnforcement: 'pending', networkRestrictions: 'pending', backupsPlan: 'pending',
} as const;

const PLATFORM_SCHEMAS = [
  'public', 'information_schema', 'auth', 'storage', 'realtime', 'extensions',
  'graphql', 'graphql_public', 'net', 'vault', 'pgbouncer', 'pgsodium', 'pgsodium_masks',
  'supabase_functions', 'supabase_migrations', '_analytics', '_realtime',
];

export class SupabaseBlockedError extends Error {
  constructor(readonly code: string) { super('Supabase 数据库安全检查阻断'); }
}
export function requireCheck(condition: unknown, code: string): asserts condition {
  if (!condition) throw new SupabaseBlockedError(code);
}
export function reportFailure(error: unknown): void {
  // 不输出驱动异常、SQL、notice、URL 或环境变量；它们可能携带密码。
  const databaseCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{5,64}$/.test(error.code) ? error.code : undefined;
  const code = error instanceof SupabaseBlockedError ? error.code : `DATABASE_OPERATION_BLOCKED${databaseCode ? `_${databaseCode}` : ''}`;
  process.stderr.write(`${JSON.stringify({ status: 'blocked', code, message: '操作未验收，请核对安全前提；不会输出连接或密码。', manual: MANUAL_PENDING })}\n`);
  process.exitCode = 1;
}
export function writeReport(report: object): void {
  const text = JSON.stringify(report);
  requireCheck(text.length < 1000, 'REPORT_TOO_LARGE');
  process.stdout.write(`${text}\n`);
}

export interface Migration { version: string; sql: string; checksum: string }
export function loadMigrations(): Migration[] {
  const directory = new URL('migrations/', pathToFileURL(`${BACKEND_DIRECTORY}/`));
  const expected = MIGRATION_VERSIONS.map(version => `${version}.sql`).sort();
  requireCheck(JSON.stringify(readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) === JSON.stringify(expected), 'MIGRATION_CATALOG_CHANGED');
  return MIGRATION_VERSIONS.map(version => {
    const sql = readFileSync(new URL(`${version}.sql`, directory), 'utf8');
    return { version, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
}
export function projectTables(migrations: Migration[]): string[] {
  return ['schema_migrations', ...migrations.flatMap(({ sql }) =>
    [...sql.matchAll(/^CREATE TABLE ([a-z_][a-z0-9_]*)\s*\(/gm)].map(match => match[1]))].sort();
}
function projectFunctions(migrations: Migration[]): Map<string, string> {
  const names = migrations.flatMap(({ sql }) => [...sql.matchAll(/^CREATE (?:OR REPLACE )?FUNCTION ([a-z_][a-z0-9_]*)\s*\(/gm)].map(match => match[1]));
  return new Map(names.map(name => [name, name === 'valid_menu_data' ? 'jsonb' : name === 'apply_ai_quota_entry'
    ? 'text, text, text, text, text, bigint, bigint, bigint, text, text' : '']));
}
export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
export function connectionConfig(connectionString: string, role: string, caFile: string): pg.ClientConfig {
  try {
    requireCheck(process.env.SUPABASE_PROJECT_REF === PROJECT_REF, 'PROJECT_REF_NOT_ALLOWED');
    requireCheck(['postgres', OWNER_ROLE, APP_ROLE].includes(role), 'DATABASE_ROLE_NOT_ALLOWED');
    requireCheck(caFile && !/[\x00-\x1f'"\\]/.test(caFile), 'CA_PATH_REQUIRED');
    const certificatePath = isAbsolute(caFile) ? caFile : resolve(BACKEND_DIRECTORY, caFile);
    const url = new URL(connectionString);
    requireCheck(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === SESSION_HOST &&
      url.port === '5432' && url.pathname === '/postgres' && !url.hash &&
      decodeURIComponent(url.username) === `${role}.${PROJECT_REF}` &&
      decodeURIComponent(url.password).length > 0, 'DATABASE_TARGET_NOT_ALLOWED');
    const config = databaseConnectionOptions(connectionString, certificatePath);
    requireCheck(typeof config.ssl === 'object' && config.ssl.rejectUnauthorized === true &&
      Boolean(config.ssl.ca) && config.ssl.servername === SESSION_HOST, 'VERIFY_FULL_REQUIRED');
    return {
      ...config, application_name: 'tablefolk-supabase-audit', connectionTimeoutMillis: 10000,
      statement_timeout: 30000, query_timeout: 30000, lock_timeout: 10000, idle_in_transaction_session_timeout: 60000,
      options: '-c default_transaction_read_only=on -c search_path=public,pg_catalog',
    };
  } catch (error) {
    if (error instanceof SupabaseBlockedError) throw error;
    throw new SupabaseBlockedError('DATABASE_TLS_OR_URL_INVALID');
  }
}
export function configuredClient(url: string, role: string, caFile: string): pg.Client {
  const client = new pg.Client(connectionConfig(url, role, caFile));
  client.on('notice', () => {});
  client.on('error', () => {});
  return client;
}
export async function assertIdentity(client: pg.Client, expectedRole: string): Promise<boolean | null> {
  const { rows } = await client.query(`SELECT pg_catalog.current_database() AS database,current_user AS role,
    session_user AS session_role,pg_catalog.current_setting('server_version_num')::int AS version,
    (SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_catalog.pg_backend_pid()) AS database_hop_tls`);
  const row = rows[0];
  requireCheck(row?.database === 'postgres' && row.role === expectedRole && row.session_role === expectedRole, 'ACTUAL_DATABASE_IDENTITY_MISMATCH');
  requireCheck(row.version === 170012, 'EXPECTED_POSTGRES_17_12_REQUIRED');
  return typeof row.database_hop_tls === 'boolean' ? row.database_hop_tls : null;
}
export async function beginReadOnly(client: pg.Client): Promise<void> {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query('SET LOCAL search_path=public,pg_catalog');
}

export async function checkSchemas(client: pg.Client): Promise<void> {
  const result = await client.query(`SELECT nspname FROM pg_catalog.pg_namespace
    WHERE nspname !~ '^pg_' AND NOT (nspname=ANY($1::text[]))`, [PLATFORM_SCHEMAS]);
  requireCheck(result.rowCount === 0, 'UNKNOWN_APP_OR_MIGRATION_SCHEMA');
  const publicSchema = await client.query("SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname='public'");
  requireCheck(publicSchema.rowCount === 1, 'PUBLIC_SCHEMA_MISSING');
  const platformMigrations = await client.query(`SELECT c.oid,c.relname,c.relkind FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='supabase_migrations' AND c.relkind IN ('r','p','v','m','f')`);
  requireCheck(platformMigrations.rowCount === 0, 'EXISTING_PLATFORM_MIGRATION_TABLES');
}

// 只审计 public 中的非扩展项目对象，不变更平台 schema 或扩展对象。
export async function publicObjects(client: pg.Client): Promise<{
  tables: { oid: number; name: string; owner: string; kind: string; force_rls: boolean }[];
  functions: { oid: number; name: string; owner: string; args: string }[];
  customTypes: number;
}> {
  const tables = await client.query(`SELECT c.oid,c.relname AS name,r.rolname AS owner,c.relkind AS kind,c.relforcerowsecurity AS force_rls
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_roles r ON r.oid=c.relowner
    WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m','f') AND NOT EXISTS
      (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
    ORDER BY c.relname`);
  const functions = await client.query(`SELECT p.oid,p.proname AS name,r.rolname AS owner,pg_catalog.oidvectortypes(p.proargtypes) AS args
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
    WHERE n.nspname='public' AND NOT EXISTS
      (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
    ORDER BY p.proname,p.oid`);
  const types = await client.query(`SELECT pg_catalog.count(*)::int AS count FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' AND t.typrelid=0 AND t.typelem=0 AND NOT EXISTS
      (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_type'::regclass AND d.objid=t.oid AND d.deptype='e')`);
  return { tables: tables.rows, functions: functions.rows, customTypes: types.rows[0].count };
}
export async function checkRoles(client: pg.Client): Promise<void> {
  const roles = await client.query(`SELECT rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
    FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])`, [[OWNER_ROLE, APP_ROLE, ...API_ROLES]]);
  requireCheck(roles.rowCount === 5, 'EXPECTED_ROLES_MISSING');
  for (const name of [OWNER_ROLE, APP_ROLE]) {
    const role = roles.rows.find(row => row.rolname === name);
    requireCheck(role?.rolcanlogin && !role.rolinherit && !role.rolsuper && !role.rolcreatedb &&
      !role.rolcreaterole && !role.rolreplication && !role.rolbypassrls, 'UNSAFE_ROLE_ATTRIBUTES');
  }
  const memberships = await client.query(`SELECT 1 FROM pg_catalog.pg_auth_members m
    WHERE m.member=ANY(ARRAY[$1::regrole::oid,$2::regrole::oid]) OR
      (m.roleid=$2::regrole::oid AND NOT (
        m.member='postgres'::regrole::oid AND m.grantor='supabase_admin'::regrole::oid AND
        m.admin_option AND NOT m.inherit_option AND NOT m.set_option))`, [OWNER_ROLE, APP_ROLE]);
  requireCheck(memberships.rowCount === 0, 'APP_OR_OWNER_ROLE_MEMBERSHIP');
  const ddl = await client.query(`SELECT
    pg_catalog.has_database_privilege($1,pg_catalog.current_database(),'CREATE') OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND pg_catalog.has_schema_privilege($1,oid,'CREATE')) AS app_ddl,
    EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=$1::regrole::oid AND deptype='o') AS app_owns,
    pg_catalog.has_schema_privilege($2,'public','CREATE') AS owner_create,
    NOT pg_catalog.has_schema_privilege($1,'public','USAGE') OR NOT pg_catalog.has_schema_privilege($2,'public','USAGE') OR
    NOT pg_catalog.has_database_privilege($1,pg_catalog.current_database(),'CONNECT') OR NOT pg_catalog.has_database_privilege($2,pg_catalog.current_database(),'CONNECT') AS access_missing`, [APP_ROLE, OWNER_ROLE]);
  const row = ddl.rows[0];
  requireCheck(!row.app_ddl && !row.app_owns && !row.owner_create && !row.access_missing, 'ROLE_DDL_OWNERSHIP_OR_ACCESS');
  const privileged = await client.query(`SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname<>$1 AND
    (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolname=$2)
    AND pg_catalog.pg_has_role($1,r.oid,'SET')`, [APP_ROLE, OWNER_ROLE]);
  requireCheck(privileged.rowCount === 0, 'APP_CAN_ASSUME_PRIVILEGED_ROLE');
}
export async function checkDefaultPrivileges(client: pg.Client): Promise<void> {
  const result = await client.query(`WITH global_acl AS (
      SELECT kind,coalesce(d.defaclacl,pg_catalog.acldefault(kind,$1::regrole::oid)) AS acl
      FROM pg_catalog.unnest(ARRAY['r'::"char",'S'::"char",'f'::"char"]) AS kinds(kind)
      LEFT JOIN pg_catalog.pg_default_acl d ON d.defaclrole=$1::regrole::oid AND d.defaclnamespace=0 AND d.defaclobjtype=kind
    ), scoped_acl AS (
      SELECT defaclobjtype AS kind,defaclacl AS acl FROM pg_catalog.pg_default_acl
      WHERE defaclrole=$1::regrole::oid AND defaclnamespace='public'::regnamespace AND defaclobjtype IN ('r','S','f')
    ) SELECT 1 FROM (SELECT * FROM global_acl UNION ALL SELECT * FROM scoped_acl) a,
      LATERAL pg_catalog.aclexplode(a.acl) x WHERE x.grantee<>$1::regrole::oid`, [OWNER_ROLE]);
  requireCheck(result.rowCount === 0, 'UNSAFE_OWNER_DEFAULT_ACL');
}
export async function checkApiPrivileges(client: pg.Client): Promise<void> {
  const api = await client.query(`WITH objects AS (
      SELECT c.oid,c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relowner=$1::regrole::oid AND c.relkind IN ('r','p','v','m','f','S')
    ), api_roles AS (SELECT pg_catalog.unnest($2::text[]) AS role)
    SELECT 1 FROM api_roles r WHERE pg_catalog.pg_has_role(r.role,$1::regrole,'SET') OR
      pg_catalog.pg_has_role(r.role,'restaurant_app','SET') OR pg_catalog.has_schema_privilege(r.role,'public','USAGE,CREATE') OR
      EXISTS(SELECT 1 FROM objects o WHERE o.relkind<>'S' AND
        (pg_catalog.has_table_privilege(r.role,o.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR
         pg_catalog.has_any_column_privilege(r.role,o.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) OR
      EXISTS(SELECT 1 FROM objects o WHERE o.relkind='S' AND pg_catalog.has_sequence_privilege(r.role,o.oid,'USAGE,SELECT,UPDATE')) OR
      EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proowner=$1::regrole::oid AND pg_catalog.has_function_privilege(r.role,p.oid,'EXECUTE'))`, [OWNER_ROLE, [...API_ROLES]]);
  requireCheck(api.rowCount === 0, 'EFFECTIVE_DATA_API_PRIVILEGES');
  const publicAcl = await client.query(`WITH project_acl AS (
      SELECT coalesce(c.relacl,pg_catalog.acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner)) AS acl
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relowner=$1::regrole::oid
        AND c.relkind IN ('r','p','S','v','m','f')
      UNION ALL SELECT a.attacl FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relowner=$1::regrole::oid AND a.attnum>0 AND NOT a.attisdropped
      UNION ALL SELECT coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner)) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proowner=$1::regrole::oid
    ) SELECT 1 FROM project_acl a,LATERAL pg_catalog.aclexplode(a.acl) x
      WHERE x.grantee=0 OR (x.grantee=$2::regrole::oid AND x.is_grantable)
    UNION ALL SELECT 1 FROM pg_catalog.pg_namespace n,LATERAL pg_catalog.aclexplode(coalesce(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) x
      WHERE n.nspname='public' AND (x.grantee=0 OR (x.grantee=$2::regrole::oid AND x.is_grantable))
    UNION ALL SELECT 1 FROM pg_catalog.pg_database d,LATERAL pg_catalog.aclexplode(coalesce(d.datacl,pg_catalog.acldefault('d',d.datdba))) x
      WHERE d.datname=pg_catalog.current_database() AND ((x.grantee=0 AND x.privilege_type='CREATE') OR (x.grantee=$2::regrole::oid AND x.is_grantable))`, [OWNER_ROLE, APP_ROLE]);
  requireCheck(publicAcl.rowCount === 0, 'PUBLIC_PRIVILEGES_OR_APP_GRANT_OPTION');
  const functions = await client.query(`SELECT
    pg_catalog.has_function_privilege($1,$2,'EXECUTE') AS quota,
    pg_catalog.has_function_privilege($1,'public.valid_menu_data(jsonb)','EXECUTE') AS valid_menu,
    EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proowner=$3::regrole::oid AND p.oid<>'public.valid_menu_data(jsonb)'::regprocedure
        AND pg_catalog.has_function_privilege($1,p.oid,'EXECUTE')) AS other_execute`, [APP_ROLE, QUOTA_SIGNATURE, OWNER_ROLE]);
  requireCheck(!functions.rows[0].quota && functions.rows[0].valid_menu && !functions.rows[0].other_execute, 'APP_FUNCTION_PRIVILEGES');
}

export async function verifyDatabaseState(client: pg.Client, migrations: Migration[]): Promise<{ tables: number; businessRows: number }> {
  await checkSchemas(client);
  await checkRoles(client);
  const expectedTables = projectTables(migrations);
  const expectedFunctions = projectFunctions(migrations);
  const objects = await publicObjects(client);
  requireCheck(objects.customTypes === 0 && objects.tables.every(row => row.kind === 'r' && row.owner === OWNER_ROLE && !row.force_rls) &&
    JSON.stringify(objects.tables.map(row => row.name)) === JSON.stringify(expectedTables), 'PROJECT_TABLE_INVENTORY_OR_OWNER');
  requireCheck(objects.functions.length === expectedFunctions.size && objects.functions.every(row =>
    row.owner === OWNER_ROLE && expectedFunctions.get(row.name) === row.args), 'PROJECT_FUNCTION_INVENTORY_OR_OWNER');
  const outside = await client.query(`SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relowner=$1::regrole::oid AND n.nspname<>'public' AND n.nspname !~ '^pg_'
    UNION ALL SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE p.proowner=$1::regrole::oid AND n.nspname<>'public' AND n.nspname !~ '^pg_'
    UNION ALL SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=$1::regrole::oid AND nspname !~ '^pg_'`, [OWNER_ROLE]);
  requireCheck(outside.rowCount === 0, 'PROJECT_OBJECTS_OUTSIDE_PUBLIC');
  const applied = await client.query('SELECT version,checksum FROM public.schema_migrations ORDER BY version');
  requireCheck(applied.rowCount === migrations.length && applied.rows.every((row, index) =>
    row.version === migrations[index].version && row.checksum === migrations[index].checksum), 'MIGRATION_CHECKSUM_MISMATCH');
  const seedRows: Record<string, number> = { schema_migrations: migrations.length, billing_plan_versions: 3, billing_price_versions: 7 };
  for (const name of expectedTables) {
    const result = await client.query(`SELECT pg_catalog.count(*)::text AS count FROM public.${quoteIdentifier(name)}`);
    requireCheck(result.rows[0].count === String(seedRows[name] ?? 0), 'OCCUPIED_PROJECT_BUSINESS_OR_CATALOG_ROWS');
  }
  await checkDefaultPrivileges(client);
  await checkApiPrivileges(client);
  return { tables: expectedTables.length, businessRows: 0 };
}

async function verifySessionLocks(appUrl: string, caFile: string): Promise<void> {
  const first = configuredClient(appUrl, APP_ROLE, caFile);
  const second = configuredClient(appUrl, APP_ROLE, caFile);
  const key = randomBytes(8).readBigInt64BE().toString();
  let firstConnected = false;
  let secondConnected = false;
  try {
    await first.connect();
    firstConnected = true;
    await second.connect();
    secondConnected = true;
    await assertIdentity(first, APP_ROLE);
    await assertIdentity(second, APP_ROLE);
    requireCheck((await first.query('SELECT pg_catalog.pg_try_advisory_lock($1::bigint) AS held', [key])).rows[0].held, 'SESSION_LOCK_NOT_ACQUIRED');
    requireCheck(!(await second.query('SELECT pg_catalog.pg_try_advisory_lock($1::bigint) AS held', [key])).rows[0].held, 'SESSION_POOLER_LOCK_CONTENTION_FAILED');
    requireCheck((await first.query('SELECT pg_catalog.pg_advisory_unlock($1::bigint) AS released', [key])).rows[0].released, 'SESSION_LOCK_UNLOCK_FAILED');
    requireCheck((await second.query('SELECT pg_catalog.pg_try_advisory_lock($1::bigint) AS held', [key])).rows[0].held, 'SESSION_LOCK_RELEASE_NOT_VISIBLE');
    requireCheck((await second.query('SELECT pg_catalog.pg_advisory_unlock($1::bigint) AS released', [key])).rows[0].released, 'SESSION_LOCK_UNLOCK_FAILED');
  } finally {
    // 即使获取锁后的响应丢失，也尝试释放本次随机键，再断开连接。
    if (firstConnected) { try { await first.query('SELECT pg_catalog.pg_advisory_unlock($1::bigint)', [key]); } catch { /* 断开连接也释放锁。 */ } }
    if (secondConnected) { try { await second.query('SELECT pg_catalog.pg_advisory_unlock($1::bigint)', [key]); } catch { /* 断开连接也释放锁。 */ } }
    await Promise.allSettled([first.end(), second.end()]);
  }
}

export async function verifySupabase(appUrl: string, ownerUrl: string, caFile: string, migrations = loadMigrations()): Promise<object> {
  requireCheck(appUrl && ownerUrl && caFile, 'VERIFIER_CREDENTIALS_AND_CA_REQUIRED');
  const app = configuredClient(appUrl, APP_ROLE, caFile);
  const owner = configuredClient(ownerUrl, OWNER_ROLE, caFile);
  const pool = new pg.Pool({ ...connectionConfig(appUrl, APP_ROLE, caFile), max: 1 });
  pool.on('error', () => {});
  pool.on('connect', client => { client.on('notice', () => {}); });
  try {
    await owner.connect();
    await app.connect();
    await beginReadOnly(owner);
    const ownerTls = await assertIdentity(owner, OWNER_ROLE);
    const state = await verifyDatabaseState(owner, migrations);
    await owner.query('COMMIT');
    await beginReadOnly(app);
    const appTls = await assertIdentity(app, APP_ROLE);
    await checkRoles(app);
    await checkApiPrivileges(app);
    const versions = await app.query('SELECT version FROM public.schema_migrations ORDER BY version');
    requireCheck(versions.rowCount === migrations.length && versions.rows.every((row, index) => row.version === migrations[index].version), 'APP_MIGRATION_READ_ACCESS');
    await app.query('COMMIT');
    await assertAppDatabase(pool);
    await verifySessionLocks(appUrl, caFile);
    return {
      status: 'verified', projectRef: PROJECT_REF, host: SESSION_HOST, database: 'postgres', postgres: '17.12',
      migrations: migrations.length, checksums: 'exact', ...state, catalogRows: { plans: 3, prices: 7 },
      roles: 'least-privilege', apiObjectPrivileges: false, quotaExecute: false, sessionLocks: true,
      tls: { client: 'verify-full', explicitCa: true, appDatabaseHop: appTls, ownerDatabaseHop: ownerTls }, manual: MANUAL_PENDING,
    };
  } finally {
    await Promise.allSettled([app.end(), owner.end(), pool.end()]);
  }
}

async function main(): Promise<void> {
  requireCheck(process.argv.length === 2, 'UNKNOWN_VERIFIER_FLAG');
  const appUrl = process.env.APPLICATION_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
  requireCheck(!process.env.APPLICATION_DATABASE_URL || !process.env.DATABASE_URL ||
    process.env.APPLICATION_DATABASE_URL === process.env.DATABASE_URL, 'CONFLICTING_APP_DATABASE_URLS');
  writeReport(await verifySupabase(appUrl, process.env.MIGRATION_DATABASE_URL ?? '', process.env.DATABASE_SSL_CA_FILE ?? ''));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(reportFailure);
