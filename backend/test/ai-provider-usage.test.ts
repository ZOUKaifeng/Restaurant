import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import type { Config } from '../src/config.js';
import type { WebsiteSnapshot } from '../src/website-html.js';
import { ApiError } from '../src/errors.js';
import { callWebsiteAgent, generateWebsite, recognizeMenuImages, callWebsiteTools, prepareWebsiteToolRequest } from '../src/deepseek.js';
import { websiteAgentTools } from '../src/website-agent-capabilities.js';
import { runWebsiteAgent } from '../src/website-react.js';
import { requestTextBytes, websiteVisionLimits } from '../src/website-vision.js';
import type { WebsiteAgentObservation, WebsiteToolMessage } from '../src/website-agent-types.js';

const config = { website: { apiKey: 'fixture-private-provider-key', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' } } as Config;
const snapshot: WebsiteSnapshot = {
  restaurant: { id: 'fixture', name: '餐厅', description: null, cuisine_type: null, address_line1: null, address_line2: null,
    city: null, region: null, postal_code: null, country_code: null, contact_email: null, contact_phone: null, timezone: null,
    currency: null, primary_locale: 'zh-CN' }, opening_hours: [], assets: [],
};
const usage = { prompt_tokens: 25, completion_tokens: 10, total_tokens: 35 };
const chat = { reply: '请确认页面风格。', design_brief: '自然清爽' };
const page = { html_body: '<main><restaurant-name></restaurant-name></main>', css: '', summary: '清爽布局' };
const menu = { categories: [], warnings: ['请人工核对'] };
const image = () => sharp({ create: { width: 3, height: 2, channels: 3, background: '#fff' } }).png().toBuffer();
function response(data: unknown, rawUsage?: unknown): Response {
  return new Response(JSON.stringify({ model: '不可信供应商模型字段', choices: [{ finish_reason: 'stop', message: {
    content: JSON.stringify(data), reasoning_content: '不应输出的供应商正文',
  } }], usage: rawUsage }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
function knownError(error: unknown, code: string): boolean {
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, code);
  assert.equal((error as ApiError & { model: string }).model, 'deepseek-flash');
  assert.deepEqual((error as ApiError & { usage: unknown }).usage, usage);
  assert.ok(!JSON.stringify(error).includes(config.website!.apiKey!));
  assert.ok(!JSON.stringify(error).includes('不应输出的供应商正文'));
  return true;
}

test('对话返回脱敏的三项 usage 和配置 model，发送前 hook 已完成', async t => {
  let checks = 0, persisted = false, calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, request: RequestInit) => {
    calls++;
    assert.equal(persisted, true);
    const body = JSON.parse(request.body as string);
    assert.equal(body.max_tokens, 2400);
    assert.equal(body.model, 'deepseek-flash');
    assert.equal(body.thinking.type, 'disabled');
    assert.equal(body.response_format.type, 'json_object');
    assert.equal(request.redirect, 'error');
    assert.ok(!JSON.stringify(body).includes(config.website!.apiKey!));
    return response(chat, { ...usage, provider_private: '不应输出的供应商正文' });
  });
  const result = await callWebsiteAgent(config, [{ role: 'user', content: '生成页面' }], snapshot, async () => {
    checks++;
    await Promise.resolve();
    persisted = true;
  });
  assert.equal(checks, 1); assert.equal(calls, 1);
  assert.deepEqual(result, { ...chat, model: 'deepseek-flash', usage });
});

test('JSON 对话、生成、菜单缺失 usage 仍可成功，但保持 null 而不是零', async t => {
  let mode = 'chat', calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(mode === 'chat' ? chat : mode === 'page' ? page : menu); });
  assert.equal((await callWebsiteAgent(config, [], snapshot)).usage, null);
  mode = 'page'; assert.equal((await generateWebsite(config, '布局', snapshot)).usage, null);
  mode = 'menu'; assert.equal((await recognizeMenuImages(config, [{ bytes: await image(), mime_type: 'image/png' }])).usage, null);
  assert.equal(calls, 3);
});

test('不完整、非安全整数、负数、字符串及矛盾总量统一保持 unknown', async t => {
  const invalid: unknown[] = [null, [], {}, { prompt_tokens: 25, completion_tokens: 10 },
    { ...usage, total_tokens: 34 }, { ...usage, total_tokens: 36 }, { ...usage, prompt_tokens: '25' },
    { ...usage, prompt_tokens: -1 }, { ...usage, completion_tokens: 1.5 },
    { ...usage, total_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER }];
  let current: unknown, calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(chat, current); });
  for (current of invalid) assert.equal((await callWebsiteAgent(config, [], snapshot)).usage, null);
  assert.equal(calls, invalid.length);
});

test('提供方明确返回三项零时是有效已知 usage', async t => {
  const zero = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  t.mock.method(globalThis, 'fetch', async () => response(chat, zero));
  assert.deepEqual((await callWebsiteAgent(config, [], snapshot)).usage, zero);
});

test('先提取真实 usage，choice 非法和内部 JSON 解析失败仍附已知账单', async t => {
  let content = '{不合法 JSON', finish = 'stop';
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ usage: { ...usage, private: '不应输出的供应商正文' },
    choices: [{ finish_reason: finish, message: { content } }] }), { status: 200 }));
  await assert.rejects(callWebsiteAgent(config, [], snapshot), error => knownError(error, 'AI_RESPONSE_INVALID'));
  content = JSON.stringify(chat); finish = 'length';
  await assert.rejects(callWebsiteAgent(config, [], snapshot), error => knownError(error, 'AI_RESPONSE_INVALID'));
});

test('输出 object/text 校验失败同样附已知 usage，不泄露供应商正文', async t => {
  let data: unknown = { ...chat, unexpected: true };
  t.mock.method(globalThis, 'fetch', async () => response(data, usage));
  await assert.rejects(callWebsiteAgent(config, [], snapshot), error => knownError(error, 'AI_OUTPUT_INVALID'));
  data = { reply: '', design_brief: '' };
  await assert.rejects(callWebsiteAgent(config, [], snapshot), error => knownError(error, 'AI_OUTPUT_INVALID'));
  data = { ...page, summary: '' };
  await assert.rejects(generateWebsite(config, '布局', snapshot), error => knownError(error, 'AI_OUTPUT_INVALID'));
});

test('菜单 normalize 失败附已知 usage，图片准备后才执行一次发送 hook', async t => {
  const bytes = await image(); let checks = 0, calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, request: RequestInit) => {
    calls++;
    assert.equal(checks, 1);
    const sent = JSON.parse(request.body as string);
    assert.equal(sent.max_tokens, 10000);
    assert.equal(sent.messages[1].content[1].image_url.detail, 'original');
    assert.match(sent.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
    return response({ ...menu, unexpected: true }, usage);
  });
  await assert.rejects(recognizeMenuImages(config, [{ bytes, mime_type: 'image/png' }], async () => { checks++; }),
    error => knownError(error, 'AI_OUTPUT_INVALID'));
  assert.equal(calls, 1); assert.equal(checks, 1);
});

test('JSON 本地配置错误不执行发送 hook，菜单图片预处理成功也不能提前计量', async t => {
  let checks = 0, calls = 0;
  const hook = async () => { checks++; };
  const invalid = { ...config, website: { ...config.website!, model: 'invalid-fixture-model' } };
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(chat, usage); });
  await assert.rejects(callWebsiteAgent(invalid, [], snapshot, hook), { code: 'AI_CONFIGURATION_INVALID' });
  await assert.rejects(generateWebsite(invalid, '布局', snapshot, hook), { code: 'AI_CONFIGURATION_INVALID' });
  await assert.rejects(recognizeMenuImages(invalid, [{ bytes: await image(), mime_type: 'image/png' }], hook), { code: 'AI_CONFIGURATION_INVALID' });
  await assert.rejects(callWebsiteAgent({ ...config, website: { ...config.website!, apiKey: undefined } }, [], snapshot, hook), { code: 'AI_NOT_CONFIGURED' });
  assert.equal(checks, 0); assert.equal(calls, 0);
});

test('JSON body 超限在发送 hook 之前拒绝，零调用', async t => {
  let checks = 0, calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(page, usage); });
  await assert.rejects(generateWebsite(config, 'x'.repeat(40 * 1024 * 1024), snapshot, async () => { checks++; }), { code: 'MENU_IMAGES_TOO_LARGE' });
  assert.equal(checks, 0); assert.equal(calls, 0);
});

test('非法图片和 mime 不匹配均在计量 hook 之前拒绝', async t => {
  let checks = 0, calls = 0;
  const hook = async () => { checks++; };
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(menu, usage); });
  await assert.rejects(recognizeMenuImages(config, [{ bytes: Buffer.from('非图片'), mime_type: 'image/png' }], hook), { code: 'MENU_SOURCE_UNAVAILABLE' });
  await assert.rejects(recognizeMenuImages(config, [{ bytes: await image(), mime_type: 'image/jpeg' }], hook), { code: 'MENU_SOURCE_UNAVAILABLE' });
  await assert.rejects(recognizeMenuImages(config, [], hook), { code: 'MENU_IMAGES_TOO_LARGE' });
  assert.equal(checks, 0); assert.equal(calls, 0);
});

test('发送 hook 拒绝不会 fetch，也不会被包装成提供方失败', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(chat, usage); });
  await assert.rejects(callWebsiteAgent(config, [], snapshot, async () => { throw new ApiError(503, 'JOB_INTERRUPTED'); }), { code: 'JOB_INTERRUPTED' });
  assert.equal(calls, 0);
});

test('usage 未知且输出失败不附假 usage，HTTP 与网络错误只返回安全信息', async t => {
  let mode = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (mode === 1) return new Response('fixture-private-provider-key 不应输出的供应商正文', { status: 402 });
    if (mode === 2) throw Object.assign(new Error('fixture-private-provider-key'), { usage });
    return response({ reply: '', design_brief: '' }, { ...usage, total_tokens: 36 });
  });
  for (const code of ['AI_OUTPUT_INVALID', 'AI_BALANCE_INSUFFICIENT', 'AI_PROVIDER_UNAVAILABLE']) {
    await assert.rejects(callWebsiteAgent(config, [], snapshot), error => {
      assert.ok(error instanceof ApiError); assert.equal(error.code, code);
      assert.equal(Object.hasOwn(error, 'usage'), false);
      assert.ok(!JSON.stringify(error).includes(config.website!.apiKey!));
      return true;
    });
    mode++;
  }
});

test('tools 总量小于或大于两项之和均拒绝，不附伪有效 usage', async t => {
  let rawUsage: unknown;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ usage: rawUsage,
    choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [] } }] }), { status: 200 }));
  for (rawUsage of [undefined, { ...usage, total_tokens: 34 }, { ...usage, total_tokens: 36 }, { ...usage, completion_tokens: '10' }]) {
    await assert.rejects(callWebsiteTools(config, [{ role: 'user', content: '生成页面' }], websiteAgentTools), error => {
      assert.ok(error instanceof ApiError); assert.equal(error.code, 'AI_USAGE_UNAVAILABLE');
      assert.equal(Object.hasOwn(error, 'usage'), false);
      return true;
    });
  }
  rawUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  assert.deepEqual((await callWebsiteTools(config, [{ role: 'user', content: '生成页面' }], websiteAgentTools)).usage, rawUsage);
});

test('tools 协议错误仍保留经过严格校验的 known usage', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ usage: { ...usage, private: '不应输出的供应商正文' },
    choices: [{ finish_reason: 'length', message: { tool_calls: [] } }] }), { status: 200 }));
  await assert.rejects(callWebsiteTools(config, [{ role: 'user', content: '生成页面' }], websiteAgentTools),
    error => knownError(error, 'AI_OUTPUT_TRUNCATED'));
});

test('tools 同步预检复用配置、固定路径、options、取消及视觉校验；本地拒绝零 fetch', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('本地预检不得发送'); });
  const messages: WebsiteToolMessage[] = [{ role: 'user', content: '生成页面' }];
  const tools = structuredClone(websiteAgentTools), before = structuredClone({ config, messages, tools });
  const prepared = prepareWebsiteToolRequest(config, messages, tools);
  assert.deepEqual(Object.keys(prepared), ['value', 'body']);
  assert.equal(prepared.value, config.website);
  assert.ok(!prepared.body.includes(config.website!.apiKey!));
  assert.deepEqual(JSON.parse(prepared.body), { model: 'deepseek-flash', messages, tools, tool_choice: 'auto',
    parallel_tool_calls: false, thinking: { type: 'disabled' }, max_tokens: 16000, temperature: 0.3, stream: false });
  const configs = [
    { value: { ...config, website: undefined }, code: 'AI_NOT_CONFIGURED' },
    { value: { ...config, website: { ...config.website!, apiKey: undefined } }, code: 'AI_NOT_CONFIGURED' },
    ...['https://api.deepseek.com/chat/completions', 'https://api.deepseek.com/', 'https://api.deepseek.com?fixture=1',
      'https://fixture.invalid'].map(baseUrl => ({ value: { ...config, website: { ...config.website!, baseUrl } }, code: 'AI_CONFIGURATION_INVALID' })),
    { value: { ...config, website: { ...config.website!, model: 'invalid-fixture-model' } }, code: 'AI_CONFIGURATION_INVALID' },
  ];
  for (const entry of configs) {
    assert.throws(() => prepareWebsiteToolRequest(entry.value, messages, tools), { code: entry.code });
    await assert.rejects(callWebsiteTools(entry.value, messages, tools), { code: entry.code });
    const observations: WebsiteAgentObservation[] = [];
    await assert.rejects(runWebsiteAgent(entry.value, '清爽布局', snapshot, async obs => { observations.push(obs); }), { code: entry.code });
    assert.deepEqual(observations.map(obs => obs.event.action), ['agent_failed']);
    assert.equal(observations[0]!.progress.model_calls, 0);
    assert.ok(!JSON.stringify(observations).includes(config.website!.apiKey!));
  }
  for (const options of [
    { maxTokens: 0, timeoutMs: 75000 }, { maxTokens: 16001, timeoutMs: 75000 }, { maxTokens: 1.5, timeoutMs: 75000 },
    { maxTokens: 16000, timeoutMs: 0 }, { maxTokens: 16000, timeoutMs: 75001 }, { maxTokens: 16000, timeoutMs: NaN },
  ]) {
    assert.throws(() => prepareWebsiteToolRequest(config, messages, tools, options), { code: 'AI_CONFIGURATION_INVALID' });
    await assert.rejects(callWebsiteTools(config, messages, tools, options), { code: 'AI_CONFIGURATION_INVALID' });
  }
  const controller = new AbortController(); controller.abort();
  const options = { maxTokens: 16000, timeoutMs: 75000, signal: controller.signal };
  assert.throws(() => prepareWebsiteToolRequest(config, messages, tools, options), { code: 'AGENT_CANCELLED' });
  await assert.rejects(callWebsiteTools(config, messages, tools, options), { code: 'AGENT_CANCELLED' });
  const cancelled: WebsiteAgentObservation[] = [];
  await assert.rejects(runWebsiteAgent(config, '清爽布局', snapshot, async obs => { cancelled.push(obs); }, callWebsiteTools, controller.signal), { code: 'AGENT_CANCELLED' });
  assert.ok(cancelled.every(obs => !obs.event.model_call && obs.progress.model_calls === 0));
  const invalidVision: WebsiteToolMessage[] = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'original' } }] }];
  assert.throws(() => prepareWebsiteToolRequest(config, invalidVision, tools), { code: 'WEBSITE_VISION_INVALID' });
  await assert.rejects(callWebsiteTools(config, invalidVision, tools), { code: 'WEBSITE_VISION_INVALID' });
  assert.equal(calls, 0);
  assert.deepEqual({ config, messages, tools }, before);
});

test('tools 完整 payload 精确字节边界含外壳：旧预算能通过的请求仍在 fetch 前拒绝', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('超限不得发送'); });
  const tools = structuredClone(websiteAgentTools);
  const messages: WebsiteToolMessage[] = [{ role: 'user', content: '' }];
  const empty = JSON.parse(prepareWebsiteToolRequest(config, messages, tools).body);
  messages[0]!.content = 'x'.repeat(websiteVisionLimits.textBytes - requestTextBytes(empty));
  const before = structuredClone({ messages, tools });
  const exact = prepareWebsiteToolRequest(config, messages, tools);
  assert.equal(requestTextBytes(JSON.parse(exact.body)), websiteVisionLimits.textBytes);
  assert.ok(requestTextBytes({ messages, tools }) < websiteVisionLimits.textBytes);
  assert.deepEqual({ messages, tools }, before);
  messages[0]!.content += 'x';
  assert.ok(requestTextBytes({ messages, tools }) < websiteVisionLimits.textBytes);
  assert.throws(() => prepareWebsiteToolRequest(config, messages, tools), { code: 'AGENT_STEP_LIMIT' });
  await assert.rejects(callWebsiteTools(config, messages, tools), { code: 'AGENT_STEP_LIMIT' });
  messages[0]!.content = 'x'.repeat(websiteVisionLimits.textBytes - requestTextBytes({ messages: [{ role: 'user', content: '' }], tools }));
  assert.equal(requestTextBytes({ messages, tools }), websiteVisionLimits.textBytes);
  assert.throws(() => prepareWebsiteToolRequest(config, messages, tools), { code: 'AGENT_STEP_LIMIT' });
  await assert.rejects(callWebsiteTools(config, messages, tools), { code: 'AGENT_STEP_LIMIT' });
  assert.equal(calls, 0);
});

test('ReAct 大快照使后续完整请求超限：保留注入预算兼容，真实 exchange 在第二次 started 前拒绝', async t => {
  t.mock.method(Date, 'now', () => 123456);
  const readContext = { message: { role: 'assistant' as const, content: null, tool_calls: [
    { id: 'context_1', type: 'function' as const, function: { name: 'read_context', arguments: '{}' } },
  ] }, usage };
  async function secondInput(value: WebsiteSnapshot): Promise<WebsiteToolMessage[]> {
    let exchanges = 0, captured: WebsiteToolMessage[] | undefined;
    await assert.rejects(runWebsiteAgent(config, '清爽布局', value, async () => undefined, async (_config, messages) => {
      if (++exchanges === 1) return structuredClone(readContext);
      captured = structuredClone(messages);
      throw new ApiError(503, 'FIXTURE_STOP');
    }), { code: 'FIXTURE_STOP' });
    assert.equal(exchanges, 2);
    return captured!;
  }
  const small = structuredClone(snapshot); small.restaurant.description = 'x';
  const baseMessages = await secondInput(small);
  const large = structuredClone(small);
  large.restaurant.description = 'x'.repeat(1 + websiteVisionLimits.textBytes - requestTextBytes({ messages: baseMessages, tools: websiteAgentTools }));
  const largeBefore = structuredClone(large), toolsBefore = structuredClone(websiteAgentTools);
  const borderMessages = await secondInput(large);
  assert.equal(requestTextBytes({ messages: borderMessages, tools: websiteAgentTools }), websiteVisionLimits.textBytes);
  assert.throws(() => prepareWebsiteToolRequest(config, borderMessages, websiteAgentTools), { code: 'AGENT_STEP_LIMIT' });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    assert.equal(calls, 1, '超限的第二次请求不得发送');
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: readContext.message }], usage }), { status: 200 });
  });
  const observations: WebsiteAgentObservation[] = [];
  await assert.rejects(runWebsiteAgent(config, '清爽布局', large, async obs => { observations.push(obs); }, callWebsiteTools), { code: 'AGENT_STEP_LIMIT' });
  assert.equal(calls, 1);
  assert.equal(observations.filter(obs => obs.event.action === 'model_call_started').length, 1);
  assert.equal(observations.filter(obs => obs.event.action === 'model_call_completed').length, 1);
  assert.equal(observations.filter(obs => obs.event.action === 'model_call_failed').length, 0);
  assert.equal(observations.at(-1)!.event.action, 'agent_failed');
  assert.equal(observations.at(-1)!.progress.model_calls, 1);
  assert.deepEqual(large, largeBefore);
  assert.deepEqual(websiteAgentTools, toolsBefore);
});

test('ReAct started 回调中取消后第二次预检拒绝，零 fetch 且不附私密请求字段', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('已取消不得发送'); });
  const controller = new AbortController(), observations: WebsiteAgentObservation[] = [];
  await assert.rejects(runWebsiteAgent(config, '清爽布局', snapshot, async obs => {
    observations.push(obs);
    if (obs.event.action === 'model_call_started') controller.abort();
  }, callWebsiteTools, controller.signal), { code: 'AGENT_CANCELLED' });
  assert.equal(calls, 0);
  assert.equal(observations.filter(obs => obs.event.action === 'model_call_started').length, 1);
  assert.equal(observations.filter(obs => obs.event.action === 'model_call_failed').length, 1);
  assert.ok(!JSON.stringify(observations).includes(config.website!.apiKey!));
  assert.ok(observations.every(obs => !Object.hasOwn(obs.event, 'body') && !Object.hasOwn(obs.event, 'value')));
});
