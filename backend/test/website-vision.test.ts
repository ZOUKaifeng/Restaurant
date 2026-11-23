import assert from 'node:assert/strict';
import { beforeEach, test, type TestContext } from 'node:test';
import sharp from 'sharp';
import type { Config } from '../src/config.js';
import { callWebsiteAgent, callWebsiteTools } from '../src/deepseek.js';
import { ApiError } from '../src/errors.js';
import { publicWebsiteSnapshot, websiteAgentContract, websiteAgentTools } from '../src/website-agent-capabilities.js';
import type { WebsiteAgentObservation, WebsiteToolCall, WebsiteToolExchange, WebsiteToolMessage, WebsiteVisionImage } from '../src/website-agent-types.js';
import type { WebsiteSnapshot } from '../src/website-html.js';
import { runWebsiteAgent } from '../src/website-react.js';
import { makeWebsiteVisionParts, requestTextBytes, validateWebsiteVisionParts, websiteVisionLimits } from '../src/website-vision.js';

const config = { website: { apiKey: 'fixture-not-a-real-key', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' } } as Config;
const id = (marker: string) => `ast_${marker.repeat(24)}`;
const snapshot: WebsiteSnapshot = {
  restaurant: { id: 'rst_vision', name: '确认餐厅', description: '确认介绍', cuisine_type: null, address_line1: null,
    address_line2: null, city: null, region: null, postal_code: null, country_code: null, contact_email: null,
    contact_phone: null, timezone: null, currency: null, primary_locale: 'zh-CN' },
  opening_hours: [], assets: [
    { id: id('a'), kind: 'restaurant_photo', mime_type: 'image/jpeg', checksum: 'a'.repeat(64), width_px: 4000, height_px: 2000 },
    { id: id('b'), kind: 'logo', mime_type: 'image/png', checksum: 'b'.repeat(64), width_px: 2000, height_px: 4000 },
    { id: id('c'), kind: 'dish_photo', mime_type: 'image/jpeg', checksum: 'c'.repeat(64), width_px: 3000, height_px: 3000 },
    { id: id('d'), kind: 'menu_source', mime_type: 'image/jpeg', checksum: 'd'.repeat(64), width_px: 100, height_px: 100 },
    { id: id('e'), kind: 'menu_source', mime_type: 'application/pdf', checksum: 'e'.repeat(64), width_px: null, height_px: null },
  ],
  menu: { revision: 7, data: { categories: [{ name: '确认菜单', items: [{ name: '确认菜品', description: null, price_text: '€ 12,50', review_note: '内部备注' }] }], warnings: ['内部警告'] } },
};
const plan = (status = 'pending') => ({ items: [{ id: 'layout', title: '视觉布局与真实校验', status }] });
const draft = {
  html_body: `<main><h1><restaurant-name></restaurant-name></h1><restaurant-description></restaurant-description><restaurant-address></restaurant-address><restaurant-contact></restaurant-contact><restaurant-hours></restaurant-hours><restaurant-menu></restaurant-menu><section class="hero"><restaurant-image data-asset-id="${id('a')}"></restaurant-image></section><section class="logo"><restaurant-image data-asset-id="${id('b')}"></restaurant-image></section><section class="gallery"><restaurant-image data-asset-id="${id('c')}"></restaurant-image></section></main>`,
  css: '.hero{aspect-ratio:2}.logo{width:4rem}.gallery{display:grid}', summary: '依据横图主体、竖版标志与菜品图安排布局',
};
const usage = { prompt_tokens: 70000, completion_tokens: 16000, total_tokens: 86000 };
let sequence = 0;
const call = (name: string, args: unknown = {}): WebsiteToolCall => ({ id: `vision_${++sequence}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const exchangeResult = (calls: WebsiteToolCall[]): WebsiteToolExchange => ({ message: { role: 'assistant', content: null, tool_calls: calls }, usage });
const providerResult = (calls: WebsiteToolCall[] = []) => new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: calls } }], usage }), { status: 200 });
async function photo(asset_id = id('a'), width_px = 16, height_px = 8, color = '#ef1020'): Promise<WebsiteVisionImage> {
  const bytes = await sharp({ create: { width: width_px, height: height_px, channels: 3, background: color } }).jpeg().toBuffer();
  return { asset_id, mime_type: 'image/jpeg', data_url: `data:image/jpeg;base64,${bytes.toString('base64')}`, width_px, height_px };
}
function largeImages(image: WebsiteVisionImage, count = 8, bytes = websiteVisionLimits.perImageBytes) {
  const jpeg = Buffer.from(image.data_url.split(',')[1]!, 'base64');
  return Array.from({ length: count }, (_, index) => ({ ...image, asset_id: id(String(index)),
    data_url: `data:image/jpeg;base64,${Buffer.concat([jpeg, Buffer.alloc(bytes - jpeg.length, index)]).toString('base64')}` }));
}
function withImages(images: WebsiteVisionImage[]): WebsiteSnapshot {
  return { ...snapshot, assets: images.map(image => ({ id: image.asset_id, kind: 'restaurant_photo', mime_type: 'image/jpeg', checksum: 'a'.repeat(64), width_px: 4000, height_px: 2000 })) };
}
const imageMessages = (images: WebsiteVisionImage[], frozen = snapshot): WebsiteToolMessage[] => [{ role: 'user', content: makeWebsiteVisionParts('设计官网', images, frozen) }];

beforeEach(t => { (t as TestContext).mock.method(globalThis, 'fetch', async () => assert.fail('纯单元测试禁止真实网络')); });

test('真实 JPEG 像素与逐图 asset_id/kind/方向绑定，顺序不依赖资产清单', async () => {
  const images = [await photo(id('b'), 8, 16, '#10ef20'), await photo(), await photo(id('c'), 10, 10, '#1020ef')];
  const parts = makeWebsiteVisionParts('依据照片布局，不做菜单 OCR', images, snapshot);
  assert.deepEqual(parts[0], { type: 'text', text: JSON.stringify({ design_brief: '依据照片布局，不做菜单 OCR' }) });
  for (let index = 0; index < images.length; index++) {
    const mapping = parts[1 + index * 2]!, imagePart = parts[2 + index * 2]!, image = images[index]!;
    assert.equal(mapping.type, 'text'); assert.ok(mapping.type === 'text');
    assert.deepEqual(JSON.parse(mapping.text), { asset_id: image.asset_id, kind: snapshot.assets.find(asset => asset.id === image.asset_id)!.kind, width_px: image.width_px, height_px: image.height_px });
    assert.ok(imagePart.type === 'image_url'); assert.equal(imagePart.image_url.detail, 'original');
    assert.equal(imagePart.image_url.url, image.data_url);
    const bytes = Buffer.from(imagePart.image_url.url.split(',')[1]!, 'base64');
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.width, image.width_px); assert.equal(metadata.height, image.height_px);
    const pixel = await sharp(bytes).raw().toBuffer();
    const dominant = index === 0 ? 1 : index === 1 ? 0 : 2;
    assert.ok(pixel[dominant]! > 200, '绑定的图片必须有实际对应的彩色像素');
  }
  assert.ok(!JSON.stringify(parts).includes(id('d')) && !JSON.stringify(parts).includes(id('e')));
});

test('空 images 保持原始文本消息与公开事实结构', async () => {
  assert.deepEqual(makeWebsiteVisionParts('需求', [], snapshot), [{ type: 'text', text: '{"design_brief":"需求"}' }]);
  assert.deepEqual(publicWebsiteSnapshot(snapshot, []), publicWebsiteSnapshot(snapshot));
  assert.equal((publicWebsiteSnapshot(snapshot) as Record<string, unknown>).vision, undefined);
  let calls = 0;
  await runWebsiteAgent(config, '需求', snapshot, async () => {}, async (_config, messages) => {
    calls++; assert.equal(typeof messages[1]!.content, 'string');
    assert.equal(messages[1]!.content, '{"design_brief":"需求"}');
    return exchangeResult([call('update_plan', plan('completed')), call('write_draft', draft), call('validate_draft'), call('finish')]);
  });
  assert.equal(calls, 1);
});

test('错绑、菜单、PDF、非公开照片及重复 ID 在任何 exchange 和观察前拒绝', async () => {
  const image = await photo();
  const cases: Array<{ images: WebsiteVisionImage[]; frozen?: WebsiteSnapshot }> = [
    { images: [{ ...image, asset_id: id('z') }] }, { images: [{ ...image, asset_id: id('d') }] },
    { images: [{ ...image, asset_id: id('e') }] }, { images: [image, image] },
    { images: [image], frozen: { ...snapshot, assets: [{ ...snapshot.assets[0]!, kind: 'private_photo' }] } },
    { images: [image], frozen: { ...snapshot, assets: [{ ...snapshot.assets[0]!, mime_type: 'application/pdf' }] } },
    { images: [image], frozen: { ...snapshot, assets: [snapshot.assets[0]!, snapshot.assets[0]!] } },
    { images: null as unknown as WebsiteVisionImage[] },
  ];
  let requests = 0, observations = 0;
  for (const item of cases) await assert.rejects(runWebsiteAgent(config, '需求', item.frozen ?? snapshot, async () => { observations++; }, async () => {
    requests++; return exchangeResult([]);
  }, undefined, item.images), { code: 'WEBSITE_VISION_INVALID' });
  assert.equal(requests, 0); assert.equal(observations, 0);
});

test('注入 MIME、base64 和缩图尺寸严格校验，不付费', async () => {
  const image = await photo();
  const invalidImages = [
    { ...image, mime_type: 'image/png' }, { ...image, width_px: 0 }, { ...image, height_px: -1 },
    { ...image, width_px: 1.5 }, { ...image, height_px: NaN },
    { ...image, data_url: 'data:image/jpeg;base64,AB==' }, { ...image, data_url: 'data:image/jpeg;base64,AAAA\n' },
    { ...image, data_url: 'data:image/jpeg;base64,AAA' }, { ...image, data_url: 'data:image/jpeg;base64,' },
    { ...image, data_url: 'data:image/png;base64,AAAA' },
  ];
  for (const invalidImage of invalidImages) await assert.rejects(runWebsiteAgent(config, '需求', snapshot, async () => {}, async () => assert.fail('非法图像不得 exchange'), undefined,
    [invalidImage as WebsiteVisionImage]), { code: 'WEBSITE_VISION_INVALID' });
  for (const oversize of [{ ...image, width_px: 1281 }, { ...image, height_px: 1281 }]) {
    await assert.rejects(runWebsiteAgent(config, '需求', snapshot, async () => {}, async () => assert.fail('超限图像不得 exchange'), undefined, [oversize]), { code: 'WEBSITE_VISION_LIMIT' });
  }
  makeWebsiteVisionParts('需求', [{ ...image, width_px: 1280, height_px: 1 }], snapshot);
});

test('8 图、逐图 160KiB、总解码 1280KiB 边界独立于文本 1MiB', async () => {
  const images = largeImages(await photo()), frozen = withImages(images);
  const messages = imageMessages(images, frozen), payload = { messages, tools: websiteAgentTools };
  assert.equal(images.length, 8);
  assert.equal(images.reduce((bytes, image) => bytes + Buffer.from(image.data_url.split(',')[1]!, 'base64').length, 0), websiteVisionLimits.totalImageBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) > websiteVisionLimits.textBytes);
  assert.ok(requestTextBytes(payload) < 10000);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < websiteVisionLimits.requestBytes);
  assert.equal(websiteVisionLimits.originalImageBytes, 10 * 1024 * 1024);
  assert.equal(websiteVisionLimits.originalImagePixels, 20_000_000);
  assert.throws(() => makeWebsiteVisionParts('需求', [...images, { ...images[0]!, asset_id: id('z') }], frozen), { code: 'WEBSITE_VISION_LIMIT' });
  const tooLarge = largeImages(await photo(), 1, websiteVisionLimits.perImageBytes + 1);
  assert.throws(() => imageMessages(tooLarge, withImages(tooLarge)), { code: 'WEBSITE_VISION_LIMIT' });
  assert.throws(() => imageMessages([{ ...images[0]!, data_url: `data:image/jpeg;base64,${'A'.repeat(220000)}` }], frozen), { code: 'WEBSITE_VISION_LIMIT' });
});

test('requestTextBytes 仅替换真实 user image_url，正文和工具参数照常计数且不变更输入', async () => {
  const messages = imageMessages([await photo()]);
  messages.push({ role: 'assistant', content: null, tool_calls: [call('write_draft', { image_url: { url: '正文'.repeat(100) } })] },
    { role: 'tool', tool_call_id: 'fixture', content: '反馈'.repeat(100) });
  const payload = { messages, tools: websiteAgentTools, extra: { image_url: { url: '不能免计'.repeat(100) } } };
  const original = structuredClone(payload), expected = structuredClone(payload);
  const user = expected.messages[0]!; assert.ok(user.role === 'user' && Array.isArray(user.content));
  for (const part of user.content) if (part.type === 'image_url') part.image_url.url = '[website-vision-image]';
  assert.equal(requestTextBytes(payload), Buffer.byteLength(JSON.stringify(expected)));
  assert.deepEqual(payload, original);
  const textOnly = { messages: [{ role: 'user' as const, content: '普通文字' }], tools: [] };
  assert.equal(requestTextBytes(textOnly), Buffer.byteLength(JSON.stringify(textOnly)));
});

test('原生 parts 仅 user 可携图，严格结构、相同像素不同ID允许且第九图拒绝', async () => {
  const image = await photo(), messages = imageMessages([image]);
  assert.doesNotThrow(() => validateWebsiteVisionParts([...messages, ...messages]));
  assert.doesNotThrow(() => makeWebsiteVisionParts('分别使用两份素材', [image, { ...image, asset_id: id('c') }], snapshot));
  for (const role of ['system', 'assistant', 'tool']) {
    assert.throws(() => validateWebsiteVisionParts([{ role, content: (messages[0] as { content: unknown }).content } as WebsiteToolMessage]), { code: 'WEBSITE_VISION_INVALID' });
  }
  for (const content of [[], [{ type: 'file', url: image.data_url }], [{ type: 'text', text: '需求', image_url: { url: image.data_url } }],
    [{ type: 'image_url', image_url: { url: image.data_url, detail: 'auto' } }],
    [{ type: 'image_url', image_url: { url: image.data_url, detail: 'original', extra: image.data_url } }], [null]]) {
    assert.throws(() => validateWebsiteVisionParts([{ role: 'user', content } as unknown as WebsiteToolMessage]), { code: 'WEBSITE_VISION_INVALID' });
  }
  const nine = largeImages(image, 9, 1000);
  assert.throws(() => validateWebsiteVisionParts(nine.map(item => ({ role: 'user', content: [{ type: 'image_url', image_url: { url: item.data_url, detail: 'original' } }] }))), { code: 'WEBSITE_VISION_LIMIT' });
});

test('ReAct 每轮保留完整真实视觉图、最近 native pair/诊断，并隔离调用者修改与持久化', async () => {
  const images = [await photo(), await photo(id('b'), 8, 16, '#10ef20'), await photo(id('c'), 10, 10, '#1020ef')];
  const originalImages = structuredClone(images), frozen = structuredClone(snapshot), originalSnapshot = structuredClone(snapshot);
  const rounds = [[call('read_context')], [call('update_plan', plan())],
    [call('write_draft', { ...draft, html_body: '<main>\n<script>禁止内容</script>\n</main>' }), call('validate_draft')],
    [call('write_draft', draft), call('validate_draft')], [call('update_plan', plan('completed'))], [call('finish')]];
  let index = 0, root: WebsiteToolMessage | undefined;
  const observations: WebsiteAgentObservation[] = [];
  const result = await runWebsiteAgent(config, '看实际照片安排布局', frozen, async observation => { observations.push(structuredClone(observation)); }, async (_config, messages) => {
    root ??= structuredClone(messages[1]!); assert.deepEqual(messages[1], root);
    assert.ok(messages[1]!.role === 'user' && Array.isArray(messages[1]!.content));
    const pictures = messages[1]!.content.filter(part => part.type === 'image_url');
    assert.deepEqual(pictures.map(part => part.image_url.url), originalImages.map(image => image.data_url));
    assert.ok(index < rounds.length);
    if (index > 0) {
      const stateMessage = messages[2]!; assert.ok(stateMessage.role === 'user' && typeof stateMessage.content === 'string');
      const state = JSON.parse(stateMessage.content), assistant = messages[3]!;
      assert.ok(assistant.role === 'assistant'); assert.deepEqual(assistant.tool_calls, rounds[index - 1]);
      assert.equal(messages.length, 4 + assistant.tool_calls.length); assert.equal(messages.at(-1)!.role, 'tool');
      messages.slice(4).forEach((feedback, i) => { assert.ok(feedback.role === 'tool'); assert.equal(feedback.tool_call_id, rounds[index - 1]![i]!.id); });
      const facts = index === 1 ? JSON.parse((messages[4] as { content: string }).content).facts : state.facts;
      assert.equal(facts.restaurant.name, '确认餐厅');
      assert.deepEqual(facts.vision.available_asset_ids, originalImages.map(image => image.asset_id));
      assert.deepEqual(facts.vision.images.map((item: { asset_id: string; width_px: number }) => [item.asset_id, item.width_px]), originalImages.map(image => [image.asset_id, image.width_px]));
      assert.equal(facts.menu.data.categories[0].items[0].price_text, '€ 12,50');
      const transient = JSON.stringify(messages.slice(2));
      for (const image of originalImages) assert.ok(!transient.includes(image.data_url));
      assert.ok(!transient.includes('内部备注') && !transient.includes('内部警告'));
      if (index === 3) {
        const feedback = JSON.parse((messages.at(-1) as { content: string }).content);
        assert.equal(feedback.ok, false);
        assert.ok(feedback.diagnostics.some((item: { file: string; line: number; code: string }) => item.file === 'index.html' && item.line === 2 && item.code === 'HTML_TAG_FORBIDDEN'));
      }
    }
    if (index === 0) { images[0]!.data_url = '不可修改根图'; images[0]!.asset_id = id('z'); frozen.restaurant.name = '不可覆盖快照'; }
    return exchangeResult(rounds[index++]!);
  }, undefined, images);
  assert.equal(index, 6); assert.equal(result.progress.phase, 'ready'); assert.equal(result.progress.round, 2);
  assert.deepEqual(result.usage, { prompt_tokens: 420000, completion_tokens: 96000, total_tokens: 516000 });
  for (const image of originalImages) {
    assert.ok(!JSON.stringify(observations).includes(image.data_url)); assert.ok(!JSON.stringify(result).includes(image.data_url));
    assert.ok(!JSON.stringify(originalSnapshot).includes(image.data_url));
    assert.ok(result.html.includes(`__SITE_ASSET_${image.asset_id}__`));
  }
  assert.equal(originalSnapshot.menu!.data.categories[0]!.items[0]!.review_note, '内部备注');
});

test('纯正文和超大参数剪除分支也不会移除固定图片或伪造 tool feedback', async () => {
  const images = [await photo()], roots = imageMessages(images)[0]!.content;
  let index = 0;
  const result = await runWebsiteAgent(config, '设计官网', snapshot, async () => {}, async (_config, messages) => {
    assert.deepEqual(messages[1]!.content, roots);
    assert.ok(index < 4);
    if (index++ === 0) return exchangeResult([call('read_context'), call('update_plan', plan('completed')), call('write_draft', draft), call('validate_draft')]);
    if (index === 2) return exchangeResult([]);
    if (index === 3) return exchangeResult([call('write_draft', { ...draft, html_body: 'x'.repeat(2 * 1024 * 1024) })]);
    assert.equal(messages.length, 4); assert.equal(messages.at(-1)!.role, 'user');
    const state = JSON.parse((messages[2] as { content: string }).content);
    assert.deepEqual(state.last_observations, [{ tool_name: 'write_draft', ok: false, code: 'TOOL_ARGUMENTS_INVALID' }]);
    assert.equal(state.current_validation_passed, true);
    return exchangeResult([call('finish')]);
  }, undefined, images);
  assert.equal(result.progress.model_calls, 4); assert.equal(result.progress.round, 1);
});

test('模型回显图片 dataURL 到 HTML/CSS/summary/计划时拒绝，不进入 draft 或 trace', async () => {
  const image = await photo(), observations: WebsiteAgentObservation[] = [];
  const rounds = [[call('update_plan', plan('completed'))], [
    call('write_draft', { ...draft, html_body: `<main>${image.data_url}</main>` }),
    call('write_draft', { ...draft, css: `/*${image.data_url}*/` }),
    call('write_draft', { ...draft, summary: image.data_url }),
    call('update_plan', { items: [{ id: 'layout', title: image.data_url, status: 'completed' }] }),
  ], [call('write_draft', draft), call('validate_draft'), call('finish')]];
  let index = 0;
  await runWebsiteAgent(config, '需求', snapshot, async observation => { observations.push(observation); }, async () => {
    assert.ok(index < rounds.length); return exchangeResult(rounds[index++]!);
  }, undefined, [image]);
  assert.equal(observations.filter(observation => observation.draft).length, 1);
  assert.equal(observations.filter(observation => observation.event.message === 'TOOL_ARGUMENTS_INVALID').length, 4);
  assert.ok(!JSON.stringify(observations).includes(image.data_url));
  assert.ok(!JSON.stringify(observations).includes(image.data_url.split(',')[1]!));
});

test('视觉输入下取消在 exchange 前或计费完成后仍生效且保留真实账单', async () => {
  const images = [await photo()];
  for (const stage of ['before', 'started', 'completed']) {
    const controller = new AbortController(), observations: WebsiteAgentObservation[] = [];
    let calls = 0;
    if (stage === 'before') controller.abort();
    await assert.rejects(runWebsiteAgent(config, '需求', snapshot, async observation => {
      observations.push(observation);
      if (observation.event.action === `model_call_${stage}`) controller.abort();
    }, async (_config, _messages, _tools, options) => {
      calls++; assert.equal(options?.signal, controller.signal); return exchangeResult([call('read_context')]);
    }, controller.signal, images), { code: 'AGENT_CANCELLED' });
    assert.equal(calls, stage === 'completed' ? 1 : 0);
    assert.equal(observations.at(-1)!.progress.total_tokens, stage === 'completed' ? usage.total_tokens : 0);
    assert.ok(!JSON.stringify(observations).includes(images[0]!.data_url));
  }
});

test('第7参数允许 undefined exchange/undefined signal，默认原生 tools 无独立视觉请求', async t => {
  const image = await photo(); let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, request: RequestInit) => {
    requests++;
    const body = JSON.parse(request.body as string);
    assert.equal(body.messages[1].content[2].image_url.url, image.data_url);
    assert.equal(body.response_format, undefined); assert.equal(body.tool_choice, 'auto');
    assert.equal(body.max_tokens, 16000); assert.equal(body.thinking.type, 'disabled');
    return providerResult([call('update_plan', plan('completed')), call('write_draft', draft), call('validate_draft'), call('finish')]);
  });
  const result = await runWebsiteAgent(config, '需求', snapshot, async () => {}, undefined, undefined, [image]);
  assert.equal(requests, 1); assert.deepEqual(result.usage, usage);
});

test('callWebsiteTools 接受 >1MiB 图像 JSON，文本接近1MiB但真实 JSON <3MiB，原生请求和用量不变', async t => {
  const images = largeImages(await photo()), messages = imageMessages(images, withImages(images));
  const user = messages[0]!; assert.ok(user.role === 'user' && Array.isArray(user.content));
  user.content.unshift({ type: 'text', text: 't'.repeat(websiteVisionLimits.textBytes - 10000) });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, request: RequestInit) => {
    requests++; const body = JSON.parse(request.body as string);
    assert.deepEqual(body.messages, messages); assert.deepEqual(body.tools, websiteAgentTools);
    assert.equal(body.parallel_tool_calls, false); assert.equal(body.temperature, 0.3); assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 16000); assert.equal(body.response_format, undefined); assert.equal(request.redirect, 'error');
    assert.ok(Buffer.byteLength(request.body as string) > 2 * 1024 * 1024);
    assert.ok(Buffer.byteLength(request.body as string) < websiteVisionLimits.requestBytes);
    assert.ok(requestTextBytes(body) < websiteVisionLimits.textBytes);
    return providerResult([call('read_context')]);
  });
  const result = await callWebsiteTools(config, messages, websiteAgentTools);
  assert.equal(requests, 1); assert.deepEqual(result.usage, usage); assert.equal(result.message.content, null);
});

test('callWebsiteTools 外部/私有 URL、非法 URI、非 user 图像和超额均拒绝且零 fetch', async () => {
  const image = await photo();
  for (const url of ['https://untrusted.example/photo.jpg', 'http://127.0.0.1/private', '/api/v1/private/photo', 'file:///private/photo.jpg',
    'blob:unsafe', 'data:image/png;base64,AAAA', 'data:image/svg+xml;base64,AAAA', 'data:image/jpeg;base64,AB==']) {
    await assert.rejects(callWebsiteTools(config, [{ role: 'user', content: [{ type: 'image_url', image_url: { url, detail: 'original' } }] }], websiteAgentTools), { code: 'WEBSITE_VISION_INVALID' });
  }
  const messages = imageMessages([image]);
  for (const role of ['system', 'assistant', 'tool']) {
    await assert.rejects(callWebsiteTools(config, [{ role, content: messages[0]!.content } as WebsiteToolMessage], websiteAgentTools), { code: 'WEBSITE_VISION_INVALID' });
  }
  const oversize = largeImages(image, 1, websiteVisionLimits.perImageBytes + 1)[0]!;
  await assert.rejects(callWebsiteTools(config, [{ role: 'user', content: [{ type: 'image_url', image_url: { url: oversize.data_url, detail: 'original' } }] }], websiteAgentTools), { code: 'WEBSITE_VISION_LIMIT' });
  const nine = largeImages(image, 9, 1000);
  await assert.rejects(callWebsiteTools(config, nine.map(item => ({ role: 'user', content: [{ type: 'image_url', image_url: { url: item.data_url, detail: 'original' } }] })), websiteAgentTools), { code: 'WEBSITE_VISION_LIMIT' });
});

test('带图请求的文本超1MiB仍报 AGENT_STEP_LIMIT，不误用图像预算放行', async () => {
  const image = await photo(), messages = imageMessages([image]);
  messages.push({ role: 'user', content: '中'.repeat(400000) });
  await assert.rejects(callWebsiteTools(config, messages, websiteAgentTools), { code: 'AGENT_STEP_LIMIT' });
  await assert.rejects(runWebsiteAgent(config, '中'.repeat(400000), snapshot, async () => {}, async () => assert.fail('文本超限不付费'), undefined, [image]), { code: 'AGENT_STEP_LIMIT' });
});

test('callWebsiteTools 已取消零 fetch，发送后取消不盲重试', async t => {
  const messages = imageMessages([await photo()]), controller = new AbortController();
  controller.abort();
  await assert.rejects(callWebsiteTools(config, messages, websiteAgentTools, { maxTokens: 16000, timeoutMs: 75000, signal: controller.signal }), { code: 'AGENT_CANCELLED' });
  const inflight = new AbortController(); let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, request: RequestInit) => {
    requests++; inflight.abort(); assert.equal(request.signal!.aborted, true); throw new DOMException('禁止记录原始正文', 'AbortError');
  });
  await assert.rejects(callWebsiteTools(config, messages, websiteAgentTools, { maxTokens: 16000, timeoutMs: 75000, signal: inflight.signal }), { code: 'AGENT_CANCELLED' });
  assert.equal(requests, 1);
});

test('照片 tools 失败仍保留提供方真实 usage，缺失用量和402不估算、不重试', async t => {
  const messages = imageMessages([await photo()]); let mode = 0, requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    if (mode === 2) return new Response('不得暴露提供方正文', { status: 402 });
    return new Response(JSON.stringify({ choices: [{ finish_reason: mode === 0 ? 'length' : 'tool_calls', message: { tool_calls: [] } }], ...(mode === 0 ? { usage } : {}) }), { status: 200 });
  });
  await assert.rejects(callWebsiteTools(config, messages, websiteAgentTools), error => {
    assert.ok(error instanceof ApiError); assert.equal(error.code, 'AI_OUTPUT_TRUNCATED');
    assert.deepEqual((error as ApiError & { usage: typeof usage }).usage, usage); return true;
  });
  mode = 1; await assert.rejects(callWebsiteTools(config, messages, websiteAgentTools), { code: 'AI_USAGE_UNAVAILABLE' });
  mode = 2; await assert.rejects(callWebsiteTools(config, messages, websiteAgentTools), { code: 'AI_BALANCE_INSUFFICIENT' });
  assert.equal(requests, 3);
});

test('旧设计 chat 保持文本并明确照片视觉仅授权生成步骤，能力契约说明缩图与菜单隔离', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, request: RequestInit) => {
    const body = JSON.parse(request.body as string);
    assert.ok(body.messages.every((message: { content: unknown }) => typeof message.content === 'string'));
    assert.match(body.messages[0].content, /本对话仅文本/);
    assert.match(body.messages[0].content, /独立确认选图授权后的官网生成步骤/);
    assert.ok(!JSON.stringify(body).includes('内部备注') && !JSON.stringify(body).includes('内部警告'));
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"reply":"确认风格","design_brief":"依据选图布局"}' } }], usage }), { status: 200 });
  });
  await callWebsiteAgent(config, [{ role: 'user', content: '如何用照片布局' }], snapshot);
  const contract = websiteAgentContract as { photo_vision: { authorization: string; excluded: string; delivery: string; limits: Record<string, number> } };
  assert.match(contract.photo_vision.authorization, /image_vision_confirmed=true/);
  assert.match(contract.photo_vision.authorization, /不发送全部资产列表的像素/);
  assert.match(contract.photo_vision.excluded, /PDF.*menu_source/);
  assert.match(contract.photo_vision.delivery, /没有独立识图调用/);
  assert.equal(contract.photo_vision.limits.max_request_json_bytes, websiteVisionLimits.requestBytes);
});
