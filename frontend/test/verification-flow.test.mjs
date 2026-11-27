import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 沿用现有 Module 内存转译；真实 API、AuthView、useAction 和 React SSR 均不访问浏览器。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'package.json'));
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const extensions = Object.fromEntries(['.ts', '.tsx', '.css'].map(name => [name, Module._extensions[name]]));
const globals = Object.fromEntries(['window', 'fetch', 'FormData', 'HTMLElement', 'HTMLInputElement']
  .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const initialCache = new Set(Object.keys(require.cache));
const TOKEN = 'verification-fixture-'.repeat(3);
const CSRF = 'anonymous-csrf-fixture-'.repeat(3);
const SESSION_CSRF = 'session-csrf-fixture-'.repeat(3);
const REFRESHED_CSRF = 'refreshed-csrf-fixture-'.repeat(3);
const VERIFY = '/api/v1/auth/verify-email';
const CSRF_PATH = '/api/v1/auth/csrf';
const FALLBACK = 'Email verified. Sign in to continue.';
const policy = {
  terms_version: 'draft-v1', terms_url: '/legal/terms', privacy_notice_version: 'draft-v1',
  privacy_url: '/legal/privacy', supported_locales: ['en', 'zh-CN'], password_min_length: 15, password_max_length: 128,
};
let transport, calls, timers, nextTimer, responder, csrfResponder, unexpected, unsubscribes;

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
function response(data, status = 200, headers = {}) {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', ...headers },
  });
}
function loginResponse() {
  return {
    csrf_token: SESSION_CSRF,
    user: {
      id: 'usr_verification_fixture_000001', email: 'verification@example.test', display_name: null,
      locale: 'en', status: 'active', email_verified_at: new Date(Date.now() - 60000).toISOString(),
      created_at: new Date(Date.now() - 120000).toISOString(),
    },
    session_expires_at: new Date(Date.now() + 3600000).toISOString(),
  };
}
function sessionOf(data) { return { user: data.user, session_expires_at: data.session_expires_at }; }
function apiError(status, code) {
  return error => {
    assert.ok(error instanceof transport.ApiError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  };
}
function writes() { return calls.filter(call => call.options.method === 'POST'); }
function sequence() { return calls.map(call => [call.url, call.options.method]); }
function checkWrite(call, path, body, csrf = CSRF) {
  assert.equal(call.url, path);
  assert.equal(call.options.method, 'POST');
  assert.deepEqual(JSON.parse(call.options.body), body);
  assert.equal(call.options.headers.get('X-CSRF-Token'), csrf);
  assert.equal(call.options.headers.get('Content-Type'), 'application/json');
  assert.equal(call.options.headers.get('Accept'), 'application/json');
  assert.equal(call.options.credentials, 'same-origin');
  assert.equal(call.options.cache, 'no-store');
  assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.referrerPolicy, 'same-origin');
  assert.ok(call.options.signal instanceof AbortSignal);
}
async function flushMicrotasks() { await new Promise(done => queueMicrotask(done)); }
function subscribe(listener) { unsubscribes.push(transport.onSessionExpired(listener)); }

before(() => {
  const compile = (module, filename) => module._compile(compiledSource(filename), filename);
  Module._extensions['.ts'] = compile;
  Module._extensions['.tsx'] = compile;
  Module._extensions['.css'] = () => {};
  transport = require(resolve(root, 'src/api.ts'));
});
beforeEach(() => {
  calls = []; timers = new Map(); nextTimer = 0; unexpected = []; unsubscribes = [];
  responder = call => { unexpected.push(call.url); throw new Error('未配置接口回包'); };
  csrfResponder = () => response({ csrf_token: CSRF });
  transport.clearCsrf();
  globalThis.window = {
    location: { origin: 'https://localhost:5173', pathname: '/auth/verify', hash: '', search: '' },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  globalThis.fetch = async (url, options) => {
    const call = { url: String(url), options };
    calls.push(call);
    return call.url === CSRF_PATH ? csrfResponder(call) : responder(call);
  };
  globalThis.HTMLElement = class HTMLElement {};
  globalThis.HTMLInputElement = class HTMLInputElement extends globalThis.HTMLElement {
    constructor(value = '') { super(); this.value = value; }
  };
  globalThis.FormData = class FormData {
    constructor(form) { this.values = new Map(Object.entries(form.values)); }
    get(name) { return this.values.get(name) ?? null; }
  };
});
afterEach(() => {
  for (const unsubscribe of unsubscribes) unsubscribe();
  transport.clearCsrf();
  for (const [name, descriptor] of Object.entries(globals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  assert.equal(timers.size, 0, '所有请求必须清理计时器');
  assert.deepEqual(unexpected, [], '不得发起未配置接口请求');
});
after(() => {
  for (const [name, handler] of Object.entries(extensions)) {
    if (handler) Module._extensions[name] = handler;
    else delete Module._extensions[name];
  }
  for (const filename of Object.keys(require.cache)) if (!initialCache.has(filename)) delete require.cache[filename];
});

for (const input of [{ token: TOKEN }, { token: TOKEN, continue_session: false }]) {
  test(`API：旧验证调用 ${Object.hasOwn(input, 'continue_session') ? 'false' : '无标志'} 无 CSRF，204 返回 null`, async () => {
    // 即使已有 CSRF，也不能给旧调用添加请求头或刷新请求。
    await transport.refreshCsrf(); calls.length = 0;
    let expired = 0; subscribe(() => { expired += 1; });
    responder = () => response(null, 204);
    assert.equal(await transport.api.verify(input), null);
    assert.deepEqual(sequence(), [[VERIFY, 'POST']]);
    checkWrite(writes()[0], VERIFY, input, null);
    assert.equal(transport.getCsrfToken(), CSRF);
    assert.equal(expired, 0);
  });
}
test('API：continue_session=true 先 GET CSRF，再仅一次 POST；200 返回会话并更新 CSRF', async () => {
  const data = loginResponse();
  responder = () => response(data);
  const input = { token: TOKEN, continue_session: true };
  const session = await transport.api.verify(input);
  assert.deepEqual(sequence(), [[CSRF_PATH, 'GET'], [VERIFY, 'POST']]);
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.headers.get('X-CSRF-Token'), null);
  checkWrite(writes()[0], VERIFY, input);
  assert.deepEqual(session, sessionOf(data));
  assert.equal(Object.hasOwn(session, 'csrf_token'), false);
  assert.equal(transport.getCsrfToken(), SESSION_CSRF);
  await flushMicrotasks(); assert.equal(writes().length, 1);
});
test('API：continue_session=true 的 204 仅返回 null，不制造会话或会话 CSRF', async () => {
  responder = () => response(null, 204);
  assert.equal(await transport.api.verify({ token: TOKEN, continue_session: true }), null);
  assert.deepEqual(sequence(), [[CSRF_PATH, 'GET'], [VERIFY, 'POST']]);
  assert.equal(transport.getCsrfToken(), CSRF);
  await flushMicrotasks(); assert.equal(writes().length, 1);
});

const malformed = [
  ['null 响应', () => null],
  ['非对象响应', () => 'accepted'],
  ['未知响应结构', () => ({ message: 'accepted' })],
  ['缺少用户', data => { delete data.user; }],
  ['用户非 active', data => { data.user.status = 'pending'; }],
  ['缺少用户状态', data => { delete data.user.status; }],
  ['用户 ID 非字符串', data => { data.user.id = 123; }],
  ['用户 ID 过短', data => { data.user.id = 'u'.repeat(15); }],
  ['用户 ID 过长', data => { data.user.id = 'u'.repeat(65); }],
  ['用户 ID 非法字符', data => { data.user.id = 'invalid/user/identifier'; }],
  ['缺少邮箱', data => { delete data.user.email; }],
  ['邮箱非字符串', data => { data.user.email = null; }],
  ['缺少验证时间', data => { delete data.user.email_verified_at; }],
  ['验证时间非字符串', data => { data.user.email_verified_at = Date.now(); }],
  ['验证时间无效', data => { data.user.email_verified_at = 'not-a-date'; }],
  ['缺少到期时间', data => { delete data.session_expires_at; }],
  ['到期时间非字符串', data => { data.session_expires_at = Date.now() + 3600000; }],
  ['到期时间无效', data => { data.session_expires_at = 'not-a-date'; }],
  ['会话已经到期', data => { data.session_expires_at = new Date(Date.now() - 60000).toISOString(); }],
  ['缺少 CSRF', data => { delete data.csrf_token; }],
  ['CSRF 非字符串', data => { data.csrf_token = 123; }],
  ['CSRF 过短', data => { data.csrf_token = 'c'.repeat(31); }],
  ['CSRF 过长', data => { data.csrf_token = 'c'.repeat(257); }],
];
function invalidResponse(change) { const data = loginResponse(); const result = change(data); return result === undefined ? data : result; }
for (const method of ['verify', 'login']) {
  for (const [label, change] of malformed) {
    test(`API：${method} 拒绝 malformed 200（${label}），清除 CSRF 且不重放`, async () => {
      responder = () => response(invalidResponse(change));
      const body = method === 'verify' ? { token: TOKEN, continue_session: true } : { email: 'verification@example.test', password: 'fixture-password' };
      await assert.rejects(transport.api[method](body), apiError(502, 'RESPONSE_INVALID'));
      assert.throws(() => transport.getCsrfToken(), apiError(403, 'CSRF_REQUIRED'));
      await flushMicrotasks();
      assert.deepEqual(sequence(), [[CSRF_PATH, 'GET'], [method === 'verify' ? VERIFY : '/api/v1/auth/login', 'POST']]);
    });
  }
}
for (const [csrfLength, idLength] of [[32, 16], [256, 64]]) {
  test(`API：接受有效 CSRF/用户 ID 边界 ${csrfLength}/${idLength}`, async () => {
    const data = loginResponse(); data.csrf_token = 'c'.repeat(csrfLength); data.user.id = 'u'.repeat(idLength);
    responder = () => response(data);
    assert.deepEqual(await transport.api.verify({ token: TOKEN, continue_session: true }), sessionOf(data));
    assert.equal(transport.getCsrfToken(), data.csrf_token);
  });
}
test('API：非 JSON 的 200 拒绝为 RESPONSE_INVALID，不重放 POST', async () => {
  responder = () => new Response('invalid-json', { status: 200 });
  await assert.rejects(transport.api.verify({ token: TOKEN, continue_session: true }), apiError(502, 'RESPONSE_INVALID'));
  assert.deepEqual(sequence(), [[CSRF_PATH, 'GET'], [VERIFY, 'POST']]);
});
for (const [label, status, code] of [['服务错误', 503, 'SERVICE_UNAVAILABLE'], ['令牌错误', 410, 'ACTION_TOKEN_EXPIRED'], ['网络错误', 0, 'NETWORK_ERROR'], ['超时', 0, 'REQUEST_TIMEOUT']]) {
  test(`API：${label} 只发送一次验证 POST`, async () => {
    responder = call => {
      if (code === 'NETWORK_ERROR') throw new TypeError('测试网络失败');
      if (code === 'REQUEST_TIMEOUT') return new Promise((resolve, reject) => {
        call.options.signal.addEventListener('abort', () => reject(new DOMException('测试超时', 'AbortError')), { once: true });
        const timer = [...timers.values()].at(-1);
        assert.equal(timer.ms, 20000); timer.fn();
      });
      return response({ code }, status);
    };
    await assert.rejects(transport.api.verify({ token: TOKEN, continue_session: true }), apiError(status, code));
    await flushMicrotasks();
    assert.deepEqual(sequence(), [[CSRF_PATH, 'GET'], [VERIFY, 'POST']]);
    assert.equal(writes().length, 1);
  });
}
for (const refreshFails of [false, true]) {
  test(`API：401 Session 清除 CSRF、通知过期、刷新${refreshFails ? '失败' : '成功'}，绝不自动重放`, async () => {
    const events = []; let gets = 0;
    csrfResponder = () => {
      gets += 1; events.push(`csrf:${gets}`);
      if (gets === 2) {
        assert.equal(events.at(-2), 'expired');
        assert.throws(() => transport.getCsrfToken(), apiError(403, 'CSRF_REQUIRED'));
        if (refreshFails) throw new TypeError('测试刷新失败');
      }
      return response({ csrf_token: gets === 1 ? CSRF : REFRESHED_CSRF });
    };
    subscribe(() => {
      assert.throws(() => transport.getCsrfToken(), apiError(403, 'CSRF_REQUIRED'));
      events.push('expired');
    });
    responder = () => { events.push('post'); return response({ code: 'UNAUTHENTICATED' }, 401, { 'WWW-Authenticate': 'Session realm="merchant"' }); };
    await assert.rejects(transport.api.verify({ token: TOKEN, continue_session: true }), apiError(401, 'UNAUTHENTICATED'));
    await flushMicrotasks();
    assert.deepEqual(events, ['csrf:1', 'post', 'expired', 'csrf:2']);
    assert.deepEqual(sequence(), [[CSRF_PATH, 'GET'], [VERIFY, 'POST'], [CSRF_PATH, 'GET']]);
    checkWrite(writes()[0], VERIFY, { token: TOKEN, continue_session: true });
    if (refreshFails) assert.throws(() => transport.getCsrfToken(), apiError(403, 'CSRF_REQUIRED'));
    else assert.equal(transport.getCsrfToken(), REFRESHED_CSRF);
  });
}
for (const [label, input, challenge, expectedCalls] of [
  ['旧调用的 Session 401', { token: TOKEN }, 'Session', [[VERIFY, 'POST']]],
  ['非 Session 的 401', { token: TOKEN, continue_session: true }, 'Bearer', [[CSRF_PATH, 'GET'], [VERIFY, 'POST']]],
]) {
  test(`API：${label} 不误通知会话过期或额外刷新`, async () => {
    let expired = 0; subscribe(() => { expired += 1; });
    responder = () => response({ code: 'UNAUTHENTICATED' }, 401, { 'WWW-Authenticate': challenge });
    await assert.rejects(transport.api.verify(input), apiError(401, 'UNAUTHENTICATED'));
    assert.equal(expired, 0); assert.deepEqual(sequence(), expectedCalls);
  });
}
test('API：403 CSRF 错误刷新 CSRF，但不重放验证 POST', async () => {
  let gets = 0;
  csrfResponder = () => response({ csrf_token: ++gets === 1 ? CSRF : REFRESHED_CSRF });
  responder = () => response({ code: 'CSRF_INVALID' }, 403);
  await assert.rejects(transport.api.verify({ token: TOKEN, continue_session: true }), apiError(403, 'CSRF_INVALID'));
  assert.deepEqual(sequence(), [[CSRF_PATH, 'GET'], [VERIFY, 'POST'], [CSRF_PATH, 'GET']]);
  assert.equal(transport.getCsrfToken(), REFRESHED_CSRF);
});

function collect(tree, predicate) {
  const matches = [];
  function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!React.isValidElement(node)) return;
    if (predicate(node)) matches.push(node);
    walk(node.props.children);
  }
  walk(tree); return matches;
}
function content(node) {
  if (Array.isArray(node)) return node.map(content).join('');
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  return content(node.props?.children);
}
function formActor(values = {}) {
  const password = new globalThis.HTMLInputElement(values.password ?? '');
  return {
    values: { ...values }, password, resets: 0,
    elements: { namedItem: name => name === 'password' ? password : null },
    reset() { this.resets += 1; this.values = {}; password.value = ''; },
  };
}
function authHarness(page = 'verify', apiOverrides = {}, propOverrides = {}) {
  const slots = [], effects = [], runs = [], busyChanges = [], events = [];
  let cursor = 0, tree, hookCount;
  function slot(kind, initial) {
    const index = cursor++;
    slots[index] ??= { kind, value: initial() };
    assert.equal(slots[index].kind, kind, 'hooks 顺序必须稳定');
    return slots[index];
  }
  const hooks = { ...React,
    useState(initial) {
      const item = slot('state', () => typeof initial === 'function' ? initial() : initial);
      return [item.value, next => { item.value = typeof next === 'function' ? next(item.value) : next; }];
    },
    useRef(initial) { return slot('ref', () => ({ current: initial })).value; },
    useEffect(callback, deps) {
      const item = slot('effect', () => undefined);
      if (!item.value || !deps || deps.some((value, i) => !Object.is(value, item.value[i]))) {
        item.value = deps; effects.push(callback);
      }
    },
  };
  const props = {
    route: { page, path: `/auth/${page}`, token: page === 'verify' ? TOKEN : null },
    policy, policyError: null, policyLoading: false, reloadPolicy: () => { events.push(['reload']); },
    navigate: path => { events.push(['navigate', path]); }, busy: false,
    onBusyChange: value => { busyChanges.push(value); },
    onConsumed: reset => { events.push(['consumed', reset]); },
    onLogin: session => { events.push(['login', session]); }, ...propOverrides,
  };
  const client = { ...transport.api, ...apiOverrides };
  const modules = new Map();
  function isolated(name) {
    const filename = resolve(root, 'src', name);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = new Module(filename, require.cache[require.resolve('react')]);
    module.filename = filename; module.paths = Module._nodeModulePaths(dirname(filename)); modules.set(filename, module);
    const localRequire = createRequire(filename);
    module.require = dependency => {
      if (dependency === 'react') return hooks;
      if (dependency === './api') return { ...transport, api: client };
      if (dependency === './ui') return isolated('ui.tsx');
      return localRequire(dependency);
    };
    module._compile(compiledSource(filename), filename);
    if (name === 'ui.tsx') {
      const realUseAction = module.exports.useAction;
      module.exports.useAction = callback => {
        const action = realUseAction(callback);
        return { ...action, run(fn) { const promise = action.run(fn); runs.push(promise); return promise; } };
      };
    }
    return module.exports;
  }
  const AuthView = isolated('AuthView.tsx').default;
  function render() {
    cursor = 0; tree = AuthView(props);
    hookCount ??= cursor; assert.equal(cursor, hookCount);
    while (effects.length) effects.shift()();
    return tree;
  }
  function one(predicate) {
    const matches = collect(tree, predicate); assert.equal(matches.length, 1); return matches[0];
  }
  render();
  return {
    events, busyChanges, runs,
    render, one,
    elements: predicate => collect(tree, predicate),
    html: () => renderToStaticMarkup(tree),
    setProps(next) { Object.assign(props, next); render(); },
    acceptTerms() { one(node => node.type === 'input' && node.props.name === 'accepted_terms').props.onChange({ target: { checked: true } }); render(); },
    submit(values = {}) {
      const form = one(node => node.type === 'form');
      assert.equal(one(node => node.type === 'fieldset').props.disabled, false);
      const actor = formActor(values);
      let prevented = false;
      form.props.onSubmit({ currentTarget: actor, preventDefault() { prevented = true; } });
      assert.equal(prevented, true); render(); return actor;
    },
    async settle() { await Promise.all(runs); await flushMicrotasks(); render(); },
  };
}

test('UI：挂载和重渲染不验证；手动 Verify and continue 精确传递 token 和 continue_session', async () => {
  const inputs = []; const data = sessionOf(loginResponse());
  const h = authHarness('verify', { verify: async input => { inputs.push(input); return data; } });
  h.render(); await flushMicrotasks();
  assert.deepEqual(inputs, []); assert.deepEqual(h.events, []); assert.deepEqual(h.busyChanges, []);
  assert.equal(content(h.one(node => node.type === 'button' && node.props.type === 'submit')), 'Verify and continue');
  assert.doesNotMatch(h.html(), new RegExp(TOKEN));
  h.submit(); await h.settle();
  assert.deepEqual(inputs, [{ token: TOKEN, continue_session: true }]);
  assert.deepEqual(h.events, [['consumed', false], ['login', data]]);
  assert.deepEqual(h.busyChanges, [true, false]);
  assert.equal(h.elements(node => node.type === 'form').length, 0);
  assert.doesNotMatch(h.html(), /Email verified\. Sign in to continue\./);
  h.render(); await h.settle(); assert.equal(inputs.length, 1);
});
test('UI：真实 200 会话先 onConsumed 清除令牌，然后 onLogin；无额外登录请求', async () => {
  const data = loginResponse(); responder = () => response(data);
  let h;
  h = authHarness('verify', {}, {
    onConsumed(reset) {
      h.events.push(['consumed', reset]);
      h.setProps({ route: { page: 'verify', path: '/auth/verify', token: null } });
    },
    onLogin(session) {
      assert.deepEqual(h.events, [['consumed', false]]);
      assert.equal(transport.getCsrfToken(), SESSION_CSRF);
      h.events.push(['login', session]);
    },
  });
  h.submit(); await h.settle();
  assert.deepEqual(h.events, [['consumed', false], ['login', sessionOf(data)]]);
  assert.deepEqual(sequence(), [[CSRF_PATH, 'GET'], [VERIFY, 'POST']]);
  assert.doesNotMatch(h.html(), /No email link is available|Email verified\. Sign in to continue\./);
});
test('UI：真实 204 显示精确简短登录回退，不 onLogin、不挂载自动验证、不重放', async () => {
  responder = () => response(null, 204);
  const h = authHarness();
  await h.settle(); assert.deepEqual(calls, []);
  h.submit(); await h.settle();
  assert.deepEqual(h.events, [['consumed', false]]);
  h.setProps({ route: { page: 'verify', path: '/auth/verify', token: null } });
  const feedback = h.one(node => typeof node.type === 'function' && node.type.name === 'ActionFeedback');
  assert.equal(feedback.props.action.note, FALLBACK);
  const html = h.html();
  assert.ok(html.includes(`<p>${FALLBACK}</p>`));
  assert.doesNotMatch(html, /role="alert"|No email link is available|Delivery depends|does not verify/);
  assert.match(html, /href="\/auth\/login"/);
  assert.equal(h.elements(node => node.type === 'form').length, 0);
  h.render(); await h.settle();
  assert.deepEqual(sequence(), [[CSRF_PATH, 'GET'], [VERIFY, 'POST']]);
});
for (const [label, change] of malformed.filter(([label]) => ['null 响应', '未知响应结构', '用户非 active', '会话已经到期'].includes(label))) {
  test(`UI：malformed 200（${label}）真实 API 报错，不消费 token 或 onLogin`, async () => {
    responder = () => response(invalidResponse(change));
    const h = authHarness(); h.submit(); await h.settle();
    assert.deepEqual(h.events, []);
    assert.match(h.html(), /role="alert"/);
    assert.match(h.html(), /unexpected response|RESPONSE_INVALID/);
    assert.equal(content(h.one(node => node.type === 'button' && node.props.type === 'submit')), 'Verify and continue');
    assert.throws(() => transport.getCsrfToken(), apiError(403, 'CSRF_REQUIRED'));
    h.render(); await h.settle(); assert.equal(writes().length, 1);
  });
}
for (const code of ['NETWORK_ERROR', 'REQUEST_TIMEOUT']) {
  test(`UI：${code} 的未知结果保留验证入口，不消费 token、不 onLogin、不自动重试`, async () => {
    let attempts = 0;
    const h = authHarness('verify', { verify: async () => { attempts += 1; throw new transport.ApiError(0, code); } });
    h.submit(); await h.settle(); h.render(); await h.settle();
    assert.equal(attempts, 1); assert.deepEqual(h.events, []);
    assert.match(h.html(), /role="alert"/); assert.match(h.html(), /outcome is unknown/i);
    assert.equal(h.elements(node => node.type === 'form').length, 1);
    assert.deepEqual(h.busyChanges, [true, false]);
  });
}
test('UI：验证请求等待期间重复提交被真实 useAction 锁阻止', async () => {
  let resolveSession; let attempts = 0;
  const pending = new Promise(resolve => { resolveSession = resolve; });
  const h = authHarness('verify', { verify: () => { attempts += 1; return pending; } });
  const oldForm = h.one(node => node.type === 'form');
  h.submit();
  oldForm.props.onSubmit({ currentTarget: formActor(), preventDefault() {} });
  assert.equal(attempts, 1);
  assert.equal(h.one(node => node.type === 'fieldset').props.disabled, true);
  resolveSession(null); await h.settle();
  assert.deepEqual(h.events, [['consumed', false]]);
});
test('UI：没有 token 或父级 busy 时不验证', async () => {
  let attempts = 0;
  for (const overrides of [{ route: { page: 'verify', path: '/auth/verify', token: null } }, { busy: true }]) {
    const h = authHarness('verify', { verify: async () => { attempts += 1; return null; } }, overrides);
    assert.equal(h.one(node => node.type === 'fieldset').props.disabled, true);
    h.one(node => node.type === 'form').props.onSubmit({ currentTarget: formActor(), preventDefault() {} });
    await h.settle(); assert.deepEqual(h.events, []);
  }
  assert.equal(attempts, 0);
});
test('UI：创建账户完成只显示 Check your email、简短提示和一个 Resend email，不显示警告', async () => {
  const inputs = [];
  const h = authHarness('register', { register: async input => { inputs.push(input); return { message: 'Request accepted. Delivery depends on the email service; this does not verify your address.' }; } });
  await h.settle(); assert.deepEqual(inputs, []);
  h.acceptTerms();
  const actor = h.submit({ email: '  verification@example.test  ', password: 'fixture-password-long', display_name: '  Fixture  ', locale: 'en' });
  assert.equal(actor.password.value, '');
  await h.settle();
  assert.deepEqual(inputs, [{ email: 'verification@example.test', password: 'fixture-password-long', display_name: 'Fixture', locale: 'en', terms_version: 'draft-v1', accepted_terms: true }]);
  assert.equal(actor.resets, 1);
  assert.equal(content(h.one(node => node.type === 'h1')), 'Check your email');
  const html = h.html();
  assert.match(html, /<p[^>]*>Open the verification link to continue\.<\/p>/);
  assert.equal(h.elements(node => typeof node.type === 'function' && node.props.href === '/auth/resend' && content(node) === 'Resend email').length, 1);
  assert.equal((html.match(/href="\/auth\/resend"/g) ?? []).length, 1);
  assert.equal(h.elements(node => node.type === 'form').length, 0);
  assert.doesNotMatch(html, /role="alert"|Delivery depends|does not verify|Request accepted|Draft legal documents|sent|delivered/i);
  assert.deepEqual(h.events, []); assert.deepEqual(h.busyChanges, [true, false]);
  h.render(); await h.settle(); assert.equal(inputs.length, 1);
});

test('E2E 静态检查：新按钮及注册提示使用精确文本定位，TypeScript 可转译（不执行浏览器测试）', () => {
  const filename = resolve(root, 'test/e2e.spec.ts');
  const source = readFileSync(filename, 'utf8');
  const result = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  assert.deepEqual((result.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
  assert.match(source, /name: action === 'verify' \? 'Verify and continue' : 'Confirm new password', exact: true/);
  assert.match(source, /getByRole\('heading', \{ name: 'Check your email', exact: true \}\)/);
  assert.match(source, /getByText\('Open the verification link to continue\.', \{ exact: true \}\)/);
  assert.doesNotMatch(source, /name: action === 'verify' \? 'Verify email'/);
});
