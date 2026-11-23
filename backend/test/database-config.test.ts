import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databaseConnectionOptions, isSupportedPostgresVersion } from '../src/db.js';

const local = 'postgresql://restaurant_test_app:synthetic@127.0.0.1:55440/restaurant_test';
const remote = 'postgresql://restaurant_app.project:synthetic@database.example.test:5432/postgres';
test('supports only Postgres 16 and 17 without loosening role protection', () => {
  for (const version of [160000, 160012, 169999, 170000, 170012, 179999]) assert.equal(isSupportedPostgresVersion(version), true);
  for (const version of [159999, 180000, 170012.5, NaN, Infinity]) assert.equal(isSupportedPostgresVersion(version), false);
});
test('local isolated test connection is unchanged, even when remote CA is configured', () => {
  assert.deepEqual(databaseConnectionOptions(local, '/nonexistent/test-only-ca'), { connectionString: local });
});
test('local-looking SQL URLs cannot override the host, role or TLS through query parameters', () => {
  for (const parameter of ['host=database.example.test&sslmode=disable', 'hostaddr=203.0.113.10',
    'user=postgres', 'options=-c%20role=postgres', 'sslmode=disable']) {
    assert.throws(() => databaseConnectionOptions(`${local}?${parameter}`, '', ''), /本地数据库 URL/);
  }
  assert.throws(() => databaseConnectionOptions(`${local}#host=database.example.test`, '', ''), /本地数据库 URL/);
  assert.deepEqual(databaseConnectionOptions(local, '', ''), { connectionString: local });
});
test('remote SQL refuses plaintext and incomplete certificate configuration', () => {
  assert.throws(() => databaseConnectionOptions(remote, '/nonexistent/test-only-ca'), /verify-full/);
  assert.throws(() => databaseConnectionOptions(`${remote}?sslmode=require`, '/nonexistent/test-only-ca'), /verify-full/);
  assert.throws(() => databaseConnectionOptions(`${remote}?sslmode=verify-full`, ''), /DATABASE_SSL_CA_FILE/);
});
test('remote SQL accepts CA PEM text from DATABASE_SSL_CA without a file, and rejects ambiguous CA sources', () => {
  const ca = '-----BEGIN CERTIFICATE-----\nsynthetic-test-only\n-----END CERTIFICATE-----\n';
  const options = databaseConnectionOptions(`${remote}?sslmode=verify-full`, '', ca);
  assert.deepEqual(options.ssl, { ca, rejectUnauthorized: true, servername: 'database.example.test' });
  const escaped = databaseConnectionOptions(`${remote}?sslmode=verify-full`, '', ca.replace(/\n/g, '\\n'));
  assert.deepEqual((escaped.ssl as { ca: string }).ca, ca);
  assert.throws(() => databaseConnectionOptions(`${remote}?sslmode=verify-full`, '/tmp/x.crt', ca), /只能配置/);
  assert.throws(() => databaseConnectionOptions(`${remote}?sslmode=verify-full`, '', '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----'), /CA 文件无效/);
});
test('remote SQL CA is scoped to client config and hostname, URL cannot override TLS', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'table-folk-db-ca-test-'));
  const caFile = join(dir, 'synthetic.crt');
  const ca = '-----BEGIN CERTIFICATE-----\nsynthetic-test-only\n-----END CERTIFICATE-----\n';
  try {
    await writeFile(caFile, ca);
    const options = databaseConnectionOptions(`${remote}?sslmode=verify-full`, caFile);
    assert.equal(options.connectionString, remote);
    assert.deepEqual(options.ssl, { ca, rejectUnauthorized: true, servername: 'database.example.test' });
    for (const parameter of ['ssl=false', 'sslrootcert=/tmp/other', 'sslkey=/tmp/key', 'sslcert=/tmp/cert', 'host=other.example', 'options=-c%20role=postgres', 'sslmode=require']) {
      assert.throws(() => databaseConnectionOptions(`${remote}?sslmode=verify-full&${parameter}`, caFile));
    }
    await writeFile(caFile, '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----');
    assert.throws(() => databaseConnectionOptions(`${remote}?sslmode=verify-full`, caFile), /CA 文件无效/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
