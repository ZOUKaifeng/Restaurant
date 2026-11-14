import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Config } from '../src/config.js';
import { callWebsiteTools } from '../src/deepseek.js';
import { websiteAgentContract, websiteAgentTools } from '../src/website-agent-capabilities.js';
const config = { website: { apiKey: 'fixture-not-a-real-key', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' } } as Config;
const usage = { prompt_tokens: 60, completion_tokens: 10, total_tokens: 70 };
test('原生函数工具接口：响应只返回调用和真实用量，不包含reasoning或密钥', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, request: RequestInit) => {
    const sent = JSON.parse(request.body as string);
    assert.equal(sent.model, 'deepseek-flash'); assert.equal(sent.thinking.type, 'disabled');
    assert.equal(sent.response_format, undefined); assert.equal(sent.tools.length, 5); assert.equal(sent.max_tokens, 1000);
    assert.ok(!JSON.stringify(sent).includes('fixture-not-a-real-key'));
    assert.equal(request.redirect, 'error');
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { reasoning_content: 'hidden internal trace', content: 'Not returned', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_context', arguments: '{}' } }] } }], usage }), { status: 200 });
  });
  const result = await callWebsiteTools(config, [{ role: 'user', content: '生成页面' }], websiteAgentTools, { maxTokens: 1000, timeoutMs: 5000 });
  assert.equal(result.message.content, null); assert.deepEqual(result.usage, usage); assert.equal(result.message.tool_calls[0]!.function.name, 'read_context');
  assert.ok(!JSON.stringify(result).includes('hidden internal trace'));
});
test('缺少用量、截断工具JSON和402必须停止，不用0用量或自动重试', async t => {
  let calls = 0, mode = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (mode === 2) return new Response('private provider text', { status: 402 });
    return new Response(JSON.stringify({ choices: [{ finish_reason: mode === 1 ? 'length' : 'tool_calls', message: { tool_calls: [] } }] }), { status: 200 });
  });
  await assert.rejects(callWebsiteTools(config, [{ role: 'user', content: '页面' }], websiteAgentTools), { code: 'AI_USAGE_UNAVAILABLE' });
  mode = 1; await assert.rejects(callWebsiteTools(config, [{ role: 'user', content: '页面' }], websiteAgentTools), { code: 'AI_OUTPUT_TRUNCATED' });
  mode = 2; await assert.rejects(callWebsiteTools(config, [{ role: 'user', content: '页面' }], websiteAgentTools), { code: 'AI_BALANCE_INSUFFICIENT' });
  assert.equal(calls, 3);
});
test('模型能力契约明示商家接口不是公开授权，顾客业务仍未实现', () => {
  const contract = websiteAgentContract as { available_model_tools: string[]; backend_status: { unavailable_features: string[] }; publish_authority: string; components: Record<string, string> };
  assert.deepEqual(contract.available_model_tools, websiteAgentTools.map(tool => tool.function.name));
  assert.ok(contract.backend_status.unavailable_features.some(feature => feature.startsWith('Customer reservation')));
  assert.ok(contract.publish_authority.includes('Only merchant'));
  // 订位入口必须由模型默认使用固定组件，而不是自由生成表单或接口调用。
  assert.match(contract.components['restaurant-reservation'] ?? '', /reservation_enabled/);
  assert.match(contract.components['restaurant-reservation'] ?? '', /<restaurant-reservation>/);
  for (const tool of websiteAgentTools) assert.equal(tool.function.parameters.additionalProperties, false);
});
