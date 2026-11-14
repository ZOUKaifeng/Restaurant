import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { Config } from '../src/config.js';
import { ApiError } from '../src/errors.js';
import { runWebsiteAgent } from '../src/website-react.js';
import { renderWebsite, type WebsiteSnapshot } from '../src/website-html.js';
import { websiteAgentTools } from '../src/website-agent-capabilities.js';
import type { WebsiteAgentObservation, WebsiteToolCall, WebsiteToolExchange, WebsiteToolMessage } from '../src/website-agent-types.js';

const config = { website: { apiKey: 'never-send-fixture-key', model: 'deepseek-flash' } } as Config;
const snapshot: WebsiteSnapshot = {
  restaurant: { id: 'rst_fixture', name: '真实餐厅', description: '真实介绍', cuisine_type: null, address_line1: null,
    address_line2: null, city: null, region: null, postal_code: null, country_code: null, contact_email: null,
    contact_phone: null, timezone: null, currency: null, primary_locale: 'zh-CN' },
  opening_hours: [], assets: [],
};
const draft = {
  html_body: '<main><h1><restaurant-name></restaurant-name></h1><restaurant-description></restaurant-description><restaurant-address></restaurant-address><restaurant-contact></restaurant-contact><restaurant-hours></restaurant-hours><restaurant-menu></restaurant-menu></main>',
  css: 'main{padding:2rem;color:#234}', summary: '真实餐厅官网',
};
const badDraft = { ...draft, html_body: '<main>\n<script>不允许的内容</script>\n</main>' };
const plan = (status = 'pending') => ({ items: [{ id: 'layout', title: '布局与真实校验', status }] });
let sequence = 0;
function call(name: string, args: unknown = {}): WebsiteToolCall {
  return { id: `call_${++sequence}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}
function response(calls: WebsiteToolCall[], total = 3): WebsiteToolExchange {
  return { message: { role: 'assistant', content: '不得显示的模型正文', tool_calls: calls }, usage: { prompt_tokens: total - 2, completion_tokens: 2, total_tokens: total } };
}
function executionState(messages: WebsiteToolMessage[]) {
  assert.ok(messages.length >= 4);
  assert.equal(messages[2]!.role, 'user');
  const state = JSON.parse(messages[2]!.content!);
  assert.ok(state.last_observations.every((item: Record<string, unknown>) =>
    Object.keys(item).every(key => ['tool_name', 'ok', 'code'].includes(key))));
  return state;
}
function toolResults(messages: WebsiteToolMessage[]): Array<{ id: string; name: string; value: Record<string, any> }> {
  const assistant = messages[3];
  assert.ok(assistant?.role === 'assistant');
  assert.equal(messages.length, 4 + assistant.tool_calls.length);
  assert.equal(messages.at(-1)!.role, 'tool');
  return messages.slice(4).map((message, index) => {
    assert.ok(message.role === 'tool');
    const call = assistant.tool_calls[index]!;
    assert.equal(message.tool_call_id, call.id);
    return { id: message.tool_call_id, name: call.function.name, value: JSON.parse(message.content) };
  });
}
function script(rounds: WebsiteToolCall[][], check?: (messages: WebsiteToolMessage[], index: number) => void): NonNullable<Parameters<typeof runWebsiteAgent>[4]> {
  let index = 0, roots: WebsiteToolMessage[] | undefined;
  return async (_config, messages, tools, options) => {
    roots ??= structuredClone(messages.slice(0, 2));
    assert.deepEqual(messages.slice(0, 2), roots);
    if (index > 0) {
      executionState(messages);
      const assistant = messages[3];
      assert.ok(assistant?.role === 'assistant');
      assert.deepEqual(assistant.tool_calls, rounds[index - 1]);
      assert.equal(assistant.content, null);
      toolResults(messages);
    }
    check?.(messages, index);
    assert.deepEqual(tools, websiteAgentTools);
    const reserve = Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8') + 1024;
    assert.equal(options?.maxTokens, Math.min(8000, 60000 - index * 3 - reserve));
    assert.ok(options!.timeoutMs > 0 && options!.timeoutMs <= 75000);
    assert.ok(Buffer.byteLength(JSON.stringify(messages), 'utf8') <= 1024 * 1024);
    assert.ok(index < rounds.length, '不应额外调用模型');
    return response(rounds[index++]!);
  };
}
const collect = (events: WebsiteAgentObservation[]) => async (event: WebsiteAgentObservation) => { events.push(structuredClone(event)); };

test('native 工具自主计划、无效草稿、真实诊断、修复、全部完成与确定性 checksum', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('工具环路测试不能调用真实网络'));
  const rounds = [
    [call('update_plan', plan()), call('read_context'), call('write_draft', badDraft), call('validate_draft')],
    [call('read_context'), call('write_draft', draft), call('validate_draft'), call('update_plan', plan('completed'))],
    [call('finish')],
  ];
  const events: WebsiteAgentObservation[] = [];
  const source = structuredClone(snapshot);
  const result = await runWebsiteAgent(config, '真实需求', source, collect(events), script(rounds, (messages, index) => {
    assert.ok(!JSON.stringify(messages).includes(config.website!.apiKey!));
    assert.ok(!JSON.stringify(messages).includes('不得显示的模型正文'));
    if (index === 1) {
      const results = toolResults(messages);
      assert.deepEqual(results.map(item => item.id), rounds[0]!.map(item => item.id));
      const invalid = results.at(-1)!.value;
      assert.equal(executionState(messages).current_draft, undefined);
      assert.deepEqual(JSON.parse(rounds[0]![2]!.function.arguments), badDraft);
      assert.deepEqual(executionState(messages).current_validation, { draft_revision: 1, valid: false });
      assert.equal(executionState(messages).current_validation_passed, false);
      assert.equal(executionState(messages).facts, undefined);
      assert.equal(executionState(messages).capabilities, undefined);
      assert.equal(executionState(messages).context_loaded, true);
      assert.equal(results.find(item => item.name === 'read_context')!.value.facts.restaurant.name, '真实餐厅');
      assert.equal(invalid.ok, false); assert.ok(invalid.diagnostics.length > 0 && invalid.diagnostics.length <= 20);
      for (const diagnostic of invalid.diagnostics) {
        assert.ok(['index.html', 'styles.css', 'assets', 'agent'].includes(diagnostic.file));
        assert.ok(Number.isInteger(diagnostic.line) && diagnostic.line >= 1);
        assert.ok(Number.isInteger(diagnostic.column) && diagnostic.column >= 1);
        assert.equal(typeof diagnostic.code, 'string');
      }
      source.restaurant.name = '中途篡改不生效';
    }
    if (index === 2) {
      const results = toolResults(messages);
      assert.deepEqual(results.map(item => item.id), rounds[1]!.map(item => item.id));
      assert.equal(executionState(messages).facts, undefined);
      assert.equal(executionState(messages).capabilities, undefined);
      assert.equal(executionState(messages).context_loaded, true);
      assert.equal(results.find(item => item.name === 'read_context')!.value.facts.restaurant.name, '真实餐厅');
      assert.equal(results[2]!.value.ok, true);
      assert.equal(executionState(messages).current_validation_passed, true);
    }
  }));
  assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 6, total_tokens: 9 });
  assert.equal(result.progress.phase, 'ready'); assert.equal(result.progress.round, 2); assert.equal(result.progress.model_calls, 3);
  assert.deepEqual({ html: result.html, checksum: result.checksum }, renderWebsite(draft, snapshot));
  assert.equal(createHash('sha256').update(result.html).digest('hex'), result.checksum);
  assert.ok(result.html.includes('真实餐厅') && !result.html.includes('中途篡改'));
  const phases = events.map(event => event.progress.phase);
  for (const phase of ['planning', 'writing', 'checking', 'repairing', 'ready']) assert.ok(phases.includes(phase as typeof phases[number]));
  assert.deepEqual(events[0]!.progress.plan, []);
  assert.equal(events.find(event => event.event.action === 'update_plan')!.progress.round, 0);
  assert.equal(events.find(event => event.draft)!.progress.round, 1);
  assert.ok(events.filter(event => event.draft).every(event => event.event.action === 'write_draft'));
  assert.ok(events.every(event => !JSON.stringify(event.progress).includes('html_body')));
  assert.ok(!JSON.stringify(events).includes('不得显示的模型正文'));
  assert.deepEqual(events.filter(event => event.event.action === 'model_call_started').map(event => event.progress.total_tokens), [0, 3, 6]);
});

test('未知工具、非法 JSON 和额外参数只返回绑定 id 的 toolerror，下一轮可以修正', async () => {
  const malformed = call('update_plan'); malformed.function.arguments = '{非法';
  const attempts = [call('browser'), malformed, call('read_context', { apiKey: '禁止读取' }), call('write_draft', draft)];
  const events: WebsiteAgentObservation[] = [];
  const result = await runWebsiteAgent(config, '需求', snapshot, collect(events), script([
    attempts,
    [call('update_plan', plan('completed')), call('write_draft', draft), call('validate_draft'), call('finish')],
  ], (messages, index) => {
    if (index === 1) {
      const results = toolResults(messages);
      assert.deepEqual(results.map(item => item.id), attempts.map(item => item.id));
      assert.deepEqual(results.map(item => item.name), attempts.map(item => item.function.name));
      assert.deepEqual(results.map(item => item.value.error.code), ['AGENT_TOOL_UNKNOWN', 'TOOL_ARGUMENTS_INVALID', 'TOOL_ARGUMENTS_INVALID', 'AGENT_PLAN_REQUIRED']);
      assert.equal(executionState(messages).context_required, true);
      assert.equal(executionState(messages).facts, undefined);
      assert.equal(executionState(messages).capabilities, undefined);
      assert.equal(executionState(messages).current_draft, null);
    }
  }));
  assert.equal(result.progress.phase, 'ready');
  assert.equal(events.filter(event => event.event.status === 'error').length, 4);
});

test('草稿必须先真实校验且 plan 完成；check 后更新 plan 不使已校验草稿失效', async () => {
  const result = await runWebsiteAgent(config, '需求', snapshot, async () => {}, script([
    [call('update_plan', plan()), call('write_draft', draft), call('finish'), call('validate_draft')],
    [call('finish')],
    [call('update_plan', plan('completed')), call('finish')],
  ], (messages, index) => {
    if (index === 1) assert.equal(toolResults(messages)[2]!.value.error.code, 'AGENT_VALIDATION_REQUIRED');
    if (index === 2) {
      assert.equal(toolResults(messages)[0]!.value.error.code, 'AGENT_PLAN_INCOMPLETE');
      assert.equal(executionState(messages).current_validation_passed, true);
      assert.equal(executionState(messages).execution_state.plan[0].status, 'pending');
    }
  }));
  assert.equal(result.progress.phase, 'ready');
});

test('新的 draft revision 不能复用旧校验', async () => {
  const result = await runWebsiteAgent(config, '需求', snapshot, async () => {}, script([
    [call('update_plan', plan('completed')), call('write_draft', draft), call('validate_draft')],
    [call('write_draft', draft), call('finish'), call('validate_draft'), call('finish')],
  ]));
  assert.equal(result.progress.round, 2);
});

test('纯正文或普通 JSON 不可伪装工具完成，也不产生假计划', async () => {
  const events: WebsiteAgentObservation[] = []; let calls = 0;
  await assert.rejects(runWebsiteAgent(config, '需求', snapshot, collect(events), async (_config, messages) => {
    if (calls > 0) {
      const state = executionState(messages);
      assert.deepEqual(state.last_observations, [{ tool_name: 'model_response', ok: false, code: 'AGENT_TOOL_REQUIRED' }]);
      assert.equal(messages.length, 4);
      assert.equal(messages[3]!.role, 'user');
      assert.equal(messages[3]!.content, '必须选择提供的原生函数工具。普通正文或 JSON 不能完成任务。请继续工具调用。');
      assert.ok(messages.every(message => message.role === 'system' || message.role === 'user'));
      assert.ok(!JSON.stringify(messages).includes('{"finish":true,"valid":true}'));
    }
    calls++; return { ...response([]), message: { role: 'assistant', content: '{"finish":true,"valid":true}', tool_calls: [] } };
  }), { code: 'AGENT_STEP_LIMIT' });
  assert.equal(calls, 12); assert.ok(events.every(event => event.progress.plan.length === 0));
  assert.equal(events.filter(event => event.event.action === 'model_response').length, 12);
  assert.equal(events.at(-1)!.progress.phase, 'failed');
});

test('最多4次写草稿，拒绝第五次并保留最近真实诊断', async () => {
  const events: WebsiteAgentObservation[] = [];
  await assert.rejects(runWebsiteAgent(config, '需求', snapshot, collect(events), script([
    [call('update_plan', plan()), call('write_draft', badDraft), call('validate_draft')],
    [call('write_draft', badDraft), call('validate_draft'), call('write_draft', badDraft), call('validate_draft')],
    [call('write_draft', badDraft), call('validate_draft'), call('write_draft', draft)],
  ])), { code: 'AGENT_REPAIR_LIMIT' });
  assert.equal(events.filter(event => event.draft).length, 4);
  assert.equal(events.at(-1)!.progress.round, 4);
  const latest = events.filter(event => event.event.action === 'validate_draft').at(-1)!;
  assert.deepEqual(events.at(-1)!.progress.diagnostics, latest.progress.diagnostics);
  assert.equal(events.at(-1)!.progress.phase, 'failed');
});

test('每响应最多4工具，全程最多24动作，达到预算不再调用模型', async () => {
  for (const mode of ['batch', 'total']) {
    let calls = 0; const events: WebsiteAgentObservation[] = [];
    await assert.rejects(runWebsiteAgent(config, '需求', snapshot, collect(events), async () => {
      calls++; return response(Array.from({ length: mode === 'batch' ? 5 : 4 }, () => call('read_context')));
    }), { code: 'AGENT_STEP_LIMIT' });
    assert.equal(calls, mode === 'batch' ? 1 : 6);
    assert.equal(events.filter(event => event.event.action === 'read_context').length, mode === 'batch' ? 0 : 24);
  }
});

test('每轮按 UTF8 {messages,tools} 字节加1024预留输入，输出取余额且 usage 真正累计', async () => {
  const events: WebsiteAgentObservation[] = []; let calls = 0, used = 0;
  const outputs: number[] = [];
  await assert.rejects(runWebsiteAgent(config, '需求', snapshot, collect(events), async (_config, messages, tools, options) => {
    calls++;
    const reserve = Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8') + 1024;
    const max = Math.min(8000, 60000 - used - reserve);
    assert.ok(max > 0); assert.equal(options?.maxTokens, max);
    outputs.push(max);
    used += 1 + max;
    return { ...response([call('read_context')]), usage: { prompt_tokens: 1, completion_tokens: max, total_tokens: 1 + max } };
  }), { code: 'AGENT_TOKEN_LIMIT' });
  assert.ok(calls > 1 && calls < 12); assert.ok(outputs.at(-1)! < 8000);
  assert.ok(used < 60000); assert.equal(events.at(-1)!.progress.total_tokens, used);
  assert.equal(events.filter(event => event.event.action === 'model_call_started').length, calls);
});

test('剩余预算不够预留实际输入时，首次或下一轮都不外发也不虚增 model_calls', async () => {
  let calls = 0;
  const events: WebsiteAgentObservation[] = [];
  await assert.rejects(runWebsiteAgent(config, 'b'.repeat(65000), snapshot, collect(events), async () => {
    calls++; return response([]);
  }), { code: 'AGENT_TOKEN_LIMIT' });
  assert.equal(calls, 0); assert.equal(events.at(-1)!.progress.model_calls, 0);
  assert.equal(events.some(event => event.event.action === 'model_call_started'), false);
  let used = 0;
  events.length = 0;
  await assert.rejects(runWebsiteAgent(config, 'b'.repeat(45000), snapshot, collect(events), async (_config, messages, tools, options) => {
    calls++;
    const reserve = Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8') + 1024;
    assert.equal(options?.maxTokens, Math.min(8000, 60000 - reserve));
    used = reserve;
    return { ...response([call('read_context')]), usage: { prompt_tokens: reserve - 1, completion_tokens: 1, total_tokens: reserve } };
  }), { code: 'AGENT_TOKEN_LIMIT' });
  assert.equal(calls, 1); assert.equal(events.at(-1)!.progress.model_calls, 1);
  assert.equal(events.at(-1)!.progress.total_tokens, used);
  assert.equal(events.filter(event => event.event.action === 'model_call_started').length, 1);
});

test('provider 超出预留输入、输出或总额时，保存真实 usage 并停止，不执行返回工具或重试', async () => {
  for (const mode of ['input', 'output', 'total']) {
    let calls = 0, total = 0; const events: WebsiteAgentObservation[] = [];
    await assert.rejects(runWebsiteAgent(config, '需求', snapshot, collect(events), async (_config, messages, tools, options) => {
      calls++;
      const reserve = Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8') + 1024;
      const prompt = mode === 'input' ? reserve + 1 : 1;
      const completion = mode === 'output' ? options!.maxTokens + 1 : 1;
      total = mode === 'total' ? reserve + options!.maxTokens + 1 : prompt + completion;
      return { ...response([call('write_draft', draft)]), usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total } };
    }), { code: 'AGENT_TOKEN_LIMIT' });
    assert.equal(calls, 1); assert.equal(events.at(-1)!.progress.total_tokens, total);
    assert.equal(events.filter(event => event.event.action === 'write_draft').length, 0);
  }
});

test('缺失、不完整、非法或矛盾 usage 都终止，不以零或推测 token 代替真实用量', async () => {
  for (const usage of [undefined, {}, { prompt_tokens: 1, completion_tokens: 2 },
    { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 },
    { prompt_tokens: 1.5, completion_tokens: 2, total_tokens: 3.5 },
    { prompt_tokens: 1, completion_tokens: 2, total_tokens: 2 }]) {
    let calls = 0; const events: WebsiteAgentObservation[] = [];
    await assert.rejects(runWebsiteAgent(config, '需求', snapshot, collect(events), async () => {
      calls++; return { ...response([call('read_context')]), usage } as WebsiteToolExchange;
    }), { code: 'AI_USAGE_UNAVAILABLE' });
    assert.equal(calls, 1); assert.equal(events.at(-1)!.progress.total_tokens, 0);
    assert.equal(events.at(-1)!.event.message, 'AI_USAGE_UNAVAILABLE');
    assert.equal(events.some(event => event.event.action === 'read_context'), false);
  }
});

test('墙钟8分钟硬限制，在观察授权之后再次检查，不发过时模型请求', async t => {
  let now = 0, calls = 0;
  t.mock.method(Date, 'now', () => now);
  const events: WebsiteAgentObservation[] = [];
  await assert.rejects(runWebsiteAgent(config, '需求', snapshot, async event => {
    events.push(event); if (event.event.action === 'model_call_started') now = 8 * 60 * 1000;
  }, async () => { calls++; return response([]); }), { code: 'AGENT_TIME_LIMIT' });
  assert.equal(calls, 0); assert.equal(events.at(-1)!.progress.phase, 'failed');
});

test('消息 UTF8 上限1MiB，超限不发任何外部请求', async () => {
  let calls = 0;
  await assert.rejects(runWebsiteAgent(config, '中'.repeat(400000), snapshot, async () => {}, async () => {
    calls++; return response([]);
  }), { code: 'AGENT_STEP_LIMIT' });
  assert.equal(calls, 0);
});

test('HTTP402/401/429/timeout/Node异常终止而不盲重试，异常原文不进入观察', async () => {
  for (const [error, code] of [
    [Object.assign(new Error('敏感正文'), { status: 402 }), 'AI_BALANCE_INSUFFICIENT'],
    [Object.assign(new Error('敏感正文'), { status: 401 }), 'AI_AUTH_FAILED'],
    [Object.assign(new Error('敏感正文'), { status: 429 }), 'AI_RATE_LIMITED'],
    [new ApiError(503, 'AI_TIMEOUT'), 'AI_TIMEOUT'],
    [new ApiError(503, 'AI_USAGE_UNAVAILABLE'), 'AI_USAGE_UNAVAILABLE'],
    [new ApiError(503, 'AI_OUTPUT_TRUNCATED'), 'AI_OUTPUT_TRUNCATED'],
    [new Error('敏感正文'), 'AI_PROVIDER_UNAVAILABLE'],
  ] as const) {
    let calls = 0; const events: WebsiteAgentObservation[] = [];
    await assert.rejects(runWebsiteAgent(config, '需求', snapshot, collect(events), async () => { calls++; throw error; }), { code });
    assert.equal(calls, 1); assert.equal(events.at(-1)!.progress.phase, 'failed');
    assert.ok(!JSON.stringify(events).includes('敏感正文'));
  }
});

test('model_call_started 观察拒绝授权时不发送外部请求', async () => {
  let calls = 0;
  await assert.rejects(runWebsiteAgent(config, '需求', snapshot, async () => { throw new ApiError(503, 'WEBSITE_CONTEXT_REVOKED'); }, async () => {
    calls++; return response([]);
  }), { code: 'WEBSITE_CONTEXT_REVOKED' });
  assert.equal(calls, 0);
});

test('工具 schema 禁止未知属性，plan 严格枚举、长度、id 与用户字符串规范化', async () => {
  for (const tool of websiteAgentTools) assert.equal(tool.function.parameters.additionalProperties, false);
  const invalid = [
    { items: [{ id: 'layout', title: '任务', status: 'done' }] },
    { items: [{ id: '../file', title: '任务', status: 'pending' }] },
    { items: [{ id: 'layout', title: '长'.repeat(151), status: 'pending' }] },
    { items: Array.from({ length: 13 }, (_, index) => ({ id: `item${index}`, title: '任务', status: 'pending' })) },
  ];
  const events: WebsiteAgentObservation[] = [];
  const result = await runWebsiteAgent(config, '需求', snapshot, collect(events), script([
    invalid.map(item => call('update_plan', item)),
    [call('update_plan', { items: [{ id: 'layout', title: ' 布局\n\u202e真实校验 ', status: 'completed' }] }), call('write_draft', draft), call('validate_draft'), call('finish')],
  ]));
  assert.equal(events.filter(event => event.event.status === 'error').length, 4);
  assert.equal(result.progress.plan[0]!.title, '布局 真实校验');
});

test('read_context 只暴露真实公开事实和能力，不含内部菜单 warnings/review_note 或配置密钥', async () => {
  const withMenu: WebsiteSnapshot = { ...snapshot, menu: { revision: 2, data: {
    warnings: ['内部警告不得发送给模型'], categories: [{ name: '真实菜单', items: [{ name: '真实菜品',
      description: '人工确认介绍', price_text: '€ 12,50', review_note: '内部复核备注不得发送给模型' }] }],
  } } };
  const result = await runWebsiteAgent(config, '需求', withMenu, async () => {}, script([
    [call('read_context')],
    [call('update_plan', plan('completed')), call('write_draft', draft), call('validate_draft'), call('finish')],
  ], (messages, index) => {
    if (index === 1) {
      const state = executionState(messages);
      assert.equal(state.context_loaded, true);
      assert.equal(state.facts, undefined); assert.equal(state.capabilities, undefined);
      const context = toolResults(messages)[0]!.value;
      assert.deepEqual(state.last_observations, [{ tool_name: 'read_context', ok: true }]);
      assert.ok(context.capabilities && typeof context.capabilities.contract_version === 'string');
      assert.equal(context.facts.menu.revision, 2);
      assert.equal(context.facts.menu.data.categories[0].items[0].price_text, '€ 12,50');
      const encoded = JSON.stringify(context.facts);
      for (const forbidden of ['warnings', 'review_note', '内部警告', '内部复核备注']) assert.ok(!encoded.includes(forbidden));
      assert.ok(!JSON.stringify(context).includes(config.website!.apiKey!));
    }
  }));
  assert.ok(result.html.includes('真实菜品') && result.html.includes('€ 12,50'));
});

test('草稿 HTML/CSS 采用 UTF8 字节上限，summary 800字且额外字段拒绝', async () => {
  for (const invalid of [{ ...draft, html_body: '中'.repeat(35000) }, { ...draft, css: '中'.repeat(14000) },
    { ...draft, summary: '长'.repeat(801) }, { ...draft, apiKey: '禁止' }]) {
    const events: WebsiteAgentObservation[] = [];
    await runWebsiteAgent(config, '需求', snapshot, collect(events), script([
      [call('update_plan', plan('completed'))],
      [call('write_draft', invalid), call('write_draft', draft), call('validate_draft'), call('finish')],
    ]));
    assert.equal(events.filter(event => event.draft).length, 1);
    assert.equal(events.filter(event => event.event.status === 'error')[0]!.event.message, 'TOOL_ARGUMENTS_INVALID');
  }
});

test('仅保留最近完整 native pair，状态去重当前稿和事实，不积累旧代码与旧 pairs', async () => {
  const revisions = ['a', 'b', 'c'].map((marker, index) => ({ ...draft,
    html_body: `${index === 0 ? badDraft.html_body : draft.html_body}<!--draft-version-${marker}--><!--${'padding'.repeat(700)}-->`,
  }));
  const events: WebsiteAgentObservation[] = [];
  const result = await runWebsiteAgent(config, '根需求固定', snapshot, collect(events), script([
    [call('read_context'), call('update_plan', plan()), call('write_draft', revisions[0]), call('validate_draft')],
    [call('write_draft', revisions[1]), call('validate_draft')],
    [call('write_draft', revisions[2])],
    [call('validate_draft'), call('update_plan', plan('completed')), call('finish')],
  ], (messages, index) => {
    assert.equal(messages[1]!.content, JSON.stringify({ design_brief: '根需求固定' }));
    if (index === 0) return;
    const state = executionState(messages);
    assert.equal(state.current_draft, undefined);
    const assistant = messages[3];
    assert.ok(assistant?.role === 'assistant');
    const write = assistant.tool_calls.find(item => item.function.name === 'write_draft')!;
    assert.deepEqual(JSON.parse(write.function.arguments), revisions[index - 1]);
    assert.equal(state.draft_revision, index);
    assert.equal(state.execution_state.plan[0].status, 'pending');
    assert.equal(state.context_loaded, true);
    if (index === 1) {
      assert.equal(state.facts, undefined); assert.equal(state.capabilities, undefined);
      assert.equal(toolResults(messages)[0]!.value.facts.restaurant.name, snapshot.restaurant.name);
    } else assert.equal(state.facts.restaurant.name, snapshot.restaurant.name);
    const encoded = JSON.stringify(messages);
    assert.equal(encoded.split(`draft-version-${['a', 'b', 'c'][index - 1]}`).length - 1, 1);
    for (const old of ['a', 'b', 'c'].slice(0, index - 1)) assert.ok(!encoded.includes(`draft-version-${old}`));
    assert.equal(state.last_observations.length, index === 1 ? 4 : index === 2 ? 2 : 1);
    if (index === 1) {
      assert.equal(state.current_validation_passed, false);
      assert.equal(state.last_observations[3].ok, false);
      assert.equal(state.last_observations[3].code, 'HTML_TAG_FORBIDDEN');
      assert.ok(toolResults(messages)[3]!.value.diagnostics.some((diagnostic: { file: string; line: number; code: string }) =>
        diagnostic.file === 'index.html' && diagnostic.line === 2 && diagnostic.code === 'HTML_TAG_FORBIDDEN'));
    }
    if (index === 2) assert.equal(state.current_validation_passed, true);
    if (index === 3) {
      assert.deepEqual(state.current_validation, { draft_revision: null, valid: null });
      assert.equal(state.current_validation_passed, false);
      assert.deepEqual(state.last_observations, [{ tool_name: 'write_draft', ok: true }]);
      assert.equal(toolResults(messages)[0]!.value.validation_required, true);
    }
  }));
  assert.equal(result.progress.phase, 'ready'); assert.equal(result.progress.round, 3);
  assert.equal(events.filter(event => event.event.action === 'model_call_started').length, 4);
});

test('逐轮 read→plan→write→validate→complete→finish 保留最新真实反馈且只读一次上下文', async () => {
  const rounds = [[call('read_context')], [call('update_plan', plan())], [call('write_draft', draft)],
    [call('validate_draft')], [call('update_plan', plan('completed'))], [call('finish')]];
  const events: WebsiteAgentObservation[] = [];
  const source = structuredClone(snapshot);
  const result = await runWebsiteAgent(config, '固定商家需求', source, collect(events), script(rounds, (messages, index) => {
    if (index === 0) return;
    const state = executionState(messages), feedback = toolResults(messages);
    assert.equal(feedback.length, 1); assert.equal(feedback[0]!.name, rounds[index - 1]![0]!.function.name);
    assert.equal(state.context_loaded, true);
    if (index === 1) {
      assert.equal(state.facts, undefined); assert.equal(state.capabilities, undefined);
      assert.deepEqual(state.execution_state.plan, []);
      assert.equal(feedback[0]!.value.facts.restaurant.name, '真实餐厅');
      source.restaurant.id = 'rst_other'; source.restaurant.name = '不可覆盖的身份';
    } else {
      assert.equal(state.facts.restaurant.id, 'rst_fixture');
      assert.equal(state.facts.restaurant.name, '真实餐厅');
      assert.ok(state.capabilities);
      assert.deepEqual(state.current_draft, index === 3 ? undefined : index > 3 ? draft : null);
    }
    if (index >= 4) assert.equal(state.current_validation_passed, true);
    const encoded = JSON.stringify(messages);
    assert.equal(Number(Boolean(state.capabilities)) + feedback.filter(item => item.value.capabilities).length, 1);
    assert.equal(encoded.split(draft.summary).length - 1, index >= 3 ? 1 : 0);
  }));
  assert.equal(result.progress.model_calls, 6); assert.equal(result.progress.phase, 'ready');
  assert.equal(events.filter(event => event.event.action === 'read_context').length, 1);
  assert.ok(result.html.includes('真实餐厅') && !result.html.includes('不可覆盖的身份'));
});

test('最近 read/write 请求被拒绝时，摘要仍保留此前真实 facts 和有效草稿，不把失败参数当当前稿', async () => {
  const result = await runWebsiteAgent(config, '需求', snapshot, async () => {}, script([
    [call('read_context'), call('update_plan', plan('completed')), call('write_draft', draft), call('validate_draft')],
    [call('read_context', { secret: '禁止' }), call('write_draft', { ...badDraft, unknown: true })],
    [call('finish')],
  ], (messages, index) => {
    if (index !== 2) return;
    const state = executionState(messages), results = toolResults(messages);
    assert.equal(state.context_loaded, true);
    assert.equal(state.facts.restaurant.name, snapshot.restaurant.name);
    assert.ok(state.capabilities); assert.deepEqual(state.current_draft, draft);
    assert.equal(state.current_validation_passed, true); assert.equal(state.draft_revision, 1);
    assert.ok(results.every(item => item.value.error.code === 'TOOL_ARGUMENTS_INVALID'));
    assert.ok(state.last_observations.every((item: { ok: boolean; code: string }) => !item.ok && item.code === 'TOOL_ARGUMENTS_INVALID'));
  }));
  assert.equal(result.progress.round, 1); assert.equal(result.progress.phase, 'ready');
});

test('原生轮次后普通正文丢弃旧 pair，保留实际状态和明确继续提示，不伪造调用', async () => {
  let calls = 0;
  const result = await runWebsiteAgent(config, '需求', snapshot, async () => {}, async (_config, messages) => {
    calls++;
    if (calls === 1) return response([call('read_context'), call('update_plan', plan('completed')), call('write_draft', draft), call('validate_draft')]);
    if (calls === 2) {
      assert.equal(toolResults(messages).length, 4);
      return response([]);
    }
    assert.equal(calls, 3); assert.equal(messages.length, 4);
    assert.ok(messages.every(message => message.role === 'system' || message.role === 'user'));
    const state = executionState(messages);
    assert.equal(state.context_loaded, true); assert.deepEqual(state.current_draft, draft);
    assert.equal(state.facts.restaurant.name, snapshot.restaurant.name); assert.ok(state.capabilities);
    assert.equal(state.current_validation_passed, true);
    assert.deepEqual(state.last_observations, [{ tool_name: 'model_response', ok: false, code: 'AGENT_TOOL_REQUIRED' }]);
    assert.equal(messages.at(-1)!.content, '必须选择提供的原生函数工具。普通正文或 JSON 不能完成任务。请继续工具调用。');
    return response([call('finish')]);
  });
  assert.equal(result.progress.phase, 'ready'); assert.equal(calls, 3);
});

test('预算包含最近完整 native pair 的参数和反馈，不因摘要省略重复字段低估请求', async () => {
  let calls = 0; const events: WebsiteAgentObservation[] = [];
  const largeDraft = { ...draft, html_body: `${draft.html_body}<!--${'p'.repeat(65000)}-->` };
  await assert.rejects(runWebsiteAgent(config, '需求', snapshot, collect(events), async () => {
    calls++; assert.equal(calls, 1);
    return response([call('read_context'), call('update_plan', plan()), call('write_draft', largeDraft)]);
  }), { code: 'AGENT_TOKEN_LIMIT' });
  assert.equal(calls, 1); assert.equal(events.at(-1)!.progress.model_calls, 1);
  assert.equal(events.filter(event => event.draft).length, 1);
});
