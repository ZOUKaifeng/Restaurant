import pg, { type Pool, type PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';

export type Database = Pool | PoolClient;
export function createPool(connectionString: string): Pool {
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, statement_timeout: 10000, idle_in_transaction_session_timeout: 10000 });
  pool.on('error', () => { process.stderr.write('数据库空闲连接失效\n'); });
  return pool;
}
export function id(prefix: string): string { return `${prefix}_${randomBytes(18).toString('base64url')}`; }
export async function assertAppDatabase(pool: Pool): Promise<void> {
  const { rows } = await pool.query(`SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,
    (has_database_privilege(current_user,current_database(),'CREATE') OR
      EXISTS(SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND has_schema_privilege(current_user,oid,'CREATE'))) AS ddl,
    EXISTS(SELECT 1 FROM pg_tables WHERE tableowner=current_user) AS owns_tables,
    current_setting('server_version_num')::int AS version
    FROM pg_roles r WHERE rolname=current_user`);
  const row = rows[0];
  if (!row || row.rolsuper || row.rolcreatedb || row.rolcreaterole || row.rolbypassrls || row.ddl || row.owns_tables) throw new Error('应用数据库角色具有不允许的管理权限');
  if (row.version < 160000 || row.version >= 170000) throw new Error('需要独立 PostgreSQL 16');
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
