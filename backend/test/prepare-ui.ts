import { createDecipheriv, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { createApp } from '../src/app.js';

// Dedicated local UI test fixture. No HTTP endpoint exposes action tokens.
// Uses the same registration and token consumption code; SMTP delivery is NOT tested.
const config = loadConfig();
const url = new URL(config.databaseUrl);
if (config.nodeEnv !== 'development' || config.emailMode !== 'disabled' || url.hostname !== '127.0.0.1' || url.port !== '55439' || url.pathname !== '/restaurant_dev' || config.appOrigin !== 'https://localhost:5173') throw new Error('Local fixture refuses non-dedicated development configuration');
if (!config.migrationDatabaseUrl) throw new Error('Dedicated owner needed for test-only encrypted token retrieval');
const pool = createPool(config.databaseUrl), owner = createPool(config.migrationDatabaseUrl);
const app = createApp({ pool, config });
const email = `ui-${randomUUID()}@restaurant.example`, password = `Test-only-${randomUUID()}!`;
try {
  const csrf = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf', headers: { origin: config.appOrigin } });
  const raw = csrf.headers['set-cookie'];
  const row = (Array.isArray(raw) ? raw : [raw]).find(x => typeof x === 'string' && x.startsWith('__Host-restaurant_authflow='));
  if (!row) throw new Error('Missing test authflow');
  const register = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: { origin: config.appOrigin, cookie: row.split(';')[0], 'x-csrf-token': csrf.json().csrf_token }, payload: { email, password, locale: 'zh-CN', display_name: '自动化测试商家', terms_version: 'terms-v1', accepted_terms: true } });
  if (register.statusCode !== 202) throw new Error('Fixture registration failed');
  const outbox = await owner.query("SELECT * FROM email_outbox WHERE recipient_email_normalized=$1 AND template_key='verify_email' ORDER BY created_at DESC LIMIT 1", [email]);
  const item = outbox.rows[0];
  if (!item?.sensitive_payload_ciphertext || item.status !== 'queued') throw new Error('No actual verification outbox');
  const [, iv, tag, data] = item.sensitive_payload_ciphertext.split('.');
  const decode = createDecipheriv('aes-256-gcm', Buffer.from(config.outboxEncryptionKey, 'hex'), Buffer.from(iv, 'base64url'));
  decode.setAAD(Buffer.from(item.id)); decode.setAuthTag(Buffer.from(tag, 'base64url'));
  const token = JSON.parse(Buffer.concat([decode.update(Buffer.from(data, 'base64url')), decode.final()]).toString()).token;
  const verify = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', payload: { token } });
  if (verify.statusCode !== 204) throw new Error('Fixture verification failed');
  const fixtureFile = new URL('../../.workbuddy/runtime/e2e.env', import.meta.url);
  writeFileSync(fixtureFile, `E2E_EMAIL=${email}\nE2E_PASSWORD=${password}\nE2E_REGISTER_EMAIL=ui-register-${randomUUID()}@restaurant.example\n`, { mode: 0o600 });
  console.log('Local UI fixture registered and verified through real PostgreSQL and normal API; real SMTP not tested. Credentials kept private.');
} finally { await app.close(); await pool.end(); await owner.end(); }
