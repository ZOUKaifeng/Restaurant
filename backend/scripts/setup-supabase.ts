import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { constants, lstatSync } from 'node:fs';
import { relative } from 'node:path';
import { open, unlink, type FileHandle } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  API_ROLES, APP_ROLE, BACKEND_DIRECTORY, MANUAL_PENDING, OWNER_ROLE, PROJECT_REF,
  QUOTA_SIGNATURE, SECRET_FILE, SESSION_HOST, SupabaseBlockedError, assertIdentity,
  beginReadOnly, checkRoles, checkSchemas, configuredClient, connectionConfig, loadMigrations,
  projectTables, publicObjects, quoteIdentifier, reportFailure, requireCheck, verifyDatabaseState,
  verifySupabase, writeReport, type Migration,
} from './verify-supabase.js';

async function lockOperations(client: pg.Client): Promise<void> {
  // 与现有 migrate.ts 使用同一个事务锁，但绝不调用其独立事务入口。
  const lock = await client.query("SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('merchant-core-migrations')) AS held");
  requireCheck(lock.rows[0].held, 'MIGRATION_OR_SETUP_ALREADY_RUNNING');
}
async function preflight(client: pg.Client, migrations: Migration[]): Promise<'empty' | 'initialized'> {
  await assertIdentity(client, 'postgres');
  await checkSchemas(client);
  const roles = await client.query(`SELECT rolname FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])`,
    [[OWNER_ROLE, APP_ROLE, 'restaurant_test_owner', 'restaurant_test_app']]);
  requireCheck(!roles.rows.some(row => row.rolname.startsWith('restaurant_test_')), 'UNEXPECTED_TEST_DATABASE_ROLES');
  const objects = await publicObjects(client);
  if (roles.rowCount === 2 && objects.tables.some(row => row.name === 'schema_migrations')) {
    requireCheck(objects.customTypes === 0 && objects.tables.every(row => row.kind === 'r' && row.owner === OWNER_ROLE && !row.force_rls) &&
      JSON.stringify(objects.tables.map(row => row.name)) === JSON.stringify(projectTables(migrations)), 'OCCUPIED_OR_UNKNOWN_PROJECT_TABLES');
    // admin 未必能读取 owner 表；候选已初始化状态必须通过独立 owner/app 只读验收。
    return 'initialized';
  }
  requireCheck(roles.rowCount === 0 && objects.tables.length === 0 && objects.functions.length === 0 && objects.customTypes === 0,
    'DATABASE_NOT_EMPTY_OR_PARTIALLY_INITIALIZED');
  const apiRoles = await client.query('SELECT rolname FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])', [[...API_ROLES]]);
  requireCheck(apiRoles.rowCount === API_ROLES.length, 'EXPECTED_SUPABASE_API_ROLES_MISSING');
  const authority = await client.query(`SELECT rolcreaterole OR rolsuper AS can_create_roles,
    pg_catalog.has_schema_privilege(current_user,'public','USAGE WITH GRANT OPTION') AS can_grant_usage,
    pg_catalog.has_schema_privilege(current_user,'public','CREATE WITH GRANT OPTION') AS can_grant_create,
    pg_catalog.has_database_privilege(current_user,pg_catalog.current_database(),'CONNECT WITH GRANT OPTION') AS can_grant_connect
    FROM pg_catalog.pg_roles WHERE rolname=current_user`);
  requireCheck(authority.rows[0]?.can_create_roles && authority.rows[0].can_grant_usage &&
    authority.rows[0].can_grant_create && authority.rows[0].can_grant_connect, 'ADMIN_BOOTSTRAP_PRIVILEGES_MISSING');
  return 'empty';
}

function assertSecretTargetAbsent(): void {
  try {
    lstatSync(SECRET_FILE);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw new SupabaseBlockedError('SECRET_TARGET_CANNOT_BE_CHECKED');
  }
  throw new SupabaseBlockedError('SECRET_TARGET_ALREADY_EXISTS');
}
function roleUrl(adminUrl: string, role: string, password: string): string {
  const url = new URL(adminUrl);
  url.username = `${role}.${PROJECT_REF}`;
  url.password = encodeURIComponent(password);
  return url.href;
}
async function syncSecretDirectory(): Promise<void> {
  const directory = await open(BACKEND_DIRECTORY, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function removeRollbackSecret(handle: FileHandle): Promise<void> {
  // 只删除本次独占创建的文件，不覆盖或删除后来替换该路径的文件。
  const created = await handle.stat();
  const current = lstatSync(SECRET_FILE);
  requireCheck(current.dev === created.dev && current.ino === created.ino && current.isFile(), 'ROLLBACK_SECRET_FILE_REPLACED');
  await unlink(SECRET_FILE);
  await syncSecretDirectory();
}

async function hardenDefaults(client: pg.Client): Promise<void> {
  const recipients = ['PUBLIC', ...API_ROLES.map(quoteIdentifier), quoteIdentifier(APP_ROLE)].join(',');
  for (const scope of ['', ' IN SCHEMA public']) {
    for (const kind of ['TABLES', 'SEQUENCES', 'FUNCTIONS']) {
      await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE restaurant_owner${scope} REVOKE ALL ON ${kind} FROM ${recipients}`);
    }
  }
}
async function hardenObjects(client: pg.Client): Promise<void> {
  const objects = await publicObjects(client);
  const recipients = ['PUBLIC', ...API_ROLES.map(quoteIdentifier)].join(',');
  for (const table of objects.tables) {
    requireCheck(table.owner === OWNER_ROLE && ['r', 'p', 'S'].includes(table.kind), 'UNEXPECTED_OBJECT_DURING_HARDENING');
    const target = `public.${quoteIdentifier(table.name)}`;
    await client.query(`REVOKE ALL ON ${table.kind === 'S' ? 'SEQUENCE' : 'TABLE'} ${target} FROM ${recipients}`);
    if (table.kind !== 'S') {
      const columns = await client.query('SELECT attname FROM pg_catalog.pg_attribute WHERE attrelid=$1 AND attnum>0 AND NOT attisdropped ORDER BY attnum', [table.oid]);
      const names = columns.rows.map(row => quoteIdentifier(row.attname)).join(',');
      // REVOKE 表级权限并不撤销独立的列级授权；保留原迁移对 app 的列授权。
      await client.query(`REVOKE SELECT (${names}),INSERT (${names}),UPDATE (${names}),REFERENCES (${names}) ON TABLE ${target} FROM ${recipients}`);
    }
  }
  for (const fn of objects.functions) {
    requireCheck(fn.owner === OWNER_ROLE, 'UNEXPECTED_FUNCTION_OWNER');
    const signature = await client.query(`SELECT pg_catalog.format('%I.%I(%s)',n.nspname,p.proname,pg_catalog.oidvectortypes(p.proargtypes)) AS signature
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=$1`, [fn.oid]);
    await client.query(`REVOKE ALL ON FUNCTION ${signature.rows[0].signature} FROM ${recipients},restaurant_app`);
  }
  await client.query('GRANT EXECUTE ON FUNCTION public.valid_menu_data(jsonb) TO restaurant_app');
  await client.query(`REVOKE EXECUTE ON FUNCTION ${QUOTA_SIGNATURE} FROM ${recipients},restaurant_app`);
  await hardenDefaults(client);
}

interface AppliedCredentials { appUrl: string; ownerUrl: string }
async function applyEmptyProduction(admin: pg.Client, adminUrl: string, caFile: string, migrations: Migration[]): Promise<AppliedCredentials | null> {
  let secretHandle: FileHandle | undefined;
  let committed = false;
  let commitAttempted = false;
  let transactionOpen = false;
  try {
    await admin.query('BEGIN READ WRITE');
    transactionOpen = true;
    await admin.query('SET LOCAL search_path=public,pg_catalog');
    await lockOperations(admin);
    const state = await preflight(admin, migrations);
    if (state === 'initialized') {
      await admin.query('ROLLBACK');
      transactionOpen = false;
      return null;
    }
    assertSecretTargetAbsent();
    const ownerSecret = randomBytes(32).toString('hex');
    const appSecret = randomBytes(32).toString('hex');
    const ownerUrl = roleUrl(adminUrl, OWNER_ROLE, ownerSecret);
    const appUrl = roleUrl(adminUrl, APP_ROLE, appSecret);
    connectionConfig(ownerUrl, OWNER_ROLE, caFile);
    connectionConfig(appUrl, APP_ROLE, caFile);
    // 提交前先在最终路径独占暂存并 fsync；文件不能含 admin URL 或其他应用认证参数。
    secretHandle = await open(SECRET_FILE, 'wx', 0o600);
    await secretHandle.chmod(0o600);
    await secretHandle.writeFile([
      `DATABASE_URL='${appUrl}'`, `APPLICATION_DATABASE_URL='${appUrl}'`, `MIGRATION_DATABASE_URL='${ownerUrl}'`,
      `DATABASE_SSL_CA_FILE='${caFile.startsWith('/') ? relative(BACKEND_DIRECTORY, caFile) : caFile}'`, `SUPABASE_PROJECT_REF='${PROJECT_REF}'`, '',
    ].join('\n'), 'utf8');
    await secretHandle.sync();
    await syncSecretDirectory();
    await admin.query("SET LOCAL password_encryption='scram-sha-256'");
    // 密码是运行时随机十六进制，仅用于角色创建及私密文件，不进入日志。
    for (const [role, password] of [[OWNER_ROLE, ownerSecret], [APP_ROLE, appSecret]]) {
      await admin.query(`CREATE ROLE ${quoteIdentifier(role)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    }
    // PG17 的 CREATEROLE 自动成员关系不保证 SET 权限；仅临时允许 admin 切换 owner。
    await admin.query('GRANT restaurant_owner TO postgres WITH SET TRUE, INHERIT FALSE');
    await admin.query('REVOKE CREATE ON DATABASE postgres FROM PUBLIC');
    await admin.query('GRANT CONNECT ON DATABASE postgres TO restaurant_owner,restaurant_app');
    await admin.query(`REVOKE USAGE,CREATE ON SCHEMA public FROM PUBLIC,${API_ROLES.map(quoteIdentifier).join(',')}`);
    await admin.query('REVOKE CREATE ON SCHEMA public FROM restaurant_app');
    await admin.query('GRANT USAGE,CREATE ON SCHEMA public TO restaurant_owner WITH GRANT OPTION');
    await admin.query('SET LOCAL ROLE restaurant_owner');
    await admin.query('SET LOCAL search_path=public,pg_catalog');
    await hardenDefaults(admin);
    await admin.query('CREATE TABLE public.schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT pg_catalog.now())');
    for (const { version, sql, checksum } of migrations) {
      await admin.query(sql);
      await admin.query('INSERT INTO public.schema_migrations(version,checksum) VALUES($1,$2)', [version, checksum]);
    }
    await hardenObjects(admin);
    await admin.query('RESET ROLE');
    await admin.query('SET LOCAL search_path=public,pg_catalog');
    await admin.query(`REVOKE USAGE,CREATE ON SCHEMA public FROM PUBLIC,${API_ROLES.map(quoteIdentifier).join(',')}`);
    await admin.query('REVOKE CREATE ON SCHEMA public FROM restaurant_app,restaurant_owner');
    await admin.query('GRANT USAGE ON SCHEMA public TO restaurant_app');
    // 不向 app 授予任何角色；移除 PG17 创建角色时给予创建者的临时成员关系。
    await admin.query('REVOKE restaurant_app FROM postgres');
    await admin.query('SET LOCAL ROLE restaurant_owner');
    await admin.query('SET LOCAL search_path=public,pg_catalog');
    await verifyDatabaseState(admin, migrations);
    await admin.query('RESET ROLE');
    await admin.query('SET LOCAL search_path=public,pg_catalog');
    await admin.query('REVOKE restaurant_owner FROM postgres');
    await checkRoles(admin);
    await assertIdentity(admin, 'postgres');
    // 任何 COMMIT 传输异常均保留凭据：不能把成功 ROLLBACK 响应当作此前未提交的证据。
    commitAttempted = true;
    await admin.query('COMMIT');
    committed = true;
    transactionOpen = false;
    return { appUrl, ownerUrl };
  } catch (error) {
    let rolledBack = false;
    if (transactionOpen && !committed) {
      try { await admin.query('ROLLBACK'); rolledBack = true; } catch { /* 状态不确定时保留凭据。 */ }
    }
    if (secretHandle && !commitAttempted && rolledBack) {
      try { await removeRollbackSecret(secretHandle); } catch { throw new SupabaseBlockedError('ROLLBACK_SECRET_CLEANUP_BLOCKED'); }
    }
    if (commitAttempted && !committed) throw new SupabaseBlockedError('COMMIT_STATUS_UNKNOWN_CREDENTIALS_PRESERVED');
    if (secretHandle && !rolledBack && !committed) throw new SupabaseBlockedError('ROLLBACK_STATUS_UNKNOWN_CREDENTIALS_PRESERVED');
    throw error;
  } finally {
    if (secretHandle) {
      try { await secretHandle.close(); } catch { if (committed) throw new SupabaseBlockedError('COMMITTED_CREDENTIAL_FILE_CLOSE_FAILED'); }
    }
  }
}

async function verifyExisting(caFile: string, migrations: Migration[]): Promise<object> {
  const appUrl = process.env.APPLICATION_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
  const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? '';
  requireCheck(appUrl && ownerUrl, 'ALREADY_INITIALIZED_VERIFIER_CREDENTIALS_REQUIRED');
  requireCheck(!process.env.APPLICATION_DATABASE_URL || !process.env.DATABASE_URL ||
    process.env.APPLICATION_DATABASE_URL === process.env.DATABASE_URL, 'CONFLICTING_APP_DATABASE_URLS');
  return verifySupabase(appUrl, ownerUrl, caFile, migrations);
}
async function main(): Promise<void> {
  const flags = process.argv.slice(2);
  requireCheck(flags.length <= 1 && flags.every(flag => ['--dry-run', '--apply-empty-production'].includes(flag)), 'UNKNOWN_OR_CONFLICTING_SETUP_FLAGS');
  const apply = flags[0] === '--apply-empty-production';
  const adminUrl = process.env.SUPABASE_ADMIN_DATABASE_URL ?? '';
  const caFile = process.env.DATABASE_SSL_CA_FILE ?? '';
  requireCheck(adminUrl && caFile && process.env.SUPABASE_PROJECT_REF, 'ADMIN_URL_CA_AND_PROJECT_REF_REQUIRED');
  const migrations = loadMigrations();
  const admin = configuredClient(adminUrl, 'postgres', caFile);
  let didCommit = false;
  try {
    await admin.connect();
    await beginReadOnly(admin);
    await lockOperations(admin);
    const tls = await assertIdentity(admin, 'postgres');
    const state = await preflight(admin, migrations);
    await admin.query('COMMIT');
    if (state === 'initialized') {
      writeReport(await verifyExisting(caFile, migrations));
      return;
    }
    assertSecretTargetAbsent();
    if (!apply) {
      writeReport({ status: 'dry-run', projectRef: PROJECT_REF, host: SESSION_HOST, database: 'postgres', postgres: '17.12',
        empty: true, migrations: migrations.length, wouldCreateRoles: 2, applyRequired: true,
        tls: { client: 'verify-full', explicitCa: true, adminDatabaseHop: tls }, manual: MANUAL_PENDING });
      return;
    }
    const credentials = await applyEmptyProduction(admin, adminUrl, caFile, migrations);
    didCommit = Boolean(credentials);
    try {
      const report = credentials
        ? await verifySupabase(credentials.appUrl, credentials.ownerUrl, caFile, migrations)
        : await verifyExisting(caFile, migrations);
      writeReport({ ...report, setup: credentials ? 'committed' : 'already-initialized', credentialsFile: 'backend/.env.supabase.local' });
    } catch {
      throw new SupabaseBlockedError(didCommit ? 'COMMITTED_READ_ONLY_VERIFICATION_BLOCKED_CREDENTIALS_SAVED' : 'EXISTING_DATABASE_VERIFICATION_BLOCKED');
    }
  } finally {
    await admin.end().catch(() => {});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(reportFailure);
