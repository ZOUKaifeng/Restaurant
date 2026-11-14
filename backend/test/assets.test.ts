import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import type { Pool } from 'pg';
import sharp from 'sharp';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { assertAppDatabase, createPool, id } from '../src/db.js';
import { migrate } from '../scripts/migrate.js';
import { digest, FLOW_COOKIE, SESSION_COOKIE } from '../src/security.js';
import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { cleanupAssetUploadIntents, cleanupDeletedAssets } from '../src/assets.js';
import { createAssetStore } from '../src/asset-storage.js';
import { checksum, MAX_IMAGE_BYTES, MAX_UPLOAD_BYTES, validateUpload } from '../src/asset-validation.js';

let app: FastifyInstance, pool: Pool, owner: Pool, config: Config, root: string;
let sequence = 0;
const password = '素材测试-Valid-Password-2026!';
const tables = 'website_model_calls,menu_jobs,menu_drafts,website_publish_actions,website_publications,website_jobs,website_versions,website_agents,asset_upload_intents,asset_references,assets,reservations,reservation_events,reservation_access_tokens,audit_logs,email_outbox,opening_hours,restaurant_members,auth_tokens,auth_sessions,auth_identities,restaurants,users';
interface Actor { cookie: string; csrf: string; email: string }
function testUrl(key: string, role: string): string {
  const value = process.env[key];
  assert.ok(value, `必须提供真实 ${key}，不可跳过或连接开发数据库`);
  const url = new URL(value);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55439');
  assert.equal(url.pathname, '/restaurant_test');
  assert.equal(decodeURIComponent(url.username), role);
  return value;
}
before(async () => {
  const appUrl = testUrl('TEST_DATABASE_URL', 'restaurant_test_app');
  const ownerUrl = testUrl('TEST_MIGRATION_DATABASE_URL', 'restaurant_test_owner');
  root = await mkdtemp('/tmp/restaurant-assets-test-');
  config = loadConfig({ ...process.env, NODE_ENV: 'test', DATABASE_URL: appUrl, MIGRATION_DATABASE_URL: ownerUrl,
    APP_ORIGIN: 'https://localhost:5173', EMAIL_MODE: 'disabled', STORAGE_MODE: 'local', STORAGE_LOCAL_ROOT: root });
  assert.equal(config.storageMode, 'local');
  assert.equal(config.storageLocalRoot, root);
  owner = createPool(ownerUrl); pool = createPool(appUrl);
  await migrate(owner, 'restaurant_test_app');
  await assertAppDatabase(pool);
  await owner.query(`TRUNCATE ${tables}`);
  app = createApp({ pool, config });
  await app.ready();
});
after(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
  if (owner) { try { await owner.query(`TRUNCATE ${tables}`); } finally { await owner.end(); } }
  if (root) {
    // 只删除本测试创建的固定深度目录及精确文件，不递归跟随符号链接。
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        assert.match(entry.name, /^rst_[A-Za-z0-9_-]{24}$/);
        for (const file of await readdir(path)) { assert.match(file, /^ast_[A-Za-z0-9_-]{24}\.(pdf|jpg|png)$/); await unlink(join(path, file)); }
        await rmdir(path);
      } else await unlink(path);
    }
    await rmdir(root);
  }
});
function cookie(response: { headers: Record<string, unknown> }, name: string): string {
  const values = response.headers['set-cookie'];
  const found = (Array.isArray(values) ? values : [values]).find(value => typeof value === 'string' && value.startsWith(`${name}=`));
  assert.equal(typeof found, 'string');
  assert.match(found as string, /HttpOnly/i); assert.match(found as string, /Secure/i);
  return (found as string).split(';')[0]!;
}
async function request(method: HTTPMethods, path: string, actor?: Actor, payload?: Buffer | Record<string, unknown>, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (actor) { headers.cookie = actor.cookie; headers['x-csrf-token'] = actor.csrf; }
  if (method !== 'GET') headers.origin ??= config.appOrigin;
  if (payload !== undefined) headers['content-type'] ??= 'application/json';
  const response = await app.inject({ method, url: `/api/v1${path}`, headers, ...(payload === undefined ? {} : { payload }),
    remoteAddress: `127.2.${Math.floor(++sequence / 250)}.${sequence % 250 + 1}` });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.ok(response.headers['x-request-id']);
  if (response.statusCode >= 400) {
    const error = response.json();
    assert.equal(error.request_id, response.headers['x-request-id']);
    assert.equal(typeof error.code, 'string'); assert.equal(typeof error.message, 'string'); assert.ok(Array.isArray(error.details));
    assert.ok(!response.body.includes('storage_key') && !response.body.includes('SELECT '));
    if (response.statusCode === 401) assert.equal(response.headers['www-authenticate'], 'Session realm="restaurant-platform"');
  }
  return response;
}
async function actor(email: string): Promise<Actor> {
  const flow = await request('GET', '/auth/csrf', undefined, undefined, { origin: config.appOrigin });
  assert.equal(flow.statusCode, 200, flow.body);
  const anonymous = { email, cookie: cookie(flow, FLOW_COOKIE), csrf: flow.json().csrf_token };
  const registration = await request('POST', '/auth/register', anonymous, { email, password, locale: 'en', terms_version: 'terms-v1', accepted_terms: true });
  assert.equal(registration.statusCode, 202, registration.body);
  // token 只来自当前独立测试库中该账户的短期密文，没有 HTTP 测试令牌入口。
  const result = await owner.query(`SELECT id,auth_token_id,sensitive_payload_ciphertext FROM email_outbox
    WHERE recipient_email_normalized=$1 AND template_key='verify_email' AND sensitive_payload_ciphertext IS NOT NULL`, [email]);
  assert.equal(result.rowCount, 1);
  const row = result.rows[0], [version, iv, tag, ciphertext] = row.sensitive_payload_ciphertext.split('.');
  assert.equal(version, 'v1');
  const decoder = createDecipheriv('aes-256-gcm', Buffer.from(config.outboxEncryptionKey, 'hex'), Buffer.from(iv, 'base64url'));
  decoder.setAAD(Buffer.from(row.id)); decoder.setAuthTag(Buffer.from(tag, 'base64url'));
  const token = JSON.parse(Buffer.concat([decoder.update(Buffer.from(ciphertext, 'base64url')), decoder.final()]).toString('utf8')).token;
  assert.equal((await owner.query('SELECT token_hash FROM auth_tokens WHERE id=$1', [row.auth_token_id])).rows[0].token_hash, digest(config, token, 'verify_email'));
  assert.equal((await request('POST', '/auth/verify-email', undefined, { token })).statusCode, 204);
  const login = await request('POST', '/auth/login', anonymous, { email, password });
  assert.equal(login.statusCode, 200, login.body);
  return { email, cookie: cookie(login, SESSION_COOKIE), csrf: login.json().csrf_token };
}
async function restaurant(actor: Actor, name: string): Promise<string> {
  const result = await request('POST', '/restaurants', actor, { name, primary_locale: 'en' }, { 'idempotency-key': id('create') });
  assert.equal(result.statusCode, 201, result.body);
  return result.json().id;
}
async function pdf(pages = 1, unsafeName?: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  if (unsafeName) doc.catalog.set(PDFName.of(unsafeName), doc.context.obj({ S: 'JavaScript', JS: PDFString.of('void 0') }));
  return Buffer.from(await doc.save());
}
function upload(rid: string, actor: Actor | undefined, bytes: Buffer, mime = 'image/png', filename = '菜单.png', key = id('upload'), kind = 'menu_source', extraQuery = '') {
  return request('POST', `/restaurants/${rid}/assets?kind=${kind}&original_filename=${encodeURIComponent(filename)}&rights_confirmed=true${extraQuery}`,
    actor, bytes, { 'content-type': mime, 'idempotency-key': key });
}
function publicAsset(value: any): void {
  assert.deepEqual(Object.keys(value).sort(), ['id', 'restaurant_id', 'kind', 'origin', 'original_filename', 'mime_type', 'size_bytes', 'checksum', 'width_px',
    'height_px', 'alt_text', 'rights_confirmed_at', 'safety_status', 'status', 'revision', 'created_at', 'updated_at', 'can_delete', 'content_url'].sort());
  assert.match(value.id, /^ast_[A-Za-z0-9_-]{24}$/);
  assert.equal(value.origin, 'upload'); assert.equal(value.safety_status, 'approved');
  assert.ok(['ready', 'deleted'].includes(value.status));
  assert.ok(Number.isInteger(value.size_bytes) && value.size_bytes > 0);
  assert.match(value.checksum, /^[a-f0-9]{64}$/);
  assert.ok(Number.isInteger(value.revision) && value.revision > 0);
  assert.equal(typeof value.can_delete, 'boolean'); assert.equal(value.alt_text, null);
  for (const field of ['rights_confirmed_at', 'created_at', 'updated_at']) assert.ok(Number.isFinite(Date.parse(value[field])));
  assert.equal(value.content_url, `/api/v1/restaurants/${value.restaurant_id}/assets/${value.id}/content`);
}
async function files(rid: string): Promise<string[]> {
  try { return (await readdir(join(root, rid))).sort(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function row(aid: string) { return (await owner.query('SELECT * FROM assets WHERE id=$1', [aid])).rows[0]; }
async function waitForLock(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  do {
    const result = await owner.query(`SELECT pid FROM pg_stat_activity WHERE usename='restaurant_test_app' AND $1::int=ANY(pg_blocking_pids(pid))`, [pid]);
    if (result.rowCount) return;
  } while (Date.now() < deadline);
  assert.fail('请求必须实际等待指定 PostgreSQL 锁');
}

test('真实 PG 与真实私有文件素材闭环', async t => {
  const alice = await actor('assets.alice@restaurant.example'), bob = await actor('assets.bob@restaurant.example');
  const rid = await restaurant(alice, '素材餐厅'), otherRid = await restaurant(bob, '其它商家餐厅'), secondRid = await restaurant(alice, '同商家第二店');
  const png = await sharp({ create: { width: 20, height: 12, channels: 4, background: '#aabbcc' } }).withMetadata().png().toBuffer();
  const jpeg = await sharp({ create: { width: 20, height: 12, channels: 3, background: '#ccbb99' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const menuPdf = await pdf();
  let image: any, imageTag: string, menu: any;
  await t.test('原始二进制上传、固定公开结构、审计、真实重编码持久化', async () => {
    const response = await upload(rid, alice, png, 'image/png', '../隐私\\菜单\u0000.png', 'assets-initial-key-0001');
    assert.equal(response.statusCode, 201, response.body);
    image = response.json(); imageTag = response.headers.etag as string; publicAsset(image);
    assert.equal(image.original_filename, '..隐私菜单.png'); assert.equal(image.kind, 'menu_source'); assert.equal(image.can_delete, true);
    assert.equal(image.revision, 1); assert.equal(imageTag, `"asset-${image.id}-v1"`);
    const stored = await row(image.id), bytes = await readFile(join(root, stored.storage_key));
    assert.equal(stored.storage_backend, 'local'); assert.equal(stored.source_checksum, checksum(png));
    const intent = (await owner.query('SELECT * FROM asset_upload_intents WHERE id=$1', [image.id])).rows[0];
    assert.equal(intent.state, 'committed'); assert.equal(intent.storage_key, stored.storage_key);
    assert.equal(intent.expected_checksum, stored.checksum); assert.equal(intent.expected_size_bytes, stored.size_bytes);
    assert.match(intent.attempt_marker, /^[a-f0-9]{48}$/); assert.ok(intent.expires_at - intent.created_at >= 15 * 60 * 1000);
    assert.equal(bytes.length, image.size_bytes); assert.equal(checksum(bytes), image.checksum);
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.width, 20); assert.equal(metadata.height, 12); assert.equal(metadata.exif, undefined); assert.equal(metadata.icc, undefined);
    assert.equal((await owner.query("SELECT count(*)::int AS n FROM audit_logs WHERE entity_id=$1 AND entity_type='asset' AND action='upload_asset'", [image.id])).rows[0].n, 1);
  });
  await t.test('PNG/JPG 所有图片类型与 PDF 菜单，旋转并清除 EXIF', async () => {
    for (const kind of ['logo', 'restaurant_photo', 'dish_photo']) {
      const result = await upload(rid, alice, jpeg, 'image/jpeg', `${kind}.jpg`, id('upload'), kind);
      assert.equal(result.statusCode, 201, result.body); publicAsset(result.json());
      assert.equal(result.json().width_px, 12); assert.equal(result.json().height_px, 20);
      const bytes = await request('GET', result.json().content_url.slice('/api/v1'.length), alice);
      assert.equal(bytes.statusCode, 200); assert.equal((await sharp(bytes.rawPayload).metadata()).exif, undefined);
    }
    const result = await upload(rid, alice, menuPdf, 'application/pdf', '菜单.pdf');
    assert.equal(result.statusCode, 201, result.body); menu = result.json(); publicAsset(menu);
    assert.equal(menu.width_px, null); assert.equal(menu.height_px, null); assert.equal(menu.checksum, checksum(menuPdf));
    assert.equal((await upload(rid, alice, menuPdf, 'application/pdf', 'logo.pdf', id('upload'), 'logo')).statusCode, 422);
  });
  await t.test('格式签名/扩展名一致，拒绝伪装、截断、HTML/SVG/GIF、主动 PDF', async () => {
    assert.equal((await upload(rid, alice, png, 'image/jpeg', '假.jpg')).statusCode, 422);
    assert.equal((await upload(rid, alice, png, 'image/png', '假.jpg')).statusCode, 422);
    assert.equal((await upload(rid, alice, Buffer.from('<html>not an image</html>'))).statusCode, 422);
    assert.equal((await upload(rid, alice, png.subarray(0, 25))).statusCode, 422);
    assert.equal((await upload(rid, alice, jpeg.subarray(0, jpeg.length - 8), 'image/jpeg', '截断.jpg')).statusCode, 422);
    assert.equal((await upload(rid, alice, menuPdf.subarray(0, menuPdf.length - 12), 'application/pdf', '截断.pdf')).statusCode, 422);
    for (const mime of ['text/html', 'image/svg+xml', 'image/gif', 'application/json']) assert.equal((await upload(rid, alice, png, mime)).statusCode, 415);
    for (const name of ['OpenAction', 'AA', 'AcroForm', 'EmbeddedFiles', 'Launch', 'RichMedia']) {
      const result = await upload(rid, alice, await pdf(1, name), 'application/pdf', '拒绝.pdf');
      assert.equal(result.statusCode, 422, result.body); assert.equal(result.json().details[0].code, 'UNSAFE_PDF');
    }
    assert.equal((await upload(rid, alice, await pdf(101), 'application/pdf', '超页数.pdf')).statusCode, 422);
    const encrypted = await PDFDocument.create(); encrypted.addPage();
    encrypted.context.trailerInfo.Encrypt = encrypted.context.register(encrypted.context.obj({ Filter: 'Standard', V: 1, R: 2 }));
    assert.equal((await upload(rid, alice, Buffer.from(await encrypted.save()), 'application/pdf', '加密.pdf')).statusCode, 422);
    const oversizedPixels = await sharp({ create: { width: 21000, height: 1000, channels: 3, background: '#ffffff' } }).png().toBuffer();
    assert.equal((await upload(rid, alice, oversizedPixels)).statusCode, 422);
    const animated = Buffer.concat([png.subarray(0, 33), Buffer.from([0, 0, 0, 8]), Buffer.from('acTL'), Buffer.alloc(12), png.subarray(33)]);
    assert.equal((await upload(rid, alice, animated)).statusCode, 422);
  });
  await t.test('20MiB/10MiB 真实字节上限，严格 query、确认与幂等键', async () => {
    assert.equal((await upload(rid, alice, Buffer.alloc(MAX_UPLOAD_BYTES + 1), 'application/pdf', '大.pdf')).statusCode, 413);
    assert.equal((await upload(rid, alice, Buffer.alloc(MAX_IMAGE_BYTES + 1))).statusCode, 413);
    for (const extra of ['&unknown=true', '&kind=logo', '&original_filename=other.png', '&rights_confirmed=false']) assert.equal((await upload(rid, alice, png, 'image/png', '菜单.png', id('upload'), 'menu_source', extra)).statusCode, extra === '&unknown=true' ? 400 : 422);
    assert.equal((await upload(rid, alice, png, 'image/png', 'a'.repeat(201) + '.png')).statusCode, 422);
    assert.equal((await upload(rid, alice, png, 'image/png', '菜单.png', 'short')).statusCode, 400);
    assert.equal((await request('POST', `/restaurants/${rid}/assets?kind=logo&original_filename=a.png`, alice, png, { 'content-type': 'image/png', 'idempotency-key': id('upload') })).statusCode, 422);
    assert.equal((await request('POST', `/restaurants/${rid}/assets?kind=logo&original_filename=a.png&rights_confirmed=true`, alice, png, { 'content-type': 'image/png' })).statusCode, 400);
  });
  await t.test('body 解析前拒绝未登录/CSRF/Origin/餐厅伪造，跨店不存在语义', async () => {
    assert.equal((await upload(rid, undefined, Buffer.alloc(MAX_UPLOAD_BYTES + 1))).statusCode, 401);
    assert.equal((await upload(rid, { ...alice, csrf: 'forged' }, png)).statusCode, 403);
    assert.equal((await request('POST', `/restaurants/${rid}/assets`, alice, png, { 'content-type': 'image/png', origin: 'https://evil.example' })).statusCode, 403);
    assert.equal((await upload(rid, bob, Buffer.alloc(MAX_UPLOAD_BYTES + 1))).statusCode, 404);
    for (const path of [`/restaurants/${rid}/assets`, `/restaurants/${rid}/assets/${image.id}`, `/restaurants/${rid}/assets/${image.id}/content`]) assert.equal((await request('GET', path, bob)).statusCode, 404);
    assert.equal((await request('GET', `/restaurants/${otherRid}/assets/${image.id}`, bob)).statusCode, 404);
    assert.equal((await request('GET', `/restaurants/${rid}/assets/${id('ast')}`, alice)).statusCode, 404);
    assert.equal((await request('DELETE', `/restaurants/${rid}/assets/${image.id}`, bob)).statusCode, 404);
    assert.equal((await request('DELETE', `/restaurants/${rid}/assets/${image.id}`, { ...alice, csrf: 'invalid' }, undefined, { 'if-match': imageTag })).statusCode, 403);
    assert.equal((await request('GET', `/restaurants/${rid}/assets/${image.id}/content`)).statusCode, 401);
  });
  await t.test('并发幂等只留一个对象；不同 checksum/kind/filename 冲突且不误删', async () => {
    const key = 'assets-concurrent-key-0001', beforeFiles = await files(rid);
    const results = await Promise.all([upload(rid, alice, png, 'image/png', '并发.png', key), upload(rid, alice, png, 'image/png', '并发.png', key)]);
    for (const result of results) assert.equal(result.statusCode, 201, result.body);
    assert.equal(results[0]!.json().id, results[1]!.json().id);
    assert.deepEqual(results.map(result => result.headers['idempotency-replayed']).sort(), ['false', 'true']);
    assert.equal((await files(rid)).length, beforeFiles.length + 1);
    const retained = await files(rid);
    for (const args of [[png, '改名.png', 'menu_source'], [png, '并发.png', 'logo'], [await sharp({ create: { width: 3, height: 3, channels: 3, background: '#ffffff' } }).png().toBuffer(), '并发.png', 'menu_source']] as [Buffer, string, string][]) {
      assert.equal((await upload(rid, alice, args[0], 'image/png', args[1], key, args[2])).statusCode, 409);
      assert.deepEqual(await files(rid), retained);
    }
    const replay = await upload(rid, alice, png, 'image/png', '../隐私\\菜单\u0000.png', 'assets-initial-key-0001');
    assert.equal(replay.statusCode, 201); assert.equal(replay.json().id, image.id);
    assert.equal((await request('GET', image.content_url.slice('/api/v1'.length), alice)).statusCode, 200);
  });
  await t.test('列表游标绑定店/用户/limit，详情与列表同形，私有 bytes 与 PDF 响应头', async () => {
    const first = await request('GET', `/restaurants/${rid}/assets?limit=2`, alice);
    assert.equal(first.statusCode, 200); assert.equal(first.json().storage_mode, 'local'); assert.equal(first.json().has_more, true);
    assert.equal(first.json().items.length, 2); first.json().items.forEach(publicAsset);
    const cursor = encodeURIComponent(first.json().next_cursor);
    const second = await request('GET', `/restaurants/${rid}/assets?limit=2&cursor=${cursor}`, alice);
    assert.equal(second.statusCode, 200); assert.ok(!second.json().items.some((item: any) => first.json().items.some((previous: any) => previous.id === item.id)));
    assert.equal((await request('GET', `/restaurants/${rid}/assets?limit=1&cursor=${cursor}`, alice)).statusCode, 400);
    assert.equal((await request('GET', `/restaurants/${secondRid}/assets?limit=2&cursor=${cursor}`, alice)).statusCode, 400);
    for (const query of ['cursor=forged', 'unknown=true']) assert.equal((await request('GET', `/restaurants/${rid}/assets?${query}`, alice)).statusCode, 400);
    for (const limit of ['0', '101', '1.5']) assert.equal((await request('GET', `/restaurants/${rid}/assets?limit=${limit}`, alice)).statusCode, 422);
    const detail = await request('GET', `/restaurants/${rid}/assets/${image.id}`, alice);
    assert.equal(detail.statusCode, 200); publicAsset(detail.json()); assert.deepEqual(detail.json(), image); assert.equal(detail.headers.etag, imageTag);
    const content = await request('GET', image.content_url.slice('/api/v1'.length), alice);
    assert.equal(content.statusCode, 200); assert.equal(content.headers['content-type'], 'image/png');
    assert.match(content.headers['content-disposition'] as string, /^inline;/); assert.equal(checksum(content.rawPayload), image.checksum);
    assert.equal(content.headers['referrer-policy'], 'no-referrer'); assert.equal(content.headers['x-content-type-options'], 'nosniff');
    const document = await request('GET', menu.content_url.slice('/api/v1'.length), alice);
    assert.equal(document.statusCode, 200); assert.match(document.headers['content-disposition'] as string, /^attachment;/);
    assert.equal(document.headers['content-type'], 'application/pdf'); assert.match(document.headers['content-security-policy'] as string, /sandbox/);
    assert.deepEqual(document.rawPayload, menuPdf);
  });
  await t.test('存储服务故障不影响廉价已完成重放，且不创建多余 intent', async t => {
    await app.close();
    const s3Config: Config = { ...config, storageMode: 's3', s3: { region: 'us-east-1', bucket: 'synthetic-test-bucket', endpoint: 'http://127.0.0.1:9', forcePathStyle: true } };
    const before = Number((await owner.query('SELECT count(*)::int AS n FROM asset_upload_intents')).rows[0].n);
    let puts = 0;
    t.mock.method(S3Client.prototype, 'send', (async (command: unknown) => {
      assert.ok(command instanceof PutObjectCommand); puts++;
      throw new Error('测试故障注入：存储不可用');
    }) as typeof S3Client.prototype.send);
    try {
      app = createApp({ pool, config: s3Config }); await app.ready();
      const replay = await upload(rid, alice, png, 'image/png', '../隐私\\菜单\u0000.png', 'assets-initial-key-0001');
      assert.equal(replay.statusCode, 201, replay.body); assert.equal(replay.json().id, image.id); assert.equal(puts, 0);
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM asset_upload_intents')).rows[0].n, before);
      const failed = await upload(rid, alice, png, 'image/png', '故障.png', 'assets-store-failure-0001');
      assert.equal(failed.statusCode, 503); assert.equal(puts, 1);
      const intents = await owner.query("SELECT * FROM asset_upload_intents WHERE restaurant_id=$1 AND state='abandoned'", [rid]);
      assert.equal(intents.rowCount, 1); assert.equal(intents.rows[0].last_error_code, 'UPLOAD_RESULT_UNKNOWN');
      assert.ok(intents.rows[0].expires_at > new Date());
    } finally { await app.close(); app = createApp({ pool, config }); await app.ready(); }
  });
  await t.test('存储PUT之前intent跨连接可见，未知结果保留到期，晚成功按marker及checksum精确补偿', async t => {
    const intentRid = await restaurant(alice, 'S3故障注入餐厅');
    const s3Config: Config = { ...config, storageMode: 's3', s3: { region: 'us-east-1', bucket: 'synthetic-test-bucket', endpoint: 'http://127.0.0.1:9', forcePathStyle: true } };
    const objects = new Map<string, { bytes: Buffer; metadata: Record<string, string>; version: string }>();
    const delayed: { key: string; bytes: Buffer; metadata: Record<string, string> }[] = [];
    const deletedKeys: string[] = [];
    let failPut = true, heads = 0;
    t.mock.method(S3Client.prototype, 'send', (async (command: any) => {
      const key = command.input.Key as string;
      if (command instanceof PutObjectCommand) {
        assert.equal(command.input.IfNoneMatch, '*');
        const intent = (await owner.query('SELECT * FROM asset_upload_intents WHERE storage_key=$1', [key])).rows[0];
        assert.ok(intent, '真实DB intent 必须在任何存储写入前已提交并可被独立连接看见');
        assert.equal(intent.state, 'pending'); assert.equal(intent.storage_backend, 's3');
        assert.equal(intent.attempt_marker, command.input.Metadata?.['upload-attempt']);
        assert.equal(intent.expected_checksum, command.input.Metadata?.['upload-checksum']);
        assert.equal(checksum(Buffer.from(command.input.Body as Buffer)), intent.expected_checksum);
        assert.ok(intent.expires_at - intent.created_at >= 15 * 60 * 1000);
        const object = { key, bytes: Buffer.from(command.input.Body as Buffer), metadata: command.input.Metadata as Record<string, string> };
        if (failPut) { delayed.push(object); throw new Error('测试故障注入：PUT回执超时，服务端之后完成'); }
        objects.set(key, { ...object, version: 'synthetic-version-1' });
        return {};
      }
      if (command instanceof HeadObjectCommand) {
        heads++;
        const object = objects.get(key);
        if (!object) throw Object.assign(new Error('测试对象尚不存在'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
        return { Metadata: object.metadata, ChecksumSHA256: Buffer.from(checksum(object.bytes), 'hex').toString('base64'),
          ChecksumType: 'FULL_OBJECT', ContentLength: object.bytes.length, VersionId: object.version, ETag: '"synthetic-etag"' };
      }
      assert.ok(command instanceof DeleteObjectCommand);
      assert.equal(command.input.VersionId, 'synthetic-version-1'); assert.equal(command.input.IfMatch, '"synthetic-etag"');
      deletedKeys.push(key); objects.delete(key); return {};
    }) as typeof S3Client.prototype.send);
    await app.close();
    const store = createAssetStore(s3Config);
    try {
      app = createApp({ pool, config: s3Config }); await app.ready();
      const failed = await upload(intentRid, alice, png, 'image/png', '晚完成.png', 'assets-late-put-0001');
      assert.equal(failed.statusCode, 503); assert.equal(heads, 0);
      const unknown = (await owner.query("SELECT * FROM asset_upload_intents WHERE restaurant_id=$1 AND state='abandoned'", [intentRid])).rows[0];
      assert.ok(unknown); assert.equal(unknown.last_error_code, 'UPLOAD_RESULT_UNKNOWN');
      await cleanupAssetUploadIntents(pool, store);
      assert.equal(heads, 0); assert.equal((await owner.query('SELECT state FROM asset_upload_intents WHERE id=$1', [unknown.id])).rows[0].state, 'abandoned');
      for (const late of delayed) objects.set(late.key, { ...late, version: 'synthetic-version-1' });
      await owner.query("UPDATE asset_upload_intents SET created_at=now()-interval '31 minutes',expires_at=now()-interval '16 minutes' WHERE id=$1", [unknown.id]);
      const cleanup = await cleanupAssetUploadIntents(pool, store);
      assert.equal(cleanup.cleaned, 1); assert.deepEqual(deletedKeys, [unknown.storage_key]);
      assert.equal((await owner.query('SELECT state FROM asset_upload_intents WHERE id=$1', [unknown.id])).rows[0].state, 'cleaned');
      failPut = false;
      const success = await upload(intentRid, alice, png, 'image/png', '已提交.png', 'assets-committed-s3-0001');
      assert.equal(success.statusCode, 201, success.body);
      const committed = (await owner.query('SELECT * FROM asset_upload_intents WHERE id=$1', [success.json().id])).rows[0];
      await owner.query("UPDATE asset_upload_intents SET created_at=now()-interval '31 minutes',expires_at=now()-interval '16 minutes' WHERE id=$1", [committed.id]);
      await cleanupAssetUploadIntents(pool, store);
      assert.ok(objects.has(committed.storage_key)); assert.deepEqual(deletedKeys, [unknown.storage_key]);
      assert.equal((await owner.query('SELECT state FROM asset_upload_intents WHERE id=$1', [committed.id])).rows[0].state, 'committed');
      const conditionalKey = `${intentRid}/${id('ast')}.png`, marker = randomBytes(24).toString('hex'), expected = checksum(png);
      objects.set(conditionalKey, { bytes: png, metadata: { 'upload-attempt': '0'.repeat(48), 'upload-checksum': expected }, version: 'synthetic-version-1' });
      assert.equal(await store.removeConditional('s3', conditionalKey, expected, marker), 'mismatch');
      objects.set(conditionalKey, { bytes: Buffer.alloc(png.length), metadata: { 'upload-attempt': marker, 'upload-checksum': expected }, version: 'synthetic-version-1' });
      assert.equal(await store.removeConditional('s3', conditionalKey, expected, marker), 'mismatch');
      assert.ok(objects.has(conditionalKey));
      assert.equal(await store.removeConditional('s3', `${intentRid}/${id('ast')}.png`, expected, marker), 'missing');
    } finally { store.close(); await app.close(); app = createApp({ pool, config }); await app.ready(); }
  });
  await t.test('新连接/新 app 持久化；存储后端按记录冻结，不随当前模式变化', async () => {
    await app.close(); await pool.end(); pool = createPool(config.databaseUrl);
    app = createApp({ pool, config: { ...config, storageMode: 's3', s3: { region: 'us-east-1', bucket: 'synthetic-test-bucket', endpoint: 'http://127.0.0.1:9', forcePathStyle: true } } });
    await app.ready();
    assert.equal((await request('GET', `/restaurants/${rid}/assets`, alice)).json().storage_mode, 's3');
    const content = await request('GET', image.content_url.slice('/api/v1'.length), alice);
    assert.equal(content.statusCode, 200, content.body); assert.equal(checksum(content.rawPayload), image.checksum);
    await app.close(); app = createApp({ pool, config }); await app.ready();
  });
  await t.test('缺文件/被篡改文件/符号链接均503，不返回假空或越界内容', async () => {
    const stored = await row(image.id), path = join(root, stored.storage_key), original = await readFile(path);
    await unlink(path);
    assert.equal((await request('GET', image.content_url.slice('/api/v1'.length), alice)).statusCode, 503);
    await writeFile(path, Buffer.alloc(original.length), { mode: 0o600 });
    assert.equal((await request('GET', image.content_url.slice('/api/v1'.length), alice)).statusCode, 503);
    await unlink(path);
    const target = join(root, 'synthetic-outside.png'); await writeFile(target, original, { mode: 0o600 }); await symlink(target, path);
    try { assert.equal((await request('GET', image.content_url.slice('/api/v1'.length), alice)).statusCode, 503); }
    finally { await unlink(path); await writeFile(path, original, { mode: 0o600 }); await unlink(target); }
    const store = createAssetStore(config);
    try {
      await assert.rejects(store.read('local', '../outside.png', 1, '0'.repeat(64)), { status: 503 });
      await assert.rejects(store.put(stored.storage_key, original, 'image/png'), { status: 503 });
      assert.deepEqual(await readFile(path), original);
      assert.throws(() => createAssetStore({ ...config, nodeEnv: 'production', storageMode: 'local' }));
      const parentLink = join(root, secondRid), rootLink = join(root, 'synthetic-root-link');
      await symlink(root, parentLink); await symlink(root, rootLink);
      const linkedStore = createAssetStore({ ...config, storageLocalRoot: rootLink });
      try {
        await assert.rejects(store.put(`${secondRid}/${id('ast')}.png`, original, 'image/png'), { status: 503 });
        await assert.rejects(linkedStore.put(`${rid}/${id('ast')}.png`, original, 'image/png'), { status: 503 });
      } finally { linkedStore.close(); await unlink(parentLink); await unlink(rootLink); }
    } finally { store.close(); }
  });
  await t.test('事务会话撤销与审计失败均回滚元数据并清理候选文件', async () => {
    const loginFlow = await request('GET', '/auth/csrf', undefined, undefined, { origin: config.appOrigin });
    const login = await request('POST', '/auth/login', { email: alice.email, cookie: cookie(loginFlow, FLOW_COOKIE), csrf: loginFlow.json().csrf_token }, { email: alice.email, password });
    const temporary = { email: alice.email, cookie: cookie(login, SESSION_COOKIE), csrf: login.json().csrf_token };
    const sessionHash = digest(config, temporary.cookie.split('=')[1]!, 'session');
    const user = (await owner.query('SELECT user_id FROM auth_sessions WHERE session_secret_hash=$1', [sessionHash])).rows[0];
    const blocker = await owner.connect(), key = 'assets-revoked-key-0001', before = await files(rid);
    try {
      await blocker.query('BEGIN');
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.user_id]);
      await blocker.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE session_secret_hash=$1', [sessionHash]);
      const pending = upload(rid, temporary, png, 'image/png', '撤销.png', key);
      await waitForLock(pid); await blocker.query('COMMIT');
      assert.equal((await pending).statusCode, 401);
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM assets WHERE restaurant_id=$1 AND upload_idempotency_key=$2', [rid, key])).rows[0].n, 0);
      assert.deepEqual(await files(rid), before);
    } finally { try { await blocker.query('ROLLBACK'); } finally { blocker.release(); } }
    const intentColumns = 'id,restaurant_id,user_id,storage_backend,storage_key,expected_checksum,expected_size_bytes,attempt_marker';
    await owner.query(`REVOKE INSERT(${intentColumns}) ON asset_upload_intents FROM restaurant_test_app`);
    try {
      assert.equal((await upload(rid, alice, png, 'image/png', '禁止写候选.png', 'assets-intent-failure-0001')).statusCode, 503);
      assert.deepEqual(await files(rid), before);
    } finally { await owner.query(`GRANT INSERT(${intentColumns}) ON asset_upload_intents TO restaurant_test_app`); }
    await owner.query('REVOKE INSERT ON audit_logs FROM restaurant_test_app');
    try {
      assert.equal((await upload(rid, alice, png, 'image/png', '回滚.png', 'assets-rollback-key-0001')).statusCode, 503);
      assert.deepEqual(await files(rid), before);
      assert.equal((await request('DELETE', `/restaurants/${rid}/assets/${image.id}`, alice, undefined, { 'if-match': imageTag })).statusCode, 503);
      assert.equal((await row(image.id)).status, 'ready'); assert.equal((await row(image.id)).revision, 1);
      assert.equal((await request('GET', image.content_url.slice('/api/v1'.length), alice)).statusCode, 200);
    } finally { await owner.query('GRANT INSERT ON audit_logs TO restaurant_test_app'); }
  });
  await t.test('引用保护和复合外键，列表/详情 can_delete 同步，删除版本严格', async () => {
    const referenceId = id('ref');
    await owner.query('INSERT INTO asset_references(id,restaurant_id,asset_id,purpose,resource_id) VALUES($1,$2,$3,$4,$5)', [referenceId, rid, image.id, 'future_menu', 'synthetic-resource']);
    await assert.rejects(owner.query('INSERT INTO asset_references(id,restaurant_id,asset_id,purpose,resource_id) VALUES($1,$2,$3,$4,$5)', [id('ref'), otherRid, image.id, 'future_site', 'synthetic-resource']));
    assert.equal((await request('GET', `/restaurants/${rid}/assets/${image.id}`, alice)).json().can_delete, false);
    const list = await request('GET', `/restaurants/${rid}/assets?limit=100`, alice);
    assert.equal(list.json().items.find((item: any) => item.id === image.id).can_delete, false);
    const used = await request('DELETE', `/restaurants/${rid}/assets/${image.id}`, alice, undefined, { 'if-match': imageTag });
    assert.equal(used.statusCode, 409); assert.equal(used.json().code, 'ASSET_IN_USE'); assert.equal((await row(image.id)).status, 'ready');
    assert.equal((await request('DELETE', `/restaurants/${rid}/assets/${image.id}`, alice)).statusCode, 428);
    for (const match of ['*', `W/${imageTag}`, `${imageTag},${imageTag}`]) assert.equal((await request('DELETE', `/restaurants/${rid}/assets/${image.id}`, alice, undefined, { 'if-match': match })).statusCode, 400);
    assert.equal((await request('DELETE', `/restaurants/${rid}/assets/${image.id}`, alice, undefined, { 'if-match': `"asset-${image.id}-v999"` })).statusCode, 412);
    await owner.query('DELETE FROM asset_references WHERE id=$1', [referenceId]);
    const stored = await row(image.id);
    assert.equal((await request('DELETE', `/restaurants/${rid}/assets/${image.id}`, alice, undefined, { 'if-match': imageTag })).statusCode, 204);
    const deleted = await request('GET', `/restaurants/${rid}/assets/${image.id}`, alice);
    assert.equal(deleted.statusCode, 200); publicAsset(deleted.json()); assert.equal(deleted.json().status, 'deleted'); assert.equal(deleted.json().revision, 2);
    assert.equal(deleted.json().can_delete, false); assert.equal(deleted.headers.etag, `"asset-${image.id}-v2"`);
    assert.ok((await row(image.id)).deleted_at); await assert.rejects(lstat(join(root, stored.storage_key)), { code: 'ENOENT' });
    assert.equal((await request('GET', image.content_url.slice('/api/v1'.length), alice)).statusCode, 404);
    assert.ok(!(await request('GET', `/restaurants/${rid}/assets?limit=100`, alice)).json().items.some((item: any) => item.id === image.id));
    assert.equal((await request('DELETE', `/restaurants/${rid}/assets/${image.id}`, alice, undefined, { 'if-match': imageTag })).statusCode, 204);
    const replay = await upload(rid, alice, png, 'image/png', '../隐私\\菜单\u0000.png', 'assets-initial-key-0001');
    assert.equal(replay.statusCode, 410); assert.equal(replay.json().code, 'ASSET_ALREADY_DELETED');
    assert.equal((await upload(rid, alice, png, 'image/png', '不同.png', 'assets-initial-key-0001')).statusCode, 409);
    await assert.rejects(owner.query('INSERT INTO asset_references(id,restaurant_id,asset_id,purpose,resource_id) VALUES($1,$2,$3,$4,$5)', [id('ref'), rid, image.id, 'future_menu', 'after-deletion']));
    assert.equal((await owner.query("SELECT count(*)::int AS n FROM audit_logs WHERE entity_id=$1 AND action='delete_asset'", [image.id])).rows[0].n, 1);
  });
  await t.test('物理删除故障保留墓碑与错误码；cleanup 精确补删不伤其它文件', async () => {
    const uploaded = await upload(rid, alice, png, 'image/png', '待清理.png'); assert.equal(uploaded.statusCode, 201);
    const stored = await row(uploaded.json().id), path = join(root, stored.storage_key), original = await readFile(path);
    const target = join(root, 'synthetic-preserved.png'); await writeFile(target, original, { mode: 0o600 });
    await unlink(path); await symlink(target, path);
    try {
      const result = await request('DELETE', `/restaurants/${rid}/assets/${stored.id}`, alice, undefined, { 'if-match': uploaded.headers.etag as string });
      assert.equal(result.statusCode, 204, result.body);
      assert.equal((await row(stored.id)).status, 'deleted'); assert.equal((await row(stored.id)).last_error_code, 'STORAGE_DELETE_FAILED');
      assert.deepEqual(await readFile(target), original);
      await unlink(path); await writeFile(path, original, { mode: 0o600 });
      const store = createAssetStore(config);
      try { assert.equal((await cleanupDeletedAssets(pool, store)).failed, 0); } finally { store.close(); }
      await assert.rejects(lstat(path), { code: 'ENOENT' }); assert.equal((await row(stored.id)).last_error_code, null);
      assert.deepEqual(await readFile(target), original);
    } finally { await unlink(target); }
  });
  await t.test('过期崩溃候选可追踪，清理仅删本intent完整checksum对象，部分写入与已有记录保护', async t => {
    const orphanRid = await restaurant(alice, '孤儿候选餐厅');
    const uid = (await owner.query('SELECT id FROM users WHERE email_normalized=$1', [alice.email])).rows[0].id;
    const store = createAssetStore(config), validated = await validateUpload(png, 'image/png', 'logo');
    async function seedIntent(bytes: Buffer | undefined, expired = true) {
      const aid = id('ast'), key = `${orphanRid}/${aid}.png`, marker = randomBytes(24).toString('hex');
      await owner.query(`INSERT INTO asset_upload_intents(id,restaurant_id,user_id,storage_backend,storage_key,expected_checksum,expected_size_bytes,attempt_marker,created_at,expires_at)
        VALUES($1,$2,$3,'local',$4,$5,$6,$7,now()-interval '31 minutes',${expired ? "now()-interval '16 minutes'" : "now()+interval '15 minutes'"})`,
      [aid, orphanRid, uid, key, validated.checksum, validated.sizeBytes, marker]);
      if (bytes) await store.put(key, bytes, 'image/png', marker);
      return { aid, key, marker };
    }
    const exact = await seedIntent(validated.bytes), missing = await seedIntent(undefined), partial = await seedIntent(validated.bytes.subarray(0, 20));
    const unrelated = `${orphanRid}/${id('ast')}.png`; await store.put(unrelated, validated.bytes, 'image/png');
    const ready = await seedIntent(validated.bytes);
    await owner.query(`INSERT INTO assets(id,restaurant_id,kind,original_filename,mime_type,size_bytes,checksum,source_checksum,width_px,height_px,
      rights_confirmed_at,storage_backend,storage_key,upload_idempotency_key,initial_request_fingerprint)
      VALUES($1,$2,'logo','有记录.png','image/png',$3,$4,$5,$6,$7,now(),'local',$8,$9,$10)`,
    [ready.aid, orphanRid, validated.sizeBytes, validated.checksum, validated.sourceChecksum, validated.width, validated.height, ready.key, id('fixture'), '1'.repeat(64)]);
    try {
      let cursor: string | undefined, cleaned = 0;
      do {
        const page = await cleanupAssetUploadIntents(pool, store, 1, cursor);
        cleaned += page.cleaned; cursor = page.next_cursor ?? undefined;
      } while (cursor);
      assert.equal(cleaned, 2);
      for (const intent of [exact, missing]) assert.equal((await owner.query('SELECT state FROM asset_upload_intents WHERE id=$1', [intent.aid])).rows[0].state, 'cleaned');
      await assert.rejects(lstat(join(root, exact.key)), { code: 'ENOENT' });
      const blocked = (await owner.query('SELECT state,last_error_code FROM asset_upload_intents WHERE id=$1', [partial.aid])).rows[0];
      assert.equal(blocked.state, 'blocked'); assert.equal(blocked.last_error_code, 'UPLOAD_OBJECT_MISMATCH');
      assert.deepEqual(await readFile(join(root, partial.key)), validated.bytes.subarray(0, 20));
      assert.equal((await owner.query('SELECT last_error_code FROM asset_upload_intents WHERE id=$1', [ready.aid])).rows[0].last_error_code, 'ASSET_RECORD_PRESENT');
      assert.deepEqual(await readFile(join(root, ready.key)), validated.bytes); assert.deepEqual(await readFile(join(root, unrelated)), validated.bytes);
      const retry = await seedIntent(validated.bytes);
      const fault = t.mock.method(store, 'removeConditional', async () => { throw new Error('测试故障注入：暂时不可用'); });
      assert.equal((await cleanupAssetUploadIntents(pool, store)).failed, 1);
      const failed = (await owner.query('SELECT state,last_error_code FROM asset_upload_intents WHERE id=$1', [retry.aid])).rows[0];
      assert.equal(failed.state, 'abandoned'); assert.equal(failed.last_error_code, 'STORAGE_CLEANUP_FAILED');
      fault.mock.restore();
      assert.equal((await cleanupAssetUploadIntents(pool, store)).cleaned, 1);
      await assert.rejects(lstat(join(root, retry.key)), { code: 'ENOENT' });
      const pending: { aid: string; key: string }[] = [];
      for (let i = 0; i < 8; i++) pending.push(await seedIntent(undefined, false));
      const before = (await owner.query('SELECT count(*)::int AS n FROM asset_upload_intents WHERE restaurant_id=$1', [orphanRid])).rows[0].n;
      const capped = await upload(orphanRid, alice, png);
      assert.equal(capped.statusCode, 409); assert.equal(capped.json().code, 'ASSET_UPLOAD_LIMIT_EXCEEDED');
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM asset_upload_intents WHERE restaurant_id=$1', [orphanRid])).rows[0].n, before);
      await assert.rejects(pool.query("UPDATE asset_upload_intents SET state='committed' WHERE id=$1", [pending[0]!.aid]), { code: '23514' });
      await owner.query("UPDATE asset_upload_intents SET expires_at=now()-interval '16 minutes' WHERE restaurant_id=$1 AND state='pending'", [orphanRid]);
      assert.equal((await cleanupAssetUploadIntents(pool, store)).cleaned, 8);
      assert.deepEqual(await readFile(join(root, partial.key)), validated.bytes.subarray(0, 20));
    } finally { store.close(); }
  });
  await t.test('锁内限制每店100份/200MiB，满配额仍可同键重放', async () => {
    const quotaRid = await restaurant(alice, '配额测试餐厅'), store = createAssetStore(config);
    async function seed(bytes: Buffer, mime: 'image/png' | 'application/pdf', count: number): Promise<string> {
      const validated = await validateUpload(bytes, mime, 'menu_source');
      let firstKey = '';
      for (let i = 0; i < count; i++) {
        const aid = id('ast'), key = id('quota'), filename = mime === 'image/png' ? '配额.png' : '配额.pdf';
        const storageKey = `${quotaRid}/${aid}.${mime === 'image/png' ? 'png' : 'pdf'}`;
        await store.put(storageKey, validated.bytes, mime);
        await owner.query(`INSERT INTO assets(id,restaurant_id,kind,original_filename,mime_type,size_bytes,checksum,source_checksum,width_px,height_px,
          rights_confirmed_at,storage_backend,storage_key,upload_idempotency_key,initial_request_fingerprint)
          VALUES($1,$2,'menu_source',$3,$4,$5,$6,$7,$8,$9,now(),'local',$10,$11,$12)`,
        [aid, quotaRid, filename, mime, validated.sizeBytes, validated.checksum, validated.sourceChecksum, validated.width, validated.height, storageKey, key,
          checksum(Buffer.from(JSON.stringify([validated.sourceChecksum, 'menu_source', filename])))]);
        if (!firstKey) firstKey = key;
      }
      return firstKey;
    }
    async function clearQuota(): Promise<void> {
      await owner.query(`UPDATE assets SET status='deleted',revision=revision+1,deleted_at=now(),updated_at=now() WHERE restaurant_id=$1 AND status='ready'`, [quotaRid]);
      let cursor: string | undefined;
      do { cursor = (await cleanupDeletedAssets(pool, store, 100, cursor)).next_cursor ?? undefined; } while (cursor);
    }
    try {
      const key = await seed(png, 'image/png', 100), before = await files(quotaRid);
      const full = await upload(quotaRid, alice, png);
      assert.equal(full.statusCode, 409, full.body); assert.equal(full.json().code, 'ASSET_QUOTA_EXCEEDED');
      assert.deepEqual(await files(quotaRid), before);
      assert.equal((await upload(quotaRid, alice, png, 'image/png', '配额.png', key)).statusCode, 201);
      assert.deepEqual(await files(quotaRid), before);
      await clearQuota();
      // 在 xref/trailer 后、startxref 前增加合法空白，构造真正20MiB的静态PDF，保持所有对象偏移不变。
      const at = menuPdf.lastIndexOf(Buffer.from('startxref'));
      const largePdf = Buffer.concat([menuPdf.subarray(0, at), Buffer.alloc(MAX_UPLOAD_BYTES - menuPdf.length, 32), menuPdf.subarray(at)]);
      await seed(largePdf, 'application/pdf', 10);
      const size = await owner.query("SELECT count(*)::int AS count,sum(size_bytes)::text AS bytes FROM assets WHERE restaurant_id=$1 AND status='ready'", [quotaRid]);
      assert.equal(size.rows[0].count, 10); assert.equal(Number(size.rows[0].bytes), 200 * 1024 * 1024);
      const byteFull = await upload(quotaRid, alice, png);
      assert.equal(byteFull.statusCode, 409, byteFull.body); assert.equal(byteFull.json().code, 'ASSET_QUOTA_EXCEEDED');
      assert.equal((await files(quotaRid)).length, 10);
    } finally { await clearQuota(); store.close(); }
  });
  await t.test('应用角色不能改存储键/初始指纹、物理删行或写未来引用', async () => {
    await assert.rejects(pool.query('UPDATE assets SET storage_key=$2 WHERE id=$1', [menu.id, `${rid}/${id('ast')}.pdf`]), { code: '42501' });
    await assert.rejects(pool.query("UPDATE assets SET initial_request_fingerprint=$2 WHERE id=$1", [menu.id, '0'.repeat(64)]), { code: '42501' });
    await assert.rejects(pool.query('DELETE FROM assets WHERE id=$1', [menu.id]), { code: '42501' });
    await assert.rejects(pool.query('INSERT INTO asset_references(id,restaurant_id,asset_id,purpose,resource_id) VALUES($1,$2,$3,$4,$5)', [id('ref'), rid, menu.id, 'future_menu', 'forbidden']), { code: '42501' });
    await assert.rejects(validateUpload(Buffer.alloc(MAX_IMAGE_BYTES + 1), 'image/png', 'logo'), { status: 413 });
    await assert.rejects(pool.query("UPDATE asset_upload_intents SET attempt_marker=$2 WHERE id=$1", [menu.id, randomBytes(24).toString('hex')]), { code: '42501' });
    await assert.rejects(pool.query("UPDATE asset_upload_intents SET expected_checksum=$2 WHERE id=$1", [menu.id, '0'.repeat(64)]), { code: '42501' });
    await assert.rejects(pool.query("UPDATE asset_upload_intents SET expires_at=now() WHERE id=$1", [menu.id]), { code: '42501' });
    await assert.rejects(pool.query('DELETE FROM asset_upload_intents WHERE id=$1', [menu.id]), { code: '42501' });
  });
});
