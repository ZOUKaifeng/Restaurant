import pg from 'pg';

// Disposable CI PostgreSQL service only. Refuses other databases or roles.
if (process.env.CI !== 'true') throw new Error('CI fixture is only for an isolated CI service');
const url = new URL(process.env.CI_DATABASE_ADMIN_URL ?? '');
if (url.hostname !== '127.0.0.1' || url.port !== '55439' || url.username !== 'postgres' || url.pathname !== '/postgres') throw new Error('Invalid dedicated CI database');
const owner = process.env.CI_TEST_OWNER_PASSWORD, app = process.env.CI_TEST_APP_PASSWORD;
if (!owner || !app || !/^[A-Za-z0-9_-]{20,}$/.test(owner) || !/^[A-Za-z0-9_-]{20,}$/.test(app)) throw new Error('Invalid CI-only role secrets');
const pool = new pg.Pool({ connectionString: url.href });
try {
  await pool.query(`CREATE ROLE restaurant_test_owner LOGIN PASSWORD '${owner}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  await pool.query(`CREATE ROLE restaurant_test_app LOGIN PASSWORD '${app}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  await pool.query('CREATE DATABASE restaurant_test OWNER restaurant_test_owner');
  await pool.query('REVOKE ALL ON DATABASE restaurant_test FROM PUBLIC');
  await pool.query('GRANT CONNECT ON DATABASE restaurant_test TO restaurant_test_owner,restaurant_test_app');
  console.log('Isolated CI database prepared with separate owner/application roles.');
} finally { await pool.end(); }
