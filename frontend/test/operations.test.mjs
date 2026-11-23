import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 沿用 table-folk 的 TS 内存编译及真实 React SSR；夹具不进入生产模块。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'package.json'));
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { parseFragment } = require('parse5');
const cssTree = require('css-tree');
const extensions = Object.fromEntries(['.ts', '.tsx', '.css'].map(name => [name, Module._extensions[name]]));
const originalGlobals = Object.fromEntries(['window', 'fetch'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const initialCache = new Set(Object.keys(require.cache));
const RID = 'restaurant_fixture_000001';
const UID = `usr_${'u'.repeat(24)}`;
const ID = `rsv_${'a'.repeat(24)}`;
const OTHER_ID = `rsv_${'b'.repeat(24)}`;
const KEY = '12345678-1234-4234-8234-123456789abc';
const CSRF = 'fixture-csrf-token-'.repeat(3);
const BASE = `/api/v1/restaurants/${RID}/reservations`;
const ANALYTICS = `/api/v1/restaurants/${RID}/analytics`;
const NOW = '2026-03-01T10:00:00.000Z';
let transport, reservations, analytics, reservationViews, analyticsViews, routes;
let calls, timers, unexpected, nextTimer, responder;
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
function load(name) { return require(resolve(root, 'src', name)); }
function stubWindow(path = '/') {
  globalThis.window = {
    location: { pathname: path, origin: 'https://localhost:5173', hash: '', search: '' },
    history: { state: null, replaceState() {}, pushState() {}, go() {} },
    addEventListener() {}, removeEventListener() {},
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
}
function response(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
function rejection(status, code = 'REQUEST_FAILED', headers = {}, details = []) {
  return response({ code, details }, status, headers);
}
function fakeFetch(fn) { responder = fn; }
function onlyResponse(data) { fakeFetch(() => response(data)); }
function writes(method = 'POST') { return calls.filter(call => call.options.method === method); }
function apiError(status, code) {
  return error => {
    assert.ok(error instanceof transport.ApiError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  };
}
function deferred() {
  let resolvePromise, reject;
  const promise = new Promise((yes, no) => { resolvePromise = yes; reject = no; });
  return { promise, resolve: resolvePromise, reject };
}
const turn = () => new Promise(done => setImmediate(done));
function record(overrides = {}) {
  return {
    id: ID, reference: 'RABCDEFGH', status: 'pending', restaurant_name: 'Fixture Dining', timezone: 'America/New_York',
    guest_name: 'Private Fixture Guest', guest_email_masked: 'f***@example.test', party_size: 2,
    local_date: '2026-03-04', local_time: '18:30', requested_start_at: '2026-03-04T23:30:00.000Z',
    note: null, decision_reason: null, cancelled_at: null, cancelled_by_type: null, revision: 1, created_at: NOW,
    guest_email: 'fixture@example.test', guest_phone: null, internal_note: null, decided_at: null,
    decided_by_user_id: null, updated_at: NOW, ...overrides,
  };
}
function event(overrides = {}) {
  return { event_type: 'created', actor_type: 'guest', from_status: null, to_status: 'pending', reservation_revision: 1, created_at: NOW, ...overrides };
}
function detail(overrides = {}) { return { reservation: record(overrides), events: [event()] }; }
function settings(overrides = {}) {
  return { restaurant_revision: 7, enabled: false, notice: null, privacy_notice_version: null, timezone: null, intervals: [], ...overrides };
}
function pageItems() {
  return Array.from({ length: 20 }, (_, index) => record({
    id: `rsv_${String(99 - index).padStart(24, '0')}`,
    created_at: new Date(Date.parse(NOW) - index * 1000).toISOString(),
  }));
}
function cursor(last = pageItems().at(-1), overrides = {}) {
  const payload = { v: 1, u: UID, r: RID, l: 20, t: last.created_at, i: last.id, ...overrides };
  // 仅夹具结构签名；签名真实性和用户绑定由后端鉴权，前端不会伪称已验证 HMAC。
  return `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${'s'.repeat(43)}`;
}
const statusKeys = ['pending', 'confirmed', 'declined', 'cancelled'];
function counts(states = {}, party = 0) {
  const statuses = Object.fromEntries(statusKeys.map(key => [key, states[key] ?? 0]));
  return { requests: Object.values(statuses).reduce((sum, n) => sum + n, 0), party_size: party, statuses };
}
function report() {
  return {
    restaurant_id: RID, range: { from: '2026-03-01', to: '2026-03-04' }, namespace: 'local_test', metric_version: 'v1',
    generated_at: NOW, current_timezone: 'UTC', timezone_fallback: true,
    traffic: { days: [
      { date: '2026-03-04', timezone: 'UTC', timezone_fallback: false, page_views: 4, reservation_clicks: 1, reservation_form_views: 2 },
      { date: '2026-03-01', timezone: 'UTC', timezone_fallback: true, page_views: 5, reservation_clicks: 2, reservation_form_views: 1 },
      { date: '2026-03-01', timezone: 'Asia/Tokyo', timezone_fallback: false, page_views: 7, reservation_clicks: 1, reservation_form_views: 3 },
    ], totals: { page_views: 16, reservation_clicks: 4, reservation_form_views: 6 }, semantics: {
      page_views: 'successful document requests, not people',
      reservation_clicks: 'platform entry redirect opened; not every button click',
      reservation_form_views: 'successful reservation form GET',
    } },
    reservations: { scope: 'all_restaurant_records', status_semantics: 'current_status_at_query_time',
      created: { days: [
        { date: '2026-03-01', timezone: 'UTC', ...counts({ confirmed: 2 }, 5) },
        { date: '2026-03-01', timezone: 'Asia/Tokyo', ...counts({ pending: 1 }, 2) },
      ], totals: counts({ pending: 1, confirmed: 2 }, 7) },
      scheduled: { days: [{ date: '2026-03-04', timezone: 'UTC', ...counts({ declined: 1, cancelled: 1 }, 8) }], totals: counts({ declined: 1, cancelled: 1 }, 8) },
    },
    subscriptions: { available: false, active_count: null, reason: 'SUBSCRIPTIONS_NOT_IMPLEMENTED' },
    visitors: { available: false, unique_visitors: null, reason: 'UV_NOT_MEASURED' },
  };
}
function emptyReport() {
  const data = report();
  data.traffic.days = [];
  data.traffic.totals = { page_views: 0, reservation_clicks: 0, reservation_form_views: 0 };
  for (const basis of ['created', 'scheduled']) data.reservations[basis] = { days: [], totals: counts() };
  return data;
}
function checkTransport(call, method, body, key = KEY) {
  assert.equal(call.options.method, method);
  assert.equal(call.options.credentials, 'same-origin');
  assert.equal(call.options.cache, 'no-store');
  assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.referrerPolicy, 'same-origin');
  assert.equal(call.options.headers.get('Accept'), 'application/json');
  assert.ok(call.options.signal instanceof AbortSignal);
  if (body !== undefined) {
    assert.equal(call.options.body, JSON.stringify(body));
    assert.equal(call.options.headers.get('Content-Type'), 'application/json');
    assert.equal(call.options.headers.get('X-CSRF-Token'), CSRF);
    assert.equal(call.options.headers.get('Idempotency-Key'), key);
  } else {
    assert.equal(call.options.body, undefined);
    assert.equal(call.options.headers.get('X-CSRF-Token'), null);
    assert.equal(call.options.headers.get('Idempotency-Key'), null);
  }
}

before(() => {
  const compile = (module, filename) => module._compile(compiledSource(filename), filename);
  Module._extensions['.ts'] = compile;
  Module._extensions['.tsx'] = compile;
  Module._extensions['.css'] = () => {};
  transport = load('api.ts');
  reservations = load('reservations-client.ts');
  analytics = load('analytics-client.ts');
  reservationViews = load('ReservationsPage.tsx');
  analyticsViews = load('AnalyticsPage.tsx');
  routes = load('routing.ts');
});
beforeEach(() => {
  calls = []; timers = new Map(); unexpected = []; nextTimer = 0;
  responder = () => { throw new Error('没有配置测试回包'); };
  stubWindow(); transport.clearCsrf();
  globalThis.fetch = async (url, options) => {
    const call = { url: String(url), options }; calls.push(call);
    if (call.url === '/api/v1/auth/csrf') return response({ csrf_token: CSRF });
    try { return responder(call); }
    catch (error) {
      // 有意模拟网络失败须返回 rejected Promise；同步 throw 表示未预期请求。
      unexpected.push({ url: call.url, error });
      throw error;
    }
  };
});
afterEach(async () => {
  // 独立父/子 harness 按挂载逆序清理，避免子 cleanup 回调已卸载的父 state。
  for (const harness of [...harnesses].reverse()) harness.unmount();
  harnesses.clear();
  await turn();
  assert.deepEqual(unexpected, [], '不得意外访问网络或未配置的接口');
  assert.equal(timers.size, 0, 'transport 的超时器必须释放');
  transport.clearCsrf();
});
after(() => {
  for (const [name, handler] of Object.entries(extensions)) {
    if (handler) Module._extensions[name] = handler;
    else delete Module._extensions[name];
  }
  for (const [name, descriptor] of Object.entries(originalGlobals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  for (const filename of Object.keys(require.cache)) {
    if (!initialCache.has(filename) && filename.startsWith(resolve(root, 'src') + '/')) delete require.cache[filename];
  }
});

test('列表过滤通过真实 GET transport，空页和 20 条 cursor 分页保留后端协议', async () => {
  const items = pageItems(), token = cursor(items.at(-1));
  const filters = { status: 'pending', from: '2026-03-01', to: '2026-03-04' };
  fakeFetch(call => {
    const url = new URL(call.url, window.location.origin);
    assert.equal(url.pathname, BASE);
    assert.deepEqual(Object.fromEntries(url.searchParams), { limit: '20', ...filters, ...(url.searchParams.has('cursor') ? { cursor: token } : {}) });
    return response(url.searchParams.has('cursor') ? { items: [], next_cursor: null } : { items, next_cursor: token });
  });
  assert.deepEqual(await reservations.reservationsClient.list(RID, filters), { items, next_cursor: token });
  assert.deepEqual(await reservations.reservationsClient.list(RID, filters, token), { items: [], next_cursor: null });
  assert.equal(calls.length, 2);
  calls.forEach(call => checkTransport(call, 'GET'));
  assert.equal(reservations.RESERVATION_PAGE_SIZE, 20);
});

for (const [label, filters] of [
  ['未知状态', { status: 'arrived' }], ['非法日期', { from: '2026-02-30' }],
  ['非闰年', { to: '2025-02-29' }], ['倒置日期', { from: '2026-03-04', to: '2026-03-01' }],
  ['未知字段', { limit: 100 }],
]) test(`列表拒绝输入 ${label}，不发请求`, async () => {
  await assert.rejects(reservations.reservationsClient.list(RID, filters), apiError(422, 'REQUEST_INVALID'));
  assert.equal(calls.length, 0);
});

for (const [label, mutate] of [
  ['超页长', data => { data.items.push(record()); }],
  ['重复 ID', data => { data.items[1] = data.items[0]; }],
  ['创建时间倒序错误', data => { data.items.reverse(); }],
  ['状态不匹配', data => { data.items[0].status = 'confirmed'; }],
  ['日期不匹配', data => { data.items[0].local_date = '2026-03-05'; }],
  ['未知状态', data => { data.items[0].status = 'arrived'; }],
  ['cursor 非法', data => { data.next_cursor = 'not-a-cursor'; }],
  ['cursor 缺失', data => { delete data.next_cursor; }],
  ['cursor 餐厅错误', data => { data.next_cursor = cursor(data.items.at(-1), { r: 'other_restaurant_0001' }); }],
  ['cursor 页长错误', data => { data.next_cursor = cursor(data.items.at(-1), { l: 19 }); }],
  ['cursor 尾 ID 错误', data => { data.next_cursor = cursor(data.items.at(-1), { i: ID }); }],
  ['cursor 尾时间错误', data => { data.next_cursor = cursor(data.items.at(-1), { t: NOW }); }],
  ['非满页有 cursor', data => { data.items.pop(); data.next_cursor = cursor(data.items.at(-1)); }],
]) test(`列表拒绝未验证回包 ${label}`, async () => {
  const data = { items: pageItems(), next_cursor: null }; mutate(data); onlyResponse(data);
  await assert.rejects(reservations.reservationsClient.list(RID, { status: 'pending', to: '2026-03-04' }), apiError(502, 'RESPONSE_INVALID'));
  assert.equal(calls.length, 1);
});

for (const [label, overrides] of [
  ['版本', { v: 2 }], ['作用域', { r: 'other_restaurant_0001' }], ['用户 ID', { u: 'bad' }],
  ['页长', { l: 40 }], ['尾 ID', { i: '../bad' }], ['日期', { t: '2026-02-30T10:00:00.000Z' }],
]) test(`cursor 输入校验 ${label}，不发请求`, async () => {
  await assert.rejects(reservations.reservationsClient.list(RID, {}, cursor(undefined, overrides)), apiError(502, 'RESPONSE_INVALID'));
  assert.equal(calls.length, 0);
});

test('详情保留合法 null 和严格递减事件；ID 输入与回包必须匹配', async () => {
  const data = detail({ status: 'confirmed', revision: 2, guest_email: null, guest_email_masked: null });
  data.events.unshift(event({ event_type: 'confirmed', actor_type: 'merchant', from_status: 'pending', to_status: 'confirmed', reservation_revision: 2 }));
  onlyResponse(data);
  assert.deepEqual(await reservations.reservationsClient.detail(RID, ID), data);
  assert.equal(calls[0].url, `${BASE}/${ID}`); checkTransport(calls[0], 'GET');
  await assert.rejects(reservations.reservationsClient.detail(RID, '../private'), apiError(422, 'REQUEST_INVALID'));
  await assert.rejects(reservations.reservationsClient.detail('../private', ID), apiError(422, 'REQUEST_INVALID'));
  assert.equal(calls.length, 1);
  onlyResponse(detail({ id: OTHER_ID }));
  await assert.rejects(reservations.reservationsClient.detail(RID, ID), apiError(502, 'RESPONSE_INVALID'));
});

for (const [field, value] of [
  ['status', 'unknown'], ['party_size', 0], ['party_size', 21], ['party_size', 1.5],
  ['revision', 0], ['revision', Number.MAX_SAFE_INTEGER + 1], ['revision', '1'],
  ['local_date', '2026-02-30'], ['local_date', '2025-02-29'], ['local_time', '24:00'],
  ['requested_start_at', '2026-02-30T10:00:00.000Z'], ['created_at', '2026-03-01T10:00:00Z'],
  ['timezone', 'Invalid/Fixture'], ['guest_name', null], ['guest_email', undefined], ['note', undefined],
  ['cancelled_by_type', 'unknown'], ['decided_by_user_id', 'bad'],
]) test(`详情拒绝 ${field}=${String(value)}`, async () => {
  onlyResponse(detail({ [field]: value }));
  await assert.rejects(reservations.reservationsClient.detail(RID, ID), apiError(502, 'RESPONSE_INVALID'));
});

for (const [label, events] of [
  ['未知事件', [event({ event_type: 'arrived' })]],
  ['未知 actor', [event({ actor_type: 'admin' })]],
  ['错误迁移', [event({ event_type: 'confirmed', from_status: 'cancelled', to_status: 'confirmed' })]],
  ['超 reservation revision', [event({ reservation_revision: 3 })]],
  ['重复 revision', [event(), event()]],
  ['升序 revision', [event(), event({ event_type: 'confirmed', from_status: 'pending', to_status: 'confirmed', reservation_revision: 2 })]],
  ['超过 50 事件', Array.from({ length: 51 }, () => event())],
]) test(`详情拒绝事件 ${label}`, async () => {
  onlyResponse({ reservation: record({ revision: 2 }), events });
  await assert.rejects(reservations.reservationsClient.detail(RID, ID), apiError(502, 'RESPONSE_INVALID'));
});

test('date_invalid 错误 fixture 原样经过 api.ts 错误协议，不转换为假成功', async () => {
  fakeFetch(() => rejection(422, 'VALIDATION_FAILED', {}, [{ field: 'from', code: 'date_invalid' }]));
  await assert.rejects(reservations.reservationsClient.list(RID, { from: '2026-03-01' }), error => {
    apiError(422, 'VALIDATION_FAILED')(error);
    assert.deepEqual(error.details, [{ field: 'from', code: 'date_invalid' }]); return true;
  });
});

for (const reason of [undefined, '', ' \n ', null, 7, 'x'.repeat(501)]) test(`decline reason 必须非空且最多 500 字符：${String(reason).slice(0, 12)}`, async () => {
  await assert.rejects(reservations.reservationsClient.decide(RID, ID, { decision: 'decline', expected_revision: 1, reason }, KEY), apiError(422, 'REQUEST_INVALID'));
  assert.equal(calls.length, 0);
});

for (const method of ['decide', 'cancel', 'updateSettings']) test(`${method} 拒绝非 UUID、安全整数错误及未知字段，不读取 CSRF`, async () => {
  const input = method === 'decide' ? { decision: 'confirm', expected_revision: 1 }
    : method === 'cancel' ? { expected_revision: 1 } : { expected_revision: 7, enabled: false, notice: null };
  const send = (body, key = KEY) => method === 'updateSettings'
    ? reservations.reservationsClient[method](RID, body, key) : reservations.reservationsClient[method](RID, ID, body, key);
  for (const key of ['not-a-uuid', '', `${KEY}/bad`]) await assert.rejects(send(input, key), apiError(422, 'REQUEST_INVALID'));
  for (const expected_revision of [null, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1, 2147483647]) {
    await assert.rejects(send({ ...input, expected_revision }), apiError(422, 'REQUEST_INVALID'));
  }
  await assert.rejects(send({ ...input, unknown: true }), apiError(422, 'REQUEST_INVALID'));
  assert.equal(calls.length, 0);
});

for (const action of ['confirm', 'decline', 'cancel']) test(`${action} 显式发送 UUID 和原 body，成功回包只接受递增 revision`, async () => {
  const input = action === 'cancel' ? { expected_revision: 1, reason: 'Fixture cancellation' }
    : { decision: action, expected_revision: 1, ...(action === 'decline' ? { reason: 'Fixture decline' } : {}) };
  const send = () => action === 'cancel' ? reservations.reservationsClient.cancel(RID, ID, input, KEY)
    : reservations.reservationsClient.decide(RID, ID, input, KEY);
  const data = record({ status: action === 'cancel' ? 'cancelled' : action === 'decline' ? 'declined' : 'confirmed', revision: 2 });
  onlyResponse(data);
  assert.deepEqual(await send(), data);
  assert.equal(calls[0].url, '/api/v1/auth/csrf');
  assert.equal(writes().length, 1);
  assert.equal(writes()[0].url, `${BASE}/${ID}/${action === 'cancel' ? 'cancel' : 'decision'}`);
  checkTransport(writes()[0], 'POST', input);
  onlyResponse(record());
  await assert.rejects(send(), apiError(502, 'RESPONSE_INVALID'));
  onlyResponse(record({ id: OTHER_ID, revision: 2 }));
  await assert.rejects(send(), apiError(502, 'RESPONSE_INVALID'));
});

for (const method of ['decide', 'cancel', 'updateSettings']) {
  for (const failure of ['network', 'timeout', 401, 403, 409, 412, 429]) test(`${method} ${failure} 不自动重放写入（CSRF/会话刷新除外）`, async () => {
    const input = method === 'decide' ? { decision: 'confirm', expected_revision: 1 }
      : method === 'cancel' ? { expected_revision: 1 } : { enabled: false, notice: null, expected_revision: 7 };
    const expired = [];
    const unsubscribe = transport.onSessionExpired(() => expired.push(true));
    fakeFetch(() => {
      if (failure === 'network') return Promise.reject(new TypeError('夹具网络未知'));
      if (failure === 'timeout') {
        const timer = [...timers.values()].at(-1);
        assert.equal(timer.ms, 20000); timer.fn();
        return Promise.reject(new TypeError('夹具超时'));
      }
      return rejection(failure, failure === 403 ? 'CSRF_INVALID' : 'REQUEST_FAILED',
        failure === 401 ? { 'WWW-Authenticate': 'Session' } : failure === 429 ? { 'Retry-After': '9' } : {});
    });
    try {
      const pending = method === 'updateSettings' ? reservations.reservationsClient.updateSettings(RID, input, KEY)
        : reservations.reservationsClient[method](RID, ID, input, KEY);
      await assert.rejects(pending, error => {
        apiError(typeof failure === 'number' ? failure : 0,
          failure === 'network' ? 'NETWORK_ERROR' : failure === 'timeout' ? 'REQUEST_TIMEOUT' : failure === 403 ? 'CSRF_INVALID' : 'REQUEST_FAILED')(error);
        assert.equal(error.retryAfter, failure === 429 ? 9 : null); return true;
      });
      await turn();
      const actual = writes(method === 'updateSettings' ? 'PATCH' : 'POST');
      assert.equal(actual.length, 1); checkTransport(actual[0], method === 'updateSettings' ? 'PATCH' : 'POST', input);
      assert.equal(calls.filter(call => call.url === '/api/v1/auth/csrf').length, [401, 403].includes(failure) ? 2 : 1);
      assert.equal(expired.length, failure === 401 ? 1 : 0);
    } finally { unsubscribe(); }
  });
}

test('settings GET 保留 null，PATCH 使用共享 restaurant revision 精确 +1', async () => {
  onlyResponse(settings());
  assert.deepEqual(await reservations.reservationsClient.settings(RID), settings());
  assert.equal(calls[0].url, `${BASE}/settings`); checkTransport(calls[0], 'GET');
  const input = { enabled: true, notice: null, privacy_notice_version: 'fixture-v1', expected_revision: 7 };
  const data = settings({ restaurant_revision: 8, enabled: true, privacy_notice_version: 'fixture-v1', timezone: 'UTC',
    intervals: [{ weekday: 7, opens_at_local: '22:00', closes_at_local: '02:00', closes_day_offset: 1, accepts_requests: true }] });
  onlyResponse(data);
  assert.deepEqual(await reservations.reservationsClient.updateSettings(RID, input, KEY), data);
  assert.equal(writes('PATCH')[0].url, `${BASE}/settings`); checkTransport(writes('PATCH')[0], 'PATCH', input);
  for (const restaurant_revision of [7, 9]) {
    onlyResponse(settings({ restaurant_revision }));
    await assert.rejects(reservations.reservationsClient.updateSettings(RID, input, KEY), apiError(502, 'RESPONSE_INVALID'));
  }
});

for (const [label, mutate] of [
  ['revision 安全整数', data => { data.restaurant_revision = Number.MAX_SAFE_INTEGER + 1; }],
  ['undefined 不等于 null', data => { delete data.notice; }], ['时区', data => { data.timezone = 'Invalid/Fixture'; }],
  ['星期', data => { data.intervals[0].weekday = 8; }], ['零长度', data => { data.intervals[0].closes_at_local = '10:00'; }],
  ['超过一天', data => { data.intervals[0].closes_day_offset = 1; }], ['bool', data => { data.enabled = 'false'; }],
]) test(`settings 拒绝回包 ${label}`, async () => {
  const data = settings({ intervals: [{ weekday: 1, opens_at_local: '10:00', closes_at_local: '12:00', closes_day_offset: 0, accepts_requests: false }] });
  mutate(data); onlyResponse(data);
  await assert.rejects(reservations.reservationsClient.settings(RID), apiError(502, 'RESPONSE_INVALID'));
});

test('analytics 真实 GET 接受稀疏多时区桶、safe totals 和 UV null，不补造原始行', async () => {
  const data = report(), original = structuredClone(data);
  onlyResponse(data);
  const query = { ...data.range, namespace: 'local_test' };
  const checked = await analytics.readAnalytics(RID, query);
  assert.equal(calls[0].url, `${ANALYTICS}?from=2026-03-01&to=2026-03-04&namespace=local_test`);
  checkTransport(calls[0], 'GET');
  assert.deepEqual(data, original);
  assert.equal(checked.traffic.days.length, 3);
  assert.deepEqual(checked.traffic.days.map(day => [day.date, day.timezone]), [
    ['2026-03-01', 'Asia/Tokyo'], ['2026-03-01', 'UTC'], ['2026-03-04', 'UTC'],
  ]);
  assert.deepEqual(checked.traffic.totals, data.traffic.totals);
  assert.deepEqual(checked.reservations.created.totals, counts({ pending: 1, confirmed: 2 }, 7));
  assert.deepEqual(checked.reservations.scheduled.totals, counts({ declined: 1, cancelled: 1 }, 8));
  assert.equal(checked.visitors.unique_visitors, null); assert.equal(checked.subscriptions.active_count, null);
  assert.equal(checked.reservations.scope, 'all_restaurant_records');
});

test('analytics 默认范围交给后端，途中改 query 不改变回包预期快照', async () => {
  const pending = deferred(); fakeFetch(() => pending.promise);
  const data = report(), query = { ...data.range, namespace: 'local_test' };
  const request = analytics.readAnalytics(RID, query);
  query.from = '2026-04-01'; query.namespace = 'production';
  pending.resolve(response(data));
  assert.deepEqual((await request).range, data.range);
  onlyResponse(data); await analytics.readAnalytics(RID);
  assert.equal(calls.at(-1).url, ANALYTICS);
});

for (const [label, query, code] of [
  ['缺 to', { from: '2026-03-01' }, 'ANALYTICS_RANGE_INVALID'],
  ['非法日', { from: '2026-02-30', to: '2026-03-01' }, 'ANALYTICS_RANGE_INVALID'],
  ['年零', { from: '0000-01-01', to: '0000-01-02' }, 'ANALYTICS_RANGE_INVALID'],
  ['倒置', { from: '2026-03-04', to: '2026-03-01' }, 'ANALYTICS_RANGE_INVALID'],
  ['367 日', { from: '2024-01-01', to: '2025-01-01' }, 'ANALYTICS_RANGE_INVALID'],
  ['未知 namespace', { namespace: 'staging' }, 'ANALYTICS_NAMESPACE_INVALID'],
  ['未知字段', { basis: 'created' }, 'ANALYTICS_REQUEST_INVALID'],
]) test(`analytics 输入 ${label} 不发请求`, async () => {
  await assert.rejects(analytics.readAnalytics(RID, query), apiError(422, code)); assert.equal(calls.length, 0);
});

test('analytics inclusive 366 天边界及 BigInt safe sums，不接受 unsafe/负数/null', async () => {
  const range = { from: '2024-01-01', to: '2024-12-31' };
  assert.equal(analytics.analyticsCalendarDates(range).length, 366);
  assert.deepEqual(analytics.analyticsCalendarDates({ from: '2024-02-29', to: '2024-02-29' }), ['2024-02-29']);
  const data = emptyReport(); data.range = range; onlyResponse(data);
  assert.deepEqual((await analytics.readAnalytics(RID, range)).range, range);
  assert.equal(analytics.safeAnalyticsSum([]), 0);
  assert.equal(analytics.safeAnalyticsSum([Number.MAX_SAFE_INTEGER - 1, 1]), Number.MAX_SAFE_INTEGER);
  assert.throws(() => analytics.safeAnalyticsSum([Number.MAX_SAFE_INTEGER, 1]), apiError(502, 'ANALYTICS_COUNT_OVERFLOW'));
  for (const value of [Number.MAX_SAFE_INTEGER + 1, -1, 1.5, NaN, Infinity, null, '1']) {
    assert.throws(() => analytics.safeAnalyticsSum([value]), apiError(502, 'ANALYTICS_RESPONSE_INVALID'));
  }
});

for (const [label, mutate] of [
  ['restaurant ID', data => { data.restaurant_id = 'other_restaurant_0001'; }],
  ['range match', data => { data.range.from = '2026-02-28'; }], ['namespace match', data => { data.namespace = 'production'; }],
  ['metric version', data => { data.metric_version = 'v2'; }], ['range 超 366 天', data => { data.range = { from: '2024-01-01', to: '2025-01-01' }; }],
  ['桶日期越界', data => { data.traffic.days[0].date = '2026-03-05'; }], ['桶日期非法', data => { data.traffic.days[0].date = '2026-02-30'; }],
  ['未知时区', data => { data.traffic.days[0].timezone = 'Invalid/Fixture'; }], ['当前 fallback 非 UTC', data => { data.current_timezone = 'Asia/Tokyo'; }],
  ['桶 fallback 非 UTC', data => { data.traffic.days[2].timezone_fallback = true; }],
  ['traffic total 不等于桶和', data => { data.traffic.totals.page_views += 1; }],
  ['unsafe count', data => { data.traffic.days[0].page_views = Number.MAX_SAFE_INTEGER + 1; }], ['null count', data => { data.traffic.totals.page_views = null; }],
  ['day status 总和', data => { data.reservations.created.days[0].statuses.confirmed += 1; }],
  ['total status 总和', data => { data.reservations.created.totals.requests += 1; }],
  ['day party total', data => { data.reservations.scheduled.days[0].party_size += 1; }],
  ['total status 分项', data => { data.reservations.created.totals.statuses = { pending: 2, confirmed: 1, declined: 0, cancelled: 0 }; }],
  ['业务 scope', data => { data.reservations.scope = 'namespace_filtered'; }],
  ['状态语义', data => { data.reservations.status_semantics = 'historical_status'; }],
  ['UV fake zero', data => { data.visitors.unique_visitors = 0; }], ['UV available', data => { data.visitors.available = true; }],
  ['subscriptions fake zero', data => { data.subscriptions.active_count = 0; }],
  ['生成日期非法', data => { data.generated_at = '2026-02-30T10:00:00.000Z'; }],
]) test(`analytics 拒绝回包 ${label}`, async () => {
  const data = report(); mutate(data); onlyResponse(data);
  await assert.rejects(analytics.readAnalytics(RID, { from: '2026-03-01', to: '2026-03-04', namespace: 'local_test' }), apiError(502, 'ANALYTICS_RESPONSE_INVALID'));
  assert.equal(calls.length, 1);
});

test('analytics 真实 GET 在 MAX_SAFE_INTEGER 边界仍精确，保留同日 UTC fallback 多桶', async () => {
  const data = emptyReport();
  data.traffic.days = [
    { date: '2026-03-01', timezone: 'UTC', timezone_fallback: true, page_views: 1, reservation_clicks: 0, reservation_form_views: 0 },
    { date: '2026-03-01', timezone: 'UTC', timezone_fallback: false, page_views: Number.MAX_SAFE_INTEGER - 1, reservation_clicks: 0, reservation_form_views: 0 },
  ];
  data.traffic.totals.page_views = Number.MAX_SAFE_INTEGER;
  onlyResponse(data);
  const checked = await analytics.readAnalytics(RID);
  assert.equal(checked.traffic.totals.page_views, Number.MAX_SAFE_INTEGER);
  assert.equal(checked.traffic.days.length, 2);
  assert.deepEqual(checked.traffic.days.map(day => day.timezone_fallback), [false, true]);
});

test('analytics 多桶累加溢出通过真实读取拒绝，不返回估算 totals', async () => {
  const data = report(); data.traffic.days[0].page_views = Number.MAX_SAFE_INTEGER;
  data.traffic.totals.page_views = Number.MAX_SAFE_INTEGER; onlyResponse(data);
  await assert.rejects(analytics.readAnalytics(RID), apiError(502, 'ANALYTICS_COUNT_OVERFLOW'));
});

function ssr(component, props) { return renderToStaticMarkup(React.createElement(component, props)); }
function attr(node, key) { return (node.attrs ?? []).find(item => item.name === key)?.value; }
function nodes(node, predicate) {
  const result = [];
  function walk(item) { if (predicate(item)) result.push(item); for (const child of item.childNodes ?? []) walk(child); }
  walk(node); return result;
}
function text(node) { return node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(text).join(''); }
function documentOf(html) { return parseFragment(html); }
function assertEnglish(html) { assert.doesNotMatch(text(documentOf(html)), /[\u3400-\u9fff]/); }
function tableRows(table) {
  const tbody = nodes(table, node => node.tagName === 'tbody')[0];
  return nodes(tbody, node => node.tagName === 'tr').map(row => (row.childNodes ?? []).filter(node => ['th', 'td'].includes(node.tagName)).map(text));
}

test('纯列表 SSR 真实英文字段、当前状态、请求时区日期及 empty；无副作用', () => {
  for (const [status, label] of [['pending', 'Pending'], ['confirmed', 'Confirmed'], ['declined', 'Declined'], ['cancelled', 'Cancelled']]) {
    const html = ssr(reservationViews.ReservationsListView, { items: [record({ status })], selectedId: ID, onSelect() { assert.fail('SSR 不应选择'); } });
    assertEnglish(html); assert.match(html, new RegExp(label));
    assert.match(html, /Private Fixture Guest/); assert.match(html, /2 guests/); assert.match(html, /RABCDEFGH/);
    assert.match(html, /Mar 4, 2026/); assert.match(html, /6:30 PM/); assert.match(html, /aria-pressed="true"/);
    assert.doesNotMatch(html, /fixture@example\.test|Internal note|Arrived/);
  }
  const empty = ssr(reservationViews.ReservationsListView, { items: [], selectedId: null, onSelect() {} });
  assert.match(empty, /No reservations found/); assert.doesNotMatch(empty, /Private Fixture Guest/);
  assert.equal(calls.length, 0);
});

test('详情 SSR 联系方式/null、只读 notes、请求 snapshot、当前状态及倒序历史，不构造 arrivals', () => {
  const data = detail({ status: 'confirmed', revision: 2, note: '<script>fixture</script>', internal_note: 'Fixture private note', guest_email: null });
  data.events.unshift(event({ event_type: 'confirmed', from_status: 'pending', to_status: 'confirmed', reservation_revision: 2, actor_type: 'merchant' }));
  const html = ssr(reservationViews.ReservationDetailView, { detail: data });
  assertEnglish(html);
  for (const label of ['Email', 'Phone', 'Not provided', 'Guest note', 'Internal note', 'Read-only', 'Decision reason', 'Created', 'Updated', 'Revision', 'Request history', 'Confirmed']) assert.ok(html.includes(label), label);
  assert.match(html, /America\/New_York/); assert.match(html, /2026-03-04 at 18:30/);
  assert.match(html, /&lt;script&gt;fixture&lt;\/script&gt;/); assert.doesNotMatch(html, /<script|Arrived|Attended/);
  const history = nodes(documentOf(html), node => node.tagName === 'ol')[0];
  const entries = nodes(history, node => node.tagName === 'li').map(text);
  assert.match(entries[0], /Revision 2/); assert.match(entries[1], /Revision 1/); assert.equal(calls.length, 0);
});

for (const basis of ['created', 'scheduled']) test(`analytics SSR ${basis} 日期口径与当前状态，图补零但原表稀疏且 UV 非零值`, () => {
  const data = analytics.validateAnalyticsReport(report(), RID);
  const html = ssr(analyticsViews.AnalyticsReportView, { report: data, reservationBasis: basis, onReservationBasisChange() { assert.fail('SSR 无交互'); } });
  assertEnglish(html);
  for (const label of ['Page views', 'Requested guests', 'Current request status', 'Status at query time, not historical status', 'Not arrivals', 'Confirmed means accepted, not attended', 'UV is unavailable, not zero', 'Subscriptions', 'Historical timezone buckets', 'Test traffic only', 'Traffic environment does not filter reservations']) assert.ok(html.includes(label), label);
  assert.match(html, basis === 'created' ? /By request creation date/ : /By scheduled reservation date/);
  const doc = documentOf(html), tables = nodes(doc, node => node.tagName === 'table');
  assert.equal(tables.length, 2);
  assert.deepEqual(tableRows(tables[0]), [
    ['2026-03-01', 'Asia/Tokyo', 'No', '7', '1', '3'],
    ['2026-03-01', 'UTC', 'Yes', '5', '2', '1'],
    ['2026-03-04', 'UTC', 'No', '4', '1', '2'],
  ]);
  assert.deepEqual(tableRows(tables[1]), basis === 'created' ? [
    ['2026-03-01', 'Asia/Tokyo', '1', '2', '1', '0', '0', '0'],
    ['2026-03-01', 'UTC', '2', '5', '0', '2', '0', '0'],
  ] : [['2026-03-04', 'UTC', '2', '8', '0', '0', '1', '1']]);
  const polylines = nodes(doc, node => node.tagName === 'polyline');
  assert.equal(polylines.length, 5);
  const pagePoints = attr(polylines[0], 'points').split(' ').map(point => point.split(',').map(Number));
  assert.equal(pagePoints.length, 4); assert.equal(pagePoints[0][1], 18);
  assert.equal(pagePoints[1][1], 170); assert.equal(pagePoints[2][1], 170);
  assert.ok(Math.abs(pagePoints[3][1] - (170 - 4 / 12 * 152)) < 1e-9);
  const statusRows = nodes(doc, node => (attr(node, 'class') ?? '').split(' ').includes('an-status-row'));
  assert.deepEqual(statusRows.map(node => text(node).trim()), basis === 'created' ? ['Pending1', 'Confirmed2', 'Declined0', 'Cancelled0'] : ['Pending0', 'Confirmed0', 'Declined1', 'Cancelled1']);
  assert.equal(calls.length, 0);
});

test('analytics 空报表与初始 loading SSR 不伪造私有指标；停用页面不渲染', () => {
  const html = ssr(analyticsViews.AnalyticsReportView, { report: analytics.validateAnalyticsReport(emptyReport(), RID) });
  assert.match(html, /No activity in this report/); assert.match(html, /No traffic rows returned/); assert.match(html, /UV is unavailable, not zero/);
  const loading = ssr(analyticsViews.default, { restaurantId: RID, active: true, busy: false });
  assert.match(loading, /Loading analytics/); assert.doesNotMatch(loading, /an-metric-value|Daily source rows|Private Fixture/);
  assert.equal(ssr(analyticsViews.default, { restaurantId: RID, active: false, busy: false }), '');
  assert.equal(calls.length, 0);
});

for (const path of ['/app/reservations', '/app/analytics']) test(`受保护路径 ${path} SSR 未认证不显示 dashboard 或私有记录`, () => {
  stubWindow(path);
  assert.deepEqual(routes.readRoute(), { page: 'app', path, token: null });
  const html = ssr(load('App.tsx').default, { initialRoute: routes.readRoute() });
  assert.match(html, /Checking your account session/);
  assert.doesNotMatch(html, /table-folk-dashboard|rs-list|an-report-view|Private Fixture Guest|fixture@example\.test/);
  assert.equal(calls.length, 0);
  // 只为 App 初始化 boot 完成/无 session 夹具，全部 hooks 与子树仍由真实 SSR 执行。
  let stateIndex = 0;
  const SignedOutApp = componentWithReact('App.tsx', { ...React, useState(initial) {
    return React.useState(stateIndex++ === 3 ? false : initial);
  } });
  const signedOut = ssr(SignedOutApp, { initialRoute: routes.readRoute() });
  assert.match(signedOut, /Sign in/);
  assert.doesNotMatch(signedOut, /Checking your account session|table-folk-dashboard|rs-list|an-report-view|Private Fixture Guest/);
});

for (const [path, title, description] of [
  ['/app/reservations', 'Reservations', 'Choose a restaurant to review and manage its reservation requests.'],
  ['/app/analytics', 'Analytics', 'Choose a restaurant to view its website activity and reservation metrics.'],
]) test(`认证 dashboard SSR ${path} 接入真实 mode 与导航，初始加载不混入样本记录`, () => {
  stubWindow(path); let stateIndex = 0;
  const session = { user: { id: UID, email: 'merchant-fixture@example.test', display_name: null, locale: 'en', status: 'active', email_verified_at: NOW, created_at: NOW }, session_expires_at: '2026-03-05T10:00:00.000Z' };
  const AuthenticatedApp = componentWithReact('App.tsx', { ...React, useState(initial) {
    const index = stateIndex++;
    return React.useState(index === 1 ? session : index === 3 ? false : initial);
  } });
  const html = ssr(AuthenticatedApp, { initialRoute: routes.readRoute() });
  assertEnglish(html);
  assert.match(html, /table-folk-dashboard/); assert.match(html, /Loading your restaurants/);
  assert.ok(html.includes(description)); assert.doesNotMatch(html, /Private Fixture Guest|an-metric-value|rs-row/);
  const doc = documentOf(html);
  const activeLink = nodes(doc, node => node.tagName === 'a' && attr(node, 'href') === path && (attr(node, 'class') ?? '').includes('active'));
  assert.equal(activeLink.length, 1); assert.equal(text(activeLink[0]), title);
  assert.equal(calls.length, 0);
});

test('新增 operations CSS 严格解析，选择器保持页面作用域并包含移动布局、focus 和表格滚动', () => {
  for (const [file, scope, mobile] of [['reservations-page.css', '.rs-page', '520px'], ['analytics-page.css', '.an-page', '600px']]) {
    const tree = cssTree.parse(readFileSync(resolve(root, 'src', file), 'utf8'), { onParseError(error) { throw error; } });
    const selectors = [], media = [], declarations = [];
    cssTree.walk(tree, {
      enter(node) {
        if (node.type === 'Rule') node.prelude.children.forEach(selector => selectors.push(cssTree.generate(selector)));
        if (node.type === 'Atrule' && node.name === 'media') media.push(cssTree.generate(node.prelude));
        if (node.type === 'Declaration') declarations.push([node.property, cssTree.generate(node.value)]);
      },
    });
    assert.ok(selectors.length > 50);
    assert.ok(selectors.every(selector => selector.startsWith(scope)), `${file} 不得污染其它页面`);
    assert.ok(selectors.some(selector => selector.includes(':focus-visible')));
    assert.ok(media.some(query => query.includes(`max-width:${mobile}`)));
    assert.ok(declarations.some(([property, value]) => property === 'min-width' && value === '0'));
    if (file === 'analytics-page.css') assert.ok(declarations.some(([property, value]) => property === 'overflow-x' && value === 'auto'));
  }
});

// 单组件 hooks harness：局部注入 React，可显式包含同组件调用的真实 useAction 模块。
// 不模拟浏览器/React 并发调度；子组件可保持为实际元素，由独立 harness 或真实 SSR 验证。
function hooksHarness(filename, initialProps, options = {}) {
  const slots = [], updates = [];
  let index = 0, expectedHooks = null, renderNeeded = false, disposed = false;
  let props = initialProps, tree;
  function slot(kind, initialize) {
    const position = index++;
    if (!slots[position]) slots[position] = { kind, ...initialize() };
    assert.equal(slots[position].kind, kind, 'hooks 顺序不能变化');
    return slots[position];
  }
  const same = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const stub = { ...React,
    useState(initial) {
      const item = slot('state', () => {
        const value = typeof initial === 'function' ? initial() : initial;
        return { value };
      });
      item.set ??= next => {
        assert.ok(!disposed, '卸载后禁止 setState');
        const value = typeof next === 'function' ? next(item.value) : next;
        updates.push({ slot: slots.indexOf(item), value });
        if (!Object.is(value, item.value)) { item.value = value; renderNeeded = true; }
      };
      return [item.value, item.set];
    },
    useRef(initial) { return slot('ref', () => ({ value: { current: initial } })).value; },
    useId() { return slot('id', () => ({ value: `fixture-hook-${index}` })).value; },
    useEffect(callback, deps) {
      const item = slot('effect', () => ({ deps: undefined, cleanup: undefined, pending: false }));
      if (!same(item.deps, deps)) { item.deps = deps; item.callback = callback; item.pending = true; }
    },
    useCallback(callback, deps) {
      const item = slot('callback', () => ({ deps: undefined, value: callback }));
      if (!same(item.deps, deps)) { item.deps = deps; item.value = callback; }
      return item.value;
    },
  };
  const Component = componentWithReact(filename, stub, options);
  function render() {
    assert.ok(!disposed); index = 0; renderNeeded = false;
    tree = Component(props);
    if (expectedHooks === null) expectedHooks = index;
    assert.equal(index, expectedHooks, '每次渲染 hooks 数一致');
    return tree;
  }
  function runEffects() {
    for (const item of slots) if (item.kind === 'effect' && item.pending) {
      item.pending = false; item.cleanup?.(); item.cleanup = item.callback();
    }
  }
  function commit() {
    for (let guard = 0; guard < 20; guard += 1) {
      if (renderNeeded) render();
      runEffects();
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
  function collect(tree, predicate) {
    const result = [];
    function walk(node) {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== 'object' || !node.props) return;
      if (predicate(node)) result.push(node);
      walk(node.props.children);
    }
    walk(tree); return result;
  }
  function elements(predicate) { return collect(expanded(tree), predicate); }
  function rawElements(predicate) { return collect(tree, predicate); }
  function content(node) {
    if (Array.isArray(node)) return node.map(content).join('');
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node !== 'object') return String(node);
    return content(node.props?.children);
  }
  function button(label) {
    const matches = elements(node => node.type === 'button' && content(node) === label);
    assert.equal(matches.length, 1, `应存在唯一按钮 ${label}`); return matches[0];
  }
  const h = {
    get tree() { return tree; }, updates, slots, elements, rawElements, content, button,
    text() { return content(expanded(tree)); },
    click(label) { const node = button(label); assert.ok(!node.props.disabled, `${label} 应可点击`); node.props.onClick(); commit(); },
    change(suffix, value) {
      const matches = elements(node => ['input', 'textarea', 'select'].includes(node.type) && node.props.id?.endsWith(suffix));
      assert.equal(matches.length, 1); assert.ok(!matches[0].props.disabled);
      matches[0].props.onChange({ target: { value } }); commit();
    },
    submit() {
      const forms = elements(node => node.type === 'form'); assert.equal(forms.length, 1);
      forms[0].props.onSubmit({ preventDefault() {} }); commit();
    },
    setProps(next) { props = { ...props, ...next }; render(); commit(); },
    async settle() { await turn(); if (!disposed) commit(); },
    unmount() {
      if (disposed) return;
      for (const item of slots) if (item.kind === 'effect') { item.cleanup?.(); item.cleanup = undefined; }
      disposed = true; harnesses.delete(h);
    },
    commit,
  };
  render(); commit(); harnesses.add(h); return h;
}
function componentWithReact(filename, stub, { select = exports => exports.default, reactModules = [] } = {}) {
  const injected = new Set(reactModules.map(name => resolve(root, 'src', name)));
  const isolatedModules = new Map();
  function compile(path) {
    if (isolatedModules.has(path)) return isolatedModules.get(path).exports;
    const isolated = new Module(path, require.cache[require.resolve('react')]);
    isolated.filename = path; isolated.paths = Module._nodeModulePaths(dirname(path));
    isolatedModules.set(path, isolated);
    const localRequire = createRequire(path);
    isolated.require = name => {
      if (name === 'react') return stub;
      const dependency = localRequire.resolve(name);
      return injected.has(dependency) ? compile(dependency) : localRequire(name);
    };
    isolated._compile(compiledSource(path), path);
    return isolated.exports;
  }
  return select(compile(resolve(root, 'src', filename)));
}
function operationHarness() {
  const busy = [], dirty = [], saved = [];
  const h = hooksHarness('ReservationsPage.tsx', {
    restaurantId: RID, active: true, busy: false,
    onBusyChange(value) { busy.push(value); }, onDirtyChange(value) { dirty.push(value); }, onSettingsSaved(value) { saved.push(value); },
  });
  return Object.assign(h, { busy, dirty, saved });
}
function operationResponses(writeResponse, { list = { items: [record()], next_cursor: null }, currentSettings = settings() } = {}) {
  fakeFetch(call => {
    if (call.options.method === 'POST' || call.options.method === 'PATCH') return writeResponse(call);
    if (call.url === `${BASE}/settings`) return response(typeof currentSettings === 'function' ? currentSettings() : currentSettings);
    if (call.url === `${BASE}/${ID}`) return response(detail());
    if (call.url.startsWith(`${BASE}?`)) return response(typeof list === 'function' ? list(call) : list);
    throw new Error(`未预期接口 ${call.url}`);
  });
}
async function prepareAction(h, action = 'confirm', reason = '') {
  await h.settle();
  const rows = h.elements(node => node.type === 'button' && node.props.className?.startsWith('rs-row'));
  assert.equal(rows.length, 1); rows[0].props.onClick(); h.commit(); await h.settle();
  h.click(action === 'cancel' ? 'Cancel reservation' : action === 'decline' ? 'Decline' : 'Confirm');
  if (reason) h.change('-reason', reason);
  h.click('Review decision'); await h.settle();
  assert.ok(h.text().includes('Confirm this change'));
}
function attemptNode(h) {
  const matches = h.elements(node => node.type === 'section' && node.props.className === 'rs-attempt');
  assert.equal(matches.length, 1, '未验证 attempt 必须保留'); return matches[0];
}
function frozenRequest(h) {
  attemptNode(h);
  const body = h.elements(node => node.type === 'pre').map(node => h.content(node));
  const uuid = h.elements(node => node.type === 'dd' && node.props.className === 'rs-code').map(node => h.content(node));
  assert.equal(body.length, 1); assert.equal(uuid.length, 1);
  return { body: JSON.parse(body[0]), key: uuid[0] };
}

for (const status of [412, 429]) test(`hooks：首次 POST 网络未知→相同 key/body retry ${status} 仍保留 attempt`, async () => {
  let round = 0;
  operationResponses(() => ++round === 1 ? Promise.reject(new TypeError('夹具未知网络结果')) : rejection(status, 'REQUEST_FAILED'));
  const h = operationHarness(); await prepareAction(h, 'decline', '  Fixture reviewed reason  ');
  h.click('Yes, decline reservation'); await h.settle();
  assert.equal(writes().length, 1);
  const original = frozenRequest(h);
  assert.deepEqual(original.body, { expected_revision: 1, reason: 'Fixture reviewed reason', decision: 'decline' });
  checkTransport(writes()[0], 'POST', original.body, original.key);
  await h.settle(); assert.equal(writes().length, 1, '网络未知后不得自动重放');
  h.click('Retry exact request'); await h.settle();
  assert.equal(writes().length, 2); assert.deepEqual(frozenRequest(h), original);
  checkTransport(writes()[1], 'POST', original.body, original.key);
  assert.match(h.text(), /original result is still unknown/);
  const attempts = h.slots.filter(slot => slot.kind === 'ref' && slot.value.current?.kind === 'decision');
  assert.equal(attempts.length, 1);
  assert.ok(Object.isFrozen(attempts[0].value.current)); assert.ok(Object.isFrozen(attempts[0].value.current.body));
  const uncertain = h.slots.filter(slot => slot.kind === 'ref' && slot.value.current instanceof WeakSet);
  assert.equal(uncertain.length, 1); assert.ok(uncertain[0].value.current.has(attempts[0].value.current));
  assert.equal(h.dirty.at(-1), true);
});

test('hooks：确定的首次 412 拒绝不冒充未知结果，草稿保留且必须重新 review', async () => {
  operationResponses(() => rejection(412, 'REVISION_CONFLICT'));
  const h = operationHarness(); await prepareAction(h);
  h.click('Yes, confirm reservation'); await h.settle();
  assert.equal(h.elements(node => node.props.className === 'rs-attempt').length, 0);
  assert.ok(h.text().includes('Review decision'));
  assert.ok(h.text().includes('Confirm reservation'));
  assert.equal(writes().length, 1); assert.equal(h.dirty.at(-1), true);
});

for (const action of ['confirm', 'cancel']) test(`hooks：${action} 同步 doubleclick 仅发 1 POST，retry doubleclick 也只有 1`, async () => {
  const pending = deferred(); let round = 0;
  operationResponses(() => ++round === 1 ? pending.promise : Promise.reject(new TypeError('夹具未知')));
  const h = operationHarness(); await prepareAction(h, action);
  const handler = h.button(`Yes, ${action} reservation`).props.onClick;
  handler(); handler(); h.commit(); await h.settle();
  assert.equal(writes().length, 1); assert.deepEqual(h.busy, [true]);
  const original = frozenRequest(h);
  pending.reject(new TypeError('夹具未知')); await h.settle();
  const retry = h.button('Retry exact request').props.onClick;
  retry(); retry(); h.commit(); await h.settle();
  assert.equal(writes().length, 2); assert.deepEqual(frozenRequest(h), original);
  assert.deepEqual(h.busy, [true, false, true, false]);
});

for (const late of ['success', 'failure']) test(`hooks：active 暂停后 POST 晚 ${late} 不 setState、不 replay，恢复只读列表`, async () => {
  const pending = deferred(); operationResponses(() => pending.promise);
  const h = operationHarness(); await prepareAction(h);
  h.click('Yes, confirm reservation'); await h.settle();
  assert.equal(writes().length, 1); const original = frozenRequest(h), write = writes()[0];
  h.setProps({ active: false }); assert.ok(write.options.signal.aborted);
  const updates = h.updates.length, busy = [...h.busy], readsBefore = calls.filter(call => call.options.method === 'GET').length;
  if (late === 'success') pending.resolve(response(record({ status: 'confirmed', revision: 2 })));
  else pending.reject(new TypeError('夹具晚失败'));
  await h.settle();
  assert.equal(h.updates.length, updates, '旧回包不得更新任何 state'); assert.deepEqual(h.busy, busy);
  assert.deepEqual(frozenRequest(h), original); assert.equal(writes().length, 1);
  h.setProps({ active: true }); await h.settle();
  assert.equal(writes().length, 1); assert.deepEqual(frozenRequest(h), original);
  assert.equal(calls.filter(call => call.options.method === 'GET').length, readsBefore + 1);
});

test('hooks：active 暂停期间列表晚成功不 setState，恢复重新请求并保持真实 loading/empty', async () => {
  const pending = deferred(); let round = 0;
  fakeFetch(call => {
    assert.ok(call.url.startsWith(`${BASE}?`));
    return ++round === 1 ? pending.promise : response({ items: [], next_cursor: null });
  });
  const h = operationHarness();
  assert.match(h.text(), /Loading reservation requests/); await h.settle();
  h.setProps({ active: false }); const updates = h.updates.length;
  pending.resolve(response({ items: [record()], next_cursor: null })); await h.settle();
  assert.equal(h.updates.length, updates); assert.doesNotMatch(h.text(), /Private Fixture Guest/);
  h.setProps({ active: true }); await h.settle(); assert.match(h.text(), /No reservations found/);
  assert.equal(calls.length, 2); assert.equal(writes().length, 0);
});

test('hooks：旧请求 finally 不能释放暂停恢复后新 retry 的 busy 锁，卸载晚回包不 set', async () => {
  const first = deferred(), second = deferred(); let round = 0;
  operationResponses(() => ++round === 1 ? first.promise : second.promise);
  const h = operationHarness(); await prepareAction(h); h.click('Yes, confirm reservation'); await h.settle();
  h.setProps({ active: false }); h.setProps({ active: true }); await h.settle();
  h.click('Retry exact request'); await h.settle(); const updates = h.updates.length, busy = [...h.busy];
  first.resolve(response(record({ revision: 2, status: 'confirmed' }))); await h.settle();
  assert.equal(h.updates.length, updates); assert.deepEqual(h.busy, busy); assert.equal(h.busy.at(-1), true);
  const signal = writes()[1].options.signal; h.unmount(); assert.ok(signal.aborted);
  const afterUnmount = h.updates.length;
  second.resolve(response(record({ revision: 2, status: 'confirmed' }))); await turn();
  assert.equal(h.updates.length, afterUnmount); assert.equal(h.busy.at(-1), false); assert.equal(h.dirty.at(-1), false);
});

test('hooks：放弃 tracking 须显式二次确认，Keep tracking 和刷新均不会清除 UUID 或发新 POST', async () => {
  operationResponses(() => Promise.reject(new TypeError('夹具未知')));
  const h = operationHarness(); await prepareAction(h); h.click('Yes, confirm reservation'); await h.settle();
  const original = frozenRequest(h);
  assert.equal(h.elements(node => node.type === 'button' && h.content(node) === 'Abandon request tracking').length, 0);
  h.click('Refresh to verify'); await h.settle(); assert.deepEqual(frozenRequest(h), original);
  h.click('Abandon tracking…'); assert.match(h.text(), /Stop tracking this request/);
  h.click('Keep tracking'); assert.deepEqual(frozenRequest(h), original);
  assert.equal(h.elements(node => node.type === 'button' && h.content(node) === 'Abandon request tracking').length, 0);
  h.click('Abandon tracking…'); h.click('Abandon request tracking');
  assert.equal(h.elements(node => node.props.className === 'rs-attempt').length, 0);
  assert.match(h.text(), /This does not undo a server-side change/); assert.equal(h.dirty.at(-1), false);
  assert.equal(writes().length, 1);
});

test('hooks：空 decline reason 不能进入确认或发 POST，review 读取实际详情', async () => {
  operationResponses(() => assert.fail('不得 POST'));
  const h = operationHarness(); await h.settle();
  h.elements(node => node.type === 'button' && node.props.className?.startsWith('rs-row'))[0].props.onClick(); h.commit(); await h.settle();
  h.click('Decline'); h.change('-reason', ' \n '); h.click('Review decision'); await h.settle();
  assert.match(h.text(), /A reason is required/); assert.doesNotMatch(h.text(), /Confirm this change/); assert.equal(writes().length, 0);
  h.change('-reason', 'Fixture reason'); h.click('Review decision'); await h.settle();
  assert.match(h.text(), /Confirm this change/);
  assert.equal(calls.filter(call => call.url === `${BASE}/${ID}`).length, 2);
});

test('hooks：列表 applied filters 与下一页 cursor 由实际事件控制，不自动应用编辑草稿', async () => {
  const items = pageItems(), token = cursor(items.at(-1));
  operationResponses(() => assert.fail('不得 POST'), { list: call => {
    const query = new URL(call.url, window.location.origin).searchParams;
    return query.has('cursor') ? { items: [], next_cursor: null } : { items, next_cursor: token };
  } });
  const h = operationHarness(); await h.settle(); const count = calls.length;
  h.change('-status', 'pending'); h.change('-from', '2026-03-01'); h.change('-to', '2026-03-04');
  assert.equal(calls.length, count); assert.match(h.text(), /Changes are not applied yet/);
  h.submit(); await h.settle();
  h.click('Next'); await h.settle(); assert.match(h.text(), /Page 2/); assert.match(h.text(), /No reservations found/);
  assert.deepEqual(Object.fromEntries(new URL(calls.at(-1).url, window.location.origin).searchParams), {
    limit: '20', status: 'pending', from: '2026-03-01', to: '2026-03-04', cursor: token,
  });
  h.click('Previous'); await h.settle(); assert.match(h.text(), /Page 1/);
  assert.equal(new URL(calls.at(-1).url, window.location.origin).searchParams.has('cursor'), false);
});

test('hooks：settings 共享 revision 改变保留草稿，明确选新 revision+review 后 PATCH；未知后不自动 retry', async () => {
  let revision = 7;
  operationResponses(() => Promise.reject(new TypeError('夹具 PATCH 未知')), { currentSettings: () => settings({ restaurant_revision: revision }) });
  const h = operationHarness(); await h.settle(); h.click('Refresh settings'); await h.settle();
  h.click('Edit request settings'); h.change('-notice', '  Fixture updated notice  ');
  revision = 8; h.click('Review settings save'); await h.settle();
  assert.match(h.text(), /shared restaurant revision changed/); assert.equal(writes('PATCH').length, 0);
  const notice = h.elements(node => node.type === 'textarea' && node.props.id?.endsWith('-notice'))[0];
  assert.equal(notice.props.value, '  Fixture updated notice  ');
  h.click('Use refreshed revision, keep draft'); h.click('Review settings save'); await h.settle();
  h.click('Yes, save request settings'); await h.settle();
  assert.equal(writes('PATCH').length, 1);
  const original = frozenRequest(h);
  assert.deepEqual(original.body, { enabled: false, notice: 'Fixture updated notice', expected_revision: 8 });
  checkTransport(writes('PATCH')[0], 'PATCH', original.body, original.key);
  assert.match(h.text(), /not server-side idempotent replay/);
  await h.settle(); assert.equal(writes('PATCH').length, 1);
  operationResponses(() => rejection(412, 'REVISION_CONFLICT'), { currentSettings: settings({ restaurant_revision: 9 }) });
  h.click('Refresh to verify'); await h.settle(); assert.deepEqual(frozenRequest(h), original);
  h.click('Retry exact request'); await h.settle(); assert.deepEqual(frozenRequest(h), original);
  assert.equal(writes('PATCH').length, 2); assert.equal(h.saved.length, 0);
});

const SECOND_RID = 'restaurant_fixture_000002';
function restaurant(overrides = {}) {
  return {
    id: RID, slug: 'fixture-dining', name: 'Fixture Dining', status: 'draft', role: 'owner',
    primary_locale: 'en', reservation_enabled: false, revision: 7, created_at: NOW, updated_at: NOW,
    description: null, cuisine_label: null, country_code: null, region: null, city: null,
    address_line1: null, address_line2: null, postal_code: null, contact_email: null, phone: null,
    timezone: null, currency_code: null, readiness: { ready_for_publication: false, missing_fields: ['timezone'] },
    ...overrides,
  };
}
function restaurantList() {
  return { items: [restaurant(), restaurant({ id: SECOND_RID, slug: 'second-dining', name: 'Second Dining', revision: 12 })], next_cursor: null, has_more: false };
}
function dashboardHarness(props = {}) {
  const dirtyChanges = [], busyChanges = [];
  const h = hooksHarness('Dashboard.tsx', {
    user: { id: UID, email: 'merchant-fixture@example.test', display_name: null, locale: 'en', status: 'active', email_verified_at: NOW, created_at: NOW },
    locales: ['en'], mode: 'restaurants', routePath: '/app/restaurants', active: true, busy: false,
    onBusyChange(value) { busyChanges.push(value); }, onDirtyChange(value) { dirtyChanges.push(value); }, ...props,
  }, { reactModules: ['ui.tsx'], expandChildren: false });
  return Object.assign(h, { dirtyChanges, busyChanges });
}
function childComponent(h, name) {
  const matches = h.rawElements(node => typeof node.type === 'function' && node.type.name === name);
  assert.equal(matches.length, 1, `应存在唯一真实子组件 ${name}`); return matches[0];
}
function openRestaurant(h, id = RID) {
  const cards = h.rawElements(node => node.type === 'article' && node.props['aria-labelledby'] === `restaurant-name-${id}`);
  assert.equal(cards.length, 1);
  const buttons = h.rawElements(node => node.type === 'button' && node.props.className === 'restaurant-open');
  const button = buttons.find(node => node.props['aria-label'].endsWith(id === RID ? 'Fixture Dining' : 'Second Dining'));
  assert.ok(button && !button.props.disabled); button.props.onClick(); h.commit();
}
function cachedRestaurants(h) {
  const matches = h.slots.filter(slot => slot.kind === 'state' && Array.isArray(slot.value?.items));
  assert.equal(matches.length, 1); return matches[0].value;
}
function cardText(h, id) {
  const matches = h.rawElements(node => node.type === 'article' && node.props['aria-labelledby'] === `restaurant-name-${id}`);
  assert.equal(matches.length, 1); return h.content(matches[0]);
}

test('Dashboard：选择餐厅后删掉重复大标题与旧工具说明，返回列表仍保留列表标题', async () => {
  onlyResponse(restaurantList()); const h = dashboardHarness(); await h.settle();
  assert.match(h.text(), /My restaurants/);
  openRestaurant(h);
  assert.equal(h.rawElements(node => node.type === 'header' && node.props.className === 'dashboard-page-heading').length, 0);
  assert.equal(h.rawElements(node => node.props.className === 'dashboard-legacy-caption').length, 0);
  const rootNode = h.rawElements(node => node.type === 'section' && node.props.className?.includes('dashboard-selected-workspace'))[0];
  assert.equal(rootNode.props['aria-labelledby'], undefined);
  assert.equal(rootNode.props['aria-label'], 'Restaurant workspace');
  assert.doesNotMatch(h.text(), /Restaurant management|Connected workspace|Existing restaurant tools|Manage this restaurant using/);
  assert.equal(childComponent(h, 'RestaurantWorkspace').props.id, RID);
  h.click('← Back to restaurants');
  assert.match(h.text(), /My restaurants/);
  assert.equal(h.rawElements(node => node.type === 'header' && node.props.className === 'dashboard-page-heading').length, 1);
});
test('Dashboard portal：顶栏返回与正文独立餐厅标题分开，脏稿确认不另 push route', async () => {
  const reactDom = require('react-dom'), originalPortal = reactDom.createPortal;
  const portals = [], target = { nodeType: 1 }, historyCalls = [];
  reactDom.createPortal = (children, container) => { portals.push({ children, container }); return null; };
  window.history.pushState = (...args) => historyCalls.push(['push', ...args]);
  window.history.replaceState = (...args) => historyCalls.push(['replace', ...args]);
  let h;
  try {
    const data = restaurantList(); data.items[0].name = 'Chome'; onlyResponse(data);
    h = dashboardHarness({ headerTarget: target }); await h.settle();
    assert.equal(portals.length, 0);
    const open = h.rawElements(node => node.type === 'button' && node.props['aria-label'] === 'Open workspace for Chome');
    assert.equal(open.length, 1); open[0].props.onClick(); h.commit();
    assert.ok(portals.length > 0); assert.ok(portals.every(portal => portal.container === target));
    const portal = portals.at(-1), doc = documentOf(renderToStaticMarkup(portal.children));
    assert.equal(text(doc), '← Back to restaurants'); assert.doesNotMatch(text(doc), /Chome|Fixture Dining|My restaurants/);
    assert.equal(nodes(doc, node => node.tagName === 'h1').length, 0);
    assert.equal(nodes(doc, node => node.tagName === 'button').length, 1);
    assert.equal(h.rawElements(node => node.type === 'button' && h.content(node) === '← Back to restaurants').length, 0);
    assert.equal(h.rawElements(node => node.type === 'header' && node.props.className === 'dashboard-page-heading').length, 0);
    const headings = h.rawElements(node => node.type === 'h1'); assert.equal(headings.length, 1);
    assert.equal(headings[0].props.className, 'workspace-title'); assert.equal(headings[0].props.tabIndex, -1);
    assert.equal(headings[0].props['aria-hidden'], undefined); assert.equal(headings[0].props.hidden, undefined);
    const main = documentOf(renderToStaticMarkup(React.createElement('main', { id: 'main' }, headings[0])));
    assert.equal(nodes(main, node => node.tagName === 'main').length, 1); assert.equal(text(main), 'Chome');
    const workspace = childComponent(h, 'RestaurantWorkspace'); assert.equal(workspace.props.headerInTopbar, true);
    workspace.props.onDirtyChange(true); h.commit();
    portals.at(-1).children.props.children.props.onClick(); h.commit();
    assert.match(h.text(), /Discard unsaved changes/); assert.equal(childComponent(h, 'RestaurantWorkspace').key, workspace.key);
    assert.equal(h.dirtyChanges.at(-1), true); assert.deepEqual(historyCalls, []);
    h.click('Keep editing'); assert.equal(childComponent(h, 'RestaurantWorkspace').key, workspace.key);
    assert.equal(h.dirtyChanges.at(-1), true);
    portals.at(-1).children.props.children.props.onClick(); h.commit(); h.click('Discard and return to restaurants');
    assert.equal(h.rawElements(node => node.type.name === 'RestaurantWorkspace').length, 0);
    assert.equal(h.rawElements(node => node.type === 'header' && node.props.className === 'dashboard-page-heading').length, 1);
    assert.equal(h.dirtyChanges.at(-1), false); assert.deepEqual(historyCalls, []);
    assert.equal(calls.length, 1); assert.equal(writes().length, 0);
  } finally { try { h?.unmount(); } finally { reactDom.createPortal = originalPortal; } }
  assert.equal(reactDom.createPortal, originalPortal);
});

test('Dashboard portal：busy 禁返回，activefalse 不建立可见 portal，恢复复用同一顶栏容器', async () => {
  const reactDom = require('react-dom'), originalPortal = reactDom.createPortal, portals = [], target = { nodeType: 1 };
  let h;
  reactDom.createPortal = (children, container) => { portals.push({ children, container }); return null; };
  try {
    onlyResponse(restaurantList()); h = dashboardHarness({ headerTarget: target }); await h.settle(); openRestaurant(h);
    h.setProps({ busy: true }); const button = portals.at(-1).children.props.children;
    assert.equal(button.props.disabled, true); button.props.onClick(); h.commit();
    assert.equal(childComponent(h, 'RestaurantWorkspace').props.id, RID); assert.doesNotMatch(h.text(), /Discard unsaved changes/);
    const before = portals.length; h.setProps({ active: false }); assert.equal(portals.length, before);
    assert.equal(childComponent(h, 'RestaurantWorkspace').props.active, false);
    h.setProps({ active: true, busy: false }); await h.settle();
    assert.ok(portals.length > before); assert.equal(portals.at(-1).container, target);
    assert.equal(portals.at(-1).children.props.children.props.disabled, false);
    portals.at(-1).children.props.children.props.onClick(); h.commit();
    assert.equal(h.rawElements(node => node.type.name === 'RestaurantWorkspace').length, 0);
    assert.equal(calls.length, 2); assert.deepEqual(h.busyChanges, []);
  } finally { try { h?.unmount(); } finally { reactDom.createPortal = originalPortal; } }
  assert.equal(reactDom.createPortal, originalPortal);
});

test('餐厅独立标题使用紧凑可见字号，不再被CSS隐藏或挤进顶栏', () => {
  const tree = cssTree.parse(readFileSync(resolve(root, 'src/dashboard.css'), 'utf8'), { onParseError(error) { throw error; } });
  const rules = [];
  cssTree.walk(tree, { enter(node) {
    if (node.type === 'Rule' && cssTree.generate(node.prelude).includes('>.workspace-title')) rules.push(node);
  } });
  assert.equal(rules.length, 1);
  const declarations = Object.fromEntries(rules[0].block.children.toArray().filter(node => node.type === 'Declaration').map(node => [node.property, cssTree.generate(node.value)]));
  assert.equal(declarations['font-size'], 'clamp(26px,2.5vw,32px)');
  assert.equal(declarations['font-weight'], '500');
  assert.notEqual(declarations.position, 'absolute'); assert.notEqual(declarations.display, 'none');
  assert.notEqual(declarations.visibility, 'hidden'); assert.equal(declarations['clip-path'], undefined);
  const globalRules = cssTree.parse(readFileSync(resolve(root, 'src/styles.css'), 'utf8'));
  let hiddenTitle = false;
  cssTree.walk(globalRules, { visit: 'Rule', enter(node) {
    if (cssTree.generate(node.prelude).includes('workspace-visually-hidden')) hiddenTitle = true;
  } });
  assert.equal(hiddenTitle, false);
});

test('RestaurantWorkspace headerInTopbar true：真实子组件无可见餐厅名/h1，刷新及 Website 操作仍可用', async () => {
  const data = restaurant({ name: 'Chome' });
  fakeFetch(call => {
    if (call.url === `/api/v1/restaurants/${RID}`) return response(data, 200, { ETag: `"restaurant-${RID}-v7"` });
    if (call.url === `/api/v1/restaurants/${RID}/opening-hours`) return response({ restaurant_id: RID, restaurant_revision: 7, timezone: null, intervals: [] }, 200, { ETag: `"restaurant-${RID}-v7"` });
    throw new Error(`未预期接口 ${call.url}`);
  });
  const h = hooksHarness('RestaurantWorkspace.tsx', { id: RID, headerInTopbar: true, active: true, locales: ['en'], busy: false,
    onBusyChange() {}, onDirtyChange() {}, onUpdated() {},
  }, { reactModules: ['ui.tsx'], expandChildren: false });
  await h.settle(); await h.settle();
  assert.equal(h.rawElements(node => node.type === 'header' && node.props.className === 'workspace-header').length, 0);
  assert.equal(h.rawElements(node => node.type === 'h1').length, 0); assert.doesNotMatch(h.text(), /Chome/);
  assert.equal(h.button('刷新资料').props.disabled, false); h.click('刷新资料');
  assert.match(h.text(), /确认用服务端资料替换本页内容/);
  h.click('Website'); assert.equal(childComponent(h, 'WebsitePanel').props.restaurant.id, RID);
});

for (const balanceResult of ['success', 'failure', 'development_test', 'negative_balance']) test(`TokenBalance GET 晚${balanceResult}不抢占或释放其他页面真实写锁，busy 仅禁余额导航`, async () => {
  const read = deferred(), write = deferred(), navigations = [];
  operationResponses(() => write.promise);
  const operationResponder = responder;
  fakeFetch(call => call.url === '/api/v1/ai/usage' ? read.promise : operationResponder(call));
  const token = hooksHarness('TokenBalance.tsx', { userId: UID, active: true, refreshKey: '/app', busy: false,
    navigate(path) { navigations.push(path); },
  });
  const h = operationHarness(); await prepareAction(h);
  assert.deepEqual(h.busy, [], '余额读取不得锁住另一页面的业务写入');
  h.click('Yes, confirm reservation'); await h.settle(); assert.equal(writes().length, 1); assert.deepEqual(h.busy, [true]);
  token.setProps({ busy: true });
  const link = token.elements(node => node.type === 'a' && node.props.href === '/account/usage'); assert.equal(link.length, 1);
  assert.equal(link[0].props['aria-disabled'], true); let prevented = 0;
  link[0].props.onClick({ button: 0, preventDefault() { prevented += 1; } }); assert.equal(prevented, 1); assert.deepEqual(navigations, []);
  const emptyTotals = { calls: 0, known_usage_calls: 0, unknown_usage_calls: 0, pending_calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  if (balanceResult === 'success') read.resolve(response({ mode: 'observation', policy_version: 'observation-v1', generated_at: '2026-03-01T10:00:00.000000Z',
    billing_account: null, quota: { configured: false, enforced: false, available_tokens: null, granted_tokens: null, reserved_tokens: null, consumed_tokens: null },
    filters: { restaurant_id: null, feature: null, origin: null, from: null, to: null }, account_totals: emptyTotals, filtered_totals: emptyTotals,
    by_feature: [], legacy: { aggregate_jobs: 0, known_total_tokens: 0, unknown_usage_jobs: 0 },
  })); else if (balanceResult === 'failure') read.reject(new TypeError('PRIVATE_BALANCE_ERROR'));
  else {
    const consumed = balanceResult === 'negative_balance' ? 1000001 : 0;
    const period = { id: `aqp_${'p'.repeat(24)}`, starts_at: '2026-11-01T00:00:00.000000Z', ends_at: '2026-12-01T00:00:00.000000Z',
      granted_at: '2026-11-19T00:00:00.000001Z', timezone: 'UTC', origin: 'development_test', tokens_per_credit: 100, auto_renew: false };
    const total = { ...emptyTotals, calls: consumed ? 1 : 0, known_usage_calls: consumed ? 1 : 0, prompt_tokens: consumed, total_tokens: consumed };
    read.resolve(response({ mode: 'observation', policy_version: 'observation-v1', generated_at: '2026-11-19T10:00:00.000000Z',
      billing_account: { id: `bla_${'a'.repeat(24)}`, status: 'active' },
      quota: { configured: true, enforced: false, granted_tokens: 1000000, available_tokens: 1000000 - consumed, reserved_tokens: 0, consumed_tokens: consumed, period },
      calendar_month_totals: { period_id: period.id, totals: total },
      filters: { restaurant_id: null, feature: null, origin: null, from: null, to: null }, account_totals: total, filtered_totals: total,
      by_feature: consumed ? [{ feature: 'menu_recognition', ...total }] : [], legacy: { aggregate_jobs: 0, known_total_tokens: 0, unknown_usage_jobs: 0 },
    }));
  }
  await token.settle(); await h.settle();
  const expected = { success: 'Not configured', failure: 'Unavailable', development_test: '10,000', negative_balance: '-0.01' };
  assert.equal(token.text(), `Credits left · ${expected[balanceResult]}`);
  assert.deepEqual(h.busy, [true]); assert.equal(writes().length, 1); assert.equal(h.button('Retry exact request').props.disabled, true);
  const reads = calls.filter(call => call.url === '/api/v1/ai/usage'); assert.equal(reads.length, 1); checkTransport(reads[0], 'GET');
  write.resolve(response(record({ revision: 2, status: 'confirmed' }))); await h.settle(); assert.deepEqual(h.busy, [true, false]);
  token.setProps({ busy: false });
  token.elements(node => node.type === 'a' && node.props.href === '/account/usage')[0].props.onClick({ button: 0, preventDefault() {} });
  assert.deepEqual(navigations, ['/account/usage']); assert.equal(writes().length, 1);
});

test('RestaurantWorkspace：顶部只留餐厅名与刷新，Website前不重复铺资料说明或readiness', async () => {
  const data = restaurant({ name: 'Chome' });
  fakeFetch(call => {
    if (call.url === `/api/v1/restaurants/${RID}`) return response(data, 200, { ETag: `"restaurant-${RID}-v7"` });
    if (call.url === `/api/v1/restaurants/${RID}/opening-hours`) return response({ restaurant_id: RID, restaurant_revision: 7, timezone: null, intervals: [] }, 200, { ETag: `"restaurant-${RID}-v7"` });
    throw new Error(`未预期接口 ${call.url}`);
  });
  const h = hooksHarness('RestaurantWorkspace.tsx', { id: RID, active: true, locales: ['en'], busy: false,
    onBusyChange() {}, onDirtyChange() {}, onUpdated() {},
  }, { reactModules: ['ui.tsx'], expandChildren: false });
  await h.settle(); await h.settle();
  const headers = h.rawElements(node => node.type === 'header' && node.props.className === 'workspace-header');
  assert.equal(headers.length, 1);
  assert.equal(h.rawElements(node => node.type === 'h1')[0].props.children, 'Chome');
  assert.equal(h.rawElements(node => node.props.className === 'readiness').length, 0);
  assert.doesNotMatch(h.content(headers[0]), /当前餐厅|版本 7|预订关闭|预约开关|草稿/);
  h.click('Website');
  assert.equal(h.rawElements(node => node.type === 'section' && node.props.className?.includes('workspace-website')).length, 1);
  assert.equal(childComponent(h, 'WebsitePanel').props.restaurant.id, RID);
  h.click('刷新资料');
  assert.match(h.text(), /确认用服务端资料替换本页内容/);
});
test('Dashboard：创建元素的实际 key 随同模式 alias 改变，create dirty 同时清除', async () => {
  onlyResponse(restaurantList()); const h = dashboardHarness(); await h.settle();
  h.click('Create restaurant');
  const before = childComponent(h, 'CreateRestaurant');
  assert.equal(before.key, '/app/restaurants');
  before.props.onDirtyChange(true); h.commit(); assert.equal(h.dirtyChanges.at(-1), true);
  h.setProps({ busy: true }); assert.equal(childComponent(h, 'CreateRestaurant').key, before.key);
  h.setProps({ busy: false, routePath: '/app' });
  assert.equal(childComponent(h, 'CreateRestaurant').key, '/app');
  assert.notEqual(childComponent(h, 'CreateRestaurant').key, before.key);
  assert.equal(h.dirtyChanges.at(-1), false);
  const panel = h.rawElements(node => node.type === 'div' && node.props.className === 'dashboard-content');
  assert.equal(panel.length, 1); assert.equal(panel[0].props.hidden, false, '同模式 alias 仍显示创建面板，但身份已改变');
  assert.equal(calls.length, 1);
});

test('Dashboard：workspace alias key 改变，清除两类 dirty 和待确认选择但保留 selected', async () => {
  onlyResponse(restaurantList()); const h = dashboardHarness(); await h.settle(); openRestaurant(h);
  const before = childComponent(h, 'RestaurantWorkspace');
  assert.equal(before.key, `workspace-/app/restaurants-${RID}`);
  before.props.onDirtyChange(true); childComponent(h, 'CreateRestaurant').props.onDirtyChange(true); h.commit();
  h.click('← Back to restaurants'); assert.match(h.text(), /Discard unsaved changes/);
  assert.equal(childComponent(h, 'RestaurantWorkspace').props.id, RID);
  h.setProps({ routePath: '/app' });
  const after = childComponent(h, 'RestaurantWorkspace');
  assert.equal(after.key, `workspace-/app-${RID}`); assert.notEqual(after.key, before.key);
  assert.equal(after.props.id, RID); assert.equal(h.dirtyChanges.at(-1), false);
  assert.doesNotMatch(h.text(), /Discard unsaved changes/);
  h.click('← Back to restaurants');
  assert.equal(h.rawElements(node => node.type.name === 'RestaurantWorkspace').length, 0);
  assert.doesNotMatch(h.text(), /Discard unsaved changes/); assert.equal(calls.length, 1);
});

test('Dashboard：选择餐厅后跨 mode 保留 selected，撤销 dirty 确认而不重复读列表', async () => {
  onlyResponse(restaurantList()); const h = dashboardHarness(); await h.settle(); openRestaurant(h, SECOND_RID);
  childComponent(h, 'RestaurantWorkspace').props.onDirtyChange(true); h.commit();
  h.click('← Back to restaurants'); assert.match(h.text(), /Discard unsaved changes/);
  h.setProps({ mode: 'reservations', routePath: '/app/reservations' });
  assert.equal(childComponent(h, 'ReservationsPage').props.restaurantId, SECOND_RID);
  assert.equal(childComponent(h, 'ReservationsPage').key, `reservations-${SECOND_RID}`);
  assert.equal(h.dirtyChanges.at(-1), false); assert.doesNotMatch(h.text(), /Discard unsaved changes/);
  childComponent(h, 'ReservationsPage').props.onDirtyChange(true); h.commit();
  h.setProps({ mode: 'analytics', routePath: '/app/analytics' });
  assert.equal(childComponent(h, 'AnalyticsPage').props.restaurantId, SECOND_RID);
  assert.equal(h.dirtyChanges.at(-1), false);
  h.setProps({ mode: 'restaurants', routePath: '/app' });
  assert.equal(childComponent(h, 'RestaurantWorkspace').props.id, SECOND_RID);
  assert.equal(calls.length, 1); assert.deepEqual(h.busyChanges, []);
});

test('Dashboard：dirty 切店须先确认，Keep editing 保留原选择，discard 后才切换', async () => {
  onlyResponse(restaurantList()); const h = dashboardHarness({ mode: 'reservations', routePath: '/app/reservations' });
  await h.settle(); openRestaurant(h);
  childComponent(h, 'ReservationsPage').props.onDirtyChange(true); h.commit();
  h.change('operations-restaurant', SECOND_RID);
  assert.match(h.text(), /Discard unsaved changes/);
  assert.equal(childComponent(h, 'ReservationsPage').props.restaurantId, RID);
  assert.equal(h.elements(node => node.type === 'select')[0].props.value, RID);
  h.click('Keep editing'); assert.equal(h.dirtyChanges.at(-1), true);
  assert.doesNotMatch(h.text(), /Discard unsaved changes/);
  assert.equal(childComponent(h, 'ReservationsPage').props.restaurantId, RID);
  h.change('operations-restaurant', SECOND_RID); h.click('Discard and continue');
  assert.equal(childComponent(h, 'ReservationsPage').props.restaurantId, SECOND_RID);
  assert.equal(childComponent(h, 'ReservationsPage').key, `reservations-${SECOND_RID}`);
  assert.equal(h.dirtyChanges.at(-1), false); assert.doesNotMatch(h.text(), /Discard unsaved changes/);
  assert.equal(calls.length, 1); assert.equal(writes().length, 0);
});

for (const late of ['success', 'failure']) test(`Dashboard：session pause 后初始列表晚 ${late} 不更新 state，恢复重新读取`, async () => {
  const pending = deferred(), data = restaurantList(); let round = 0;
  fakeFetch(call => {
    assert.equal(call.url, '/api/v1/restaurants?limit=20');
    return ++round === 1 ? pending.promise : response(data);
  });
  const h = dashboardHarness(); assert.match(h.text(), /Loading your restaurants/);
  h.setProps({ active: false }); assert.ok(calls[0].options.signal.aborted);
  const count = h.updates.length;
  if (late === 'success') pending.resolve(response(data)); else pending.reject(new TypeError('夹具晚读失败'));
  await h.settle(); assert.equal(h.updates.length, count);
  assert.doesNotMatch(h.text(), /Fixture Dining|Second Dining/);
  h.setProps({ active: true }); await h.settle();
  assert.deepEqual(cachedRestaurants(h), data); assert.equal(calls.length, 2);
  assert.deepEqual(h.busyChanges, []);
});

for (const late of ['success', 'failure']) test(`Dashboard：真实 useAction 刷新在 session pause 后晚 ${late} 不污染卡片 cache 或写锁`, async () => {
  const pending = deferred(), data = restaurantList(), stale = restaurantList(); let round = 0;
  stale.items[0].name = 'Stale restaurant';
  fakeFetch(call => {
    assert.equal(call.url, '/api/v1/restaurants?limit=20');
    return ++round === 2 ? pending.promise : response(data);
  });
  const h = dashboardHarness(); await h.settle(); h.click('Refresh');
  assert.match(h.text(), /Loading…/); assert.deepEqual(h.busyChanges, []);
  h.setProps({ active: false }); assert.ok(calls[1].options.signal.aborted);
  const cache = cachedRestaurants(h);
  if (late === 'success') pending.resolve(response(stale)); else pending.reject(new TypeError('夹具晚刷新失败'));
  await h.settle(); assert.equal(cachedRestaurants(h), cache);
  assert.doesNotMatch(h.text(), /Stale restaurant|Error code:/);
  // useAction 的 pending finally 可以收尾；禁止的是失效读取修改业务 cache/外页写锁。
  assert.equal(h.button('Refresh').props.disabled, false); assert.deepEqual(h.busyChanges, []);
  assert.equal(childComponent(h, 'ActionFeedback').props.action.pending, false);
  assert.equal(childComponent(h, 'ActionFeedback').props.action.error, null);
  h.setProps({ active: true }); await h.settle();
  assert.deepEqual(cachedRestaurants(h), data); assert.equal(calls.length, 3); assert.equal(writes().length, 0);
});

test('Dashboard：真实 settings PATCH 成功经 onSettingsSaved 更新所选卡片 cache，未选餐厅不变', async () => {
  onlyResponse(restaurantList()); const h = dashboardHarness({ mode: 'reservations', routePath: '/app/reservations' });
  await h.settle(); openRestaurant(h);
  const page = childComponent(h, 'ReservationsPage'), untouched = cachedRestaurants(h).items[1];
  const currentSettings = settings({ timezone: 'UTC', privacy_notice_version: 'fixture-v1', intervals: [
    { weekday: 1, opens_at_local: '10:00', closes_at_local: '12:00', closes_day_offset: 0, accepts_requests: true },
  ] });
  const saved = { ...currentSettings, restaurant_revision: 8, enabled: true };
  operationResponses(() => response(saved), { currentSettings });
  const child = hooksHarness('ReservationsPage.tsx', page.props); await child.settle();
  child.click('Refresh settings'); await child.settle(); child.click('Edit request settings');
  const checkbox = child.elements(node => node.type === 'input' && node.props.type === 'checkbox');
  assert.equal(checkbox.length, 1); assert.equal(checkbox[0].props.checked, false);
  checkbox[0].props.onChange({ target: { checked: true } }); child.commit(); h.commit();
  assert.equal(h.dirtyChanges.at(-1), true);
  child.click('Review settings save'); await child.settle();
  child.click('Yes, save request settings'); await child.settle(); h.commit();
  assert.equal(writes('PATCH').length, 1); assert.deepEqual(h.busyChanges, [true, false]);
  const write = writes('PATCH')[0];
  assert.equal(write.url, `${BASE}/settings`);
  checkTransport(write, 'PATCH', { enabled: true, notice: null, expected_revision: 7 }, write.options.headers.get('Idempotency-Key'));
  assert.match(child.text(), /Reservation settings saved/);
  assert.equal(cachedRestaurants(h).items[0].revision, 8);
  assert.equal(cachedRestaurants(h).items[0].reservation_enabled, true);
  assert.equal(cachedRestaurants(h).items[1], untouched);
  assert.match(cardText(h, RID), /Requests enabled/); assert.match(cardText(h, SECOND_RID), /Requests disabled/);
  assert.equal(h.dirtyChanges.at(-1), false);
  child.unmount(); h.commit();
  h.click('← Back to restaurants'); assert.match(cardText(h, RID), /Requests enabled/);
});

test('Dashboard：SettingsSaved 只更新匹配餐厅，旧 revision 不回退，等版本和新版本均可刷新卡片', async () => {
  onlyResponse(restaurantList()); const h = dashboardHarness({ mode: 'reservations', routePath: '/app/reservations' });
  await h.settle(); openRestaurant(h);
  const callback = childComponent(h, 'ReservationsPage').props.onSettingsSaved;
  const untouched = cachedRestaurants(h).items[1];
  callback(settings({ restaurant_revision: 8, enabled: true })); h.commit();
  callback(settings({ restaurant_revision: 7, enabled: false })); h.commit();
  assert.equal(cachedRestaurants(h).items[0].revision, 8); assert.match(cardText(h, RID), /Requests enabled/);
  callback(settings({ restaurant_revision: 8, enabled: false })); h.commit();
  assert.match(cardText(h, RID), /Requests disabled/);
  callback(settings({ restaurant_revision: 9, enabled: true })); h.commit();
  assert.equal(cachedRestaurants(h).items[0].revision, 9); assert.match(cardText(h, RID), /Requests enabled/);
  assert.equal(cachedRestaurants(h).items[1], untouched); assert.equal(calls.length, 1);
});

function analyticsReaderHarness(props = {}) {
  const initial = { restaurantId: RID, busy: false, ...props };
  return hooksHarness('AnalyticsPage.tsx', initial, {
    // 根组件无 hooks；取它实际返回的子类型，不增加生产 export，也不改写源码。
    select: exports => exports.default({ ...initial, active: true }).type,
    expandChildren: false,
  });
}
function analyticsReportElement(h) {
  const matches = h.rawElements(node => node.type.name === 'AnalyticsReportView');
  assert.ok(matches.length <= 1); return matches[0];
}
function analyticsReportHtml(h) {
  const element = analyticsReportElement(h);
  return element ? ssr(analyticsViews.AnalyticsReportView, element.props) : '';
}
function editAnalytics(h, patch) {
  const fields = h.elements(node => node.type === 'input' && node.props.type === 'date');
  assert.equal(fields.length, 2);
  for (const [name, value] of Object.entries(patch)) {
    const node = name === 'namespace'
      ? h.elements(node => node.type === 'select')[0] : fields[name === 'from' ? 0 : 1];
    node.props.onChange({ target: { value } }); h.commit();
  }
}
function analyticsFixture(range, { namespace = 'local_test', restaurantId = RID } = {}) {
  return { ...emptyReport(), range: { ...range }, namespace, restaurant_id: restaurantId };
}
const NEXT_RANGE = { from: '2026-04-01', to: '2026-04-03' };
const OLD_RANGE = { from: '2026-03-05', to: '2026-03-07' };
function overlappingAnalytics(h) {
  editAnalytics(h, OLD_RANGE);
  const forms = h.elements(node => node.type === 'form'); assert.equal(forms.length, 1);
  const defaults = h.button('Default last 30 days'); assert.equal(defaults.props.disabled, false);
  // 同一提交前驱动已取得的实际事件闭包；不是绕过 loading 后再点击禁用按钮。
  forms[0].props.onSubmit({ preventDefault() {} }); defaults.props.onClick(); h.commit();
}

test('AnalyticsPage：实际 reader key 绑定 restaurantId，active=false 返回 null 而非保留读取子树', () => {
  const h = hooksHarness('AnalyticsPage.tsx', { restaurantId: RID, active: true, busy: false }, { expandChildren: false });
  assert.ok(React.isValidElement(h.tree)); assert.equal(h.tree.type.name, 'AnalyticsReader'); assert.equal(h.tree.key, RID);
  h.setProps({ restaurantId: SECOND_RID }); assert.equal(h.tree.key, SECOND_RID); assert.equal(h.tree.props.restaurantId, SECOND_RID);
  h.setProps({ active: false }); assert.equal(h.tree, null);
  h.setProps({ active: true }); assert.equal(h.tree.key, SECOND_RID);
  assert.equal(calls.length, 0, '仅验证根元素身份；读取由下方真实 reader hooks 驱动');
});

test('AnalyticsReader：初始 loading→report ready 的实际 UI 和服务端默认草稿，不提前展示指标', async () => {
  const pending = deferred(); fakeFetch(call => { assert.equal(call.url, ANALYTICS); return pending.promise; });
  const h = analyticsReaderHarness();
  assert.match(h.text(), /Loading analytics/); assert.equal(analyticsReportHtml(h), '');
  for (const label of ['Apply filters', 'Default last 30 days', 'Refresh report']) assert.equal(h.button(label).props.disabled, true);
  assert.deepEqual(h.elements(node => node.type === 'input').map(node => node.props.value), ['', '']);
  pending.resolve(response(report())); await h.settle();
  assert.match(h.text(), /Report ready/); assert.doesNotMatch(h.text(), /Loading analytics/);
  for (const label of ['Apply filters', 'Default last 30 days', 'Refresh report']) assert.equal(h.button(label).props.disabled, false);
  assert.deepEqual(h.elements(node => node.type === 'input').map(node => node.props.value), ['2026-03-01', '2026-03-04']);
  assert.equal(h.elements(node => node.type === 'select')[0].props.value, 'local_test');
  assert.match(analyticsReportHtml(h), /Mar 1, 2026.*Mar 4, 2026/);
  assert.match(analyticsReportHtml(h), /an-metric-value/); assert.equal(calls.length, 1); checkTransport(calls[0], 'GET');
});

for (const late of ['success', 'failure']) test(`AnalyticsReader：旧日期请求晚 ${late} 不覆盖新报告、草稿或 ready 状态`, async () => {
  const old = deferred(), current = deferred(); let round = 0;
  fakeFetch(() => ++round === 1 ? response(report()) : round === 2 ? old.promise : current.promise);
  const h = analyticsReaderHarness(); await h.settle(); overlappingAnalytics(h);
  assert.equal(calls.length, 3); assert.ok(calls[1].options.signal.aborted);
  assert.deepEqual(Object.fromEntries(new URL(calls[1].url, window.location.origin).searchParams), { ...OLD_RANGE, namespace: 'local_test' });
  assert.equal(calls[2].url, ANALYTICS);
  current.resolve(response(analyticsFixture(NEXT_RANGE, { namespace: 'production' }))); await h.settle();
  const before = analyticsReportElement(h).props.report, updates = h.updates.length;
  if (late === 'success') old.resolve(response(analyticsFixture(OLD_RANGE))); else old.reject(new TypeError('夹具过期读取失败'));
  await h.settle();
  assert.equal(h.updates.length, updates); assert.equal(analyticsReportElement(h).props.report, before);
  assert.deepEqual(before.range, NEXT_RANGE); assert.equal(before.namespace, 'production');
  assert.deepEqual(h.elements(node => node.type === 'input').map(node => node.props.value), Object.values(NEXT_RANGE));
  assert.match(h.text(), /Report ready/); assert.doesNotMatch(h.text(), /Analytics could not be loaded/);
  assert.match(analyticsReportHtml(h), /Apr 1, 2026.*Apr 3, 2026/); assert.doesNotMatch(analyticsReportHtml(h), /Mar 5, 2026|Local test traffic/);
});

test('AnalyticsReader：旧请求先结束时 finally 不提前结束新请求 loading，旧报告保留自身标签', async () => {
  const old = deferred(), current = deferred(); let round = 0;
  fakeFetch(() => ++round === 1 ? response(report()) : round === 2 ? old.promise : current.promise);
  const h = analyticsReaderHarness(); await h.settle(); overlappingAnalytics(h);
  const updates = h.updates.length;
  old.resolve(response(analyticsFixture(OLD_RANGE))); await h.settle();
  assert.equal(h.updates.length, updates); assert.match(h.text(), /Updating… The previous report/);
  assert.equal(h.button('Apply filters').props.disabled, true);
  assert.match(analyticsReportHtml(h), /Mar 1, 2026.*Mar 4, 2026/);
  assert.equal(h.elements(node => node.type === 'div' && node.props.className === 'an-updating')[0].props['aria-busy'], true);
  current.resolve(response(analyticsFixture(NEXT_RANGE))); await h.settle();
  assert.match(h.text(), /Report ready/); assert.equal(h.button('Apply filters').props.disabled, false);
  assert.match(analyticsReportHtml(h), /Apr 1, 2026.*Apr 3, 2026/);
});

for (const failure of ['503', 'invalid']) test(`AnalyticsReader：新范围 ${failure} 撤下旧报告与标签，显式 retry 沿用失败范围`, async () => {
  const failed = deferred(), retry = deferred(); let round = 0;
  fakeFetch(() => ++round === 1 ? response(report()) : round === 2 ? failed.promise : retry.promise);
  const h = analyticsReaderHarness(); await h.settle(); editAnalytics(h, { ...NEXT_RANGE, namespace: 'production' }); h.submit();
  assert.match(h.text(), /Updating/); assert.match(analyticsReportHtml(h), /Mar 1, 2026.*Mar 4, 2026/);
  failed.resolve(failure === '503' ? rejection(503, 'SERVICE_UNAVAILABLE') : response(analyticsFixture(NEXT_RANGE)));
  await h.settle();
  assert.equal(analyticsReportHtml(h), ''); assert.equal(analyticsReportElement(h), undefined);
  assert.doesNotMatch(h.text(), /Updating|Report ready/); assert.match(h.text(), /Analytics could not be loaded/);
  assert.match(h.text(), failure === '503' ? /temporarily unavailable/ : /response failed validation/);
  assert.equal(h.button('Refresh report').props.disabled, true); assert.equal(h.button('Retry report').props.disabled, false);
  assert.deepEqual(h.elements(node => node.type === 'input').map(node => node.props.value), Object.values(NEXT_RANGE));
  h.click('Retry report'); assert.match(h.text(), /Loading analytics/); assert.equal(analyticsReportHtml(h), '');
  assert.equal(calls[2].url, calls[1].url);
  retry.resolve(response(analyticsFixture(NEXT_RANGE, { namespace: 'production' }))); await h.settle();
  assert.match(h.text(), /Report ready/); assert.doesNotMatch(h.text(), /Analytics could not be loaded/);
  assert.match(analyticsReportHtml(h), /Apr 1, 2026.*Apr 3, 2026/); assert.doesNotMatch(analyticsReportHtml(h), /<h2>Mar 1, 2026|Local test traffic/);
});

test('AnalyticsReader：编辑日期和环境后 refresh 读取当前报告范围，草稿不被自动应用或覆盖', async () => {
  const pending = deferred(); let round = 0;
  fakeFetch(() => ++round === 1 ? response(report()) : pending.promise);
  const h = analyticsReaderHarness(); await h.settle(); editAnalytics(h, { ...NEXT_RANGE, namespace: 'production' });
  assert.equal(calls.length, 1); assert.match(h.text(), /Unapplied filter changes/);
  h.click('Refresh report');
  assert.deepEqual(Object.fromEntries(new URL(calls[1].url, window.location.origin).searchParams), { ...report().range, namespace: 'local_test' });
  assert.match(h.text(), /Updating/); assert.match(analyticsReportHtml(h), /Mar 1, 2026.*Mar 4, 2026/);
  pending.resolve(response(report())); await h.settle();
  assert.deepEqual(h.elements(node => node.type === 'input').map(node => node.props.value), Object.values(NEXT_RANGE));
  assert.equal(h.elements(node => node.type === 'select')[0].props.value, 'production');
  assert.match(h.text(), /Unapplied filter changes/); assert.match(h.text(), /Report ready/);
  assert.deepEqual(analyticsReportElement(h).props.report.range, report().range);
});

test('AnalyticsReader：默认读取尚未完成时编辑日期，回包只更新报告而不覆盖较新的输入草稿', async () => {
  const pending = deferred(); fakeFetch(() => pending.promise);
  const h = analyticsReaderHarness(); editAnalytics(h, { ...NEXT_RANGE, namespace: 'production' });
  assert.equal(calls.length, 1); assert.equal(h.button('Apply filters').props.disabled, true);
  pending.resolve(response(report())); await h.settle();
  assert.deepEqual(h.elements(node => node.type === 'input').map(node => node.props.value), Object.values(NEXT_RANGE));
  assert.equal(h.elements(node => node.type === 'select')[0].props.value, 'production');
  assert.deepEqual(analyticsReportElement(h).props.report.range, report().range);
  assert.match(h.text(), /Unapplied filter changes/); assert.match(h.text(), /Report ready/);
});

for (const late of ['success', 'failure']) test(`AnalyticsReader：根元素切 restaurant 后清空读取，旧 reader 卸载晚 ${late} 不更新`, async () => {
  const old = deferred(), current = deferred(); let round = 0;
  fakeFetch(() => ++round === 1 ? response(report()) : round === 2 ? old.promise : current.promise);
  const page = hooksHarness('AnalyticsPage.tsx', { restaurantId: RID, active: true, busy: false }, { expandChildren: false });
  const firstKey = page.tree.key, first = analyticsReaderHarness(page.tree.props); await first.settle();
  first.click('Refresh report');
  page.setProps({ restaurantId: SECOND_RID }); assert.notEqual(page.tree.key, firstKey);
  // 按真实 key 边界显式卸载/挂载；不声称 harness 实现了 React reconciliation。
  first.unmount(); assert.ok(calls[1].options.signal.aborted);
  const second = analyticsReaderHarness(page.tree.props), updates = first.updates.length;
  assert.equal(analyticsReportHtml(second), ''); assert.match(second.text(), /Loading analytics/);
  assert.deepEqual(second.elements(node => node.type === 'input').map(node => node.props.value), ['', '']);
  assert.equal(calls[2].url, `/api/v1/restaurants/${SECOND_RID}/analytics`);
  if (late === 'success') old.resolve(response(report())); else old.reject(new TypeError('夹具切店晚失败'));
  await second.settle(); assert.equal(first.updates.length, updates); assert.equal(analyticsReportHtml(second), '');
  current.resolve(response(analyticsFixture(NEXT_RANGE, { restaurantId: SECOND_RID, namespace: 'production' }))); await second.settle();
  assert.equal(analyticsReportElement(second).props.report.restaurant_id, SECOND_RID);
  assert.match(analyticsReportHtml(second), /Apr 1, 2026.*Apr 3, 2026/); assert.doesNotMatch(analyticsReportHtml(second), new RegExp(RID));
});

test('AnalyticsReader：active pause 卸载读状态，恢复不复用旧报告或草稿，重新请求服务端默认', async () => {
  const old = deferred(), current = deferred(); let round = 0;
  fakeFetch(() => ++round === 1 ? response(report()) : round === 2 ? old.promise : current.promise);
  const page = hooksHarness('AnalyticsPage.tsx', { restaurantId: RID, active: true, busy: false }, { expandChildren: false });
  const first = analyticsReaderHarness(page.tree.props); await first.settle(); editAnalytics(first, NEXT_RANGE); first.click('Refresh report');
  page.setProps({ active: false }); assert.equal(page.tree, null); first.unmount();
  const updates = first.updates.length; old.resolve(response(report())); await turn();
  assert.equal(first.updates.length, updates); assert.ok(calls[1].options.signal.aborted);
  page.setProps({ active: true }); const second = analyticsReaderHarness(page.tree.props);
  assert.equal(calls[2].url, ANALYTICS); assert.equal(analyticsReportHtml(second), '');
  assert.deepEqual(second.elements(node => node.type === 'input').map(node => node.props.value), ['', '']);
  current.resolve(response(analyticsFixture(OLD_RANGE))); await second.settle();
  assert.deepEqual(analyticsReportElement(second).props.report.range, OLD_RANGE);
  assert.deepEqual(second.elements(node => node.type === 'input').map(node => node.props.value), Object.values(OLD_RANGE));
});

test('AnalyticsReader：日期口径切换只更新当前报告视图，busy 通过真实 fieldset 和按钮阻止读取', async () => {
  onlyResponse(report()); const h = analyticsReaderHarness(); await h.settle();
  analyticsReportElement(h).props.onReservationBasisChange('scheduled'); h.commit();
  assert.equal(analyticsReportElement(h).props.reservationBasis, 'scheduled');
  assert.match(analyticsReportHtml(h), /By scheduled reservation date/); assert.equal(calls.length, 1);
  h.setProps({ busy: true }); assert.equal(h.elements(node => node.type === 'fieldset')[0].props.disabled, true);
  assert.equal(h.button('Refresh report').props.disabled, true); assert.equal(h.button('Default last 30 days').props.disabled, true);
  h.submit(); assert.equal(calls.length, 1, '真实 apply 闭包也必须拒绝 busy 提交');
  h.setProps({ busy: false }); assert.equal(h.button('Refresh report').props.disabled, false);
});

test('扩展 hooks harness 对 ui 和 reader 的局部注入不污染正常模块与 SSR', () => {
  assert.equal(require('react'), React); assert.equal(load('AnalyticsPage.tsx'), analyticsViews);
  const normalUi = load('ui.tsx'), normalDashboard = load('Dashboard.tsx');
  const h = dashboardHarness({ active: false });
  assert.equal(load('ui.tsx'), normalUi); assert.equal(load('Dashboard.tsx'), normalDashboard);
  const html = ssr(normalDashboard.default, {
    user: { id: UID }, locales: ['en'], active: false, busy: false, onBusyChange() {}, onDirtyChange() {},
  });
  assert.match(html, /Loading your restaurants/); assert.doesNotMatch(html, /fixture-hook/);
  assert.equal(analyticsViews.default({ restaurantId: RID, active: false, busy: false }), null);
  h.unmount(); assert.equal(calls.length, 0);
});

test('hooks stub 不污染正常 React SSR/模块缓存', () => {
  assert.equal(load('ReservationsPage.tsx'), reservationViews);
  assert.equal(require('react'), React);
  const html = ssr(reservationViews.default, { restaurantId: RID, active: true, busy: false, onBusyChange() {}, onDirtyChange() {} });
  assert.match(html, /Waiting for requests/); assert.doesNotMatch(html, /Private Fixture Guest|fixture-hook/);
  assert.equal(calls.length, 0);
});
