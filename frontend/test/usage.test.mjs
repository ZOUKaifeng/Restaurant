import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 复用 table-folk / operations 的内存 TS 装载、真实 SSR 与单组件 hooks harness。
// 不启动浏览器，不访问 DB、模型或真实网络；夹具不进入生产模块。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'package.json'));
const ts = require('typescript'), React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { parseFragment } = require('parse5');
const extensions = Object.fromEntries(['.ts', '.tsx', '.css'].map(name => [name, Module._extensions[name]]));
const globals = Object.fromEntries(['window', 'document', 'fetch'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const cache = new Set(Object.keys(require.cache));
const RID = 'restaurant_fixture_000001', RID2 = 'restaurant_fixture_000002';
const UID = `usr_${'u'.repeat(24)}`, UID2 = `usr_${'v'.repeat(24)}`;
const NOW = '2026-03-01T10:00:00.123456Z';
const CURSOR = `opaque_page_1.${'s'.repeat(43)}`, CURSOR2 = `opaque_page_2.${'s'.repeat(43)}`;
const filterKeys = ['restaurant_id', 'feature', 'origin', 'from', 'to'];
const totalKeys = ['calls', 'known_usage_calls', 'unknown_usage_calls', 'pending_calls', 'prompt_tokens', 'completion_tokens', 'total_tokens'];
let client, views, transport, routes, calls, timers, responder, nextTimer, unexpected;
const harnesses = new Set();
function compiledSource(filename) {
  const output = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true, moduleResolution: ts.ModuleResolutionKind.NodeJs,
  }, fileName: filename }).outputText;
  return output.replace(/require\(["'](\.\.?\/[^"']+)\.js["']\)/g, (match, relative) => {
    for (const extension of ['.ts', '.tsx']) {
      const target = resolve(dirname(filename), relative + extension);
      if (existsSync(target)) return `require(${JSON.stringify(target)})`;
    }
    return match;
  });
}
const load = name => require(resolve(root, 'src', name));
function response(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
function deferred() {
  let resolvePromise, reject;
  const promise = new Promise((yes, no) => { resolvePromise = yes; reject = no; });
  return { promise, resolve: resolvePromise, reject };
}
const turn = () => new Promise(done => setImmediate(done));
function filters(query = {}) { return Object.fromEntries(filterKeys.map(key => [key, query[key] ?? null])); }
function totals(known = 0, pending = 0, unknown = 0, input = 0, output = 0) {
  return { calls: known + pending + unknown, known_usage_calls: known, unknown_usage_calls: unknown, pending_calls: pending, prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}
function report(query = {}, groups = [
  { feature: 'menu_recognition', ...totals(1, 0, 0, 8, 2) },
  { feature: 'website_chat', ...totals(0, 1, 0) },
  { feature: 'website_generate', ...totals(0, 0, 1) },
]) {
  const filtered = Object.fromEntries(totalKeys.map(key => [key, groups.reduce((sum, group) => sum + group[key], 0)]));
  return {
    mode: 'observation', policy_version: 'observation-v1', generated_at: NOW,
    billing_account: { id: `bla_${'a'.repeat(24)}`, status: 'active' },
    quota: { configured: false, enforced: false, available_tokens: null, granted_tokens: null, reserved_tokens: null, consumed_tokens: null },
    filters: filters(query), account_totals: { ...filtered }, filtered_totals: { ...filtered }, by_feature: groups,
    legacy: { aggregate_jobs: 2, known_total_tokens: 45, unknown_usage_jobs: 3 },
  };
}
function creditPeriod(patch = {}) {
  return { id: `aqp_${'p'.repeat(24)}`, starts_at: '2026-11-01T00:00:00.000000Z', ends_at: '2026-12-01T00:00:00.000000Z',
    granted_at: '2026-11-19T00:00:00.000001Z', timezone: 'UTC', origin: 'development_test', tokens_per_credit: 100, auto_renew: false, ...patch };
}
function configuredReport(query = {}, consumed = 0, reserved = 0, month = totals()) {
  const history = totals(1, 0, 0, 10000, 0);
  const all = Object.fromEntries(totalKeys.map(key => [key, history[key] + month[key]]));
  const data = report(query, [{ feature: 'website_chat', ...all }]);
  const period = creditPeriod();
  data.generated_at = '2026-11-19T10:00:00.123456Z';
  data.quota = { configured: true, enforced: false, granted_tokens: 1000000, available_tokens: 1000000 - reserved - consumed,
    reserved_tokens: reserved, consumed_tokens: consumed, period };
  data.calendar_month_totals = { period_id: period.id, totals: month };
  return data;
}
function call(index = 9, patch = {}) {
  return { id: `aic_${String(index).padStart(24, '0')}`, restaurant_id: RID, restaurant_name: 'Current owner dining',
    job_id: `job_${'j'.repeat(24)}`, feature: 'menu_recognition', model: 'deepseek-chat', provider: 'deepseek', call_index: 1,
    call_status: 'completed', usage_status: 'known', origin: 'live', chargeable: false,
    prompt_tokens: 8, completion_tokens: 2, total_tokens: 10, elapsed_ms: 1200, error_code: null,
    created_at: NOW, finished_at: '2026-03-01T10:00:02.123456Z', ...patch };
}
function page(query = {}, items = [call()], next = null) { return { filters: filters(query), items, next_cursor: next }; }
function owner(index = 1, patch = {}) { return { id: `restaurant_fixture_${String(index).padStart(6, '0')}`, name: `Owner restaurant ${index}`, role: 'owner', status: 'active', ...patch }; }
function session(userId = UID) { return { user: { id: userId, email: 'owner@example.test', locale: 'en', status: 'active', display_name: null }, session_expires_at: '2026-03-02T00:00:00.000Z' }; }
function setupResponses({ summary = report(), first = page(), restaurants = { items: [owner()], next_cursor: null, has_more: false }, more = page({}, [call(8)]), extra } = {}) {
  responder = request => {
    const url = new URL(request.url, window.location.origin);
    if (url.pathname === '/api/v1/ai/usage') return response(typeof summary === 'function' ? summary(request, url) : summary);
    if (url.pathname === '/api/v1/ai/usage/calls') {
      const data = url.searchParams.has('cursor') ? more : first;
      return response(typeof data === 'function' ? data(request, url) : data);
    }
    if (url.pathname === '/api/v1/restaurants') return response(typeof restaurants === 'function' ? restaurants(request, url) : restaurants);
    if (extra) return extra(request, url);
    throw new Error(`未配置接口 ${request.url}`);
  };
}
function assertApiError(status, code = 'USAGE_RESPONSE_INVALID') {
  return error => { assert.ok(error instanceof transport.ApiError); assert.equal(error.status, status); assert.equal(error.code, code); return true; };
}
function urlOf(request) { return new URL(request.url, window.location.origin); }
function queryOf(request) { return Object.fromEntries(urlOf(request).searchParams); }
function readRequests(path) { return calls.filter(request => urlOf(request).pathname === path); }
function checkGet(request) {
  assert.equal(request.options.method, 'GET');
  for (const [key, value] of Object.entries({ credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'same-origin' })) assert.equal(request.options[key], value);
  assert.equal(request.options.body, undefined);
  assert.equal(request.options.headers.get('Accept'), 'application/json');
  assert.equal(request.options.headers.get('X-CSRF-Token'), null);
  assert.ok(request.options.signal instanceof AbortSignal);
}
function nodes(node, predicate) {
  const result = [];
  function walk(item) { if (predicate(item)) result.push(item); (item.childNodes ?? []).forEach(walk); }
  walk(node); return result;
}
const attr = (node, key) => (node.attrs ?? []).find(item => item.name === key)?.value;
const text = node => node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(text).join('');
function markup(data = report(), items = [call()]) { return renderToStaticMarkup(React.createElement(views.UsageReportView, { report: data, calls: items })); }

test('有符号余额精确换算，原用量 formatter 继续拒绝负数', () => {
  const { formatUsageCreditBalance, formatUsageCredits } = load('usage-credits.ts');
  for (const [input, expected] of [[null, '—'], [0, '0'], [-1, '-0.01'], [-10, '-0.1'], [-101, '-1.01'],
    [1000000, '10,000'], [999000, '9,990'], [-Number.MAX_SAFE_INTEGER, '-90,071,992,547,409.91']]) assert.equal(formatUsageCreditBalance(input), expected);
  for (const value of [undefined, '0', 1n, NaN, Infinity, 0.01, Number.MAX_SAFE_INTEGER + 1, -Number.MAX_SAFE_INTEGER - 1]) {
    assert.throws(() => formatUsageCreditBalance(value), assertApiError(502));
  }
  assert.throws(() => formatUsageCredits(-1), assertApiError(502));
});
test('配置报表匹配真实 quota union 和 monthly totals，保留旧 alltime，不以历史反推余额', () => {
  const schemas = JSON.parse(readFileSync(resolve(root, '../backend/contracts/ai-usage.openapi.json'), 'utf8')).components.schemas;
  for (const consumed of [0, 1, 1000, 1000001]) {
    const data = configuredReport({}, consumed, 0, consumed ? totals(1, 0, 0, consumed, 0) : totals());
    const original = structuredClone(data), validated = client.validateUsageReport(data);
    assert.deepEqual(validated, original); assert.deepEqual(data, original);
    assert.deepEqual(Object.keys(validated.quota).sort(), schemas.Quota.oneOf[1].required.toSorted());
    assert.deepEqual(Object.keys(validated.quota.period).sort(), schemas.AiCreditPeriod.required.toSorted());
    assert.deepEqual(Object.keys(validated.calendar_month_totals).sort(), schemas.CalendarMonthTotals.required.toSorted());
    assert.equal(validated.quota.available_tokens, 1000000 - consumed);
    assert.equal(validated.account_totals.total_tokens, 10000 + consumed);
  }
});
for (const [label, mutate] of [
  ['enforced', data => { data.quota.enforced = true; }], ['缺少period', data => { delete data.quota.period; }],
  ['quota额外字段', data => { data.quota.paid = true; }], ['错误configured', data => { data.quota.configured = 'true'; }],
  ['不守恒', data => { data.quota.available_tokens -= 1; }], ['账户null', data => { data.billing_account = null; }],
  ['缺少monthtotals', data => { delete data.calendar_month_totals; }], ['monthtotals null', data => { data.calendar_month_totals = null; }],
  ['monthtotals period不匹配', data => { data.calendar_month_totals.period_id = `aqp_${'q'.repeat(24)}`; }],
  ['monthtotals额外字段', data => { data.calendar_month_totals.extra = 0; }],
  ['monthtotals缺少字段', data => { delete data.calendar_month_totals.totals; }],
  ['monthtotals计数矛盾', data => { data.calendar_month_totals.totals.calls = 1; }],
  ['monthtotals超账户', data => { data.calendar_month_totals.totals = totals(2); }],
  ['monthtotals未知计量', data => { data.calendar_month_totals.totals = totals(0, 1, 0, 1, 0); }],
  ['monthtotals未知字段', data => { data.calendar_month_totals.totals.money = 0; }],
  ['生成早于授额微秒', data => { data.generated_at = '2026-11-19T00:00:00.000000Z'; }],
  ['生成等于到期', data => { data.generated_at = data.quota.period.ends_at; }],
]) test(`configured report 拒绝${label}`, () => {
  const data = configuredReport(); mutate(data); assert.throws(() => client.validateUsageReport(data), assertApiError(502));
});
for (const field of ['granted_tokens', 'reserved_tokens', 'consumed_tokens', 'available_tokens']) test(`quota ${field} 必须安全整数，只有available允许负数`, () => {
  for (const value of [null, undefined, '1', 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, -Number.MAX_SAFE_INTEGER - 1,
    ...(field === 'available_tokens' ? [] : [-1])]) {
    const data = configuredReport(); data.quota[field] = value;
    assert.throws(() => client.validateUsageReport(data), assertApiError(502));
  }
});
test('quota BigInt守恒允许中间和超安全上限、最终负余额仍安全，不用number相减', () => {
  const data = configuredReport();
  Object.assign(data.quota, { granted_tokens: Number.MAX_SAFE_INTEGER, reserved_tokens: Number.MAX_SAFE_INTEGER,
    consumed_tokens: Number.MAX_SAFE_INTEGER, available_tokens: -Number.MAX_SAFE_INTEGER });
  assert.deepEqual(client.validateUsageReport(data).quota, data.quota);
  data.quota.available_tokens += 1; assert.throws(() => client.validateUsageReport(data), assertApiError(502));
});
for (const [label, patch] of [
  ['id', { id: 'aqp_bad' }], ['非UTC', { timezone: 'Asia/Shanghai' }], ['origin', { origin: 'paid' }],
  ['换算', { tokens_per_credit: 99 }], ['续发', { auto_renew: true }], ['未知字段', { payment_enabled: true }],
  ['起点非首日', { starts_at: '2026-11-02T00:00:00.000000Z' }], ['起点非午夜', { starts_at: '2026-11-01T00:00:01.000000Z' }],
  ['起点微秒', { starts_at: '2026-11-01T00:00:00.000001Z' }], ['三位精度', { starts_at: '2026-11-01T00:00:00.000Z' }],
  ['非UTC格式', { starts_at: '2026-11-01T00:00:00.000000+00:00' }], ['非法月', { starts_at: '2026-13-01T00:00:00.000000Z' }],
  ['非法日', { granted_at: '2026-11-31T00:00:00.000000Z' }], ['零年', { starts_at: '0000-11-01T00:00:00.000000Z' }],
  ['终点非首日', { ends_at: '2026-11-30T00:00:00.000000Z' }], ['终点非午夜', { ends_at: '2026-12-01T01:00:00.000000Z' }],
  ['跨两月', { ends_at: '2027-01-01T00:00:00.000000Z' }], ['相同终点', { ends_at: '2026-11-01T00:00:00.000000Z' }],
  ['授额前', { granted_at: '2026-10-31T23:59:59.999999Z' }], ['授额等于终点', { granted_at: '2026-12-01T00:00:00.000000Z' }],
]) test(`共享period 拒绝${label}`, () => {
  const data = configuredReport(); Object.assign(data.quota.period, patch);
  assert.throws(() => client.validateUsageReport(data), assertApiError(502));
});
test('period逐个必填，闰月与跨年、首尾微秒精确保留', () => {
  for (const key of Object.keys(creditPeriod())) {
    const data = configuredReport(); delete data.quota.period[key]; assert.throws(() => client.validateUsageReport(data), assertApiError(502));
  }
  for (const [start, end, grant] of [
    ['2024-02-01', '2024-03-01', '2024-02-29T23:59:59.999999Z'],
    ['2026-12-01', '2027-01-01', '2026-12-01T00:00:00.000000Z'],
    ['0001-01-01', '0001-02-01', '0001-01-01T00:00:00.000000Z'],
  ]) {
    const period = creditPeriod({ starts_at: `${start}T00:00:00.000000Z`, ends_at: `${end}T00:00:00.000000Z`, granted_at: grant });
    assert.deepEqual(client.readCreditPeriod(period), period);
  }
});
test('quota false禁止period与monthly totals，不把未配置变成零', () => {
  const first = report(); first.quota.period = creditPeriod(); assert.throws(() => client.validateUsageReport(first), assertApiError(502));
  for (const month of [undefined, null, { period_id: creditPeriod().id, totals: totals() }]) {
    const data = report(); data.calendar_month_totals = month; assert.throws(() => client.validateUsageReport(data), assertApiError(502));
  }
});
test('configured SSR顶部四项自然月摘要：无新调用10000/0，历史100积分折叠且不追扣', () => {
  const data = client.validateUsageReport(configuredReport());
  const doc = parseFragment(markup(data, [])), overview = nodes(doc, node => attr(node, 'aria-label') === 'This calendar month credit summary')[0];
  const values = nodes(overview, node => attr(node, 'class') === 'usage-value').map(text);
  assert.deepEqual(values, ['10,000', '0', '10,000', '0']);
  const visible = (overview.childNodes ?? []).filter(node => node.tagName !== 'details').map(text).join('');
  for (const expected of ['This calendar month · UTC', '2026-11-01 – 2026-11-30', 'Granted credits', 'Used credits', 'Credits left',
    'Pending or unknown calls', 'Earlier history is not deducted', 'Not a paid subscription', '0 calls since grant']) assert.ok(visible.includes(expected), expected);
  assert.doesNotMatch(visible, /Known credit usage|Account shared · all time|100 credits|No credits have been deducted/);
  const details = nodes(overview, node => node.tagName === 'details');
  assert.equal(details.length, 1); assert.equal(attr(details[0], 'open'), undefined);
  assert.match(text(details[0]), /Known credit usage: 100/);
  assert.match(visible, /2026-12-01 00:00:00.000000 UTC \(exclusive\)/);
  assert.match(visible, /No automatic renewal or next-month grant/);
  assert.match(text(doc), /History \/ filters/);
  assert.doesNotMatch(text(doc), /No credits have been deducted|allowances not configured|\btokens?\b|1000000|1,000,000/);
  for (const name of ['TokenBalance.tsx', 'UsagePage.tsx', 'BillingPage.tsx']) assert.doesNotMatch(readFileSync(resolve(root, 'src', name), 'utf8'), /\b10000(?:00)?\b/);
});
test('月摘要只读quota消费，不合并legacy；pending/unknown不估算，失败known保留provider真实用量', () => {
  const month = totals(1, 2, 3, 800, 200), data = client.validateUsageReport(configuredReport({}, 1000, 1, month));
  const failed = call(9, { call_status: 'failed', error_code: 'UPSTREAM_ERROR', created_at: '2026-11-19T01:00:00.000000Z',
    finished_at: '2026-11-19T01:00:01.000000Z', prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000 });
  const html = markup(data, [failed]), doc = parseFragment(html);
  assert.deepEqual(nodes(doc, node => attr(node, 'class') === 'usage-value').map(text), ['10,000', '10', '9,989.99', '5']);
  for (const phrase of ['2 pending · 3 unknown', '6 calls since grant', 'known balance may update later', 'not estimated', 'Failed calls with known provider usage are counted',
    'Reserved credits: 0.01', 'failed', 'UPSTREAM_ERROR']) assert.ok(text(doc).includes(phrase), phrase);
  assert.doesNotMatch(text(doc), /No credits have been deducted|11000|11,000|1000000/);
  const small = client.validateUsageReport(configuredReport({}, 1, 0, totals(1, 0, 0, 1, 0)));
  assert.deepEqual(nodes(parseFragment(markup(small, [])), node => attr(node, 'class') === 'usage-value').map(text), ['10,000', '0.01', '9,999.99', '0']);
});
test('pending与unknown以及尚未报告的未来调用不虚补扣费，真实余额和known零保持区别', () => {
  const data = client.validateUsageReport(configuredReport({}, 0, 0, totals(0, 1, 1)));
  const doc = parseFragment(markup(data, []));
  assert.deepEqual(nodes(doc, node => attr(node, 'class') === 'usage-value').map(text), ['10,000', '0', '10,000', '2']);
  assert.match(text(doc), /2 calls since grant · 0 known usage calls/); assert.match(text(doc), /not estimated/);
  assert.equal(data.calendar_month_totals.totals.total_tokens, 0);
  assert.match(text(doc), /No calls returned for this scope/);
});
for (const key of totalKeys) test(`calendar_month_totals ${key}严格复用安全整数校验`, () => {
  for (const value of [null, undefined, -1, 0.1, '0', Number.MAX_SAFE_INTEGER + 1]) {
    const data = configuredReport(); data.calendar_month_totals.totals[key] = value;
    assert.throws(() => client.validateUsageReport(data), assertApiError(502));
  }
});
test('configured quota逐个必填、嵌套对象不得替代真实数量', () => {
  for (const key of Object.keys(configuredReport().quota)) {
    const data = configuredReport(); delete data.quota[key]; assert.throws(() => client.validateUsageReport(data), assertApiError(502));
  }
  for (const quota of [null, [], true, 'configured']) {
    const data = configuredReport(); data.quota = quota; assert.throws(() => client.validateUsageReport(data), assertApiError(502));
  }
});
test('负余额真实显示且不添加hardlock或付费权限', () => {
  const data = client.validateUsageReport(configuredReport({}, 1000001, 0, totals(1, 0, 0, 1000001, 0)));
  const doc = parseFragment(markup(data, []));
  assert.deepEqual(nodes(doc, node => attr(node, 'class') === 'usage-value').map(text), ['10,000', '10,000.01', '-0.01', '0']);
  assert.match(text(doc), /no hard limit is enforced/); assert.equal(nodes(doc, node => node.tagName === 'button').length, 0);
});
test('手选历史scope仍alltime统计；月授额和全账户月count不受餐厅feature日期筛选', () => {
  const base = configuredReport({}, 1, 0, totals(1, 1, 1, 1, 0));
  for (const query of [{ restaurant_id: RID }, { feature: 'menu_recognition' }, { origin: 'legacy_import' }, { from: '2026-03-01', to: '2026-03-01' }]) {
    const data = configuredReport(query, 1, 0, totals(1, 1, 1, 1, 0)); data.filtered_totals = totals(); data.by_feature = [];
    const actual = client.validateUsageReport(data, query);
    assert.deepEqual(actual.account_totals, base.account_totals); assert.deepEqual(actual.calendar_month_totals, base.calendar_month_totals);
    assert.deepEqual(actual.quota, base.quota);
    assert.match(text(parseFragment(markup(actual, []))), /3 calls since grant/);
  }
});

test('积分显示按100计量单位换算，零与未知分开，整百与百分位不向上整点扣费', () => {
  const { formatUsageCredits, USAGE_TOKENS_PER_CREDIT } = load('usage-credits.ts');
  assert.equal(USAGE_TOKENS_PER_CREDIT, 100);
  for (const [input, expected] of [[null, '—'], [0, '0'], [1, '0.01'], [8, '0.08'], [10, '0.1'], [99, '0.99'],
    [100, '1'], [101, '1.01'], [42146, '421.46'], [100000, '1,000'], [1000000, '10,000'],
    [Number.MAX_SAFE_INTEGER, '90,071,992,547,409.91']]) assert.equal(formatUsageCredits(input), expected);
  for (const invalid of [undefined, -1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100', 100n]) {
    assert.throws(() => formatUsageCredits(invalid), error => error.code === 'USAGE_RESPONSE_INVALID');
  }
});
test('SSR全部用量均显示积分，输入输出总量与历史聚合转换，不泄露实际计量数', () => {
  const data = report({}, [{ feature: 'website_generate', ...totals(1, 0, 0, 37623, 4523) }]);
  data.legacy = { aggregate_jobs: 2, known_total_tokens: 98765, unknown_usage_jobs: 0 };
  const item = call(9, { feature: 'website_generate', prompt_tokens: 37623, completion_tokens: 4523, total_tokens: 42146 });
  const original = structuredClone(data), originalCall = structuredClone(item);
  const html = markup(data, [item]), doc = parseFragment(html), visibleText = text(doc);
  for (const expected of ['Known credit usage', '421.46', '376.23', '45.23', '987.65', 'Input credits', 'Output credits',
    'Known total credits', 'Known aggregate credits', 'No credits have been deducted', 'not a credit balance']) assert.ok(visibleText.includes(expected), expected);
  assert.doesNotMatch(visibleText, /\btokens?\b|37,623|4,523|42,146|98,765|37623|4523|42146|98765/i);
  const tables = nodes(doc, node => node.tagName === 'table');
  const callRow = nodes(tables[1], node => node.tagName === 'tbody')[0].childNodes.find(node => node.tagName === 'tr');
  const cells = (callRow.childNodes ?? []).filter(node => node.tagName === 'td');
  assert.deepEqual(cells.slice(2, 5).map(text), ['376.23', '45.23', '421.46']);
  assert.deepEqual(data, original); assert.deepEqual(item, originalCall);
});
test('小额调用不逐条向上取整：两次0.01合计0.02积分，未知仍是破折号', () => {
  const data = report({}, [{ feature: 'menu_recognition', ...totals(2, 0, 1, 2, 0) }]);
  const items = [call(9, { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 }),
    call(8, { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 }),
    call(7, { usage_status: 'unknown', prompt_tokens: null, completion_tokens: null, total_tokens: null })];
  const doc = parseFragment(markup(data, items));
  const values = nodes(doc, node => attr(node, 'class') === 'usage-value');
  assert.equal(text(values[0]), '0.02');
  const tables = nodes(doc, node => node.tagName === 'table'), rows = nodes(tables[1], node => node.tagName === 'tbody')[0].childNodes.filter(node => node.tagName === 'tr');
  assert.equal(text(rows[2].childNodes.filter(node => node.tagName === 'td')[4]), '—');
});
before(() => {
  const compile = (module, filename) => module._compile(compiledSource(filename), filename);
  Module._extensions['.ts'] = compile; Module._extensions['.tsx'] = compile; Module._extensions['.css'] = () => {};
  transport = load('api.ts'); client = load('usage-client.ts'); views = load('UsagePage.tsx'); routes = load('routing.ts');
});
beforeEach(() => {
  calls = []; timers = new Map(); nextTimer = 0; unexpected = [];
  responder = () => { throw new Error('不得访问真实网络'); };
  const listeners = new Map();
  const history = { state: null, replaceState(state, _, path) { this.state = state; if (path) window.location.pathname = path; },
    pushState(state, _, path) { this.state = state; window.location.pathname = path; }, go() {} };
  globalThis.window = { location: { pathname: '/account/usage', origin: 'https://localhost:5173', hash: '', search: '' }, history,
    addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
    emit(type, event = {}) { listeners.get(type)?.(event); }, scrollTo() {}, requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); } };
  globalThis.document = { documentElement: { lang: 'en' }, querySelector: () => null };
  globalThis.fetch = async (url, options) => {
    const request = { url: String(url), options }; calls.push(request);
    if (request.url === '/api/v1/auth/csrf') return response({ csrf_token: 'csrf-fixture-'.repeat(4) });
    try { return responder(request); } catch (error) { unexpected.push(error.message); throw error; }
  };
  transport.clearCsrf();
});
afterEach(async () => {
  for (const harness of [...harnesses].reverse()) harness.unmount();
  await turn();
  assert.deepEqual(unexpected, []);
  assert.equal(timers.size, 0, '请求定时器不得泄漏');
  assert.ok(calls.every(request => request.options.method === 'GET'), 'Usage 不得发起模型或业务写操作');
  transport.clearCsrf();
});
after(() => {
  for (const [name, handler] of Object.entries(extensions)) { if (handler) Module._extensions[name] = handler; else delete Module._extensions[name]; }
  for (const [name, descriptor] of Object.entries(globals)) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  for (const name of Object.keys(require.cache)) if (!cache.has(name) && name.startsWith(resolve(root, 'src') + '/')) delete require.cache[name];
});

test('响应与真实后端 types / OpenAPI 字段一致；三类计数与独立 legacy 保留', () => {
  const contract = JSON.parse(readFileSync(resolve(root, '../backend/contracts/ai-usage.openapi.json'), 'utf8'));
  const data = client.validateUsageReport(report());
  assert.deepEqual(data, report());
  assert.deepEqual(Object.keys(data).sort(), contract.components.schemas.AiUsageReport.required.toSorted());
  const actual = client.validateUsageCalls(page({}, [call(9), call(8, { call_status: 'started', usage_status: 'pending', prompt_tokens: null, completion_tokens: null, total_tokens: null, elapsed_ms: null, finished_at: null })]));
  assert.deepEqual(Object.keys(actual.items[0]).sort(), contract.components.schemas.AiUsageCall.required.toSorted());
  assert.equal(actual.items[1].total_tokens, null);
  const zero = call(7, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  assert.equal(client.validateUsageCalls(page({}, [zero])).items[0].total_tokens, 0);
});
for (const [label, mutate] of [
  ['未知根字段', data => { data.available_balance = 0; }], ['缺少字段', data => { delete data.legacy; }],
  ['启用 quota', data => { data.quota.configured = true; }], ['零假余额', data => { data.quota.available_tokens = 0; }],
  ['quota 空字段丢失', data => { delete data.quota.consumed_tokens; }], ['账户 ID', data => { data.billing_account.id = RID; }],
  ['账户 status', data => { data.billing_account.status = 'pending'; }], ['坏时间', data => { data.generated_at = '2026-02-30T00:00:00.000000Z'; }],
  ['非 UTC 时间', data => { data.generated_at = '2026-03-01T10:00:00.123456+00:00'; }], ['微秒格式', data => { data.generated_at = '2026-03-01T10:00:00.123Z'; }],
  ['filters 错范围', data => { data.filters.from = '2026-03-01'; data.filters.to = '2026-03-02'; }],
  ['filters 缺 null', data => { delete data.filters.origin; }], ['计数矛盾', data => { data.filtered_totals.calls += 1; }],
  ['输入输出矛盾', data => { data.account_totals.total_tokens += 1; }], ['无 known 却有 tokens', data => { data.by_feature[1].total_tokens = 2; data.by_feature[1].prompt_tokens = 2; }],
  ['多 feature 矛盾', data => { data.by_feature[0].calls += 1; data.by_feature[0].unknown_usage_calls += 1; }],
  ['重复 feature', data => { data.by_feature[1].feature = 'menu_recognition'; }], ['第四 feature', data => { data.by_feature.push({ feature: 'other', ...totals() }); }],
  ['feature 未知字段', data => { data.by_feature[0].amount = 0; }], ['account 小于 filtered', data => { data.account_totals = totals(); }],
  ['legacy 非整数', data => { data.legacy.aggregate_jobs = 1.5; }], ['无账户却有账', data => { data.billing_account = null; }],
  ['状态计数和溢出', data => { data.account_totals = { ...totals(), calls: Number.MAX_SAFE_INTEGER, known_usage_calls: Number.MAX_SAFE_INTEGER, unknown_usage_calls: 1 }; }],
  ['token 和溢出', data => { data.account_totals = { ...totals(1), prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER }; }],
]) test(`report 拒绝${label}`, () => { const data = report(); mutate(data); assert.throws(() => client.validateUsageReport(data), assertApiError(502)); });
for (const key of totalKeys) test(`report 拒绝 ${key} unsafe integer / null / 负数`, () => {
  for (const value of [Number.MAX_SAFE_INTEGER + 1, null, -1, 0.5, '0']) {
    const data = report(); data.account_totals[key] = value;
    assert.throws(() => client.validateUsageReport(data), assertApiError(502));
  }
});
test('稀疏 by_feature 按真实契约可为空，UI 固定三类；未知和 pending 不算 known 零', () => {
  const data = report({}, []); data.billing_account = null; data.legacy = { aggregate_jobs: 0, known_total_tokens: 0, unknown_usage_jobs: 0 };
  assert.deepEqual(client.validateUsageReport(data), data);
  const doc = parseFragment(markup(data, []));
  const featureTable = nodes(doc, node => node.tagName === 'table')[0];
  assert.equal(nodes(featureTable, node => node.tagName === 'tbody')[0].childNodes.filter(node => node.tagName === 'tr').length, 3);
  assert.match(text(doc), /No metering account yet/);
  assert.match(text(doc), /No calls returned/);
});
test('filtered totals 单独、account totals 全账户，feature 过滤不允许其他非零组', () => {
  const query = { restaurant_id: RID, feature: 'website_chat', origin: 'live', from: '2026-03-01', to: '2026-03-02' };
  const data = report(query, [{ feature: 'website_chat', ...totals(0, 1, 0) }]); data.account_totals = report().account_totals;
  assert.equal(client.validateUsageReport(data, query).account_totals.total_tokens, 10);
  const bad = structuredClone(data); bad.by_feature[0].feature = 'website_generate';
  assert.throws(() => client.validateUsageReport(bad, query), assertApiError(502));
  assert.throws(() => client.validateUsageReport(data, { ...query, restaurant_id: RID2 }), assertApiError(502));
});
for (const [label, patch] of [
  ['ID', { id: 'aic_bad' }], ['restaurant ID', { restaurant_id: '../secret' }], ['name 缺 nullable', { restaurant_name: undefined }],
  ['job 类型', { job_id: null }], ['model 空', { model: '' }], ['provider', { provider: 'other' }], ['chargeable', { chargeable: true }],
  ['index 零', { call_index: 0 }], ['index 溢出', { call_index: 2147483648 }], ['origin', { origin: 'legacy' }],
  ['pending token 零', { call_status: 'started', usage_status: 'pending', finished_at: null, elapsed_ms: null }],
  ['known token null', { prompt_tokens: null }], ['token 不一致', { total_tokens: 11 }], ['unknown token 零', { usage_status: 'unknown', prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }],
  ['started known', { call_status: 'started' }], ['finished pending', { usage_status: 'pending', prompt_tokens: null, completion_tokens: null, total_tokens: null }],
  ['结束无时间', { finished_at: null }], ['结束先于开始微秒', { finished_at: '2026-03-01T10:00:00.123455Z' }],
  ['时间 24 时', { created_at: '2026-03-01T24:00:00.000000Z' }], ['非法 UTC 日期', { created_at: '2026-02-30T00:00:00.000000Z' }],
  ['duration unsafe', { elapsed_ms: Number.MAX_SAFE_INTEGER + 1 }], ['completed error', { error_code: 'UPSTREAM_ERROR' }], ['error code', { call_status: 'failed', error_code: '<script>' }],
  ['额外私有字段', { input: 'must not be rendered' }],
]) test(`calls 拒绝${label}`, () => { assert.throws(() => client.validateUsageCalls(page({}, [call(9, patch)])), assertApiError(502)); });
test('calls 校验 limit、filters、行内范围、cursor，精确微秒排序，不猜游标签名', () => {
  const query = { restaurant_id: RID, feature: 'menu_recognition', origin: 'live', from: '2026-03-01', to: '2026-03-01', limit: 20 };
  assert.equal(client.validateUsageCalls(page(query, [call()], CURSOR), query).next_cursor, CURSOR);
  for (const patch of [{ restaurant_id: RID2 }, { feature: 'website_chat' }, { origin: 'legacy_import' }, { created_at: '2026-03-02T00:00:00.000000Z', finished_at: '2026-03-02T00:00:01.000000Z' }]) {
    assert.throws(() => client.validateUsageCalls(page(query, [call(9, patch)]), query), assertApiError(502));
  }
  for (const data of [page({}, [call(), call()]), page({}, [call(8), call(9)]), page({}, [call(9, { created_at: '2026-03-01T10:00:00.123455Z' }), call(8)]), page({}, [], CURSOR), page({}, [call()], '../cursor'), page({}, [call()], 'a'.repeat(2049))]) {
    assert.throws(() => client.validateUsageCalls(data), assertApiError(502));
  }
  assert.throws(() => client.validateUsageCalls(page({}, [call(), call(8)]), { limit: 1 }), assertApiError(502));
  assert.throws(() => client.validateUsageCalls(page({}, [call()], CURSOR), { cursor: CURSOR }), assertApiError(502));
  assert.throws(() => client.validateUsageCalls({ ...page(), more: true }), assertApiError(502));
});
for (const [label, query, callsQuery = false, code = 'USAGE_REQUEST_INVALID'] of [
  ['summary limit', { limit: 20 }], ['summary cursor', { cursor: CURSOR }], ['未知参数', { namespace: 'live' }],
  ['null 餐厅', { restaurant_id: null }], ['数组', []], ['非 owner ID 格式', { restaurant_id: 'short' }],
  ['feature', { feature: 'menu' }], ['origin', { origin: 'legacy' }], ['undefined field', { feature: undefined }],
  ['from 单边', { from: '2026-03-01' }, false, 'USAGE_RANGE_INVALID'], ['非闰年', { from: '2025-02-29', to: '2025-03-01' }, false, 'USAGE_RANGE_INVALID'],
  ['坏日期', { from: '2026-02-30', to: '2026-03-01' }, false, 'USAGE_RANGE_INVALID'], ['year zero', { from: '0000-01-01', to: '0000-01-01' }, false, 'USAGE_RANGE_INVALID'],
  ['时间戳日期', { from: NOW, to: NOW }, false, 'USAGE_RANGE_INVALID'], ['倒置', { from: '2026-03-02', to: '2026-03-01' }, false, 'USAGE_RANGE_INVALID'],
  ['367天', { from: '2026-01-01', to: '2027-01-02' }, false, 'USAGE_RANGE_INVALID'],
  ['limit 0', { limit: 0 }, true], ['limit 51', { limit: 51 }, true], ['limit 小数', { limit: 1.5 }, true], ['limit 字符串', { limit: '20' }, true],
  ['cursor null', { cursor: null }, true], ['cursor 空', { cursor: '' }, true], ['cursor 大', { cursor: 'a'.repeat(2049) }, true],
]) test(`请求在网络前拒绝${label}`, async () => {
  await assert.rejects(callsQuery ? client.readUsageCalls(query) : client.readUsage(query), assertApiError(400, code));
  assert.equal(calls.length, 0);
});
test('UTC 首尾 366 天、0001 与 9999 边界可用，日期不依赖本地时区', () => {
  for (const range of [['2026-01-01', '2027-01-01'], ['2024-02-29', '2024-02-29'], ['0001-01-01', '0001-01-01'], ['9999-12-31', '9999-12-31']]) {
    assert.doesNotThrow(() => client.validateUsageRange(...range));
  }
});
test('同源 GET session transport，summary 无 limit/cursor、calls 默认20/最大50，不修改请求快照', async () => {
  const query = { restaurant_id: RID, feature: 'menu_recognition', origin: 'live', from: '2026-03-01', to: '2026-03-01' };
  responder = request => {
    const params = queryOf(request), isCalls = urlOf(request).pathname.endsWith('/calls');
    assert.deepEqual(params, { ...query, ...(isCalls ? { limit: params.limit, ...(params.cursor ? { cursor: CURSOR } : {}) } : {}) });
    return response(isCalls ? page(query, [call()]) : report(query, [{ feature: 'menu_recognition', ...totals(1, 0, 0, 8, 2) }]));
  };
  const signal = new AbortController().signal;
  await client.readUsage(query, signal); await client.readUsageCalls(query, signal); await client.readUsageCalls({ ...query, limit: 50, cursor: CURSOR }, signal);
  calls.forEach(checkGet); assert.equal(queryOf(calls[1]).limit, '20'); assert.equal(queryOf(calls[2]).limit, '50');
  const late = deferred(); responder = () => late.promise;
  const mutable = { feature: 'menu_recognition' }, result = client.readUsage(mutable);
  mutable.feature = 'website_chat'; late.resolve(response(report({ feature: 'menu_recognition' }, [{ feature: 'menu_recognition', ...totals(1, 0, 0, 8, 2) }])));
  assert.equal((await result).filters.feature, 'menu_recognition');
});
test('401 Session 通知失效但不重放，timeout 和预取消均不伪成功', async () => {
  let expired = 0; const unsubscribe = transport.onSessionExpired(() => { expired += 1; });
  responder = () => response({ code: 'UNAUTHENTICATED' }, 401, { 'WWW-Authenticate': 'Session' });
  try { await assert.rejects(client.readUsage(), assertApiError(401, 'UNAUTHENTICATED')); } finally { unsubscribe(); }
  assert.equal(expired, 1); assert.equal(readRequests('/api/v1/ai/usage').length, 1);
  const cancelled = new AbortController(); cancelled.abort();
  const before = calls.length; await assert.rejects(client.readUsage({}, cancelled.signal), error => error.name === 'AbortError'); assert.equal(calls.length, before);
  responder = request => new Promise((_, reject) => request.options.signal.addEventListener('abort', () => reject(new Error('超时')), { once: true }));
  const timed = client.readUsage(); [...timers.values()][0].fn();
  await assert.rejects(timed, assertApiError(0, 'REQUEST_TIMEOUT'));
});
test('SSR 清楚显示部分 known / pending / unknown、UTC 与单列 legacy；不造余额支付或历史导航', () => {
  const unknown = call(8, { restaurant_name: null, usage_status: 'unknown', prompt_tokens: null, completion_tokens: null, total_tokens: null, elapsed_ms: null });
  const pending = call(7, { restaurant_name: null, call_status: 'started', usage_status: 'pending', prompt_tokens: null, completion_tokens: null, total_tokens: null, elapsed_ms: null, finished_at: null });
  const knownZero = call(6, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  const html = markup(report(), [call(), unknown, pending, knownZero, call(5, { origin: 'legacy_import', feature: 'website_generate' })]);
  const doc = parseFragment(html), allText = text(doc);
  for (const label of ['Account shared', 'Known credit usage', 'Model calls', 'Pending', 'Unknown', 'Filtered usage', 'Legacy aggregate', 'may be partial, not a final total', 'not a credit balance', 'UTC', 'Name unavailable', 'Imported legacy']) {
    assert.ok(allText.includes(label), label);
  }
  assert.equal(nodes(doc, node => node.tagName === 'a').length, 0);
  assert.equal(nodes(doc, node => node.tagName === 'button' || node.tagName === 'input').length, 0);
  const callTable = nodes(doc, node => node.tagName === 'table')[1], body = nodes(callTable, node => node.tagName === 'tbody')[0];
  const rows = nodes(body, node => node.tagName === 'tr').map(row => row.childNodes.filter(node => ['td', 'th'].includes(node.tagName)).map(text));
  assert.deepEqual(rows[1].slice(3, 7), ['—', '—', '—', '—']); assert.deepEqual(rows[3].slice(3, 6), ['0', '0', '0']);
  assert.equal(rows[1].at(-1), 'completedunknown'); assert.equal(rows[2].at(-1), 'startedpending');
  assert.doesNotMatch(allText, /Buy tokens|Top up|Checkout|Available balance|\$|Payment enabled/i);
  assert.equal(calls.length, 0);
});
test('SSR overview只保留一组指标，解释及历史聚合默认折叠，调用标识保留可展开', () => {
  const doc = parseFragment(markup());
  const metrics = nodes(doc, node => attr(node, 'class') === 'usage-metrics');
  assert.equal(metrics.length, 1);
  const folded = nodes(doc, node => node.tagName === 'details');
  assert.ok(folded.length >= 3);
  assert.ok(folded.every(node => attr(node, 'open') === undefined));
  assert.ok(folded.some(node => text(node).includes('not a credit balance')));
  assert.ok(folded.some(node => text(node).includes('Legacy aggregate')));
  assert.ok(folded.some(node => text(node).includes(call().id) && text(node).includes(call().job_id)));
  assert.ok(text(doc).includes('0.1 known credits · 3 calls'));
});

test('CSS 可解析且限定Usage，沿用管理页灰细线、正文14px、次级小字与黑主按钮', () => {
  const cssTree = require('css-tree'), selectors = [], declarations = [];
  const tree = cssTree.parse(readFileSync(resolve(root, 'src/usage-page.css'), 'utf8'), { onParseError(error) { throw error; } });
  cssTree.walk(tree, { enter(node) {
    if (node.type === 'Rule') node.prelude.children.forEach(selector => selectors.push(cssTree.generate(selector)));
    if (node.type === 'Declaration') declarations.push([node.property, cssTree.generate(node.value).trim()]);
  } });
  assert.ok(selectors.every(selector => selector.startsWith('.usage-page')));
  assert.ok(declarations.some(([key, value]) => key === 'background' && value === '#fff'));
  assert.ok(declarations.some(([key, value]) => key === '--usage-line' && value === '#dedede'));
  assert.ok(declarations.some(([key, value]) => key === 'font-size' && value === '14px'));
  assert.ok(selectors.includes('.usage-page button.usage-primary'));
  assert.ok(selectors.includes('.usage-page .usage-heading'));
  assert.ok(selectors.includes('.usage-page .usage-table-scroll'));
  assert.ok(declarations.some(([key, value]) => key === 'color-scheme' && value === 'light'));
  assert.ok(!declarations.some(([key, value]) => key === 'border' && value === '1px solid #111'));
});

// 与 operations 相同的 slot/cleanup 调度；子组件不由 harness 伪造并发调度。
function hooksHarness(filename, initialProps, options = {}) {
  const slots = [], updates = [];
  let index = 0, expectedHooks = null, renderNeeded = false, disposed = false, props = initialProps, tree;
  const same = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  function slot(kind, initialize) {
    const position = index++; if (!slots[position]) slots[position] = { kind, ...initialize() };
    assert.equal(slots[position].kind, kind); return slots[position];
  }
  const stub = { ...React,
    useState(initial) {
      const item = slot('state', () => ({ value: typeof initial === 'function' ? initial() : initial }));
      item.set ??= next => {
        assert.ok(!disposed, '卸载后禁止 setState');
        const value = typeof next === 'function' ? next(item.value) : next;
        updates.push(value); if (!Object.is(value, item.value)) { item.value = value; renderNeeded = true; }
      };
      return [item.value, item.set];
    },
    useRef(initial) { return slot('ref', () => ({ value: { current: initial } })).value; },
    useId() { return slot('id', () => ({ value: `usage-fixture-${index}` })).value; },
    useEffect(callback, deps) {
      const item = slot('effect', () => ({ deps: undefined, cleanup: undefined, pending: false }));
      if (!same(item.deps, deps)) { item.deps = deps; item.callback = callback; item.pending = true; }
    },
    useCallback(callback, deps) {
      const item = slot('callback', () => ({ deps: undefined, value: callback }));
      if (!same(item.deps, deps)) { item.deps = deps; item.value = callback; } return item.value;
    },
  };
  const injected = new Set((options.reactModules ?? []).map(name => resolve(root, 'src', name))), isolatedModules = new Map();
  function compile(path) {
    if (isolatedModules.has(path)) return isolatedModules.get(path).exports;
    const isolated = new Module(path, require.cache[require.resolve('react')]);
    isolated.filename = path; isolated.paths = Module._nodeModulePaths(dirname(path)); isolatedModules.set(path, isolated);
    const localRequire = createRequire(path);
    isolated.require = name => { if (name === 'react') return stub; const dependency = localRequire.resolve(name); return injected.has(dependency) ? compile(dependency) : localRequire(name); };
    isolated._compile(compiledSource(path), path); return isolated.exports;
  }
  const exports = compile(resolve(root, 'src', filename));
  const Component = (options.select ?? (value => value.default))(exports);
  function render() {
    assert.ok(!disposed); index = 0; renderNeeded = false; tree = Component(props);
    expectedHooks ??= index; assert.equal(index, expectedHooks); return tree;
  }
  function commit() {
    for (let guard = 0; guard < 20; guard += 1) {
      if (renderNeeded) render();
      for (const item of slots) if (item.kind === 'effect' && item.pending) { item.pending = false; item.cleanup?.(); item.cleanup = item.callback(); }
      if (!renderNeeded) return;
    }
    assert.fail('harness 渲染未稳定');
  }
  function expanded(node) {
    if (Array.isArray(node)) return node.map(expanded);
    if (!React.isValidElement(node)) return node;
    if (typeof node.type === 'function' && options.expandChildren !== false) return expanded(node.type(node.props));
    return { type: node.type, key: node.key, props: { ...node.props, children: expanded(node.props.children) } };
  }
  function elements(predicate) {
    const result = [];
    function walk(node) {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== 'object' || !node.props) return;
      if (predicate(node)) result.push(node); walk(node.props.children);
    }
    walk(expanded(tree)); return result;
  }
  function content(node) {
    if (Array.isArray(node)) return node.map(content).join('');
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    return typeof node === 'object' ? content(node.props?.children) : String(node);
  }
  const h = { get tree() { return tree; }, slots, updates, elements, content, commit,
    text() { return content(expanded(tree)); },
    button(label) { const matches = elements(node => node.type === 'button' && content(node) === label); assert.equal(matches.length, 1, label); return matches[0]; },
    click(label) { const node = h.button(label); assert.ok(!node.props.disabled); node.props.onClick(); commit(); },
    change(suffix, value) { const matches = elements(node => ['select', 'input'].includes(node.type) && node.props.id?.endsWith(suffix)); assert.equal(matches.length, 1); assert.ok(!matches[0].props.disabled); matches[0].props.onChange({ target: { value, checked: value } }); commit(); },
    submit() { const form = elements(node => node.type === 'form'); assert.equal(form.length, 1); form[0].props.onSubmit({ preventDefault() {} }); commit(); },
    renderProps(next) { props = { ...props, ...next }; render(); },
    setProps(next) { h.renderProps(next); commit(); },
    async settle() { await turn(); if (!disposed) commit(); },
    unmount() { if (disposed) return; for (const item of slots) if (item.kind === 'effect') { item.cleanup?.(); item.cleanup = undefined; } disposed = true; harnesses.delete(h); },
  };
  render(); commit(); harnesses.add(h); return h;
}
function reader(props = {}) {
  return hooksHarness('UsagePage.tsx', { userId: UID, busy: false, ...props }, { select: value => value.default({ userId: UID, active: true, busy: false }).type });
}

function balance(props = {}) {
  return hooksHarness('TokenBalance.tsx', { userId: UID, active: true, refreshKey: '/app', navigate() {}, busy: false, ...props });
}
test('TokenBalanceView available SSR只接受安全number，以真实积分余额为可访问文字', () => {
  const View = load('TokenBalance.tsx').TokenBalanceView;
  for (const [availableTokens, expected] of [[1000000, '10,000'], [999000, '9,990'], [999999, '9,999.99'], [0, '0'], [-1, '-0.01']]) {
    const doc = parseFragment(renderToStaticMarkup(React.createElement(View, { state: 'available', availableTokens, busy: false, navigate() {} })));
    assert.equal(text(doc), `Credits left · ${expected}`);
    assert.equal(attr(nodes(doc, node => node.tagName === 'a')[0], 'href'), '/account/usage');
    assert.equal(nodes(doc, node => attr(node, 'aria-live') === 'polite').length, 1);
    assert.doesNotMatch(text(doc), /1000000|1,000,000|tokens|bla_|usr_|aqp_/);
  }
  for (const availableTokens of [undefined, null, '1000000', 1000000n, NaN, Infinity, 0.01, Number.MAX_SAFE_INTEGER + 1]) {
    const html = renderToStaticMarkup(React.createElement(View, { state: 'available', availableTokens, busy: false, navigate() {} }));
    assert.equal(text(parseFragment(html)), 'Credits left · Unavailable');
  }
});
test('已授额顶栏顺序刷新真实余额，暂停取消定时器且不重复读取', async () => {
  setupResponses({ summary: configuredReport() }); const h = balance(); await h.settle();
  assert.equal(h.text(), 'Credits left · 10,000');
  const poll = [...timers.entries()].filter(([, item]) => item.ms === 30_000);
  assert.equal(poll.length, 1);
  setupResponses({ summary: configuredReport({}, 1000, 0, totals(1, 0, 0, 1000, 0)) });
  const [timerId, timer] = poll[0]; timers.delete(timerId); timer.fn(); await h.settle();
  assert.equal(h.text(), 'Credits left · 9,990'); assert.equal(calls.length, 2);
  h.setProps({ active: false });
  assert.equal(h.text(), '');
  assert.equal([...timers.values()].filter(item => item.ms === 30_000).length, 0);
});
test('同用户首次null授额后refresh只一个GET返回真实10000，新消费1000返回9990', async () => {
  setupResponses(); const h = balance(); await h.settle(); assert.equal(h.text(), 'Credits left · Not configured');
  setupResponses({ summary: configuredReport() }); h.setProps({ refreshKey: '/account/usage' });
  assert.equal(h.text(), 'Credits left · —'); await h.settle(); assert.equal(h.text(), 'Credits left · 10,000');
  setupResponses({ summary: configuredReport({}, 1000, 0, totals(1, 0, 0, 1000, 0)) });
  h.renderProps({ refreshKey: '/app/analytics' }); assert.equal(h.text(), 'Credits left · —'); h.commit(); await h.settle();
  assert.equal(h.text(), 'Credits left · 9,990');
  assert.equal(calls.length, 3); calls.forEach(checkGet); assert.ok(calls.every(request => request.url === '/api/v1/ai/usage'));
  assert.equal(text(parseFragment(renderToStaticMarkup(h.tree))), h.text());
});
for (const change of ['refresh', 'user', 'inactive']) for (const outcome of ['success', 'failure']) test(`configured余额${change}首次render隔离，cleanup前晚${outcome}不setState`, async () => {
  setupResponses({ summary: configuredReport() }); const h = balance(); await h.settle(); assert.equal(h.text(), 'Credits left · 10,000');
  const late = deferred(); responder = () => late.promise; h.setProps({ refreshKey: '/pending' });
  const request = calls.at(-1);
  const patch = change === 'refresh' ? { refreshKey: '/fresh' } : change === 'user' ? { userId: UID2 } : { active: false };
  h.renderProps(patch); assert.equal(h.text(), change === 'inactive' ? '' : 'Credits left · —');
  const updates = h.updates.length;
  if (outcome === 'success') late.resolve(response(configuredReport({}, 1000, 0, totals(1, 0, 0, 1000, 0)))); else late.reject(new Error('STALE_PRIVATE'));
  await turn(); assert.equal(h.updates.length, updates);
  setupResponses({ summary: configuredReport({}, 1, 0, totals(1, 0, 0, 1, 0)) }); h.commit();
  // 旧响应已结束，transport 已解除转发监听；不把已结束请求的包装 signal 当组件控制器。
  // cleanup 对仍在途请求的 abort 由下方原有 activefalse / unmount 测试覆盖。
  if (change === 'inactive') { assert.equal(calls.length, 2); h.setProps({ active: true }); }
  await h.settle(); assert.equal(h.text(), 'Credits left · 9,999.99'); assert.equal(calls.length, 3);
  assert.notEqual(request.options.signal, calls.at(-1).options.signal);
});
test('configured余额卸载后晚成功不setState，invalid root不信任局部正确quota', async () => {
  const late = deferred(); responder = () => late.promise; const h = balance(); h.unmount(); const updates = h.updates.length;
  late.resolve(response(configuredReport())); await turn(); assert.equal(h.updates.length, updates); assert.ok(calls[0].options.signal.aborted);
  const data = configuredReport(); data.filtered_totals.calls += 1;
  setupResponses({ summary: data }); const fresh = balance(); await fresh.settle(); assert.equal(fresh.text(), 'Credits left · Unavailable');
  assert.equal(calls.length, 2);
});
test('UsageReader refresh重新读真实quota，不多请求，草稿历史filters不改变余额或当前月计数', async () => {
  setupResponses({ summary: configuredReport(), first: page({}, [call()]) }); const h = reader(); await h.settle();
  assert.match(h.text(), /This calendar month · UTC/); assert.equal(readRequests('/api/v1/ai/usage').length, 1);
  assert.deepEqual(queryOf(readRequests('/api/v1/ai/usage')[0]), {});
  h.change('-dates', true); h.change('-from', '2026-03-01'); h.change('-to', '2026-03-01');
  assert.match(h.text(), /Unapplied filter changes/);
  setupResponses({ summary: configuredReport({}, 1000, 0, totals(1, 2, 1, 1000, 0)) });
  h.click('Refresh report'); await h.settle();
  assert.deepEqual(queryOf(readRequests('/api/v1/ai/usage').at(-1)), {}); assert.match(h.text(), /9,990/); assert.match(h.text(), /4 calls since grant/);
  const query = { from: '2026-03-01', to: '2026-03-01' }, selected = configuredReport(query, 1000, 0, totals(1, 2, 1, 1000, 0));
  selected.filtered_totals = totals(); selected.by_feature = [];
  setupResponses({ summary: selected, first: page(query, []) }); h.submit(); await h.settle();
  assert.deepEqual(queryOf(readRequests('/api/v1/ai/usage').at(-1)), query);
  assert.match(h.text(), /9,990/); assert.match(h.text(), /4 calls since grant/); assert.doesNotMatch(h.text(), /Unapplied filter changes/);
  assert.equal(readRequests('/api/v1/ai/usage').length, 3); assert.equal(readRequests('/api/v1/ai/usage/calls').length, 3);
  assert.equal(readRequests('/api/v1/restaurants').length, 1); assert.equal(calls.length, 7); calls.forEach(checkGet);
});
test('UsageReader已读configured新refresh晚包不覆盖，换用户先隐藏月余额，inactive卸载不恢复', async () => {
  setupResponses({ summary: configuredReport() }); const h = reader(); await h.settle(); assert.match(h.text(), /10,000/);
  const late = deferred(); responder = () => late.promise; h.click('Refresh report'); assert.doesNotMatch(h.text(), /10,000|This calendar month/);
  setupResponses({ summary: configuredReport({}, 1, 0, totals(1, 0, 0, 1, 0)) }); h.click('Refresh report'); await h.settle(); assert.match(h.text(), /9,999.99/);
  const before = h.updates.length; late.resolve(response(configuredReport())); await h.settle(); assert.equal(h.updates.length, before);
  setupResponses(); h.renderProps({ userId: UID2 }); assert.doesNotMatch(h.text(), /9,999.99|This calendar month/); h.commit(); await h.settle();
  assert.match(h.text(), /Account shared · all time/); assert.doesNotMatch(h.text(), /9,999.99/);
  const last = deferred(); responder = () => last.promise; h.click('Refresh report'); h.unmount(); const updates = h.updates.length;
  last.resolve(response(configuredReport())); await turn(); assert.equal(h.updates.length, updates);
  assert.equal(views.default({ userId: UID2, active: false, busy: false }), null);
});
function followBalance(h) {
  const links = h.elements(node => node.type === 'a' && node.props.className === 'management-token-balance');
  assert.equal(links.length, 1);
  let prevented = 0;
  links[0].props.onClick({ button: 0, preventDefault() { prevented += 1; } });
  assert.equal(prevented, 1);
  return links[0];
}
for (const [state, value] of [['loading', '—'], ['not_configured', 'Not configured'], ['unavailable', 'Unavailable']]) {
  test(`TokenBalanceView 真实 SSR：${state} 只显示状态，不造余额或暴露账户`, () => {
    const doc = parseFragment(renderToStaticMarkup(React.createElement(load('TokenBalance.tsx').TokenBalanceView, { state, busy: false, navigate() {} })));
    assert.equal(text(doc), `Credits left · ${value}`);
    const links = nodes(doc, node => node.tagName === 'a');
    assert.equal(links.length, 1); assert.equal(attr(links[0], 'href'), '/account/usage');
    assert.equal(attr(links[0], 'class'), 'management-token-balance');
    assert.equal(nodes(doc, node => attr(node, 'aria-live') === 'polite').length, 1);
    assert.doesNotMatch(text(doc), /[0-9]|∞|infinite|unlimited|used|owner@|bla_|usr_|csrf/i);
    assert.equal(calls.length, 0);
  });
}
test('TokenBalance 真实组件 SSR：初始破折号、inactive 返回空，不运行读取 effect', () => {
  const Component = load('TokenBalance.tsx').default;
  const props = { userId: UID, active: true, refreshKey: '/app', busy: false, navigate() {} };
  assert.equal(text(parseFragment(renderToStaticMarkup(React.createElement(Component, props)))), 'Credits left · —');
  assert.equal(renderToStaticMarkup(React.createElement(Component, { ...props, active: false })), '');
  assert.equal(calls.length, 0);
});
test('TokenBalance 真实 readUsage GET 全账户 quota null→Not configured，不把观测或 legacy 用量当剩余', async () => {
  setupResponses(); const h = balance();
  assert.equal(h.text(), 'Credits left · —'); await h.settle();
  assert.equal(h.text(), 'Credits left · Not configured');
  assert.equal(text(parseFragment(renderToStaticMarkup(h.tree))), h.text());
  assert.deepEqual(calls.map(request => request.url), ['/api/v1/ai/usage']);
  checkGet(calls[0]); assert.deepEqual(queryOf(calls[0]), {});
  assert.equal(calls[0].options.headers.get('Idempotency-Key'), null);
  assert.doesNotMatch(h.text(), /[0-9]|∞|infinite|unlimited|used|bla_|usr_|csrf/i);
  h.setProps({ busy: true }); h.setProps({ busy: false, navigate() {} }); await h.settle();
  assert.equal(calls.length, 1, 'busy 和 navigate 的变化不能重复读取');
});
test('TokenBalance 初始 inactive 不读账户，暂停期间改路由/用户也不请求', async () => {
  const h = balance({ active: false }); assert.equal(h.tree, null); assert.equal(calls.length, 0);
  h.setProps({ userId: UID2, refreshKey: '/account/usage', busy: true }); await h.settle();
  assert.equal(h.tree, null); assert.equal(calls.length, 0);
  setupResponses(); h.setProps({ active: true, busy: false }); assert.equal(h.text(), 'Credits left · —'); await h.settle();
  assert.equal(h.text(), 'Credits left · Not configured'); assert.equal(calls.length, 1); checkGet(calls[0]);
});
for (const failure of ['network', 'http', 'unauthenticated', 'invalid-private-response', 'quota-field-missing']) test(`TokenBalance GET ${failure}→Unavailable，不显错误私文也不自动重试`, async () => {
  responder = () => {
    if (failure === 'network') return Promise.reject(new TypeError('PRIVATE_ERROR_TEXT'));
    if (failure === 'http') return response({ code: 'SERVICE_UNAVAILABLE', message: 'PRIVATE_ERROR_TEXT' }, 503);
    if (failure === 'unauthenticated') return response({ code: 'UNAUTHENTICATED', message: 'PRIVATE_ERROR_TEXT' }, 401, { 'WWW-Authenticate': 'Session' });
    if (failure === 'invalid-private-response') return response({ ...report(), private_input: 'PRIVATE_ERROR_TEXT' });
    const data = report(); delete data.quota.available_tokens; return response(data);
  };
  const h = balance(); assert.equal(h.text(), 'Credits left · —'); await h.settle();
  assert.equal(h.text(), 'Credits left · Unavailable');
  assert.doesNotMatch(renderToStaticMarkup(h.tree), /PRIVATE_ERROR_TEXT|owner@|bla_|usr_|csrf|[0-9]/);
  await h.settle(); assert.equal(readRequests('/api/v1/ai/usage').length, 1); checkGet(calls[0]);
  assert.deepEqual(calls.map(request => request.url), failure === 'unauthenticated'
    ? ['/api/v1/ai/usage', '/api/v1/auth/csrf'] : ['/api/v1/ai/usage']);
});
for (const change of ['route', 'user']) for (const lateResult of ['success', 'failure']) {
  test(`TokenBalance ${change} 改变只新增一个 account GET，旧晚${lateResult}不能污染新状态`, async () => {
    const old = deferred(), fresh = deferred(); let round = 0;
    responder = () => ++round === 1 ? old.promise : fresh.promise;
    const h = balance(); const oldRequest = calls[0];
    const next = change === 'route' ? { refreshKey: '/app/analytics' } : { userId: UID2 };
    h.renderProps(next); assert.equal(h.text(), 'Credits left · —'); h.commit();
    assert.ok(oldRequest.options.signal.aborted); assert.equal(calls.length, 2);
    assert.notEqual(calls[0].options.signal, calls[1].options.signal);
    calls.forEach(request => { checkGet(request); assert.equal(request.url, '/api/v1/ai/usage'); assert.deepEqual(queryOf(request), {}); });
    fresh.resolve(response({ code: 'SERVICE_UNAVAILABLE' }, 503)); await h.settle();
    assert.equal(h.text(), 'Credits left · Unavailable'); const updates = h.updates.length;
    if (lateResult === 'success') old.resolve(response(report())); else old.reject(new TypeError('STALE_PRIVATE_ERROR'));
    await h.settle(); assert.equal(h.updates.length, updates); assert.equal(h.text(), 'Credits left · Unavailable');
    h.setProps(next); await h.settle(); assert.equal(calls.length, 2);
    setupResponses(); h.setProps(change === 'route' ? { refreshKey: '/account/sessions' } : { userId: UID }); await h.settle();
    assert.equal(calls.length, 3); assert.equal(h.text(), 'Credits left · Not configured');
  });
}
test('TokenBalance 已加载用户切换首次 render 不泄漏前用户状态，commit 后只读取新账户', async () => {
  setupResponses(); const h = balance(); await h.settle(); assert.equal(h.text(), 'Credits left · Not configured');
  const next = deferred(); responder = () => next.promise;
  h.renderProps({ userId: UID2 }); assert.equal(h.text(), 'Credits left · —'); assert.equal(calls.length, 1);
  h.commit(); assert.equal(calls.length, 2); assert.equal(calls[1].options.signal.aborted, false);
  assert.notEqual(calls[0].options.signal, calls[1].options.signal);
  next.resolve(response(report())); await h.settle(); assert.equal(h.text(), 'Credits left · Not configured');
});
for (const lateResult of ['success', 'failure']) test(`TokenBalance activefalse 立即空树，abort 后晚${lateResult}不更新或重放，resume 新 GET`, async () => {
  setupResponses(); const h = balance(); await h.settle();
  const late = deferred(), resumed = deferred(); responder = () => late.promise;
  h.setProps({ refreshKey: '/account/usage' }); assert.equal(h.text(), 'Credits left · —');
  const request = calls.at(-1);
  h.renderProps({ active: false }); assert.equal(h.tree, null); assert.equal(h.text(), '');
  assert.equal(renderToStaticMarkup(h.tree), ''); h.commit(); assert.ok(request.options.signal.aborted);
  const updates = h.updates.length;
  if (lateResult === 'success') late.resolve(response(report())); else late.reject(new TypeError('STALE_PRIVATE_ERROR'));
  await h.settle(); assert.equal(h.updates.length, updates); assert.equal(h.tree, null); assert.equal(calls.length, 2);
  h.setProps({ refreshKey: '/app/analytics', userId: UID2 }); assert.equal(h.tree, null); assert.equal(calls.length, 2);
  responder = () => resumed.promise; h.setProps({ active: true });
  assert.equal(h.text(), 'Credits left · —'); assert.equal(calls.length, 3);
  resumed.resolve(response(report())); await h.settle(); assert.equal(h.text(), 'Credits left · Not configured');
  assert.ok(calls.every(request => request.url === '/api/v1/ai/usage'));
});
for (const lateResult of ['success', 'failure']) test(`TokenBalance 卸载 abort，晚${lateResult}不 setState 或重新请求`, async () => {
  const late = deferred(); responder = () => late.promise;
  const h = balance(); h.unmount(); assert.ok(calls[0].options.signal.aborted); const updates = h.updates.length;
  if (lateResult === 'success') late.resolve(response(report())); else late.reject(new TypeError('LATE_PRIVATE_ERROR'));
  await turn(); assert.equal(h.updates.length, updates); assert.equal(calls.length, 1);
});
test('TokenBalance busy 只禁 PageLink 导航，GET flight 不因此取消或刷新', async () => {
  const late = deferred(), navigations = []; responder = () => late.promise;
  const h = balance({ navigate(path) { navigations.push(path); } });
  followBalance(h); assert.deepEqual(navigations, ['/account/usage']);
  h.setProps({ busy: true }); const link = followBalance(h);
  assert.equal(link.props['aria-disabled'], true); assert.equal(link.props.tabIndex, -1);
  assert.deepEqual(navigations, ['/account/usage']); assert.equal(calls.length, 1); assert.equal(calls[0].options.signal.aborted, false);
  late.resolve(response(report())); await h.settle(); assert.equal(h.text(), 'Credits left · Not configured');
  h.setProps({ busy: false }); const enabled = followBalance(h); assert.equal(enabled.props['aria-disabled'], undefined);
  assert.deepEqual(navigations, ['/account/usage', '/account/usage']); assert.equal(calls.length, 1);
});

function appBalanceElement(app) {
  const matches = app.elements(node => node.type === load('TokenBalance.tsx').default);
  assert.equal(matches.length, 1); return matches[0];
}
function appDashboardElement(app) {
  const matches = app.elements(node => node.type === load('Dashboard.tsx').default);
  assert.equal(matches.length, 1); return matches[0];
}
for (const configured of [false, true]) test(`App 顶栏真实 TokenBalance ${configured ? '配置余额' : '未知余额'}，路由 props 和 dirty navigation 保留`, async () => {
  setupResponses({ summary: configured ? configuredReport() : report(), extra: request => request.url === '/api/v1/auth/me' ? response(session()) : response({ supported_locales: ['en'] }) });
  window.location.pathname = '/app';
  const app = hooksHarness('App.tsx', { initialRoute: routes.readRoute() }, { reactModules: ['ui.tsx'], expandChildren: false }); await app.settle();
  const header = app.elements(node => node.type === 'header' && node.props.className === 'management-header'); assert.equal(header.length, 1);
  assert.equal(app.content(header[0]), ''); assert.doesNotMatch(app.content(header[0]), /owner@example|Chome/);
  const main = app.elements(node => node.type === 'main' && node.props.id === 'main'); assert.equal(main.length, 1);
  assert.equal(main[0].props.className, 'restaurant-workspace-main');
  const context = app.elements(node => node.props.className === 'management-header-context'); assert.equal(context.length, 1);
  const target = { nodeType: 1 }; context[0].props.ref(target); app.commit();
  assert.equal(appDashboardElement(app).props.headerTarget, target);
  const token = appBalanceElement(app); assert.equal(token.key, UID); assert.equal(token.props.userId, UID);
  assert.equal(token.props.active, true); assert.equal(token.props.refreshKey, '/app'); assert.equal(token.props.busy, false);
  const h = balance(token.props); await h.settle(); assert.equal(h.text(), configured ? 'Credits left · 10,000' : 'Credits left · Not configured');
  const pushes = [], originalPush = window.history.pushState;
  window.history.pushState = function (...args) { pushes.push(args[2]); originalPush.apply(this, args); };
  appDashboardElement(app).props.onDirtyChange(true); app.commit();
  h.setProps(appBalanceElement(app).props); followBalance(h); app.commit();
  assert.match(app.text(), /Leave your unsaved changes/); assert.deepEqual(pushes, []); assert.equal(window.location.pathname, '/app');
  app.click('Keep editing'); assert.equal(appDashboardElement(app).props.active, true); assert.deepEqual(pushes, []);
  h.setProps(appBalanceElement(app).props); followBalance(h); app.commit(); app.click('Discard and leave');
  assert.deepEqual(pushes, ['/account/usage']); assert.equal(window.location.pathname, '/account/usage');
  h.setProps(appBalanceElement(app).props); await h.settle(); assert.equal(readRequests('/api/v1/ai/usage').length, 2);
  assert.equal(appBalanceElement(app).props.refreshKey, '/account/usage');
});
test('App 同账户退出完成边界：头部移除 TokenBalance/邮箱，登录后新组件不复用旧读取', async () => {
  setupResponses({ extra: request => request.url === '/api/v1/auth/me' ? response(session()) : response({ supported_locales: ['en'] }) });
  window.location.pathname = '/account/sessions';
  const app = hooksHarness('App.tsx', { initialRoute: routes.readRoute() }, { reactModules: ['ui.tsx'], expandChildren: false }); await app.settle();
  const late = deferred(); responder = () => late.promise;
  const h = balance(appBalanceElement(app).props);
  const settings = app.elements(node => typeof node.type === 'function' && node.props.onLoggedOut);
  assert.equal(settings.length, 1);
  // 直接触发真实 App 接收的退出完成回调，不伪称已执行密码表单或网络写入。
  settings[0].props.onLoggedOut(); app.commit();
  assert.equal(window.location.pathname, '/auth/login');
  assert.equal(app.elements(node => node.type === load('TokenBalance.tsx').default).length, 0);
  assert.equal(app.elements(node => node.props.className === 'management-header').length, 0);
  assert.doesNotMatch(app.text(), /owner@example|Credits left|Not configured/);
  h.unmount(); const updates = h.updates.length; assert.ok(readRequests('/api/v1/ai/usage')[0].options.signal.aborted);
  late.resolve(response(report())); await app.settle(); assert.equal(h.updates.length, updates);
  assert.equal(readRequests('/api/v1/ai/usage').length, 1);
  const auth = app.elements(node => typeof node.type === 'function' && node.props.onLogin)[0]; assert.ok(auth);
  setupResponses(); auth.props.onLogin(session()); app.commit();
  const returned = appBalanceElement(app); assert.equal(returned.key, UID); assert.equal(returned.props.refreshKey, '/app');
  const fresh = balance(returned.props); assert.equal(fresh.text(), 'Credits left · —'); await fresh.settle();
  assert.equal(fresh.text(), 'Credits left · Not configured'); assert.equal(readRequests('/api/v1/ai/usage').length, 2);
});

test('App 同账户脏稿 session 失效：隐藏 workspace，头部不保邮箱/余额；重新登录只新 GET', async () => {
  setupResponses({ extra: request => request.url === '/api/v1/auth/me' ? response(session()) : response({ supported_locales: ['en'] }) });
  window.location.pathname = '/app';
  const app = hooksHarness('App.tsx', { initialRoute: routes.readRoute() }, { reactModules: ['ui.tsx'], expandChildren: false }); await app.settle();
  const h = balance(appBalanceElement(app).props); await h.settle();
  appDashboardElement(app).props.onDirtyChange(true); app.commit();
  const late = deferred(); responder = () => late.promise;
  appDashboardElement(app).props.onDirtyChange(false); app.commit();
  window.location.pathname = '/app/analytics'; window.emit('popstate'); app.commit();
  h.setProps(appBalanceElement(app).props); appDashboardElement(app).props.onDirtyChange(true); app.commit();
  const request = readRequests('/api/v1/ai/usage').at(-1);
  transport.notifySessionExpired(); app.commit();
  assert.equal(app.elements(node => node.type === load('TokenBalance.tsx').default).length, 0);
  const header = app.elements(node => node.type === 'header' && node.props.className === 'management-header'); assert.equal(header.length, 1);
  assert.equal(app.content(header[0]), ''); assert.doesNotMatch(app.content(header[0]), /owner@example|Credits left|Not configured/);
  assert.equal(appDashboardElement(app).props.active, false); assert.equal(appDashboardElement(app).props.busy, true);
  assert.equal(app.elements(node => node.props.hidden === true && node.key === 'saved-workspace').length, 1);
  // harness 不负责 reconciliation；按 App 的真实移除边界卸载子组件。
  h.unmount(); assert.ok(request.options.signal.aborted); const updates = h.updates.length;
  late.resolve(response(report())); await app.settle(); assert.equal(h.updates.length, updates);
  const before = readRequests('/api/v1/ai/usage').length;
  assert.equal(before, 2); assert.equal(app.elements(node => node.type === load('TokenBalance.tsx').default).length, 0);
  const auth = app.elements(node => typeof node.type === 'function' && node.props.onLogin)[0]; assert.ok(auth);
  setupResponses(); auth.props.onLogin(session()); app.commit();
  const returned = appBalanceElement(app); assert.equal(returned.key, UID); assert.equal(returned.props.refreshKey, '/app/analytics');
  const fresh = balance(returned.props); assert.equal(fresh.text(), 'Credits left · —'); await fresh.settle();
  assert.equal(fresh.text(), 'Credits left · Not configured'); assert.equal(readRequests('/api/v1/ai/usage').length, before + 1);
  assert.equal(appDashboardElement(app).props.active, true);
});

test('初次仅 alltime GET，显式餐厅翻页每次20，owner/可用限定，UI 不自动拉100家', async () => {
  setupResponses({ restaurants: (_, url) => url.searchParams.has('cursor')
    ? { items: [owner(21), owner(22, { status: 'archived' })], next_cursor: null, has_more: false }
    : { items: Array.from({ length: 20 }, (_, index) => owner(index + 1)), next_cursor: 'restaurant_cursor_20', has_more: true } });
  const h = reader(); await h.settle();
  assert.equal(readRequests('/api/v1/restaurants').length, 1);
  assert.deepEqual(queryOf(readRequests('/api/v1/restaurants')[0]), { limit: '20' });
  assert.deepEqual(queryOf(readRequests('/api/v1/ai/usage')[0]), {});
  assert.deepEqual(queryOf(readRequests('/api/v1/ai/usage/calls')[0]), { limit: '20' });
  assert.ok(h.elements(node => node.props.id?.endsWith('-dates'))[0].props.checked === false);
  h.click('Load more restaurants'); await h.settle();
  assert.equal(readRequests('/api/v1/restaurants').length, 2);
  assert.deepEqual(queryOf(readRequests('/api/v1/restaurants')[1]), { limit: '20', cursor: 'restaurant_cursor_20' });
  assert.equal(h.elements(node => node.type === 'option' && node.props.value === owner(21).id).length, 1);
  assert.equal(h.elements(node => node.type === 'option' && node.props.value === owner(22).id).length, 0);
  const query = { restaurant_id: owner(21).id };
  setupResponses({ summary: report(query), first: page(query, [call(9, { restaurant_id: query.restaurant_id })]) });
  h.change('-restaurant', query.restaurant_id); h.submit(); await h.settle();
  assert.equal(queryOf(readRequests('/api/v1/ai/usage').at(-1)).restaurant_id, query.restaurant_id);
  assert.equal(readRequests('/api/v1/restaurants').length, 2);
  calls.forEach(checkGet);
});
test('list 错 owner / 循环 cursor / 过大页显式报错，不选择后台任意ID', async () => {
  for (const restaurants of [
    { items: [owner(1, { role: 'editor' })], next_cursor: null, has_more: false },
    { items: Array.from({ length: 21 }, (_, index) => owner(index + 1)), next_cursor: null, has_more: false },
    { items: [owner()], next_cursor: null, has_more: true },
  ]) {
    setupResponses({ restaurants }); const h = reader(); await h.settle();
    assert.match(h.text(), /Restaurant list:.*failed validation/);
    h.change('-restaurant', RID2); const before = calls.length; h.submit(); assert.equal(calls.length, before);
    h.unmount();
  }
  setupResponses({ restaurants: { items: [owner()], next_cursor: 'repeat', has_more: true } });
  const h = reader(); await h.settle(); h.click('Load more restaurants'); await h.settle();
  assert.match(h.text(), /Restaurant list:.*failed validation/);
  assert.equal(readRequests('/api/v1/restaurants').length, 5);
});
test('apply 可打断 flight；旧 calls 晚回包不覆盖新 UTC range；错误标题不搭旧报告', async () => {
  const oldCalls = deferred(), newSummary = deferred(), newCalls = deferred();
  setupResponses();
  const base = responder;
  responder = request => urlOf(request).pathname === '/api/v1/ai/usage/calls' ? oldCalls.promise : base(request);
  const h = reader(); await h.settle();
  h.change('-dates', true); h.change('-from', '2026-03-04'); h.change('-to', '2026-03-04');
  const query = { from: '2026-03-04', to: '2026-03-04' };
  responder = request => urlOf(request).pathname === '/api/v1/ai/usage' ? newSummary.promise : newCalls.promise;
  h.submit();
  assert.equal(readRequests('/api/v1/ai/usage/calls')[0].options.signal.aborted, true);
  assert.match(h.text(), /2026-03-04/); assert.doesNotMatch(h.text(), /Current owner dining/);
  oldCalls.resolve(response(page({}, [call(9, { restaurant_name: 'OLD PRIVATE NAME' })])));
  newSummary.resolve(response(report(query))); newCalls.resolve(response(page(query, [call(8, { restaurant_name: 'NEW RANGE NAME', created_at: '2026-03-04T10:00:00.000000Z', finished_at: '2026-03-04T10:00:01.000000Z' })])));
  await h.settle(); assert.match(h.text(), /NEW RANGE NAME/); assert.doesNotMatch(h.text(), /OLD PRIVATE NAME/);
  const failed = { from: '2026-03-05', to: '2026-03-05' };
  responder = () => response({ code: 'SERVICE_UNAVAILABLE' }, 503);
  h.change('-from', failed.from); h.change('-to', failed.to); h.submit(); await h.settle();
  assert.match(h.text(), /2026-03-05/); assert.doesNotMatch(h.text(), /NEW RANGE NAME|Account shared/);
});
test('日期 checkbox 与 apply，非法日期不请求、不把草稿标成已应用；refresh 忽略草稿并清旧report', async () => {
  setupResponses(); const h = reader(); await h.settle();
  h.change('-dates', true); h.change('-from', '2026-02-30'); h.change('-to', '2026-03-01');
  const before = calls.length; h.submit(); assert.equal(calls.length, before);
  assert.match(h.text(), /valid UTC calendar dates/); assert.match(h.text(), /Unapplied filter changes/);
  assert.match(h.text(), /All time · UTC/); assert.match(h.text(), /Current owner dining/);
  const summary = deferred(), callPage = deferred();
  responder = request => urlOf(request).pathname.endsWith('/calls') ? callPage.promise : summary.promise;
  h.click('Refresh report'); assert.doesNotMatch(h.text(), /Current owner dining|Account shared/);
  assert.deepEqual(queryOf(readRequests('/api/v1/ai/usage').at(-1)), {});
  summary.resolve(response(report())); callPage.resolve(response(page())); await h.settle();
  h.change('-dates', false); h.submit(); await h.settle();
  assert.deepEqual(queryOf(readRequests('/api/v1/ai/usage').at(-1)), {});
});
test('loadmore scope + stable limit/cursor，重复 ID 去重、冲突不吞已有数据，重试不自动重放', async () => {
  setupResponses({ first: page({}, [call(9), call(8)], CURSOR), more: page({}, [call(8), call(7)], CURSOR2) });
  const h = reader(); await h.settle();
  h.click('Load more calls'); await h.settle();
  assert.equal(h.elements(node => node.type === 'span' && node.props.className === 'usage-id' && h.content(node).startsWith('Call aic_')).length, 3);
  assert.deepEqual(queryOf(readRequests('/api/v1/ai/usage/calls').at(-1)), { limit: '20', cursor: CURSOR });
  assert.equal(readRequests('/api/v1/ai/usage').length, 1);
  setupResponses({ more: page({}, [call(7, { total_tokens: 11, completion_tokens: 3 }), call(6)]) });
  h.click('Load more calls'); await h.settle();
  assert.match(h.text(), /Next page failed; previously loaded calls remain/);
  assert.equal(h.elements(node => node.type === 'span' && node.props.className === 'usage-id' && h.content(node).startsWith('Call aic_')).length, 3);
  const before = calls.length; await h.settle(); assert.equal(calls.length, before);
  setupResponses({ more: page({}, [call(6)]) }); h.click('Retry more calls'); await h.settle();
  assert.equal(queryOf(readRequests('/api/v1/ai/usage/calls').at(-1)).cursor, CURSOR2);
  assert.match(h.text(), /End of returned pages/);
});
for (const action of ['apply', 'refresh']) test(`loadmore 晚回包不能追加到 ${action} 的新scope`, async () => {
  setupResponses({ first: page({}, [call(9)], CURSOR) }); const h = reader(); await h.settle();
  const late = deferred(); responder = () => late.promise; h.click('Load more calls');
  const moreRequest = readRequests('/api/v1/ai/usage/calls').at(-1);
  const query = action === 'apply' ? { feature: 'website_chat' } : {};
  setupResponses({ summary: action === 'apply' ? report(query, [{ feature: 'website_chat', ...totals(1) }]) : report(), first: page(query, [call(7, { feature: query.feature ?? 'menu_recognition', restaurant_name: 'NEW SCOPE ONLY' })]) });
  if (action === 'apply') { h.change('-feature', 'website_chat'); h.submit(); } else h.click('Refresh report');
  assert.ok(moreRequest.options.signal.aborted);
  late.resolve(response(page({}, [call(8, { restaurant_name: 'STALE APPEND' })]))); await h.settle();
  assert.match(h.text(), /NEW SCOPE ONLY/); assert.doesNotMatch(h.text(), /STALE APPEND/);
  const latest = queryOf(readRequests('/api/v1/ai/usage/calls').at(-1)); assert.equal(latest.cursor, undefined); assert.equal(latest.limit, '20');
});
test('loadmore 双点击只一个flight，循环cursor错误保留旧行；busy不变成全局锁', async () => {
  setupResponses({ first: page({}, [call()], CURSOR) }); const h = reader(); await h.settle();
  const late = deferred(); responder = () => late.promise;
  const click = h.button('Load more calls').props.onClick; click(); click(); h.commit();
  assert.equal(readRequests('/api/v1/ai/usage/calls').length, 2);
  assert.equal(h.button('Refresh report').props.disabled, false);
  late.resolve(response(page({}, [call(8)], CURSOR))); await h.settle();
  assert.match(h.text(), /Next page failed/); assert.match(h.text(), /Current owner dining/);
  const before = calls.length; h.setProps({ busy: true }); h.submit(); assert.equal(calls.length, before);
  assert.ok(h.button('Refresh report').props.disabled);
});
for (const action of ['apply', 'refresh']) test(`未commit的 ${action} 不能被旧loadmore回调附加旧scope`, async () => {
  setupResponses({ first: page({}, [call()], CURSOR) }); const h = reader(); await h.settle();
  const staleMore = h.button('Load more calls').props.onClick;
  const query = action === 'apply' ? { feature: 'website_chat' } : {};
  setupResponses({ summary: report(query, [{ feature: 'website_chat', ...totals(1) }]), first: page(query, [call(7, { feature: 'website_chat' })]) });
  if (action === 'apply') {
    h.change('-feature', 'website_chat');
    h.elements(node => node.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  } else h.button('Refresh report').props.onClick();
  const before = readRequests('/api/v1/ai/usage/calls').length;
  staleMore();
  assert.equal(readRequests('/api/v1/ai/usage/calls').length, before);
  h.commit(); await h.settle();
  assert.equal(queryOf(readRequests('/api/v1/ai/usage/calls').at(-1)).cursor, undefined);
});
test('完成more但尚未commit时，旧按钮不能再次请求已消费cursor', async () => {
  setupResponses({ first: page({}, [call()], CURSOR), more: page({}, [call(8)], CURSOR2) });
  const h = reader(); await h.settle(); const staleMore = h.button('Load more calls').props.onClick;
  staleMore(); await turn(); const before = calls.length;
  staleMore(); assert.equal(calls.length, before); h.commit();
  assert.equal(queryOf(readRequests('/api/v1/ai/usage/calls').at(-1)).cursor, CURSOR);
  setupResponses({ more: page({}, [call(7)]) });
  h.click('Load more calls'); await h.settle();
  assert.equal(queryOf(readRequests('/api/v1/ai/usage/calls').at(-1)).cursor, CURSOR2);
});
for (const status of [401, 403, 404, 409]) test(`loadmore ${status} 撤下私有call和餐厅名称，不保留可点击旧店`, async () => {
  setupResponses({ first: page({}, [call()], CURSOR) }); const h = reader(); await h.settle();
  assert.match(h.text(), /Current owner dining/);
  responder = () => response({ code: 'ACCESS_CHANGED' }, status);
  h.click('Load more calls'); await h.settle();
  assert.doesNotMatch(h.text(), /Current owner dining|Account shared|Owner restaurant 1/);
  assert.equal(h.elements(node => node.type === 'a').length, 0);
});
test('activefalse 返回null并卸载flight；晚包不更新、resume只新 alltime、不重放旧cursor', async () => {
  setupResponses({ first: page({}, [call()], CURSOR) }); const h = reader(); await h.settle();
  const late = deferred(); responder = () => late.promise; h.click('Load more calls');
  const request = readRequests('/api/v1/ai/usage/calls').at(-1), updates = h.updates.length;
  const dormant = views.default({ userId: UID, active: false, busy: false }); assert.equal(dormant, null);
  h.unmount(); assert.ok(request.options.signal.aborted);
  late.resolve(response(page({}, [call(8, { restaurant_name: 'STALE PRIVATE' })]))); await turn();
  assert.equal(h.updates.length, updates);
  setupResponses({ first: page({}, [call(5, { restaurant_name: 'RESUMED FRESH' })]) });
  const resumed = reader(); await resumed.settle(); assert.match(resumed.text(), /RESUMED FRESH/); assert.doesNotMatch(resumed.text(), /STALE PRIVATE/);
  assert.deepEqual(queryOf(readRequests('/api/v1/ai/usage/calls').at(-1)), { limit: '20' });
  assert.equal(views.default({ userId: UID, active: true, busy: false }).key, UID);
});
test('user 切换首次render 不显示上一用户报告，所有flight与restaurant late包隔离', async () => {
  setupResponses({ first: page({}, [call()], CURSOR) }); const h = reader(); await h.settle();
  const listLate = deferred(), moreLate = deferred();
  responder = request => urlOf(request).pathname === '/api/v1/restaurants' ? listLate.promise : moreLate.promise;
  h.click('Reload current restaurants'); h.click('Load more calls');
  const oldRequests = calls.slice(-2);
  setupResponses({ first: page({}, [call(5, { restaurant_name: 'SECOND USER NAME' })]), restaurants: { items: [owner(2)], next_cursor: null, has_more: false } });
  h.renderProps({ userId: UID2 });
  assert.doesNotMatch(h.text(), /Current owner dining|Account shared|Owner restaurant 1/);
  h.commit(); oldRequests.forEach(request => assert.ok(request.options.signal.aborted));
  listLate.resolve(response({ items: [owner(3, { name: 'OLD USER RESTAURANT' })], next_cursor: null, has_more: false }));
  moreLate.resolve(response(page({}, [call(8, { restaurant_name: 'OLD USER APPEND' })])));
  await h.settle(); assert.match(h.text(), /SECOND USER NAME/); assert.doesNotMatch(h.text(), /OLD USER/);
  assert.equal(views.default({ userId: UID2, active: true, busy: false }).key, UID2);
});
test('restaurant reload 的旧包不覆盖新list；report刷新不自动再拉餐厅', async () => {
  setupResponses(); const h = reader(); await h.settle();
  const late = deferred(); responder = () => late.promise; h.click('Reload current restaurants');
  setupResponses({ restaurants: { items: [owner(2)], next_cursor: null, has_more: false } }); h.click('Reload current restaurants'); await h.settle();
  late.resolve(response({ items: [owner(3, { name: 'OLD LIST' })], next_cursor: null, has_more: false })); await h.settle();
  assert.doesNotMatch(h.text(), /OLD LIST/);
  const before = readRequests('/api/v1/restaurants').length; h.click('Refresh report'); await h.settle();
  assert.equal(readRequests('/api/v1/restaurants').length, before);
});

test('route 精确/account/usage；未认证及boot不渲染Usage，不自动读报表', async () => {
  assert.deepEqual(routes.readRoute(), { page: 'usage', path: '/account/usage', token: null });
  window.location.pathname = '/account/usage/old'; assert.equal(routes.readRoute().page, 'not-found'); window.location.pathname = '/account/usage';
  const html = renderToStaticMarkup(React.createElement(load('App.tsx').default, { initialRoute: routes.readRoute() }));
  assert.match(html, /Checking your account session/); assert.doesNotMatch(html, /Account shared|usage-report/);
  responder = request => request.url === '/api/v1/auth/me' ? response({ code: 'UNAUTHENTICATED' }, 401) : response({ supported_locales: ['en'] });
  const app = hooksHarness('App.tsx', { initialRoute: routes.readRoute() }, { reactModules: ['ui.tsx'], expandChildren: false });
  await app.settle();
  const auth = app.elements(node => typeof node.type === 'function' && node.props.onLogin)[0];
  assert.equal(auth.props.route.page, 'login');
  assert.equal(app.elements(node => node.type === views.default).length, 0);
  assert.equal(readRequests('/api/v1/ai/usage').length, 0);
  assert.doesNotMatch(app.text(), /Workspace navigation/);
});
for (const returningUser of [UID, UID2]) test(`App Usage仅真实session且keyuserid；expiry→Auth，恢复${returningUser === UID ? '同用户' : '另一用户'}不保留pauseddata`, async () => {
  setupResponses({ extra: request => request.url === '/api/v1/auth/me' ? response(session()) : response({ supported_locales: ['en'] }) });
  const app = hooksHarness('App.tsx', { initialRoute: routes.readRoute() }, { reactModules: ['ui.tsx'], expandChildren: false }); await app.settle();
  let usage = app.elements(node => node.type === views.default);
  assert.equal(usage.length, 1); assert.equal(usage[0].key, UID); assert.equal(usage[0].props.userId, UID); assert.equal(usage[0].props.active, true);
  assert.equal(app.elements(node => node.type === 'div' && node.props.className?.includes('management-shell')).length, 1);
  const link = app.elements(node => node.props.href === '/account/usage')[0]; assert.equal(app.content(link), 'Credit usage'); assert.match(link.props.className, /active/);
  const h = reader(); await h.settle();
  const late = deferred(); responder = () => late.promise; h.click('Refresh report');
  transport.notifySessionExpired(); await app.settle();
  assert.equal(app.elements(node => node.type === views.default).length, 0);
  assert.equal(app.elements(node => node.type === 'div' && node.props.className?.includes('management-shell')).length, 0);
  const auth = app.elements(node => typeof node.type === 'function' && node.props.onLogin)[0]; assert.equal(auth.props.route.page, 'login');
  h.unmount(); const updates = h.updates.length;
  late.resolve(response(report())); await turn(); assert.equal(h.updates.length, updates);
  auth.props.onLogin(session(returningUser)); app.commit();
  window.location.pathname = '/account/usage'; window.emit('popstate'); app.commit();
  usage = app.elements(node => node.type === views.default); assert.equal(usage.length, 1); assert.equal(usage[0].key, returningUser);
  setupResponses({ first: page({}, [call(5, { restaurant_name: 'AFTER AUTH FRESH' })]) });
  const resumed = reader({ userId: returningUser }); await resumed.settle();
  assert.match(resumed.text(), /AFTER AUTH FRESH/); assert.deepEqual(queryOf(readRequests('/api/v1/ai/usage/calls').at(-1)), { limit: '20' });
});
