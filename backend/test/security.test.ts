import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDecipheriv } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { checkPassword, csrf, encryptAction, hashPassword, normalizeEmail, validCsrf, verifyPassword } from '../src/security.js';
import { input, validateIntervals, type Interval } from '../src/validation.js';

const env = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://restaurant_test_app:synthetic@127.0.0.1:55439/restaurant_test', APP_ORIGIN: 'https://localhost:5173', TOKEN_PEPPER: '测试专用-pepper-'.repeat(4), CURSOR_SECRET: '测试专用-cursor-'.repeat(4), OUTBOX_ENCRYPTION_KEY: '01'.repeat(32), EMAIL_MODE: 'disabled' };
test('配置必须显式且生产要求HTTPS和SMTP', () => {
  assert.equal(loadConfig(env).port, 4000);
  for (const key of ['DATABASE_URL', 'APP_ORIGIN', 'TOKEN_PEPPER', 'CURSOR_SECRET', 'OUTBOX_ENCRYPTION_KEY']) assert.throws(() => loadConfig({ ...env, [key]: '' }));
  assert.throws(() => loadConfig({ ...env, PORT: '1.5' }));
  assert.throws(() => loadConfig({ ...env, TOKEN_PEPPER: 'short' }));
  assert.throws(() => loadConfig({ ...env, OUTBOX_ENCRYPTION_KEY: 'z'.repeat(64) }));
  assert.throws(() => loadConfig({ ...env, NODE_ENV: 'production' }));
  assert.throws(() => loadConfig({ ...env, NODE_ENV: 'production', EMAIL_MODE: 'smtp', APP_ORIGIN: 'http://localhost:5173' }));
  assert.throws(() => loadConfig({ ...env, EMAIL_MODE: 'smtp' }));
});
test('CSRF绑定上下文与有效期，不接受篡改或过期', () => {
  const config = loadConfig(env), expires = new Date(Date.now() + 60000);
  const token = csrf(config, 'context-one', expires);
  assert.ok(validCsrf(config, 'context-one', token));
  assert.ok(!validCsrf(config, 'context-two', token));
  assert.ok(!validCsrf(config, 'context-one', `${token}x`));
  assert.ok(!validCsrf(config, 'context-one', csrf(config, 'context-one', new Date(Date.now() - 1000))));
});
test('成熟argon2id与dummy验证，保留密码及邮箱加号句点', async () => {
  const password = '带空格密码-Valid-2026   ';
  const hash = await hashPassword(password);
  assert.ok(await verifyPassword(hash, password));
  assert.ok(!await verifyPassword(hash, password.trim()));
  assert.ok(!await verifyPassword(null, password));
  assert.equal(normalizeEmail(' A.B+Tag@Restaurant.example '), 'a.b+tag@restaurant.example');
  assert.throws(() => checkPassword('a'.repeat(15)));
  assert.throws(() => checkPassword('x'.repeat(129)));
  assert.throws(() => input('RestaurantPatchInput', { owner_id: 'anything', name: '名称' }));
  assert.deepEqual(input('RestaurantPatchInput', { description: '  测试  ' }), { description: '测试' });
});
test('短期AES256GCM密文认证outbox ID且不含明文', () => {
  const config = loadConfig(env), token = '测试专用-action-token-1234567890';
  const ciphertext = encryptAction(config, 'outbox-test-id', token);
  assert.ok(!ciphertext.includes(token));
  const [, iv, tag, data] = ciphertext.split('.') as [string, string, string, string];
  const decrypt = (aad: string) => {
    const decoder = createDecipheriv('aes-256-gcm', Buffer.from(config.outboxEncryptionKey, 'hex'), Buffer.from(iv, 'base64url'));
    decoder.setAAD(Buffer.from(aad)); decoder.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decoder.update(Buffer.from(data, 'base64url')), decoder.final()]).toString('utf8');
  };
  assert.equal(JSON.parse(decrypt('outbox-test-id')).token, token);
  assert.throws(() => decrypt('another-outbox'));
});
test('营业相邻合法，周界和次日重叠不合法', () => {
  const interval: Interval = { weekday: 7, opens_at_local: '22:00', closes_at_local: '02:00', closes_day_offset: 1, accepts_requests: false, sort_order: 0 };
  validateIntervals([interval, { ...interval, weekday: 1, opens_at_local: '02:00', closes_at_local: '03:00', closes_day_offset: 0 }]);
  assert.throws(() => validateIntervals([interval, { ...interval, weekday: 1, opens_at_local: '01:00', closes_at_local: '03:00', closes_day_offset: 0 }]));
  assert.throws(() => validateIntervals([{ ...interval, opens_at_local: '00:00', closes_at_local: '01:00' }]));
});
