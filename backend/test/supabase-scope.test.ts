import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionConfig, loadMigrations, projectTables, PROJECT_REF, SESSION_HOST } from '../scripts/verify-supabase.js';

test('Supabase empty initializer catalogue contains the exact current migrations, including calendar schema but no grants', () => {
  const migrations = loadMigrations();
  assert.equal(migrations.length, 14);
  const tables = projectTables(migrations);
  assert.equal(tables.length, 38);
  assert.equal(new Set(tables).size, tables.length);
  assert.ok(tables.includes('ai_calendar_credit_grants'));
  assert.equal(migrations[9].checksum, '73461c93420bf4cc1af48013b647c27a6ad226fdf396be9a283acac263ae895e');
});
test('Supabase initializer rejects other projects, hosts, ports, database names, roles and TLS overrides', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'table-folk-supabase-scope-'));
  const caFile = join(directory, 'test.crt');
  const previous = process.env.SUPABASE_PROJECT_REF;
  process.env.SUPABASE_PROJECT_REF = PROJECT_REF;
  try {
    await writeFile(caFile, '-----BEGIN CERTIFICATE-----\nsynthetic-not-a-real-certificate\n-----END CERTIFICATE-----\n');
    const base = `postgresql://restaurant_app.${PROJECT_REF}:synthetic@${SESSION_HOST}:5432/postgres?sslmode=verify-full`;
    const config = connectionConfig(base, 'restaurant_app', caFile);
    assert.equal(typeof config.ssl, 'object');
    assert.equal((config.ssl as { rejectUnauthorized: boolean }).rejectUnauthorized, true);
    for (const changed of [base.replace(PROJECT_REF, 'otherproject'), base.replace(SESSION_HOST, '127.0.0.1'), base.replace(':5432', ':6543'), base.replace('/postgres?', '/restaurant_dev?'), base.replace('restaurant_app.', 'postgres.'), base.replace('verify-full', 'require'), `${base}&host=other`, `${base}#override`]) {
      assert.throws(() => connectionConfig(changed, 'restaurant_app', caFile));
    }
    process.env.SUPABASE_PROJECT_REF = 'another';
    assert.throws(() => connectionConfig(base, 'restaurant_app', caFile), /安全检查阻断/);
  } finally {
    if (previous === undefined) delete process.env.SUPABASE_PROJECT_REF; else process.env.SUPABASE_PROJECT_REF = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
