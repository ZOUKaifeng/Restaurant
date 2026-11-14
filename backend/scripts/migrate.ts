import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { createPool, transaction } from '../src/db.js';
import { validateDatabaseUrl } from '../src/config.js';

export async function migrate(pool: Pool, appRole = process.env.APP_DB_ROLE ?? 'restaurant_app'): Promise<void> {
  if (!['restaurant_app', 'restaurant_test_app'].includes(appRole)) throw new Error('APP_DB_ROLE 不在本轮固定角色白名单');
  const source = new URL('../migrations/001_merchant_core.sql', import.meta.url);
  const sql = readFileSync(existsSync(source) ? source : new URL('../../migrations/001_merchant_core.sql', import.meta.url), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  await transaction(pool, async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('merchant-core-migrations'))");
    const role = await db.query(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=$1`, [appRole]);
    if (!role.rows[0] || !role.rows[0].rolcanlogin || role.rows[0].rolsuper || role.rows[0].rolcreatedb || role.rows[0].rolcreaterole || role.rows[0].rolbypassrls) throw new Error('应用角色不存在或具有管理权限');
    await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = await db.query("SELECT checksum FROM schema_migrations WHERE version='001_merchant_core'");
    if (applied.rows[0]) {
      if (applied.rows[0].checksum !== checksum) throw new Error('已执行迁移被修改，必须创建新迁移');
      return;
    }
    await db.query(sql);
    await db.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', ['001_merchant_core', checksum]);
  });
}
async function main(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('缺少 MIGRATION_DATABASE_URL');
  validateDatabaseUrl(url);
  const pool = createPool(url);
  try { await migrate(pool); process.stdout.write('数据库迁移完成\n'); } finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { process.stderr.write('迁移失败，请核查 owner 配置、角色及迁移校验\n'); process.exitCode = 1; });
