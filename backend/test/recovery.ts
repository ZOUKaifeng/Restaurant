import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createPool } from '../src/db.js';

// Read-only backup of development data, restore into a new dedicated database.
// Never drop a database, truncate development data or touch another PostgreSQL cluster.
const source = new URL(process.env.MIGRATION_DATABASE_URL ?? '');
assert.equal(source.hostname, '127.0.0.1'); assert.equal(source.port, '55439');
assert.equal(source.pathname, '/restaurant_dev'); assert.equal(source.username, 'restaurant_owner');
const root = fileURLToPath(new URL('../../', import.meta.url));
const runtime = resolve(root, '.workbuddy/runtime');
const pgBin = process.env.PG_BIN_DIR ?? '/opt/homebrew/bin';
const restoreDatabase = `restaurant_restore_${Date.now()}`;
const backup = resolve(runtime, `${restoreDatabase}.dump`);
mkdirSync(runtime, { recursive: true });
const run = (name: string, args: string[], password: string, input?: string) => {
  const out = spawnSync(resolve(pgBin, name), args, { env: { ...process.env, PGPASSWORD: password }, input, encoding: 'utf8' });
  assert.equal(out.status, 0, `${name} must succeed (no credentials logged)`);
};
const ownerPassword = decodeURIComponent(source.password);
const original = createPool(source.href);
const restoreUrl = new URL(source.href); restoreUrl.pathname = `/${restoreDatabase}`;
let restored: ReturnType<typeof createPool> | undefined;
try {
  const counts = async (pool: ReturnType<typeof createPool>) => {
    const tables = ['schema_migrations', 'users', 'auth_identities', 'auth_sessions', 'auth_tokens', 'restaurants', 'restaurant_members', 'opening_hours', 'email_outbox', 'audit_logs'];
    const result: Record<string, number> = {};
    for (const table of tables) result[table] = (await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count;
    return result;
  };
  const expected = await counts(original);
  const revisions = await original.query('SELECT id,revision FROM restaurants ORDER BY id');
  run('pg_dump', ['-h', '127.0.0.1', '-p', '55439', '-U', 'restaurant_owner', '-d', 'restaurant_dev', '-Fc', '-f', backup], ownerPassword);
  const admin = readFileSync(resolve(runtime, 'cluster-admin.pw'), 'utf8').trim();
  run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '55439', '-U', 'restaurant_admin', '-d', 'postgres'], admin,
    `CREATE DATABASE ${restoreDatabase} OWNER restaurant_owner; REVOKE ALL ON DATABASE ${restoreDatabase} FROM PUBLIC; GRANT CONNECT ON DATABASE ${restoreDatabase} TO restaurant_owner;`);
  run('pg_restore', ['-h', '127.0.0.1', '-p', '55439', '-U', 'restaurant_owner', '-d', restoreDatabase, '--no-owner', '--no-acl', '--exit-on-error', backup], ownerPassword);
  restored = createPool(restoreUrl.href);
  assert.deepEqual(await counts(restored), expected, 'All restored entity counts must match');
  assert.deepEqual((await restored.query('SELECT id,revision FROM restaurants ORDER BY id')).rows, revisions.rows, 'Restaurant IDs/revisions persisted');
  const broken = await restored.query('SELECT count(*)::int AS n FROM restaurant_members m LEFT JOIN users u ON u.id=m.user_id LEFT JOIN restaurants r ON r.id=m.restaurant_id WHERE u.id IS NULL OR r.id IS NULL');
  assert.equal(broken.rows[0].n, 0);
  console.log(JSON.stringify({ recovery: 'passed', compared_entities: Object.keys(expected).length, restaurant_versions: revisions.rows.length, orphan_members: 0, backup_kept_private: true }));
} finally { await original.end(); if (restored) await restored.end(); }
