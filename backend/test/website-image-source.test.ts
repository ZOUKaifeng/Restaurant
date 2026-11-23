import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, test, type TestContext } from 'node:test';
import sharp from 'sharp';
import type { Database } from '../src/db.js';
import type { AssetStore } from '../src/asset-storage.js';
import type { WebsiteSnapshot } from '../src/website-html.js';
import {
  eligibleWebsiteImageAssets, prepareWebsiteImages, sourcesCurrent, validateWebsiteImageJob, validateWebsiteImageSources,
  websiteImageSourcesRequired, type WebsiteImageJob, type WebsiteImageSourceRow,
} from '../src/website-image-source.js';
import { websiteVisionLimits } from '../src/website-vision.js';

const rid = `rst_${'r'.repeat(24)}`, aid = (marker = 'a') => `ast_${marker.repeat(24)}`;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const restaurant: WebsiteSnapshot['restaurant'] = { id: rid, name: '纯测试餐厅', description: null, cuisine_type: null,
  address_line1: null, address_line2: null, city: null, region: null, postal_code: null, country_code: null,
  contact_email: null, contact_phone: null, timezone: null, currency: null, primary_locale: 'zh-CN' };
const unavailable = { code: 'WEBSITE_IMAGE_SOURCE_UNAVAILABLE' }, limit = { code: 'WEBSITE_VISION_LIMIT' };
const pixelBytes = (image: { data_url: string }) => Buffer.from(image.data_url.slice('data:image/jpeg;base64,'.length), 'base64');
async function photo(width = 80, height = 40): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#ec1020' } }).jpeg().toBuffer();
}
async function fixture(bytes: Buffer, marker = 'a'): Promise<{ job: WebsiteImageJob; row: WebsiteImageSourceRow }> {
  const metadata = await sharp(bytes).metadata(), mime = metadata.format === 'png' ? 'image/png' : 'image/jpeg';
  const asset = { id: aid(marker), kind: 'restaurant_photo' as const, mime_type: mime as WebsiteImageSourceRow['mime_type'], checksum: sha(bytes), width_px: metadata.width!, height_px: metadata.height! };
  const job: WebsiteImageJob = { id: `wsj_${'j'.repeat(24)}`, kind: 'generate', restaurant_id: rid, requesting_user_id: `usr_${'u'.repeat(24)}`,
    status: 'running', lease_token: '纯测试租约', input: { brief: '按实际照片设计，不做 OCR', asset_ids: [asset.id], public_assets_confirmed: true, image_vision_confirmed: true },
    snapshot: { restaurant: { ...restaurant }, opening_hours: [], assets: [asset] } };
  const row: WebsiteImageSourceRow = { ...asset, restaurant_id: rid, size_bytes: bytes.length, status: 'ready', safety_status: 'approved',
    rights_confirmed_at: new Date('2026-01-01T00:00:00Z'), origin: 'upload', storage_backend: 'local', storage_key: `${rid}/${asset.id}.${mime === 'image/png' ? 'png' : 'jpg'}`,
    reference_restaurant_id: rid, reference_asset_id: asset.id, reference_purpose: 'website_job', reference_resource_id: job.id };
  return { job, row };
}
function mockStore(read: AssetStore['read'] = async () => assert.fail('不得读取素材')) {
  const state = { reads: 0, closes: 0 };
  const store: Pick<AssetStore, 'read' | 'close'> = {
    read: async (...args) => { state.reads++; return read(...args); }, close: () => { state.closes++; },
  };
  return { store, state };
}
function mockDatabase(rows: WebsiteImageSourceRow[] = []) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = { query: async (sql: string, values: unknown[]) => { calls.push({ sql, values }); return { rows }; } } as unknown as Database;
  return { db, calls };
}
beforeEach(t => { (t as TestContext).mock.method(globalThis, 'fetch', async () => assert.fail('纯测试禁止真实网络')); });

test('仅选中快照 JPG/PNG 照片入视觉，菜单图片/PDF/未知类型排除，descriptor 不污染快照', async () => {
  const bytes = await photo(), { job, row } = await fixture(bytes), original = structuredClone(job);
  const photos = ['restaurant_photo', 'dish_photo', 'logo'].map((kind, index) => ({ ...job.snapshot.assets[0]!, id: aid(String(index)), kind }));
  job.snapshot.assets = [...photos, { ...photos[0]!, id: aid('m'), kind: 'menu_source' },
    { ...photos[0]!, id: aid('p'), kind: 'menu_source', mime_type: 'application/pdf', width_px: null, height_px: null },
    { ...photos[0]!, id: aid('x'), kind: 'private_photo' }, { ...photos[0]!, id: aid('q'), mime_type: 'application/pdf' }];
  job.input.asset_ids = job.snapshot.assets.map(asset => asset.id).reverse();
  const frozen = structuredClone(job), rows = photos.map(asset => ({ ...row, ...asset,
    storage_key: `${rid}/${asset.id}.jpg`, reference_asset_id: asset.id })).reverse() as WebsiteImageSourceRow[];
  const { store, state } = mockStore(async (backend, key, size, hash) => {
    assert.equal(backend, 'local'); assert.ok(rows.some(source => source.storage_key === key));
    assert.equal(size, bytes.length); assert.equal(hash, sha(bytes)); return bytes;
  });
  const images = await prepareWebsiteImages(job, rows, store);
  assert.deepEqual(images.map(image => image.asset_id), photos.map(asset => asset.id));
  assert.equal(state.reads, 3); assert.equal(state.closes, 1); assert.deepEqual(job, frozen);
  assert.ok(!JSON.stringify(job).includes('storage_key') && !JSON.stringify(job).includes('data:image'));
  assert.equal(original.snapshot.assets.length, 1);
});

test('legacy 缺少许可或许可不为 true，chat 即使带照片也不查 DB、不读 store', async () => {
  const { job, row } = await fixture(await photo());
  for (const input of [{ ...job.input, image_vision_confirmed: undefined }, { ...job.input, image_vision_confirmed: false },
    { ...job.input, image_vision_confirmed: 'true' }]) {
    const legacy = { ...job, input } as WebsiteImageJob, { db, calls } = mockDatabase(), { store, state } = mockStore();
    assert.equal(websiteImageSourcesRequired(legacy), false);
    assert.deepEqual(await sourcesCurrent(db, legacy, legacy, false, null), []);
    assert.deepEqual(await prepareWebsiteImages(legacy, [row], store), []);
    assert.equal(calls.length, 0); assert.equal(state.reads, 0); assert.equal(state.closes, 1);
  }
  const chat = { ...job, kind: 'chat' as const }, { store, state } = mockStore();
  assert.deepEqual(await prepareWebsiteImages(chat, [row], store), []); assert.equal(state.reads, 0);
});

test('noeligible 不添加许可/引用/asset_ids 新要求，不读 PDF 或菜单图片', async () => {
  const { job } = await fixture(await photo());
  for (const assets of [[], job.snapshot.assets.map(asset => ({ ...asset, kind: 'menu_source' })),
    job.snapshot.assets.map(asset => ({ ...asset, mime_type: 'application/pdf' }))]) {
    const textJob = { ...job, input: { image_vision_confirmed: true as const }, snapshot: { ...job.snapshot, assets } };
    const { db, calls } = mockDatabase(), { store, state } = mockStore();
    assert.deepEqual(eligibleWebsiteImageAssets(textJob.snapshot), []);
    assert.deepEqual(await sourcesCurrent(db, textJob, textJob, false, null), []);
    assert.deepEqual(await prepareWebsiteImages(textJob, [], store), []);
    assert.equal(calls.length, 0); assert.equal(state.reads, 0); assert.equal(state.closes, 1);
  }
});

test('job/rid/requestingUser/lease/status/授权守卫在任何素材查询之前拒绝', async () => {
  const { job } = await fixture(await photo());
  const cases: Array<{ current?: WebsiteImageJob; authorized?: boolean; remaining?: number | null; code: string }> = [
    { current: { ...job, id: '其它任务' }, code: 'JOB_INTERRUPTED' },
    { current: { ...job, restaurant_id: '其它餐厅' }, code: 'JOB_INTERRUPTED' },
    { current: { ...job, requesting_user_id: '其它用户' }, code: 'JOB_INTERRUPTED' },
    { current: { ...job, lease_token: '其它租约' }, code: 'JOB_INTERRUPTED' },
    { current: { ...job, lease_token: null }, code: 'JOB_INTERRUPTED' },
    { current: { ...job, status: 'failed' }, code: 'JOB_INTERRUPTED' },
    { current: { ...job, kind: 'chat' }, code: 'JOB_INTERRUPTED' },
    { remaining: 0, code: 'JOB_INTERRUPTED' }, { remaining: -1, code: 'JOB_INTERRUPTED' },
    { remaining: null, code: 'JOB_INTERRUPTED' }, { remaining: NaN, code: 'JOB_INTERRUPTED' },
    { authorized: false, code: 'WEBSITE_CONTEXT_REVOKED' },
  ];
  for (const item of cases) {
    const { db, calls } = mockDatabase();
    await assert.rejects(sourcesCurrent(db, item.current ?? job, job, item.authorized ?? true,
      item.remaining === undefined ? 60 : item.remaining), { code: item.code });
    assert.equal(calls.length, 0);
  }
});

test('视觉/公开许可撤销、snapshot/input IDs 不匹配、重复/跨店清单在素材查询前拒绝', async () => {
  const { job } = await fixture(await photo());
  const inputs = [{ ...job.input, image_vision_confirmed: undefined }, { ...job.input, public_assets_confirmed: undefined },
    { ...job.input, asset_ids: [] }, { ...job.input, asset_ids: [aid('x')] }, { ...job.input, asset_ids: [aid(), aid()] }];
  for (const input of inputs) {
    const { db, calls } = mockDatabase();
    await assert.rejects(sourcesCurrent(db, { ...job, input }, job, true, 60), unavailable); assert.equal(calls.length, 0);
  }
  const differentRestaurant = structuredClone(job); differentRestaurant.snapshot.restaurant.id = '跨店';
  assert.throws(() => validateWebsiteImageJob(differentRestaurant, job, true, 60), unavailable);
  const duplicate = structuredClone(job); duplicate.snapshot.assets.push(duplicate.snapshot.assets[0]!); duplicate.input.asset_ids!.push(aid());
  assert.throws(() => validateWebsiteImageSources(duplicate, []), unavailable);
});

test('每次 sourcesCurrent 都比较 claim 冻结的 id/checksum/mime/kind/dims，当前快照篡改拒绝', async () => {
  const { job } = await fixture(await photo());
  for (const change of [{ checksum: 'f'.repeat(64) }, { mime_type: 'image/png' }, { kind: 'menu_source' },
    { width_px: 81 }, { height_px: 41 }, { id: aid('b') }]) {
    const current = structuredClone(job); Object.assign(current.snapshot.assets[0]!, change);
    if (change.id) current.input.asset_ids = [change.id];
    const { db, calls } = mockDatabase();
    await assert.rejects(sourcesCurrent(db, current, job, true, 60), unavailable); assert.equal(calls.length, 0);
  }
});

test('sourcesCurrent 仅参数化 SELECT 当前素材及精确 website_job 引用，descriptor 来自真实行', async () => {
  const { job, row } = await fixture(await photo()), { db, calls } = mockDatabase([row]);
  const rows = await sourcesCurrent(db, structuredClone(job), job, true, 60);
  assert.deepEqual(rows, [row]); assert.notEqual(rows[0], row);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0]!.values, [rid, job.id, [aid()]]);
  assert.match(calls[0]!.sql, /JOIN asset_references/); assert.match(calls[0]!.sql, /ar\.purpose='website_job' AND ar\.resource_id=\$2/);
  assert.match(calls[0]!.sql, /a\.restaurant_id=\$1/); assert.doesNotMatch(calls[0]!.sql, /INSERT|UPDATE|DELETE/);
  row.checksum = 'b'.repeat(64);
  await assert.rejects(sourcesCurrent(db, job, job, true, 60), unavailable);
});

test('真实行归属、引用、rights/safety/ready/origin、存储与全部冻结元数据 mismatch 在读前失败', async () => {
  const { job, row } = await fixture(await photo());
  const changes: Array<Partial<WebsiteImageSourceRow>> = [
    { restaurant_id: '跨店' }, { reference_restaurant_id: '跨店' }, { reference_asset_id: aid('b') },
    { reference_purpose: 'menu_job' }, { reference_resource_id: '其它任务' }, { status: 'deleted' },
    { safety_status: 'pending' }, { rights_confirmed_at: null }, { rights_confirmed_at: new Date(NaN) }, { origin: 'remote' },
    { checksum: 'b'.repeat(64) }, { mime_type: 'image/png' }, { kind: 'dish_photo' }, { width_px: 81 }, { height_px: 41 },
    { size_bytes: 0 }, { size_bytes: 1.5 }, { storage_key: `${rid}/${aid('b')}.jpg` }, { storage_backend: 'other' as 'local' },
  ];
  for (const change of changes) {
    const { store, state } = mockStore();
    await assert.rejects(prepareWebsiteImages(job, [{ ...row, ...change }], store), unavailable);
    assert.equal(state.reads, 0); assert.equal(state.closes, 1);
  }
});

test('引用丢失、重复或额外图源显式失败，不偷偷略图', async () => {
  const { job, row } = await fixture(await photo());
  for (const rows of [[], [row, row], [{ ...row, id: aid('b') }]]) {
    const { store, state } = mockStore();
    await assert.rejects(prepareWebsiteImages(job, rows, store), unavailable); assert.equal(state.reads, 0); assert.equal(state.closes, 1);
  }
  const { db } = mockDatabase(); await assert.rejects(sourcesCurrent(db, job, job, true, 60), unavailable);
});

test('store mock 不校验时 helper 仍独立检查真实 bytes 长度与 SHA256', async () => {
  const bytes = await photo(), { job, row } = await fixture(bytes);
  for (const wrong of [bytes.subarray(0, bytes.length - 1), Buffer.alloc(bytes.length), undefined as unknown as Buffer]) {
    const { store, state } = mockStore(async () => wrong);
    await assert.rejects(prepareWebsiteImages(job, [row], store), unavailable); assert.equal(state.reads, 1); assert.equal(state.closes, 1);
  }
});

test('文件缺失和存储错误统一安全码并 finally.close，不泄漏路径或原始异常', async () => {
  const { job, row } = await fixture(await photo()), { store, state } = mockStore(async () => { throw new Error('ENOENT /private/secret/path'); });
  await assert.rejects(prepareWebsiteImages(job, [row], store), error => {
    assert.ok(error instanceof Error); assert.equal((error as Error & { code: string }).code, unavailable.code);
    assert.ok(!error.message.includes('/private/') && !error.message.includes('secret')); return true;
  });
  assert.equal(state.closes, 1);
});

test('PDF 冒充 JPG 即便 bytes/checksum 完全匹配也不得解码或外发', async () => {
  const { job, row } = await fixture(await photo()), bytes = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
  row.size_bytes = bytes.length; row.checksum = sha(bytes); job.snapshot.assets[0]!.checksum = row.checksum;
  const { store, state } = mockStore(async () => bytes);
  await assert.rejects(prepareWebsiteImages(job, [row], store), unavailable); assert.equal(state.closes, 1);
});

test('损坏 JPEG、真实 MIME 不符、截断 PNG 均显式失败并关闭 store', async () => {
  const png = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#00aa00' } }).png().toBuffer();
  for (const bytes of [Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x00, 0xff, 0xd9]), png, png.subarray(0, png.length - 4)]) {
    const { job, row } = await fixture(await photo()); row.size_bytes = bytes.length; row.checksum = sha(bytes); job.snapshot.assets[0]!.checksum = row.checksum;
    const { store, state } = mockStore(async () => bytes);
    await assert.rejects(prepareWebsiteImages(job, [row], store), unavailable); assert.equal(state.closes, 1);
  }
});

test('真实 EXIF 方向自动旋转且去除 EXIF/ICC/XMP 元数据，输出尺寸与像素准确', async () => {
  const bytes = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#ef1020' } })
    .withMetadata({ orientation: 6 }).withExifMerge({ IFD0: { Artist: '不得外发的作者', Copyright: '不得外发的版权元数据' } })
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">不得外发的元数据</x:xmpmeta>').jpeg().toBuffer();
  const input = await sharp(bytes).metadata(); assert.ok(input.exif && input.icc && input.xmp); assert.equal(input.orientation, 6);
  const { job, row } = await fixture(bytes), { store, state } = mockStore(async () => bytes);
  const [image] = await prepareWebsiteImages(job, [row], store), output = await sharp(pixelBytes(image!)).metadata();
  assert.equal(image!.mime_type, 'image/jpeg'); assert.equal(image!.width_px, 40); assert.equal(image!.height_px, 80);
  assert.equal(output.width, image!.width_px); assert.equal(output.height, image!.height_px);
  assert.equal(output.exif, undefined); assert.equal(output.icc, undefined); assert.equal(output.xmp, undefined); assert.equal(output.orientation, undefined);
  const pixels = await sharp(pixelBytes(image!)).raw().toBuffer(); assert.ok(pixels[0]! > 200 && pixels[1]! < 50);
  assert.equal(state.closes, 1);
});

test('透明 PNG 内存 flatten 白底并转 JPEG，不保留 alpha 或元数据', async () => {
  const bytes = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 20, g: 40, b: 80, alpha: 0 } } }).withMetadata().png().toBuffer();
  const { job, row } = await fixture(bytes), { store } = mockStore(async () => bytes);
  const [image] = await prepareWebsiteImages(job, [row], store), decoded = sharp(pixelBytes(image!));
  const metadata = await decoded.metadata(); assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.hasAlpha, false); assert.equal(metadata.icc, undefined);
  const pixels = await decoded.raw().toBuffer(); assert.ok(pixels.subarray(0, 3).every(value => value >= 250));
});

test('大尺寸真实图 inside 缩至 1280 且不放大小图，逐图 JPEG ≤160KiB', async () => {
  for (const [width, height, expected] of [[5000, 3000, [1280, 768]], [80, 40, [80, 40]]] as const) {
    const bytes = await photo(width, height), { job, row } = await fixture(bytes), { store } = mockStore(async () => bytes);
    const [image] = await prepareWebsiteImages(job, [row], store);
    assert.deepEqual([image!.width_px, image!.height_px], expected); assert.ok(pixelBytes(image!).length <= websiteVisionLimits.perImageBytes);
  }
});

test('真实高噪声 JPEG 逐级降 quality/尺寸直至满足预算，不丢图', async () => {
  const bytes = await sharp(randomBytes(1280 * 1280 * 3), { raw: { width: 1280, height: 1280, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
  const first = await sharp(bytes).jpeg({ quality: 75 }).toBuffer(); assert.ok(first.length > websiteVisionLimits.perImageBytes);
  const { job, row } = await fixture(bytes), { store } = mockStore(async () => bytes);
  const [image] = await prepareWebsiteImages(job, [row], store);
  assert.equal(image!.asset_id, row.id); assert.ok(image!.width_px < 1280); assert.ok(pixelBytes(image!).length <= websiteVisionLimits.perImageBytes);
});

test('第九张、源图>10MiB 或>20MP 在 store.read 之前以 WEBSITE_VISION_LIMIT 拒绝', async () => {
  const { job, row } = await fixture(await photo());
  const many = structuredClone(job); many.snapshot.assets = Array.from({ length: 9 }, (_, index) => ({ ...job.snapshot.assets[0]!, id: aid(String(index)) }));
  many.input.asset_ids = many.snapshot.assets.map(asset => asset.id);
  const cases = [
    { job: many, rows: [] }, { job, rows: [{ ...row, size_bytes: websiteVisionLimits.originalImageBytes + 1 }] },
    { job: { ...job, snapshot: { ...job.snapshot, assets: [{ ...job.snapshot.assets[0]!, width_px: 5000, height_px: 4001 }] } }, rows: [{ ...row, width_px: 5000, height_px: 4001 }] },
  ];
  for (const item of cases) {
    const { store, state } = mockStore(); await assert.rejects(prepareWebsiteImages(item.job, item.rows, store), limit);
    assert.equal(state.reads, 0); assert.equal(state.closes, 1);
  }
});

test('允许8张且总 JPEG ≤1280KiB，输出顺序绑定原始选图 ID，任何异常都不返回部分图片', async () => {
  const bytes = await photo(), { job, row } = await fixture(bytes);
  job.snapshot.assets = Array.from({ length: 8 }, (_, index) => ({ ...job.snapshot.assets[0]!, id: aid(String(index)) }));
  job.input.asset_ids = job.snapshot.assets.map(asset => asset.id);
  const rows = job.snapshot.assets.map(asset => ({ ...row, ...asset, reference_asset_id: asset.id, storage_key: `${rid}/${asset.id}.jpg` })) as WebsiteImageSourceRow[];
  const { store, state } = mockStore(async () => bytes), images = await prepareWebsiteImages(job, rows, store);
  assert.equal(images.length, 8); assert.equal(state.reads, 8); assert.equal(state.closes, 1);
  assert.deepEqual(images.map(image => image.asset_id), job.input.asset_ids);
  assert.ok(images.reduce((total, image) => total + pixelBytes(image).length, 0) <= websiteVisionLimits.totalImageBytes);
  let readCount = 0; const failure = mockStore(async () => { if (++readCount === 2) throw new Error('文件丢失'); return bytes; });
  await assert.rejects(prepareWebsiteImages(job, rows, failure.store), unavailable); assert.equal(failure.state.reads, 2); assert.equal(failure.state.closes, 1);
});

test('所有降级仍无法压入160KiB时显式 WEBSITE_VISION_LIMIT，不偷偷丢图', async t => {
  const bytes = await photo(), { job, row } = await fixture(bytes), { store, state } = mockStore(async () => bytes);
  const probe = sharp(bytes), prototype = Object.getPrototypeOf(probe);
  let attempts = 0;
  t.mock.method(prototype, 'toBuffer', async () => {
    attempts++;
    return { data: Buffer.alloc(websiteVisionLimits.perImageBytes + 1), info: { width: 80, height: 40 } };
  });
  await assert.rejects(prepareWebsiteImages(job, [row], store), limit);
  assert.equal(attempts, 5); assert.equal(state.reads, 1); assert.equal(state.closes, 1); probe.destroy();
});

test('单次 store.read 超时失败并关闭，不等待或外发部分结果', async t => {
  const { job, row } = await fixture(await photo());
  const { store, state } = mockStore(async () => new Promise<Buffer>(() => {}));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejection = assert.rejects(prepareWebsiteImages(job, [row], store), limit);
  t.mock.timers.tick(15_001);
  await rejection; assert.equal(state.reads, 1); assert.equal(state.closes, 1);
});

test('单图所有编码尝试共用5s超时预算，超时显式失败并关闭', async t => {
  const bytes = await photo(), { job, row } = await fixture(bytes), probe = sharp(bytes), prototype = Object.getPrototypeOf(probe);
  let begin: (() => void) | undefined;
  const started = new Promise<void>(resolve => { begin = resolve; });
  t.mock.method(prototype, 'toBuffer', async () => { begin!(); return new Promise(() => {}); });
  const { store, state } = mockStore(async () => bytes);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejection = assert.rejects(prepareWebsiteImages(job, [row], store), limit);
  await started; t.mock.timers.tick(5_001); await rejection;
  assert.equal(state.closes, 1); probe.destroy();
});

test('APNG 控制块不得被 animated:false 静默截成首帧', async () => {
  const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#aa0000' } }).png().toBuffer();
  const control = Buffer.alloc(20); control.writeUInt32BE(8); control.write('acTL', 4); control.writeUInt32BE(2, 8);
  const animated = Buffer.concat([bytes.subarray(0, 33), control, bytes.subarray(33)]), { job, row } = await fixture(bytes);
  row.size_bytes = animated.length; row.checksum = sha(animated); job.snapshot.assets[0]!.checksum = row.checksum;
  const { store, state } = mockStore(async () => animated); await assert.rejects(prepareWebsiteImages(job, [row], store), unavailable); assert.equal(state.closes, 1);
});
