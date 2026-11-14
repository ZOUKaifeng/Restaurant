import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Only this project's dedicated localhost cluster; never inspect or modify other clusters.
const root = fileURLToPath(new URL('../../', import.meta.url));
const runtime = resolve(root, '.workbuddy/runtime');
const cluster = resolve(runtime, 'postgres');
const port = '55439';
const pgBin = process.env.PG_BIN_DIR ?? '/opt/homebrew/bin';
const call = (name, args, options = {}) => {
  const result = spawnSync(resolve(pgBin, name), args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(`${name} failed; inspect local service configuration (secrets not logged)`);
  return result.stdout;
};
const secret = () => randomBytes(32).toString('hex');
mkdirSync(runtime, { recursive: true });
const adminPasswordFile = resolve(runtime, 'cluster-admin.pw');
if (!existsSync(adminPasswordFile)) writeFileSync(adminPasswordFile, secret(), { mode: 0o600, flag: 'wx' });
chmodSync(adminPasswordFile, 0o600);
const adminPassword = readFileSync(adminPasswordFile, 'utf8').trim();
if (!existsSync(resolve(cluster, 'PG_VERSION'))) {
  call('initdb', ['-D', cluster, '-U', 'restaurant_admin', `--pwfile=${adminPasswordFile}`, '--auth-local=scram-sha-256', '--auth-host=scram-sha-256', '--encoding=UTF8', '--locale=C']);
}
if (readFileSync(resolve(cluster, 'PG_VERSION'), 'utf8').trim() !== '16') throw new Error('Dedicated local cluster must be PostgreSQL 16');
const status = spawnSync(resolve(pgBin, 'pg_ctl'), ['-D', cluster, 'status'], { stdio: 'ignore' });
if (status.status !== 0) call('pg_ctl', ['-D', cluster, '-l', resolve(runtime, 'postgres.log'), '-o', `-p ${port} -h 127.0.0.1 -k /tmp`, '-w', 'start']);
const envFile = resolve(root, 'backend/.env.local');
if (existsSync(envFile)) {
  console.log('Local cluster ready; existing private configuration preserved.');
  process.exit(0);
}
const app = secret(), owner = secret(), testApp = secret(), testOwner = secret();
const adminEnv = { ...process.env, PGPASSWORD: adminPassword };
const sql = (value) => call('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', port, '-U', 'restaurant_admin', '-d', 'postgres'], { env: adminEnv, input: value });
for (const [name, pass] of [['restaurant_app', app], ['restaurant_owner', owner], ['restaurant_test_app', testApp], ['restaurant_test_owner', testOwner]]) {
  sql(`CREATE ROLE ${name} LOGIN PASSWORD '${pass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;`);
}
for (const [database, role, appRole] of [['restaurant_dev', 'restaurant_owner', 'restaurant_app'], ['restaurant_test', 'restaurant_test_owner', 'restaurant_test_app']]) {
  sql(`CREATE DATABASE ${database} OWNER ${role}; REVOKE ALL ON DATABASE ${database} FROM PUBLIC; GRANT CONNECT ON DATABASE ${database} TO ${role}, ${appRole};`);
}
const url = (role, pass, db) => `postgresql://${role}:${pass}@127.0.0.1:${port}/${db}`;
const backendEnv = [
  'NODE_ENV=development', `DATABASE_URL=${url('restaurant_app', app, 'restaurant_dev')}`, `MIGRATION_DATABASE_URL=${url('restaurant_owner', owner, 'restaurant_dev')}`,
  `TEST_DATABASE_URL=${url('restaurant_test_app', testApp, 'restaurant_test')}`, `TEST_MIGRATION_DATABASE_URL=${url('restaurant_test_owner', testOwner, 'restaurant_test')}`,
  'APP_DB_ROLE=restaurant_app', 'APP_ORIGIN=https://localhost:5173', 'HOST=127.0.0.1', 'PORT=4000', 'EMAIL_MODE=disabled',
  `TOKEN_PEPPER=${secret()}`, `CURSOR_SECRET=${secret()}`, `OUTBOX_ENCRYPTION_KEY=${secret()}`, ''
].join('\n');
writeFileSync(envFile, backendEnv, { mode: 0o600, flag: 'wx' });
const tls = resolve(runtime, 'tls');
mkdirSync(tls, { recursive: true });
const cert = resolve(tls, 'localhost.crt'), key = resolve(tls, 'localhost.key');
if (!existsSync(cert) || !existsSync(key)) {
  const openssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '30', '-keyout', key, '-out', cert, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  if (openssl.status !== 0) throw new Error('Could not generate development TLS certificate');
}
chmodSync(key, 0o600);
const frontEnv = resolve(root, 'frontend/.env.local');
if (!existsSync(frontEnv)) writeFileSync(frontEnv, 'DEV_TLS_CERT=../.workbuddy/runtime/tls/localhost.crt\nDEV_TLS_KEY=../.workbuddy/runtime/tls/localhost.key\n', { mode: 0o600, flag: 'wx' });
console.log('Dedicated PostgreSQL 16 dev/test databases and private environment created. No real mail provider configured.');
