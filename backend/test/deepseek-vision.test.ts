import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import type { Config } from '../src/config.js';
import { recognizeMenuImages, generateWebsite } from '../src/deepseek.js';
import { ApiError } from '../src/errors.js';
import { renderWebsite, type WebsiteSnapshot } from '../src/website-html.js';
const config = { website: { apiKey: 'fixture-not-real-key', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' } } as Config;
const data = { categories: [{ name: '主食', items: [{ name: 'Pizza <b>Test</b>', description: '原文描述', price_text: 'Small $12.50 / Large $18.00', review_note: '内部核对备注' }] }], warnings: ['内部不确定提示'] };
test('真实编码图片通过dataURI发模型，无独立OCR及公共文件URL，返回原文价格', async t => {
  const image = await sharp({ create: { width: 10, height: 6, channels: 3, background: '#ffffff' } }).png().toBuffer();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown, options: RequestInit) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal((options.headers as Record<string, string>).Authorization, 'Bearer fixture-not-real-key');
    const body = JSON.parse(options.body as string);
    assert.equal(body.model, 'deepseek-flash'); assert.equal(body.thinking.type, 'disabled');
    assert.equal(body.response_format.type, 'json_object'); assert.equal(body.stream, false);
    const parts = body.messages[1].content;
    assert.equal(parts.length, 2); assert.equal(parts[1].type, 'image_url'); assert.equal(parts[1].image_url.detail, 'original');
    assert.match(parts[1].image_url.url, /^data:image\/png;base64,/);
    const bytes = Buffer.from(parts[1].image_url.url.split(',')[1], 'base64');
    assert.equal((await sharp(bytes).metadata()).width, 10);
    assert.ok(!JSON.stringify(body.messages).includes('fixture-not-real-key'));
    return new Response(JSON.stringify({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }], usage: { prompt_tokens: 25, completion_tokens: 20, total_tokens: 45 } }), { status: 200 });
  });
  const result = await recognizeMenuImages(config, [{ bytes: image, mime_type: 'image/png' }]);
  assert.equal(calls, 1); assert.equal(result.data.categories[0]!.items[0]!.price_text, 'Small $12.50 / Large $18.00');
  assert.deepEqual(result.usage, { prompt_tokens: 25, completion_tokens: 20, total_tokens: 45 });
});
test('视觉调用不盲重试、错误不暴露上游密钥正文', async t => {
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('provider response must not leak fixture-not-real-key', { status: 402 }); });
  await assert.rejects(recognizeMenuImages(config, [{ bytes: image, mime_type: 'image/png' }]), { code: 'AI_BALANCE_INSUFFICIENT' });
  assert.equal(calls, 1);
  await assert.rejects(recognizeMenuImages({ website: { ...config.website!, baseUrl: 'https://untrusted.example' } } as Config, [{ bytes: image, mime_type: 'image/png' }]), { code: 'AI_CONFIGURATION_INVALID' });
  assert.equal(calls, 1);
});
test('确认菜单由后端转义并保原价格；内部warning/note不公开', () => {
  const snapshot: WebsiteSnapshot = { restaurant: { id: 'example', name: '餐厅', description: null, cuisine_type: null, address_line1: null, address_line2: null, city: null, region: null, postal_code: null, country_code: null, contact_email: null, contact_phone: null, timezone: null, currency: null, primary_locale: 'zh-CN' }, opening_hours: [], assets: [], menu: { revision: 3, data } };
  const page = renderWebsite({ html_body: '<restaurant-menu></restaurant-menu>', css: '', summary: 'Test' }, snapshot).html;
  assert.ok(page.includes('Pizza &lt;b&gt;Test&lt;/b&gt;') && page.includes('Small $12.50 / Large $18.00'));
  assert.ok(!page.includes('内部核对备注') && !page.includes('内部不确定提示'));
  assert.ok(page.includes('data-menu-revision="3"'));
});
test('图片准备之后付费之前执行授权核验，撤销时不向模型发送', async t => {
  const image = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#fff' } }).png().toBuffer();
  let calls = 0, checks = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Must not send'); });
  await assert.rejects(recognizeMenuImages(config, [{ bytes: image, mime_type: 'image/png' }], async () => { checks++; throw new ApiError(503, 'MENU_SEND_CANCELLED'); }), { code: 'MENU_SEND_CANCELLED' });
  assert.equal(checks, 1); assert.equal(calls, 0);
});
test('网页模型只收到菜单公开字段，不发内部备注和不确定警告', async t => {
  const snapshot: WebsiteSnapshot = { restaurant: { id: 'example', name: '餐厅', description: null, cuisine_type: null, address_line1: null, address_line2: null, city: null, region: null, postal_code: null, country_code: null, contact_email: null, contact_phone: null, timezone: null, currency: null, primary_locale: 'zh-CN' }, opening_hours: [], assets: [], menu: { revision: 3, data } };
  t.mock.method(globalThis, 'fetch', async (_: unknown, options: RequestInit) => {
    const body = JSON.parse(options.body as string);
    const transmitted = JSON.stringify(body.messages);
    assert.ok(transmitted.includes('Small $12.50 / Large $18.00'));
    assert.ok(!transmitted.includes('内部核对备注') && !transmitted.includes('内部不确定提示'));
    const user = JSON.parse(body.messages[1].content);
    assert.deepEqual(Object.keys(user.snapshot.menu.data.categories[0].items[0]).sort(), ['description', 'name', 'price_text']);
    assert.equal(user.snapshot.menu.data.warnings, undefined);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ html_body: '<restaurant-menu></restaurant-menu>', css: '', summary: '布局' }) } }] }), { status: 200 });
  });
  await generateWebsite(config, '真实菜单', snapshot);
  assert.equal(snapshot.menu!.data.categories[0]!.items[0]!.review_note, '内部核对备注');
});
