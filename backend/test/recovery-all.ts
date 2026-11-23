import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdtemp, open, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg, { type Pool, type PoolClient } from 'pg';
import { assertAppDatabase } from '../src/db.js';
import { readTestDatabaseScope, type TestDatabaseScope } from './database-scope.js';

const OWNER = 'restaurant_test_owner';
const APP = 'restaurant_test_app';
const ADMIN = 'restaurant_admin';
const QUOTA = 'public.apply_ai_quota_entry(text,text,text,text,text,bigint,bigint,bigint,text,text)';
const TABLES = [
  'schema_migrations', 'users', 'auth_identities', 'auth_sessions', 'auth_tokens',
  'restaurants', 'restaurant_members', 'opening_hours', 'email_outbox', 'audit_logs',
  'assets', 'asset_references', 'asset_upload_intents', 'website_agents',
  'website_versions', 'website_jobs', 'website_publications', 'website_publish_actions',
  'menu_drafts', 'menu_jobs', 'website_model_calls', 'reservations', 'reservation_events',
  'reservation_access_tokens', 'analytics_events', 'analytics_daily', 'billing_accounts',
  'ai_model_calls', 'ai_quota_periods', 'ai_quota_ledger', 'billing_plan_versions',
  'billing_price_versions', 'billing_credit_pack_versions', 'billing_offer_grants',
  'billing_subscriptions', 'website_version_sources', 'website_content_actions', 'ai_calendar_credit_grants',
].sort();
const MIGRATIONS = [
  '001_merchant_core', '002_assets', '003_asset_upload_intents', '004_websites',
  '005_menu_vision', '006_website_react', '007_website_usage', '008_reservations',
  '009_analytics', '010_ai_metering', '011_billing_catalog', '012_website_content', '013_calendar_test_credits', '014_calendar_credit_guards',
];

class RecoveryError extends Error {
  constructor(readonly code: string, readonly diagnostic?: { object: string; fields: string[] }) { super('恢复验证未通过'); }
}
function requireCheck(value: unknown, code: string): asserts value {
  if (!value) throw new RecoveryError(code);
}
function equal(actual: unknown, expected: unknown, code: string): void {
  requireCheck(JSON.stringify(actual) === JSON.stringify(expected), code);
}
function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
function adminEndpoint(scope: TestDatabaseScope): URL {
  const value = process.env.TEST_DATABASE_ADMIN_URL;
  requireCheck(value && !/[\s\\?#\u0000]/u.test(value), 'LOCAL_ADMIN_URL_REQUIRED');
  let url: URL;
  try { url = new URL(value); } catch { throw new RecoveryError('LOCAL_ADMIN_URL_INVALID'); }
  requireCheck(['postgres:', 'postgresql:'].includes(url.protocol) &&
    url.hostname === '127.0.0.1' && url.port === scope.port && url.pathname === '/postgres' &&
    url.username === ADMIN && url.password && !url.search && !url.hash &&
    value.slice(value.lastIndexOf('@') + 1) === `127.0.0.1:${scope.port}/postgres`, 'LOCAL_ADMIN_ENDPOINT_MISMATCH');
  try { requireCheck(decodeURIComponent(url.password).length > 0, 'LOCAL_ADMIN_PASSWORD_REQUIRED'); }
  catch { throw new RecoveryError('LOCAL_ADMIN_PASSWORD_INVALID'); }
  return url;
}

// 不继承用户环境、PGSERVICE、PGOPTIONS、日志位置或任何默认连接设置。
function childEnvironment(directory: string, bin: string, password?: string, readOnly = true): NodeJS.ProcessEnv {
  return {
    PATH: bin, HOME: directory, LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
    PGCONNECT_TIMEOUT: '10', PGSSLMODE: 'disable', PGAPPNAME: 'restaurant-recovery-all',
    PGPASSFILE: join(directory, 'unused.pgpass'), PGSERVICEFILE: join(directory, 'unused.pg_service.conf'),
    PGOPTIONS: `-c default_transaction_read_only=${readOnly ? 'on' : 'off'} -c timezone=UTC`,
    ...(password === undefined ? {} : { PGPASSWORD: password }),
  };
}
async function runTool(bin: string, tool: 'psql' | 'pg_dump' | 'pg_restore', args: string[],
  env: NodeJS.ProcessEnv, captureVersion = false): Promise<string> {
  return new Promise((accept, reject) => {
    const child = spawn(join(bin, tool), args, {
      env, shell: false, stdio: ['ignore', captureVersion ? 'pipe' : 'ignore', 'pipe'],
    });
    let output = '', diagnostics = '', tooLarge = false;
    child.stderr?.on('data', (data: Buffer) => { if (diagnostics.length < 32768) diagnostics += data.toString('utf8'); });
    child.stdout?.on('data', (data: Buffer) => {
      if (output.length + data.length > (tool === 'pg_restore' && args.includes('--list') ? 1048576 : 4096)) tooLarge = true;
      else output += data.toString('utf8');
    });
    child.on('error', () => reject(new RecoveryError(`${tool.toUpperCase()}_SPAWN_FAILED`)));
    child.on('close', code => {
      if (code !== 0 || tooLarge) {
        const reason = /schema "public" already exists/i.test(diagnostics) ? '_PUBLIC_SCHEMA_EXISTS' : /permission denied/i.test(diagnostics) ? '_PERMISSION_DENIED' : /violates.*constraint/i.test(diagnostics) ? '_CONSTRAINT' : '';
        reject(new RecoveryError(`${tool.toUpperCase()}_FAILED${reason}`));
      }
      else accept(output);
    });
  });
}

async function verifyIdentity(db: Pool | PoolClient, scope: TestDatabaseScope,
  database: string, role: typeof OWNER | typeof APP | typeof ADMIN): Promise<void> {
  const { rows } = await db.query(`SELECT current_database() AS database,current_user AS role,
    session_user AS session_role,host(inet_server_addr()) AS host,inet_server_port() AS port,
    current_setting('server_version_num')::integer AS version,
    pg_catalog.pg_get_userbyid(d.datdba) AS database_owner,
    r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,r.rolreplication,r.rolcanlogin,
    EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid) AS memberships,
    EXISTS(SELECT 1 FROM pg_catalog.pg_roles privileged WHERE privileged.oid<>r.oid AND
      (privileged.rolsuper OR privileged.rolcreatedb OR privileged.rolcreaterole OR
       privileged.rolbypassrls OR privileged.rolreplication) AND
      pg_catalog.pg_has_role(current_user,privileged.oid,'SET')) AS can_assume_admin
    FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_database d ON d.datname=current_database()
    WHERE r.rolname=current_user`);
  const row = rows[0];
  requireCheck(row && row.database === database && row.role === role && row.session_role === role &&
    row.host === '127.0.0.1' && row.port === Number(scope.port) && Number.isInteger(row.version) &&
    Math.floor(row.version / 10000) === scope.major && row.rolcanlogin === true, 'DATABASE_IDENTITY_MISMATCH');
  if (role === ADMIN) {
    requireCheck(database === 'postgres' && row.rolsuper === true, 'LOCAL_SUPERUSER_REQUIRED');
  } else {
    requireCheck(row.database_owner === OWNER && row.memberships === false && row.can_assume_admin === false &&
      [row.rolsuper, row.rolcreatedb, row.rolcreaterole, row.rolbypassrls, row.rolreplication]
        .every(value => value === false), 'TEST_ROLE_HAS_ADMIN_PRIVILEGES');
  }
}
async function verifyApp(pool: Pool, scope: TestDatabaseScope, database: string): Promise<void> {
  await verifyIdentity(pool, scope, database, APP);
  await assertAppDatabase(pool);
  const { rows } = await pool.query(`SELECT
    pg_catalog.has_database_privilege(current_user,current_database(),'CONNECT') AS connect,
    pg_catalog.has_schema_privilege(current_user,'public','USAGE') AS schema_usage,
    pg_catalog.has_table_privilege(current_user,'public.users','SELECT') AS users_read,
    pg_catalog.has_function_privilege(current_user,$1,'EXECUTE') AS quota_execute,
    EXISTS(SELECT 1 FROM unnest(ARRAY['public.ai_quota_periods','public.ai_quota_ledger']) AS t(name)
      WHERE pg_catalog.has_any_column_privilege(current_user,t.name,'INSERT') OR
        pg_catalog.has_any_column_privilege(current_user,t.name,'UPDATE') OR
        pg_catalog.has_table_privilege(current_user,t.name,'DELETE')) AS quota_write`, [QUOTA]);
  const row = rows[0];
  requireCheck(row && row.connect === true && row.schema_usage === true && row.users_read === true &&
    row.quota_execute === false && row.quota_write === false, 'APP_ACL_VERIFICATION_FAILED');
}

// ACL 数组顺序和物理 OID 不参与比较；NULL ACL 展开为对应对象的有效默认权限。
function acl(expression: string): string {
  return `COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'grantor',pg_catalog.pg_get_userbyid(a.grantor),
    'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
    'privilege',a.privilege_type,'grantable',a.is_grantable)
    ORDER BY pg_catalog.pg_get_userbyid(a.grantor) COLLATE "C",
      (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END) COLLATE "C",
      a.privilege_type COLLATE "C",a.is_grantable)
    FROM pg_catalog.aclexplode(CASE WHEN cardinality(${expression})>0 THEN ${expression} ELSE NULL::aclitem[] END) a),'[]'::jsonb)`;
}
const RELATIONS = `SELECT c.oid,c.relowner,c.relname,c.relkind,c.relpersistence,c.relrowsecurity,
  c.relforcerowsecurity,c.relreplident,c.relispartition,c.relpartbound,c.relam,c.reloptions,c.relacl,n.nspname
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND pg_catalog.pg_get_userbyid(c.relowner)=$1
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d
      WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')`;
const ROUTINES = `SELECT p.oid,p.proname,p.proowner,p.prokind,p.prolang,p.prosecdef,p.proisstrict,
  p.proleakproof,p.provolatile,p.proparallel,p.proconfig,p.proacl,n.nspname
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND pg_catalog.pg_get_userbyid(p.proowner)=$1
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d
      WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')`;
const CATALOG_SQL = {
  relations: `WITH project AS (${RELATIONS}) SELECT
    format('%I.%I',c.nspname,c.relname) AS name,c.relkind::text AS kind,
    pg_catalog.pg_get_userbyid(c.relowner) AS owner,c.relpersistence::text AS persistence,
    c.relrowsecurity AS row_security,c.relforcerowsecurity AS force_row_security,
    c.relreplident::text AS replica_identity,c.relispartition AS is_partition,
    pg_catalog.pg_get_expr(c.relpartbound,c.oid) AS partition_bound,
    CASE WHEN c.relkind='p' THEN pg_catalog.pg_get_partkeydef(c.oid) ELSE NULL END AS partition_key,
    am.amname AS access_method,
    ARRAY(SELECT v FROM unnest(c.reloptions) AS o(v) ORDER BY v COLLATE "C") AS options,
    ${acl(`COALESCE(c.relacl,pg_catalog.acldefault(
      CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))`)} AS grants
    FROM project c LEFT JOIN pg_catalog.pg_am am ON am.oid=c.relam
    ORDER BY name`,
  columns: `WITH project AS (${RELATIONS}) SELECT
    format('%I.%I',c.nspname,c.relname) AS relation,a.attname AS name,
    row_number() OVER(PARTITION BY c.oid ORDER BY a.attnum)::integer AS position,
    pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
    CASE WHEN coll.oid IS NULL THEN NULL ELSE format('%I.%I',cn.nspname,coll.collname) END AS collation,
    a.attnotnull AS not_null,a.attidentity::text AS identity,a.attgenerated::text AS generated,
    a.attstorage::text AS storage,a.attcompression::text AS compression,
    pg_catalog.pg_get_expr(ad.adbin,ad.adrelid) AS default_expression,
    ${acl("COALESCE(a.attacl,'{}'::aclitem[])")} AS grants
    FROM project c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
    LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid=c.oid AND ad.adnum=a.attnum
    LEFT JOIN pg_catalog.pg_collation coll ON coll.oid=a.attcollation
    LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=coll.collnamespace
    WHERE a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m','c','f')
    ORDER BY relation,position`,
  constraints: `WITH project AS (${RELATIONS}) SELECT
    format('%I.%I',c.nspname,c.relname) AS relation,k.conname AS name,k.contype::text AS type,
    pg_catalog.pg_get_constraintdef(k.oid,false) AS definition,k.convalidated AS validated,
    k.condeferrable AS deferrable,k.condeferred AS initially_deferred,k.connoinherit AS no_inherit,
    CASE WHEN ref.oid IS NULL THEN NULL ELSE format('%I.%I',rn.nspname,ref.relname) END AS referenced_relation
    FROM project c JOIN pg_catalog.pg_constraint k ON k.conrelid=c.oid
    LEFT JOIN pg_catalog.pg_class ref ON ref.oid=k.confrelid
    LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid=ref.relnamespace
    ORDER BY relation,name`,
  // 内部外键触发器由约束定义验证，不比较其含 OID 的自动生成名称。
  triggers: `WITH project AS (${RELATIONS}) SELECT
    format('%I.%I',c.nspname,c.relname) AS relation,t.tgname AS name,
    pg_catalog.pg_get_triggerdef(t.oid,false) AS definition,t.tgenabled::text AS enabled,
    format('%I.%I(%s)',pn.nspname,p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid)) AS function,
    k.conname AS constraint_name,t.tgdeferrable AS deferrable,t.tginitdeferred AS initially_deferred
    FROM project c JOIN pg_catalog.pg_trigger t ON t.tgrelid=c.oid
    JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
    LEFT JOIN pg_catalog.pg_constraint k ON k.oid=t.tgconstraint
    WHERE NOT t.tgisinternal ORDER BY relation,name`,
  indexes: `WITH project AS (${RELATIONS}) SELECT
    format('%I.%I',c.nspname,c.relname) AS name,
    format('%I.%I',tn.nspname,t.relname) AS relation,
    pg_catalog.pg_get_indexdef(c.oid,0,false) AS definition,i.indisunique AS unique_index,
    i.indisprimary AS primary_index,i.indisexclusion AS exclusion,i.indisvalid AS valid,
    i.indisready AS ready,i.indimmediate AS immediate,i.indisreplident AS replica_identity,
    i.indnullsnotdistinct AS nulls_not_distinct
    FROM project c JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
    JOIN pg_catalog.pg_class t ON t.oid=i.indrelid
    JOIN pg_catalog.pg_namespace tn ON tn.oid=t.relnamespace ORDER BY name`,
  functions: `WITH project AS (${ROUTINES}) SELECT
    format('%I.%I(%s)',p.nspname,p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid)) AS name,
    pg_catalog.pg_get_userbyid(p.proowner) AS owner,p.prokind::text AS kind,l.lanname AS language,
    pg_catalog.pg_get_function_arguments(p.oid) AS arguments,
    pg_catalog.pg_get_function_result(p.oid) AS result,
    pg_catalog.pg_get_functiondef(p.oid) AS definition,p.prosecdef AS security_definer,
    p.proisstrict AS strict,p.proleakproof AS leakproof,p.provolatile::text AS volatility,
    p.proparallel::text AS parallel,
    ARRAY(SELECT v FROM unnest(p.proconfig) AS o(v) ORDER BY v COLLATE "C") AS settings,
    ${acl("COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))")} AS grants
    FROM project p JOIN pg_catalog.pg_language l ON l.oid=p.prolang ORDER BY name`,
  schemas: `SELECT n.nspname AS name,pg_catalog.pg_get_userbyid(n.nspowner) AS owner,
    ${acl("COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))")} AS grants
    FROM pg_catalog.pg_namespace n WHERE n.nspname='public' AND $1::text IS NOT NULL`,
  default_acls: `SELECT pg_catalog.pg_get_userbyid(d.defaclrole) AS owner,
    COALESCE(n.nspname,'<global>') AS schema,d.defaclobjtype::text AS object_type,
    ${acl('d.defaclacl')} AS grants
    FROM pg_catalog.pg_default_acl d LEFT JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace
    WHERE pg_catalog.pg_get_userbyid(d.defaclrole)=$1 AND (d.defaclnamespace=0 OR n.nspname='public')
    ORDER BY owner,schema,object_type`,
  policies: `WITH project AS (${RELATIONS}) SELECT
    format('%I.%I',c.nspname,c.relname) AS relation,p.polname AS name,p.polcmd::text AS command,
    p.polpermissive AS permissive,
    ARRAY(SELECT CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(role_oid) END
      FROM unnest(p.polroles) AS r(role_oid)
      ORDER BY (CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(role_oid) END) COLLATE "C") AS roles,
    pg_catalog.pg_get_expr(p.polqual,p.polrelid) AS using_expression,
    pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression
    FROM project c JOIN pg_catalog.pg_policy p ON p.polrelid=c.oid
    ORDER BY relation,name`,
  rules: `WITH project AS (${RELATIONS}) SELECT
    format('%I.%I',c.nspname,c.relname) AS relation,r.rulename AS name,
    r.ev_enabled::text AS enabled,pg_catalog.pg_get_ruledef(r.oid,false) AS definition
    FROM project c JOIN pg_catalog.pg_rewrite r ON r.ev_class=c.oid
    ORDER BY relation,name`,
  sequences: `WITH project AS (${RELATIONS}) SELECT
    format('%I.%I',c.nspname,c.relname) AS name,pg_catalog.format_type(s.seqtypid,NULL) AS type,
    s.seqstart::text AS start,s.seqincrement::text AS increment,s.seqmax::text AS maximum,
    s.seqmin::text AS minimum,s.seqcache::text AS cache,s.seqcycle AS cycle
    FROM project c JOIN pg_catalog.pg_sequence s ON s.seqrelid=c.oid ORDER BY name`,
};
type Catalog = Record<keyof typeof CATALOG_SQL, Record<string, unknown>[]>;

export function canonicalConstraintDefinition(definition: string): string {
  // pg_dump/pg_restore 会将无长度限制 varchar 常量数组的 text[] 转换下推到各元素；仅规范此等价情况。
  return definition
    .replace(/\('((?:''|[^'])*)'::character varying\)::text/g, "'$1'::text")
    .replace(/'((?:''|[^'])*)'::character varying(?![\w(])/g, "'$1'::text")
    .replace(/\(\(ARRAY\[([\s\S]*?)\]\)::text\[\]\)/g, (whole, constants: string) =>
      /^'(?:''|[^'])*'::text(?:,\s*'(?:''|[^'])*'::text)*$/.test(constants) ? `(ARRAY[${constants}])` : whole);
}
async function catalog(db: PoolClient): Promise<Catalog> {
  const { rows } = await db.query(`SELECT
    EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND pg_catalog.pg_get_userbyid(c.relowner)<>$1 AND
        NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass
          AND d.objid=c.oid AND d.deptype='e')) AS foreign_relations,
    EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND (pg_catalog.pg_get_userbyid(p.proowner)<>$1 OR p.prokind='a') AND
        NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_proc'::regclass
          AND d.objid=p.oid AND d.deptype='e')) AS foreign_routines`, [OWNER]);
  requireCheck(rows[0]?.foreign_relations === false && rows[0]?.foreign_routines === false,
    'PUBLIC_OBJECT_SCOPE_MISMATCH');
  const result = {} as Catalog;
  for (const key of Object.keys(CATALOG_SQL) as (keyof Catalog)[]) {
    // 跨数据库使用固定 UTF-8 字节顺序，不依赖各库的默认排序规则。
    try {
      const rows = (await db.query(CATALOG_SQL[key], [OWNER])).rows;
      if (key === 'constraints') for (const row of rows) row.definition = canonicalConstraintDefinition(String(row.definition));
      result[key] = rows.sort((left, right) => Buffer.compare(Buffer.from(JSON.stringify(left)), Buffer.from(JSON.stringify(right))));
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{5,64}$/.test(error.code) ? error.code : 'QUERY_FAILED';
      throw new RecoveryError(`CATALOG_${key.toUpperCase()}_${code}`);
    }
  }
  const tables = result.relations.filter(row => row.kind === 'r' || row.kind === 'p').map(row => row.name).sort();
  equal(tables, TABLES.map(name => `public.${name}`), 'PROJECT_TABLE_INVENTORY_REQUIRED');
  requireCheck(result.relations.every(row => row.kind !== 'f'), 'FOREIGN_TABLES_NOT_ALLOWED');
  requireCheck(result.schemas.length === 1 && result.schemas[0].owner === 'pg_database_owner',
    'PUBLIC_SCHEMA_OWNER_MISMATCH');
  return result;
}

type Fingerprint = { count: string; sha256: string };
async function dataFingerprints(db: PoolClient): Promise<Record<string, Fingerprint>> {
  const result: Record<string, Fingerprint> = {};
  for (const table of TABLES) {
    const name = `public.${identifier(table)}`;
    const count = (await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${name}`)).rows[0]?.count;
    requireCheck(typeof count === 'string' && /^\d+$/.test(count), 'TABLE_COUNT_FAILED');
    // JSONB 在服务器端规范化所有字段和嵌套 JSON；不经 JS 数值转换，不输出任何行内容。
    await db.query(`DECLARE recovery_rows NO SCROLL CURSOR FOR
      SELECT row_text FROM (SELECT pg_catalog.to_jsonb(t)::text AS row_text FROM ${name} t) canonical
      ORDER BY row_text COLLATE "C"`);
    const hash = createHash('sha256');
    let seen = 0n;
    try {
      for (;;) {
        const { rows } = await db.query<{ row_text: string }>('FETCH FORWARD 512 FROM recovery_rows');
        if (rows.length === 0) break;
        for (const { row_text: text } of rows) {
          requireCheck(typeof text === 'string', 'CANONICAL_ROW_INVALID');
          hash.update(`${Buffer.byteLength(text, 'utf8')}:`);
          hash.update(text, 'utf8');
          seen += 1n;
        }
      }
    } finally { await db.query('CLOSE recovery_rows'); }
    requireCheck(seen.toString() === count, 'SNAPSHOT_ROW_COUNT_MISMATCH');
    result[table] = { count, sha256: hash.digest('hex') };
  }
  return result;
}
async function verifyMigrations(db: PoolClient): Promise<void> {
  const { rows } = await db.query<{ version: string; checksum: string }>(
    'SELECT version,checksum FROM public.schema_migrations ORDER BY version COLLATE "C"');
  equal(rows.map(row => row.version), MIGRATIONS, 'FULL_MIGRATION_HISTORY_REQUIRED');
  requireCheck(rows.every(row => /^[a-f0-9]{64}$/.test(row.checksum)), 'MIGRATION_CHECKSUM_INVALID');
}

async function main(): Promise<object> {
  // 两个测试 URL 必须先共同通过共享验证器；从不读取开发连接或私密 env 文件。
  const scope = readTestDatabaseScope();
  const adminUrl = adminEndpoint(scope);
  const ownerUrl = new URL(scope.migrationDatabaseUrl), appUrl = new URL(scope.databaseUrl);
  const binInput = process.env.PG_BIN_DIR;
  requireCheck(binInput && isAbsolute(binInput) && !binInput.includes('\u0000'), 'ABSOLUTE_PG_BIN_DIR_REQUIRED');
  const bin = resolve(binInput);
  requireCheck((await stat(bin)).isDirectory(), 'PG_BIN_DIR_INVALID');
  for (const tool of ['psql', 'pg_dump', 'pg_restore']) {
    const executable = join(bin, tool);
    requireCheck((await stat(executable)).isFile(), 'PG_TOOL_MISSING');
    await access(executable, constants.X_OK);
  }
  const directory = await mkdtemp('/tmp/restaurant-recovery-all-');
  await chmod(directory, 0o700);
  const archive = join(directory, 'public.dump');
  const file = await open(archive, 'wx', 0o600);
  await file.close();
  for (const tool of ['psql', 'pg_dump', 'pg_restore'] as const) {
    const version = await runTool(bin, tool, ['--version'], childEnvironment(directory, bin), true);
    const match = new RegExp(`^${tool} \\(PostgreSQL\\) (\\d+)(?:\\.\\d+)+\\b`).exec(version.trim());
    requireCheck(match && Number(match[1]) === scope.major, 'PG_TOOL_MAJOR_MISMATCH');
  }

  const database = `restaurant_restore_test_${randomBytes(12).toString('hex')}`;
  const pools: Pool[] = [];
  let connectionFailed = false;
  function pool(url: URL, target = url.pathname.slice(1)): Pool {
    const connection = new pg.Pool({
      host: '127.0.0.1', port: Number(scope.port), database: target,
      user: url.username, password: decodeURIComponent(url.password), ssl: false, max: 1,
      connectionTimeoutMillis: 10000, statement_timeout: 0, lock_timeout: 10000,
      // 导出快照期间必须允许外部 pg_dump 并发执行，不使用 createPool 的短空闲事务超时。
      idle_in_transaction_session_timeout: 0, application_name: 'restaurant-recovery-all',
      options: '-c default_transaction_read_only=on -c search_path=public,pg_catalog -c timezone=UTC' +
        ' -c idle_in_transaction_session_timeout=0 -c statement_timeout=0 -c lock_timeout=10000' +
        ' -c datestyle=ISO,YMD -c intervalstyle=postgres -c extra_float_digits=3 -c bytea_output=hex',
    });
    connection.on('error', () => { connectionFailed = true; });
    pools.push(connection);
    return connection;
  }
  let sourceClient: PoolClient | undefined, restoredClient: PoolClient | undefined;
  let sourceTransaction = false, restoredTransaction = false;
  let report: object | undefined;
  try {
    const admin = pool(adminUrl), source = pool(ownerUrl), sourceApp = pool(appUrl);
    await verifyIdentity(admin, scope, 'postgres', ADMIN);
    sourceClient = await source.connect();
    sourceClient.on('error', () => { connectionFailed = true; });
    await verifyIdentity(sourceClient, scope, 'restaurant_test', OWNER);
    await verifyApp(sourceApp, scope, 'restaurant_test');
    await sourceClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    sourceTransaction = true;
    await sourceClient.query('SET LOCAL search_path=pg_catalog');
    const snapshot = (await sourceClient.query<{ snapshot: string }>(
      'SELECT pg_catalog.pg_export_snapshot() AS snapshot')).rows[0]?.snapshot;
    requireCheck(snapshot && /^[a-f0-9]+-[a-f0-9]+-\d+$/i.test(snapshot), 'SNAPSHOT_EXPORT_FAILED');
    const expectedCatalog = await catalog(sourceClient);
    await verifyMigrations(sourceClient);
    const expectedData = await dataFingerprints(sourceClient);
    const sourceArgs = ['-h', '127.0.0.1', '-p', scope.port, '-U', OWNER, '-d', 'restaurant_test'];
    await runTool(bin, 'pg_dump', [...sourceArgs, '-w', '-Fc', '--schema=public', '--strict-names',
      `--snapshot=${snapshot}`, '-f', archive], childEnvironment(directory, bin, decodeURIComponent(ownerUrl.password)));
    requireCheck(((await stat(archive)).mode & 0o077) === 0 && (await stat(archive)).size > 0,
      'PRIVATE_ARCHIVE_REQUIRED');
    await sourceClient.query('COMMIT');
    sourceTransaction = false;
    sourceClient.release();
    sourceClient = undefined;

    // 管理员仅在已验证的本地集群中创建随机新库和设置该新库的 CONNECT 权限。
    await admin.query('SET default_transaction_read_only=off');
    await admin.query(`CREATE DATABASE ${identifier(database)} WITH TEMPLATE template0 OWNER ${identifier(OWNER)}`);
    await admin.query(`REVOKE ALL ON DATABASE ${identifier(database)} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${identifier(database)} TO ${identifier(OWNER)},${identifier(APP)}`);
    await admin.query('SET default_transaction_read_only=on');
    // template0 已有 public：仅跳过重复 CREATE SCHEMA 条目，保留 schema ACL/COMMENT；不 DROP/--clean。
    const listing = await runTool(bin, 'pg_restore', ['--list', archive], childEnvironment(directory, bin), true);
    const lines = listing.split('\n');
    const schemaLines = lines.filter(line => /^\d+;\s+\d+\s+\d+\s+SCHEMA - public\s/.test(line));
    requireCheck(schemaLines.length === 1, 'PUBLIC_SCHEMA_TOC_REQUIRED');
    const restoreList = join(directory, 'restore-list.txt');
    const listHandle = await open(restoreList, 'wx', 0o600);
    try { await listHandle.writeFile(lines.filter(line => !schemaLines.includes(line)).join('\n')); }
    finally { await listHandle.close(); }
    // 不使用 --no-acl、--clean 或 --create；同一个非管理员 owner 恢复权限和全部迁移对象。
    await runTool(bin, 'pg_restore', ['-h', '127.0.0.1', '-p', scope.port, '-U', OWNER,
      '-d', database, '-w', '--no-owner', '--use-list=' + restoreList, '--exit-on-error', '--single-transaction', archive],
    childEnvironment(directory, bin, decodeURIComponent(ownerUrl.password), false));

    const restored = pool(ownerUrl, database);
    restoredClient = await restored.connect();
    restoredClient.on('error', () => { connectionFailed = true; });
    await verifyIdentity(restoredClient, scope, database, OWNER);
    await restoredClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    restoredTransaction = true;
    await restoredClient.query('SET LOCAL search_path=pg_catalog');
    const actualCatalog = await catalog(restoredClient);
    for (const key of Object.keys(CATALOG_SQL) as (keyof Catalog)[]) {
      if (JSON.stringify(actualCatalog[key]) !== JSON.stringify(expectedCatalog[key])) {
        const actualRow = actualCatalog[key].find(row => !expectedCatalog[key].some(expected => JSON.stringify(row) === JSON.stringify(expected)));
        const expectedRow = actualRow ? expectedCatalog[key].find(row => row.name === actualRow.name && row.relation === actualRow.relation) : undefined;
        const diagnostic = actualRow && expectedRow ? { object: String(actualRow.relation ?? '') + '.' + String(actualRow.name ?? ''),
          fields: Object.keys(actualRow).filter(field => JSON.stringify(actualRow[field]) !== JSON.stringify(expectedRow[field])) } : undefined;
        throw new RecoveryError(`RESTORED_${key.toUpperCase()}_MISMATCH`, diagnostic);
      }
    }
    await verifyMigrations(restoredClient);
    const actualData = await dataFingerprints(restoredClient);
    equal(actualData, expectedData, 'RESTORED_FULL_DATA_HASH_MISMATCH');
    await restoredClient.query('COMMIT');
    restoredTransaction = false;
    restoredClient.release();
    restoredClient = undefined;
    await verifyApp(pool(appUrl, database), scope, database);
    requireCheck(!connectionFailed, 'DATABASE_CONNECTION_FAILED');
    report = {
      recovery: 'passed', postgres_major: scope.major, restore_database: database,
      compared_tables: TABLES.length, migration_count: MIGRATIONS.length,
      table_counts: Object.fromEntries(TABLES.map(table => [table, expectedData[table].count])),
      object_counts: Object.fromEntries(Object.entries(expectedCatalog).map(([key, value]) => [key, value.length])),
      full_data_sha256_verified: true, snapshot_consistent: true, acl_verified: true,
      app_connect_verified: true, app_users_read_verified: true, app_quota_execute_denied: true,
      source_read_only: true, backup_kept_private: true, restore_database_kept: true,
    };
  } finally {
    // 即使失败也保留新库和私有备份；绝不删除或清空源库、恢复库。
    if (sourceClient) {
      if (sourceTransaction) await sourceClient.query('ROLLBACK').catch(() => {});
      sourceClient.release();
    }
    if (restoredClient) {
      if (restoredTransaction) await restoredClient.query('ROLLBACK').catch(() => {});
      restoredClient.release();
    }
    await Promise.all(pools.map(connection => connection.end()));
  }
  requireCheck(report && !connectionFailed, 'RECOVERY_NOT_VERIFIED');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(report => { process.stdout.write(`${JSON.stringify(report)}\n`); }).catch((error: unknown) => {
    // 不转发驱动错误、SQL、命令输出、密码、URL、快照或私有备份位置。
    const databaseCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{5,64}$/.test(error.code) ? error.code : undefined;
    const code = error instanceof RecoveryError ? error.code : `RECOVERY_OPERATION_FAILED${databaseCode ? `_${databaseCode}` : ''}`;
    process.stderr.write(`${JSON.stringify({ recovery: 'failed', code, ...(error instanceof RecoveryError && error.diagnostic ? { diagnostic: error.diagnostic } : {}) })}\n`);
    process.exitCode = 1;
  });
}
