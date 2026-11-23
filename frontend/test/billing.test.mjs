import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 内存 TS loader、真实 SSR、ReactDOM hooks 与提交边界 harness；不使用浏览器或真实网络。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'package.json'));
const ts = require('typescript'), React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { parseFragment } = require('parse5');
const extensions = Object.fromEntries(['.ts', '.tsx', '.css'].map(name => [name, Module._extensions[name]]));
const globals = Object.fromEntries(['window', 'document', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const cache = new Set(Object.keys(require.cache));
const UID = `usr_${'u'.repeat(24)}`, UID2 = `usr_${'v'.repeat(24)}`;
const NOW = '2026-03-01T10:00:00.123456Z';
let client, pricing, billing, transport, calls, timers, nextTimer, responder, unexpected;
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
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
function deferred() {
  let resolvePromise;
  const promise = new Promise(yes => { resolvePromise = yes; });
  return { promise, resolve: resolvePromise };
}
const turn = () => new Promise(done => setImmediate(done));
const id = (prefix, index) => `${prefix}_${String(index).padStart(24, '0')}`;
function catalog() {
  return { schema_version: 'billing-catalog-v1', billing_model: 'subscription_with_credit_addons', currency: 'USD', payment_enabled: false,
    plans: ['maintain', 'build', 'unlimited'].map((code, index) => ({ id: id('bpv', index + 1), code, name: ['Maintain', 'Build', 'Unlimited'][index], version: 1, status: 'draft',
      ai: { mode: index === 2 ? 'unlimited' : 'limited', monthly_credits: [1000, 10000, null][index], tokens_per_credit: 100, allocation_status: 'proposed', grant_schedule: 'unconfirmed' }, hosted_site_limit: null,
      prices: [{ id: id('bpr', index * 2 + 1), interval: 'month', amount_minor: [5900, 9900, 19900][index], currency: 'USD', status: 'draft' },
        { id: id('bpr', index * 2 + 2), interval: 'year', amount_minor: [41300, 69300, 139300][index], currency: 'USD', status: 'draft' }] })),
    credit_packs: [], addons_status: 'not_configured', seed_offer: { plan_code: 'unlimited', amount_minor: 3990, interval: 'month', requires_approval: true, duration_status: 'unconfirmed', purchasable: false } };
}
function creditPack(patch = {}) {
  return { id: id('bcp', 1), name: 'Recorded draft pack', credits: 500, amount_minor: 1234, currency: 'USD', tokens_per_credit: 100, validity_policy: 'unconfirmed', validity_days: null, status: 'draft', ...patch };
}
function packCatalog(packs = [creditPack()]) { return { ...catalog(), credit_packs: packs, addons_status: packs.length ? 'draft' : 'not_configured' }; }
function subscription(patch = {}) {
  return { id: id('bsu', 1), plan_id: id('bpv', 2), plan_code: 'build', plan_name: 'Build', price_id: id('bpr', 3), interval: 'month', amount_minor: 9900, currency: 'USD', status: 'incomplete',
    period_start: null, period_end: null, paid_through: null, cancel_requested_at: null, revision: 1, ...patch };
}
function overview(patch = {}) {
  return { schema_version: 'billing-overview-v1', mode: 'observation', payment_enabled: false, account: null, subscription: null, seed_eligibility: 'not_granted',
    credits: { status: 'not_configured', enforced: false, available: null, reserved: null, consumed: null }, addons_status: 'not_configured', generated_at: NOW, ...patch };
}
const account = () => ({ id: id('bla', 1), status: 'active' });
function testPeriod(patch = {}) {
  return { id: id('aqp', 1), starts_at: '2026-11-01T00:00:00.000000Z', ends_at: '2026-12-01T00:00:00.000000Z',
    granted_at: '2026-11-19T00:00:00.000001Z', timezone: 'UTC', origin: 'development_test', tokens_per_credit: 100, auto_renew: false, ...patch };
}
function testOverview(credits = {}, patch = {}) {
  return overview({ account: account(), generated_at: '2026-11-19T10:00:00.123456Z',
    credits: { status: 'development_test', enforced: false, granted: 10000, available: 10000, reserved: 0, consumed: 0, period: testPeriod(), ...credits }, ...patch });
}
function setup(data = catalog(), personal = overview()) {
  responder = request => {
    if (request.url === '/api/v1/billing/catalog') return response(data);
    if (request.url === '/api/v1/billing/overview') return response(personal);
    throw new Error(`未配置接口 ${request.url}`);
  };
}
const apiError = (status = 502, code = 'BILLING_RESPONSE_INVALID') => error => {
  assert.ok(error instanceof transport.ApiError); assert.equal(error.status, status); assert.equal(error.code, code); return true;
};
const requests = path => calls.filter(request => request.url === `/api/v1/billing/${path}`);
function checkGet(request) {
  assert.equal(request.options.method, 'GET');
  for (const [key, value] of Object.entries({ credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'same-origin' })) assert.equal(request.options[key], value);
  assert.equal(request.options.body, undefined); assert.equal(request.options.headers.get('Accept'), 'application/json');
  assert.equal(request.options.headers.get('X-CSRF-Token'), null); assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(new URL(request.url, window.location.origin).search, '');
}
function nodes(node, predicate) {
  const result = [];
  function walk(item) { if (predicate(item)) result.push(item); (item.childNodes ?? []).forEach(walk); }
  walk(node); return result;
}
const attr = (node, key) => (node.attrs ?? []).find(item => item.name === key)?.value;
const text = node => node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(text).join('');
function pricingMarkup(data = catalog(), interval = 'month', extra = {}) {
  return renderToStaticMarkup(React.createElement(pricing.PricingCatalogView, { catalog: client.validateCatalog(data), interval, busy: false, onIntervalChange() {}, ...extra }));
}
const billingMarkup = data => renderToStaticMarkup(React.createElement(billing.BillingOverviewView, { overview: client.validateOverview(data) }));

before(() => {
  const compile = (module, filename) => module._compile(compiledSource(filename), filename);
  Module._extensions['.ts'] = compile; Module._extensions['.tsx'] = compile; Module._extensions['.css'] = () => {};
  transport = load('api.ts'); client = load('billing-client.ts'); pricing = load('PricingPage.tsx'); billing = load('BillingPage.tsx');
});
beforeEach(() => {
  calls = []; timers = new Map(); nextTimer = 0; unexpected = [];
  responder = () => { throw new Error('不得访问真实网络'); };
  globalThis.window = { location: { pathname: '/pricing', origin: 'https://localhost:5173', hash: '', search: '' },
    setTimeout(fn, ms) { const value = ++nextTimer; timers.set(value, { fn, ms }); return value; }, clearTimeout(value) { timers.delete(value); } };
  globalThis.document = { documentElement: { lang: 'en' } };
  globalThis.fetch = async (url, options) => {
    const request = { url: String(url), options }; calls.push(request);
    if (request.url === '/api/v1/auth/csrf') return response({ csrf_token: 'csrf-fixture-'.repeat(4) });
    try { return responder(request); } catch (error) { unexpected.push(error.message); throw error; }
  };
  transport.clearCsrf();
});
afterEach(async () => {
  for (const h of [...harnesses].reverse()) h.unmount();
  await turn(); assert.deepEqual(unexpected, []); assert.equal(timers.size, 0, '计费请求定时器不得泄漏');
  assert.ok(calls.every(request => request.options.method === 'GET'), '只读计费页面不得提交付款或业务写入');
  transport.clearCsrf();
});
after(() => {
  for (const [name, handler] of Object.entries(extensions)) { if (handler) Module._extensions[name] = handler; else delete Module._extensions[name]; }
  for (const [name, descriptor] of Object.entries(globals)) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  for (const name of Object.keys(require.cache)) if (!cache.has(name) && name.startsWith(resolve(root, 'src') + '/')) delete require.cache[name];
});

test('development_test匹配真实Billing union，数值是积分不是raw tokens，null分支原样保留', async () => {
  const schema = JSON.parse(readFileSync(resolve(root, '../backend/contracts/billing.openapi.json'), 'utf8')).components.schemas;
  for (const credits of [{}, { consumed: 10, available: 9990 }, { consumed: 0.01, available: 9999.99 },
    { consumed: 10000.01, available: -0.01 }, { granted: Number.MAX_SAFE_INTEGER / 100, available: Number.MAX_SAFE_INTEGER / 100 }]) {
    const data = testOverview(credits), original = structuredClone(data), actual = client.validateOverview(data);
    assert.deepEqual(actual, original); assert.deepEqual(data, original);
    assert.deepEqual(Object.keys(actual.credits).sort(), schema.BillingCreditsObservation.oneOf[1].required.toSorted());
    assert.deepEqual(Object.keys(actual.credits.period).sort(), schema.AiCreditPeriod.required.toSorted());
    assert.equal(actual.subscription, null); assert.equal(actual.payment_enabled, false); assert.equal(actual.credits.enforced, false);
  }
  setup(catalog(), testOverview()); assert.deepEqual(await client.readOverview(), testOverview());
  assert.equal(calls.length, 1); calls.forEach(checkGet);
  assert.deepEqual(client.validateOverview(overview()).credits, overview().credits);
});
test('Billing积分formatter精确百分位，负数只允许available，支持安全上限展示投影', () => {
  for (const [value, expected] of [[0, '0'], [0.01, '0.01'], [0.29, '0.29'], [10000, '10,000'], [9990, '9,990'], [9999.99, '9,999.99'],
    [Number.MAX_SAFE_INTEGER / 100, '90,071,992,547,409.9']]) assert.equal(client.formatBillingCredits(value), expected);
  assert.equal(client.formatBillingCredits(-0.01, true), '-0.01'); assert.equal(client.formatBillingCredits(-Number.MAX_SAFE_INTEGER / 100, true), '-90,071,992,547,409.9');
  for (const value of [null, undefined, '10000', 1n, NaN, Infinity, 0.001, 1.234, Number.MAX_SAFE_INTEGER / 100 + 1]) {
    assert.throws(() => client.formatBillingCredits(value), apiError());
  }
  assert.throws(() => client.formatBillingCredits(-0.01), apiError());
});
for (const field of ['available', 'reserved', 'consumed', 'granted']) test(`development_test ${field}校验有限百分位与安全上限，不准nullable伪零`, () => {
  for (const value of [null, undefined, '1', NaN, Infinity, 0.001, 1.234, Number.MAX_SAFE_INTEGER / 100 + 1,
    -Number.MAX_SAFE_INTEGER / 100 - 1, ...(field === 'available' ? [] : [-0.01])]) {
    const data = testOverview({ [field]: value }); assert.throws(() => client.validateOverview(data), apiError());
  }
});
for (const [label, mutate] of [
  ['强制额度', data => { data.credits.enforced = true; }], ['payment', data => { data.payment_enabled = true; }],
  ['无账户', data => { data.account = null; }], ['未知credit字段', data => { data.credits.price = 0; }],
  ['假status', data => { data.credits.status = 'paid'; }], ['period为null', data => { data.credits.period = null; }],
  ['生成早于授额微秒', data => { data.generated_at = '2026-11-19T00:00:00.000000Z'; }],
  ['生成等于到期', data => { data.generated_at = data.credits.period.ends_at; }],
]) test(`development_test拒绝${label}`, () => { const data = testOverview(); mutate(data); assert.throws(() => client.validateOverview(data), apiError()); });
for (const [label, patch] of [
  ['period ID', { id: id('bla', 1) }], ['非UTC', { timezone: 'Asia/Shanghai' }], ['付费origin', { origin: 'subscription' }],
  ['换算', { tokens_per_credit: 1000 }], ['续发', { auto_renew: true }], ['未知字段', { granted: 10000 }],
  ['非法月', { starts_at: '2026-13-01T00:00:00.000000Z' }], ['非月首', { starts_at: '2026-11-02T00:00:00.000000Z' }],
  ['三位精度', { starts_at: '2026-11-01T00:00:00.000Z' }], ['非UTC格式', { ends_at: '2026-12-01T00:00:00.000000+00:00' }],
  ['结束非午夜', { ends_at: '2026-12-01T00:00:00.000001Z' }], ['结束非下月', { ends_at: '2027-01-01T00:00:00.000000Z' }],
  ['授额早于周期', { granted_at: '2026-10-31T23:59:59.999999Z' }], ['授额等于周期终点', { granted_at: '2026-12-01T00:00:00.000000Z' }],
]) test(`Billing共享period拒绝${label}并返回BILLING错误`, () => {
  const data = testOverview({ period: testPeriod(patch) }); assert.throws(() => client.validateOverview(data), apiError());
});
test('development_test credits与period逐个必填，未配置分支仍拒绝任何授额字段', () => {
  for (const key of Object.keys(testOverview().credits)) {
    const data = testOverview(); delete data.credits[key]; assert.throws(() => client.validateOverview(data), apiError());
  }
  for (const key of Object.keys(testPeriod())) {
    const data = testOverview(); delete data.credits.period[key]; assert.throws(() => client.validateOverview(data), apiError());
  }
  for (const patch of [{ granted: 0 }, { period: testPeriod() }, { available: 0 }, { status: 'development_test' }]) {
    assert.throws(() => client.validateOverview(overview({ credits: { ...overview().credits, ...patch } })), apiError());
  }
});
test('configured Billing SSR真实10000/9990/百分位/负余额，不声称订阅付费、付款或周期续发', () => {
  for (const [credits, granted, available, consumed] of [
    [{}, '10,000', '10,000', '0'], [{ consumed: 10, available: 9990 }, '10,000', '9,990', '10'],
    [{ consumed: 0.01, available: 9999.99 }, '10,000', '9,999.99', '0.01'],
    [{ consumed: 10000.01, available: -0.01 }, '10,000', '-0.01', '10,000.01'],
  ]) {
    const html = billingMarkup(testOverview(credits)), doc = parseFragment(html);
    const section = nodes(doc, node => node.tagName === 'section' && attr(node, 'aria-label') === 'Credits')[0];
    assert.deepEqual(nodes(section, node => node.tagName === 'dd').map(text), [granted, available, consumed, '0']);
    for (const phrase of ['Test allowance · this month', 'This calendar month · UTC', '2026-11-01 – 2026-11-30', 'Not a paid subscription', 'No paid plan',
      'Test credits applied to calls started after grant. Earlier history is not deducted.', '2026-12-01 00:00:00.000000 UTC', '(exclusive)', 'No automatic renewal or next-month grant', 'no hard limit is enforced']) assert.ok(text(section).includes(phrase), phrase);
    assert.match(text(doc), /No subscription/); assert.doesNotMatch(text(doc), /PayPal|Payment successful|Current plan|Not configured —|1000000|1,000,000|\btokens?\b|\$/i);
    assert.equal(nodes(doc, node => ['a', 'button'].includes(node.tagName)).length, 0);
  }
  const changed = billingMarkup(testOverview({ granted: 123.45, available: 120.15, consumed: 3, reserved: 0.3 }));
  assert.match(changed, /123.45/); assert.match(changed, /120.15/); assert.doesNotMatch(changed, /10,000/);
});
test('测试额度与订阅记录独立，不推断付款/Unlimited权益，Pricing公开目录不发额度', async () => {
  const personal = testOverview({}, { subscription: subscription({ status: 'active' }) });
  const doc = parseFragment(billingMarkup(personal));
  assert.match(text(doc), /not proof of payment or entitlement/); assert.match(text(doc), /Not a paid subscription/);
  assert.match(text(doc), /Subscription records do not prove a paid plan/); assert.doesNotMatch(text(doc), /No paid plan|Payment successful/);
  setup(catalog(), testOverview()); const h = pricingReader({ authenticated: true, userId: UID }); await h.settle();
  assert.doesNotMatch(h.text(), /Test allowance|Credits left|Payment successful/);
  assert.equal(requests('overview').length, 1); assert.equal(requests('catalog').length, 1); calls.forEach(checkGet);
});
test('Billing hooks展示真实配置额度，暂停后同user只新GET，旧晚包不能恢复余额', async () => {
  setup(catalog(), testOverview()); const h = overviewReader(); await h.settle(); assert.match(h.text(), /Credits left10,000/);
  h.renderProps({ active: false }); assert.doesNotMatch(h.text(), /10,000|Test allowance/); h.commit();
  const late = deferred(); responder = () => late.promise; h.setProps({ active: true }); const old = requests('overview').at(-1);
  h.setProps({ active: false }); setup(catalog(), testOverview({ consumed: 10, available: 9990 })); h.setProps({ active: true }); await h.settle();
  assert.match(h.text(), /Credits left9,990/); const updates = h.updates.length;
  late.resolve(response(testOverview())); await h.settle(); assert.equal(h.updates.length, updates); assert.ok(old.options.signal.aborted);
  assert.equal(requests('overview').length, 3); assert.equal(requests('catalog').length, 0); calls.forEach(checkGet);
});
test('Billing配置余额user首次render、expiry和卸载隔离，不渲染未校验quota', async () => {
  setup(catalog(), testOverview()); const h = billingReader(); await h.settle(); assert.match(h.text(), /10,000/);
  setup(); h.renderProps({ userId: UID2 }); assert.doesNotMatch(h.text(), /10,000|Test allowance/); h.commit(); await h.settle(); assert.match(h.text(), /Not configured —/);
  setup(catalog(), testOverview()); h.setProps({ userId: UID }); await h.settle(); assert.match(h.text(), /10,000/);
  transport.notifySessionExpired(); h.commit(); assert.doesNotMatch(h.text(), /10,000|Test allowance/); h.unmount();
  const late = deferred(); responder = () => late.promise; const fresh = billingReader(); fresh.unmount(); const updates = fresh.updates.length;
  late.resolve(response(testOverview())); await turn(); assert.equal(fresh.updates.length, updates);
  setup(catalog(), testOverview({ available: null })); const invalid = billingReader(); await invalid.settle();
  assert.match(invalid.text(), /failed validation/); assert.doesNotMatch(invalid.text(), /10,000|Test allowance|Not configured —/);
});
test('真实ReactDOM Billing与TokenBalance hooks读取配置number、不启动浏览器、不接模型或支付', async () => {
  setup(catalog(), testOverview({ consumed: 0.01, available: 9999.99 }));
  const b = await reactRoot(billing.default, { userId: UID, active: true, busy: false, navigate() {} });
  try {
    await b.settle(); assert.match(b.text(), /Credits left9,999.99/); assert.match(b.text(), /Used credits0.01/);
    await b.setProps({ active: false }); assert.equal(b.text(), '');
  } finally { await b.unmount(); }
  const t = { calls: 1, known_usage_calls: 1, pending_calls: 0, unknown_usage_calls: 0, prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 };
  const usage = { mode: 'observation', policy_version: 'observation-v1', generated_at: '2026-11-19T10:00:00.123456Z', billing_account: account(),
    quota: { configured: true, enforced: false, granted_tokens: 1000000, available_tokens: 999999, consumed_tokens: 1, reserved_tokens: 0, period: testPeriod() },
    calendar_month_totals: { period_id: testPeriod().id, totals: t }, filters: { restaurant_id: null, feature: null, origin: null, from: null, to: null },
    account_totals: t, filtered_totals: t, by_feature: [{ feature: 'website_chat', ...t }], legacy: { aggregate_jobs: 0, known_total_tokens: 0, unknown_usage_jobs: 0 } };
  responder = request => { assert.equal(request.url, '/api/v1/ai/usage'); return response(usage); };
  const balance = await reactRoot(load('TokenBalance.tsx').default, { userId: UID, active: true, refreshKey: '/app', busy: false, navigate() {} });
  try {
    await balance.settle(); assert.equal(balance.text(), 'Credits left · 9,999.99');
    usage.quota.consumed_tokens = 1000; usage.quota.available_tokens = 999000;
    t.prompt_tokens = 1000; t.total_tokens = 1000; usage.by_feature[0].prompt_tokens = 1000; usage.by_feature[0].total_tokens = 1000;
    await balance.setProps({ refreshKey: '/account/usage' }); await balance.settle(); assert.equal(balance.text(), 'Credits left · 9,990');
    await balance.setProps({ active: false }); assert.equal(balance.text(), '');
    assert.equal(calls.length, 3); calls.forEach(checkGet);
  } finally { await balance.unmount(); }
});

test('正式Pricing公开路由不等待me，Billing路由在会话未确认前不展示私有信息', () => {
  const routing = load('routing.ts');
  window.location.pathname = '/pricing'; assert.equal(routing.readRoute().page, 'pricing');
  window.location.pathname = '/account/billing'; assert.equal(routing.readRoute().page, 'billing');
  const App = load('App.tsx').default;
  const publicHtml = renderToStaticMarkup(React.createElement(App, { initialRoute: { page: 'pricing', path: '/pricing', token: null } }));
  assert.match(publicHtml, /A plan for your next chapter/); assert.doesNotMatch(publicHtml, /Checking your account session/);
  assert.match(publicHtml, /href="\/pricing"/);
  const privateHtml = renderToStaticMarkup(React.createElement(App, { initialRoute: { page: 'billing', path: '/account/billing', token: null } }));
  assert.match(privateHtml, /Checking your account session/);
  assert.doesNotMatch(privateHtml, /Recorded subscription|billing-overview|No confirmed credit balance/);
  assert.equal(calls.length, 0);
});

// 与 Usage 相同的 slot / effect cleanup 调度，只保留本批所需方法。
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
    useEffect(callback, deps) {
      const item = slot('effect', () => ({ deps: undefined, cleanup: undefined, pending: false }));
      if (!same(item.deps, deps)) { item.deps = deps; item.callback = callback; item.pending = true; }
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
  const h = { get tree() { return tree; }, updates, elements, content, commit,
    text() { return content(expanded(tree)); },
    button(label) { const matches = elements(node => node.type === 'button' && content(node) === label); assert.equal(matches.length, 1, label); return matches[0]; },
    click(label) { const node = h.button(label); assert.ok(!node.props.disabled); node.props.onClick(); commit(); },
    renderProps(next) { props = { ...props, ...next }; render(); },
    setProps(next) { h.renderProps(next); commit(); },
    async settle() { await turn(); if (!disposed) commit(); },
    unmount() { if (disposed) return; for (const item of slots) if (item.kind === 'effect') { item.cleanup?.(); item.cleanup = undefined; } disposed = true; harnesses.delete(h); },
  };
  render(); commit(); harnesses.add(h); return h;
}
const pricingReader = (props = {}) => hooksHarness('PricingPage.tsx', { navigate() {}, busy: false, authenticated: false, userId: null, ...props }, { reactModules: ['BillingPage.tsx'] });
const billingReader = (props = {}) => hooksHarness('BillingPage.tsx', { userId: UID, busy: false, navigate() {}, ...props }, { select: value => value.default({ userId: UID, active: true, busy: false, navigate() {} }).type });
function overviewReader(props = {}) {
  return hooksHarness('BillingPage.tsx', { userId: UID, active: true, ...props }, { select: value => current => {
    const state = value.useBillingOverview(current.userId, current.active);
    return React.createElement('div', null, state.data ? React.createElement(value.BillingOverviewView, { overview: state.data }) : state.error ?? 'Loading');
  } });
}

// 最小内存 host 仅提供 ReactDOM 所需节点操作；真实 React 调度 hooks 和事件，不启动浏览器。
async function reactRoot(Component, initialProps) {
  class HostNode {
    constructor(nodeType, name, ownerDocument) {
      this.nodeType = nodeType; this.nodeName = name; this.tagName = name; this.ownerDocument = ownerDocument;
      this.namespaceURI = 'http://www.w3.org/1999/xhtml'; this.childNodes = []; this.parentNode = null;
      this.attributes = new Map(); this.listeners = new Map(); this.style = { setProperty(name, value) { this[name] = value; } };
    }
    appendChild(node) { if (node.parentNode) node.parentNode.removeChild(node); this.childNodes.push(node); node.parentNode = this; return node; }
    removeChild(node) { const index = this.childNodes.indexOf(node); assert.notEqual(index, -1); this.childNodes.splice(index, 1); node.parentNode = null; return node; }
    insertBefore(node, before) { if (node.parentNode) node.parentNode.removeChild(node); const index = this.childNodes.indexOf(before); assert.notEqual(index, -1); this.childNodes.splice(index, 0, node); node.parentNode = this; return node; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    addEventListener(name, callback, options) { const capture = typeof options === 'boolean' ? options : !!options?.capture; const list = this.listeners.get(name) ?? []; list.push({ callback, capture }); this.listeners.set(name, list); }
    removeEventListener(name, callback) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(item => item.callback !== callback)); }
    get firstChild() { return this.childNodes[0] ?? null; }
    get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(node => node.textContent).join(''); }
    set textContent(value) {
      if (this.nodeType === 3) { this.nodeValue = String(value); return; }
      for (const child of this.childNodes) child.parentNode = null;
      this.childNodes = []; if (value) this.appendChild(this.ownerDocument.createTextNode(String(value)));
    }
  }
  const doc = new HostNode(9, '#document', null);
  doc.createElement = name => new HostNode(1, name.toUpperCase(), doc);
  doc.createElementNS = (_, name) => doc.createElement(name);
  doc.createTextNode = value => { const node = new HostNode(3, '#text', doc); node.nodeValue = value; return node; };
  doc.documentElement = doc.createElement('html'); doc.body = doc.createElement('body'); doc.activeElement = doc.body;
  doc.defaultView = window; window.HTMLElement = HostNode; window.HTMLIFrameElement = class {}; globalThis.document = doc;
  const actEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = doc.createElement('div'); doc.body.appendChild(container);
  const root = require('react-dom/client').createRoot(container);
  let props = initialProps;
  const find = predicate => {
    const result = []; function walk(node) { if (predicate(node)) result.push(node); node.childNodes.forEach(walk); } walk(container); return result;
  };
  const h = {
    text: () => container.textContent,
    elements: find,
    async setProps(next) { props = { ...props, ...next }; await React.act(async () => { root.render(React.createElement(Component, props)); }); },
    async settle() { await React.act(async () => { await turn(); }); },
    async click(label) {
      const matches = find(node => node.tagName === 'BUTTON' && node.textContent === label); assert.equal(matches.length, 1);
      const target = matches[0]; assert.equal(target.getAttribute('disabled'), null);
      await React.act(async () => {
        const event = { type: 'click', target, button: 0, bubbles: true, preventDefault() {}, stopPropagation() {} };
        for (const { callback, capture } of container.listeners.get('click') ?? []) if (!capture) callback(event);
      });
    },
    async unmount() { try { await React.act(async () => { root.unmount(); }); } finally { globalThis.IS_REACT_ACT_ENVIRONMENT = actEnvironment; } },
  };
  await h.setProps({}); return h;
}

test('目录与概览精确匹配真实共享 OpenAPI，null 与拟定额度完整保留', () => {
  const schemas = JSON.parse(readFileSync(resolve(root, '../backend/contracts/billing.openapi.json'), 'utf8')).components.schemas;
  const data = client.validateCatalog(catalog()), personal = client.validateOverview(overview());
  assert.deepEqual(data, catalog()); assert.deepEqual(personal, overview());
  for (const [value, name] of [[data, 'BillingCatalog'], [data.plans[0], 'BillingPlan'], [data.plans[0].ai, 'BillingAi'], [data.plans[0].prices[0], 'BillingPrice'], [data.seed_offer, 'BillingSeedOffer'], [personal, 'BillingOverview'], [personal.credits, 'BillingCreditsObservation'], [client.validateOverview(overview({ account: account(), subscription: subscription() })).subscription, 'BillingSubscriptionView']]) {
    assert.deepEqual(Object.keys(value).sort(), (schemas[name].required ?? schemas[name].oneOf[0].required).toSorted());
  }
  assert.deepEqual(data.plans.map(item => item.prices.map(price => price.amount_minor)), [[5900, 41300], [9900, 69300], [19900, 139300]]);
  assert.deepEqual(data.plans.map(item => item.ai.monthly_credits), [1000, 10000, null]);
});
for (const [name, get] of [['根', data => data], ['套餐', data => data.plans[0]], ['AI', data => data.plans[0].ai], ['价格', data => data.plans[0].prices[0]], ['Seed', data => data.seed_offer]]) {
  test(`目录${name}拒绝未知字段与每一个缺失必填字段`, () => {
    const extra = catalog(); get(extra).private_field = '不得显示'; assert.throws(() => client.validateCatalog(extra), apiError());
    for (const key of Object.keys(get(catalog()))) { const data = catalog(); delete get(data)[key]; assert.throws(() => client.validateCatalog(data), apiError()); }
  });
}
for (const [label, mutate, count, interval, expected] of [
  ['缺少套餐', data => data.plans.pop(), 2, 'month', '$59.00'],
  ['缺少年价', data => data.plans[0].prices.pop(), 3, 'year', 'Price not configured'],
]) test(`目录合法${label}保留服务器结果并真实渲染，不拒绝整份目录`, async () => {
  const data = catalog(); mutate(data); assert.deepEqual(client.validateCatalog(data), data);
  const html = pricingMarkup(data, interval), cards = nodes(parseFragment(html), node => node.tagName === 'article');
  assert.equal(cards.length, count); assert.ok(text(cards[0]).includes(expected)); assert.doesNotMatch(html, /NaN|undefined/);
  assert.ok(cards.every(card => nodes(card, node => node.tagName === 'button' && attr(node, 'disabled') !== undefined).length === 1));
  if (label === '缺少套餐') { assert.doesNotMatch(html, /Unlimited AI usage|\$199\.00/); }
  else { assert.doesNotMatch(text(cards[0]), /\$413\.00|Equivalent to|Save 5 months|Full annual charge/); }
  setup(data); assert.deepEqual(await client.readCatalog(), data); assert.equal(calls.length, 1); calls.forEach(checkGet);
});
for (const [label, mutate] of [
  ['第四个套餐', data => data.plans.push(structuredClone(data.plans[0]))],
  ['重复 code', data => data.plans[1].code = 'maintain'], ['重复套餐 ID', data => data.plans[1].id = data.plans[0].id],
  ['三个价格', data => data.plans[0].prices.push(structuredClone(data.plans[0].prices[0]))],
  ['重复周期', data => data.plans[0].prices[1].interval = 'month'], ['跨套餐重复价格 ID', data => data.plans[1].prices[0].id = data.plans[0].prices[0].id],
  ['错误套餐前缀', data => data.plans[0].id = id('bpr', 1)], ['错误价格前缀', data => data.plans[0].prices[0].id = id('bpv', 1)],
  ['错误币种', data => data.currency = 'EUR'], ['零币种', data => data.plans[0].prices[0].currency = 0],
  ['启用支付', data => data.payment_enabled = true], ['已配置加购', data => data.credit_packs.push({ amount_minor: 100 })],
  ['有限档 null 额度', data => data.plans[0].ai.monthly_credits = null], ['Unlimited 有限额度', data => data.plans[2].ai.monthly_credits = 10000],
  ['有限档 Unlimited mode', data => data.plans[0].ai.mode = 'unlimited'], ['Proposed 已授予', data => data.plans[0].ai.grant_schedule = 'service_month'],
  ['Seed 可买', data => data.seed_offer.purchasable = true], ['Seed 无须审批', data => data.seed_offer.requires_approval = false], ['Seed 假价格', data => data.seed_offer.amount_minor = 3900],
]) test(`目录拒绝${label}`, () => { const data = catalog(); mutate(data); assert.throws(() => client.validateCatalog(data), apiError()); });
for (const [name, get, key, minimum] of [
  ['月价', data => data.plans[0].prices[0], 'amount_minor', 0], ['年价', data => data.plans[0].prices[1], 'amount_minor', 0],
  ['版本', data => data.plans[0], 'version', 1], ['额度', data => data.plans[0].ai, 'monthly_credits', 0],
  ['积分换算', data => data.plans[0].ai, 'tokens_per_credit', 1], ['站点预算', data => data.plans[0], 'hosted_site_limit', 0],
]) test(`${name}必须为安全整数，最小值 ${minimum}`, () => {
  for (const value of [Number.MAX_SAFE_INTEGER + 1, -1, 0.5, '100', undefined, ...(minimum ? [0] : [])]) {
    const data = catalog(); get(data)[key] = value; assert.throws(() => client.validateCatalog(data), apiError());
  }
});
for (const [name, get] of [['根', data => data], ['账户', data => data.account], ['订阅', data => data.subscription], ['积分', data => data.credits]]) {
  test(`概览${name}拒绝未知字段与每一个缺失必填字段`, () => {
    const base = () => overview({ account: account(), subscription: subscription() });
    const extra = base(); get(extra).secret = '不得显示'; assert.throws(() => client.validateOverview(extra), apiError());
    for (const key of Object.keys(get(base()))) { const data = base(); delete get(data)[key]; assert.throws(() => client.validateOverview(data), apiError()); }
  });
}
for (const [label, mutate] of [
  ['零余额', data => data.credits.available = 0], ['零预留', data => data.credits.reserved = 0], ['零已用', data => data.credits.consumed = 0],
  ['假积分授予', data => data.credits.status = 'configured'], ['强制额度', data => data.credits.enforced = true],
  ['错误账户前缀', data => data.account.id = id('usr', 1)], ['错误订阅前缀', data => data.subscription.id = id('bpr', 1)],
  ['错误 plan 前缀', data => data.subscription.plan_id = id('bpr', 1)], ['错误 price 前缀', data => data.subscription.price_id = id('bpv', 1)],
  ['无账户却有订阅', data => data.account = null], ['未知状态', data => data.subscription.status = 'paid'],
  ['未知 Seed 状态', data => data.seed_eligibility = 'eligible'], ['非 USD', data => data.subscription.currency = 'CNY'],
  ['不安全金额', data => data.subscription.amount_minor = Number.MAX_SAFE_INTEGER + 1], ['零 revision', data => data.subscription.revision = 0],
  ['非法日期', data => data.generated_at = '2026-02-30T10:00:00.123456Z'], ['非法时间', data => data.generated_at = '2026-03-01T24:00:00.123456Z'],
  ['非 UTC', data => data.generated_at = '2026-03-01T10:00:00.123+00:00'], ['四位小数', data => data.generated_at = '2026-03-01T10:00:00.1234Z'],
  ['周期缺失一端', data => data.subscription.period_start = NOW], ['结束早于开始', data => { data.subscription.period_start = NOW; data.subscription.period_end = '2026-03-01T10:00:00.123455Z'; }],
]) test(`概览拒绝${label}`, () => { const data = overview({ account: account(), subscription: subscription() }); mutate(data); assert.throws(() => client.validateOverview(data), apiError()); });
test('订阅校验已知价格归属与 code，允许真实历史和私有 Seed ID，不猜成当前价格', () => {
  const data = overview({ account: account(), subscription: subscription() });
  assert.deepEqual(client.validateOverview(data, catalog()), data);
  for (const patch of [{ plan_code: 'maintain' }, { price_id: id('bpr', 1) }, { amount_minor: 100 }, { interval: 'year' }]) {
    assert.throws(() => client.validateOverview({ ...data, subscription: subscription(patch) }, catalog()), apiError());
  }
  const seed = overview({ account: account(), subscription: subscription({ plan_id: id('bpv', 3), plan_code: 'unlimited', plan_name: 'Unlimited', price_id: id('bpr', 7), amount_minor: 3990 }) });
  assert.deepEqual(client.validateOverview(seed, catalog()), seed);
  const historical = overview({ account: account(), subscription: subscription({ plan_id: id('bpv', 50), price_id: id('bpr', 50), plan_name: 'Historical build' }) });
  assert.deepEqual(client.validateOverview(historical, catalog()), historical);
  const micro = overview({ account: account(), subscription: subscription({ period_start: NOW, period_end: '2026-03-01T10:00:00.123457Z' }) });
  assert.deepEqual(client.validateOverview(micro), micro);
  assert.equal(client.validateOverview(overview({ generated_at: '2026-03-01T10:00:00.123Z' })).generated_at, '2026-03-01T10:00:00.123Z');
});

test('真实 transport 公开 GET 与 session GET，无参数、CSRF、写入或额外 me', async () => {
  setup(); const controller = new AbortController();
  assert.deepEqual(await client.readCatalog(controller.signal), catalog()); assert.deepEqual(await client.readOverview(controller.signal), overview());
  assert.equal(calls.length, 2); calls.forEach(checkGet);
  let expired = 0; const unsubscribe = transport.onSessionExpired(() => { expired += 1; });
  responder = () => response({ code: 'UNAUTHENTICATED' }, 401, { 'WWW-Authenticate': 'Session' });
  try {
    await assert.rejects(client.readCatalog(), apiError(401, 'UNAUTHENTICATED')); assert.equal(expired, 0); assert.equal(calls.length, 3);
    await assert.rejects(client.readOverview(), apiError(401, 'UNAUTHENTICATED')); assert.equal(expired, 1);
    assert.equal(requests('overview').length, 2); assert.equal(calls.filter(request => request.url === '/api/v1/auth/csrf').length, 1);
  } finally { unsubscribe(); }
});
test('错误响应不变成成功，预取消不请求，网络和超时 status 0 清晰映射', async () => {
  responder = () => response({ invalid: true }); await assert.rejects(client.readCatalog(), apiError());
  responder = () => response({ code: 'SERVICE_UNAVAILABLE' }, 503); await assert.rejects(client.readOverview(), apiError(503, 'SERVICE_UNAVAILABLE'));
  responder = () => Promise.reject(new Error('网络不可达')); await assert.rejects(client.readCatalog(), apiError(0, 'NETWORK_ERROR'));
  assert.match(client.billingErrorMessage(new transport.ApiError(0, 'NETWORK_ERROR')), /Unable to reach/);
  const cancelled = new AbortController(); cancelled.abort(); const count = calls.length;
  await assert.rejects(client.readOverview(cancelled.signal), error => error.name === 'AbortError'); assert.equal(calls.length, count);
  responder = request => new Promise((_, reject) => request.options.signal.addEventListener('abort', () => reject(new Error('超时')), { once: true }));
  const timed = client.readOverview(); [...timers.values()][0].fn(); await assert.rejects(timed, apiError(0, 'REQUEST_TIMEOUT'));
  assert.match(client.billingErrorMessage(new transport.ApiError(0, 'REQUEST_TIMEOUT')), /timed out/);
});

test('纯 SSR 三卡按服务端月价，年价全额优先、正确折算和 Save 5 months；所有购买按钮 inactive', () => {
  const month = parseFragment(pricingMarkup()), year = parseFragment(pricingMarkup(catalog(), 'year'));
  assert.equal(nodes(month, node => node.tagName === 'article').length, 3);
  for (const amount of ['$59.00', '$99.00', '$199.00']) assert.ok(text(month).includes(amount));
  for (const amount of ['$413.00', '$693.00', '$1,393.00', '$34.42', '$57.75', '$116.08', 'Full annual charge', 'Not billed monthly']) assert.ok(text(year).includes(amount), amount);
  assert.equal(nodes(year, node => attr(node, 'class') === 'billing-saving').length, 3);
  const buttons = nodes(year, node => node.tagName === 'button');
  assert.deepEqual(buttons.slice(0, 2).map(node => attr(node, 'aria-pressed')), ['false', 'true']);
  const pay = buttons.filter(node => text(node) === 'Payments not enabled'); assert.equal(pay.length, 3); assert.ok(pay.every(node => attr(node, 'disabled') !== undefined));
  assert.equal(nodes(year, node => node.tagName === 'a').length, 0);
  assert.ok(nodes(year, node => node.tagName === 'details').every(node => attr(node, 'open') === undefined));
  for (const phrase of ['Proposed', 'not a confirmed allocation', 'not guaranteed hosting', 'not storage or hosted websites', 'Prices are not configured']) assert.ok(text(year).includes(phrase), phrase);
  assert.doesNotMatch(text(year), /PayPal|Checkout|Unlimited websites|Unlimited storage|\$39\.90/i); assert.equal(calls.length, 0);
});
test('金额变化真实呈现，无硬编码三档价格；只有恰好七个月价才显示节省五个月', () => {
  const data = catalog(); data.plans[0].prices[0].amount_minor = 6101; data.plans[0].prices[1].amount_minor = 47003;
  const html = pricingMarkup(data, 'year'); assert.match(html, /\$470\.03/); assert.match(html, /\$39\.17/); assert.doesNotMatch(html, /\$413\.00/);
  assert.equal(nodes(parseFragment(html), node => attr(node, 'class') === 'billing-saving').length, 2);
  data.plans[0].prices[1].amount_minor = 42707; assert.equal(client.savesFiveMonths(client.validateCatalog(data).plans[0]), true);
  data.plans[0].prices[0].amount_minor = Number.MAX_SAFE_INTEGER; data.plans[0].prices[1].amount_minor = Number.MAX_SAFE_INTEGER;
  assert.equal(client.savesFiveMonths(client.validateCatalog(data).plans[0]), false);
});
test('真实 onclick 切换月年金额，无重新 GET、无支付回调；busy 不锁定只读周期', async () => {
  setup(); const h = pricingReader(); await h.settle(); assert.match(h.text(), /\$59\.00/);
  h.click('Yearly'); assert.match(h.text(), /\$413\.00/); assert.match(h.text(), /\$34\.42/); assert.doesNotMatch(h.text(), /\$59\.00/);
  assert.equal(h.button('Yearly').props['aria-pressed'], true);
  h.setProps({ busy: true }); h.click('Monthly'); assert.match(h.text(), /\$59\.00/); assert.equal(h.button('Monthly').props['aria-pressed'], true);
  const pay = h.elements(node => node.type === 'button' && h.content(node) === 'Payments not enabled');
  assert.equal(pay.length, 3); assert.ok(pay.every(node => node.props.disabled && node.props.onClick === undefined));
  assert.equal(requests('catalog').length, 1); assert.equal(requests('overview').length, 0); assert.equal(calls.length, 1);
});
test('公开 Pricing 不等待 me，不调用 overview；资格慢或失败都不阻断标准目录', async () => {
  setup(); const publicPage = pricingReader({ userId: UID, authenticated: false }); await publicPage.settle();
  assert.match(publicPage.text(), /\$199\.00/); assert.doesNotMatch(publicPage.text(), /Seed eligibility approved|\$39\.90/); assert.equal(requests('overview').length, 0);
  const late = deferred(); responder = request => request.url.endsWith('/catalog') ? response(catalog()) : late.promise;
  const signedIn = pricingReader({ userId: UID, authenticated: true }); await signedIn.settle(); assert.match(signedIn.text(), /\$59\.00/);
  late.resolve(response({ bad: 'private' })); await signedIn.settle(); assert.match(signedIn.text(), /failed validation/); assert.match(signedIn.text(), /\$59\.00/);
  assert.doesNotMatch(signedIn.text(), /Seed eligibility approved|\$39\.90/);
});
for (const state of ['not_granted', 'pending', 'approved', 'ended']) test(`Seed ${state} 仅真实 approved 显示本人资格，不提供种子购买 CTA`, async () => {
  setup(catalog(), overview({ account: account(), seed_eligibility: state }));
  const h = pricingReader({ authenticated: true, userId: UID }); await h.settle();
  assert.equal(h.text().includes('Seed eligibility approved'), state === 'approved');
  assert.equal(h.text().includes('$39.90'), state === 'approved');
  if (state === 'approved') assert.match(h.text(), /not purchasable/); else assert.match(h.text(), /Seed offer requires approval/);
  assert.equal(h.elements(node => node.type === 'a').length, 1);
  assert.ok(h.elements(node => node.type === 'button').every(node => !/Seed/.test(h.content(node))));
});
test('Pricing 登出首次 render 撤下资格、取消请求；同用户再认证只接收新包', async () => {
  setup(catalog(), overview({ account: account(), seed_eligibility: 'approved' })); const h = pricingReader({ authenticated: true, userId: UID }); await h.settle();
  assert.match(h.text(), /Seed eligibility approved/);
  h.renderProps({ authenticated: false }); assert.doesNotMatch(h.text(), /Seed eligibility approved|\$39\.90/); h.commit();
  const late = deferred(); setup(); const base = responder; responder = request => request.url.endsWith('/overview') ? late.promise : base(request);
  h.setProps({ authenticated: true }); const pending = requests('overview').at(-1); h.renderProps({ authenticated: false }); h.commit(); assert.ok(pending.options.signal.aborted);
  setup(catalog(), overview()); h.setProps({ authenticated: true }); await h.settle();
  late.resolve(response(overview({ account: account(), seed_eligibility: 'approved' }))); await h.settle();
  assert.doesNotMatch(h.text(), /Seed eligibility approved|\$39\.90/); assert.equal(requests('catalog').length, 1);
});
test('Pricing user 切换未 commit 时晚包不 setState；新用户绝不显示旧资格', async () => {
  const late = deferred(); responder = request => request.url.endsWith('/catalog') ? response(catalog()) : late.promise;
  const h = pricingReader({ authenticated: true, userId: UID }); await h.settle();
  h.renderProps({ userId: UID2 }); const updates = h.updates.length;
  late.resolve(response(overview({ account: account(), seed_eligibility: 'approved' }))); await turn(); assert.equal(h.updates.length, updates);
  setup(); h.commit(); await h.settle(); assert.equal(requests('overview').length, 2); assert.doesNotMatch(h.text(), /Seed eligibility approved|\$39\.90/);
});

test('Billing 新账户正常显示无订阅与未配置积分，不造零余额或 Unlimited；私有记录仅呈现 server fields', async () => {
  const html = billingMarkup(overview()); assert.match(html, /No subscription/); assert.match(html, /No subscription/); assert.match(html, /Not configured —/); assert.match(html, /No offers available/);
  assert.doesNotMatch(html, /Unlimited|\$|PayPal/i);
  const creditSection = nodes(parseFragment(html), node => node.tagName === 'section' && attr(node, 'aria-label') === 'Credits')[0];
  assert.doesNotMatch(text(creditSection), /\b0\b/);
  setup(); const paths = [], h = billingReader({ busy: true, navigate: path => paths.push(path) }); await h.settle();
  assert.match(h.text(), /No subscription/); assert.equal(requests('overview').length, 1); assert.equal(requests('catalog').length, 0); calls.forEach(checkGet);
  h.setProps({ busy: false }); const links = h.elements(node => node.type === 'a'); assert.deepEqual(links.map(node => node.props.href), ['/pricing', '/account/usage']);
  links[0].props.onClick({ button: 0, preventDefault() {} }); assert.deepEqual(paths, ['/pricing']); assert.equal(calls.length, 1);
  const record = billingMarkup(overview({ account: account(), subscription: subscription({ status: 'active', period_start: NOW, period_end: '2026-04-01T10:00:00.123456Z' }) }));
  assert.match(record, /Recorded subscription/); assert.match(record, /not proof of payment or entitlement/); assert.doesNotMatch(record, /Current plan|No active subscription/);
  assert.match(record, /Build/); assert.match(record, /\$99\.00/); assert.match(record, /UTC/);
  assert.ok(nodes(parseFragment(record), node => node.tagName === 'details').every(node => attr(node, 'open') === undefined));
});
for (const status of ['incomplete', 'active', 'past_due', 'suspended', 'cancelled', 'expired']) test(`Billing ${status} 仅展示记录，不宣称付款或权益`, () => {
  const html = billingMarkup(overview({ account: account(), subscription: subscription({ status }) }));
  assert.match(html, /Recorded subscription/); assert.match(html, /not proof of payment or entitlement/); assert.match(html, /Payments are not enabled/);
  assert.doesNotMatch(html, /Current plan|No active subscription|No subscription|Payment successful/); assert.ok(html.includes(status));
});
test('Billing 外壳 active false 返回 null，按当前 user immutable key；卸载后晚包不更新', async () => {
  assert.equal(billing.default({ userId: UID, active: false, busy: false, navigate() {} }), null);
  assert.equal(billing.default({ userId: UID, active: true, busy: false, navigate() {} }).key, UID);
  assert.equal(billing.default({ userId: UID2, active: true, busy: false, navigate() {} }).key, UID2);
  const late = deferred(); responder = () => late.promise; const h = billingReader(); const request = requests('overview')[0]; h.unmount(); const count = h.updates.length;
  late.resolve(response(overview({ account: account(), subscription: subscription({ plan_name: 'OLD PRIVATE' }) }))); await turn();
  assert.ok(request.options.signal.aborted); assert.equal(h.updates.length, count);
});
test('Billing hook 暂停立即隐藏私有数据并 abort；resume 同 user 也只读新快照', async () => {
  setup(catalog(), overview({ account: account(), subscription: subscription({ plan_name: 'PRIVATE FIRST' }) })); const h = overviewReader(); await h.settle(); assert.match(h.text(), /PRIVATE FIRST/);
  h.renderProps({ active: false }); assert.doesNotMatch(h.text(), /PRIVATE FIRST|Recorded subscription/); h.commit();
  const late = deferred(); responder = () => late.promise; h.setProps({ active: true }); const lateRequest = requests('overview').at(-1);
  h.setProps({ active: false }); setup(catalog(), overview()); h.setProps({ active: true }); await h.settle();
  late.resolve(response(overview({ account: account(), subscription: subscription({ plan_name: 'STALE RESUME' }) }))); await h.settle();
  assert.ok(lateRequest.options.signal.aborted); assert.doesNotMatch(h.text(), /PRIVATE FIRST|STALE RESUME/); assert.match(h.text(), /No subscription/);
});
test('Billing user 切换首次 render 隔离；旧请求在 cleanup 前到达也不 setState', async () => {
  const late = deferred(); responder = () => late.promise; const h = billingReader();
  h.renderProps({ userId: UID2 }); const count = h.updates.length;
  late.resolve(response(overview({ account: account(), subscription: subscription({ plan_name: 'OLD PRIVATE' }) }))); await turn(); assert.equal(h.updates.length, count);
  setup(catalog(), overview({ account: account(), subscription: subscription({ plan_name: 'SECOND USER' }) })); h.commit(); await h.settle();
  assert.equal(requests('overview').length, 2); assert.match(h.text(), /SECOND USER/); assert.doesNotMatch(h.text(), /OLD PRIVATE/);
});
test('会话 expiry 撤下已读 Billing 和 Seed，迟到响应不恢复 private data，公共价格保留', async () => {
  setup(catalog(), overview({ account: account(), subscription: subscription({ plan_name: 'PRIVATE PLAN' }), seed_eligibility: 'approved' }));
  const h = billingReader(), p = pricingReader({ authenticated: true, userId: UID }); await h.settle(); await p.settle();
  assert.match(h.text(), /PRIVATE PLAN/); assert.match(p.text(), /Seed eligibility approved/);
  transport.notifySessionExpired(); h.commit(); p.commit(); assert.doesNotMatch(h.text(), /PRIVATE PLAN|Recorded subscription/); assert.doesNotMatch(p.text(), /Seed eligibility approved|\$39\.90/); assert.match(p.text(), /\$59\.00/);
  assert.match(h.text(), /session has expired/);
  h.unmount(); p.unmount(); const late = deferred(); responder = () => late.promise; const fresh = billingReader();
  transport.notifySessionExpired(); fresh.commit(); const count = fresh.updates.length;
  late.resolve(response(overview({ account: account(), subscription: subscription({ plan_name: 'EXPIRED LATE PRIVATE' }) }))); await fresh.settle();
  assert.equal(fresh.updates.length, count); assert.doesNotMatch(fresh.text(), /EXPIRED LATE PRIVATE/);
});
for (const [status, data, pattern] of [[401, { code: 'UNAUTHENTICATED' }, /session has expired/], [403, { code: 'FORBIDDEN' }, /access is no longer/], [200, { invalid: true }, /failed validation/], [503, { code: 'SERVICE_UNAVAILABLE' }, /Unable to load billing/]]) {
  test(`Billing ${status} 错误明确，不造订阅积分或支付成功`, async () => {
    responder = () => response(data, status); const h = billingReader(); await h.settle(); assert.match(h.text(), pattern);
    assert.doesNotMatch(h.text(), /No subscription|Not configured —|Payment successful|Recorded subscription/); assert.equal(requests('overview').length, 1);
  });
}
test('Pricing 接口失败不回落硬编码价格，卸载 catalog late 包不 setState', async () => {
  responder = () => response({ invalid: true }); const h = pricingReader(); await h.settle(); assert.match(h.text(), /failed validation/); assert.doesNotMatch(h.text(), /\$59|\$99|\$199|Payments not enabled/);
  const late = deferred(); responder = () => late.promise; const fresh = pricingReader(); const request = requests('catalog').at(-1); fresh.unmount(); const count = fresh.updates.length;
  late.resolve(response(catalog())); await turn(); assert.ok(request.options.signal.aborted); assert.equal(fresh.updates.length, count);
});
test('真实 ReactDOM hooks 与委托事件切换月年，busy 只读切换不锁定且无额外请求或写入', async () => {
  setup(); const h = await reactRoot(pricing.default, { navigate() {}, busy: false, authenticated: false, userId: null });
  try {
    await h.settle(); assert.match(h.text(), /\$59\.00/);
    await h.click('Yearly'); assert.match(h.text(), /\$413\.00/); assert.match(h.text(), /\$34\.42/); assert.doesNotMatch(h.text(), /\$59\.00/);
    await h.setProps({ busy: true }); await h.click('Monthly'); assert.match(h.text(), /\$59\.00/);
    const periods = h.elements(node => node.tagName === 'BUTTON' && ['Monthly', 'Yearly'].includes(node.textContent));
    assert.deepEqual(periods.map(node => node.getAttribute('aria-pressed')), ['true', 'false']);
    const pay = h.elements(node => node.tagName === 'BUTTON' && node.textContent === 'Payments not enabled');
    assert.equal(pay.length, 3); assert.ok(pay.every(node => node.getAttribute('disabled') !== null));
    assert.equal(calls.length, 1); calls.forEach(checkGet);
  } finally { await h.unmount(); }
});
test('真实 React hooks 新用户作用域拒绝旧 Seed 晚包，NULL 余额保持未知且 approved 不表示权益', async () => {
  const late = deferred(); responder = request => request.url.endsWith('/catalog') ? response(catalog()) : late.promise;
  const h = await reactRoot(pricing.default, { navigate() {}, busy: false, authenticated: true, userId: UID });
  try {
    const oldRequest = requests('overview')[0];
    setup(catalog(), overview({ account: account(), seed_eligibility: 'pending' })); await h.setProps({ userId: UID2 });
    assert.ok(oldRequest.options.signal.aborted);
    late.resolve(response(overview({ account: account(), seed_eligibility: 'approved' }))); await h.settle();
    assert.doesNotMatch(h.text(), /Seed eligibility approved|\$39\.90/); assert.match(h.text(), /Seed offer requires approval/);
    assert.equal(requests('overview').length, 2); assert.equal(requests('catalog').length, 1);
  } finally { await h.unmount(); }
  setup(catalog(), overview({ account: account(), subscription: subscription({ status: 'active', paid_through: null }), seed_eligibility: 'approved' }));
  const b = await reactRoot(billing.default, { navigate() {}, busy: false, active: true, userId: UID });
  try {
    await b.settle(); assert.match(b.text(), /Recorded subscription/); assert.match(b.text(), /not proof of payment or entitlement/);
    assert.match(b.text(), /Not configured —/); assert.match(b.text(), /Paid throughNot set/); assert.doesNotMatch(b.text(), /Current plan|Payment successful/);
    const credits = b.elements(node => node.tagName === 'SECTION' && node.getAttribute('aria-label') === 'Credits')[0];
    assert.doesNotMatch(credits.textContent, /\b0\b/);
    await React.act(async () => { transport.notifySessionExpired(); });
    assert.doesNotMatch(b.text(), /Recorded subscription|Seed eligibility approved|Not configured —/); assert.match(b.text(), /session has expired/);
  } finally { await b.unmount(); }
});
test('金额边界遵循真实 SafeInteger：零报价保留，小数 minor units 仅允许月均比较', () => {
  const data = catalog(); data.plans[0].prices.forEach(price => { price.amount_minor = 0; }); data.plans[0].ai.monthly_credits = 0;
  assert.equal(client.validateCatalog(data).plans[0].prices[0].amount_minor, 0);
  assert.equal(client.validateOverview(overview({ account: account(), subscription: subscription({ amount_minor: 0 }) })).subscription.amount_minor, 0);
  assert.equal(client.formatBillingAmount(0), '$0.00'); assert.equal(client.formatBillingAmount(41300 / 12, 'USD', 'equivalent'), '$34.42');
  assert.equal(client.savesFiveMonths(client.validateCatalog(data).plans[0]), false);
  assert.match(pricingMarkup(data), /\$0\.00/); assert.match(pricingMarkup(data), /0 monthly credits/);
  for (const value of [41300 / 12, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100', null]) assert.throws(() => client.formatBillingAmount(value), apiError());
  for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100', null]) assert.throws(() => client.formatBillingAmount(value, 'USD', 'equivalent'), apiError());
  assert.throws(() => client.validateOverview(overview({ account: account(), subscription: subscription({ amount_minor: 0.5 }) })), apiError());
});
for (const [field, value] of [['mode', 'enforced'], ['payment_enabled', true], ['seed_eligibility', false]]) test(`概览拒绝 ${field}=${value}，不推断成功、额度或种子资格`, () => {
  assert.throws(() => client.validateOverview(overview({ [field]: value })), apiError());
});
test('真实 draft 积分包字段匹配 OpenAPI 并完整保留，展示记录而非虚构报价或购买入口', async () => {
  const data = packCatalog(), validated = client.validateCatalog(data);
  const schema = JSON.parse(readFileSync(resolve(root, '../backend/contracts/billing.openapi.json'), 'utf8')).components.schemas.BillingCreditPack;
  assert.deepEqual(validated, data); assert.deepEqual(Object.keys(validated.credit_packs[0]).sort(), schema.required.toSorted());
  const html = pricingMarkup(data), section = nodes(parseFragment(html), node => node.tagName === 'section' && attr(node, 'aria-label') === 'Credit add-ons')[0];
  for (const phrase of ['Recorded draft pack', 'draft · currently unavailable', '500 credits', 'Recorded price $12.34', 'Validity not confirmed']) assert.ok(text(section).includes(phrase), phrase);
  assert.doesNotMatch(text(section), /Prices are not configured|No offers available/); assert.equal(nodes(section, node => ['button', 'a'].includes(node.tagName)).length, 0);
  const changed = pricingMarkup(packCatalog([creditPack({ amount_minor: 6789, credits: 2500, validity_policy: 'days', validity_days: 30 })]));
  assert.match(changed, /\$67\.89/); assert.match(changed, /2,500 credits/); assert.match(changed, /30 days/); assert.doesNotMatch(changed, /\$12\.34/);
  const draftOverview = billingMarkup(overview({ addons_status: 'draft' })); assert.match(draftOverview, /Draft credit add-ons recorded/); assert.match(draftOverview, /currently unavailable/); assert.doesNotMatch(draftOverview, /Prices are not configured|\$/);
  setup(data, overview({ addons_status: 'draft' })); assert.deepEqual(await client.readCatalog(), data); assert.equal((await client.readOverview()).addons_status, 'draft');
});
for (const status of ['draft', 'active', 'retired']) test(`积分包真实 ${status} 状态不会开启付款或加购权益`, () => {
  const data = packCatalog([creditPack({ status })]), html = pricingMarkup(data);
  assert.ok(html.includes(`${status} · currently unavailable`)); assert.match(html, /Purchases are not enabled/);
  assert.equal(nodes(parseFragment(html), node => node.tagName === 'button' && attr(node, 'disabled') !== undefined).length, 3);
});
test('积分包拒绝未知字段、缺失必填字段与重复 ID，addons_status 与目录真实一致', () => {
  const extra = packCatalog(); extra.credit_packs[0].unknown = true; assert.throws(() => client.validateCatalog(extra), apiError());
  for (const key of Object.keys(creditPack())) { const data = packCatalog(); delete data.credit_packs[0][key]; assert.throws(() => client.validateCatalog(data), apiError()); }
  assert.throws(() => client.validateCatalog(packCatalog([creditPack(), creditPack()])), apiError());
  assert.throws(() => client.validateCatalog({ ...packCatalog(), addons_status: 'not_configured' }), apiError());
  assert.throws(() => client.validateCatalog({ ...catalog(), addons_status: 'draft' }), apiError());
});
for (const [field, values] of [
  ['credits', [0, -1, 0.5, null, Number.MAX_SAFE_INTEGER + 1]], ['tokens_per_credit', [0, -1, 0.5]],
  ['amount_minor', [-1, 0.5, '1234', Infinity]], ['validity_days', [0, -1, 0.5]],
  ['id', [id('bpr', 1), 'bcp_invalid']], ['name', ['', '\u0001']], ['currency', ['EUR']], ['status', ['available']],
]) test(`积分包 ${field} 严格校验，不允许虚假记录`, () => {
  for (const value of values) assert.throws(() => client.validateCatalog(packCatalog([creditPack({ [field]: value })])), apiError());
});
test('积分包零价及未知有效期合法，文本由 React 转义而非 HTML 注入', () => {
  const data = packCatalog([creditPack({ amount_minor: 0, name: '<img src=x onerror=alert(1)>' })]);
  assert.equal(client.validateCatalog(data).credit_packs[0].validity_days, null);
  const html = pricingMarkup(data); assert.match(html, /Recorded price \$0\.00/); assert.match(html, /&lt;img/);
  assert.equal(nodes(parseFragment(html), node => node.tagName === 'img').length, 0);
});
for (const paidThrough of [null, '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z']) test(`active + paid_through=${paidThrough} 仍是观测记录，显式提示不构成付款或权益`, () => {
  const html = billingMarkup(overview({ account: account(), subscription: subscription({ status: 'active', paid_through: paidThrough }) }));
  const section = nodes(parseFragment(html), node => node.tagName === 'section' && attr(node, 'aria-label') === 'Recorded subscription')[0];
  const visible = (section.childNodes ?? []).filter(node => node.tagName !== 'details').map(text).join('');
  assert.match(visible, /not proof of payment or entitlement/); assert.match(visible, /Payments are not enabled/); assert.match(visible, /Recorded statusactive/);
  assert.doesNotMatch(visible, /Current plan|No active subscription|Payment successful/);
});
for (const count of [0, 1, 2, 3]) test(`公开目录 ${count} 个真实套餐合法，SSR 不补齐已退役套餐`, async () => {
  const data = catalog(); data.plans = data.plans.slice(0, count);
  assert.deepEqual(client.validateCatalog(data), data);
  for (const interval of ['month', 'year']) {
    const html = pricingMarkup(data, interval), fragment = parseFragment(html);
    assert.equal(nodes(fragment, node => node.tagName === 'article').length, count);
    assert.equal(nodes(fragment, node => node.tagName === 'button' && attr(node, 'disabled') !== undefined).length, count);
    assert.doesNotMatch(html, /NaN|undefined/);
    if (count === 0) {
      assert.match(html, /No plans currently available/); assert.doesNotMatch(html, /\$|Maintain|Build|Unlimited AI usage|Monthly grants are scheduled/);
      assert.equal(nodes(fragment, node => attr(node, 'class') === 'billing-plan-grid').length, 0);
    } else assert.equal(attr(nodes(fragment, node => attr(node, 'class') === 'billing-plan-grid')[0], 'data-plan-count'), String(count));
  }
  setup(data); assert.deepEqual(await client.readCatalog(), data); assert.equal(calls.length, 1); calls.forEach(checkGet);
});
for (const intervals of [[], ['month'], ['year'], ['month', 'year']]) test(`套餐报价 [${intervals.join(',')}] 合法，按当前月年周期 SSR 显示或明确未配置`, () => {
  const data = catalog(); data.plans = [data.plans[0]]; data.plans[0].prices = data.plans[0].prices.filter(price => intervals.includes(price.interval));
  assert.deepEqual(client.validateCatalog(data), data);
  for (const interval of ['month', 'year']) {
    const html = pricingMarkup(data, interval), card = nodes(parseFragment(html), node => node.tagName === 'article')[0];
    assert.equal(nodes(card, node => node.tagName === 'button' && attr(node, 'disabled') !== undefined).length, 1);
    if (intervals.includes(interval)) {
      assert.ok(text(card).includes(interval === 'year' ? '$413.00' : '$59.00')); assert.doesNotMatch(text(card), /Price not configured/);
      if (interval === 'year') assert.match(text(card), /Equivalent to \$34\.42/);
    } else {
      assert.match(text(card), /Price not configured/); assert.doesNotMatch(text(card), /\$|Equivalent to|Full annual charge|Save 5 months|NaN|undefined/);
    }
    assert.equal(text(card).includes('Save 5 months'), interval === 'year' && intervals.length === 2);
  }
});
test('稀疏目录仍拒绝重复 code、plan ID、price ID、interval、非法数组及未校验价格', () => {
  const base = () => { const data = catalog(); data.plans = data.plans.slice(0, 2); data.plans.forEach(plan => { plan.prices = [plan.prices[0]]; }); return data; };
  for (const mutate of [
    data => { data.plans[1].code = data.plans[0].code; }, data => { data.plans[1].id = data.plans[0].id; },
    data => { data.plans[1].prices[0].id = data.plans[0].prices[0].id; },
    data => { data.plans[0].prices.push({ ...data.plans[0].prices[0], id: id('bpr', 99) }); },
    data => { data.plans[0].prices[0].amount_minor = 1.5; }, data => { data.plans[0].prices[0].interval = 'week'; },
    data => { data.plans[0].prices[0].currency = 'EUR'; },
  ]) { const data = base(); mutate(data); assert.throws(() => client.validateCatalog(data), apiError()); }
  for (const value of [null, {}, '[]', 0]) {
    assert.throws(() => client.validateCatalog({ ...catalog(), plans: value }), apiError());
    const data = base(); data.plans[0].prices = value; assert.throws(() => client.validateCatalog(data), apiError());
  }
  const unknown = base(); unknown.plans[0].code = 'future_plan'; assert.throws(() => client.validateCatalog(unknown), apiError());
});
test('真实 React hooks 在部分报价间月年切换：缺价不崩溃、不引用别的报价、不重新请求', async () => {
  const data = catalog(); data.plans[0].prices.pop(); data.plans[1].prices.shift(); data.plans[2].prices = [];
  setup(data); const h = await reactRoot(pricing.default, { navigate() {}, busy: true, authenticated: false, userId: null });
  try {
    await h.settle(); assert.match(h.text(), /\$59\.00/); assert.doesNotMatch(h.text(), /\$99\.00|\$199\.00/);
    const cards = () => h.elements(node => node.tagName === 'ARTICLE');
    assert.equal(cards().length, 3); assert.match(cards()[1].textContent, /Price not configured/); assert.match(cards()[2].textContent, /Price not configured/);
    await h.click('Yearly'); assert.match(cards()[0].textContent, /Price not configured/); assert.match(cards()[1].textContent, /\$693\.00/); assert.match(cards()[1].textContent, /Equivalent to \$57\.75/);
    assert.doesNotMatch(h.text(), /\$413\.00|\$1,393\.00|Save 5 months|NaN|undefined/);
    await h.click('Monthly'); assert.match(cards()[0].textContent, /\$59\.00/); assert.match(cards()[1].textContent, /Price not configured/);
    const pay = h.elements(node => node.tagName === 'BUTTON' && node.textContent === 'Payments not enabled'); assert.equal(pay.length, 3); assert.ok(pay.every(node => node.getAttribute('disabled') !== null));
    assert.equal(calls.length, 1); calls.forEach(checkGet);
  } finally { await h.unmount(); }
});
test('真实公共空目录保留付款关闭和种子审批说明，不调用本人接口或伪造三档', async () => {
  const data = catalog(); data.plans = []; setup(data);
  const h = await reactRoot(pricing.default, { navigate() {}, busy: false, authenticated: false, userId: null });
  try {
    await h.settle(); assert.match(h.text(), /No plans currently available/); assert.match(h.text(), /Payments are not enabled/); assert.match(h.text(), /Seed offer requires approval/);
    assert.doesNotMatch(h.text(), /\$|Seed eligibility approved|Maintain|Unlimited AI usage|failed validation|NaN/);
    await h.click('Yearly'); assert.equal(h.elements(node => node.tagName === 'ARTICLE').length, 0);
    assert.equal(calls.length, 1); assert.equal(requests('overview').length, 0); calls.forEach(checkGet);
  } finally { await h.unmount(); }
});
test('空公开目录不否认独立本人 Seed 审批，已知全局报价可读但不补 Unlimited 套餐或权益', async () => {
  const data = catalog(); data.plans = [];
  setup(data, overview({ account: account(), seed_eligibility: 'approved' })); const h = pricingReader({ authenticated: true, userId: UID }); await h.settle();
  assert.match(h.text(), /No plans currently available/); assert.match(h.text(), /Seed eligibility approved/); assert.match(h.text(), /\$39\.90/); assert.match(h.text(), /not purchasable/);
  assert.equal(h.elements(node => node.type === 'article').length, 0); assert.equal(h.elements(node => node.type === 'button' && node.props.disabled).length, 0);
  assert.equal(requests('catalog').length, 1); assert.equal(requests('overview').length, 1); calls.forEach(checkGet);
  assert.deepEqual(client.validateOverview(overview({ account: account(), subscription: subscription() }), data).subscription, subscription());
  for (const patch of [{ amount_minor: 3900 }, { requires_approval: false }, { purchasable: true }]) assert.throws(() => client.validateCatalog({ ...data, seed_offer: { ...data.seed_offer, ...patch } }), apiError());
});
for (const scenario of ['all_service_month', 'mixed', 'all_unconfirmed', 'empty']) test(`Plan details 按真实 grant_schedule ${scenario} 说明，不把所有授予周期硬写未确认`, () => {
  const data = catalog();
  if (scenario === 'empty') data.plans = [];
  else data.plans.forEach((plan, index) => {
    if (scenario === 'all_service_month' || (scenario === 'mixed' && index === 0)) {
      plan.ai.allocation_status = 'confirmed'; plan.ai.grant_schedule = 'service_month';
    }
  });
  const html = pricingMarkup(data), details = nodes(parseFragment(html), node => node.tagName === 'details')[0];
  assert.doesNotMatch(text(details), /Monthly grants have not been confirmed/);
  if (scenario === 'all_service_month') {
    assert.match(text(details), /Monthly grants are scheduled by service month/); assert.doesNotMatch(text(details), /unconfirmed|marked proposed/);
  } else if (scenario === 'empty') {
    assert.match(text(details), /No plan grant schedules are configured/); assert.doesNotMatch(text(details), /Monthly grants are scheduled|Some monthly grant schedules/);
  } else {
    assert.match(text(details), /Some monthly grant schedules remain unconfirmed/); assert.match(text(details), /marked proposed/);
  }
  if (scenario !== 'empty') assert.match(text(details), /This catalog does not grant credits/);
  assert.match(html, /Payments are not enabled/);
});
for (const [policy, days, expected] of [['unconfirmed', null, 'Validity not confirmed'], ['never_expires', null, 'No expiry'], ['days', 30, '30 days']]) test(`积分包 ${policy} 有效期契约完整保留并按真实策略展示 ${expected}`, async () => {
  const data = packCatalog([creditPack({ validity_policy: policy, validity_days: days })]);
  assert.deepEqual(client.validateCatalog(data), data);
  const section = nodes(parseFragment(pricingMarkup(data)), node => node.tagName === 'section' && attr(node, 'aria-label') === 'Credit add-ons')[0];
  assert.ok(text(section).includes(expected)); assert.match(text(section), /currently unavailable/);
  for (const phrase of ['Validity not confirmed', 'No expiry', '30 days']) if (phrase !== expected) assert.ok(!text(section).includes(phrase));
  setup(data); assert.deepEqual(await client.readCatalog(), data); assert.equal(calls.length, 1); calls.forEach(checkGet);
});
test('积分包 validity_policy 必填且严格保持 null 与正整数天数一致，旧缺字段响应不得猜测有效期', async () => {
  for (const pack of [
    creditPack({ validity_policy: 'days', validity_days: null }), creditPack({ validity_policy: 'unconfirmed', validity_days: 30 }),
    creditPack({ validity_policy: 'never_expires', validity_days: 30 }), creditPack({ validity_policy: 'unknown' }),
    creditPack({ validity_policy: null }), creditPack({ validity_policy: false }),
    ...[0, -1, 0.5, '30', Number.MAX_SAFE_INTEGER + 1, undefined].map(value => creditPack({ validity_policy: 'days', validity_days: value })),
  ]) assert.throws(() => client.validateCatalog(packCatalog([pack])), apiError());
  const data = packCatalog(); delete data.credit_packs[0].validity_policy;
  assert.throws(() => client.validateCatalog(data), apiError()); setup(data); await assert.rejects(client.readCatalog(), apiError());
  const h = pricingReader(); await h.settle(); assert.match(h.text(), /failed validation/); assert.doesNotMatch(h.text(), /No expiry|Recorded draft pack|\$12\.34/);
});
test('三档套餐在所有响应式规则中保持横排，窄屏使用最小卡宽与容器滚动', () => {
  const cssTree = require('css-tree'), gridRules = [], siblingRules = [];
  const tree = cssTree.parse(readFileSync(resolve(root, 'src/billing-page.css'), 'utf8'), { onParseError(error) { throw error; } });
  cssTree.walk(tree, { visit: 'Rule', enter(node) {
    const selectors = node.prelude.children.toArray().map(selector => cssTree.generate(selector).replace(/\s*\+\s*/g, ' + '));
    const declarations = node.block.children.toArray().filter(item => item.type === 'Declaration')
      .map(item => [item.property, cssTree.generate(item.value).trim()]);
    if (selectors.includes('.billing-page .billing-plan-grid')) gridRules.push(declarations);
    if (selectors.includes('.billing-page .billing-plan + .billing-plan')) siblingRules.push(declarations);
  } });
  const columns = gridRules.flat().filter(([property]) => property === 'grid-template-columns').map(([, value]) => value);
  assert.equal(columns.length, 2);
  assert.ok(columns.every(value => /^repeat\(3,/.test(value)), '三档不能在响应式规则中折叠成单列');
  assert.ok(columns.some(value => value.includes('220px')), '窄屏卡片保留可读的最小宽度');
  assert.ok(gridRules.flat().some(([property, value]) => property === 'overflow-x' && value === 'auto'));
  assert.ok(siblingRules.flat().some(([property, value]) => property === 'border-left' && value.startsWith('1px solid')));
  assert.ok(!siblingRules.flat().some(([property]) => property === 'border-top'), '保持横向分隔线');
  const fragment = parseFragment(pricingMarkup(catalog()));
  const grid = nodes(fragment, node => attr(node, 'class') === 'billing-plan-grid')[0];
  assert.equal(attr(grid, 'data-plan-count'), '3');
  assert.deepEqual((grid.childNodes ?? []).filter(node => node.tagName === 'article').map(node => attr(node, 'aria-label')),
    ['Maintain plan', 'Build plan', 'Unlimited plan']);
});
test('样式全部 scoped、正文14px标签11px、黑白灰细线，无依赖全局或大装饰', () => {
  const cssTree = require('css-tree'), selectors = [], declarations = [];
  const tree = cssTree.parse(readFileSync(resolve(root, 'src/billing-page.css'), 'utf8'), { onParseError(error) { throw error; } });
  cssTree.walk(tree, { enter(node) {
    if (node.type === 'Rule') node.prelude.children.forEach(selector => selectors.push(cssTree.generate(selector)));
    if (node.type === 'Declaration') declarations.push([node.property, cssTree.generate(node.value).trim()]);
  } });
  assert.ok(selectors.every(selector => selector.startsWith('.billing-page')));
  for (const pair of [['background', '#fff'], ['--billing-line', '#dedede'], ['font-size', '14px'], ['font-size', '11px'], ['color-scheme', 'light']]) assert.ok(declarations.some(([key, value]) => key === pair[0] && value === pair[1]));
  assert.ok(selectors.includes('.billing-page .billing-primary')); assert.ok(!declarations.some(([key]) => key === 'animation' || key === 'background-image'));
});
