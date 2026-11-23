import pg, { type Pool, type PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type Database = Pool | PoolClient;
export function databaseConnectionOptions(connectionString: string, caFile = process.env.DATABASE_SSL_CA_FILE, caPem = process.env.DATABASE_SSL_CA): pg.ClientConfig {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('数据库连接协议无效');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (local) {
    if (url.search || url.hash) throw new Error('本地数据库 URL 不得附带主机、角色或会话覆盖参数');
    return { connectionString };
  }
  if (url.searchParams.get('sslmode') !== 'verify-full' || (!caFile && !caPem)) throw new Error('远程数据库必须配置 sslmode=verify-full 和 DATABASE_SSL_CA（或 DATABASE_SSL_CA_FILE）');
  if (caPem && caFile) throw new Error('远程数据库证书只能配置 DATABASE_SSL_CA 或 DATABASE_SSL_CA_FILE 其中一个');
  if (url.searchParams.has('ssl') || url.searchParams.has('sslcert') || url.searchParams.has('sslkey') || url.searchParams.has('sslrootcert')) {
    throw new Error('远程数据库证书只允许通过 DATABASE_SSL_CA 或 DATABASE_SSL_CA_FILE 配置，禁止混用 URL SSL 参数');
  }
  if (url.hash || [...url.searchParams.keys()].some(key => key !== 'sslmode') || url.searchParams.getAll('sslmode').length !== 1) {
    throw new Error('远程数据库 URL 不得附带主机、角色或其他会话覆盖参数');
  }
  const ca = caPem ? caPem.replace(/\\n/g, '\n') : readFileSync(caFile as string, 'utf8');
  if (!ca.includes('-----BEGIN CERTIFICATE-----') || ca.includes('PRIVATE KEY')) throw new Error('数据库 CA 文件无效');
  url.searchParams.delete('sslmode');
  return { connectionString: url.href, ssl: { ca, rejectUnauthorized: true, servername: url.hostname } };
}
export function isSupportedPostgresVersion(version: number): boolean {
  return Number.isInteger(version) && version >= 160000 && version < 180000;
}
export function createPool(connectionString: string): Pool {
  const pool = new pg.Pool({ ...databaseConnectionOptions(connectionString), max: 10, connectionTimeoutMillis: 5000, statement_timeout: 10000, idle_in_transaction_session_timeout: 10000 });
  pool.on('error', () => { process.stderr.write('数据库空闲连接失效\n'); });
  return pool;
}
export function id(prefix: string): string { return `${prefix}_${randomBytes(18).toString('base64url')}`; }
export async function assertAppDatabase(pool: Pool): Promise<void> {
  const { rows } = await pool.query(`SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,r.rolreplication,
    EXISTS(SELECT 1 FROM pg_roles privileged WHERE privileged.oid<>r.oid AND
      (privileged.rolsuper OR privileged.rolcreatedb OR privileged.rolcreaterole OR privileged.rolbypassrls OR
       privileged.rolreplication OR privileged.rolname IN ('restaurant_owner','restaurant_test_owner'))
      AND pg_has_role(current_user,privileged.oid,'SET')) AS can_assume_privileged_role,
    (has_database_privilege(current_user,current_database(),'CREATE') OR
      EXISTS(SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND has_schema_privilege(current_user,oid,'CREATE'))) AS ddl,
    EXISTS(SELECT 1 FROM pg_tables WHERE tableowner=current_user) AS owns_tables,
    current_setting('server_version_num')::int AS version
    FROM pg_roles r WHERE rolname=current_user`);
  const row = rows[0];
  if (!row || row.rolsuper || row.rolcreatedb || row.rolcreaterole || row.rolbypassrls || row.rolreplication || row.can_assume_privileged_role || row.ddl || row.owns_tables) throw new Error('应用数据库角色具有不允许的管理权限');
  if (!isSupportedPostgresVersion(row.version)) throw new Error('需要 PostgreSQL 16 或 17');
  await pool.query('SELECT id FROM users LIMIT 0');
}
export async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* 原始错误优先。 */ }
    throw error;
  } finally { client.release(); }
}
export async function audit(db: Database, userId: string, action: string, entityId: string, requestId: string, fields: string[] = [], restaurantId: string | null = null): Promise<void> {
  await db.query(`INSERT INTO audit_logs(id,restaurant_id,actor_type,actor_user_id,action,entity_type,entity_id,request_id,outcome,changed_fields)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'success',$9)`,
  [id('aud'), restaurantId, restaurantId ? 'merchant' : 'system', userId, action, restaurantId ? 'restaurant' : 'user', entityId, requestId, fields]);
}
