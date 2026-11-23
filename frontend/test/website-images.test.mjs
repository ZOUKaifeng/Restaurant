import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 仅复制 operations 的内存编译、真实 SSR 与单组件 hooks helpers，不导入其测试。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'package.json'));
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { parseFragment } = require('parse5');
const extensions = Object.fromEntries(['.ts', '.tsx', '.css'].map(name => [name, Module._extensions[name]]));
const originalGlobals = Object.fromEntries(['window', 'fetch', 'document', 'Image', 'sessionStorage', 'FileReader', 'createImageBitmap']
  .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const urlDescriptors = Object.fromEntries(['createObjectURL', 'revokeObjectURL'].map(name => [name, Object.getOwnPropertyDescriptor(URL, name)]));
const originalHooks = Object.fromEntries(['useState', 'useRef', 'useEffect', 'useCallback'].map(name => [name, React[name]]));
const initialCache = new Set(Object.keys(require.cache));
const RID = 'restaurant_fixture_000001';
const AID = `ast_${'a'.repeat(24)}`;
const BID = `ast_${'b'.repeat(24)}`;
const VID = `wsv_${'v'.repeat(24)}`;
const JID = `wsj_${'j'.repeat(24)}`;
const KEY = '12345678-1234-4234-8234-123456789abc';
const CSRF = 'fixture-csrf-token-'.repeat(3);
const NOW = '2026-03-01T10:00:00.000Z';
const BASE = `/api/v1/restaurants/${RID}/website`;
const ASSETS = `/api/v1/restaurants/${RID}/assets`;
const STORAGE = `website-attempt:${RID}`;
const GENERATE = 'Create draft';
const FACTS = 'I confirm the saved facts';
const VISION = 'I separately authorize';
let transport, websiteApi, assetApi, WebsitePanel, Thumbnail;
let calls, timers, unexpected, responder, csrfResponder, nextTimer, storage;
let images, canvases, created, revoked, liveUrls, encodings, canvasMode;
const harnesses = new Set();
const turn = () => new Promise(done => setImmediate(done));

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
function response(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
function rejection(status, code) { return response({ code, details: [] }, status); }
function deferred() {
  let yes, no;
  const promise = new Promise((resolve, reject) => { yes = resolve; no = reject; });
  return { promise, resolve: yes, reject: no };
}
function apiError(status, code) {
  return error => {
    assert.ok(error instanceof transport.ApiError);
    assert.equal(error.status, status); assert.equal(error.code, code); return true;
  };
}
function writes() { return calls.filter(call => call.options.method === 'POST'); }
function contentCalls() { return calls.filter(call => call.url.endsWith('/content')); }
function checkTransport(call, method, body, key = KEY, accept = 'application/json') {
  assert.equal(call.options.method, method);
  assert.equal(call.options.credentials, 'same-origin');
  assert.equal(call.options.cache, 'no-store');
  assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.referrerPolicy, 'same-origin');
  assert.equal(call.options.headers.get('Accept'), accept);
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
function asset(overrides = {}) {
  const value = {
    id: AID, restaurant_id: RID, kind: 'restaurant_photo', origin: 'upload',
    original_filename: '真实餐厅.jpg', mime_type: 'image/jpeg', size_bytes: 4,
    checksum: 'fixture-photo-checksum', width_px: 2048, height_px: 1024, alt_text: null,
    rights_confirmed_at: NOW, safety_status: 'approved', status: 'ready', revision: 1,
    created_at: NOW, updated_at: NOW, can_delete: true, ...overrides,
  };
  return { content_url: `${ASSETS}/${value.id}/content`, ...value };
}
function restaurant(overrides = {}) {
  return {
    id: RID, name: '真实餐厅', slug: 'fixture-dining', status: 'draft', revision: 7, role: 'owner',
    description: '仅展示商家保存的事实', cuisine_label: null, country_code: null, region: null, city: null,
    address_line1: null, address_line2: null, postal_code: null, contact_email: null, phone: null,
    timezone: null, currency_code: null, primary_locale: 'zh-CN', reservation_enabled: false,
    created_at: NOW, updated_at: NOW, readiness: { ready_for_publication: false, missing_fields: ['phone'] }, ...overrides,
  };
}
function state(overrides = {}) {
  return {
    agent: { id: null, revision: 0, messages: [], design_brief: '用商家真实照片展示餐厅与菜品' },
    versions: [], jobs: [], publication: { revision: 0, published_version_id: null, slug: null, url: null, deployment_mode: 'unconfigured' },
    model: 'fixture-model', model_configured: true, menu_recognition_enabled: true,
    menu: { revision: 3, status: 'confirmed', item_count: 2 }, ...overrides,
  };
}
function body(overrides = {}) {
  const { image_vision_confirmed, ...rest } = overrides;
  return { brief: '用商家真实照片展示餐厅与菜品', asset_ids: [AID], public_assets_confirmed: true,
    ...(Object.hasOwn(overrides, 'image_vision_confirmed') ? { image_vision_confirmed } : {}),
    expected_restaurant_revision: 7, expected_menu_revision: 3, ...rest };
}
function version(ids = [AID]) {
  return { id: VID, restaurant_id: RID, version_number: 1, summary: '真实素材网页', created_at: NOW,
    checksum: 'fixture-website-checksum', asset_ids: ids };
}
function contentResponse(item = asset(), bytes = 'JPEG', status = 200, mime = item.mime_type) {
  return new Response(bytes, { status, headers: { 'Content-Type': mime } });
}
function panelResponses({ items = [asset()], current = state(), write = () => rejection(503, 'AI_UPSTREAM_UNAVAILABLE'), extra } = {}) {
  responder = call => {
    if (call.url === BASE) return response(typeof current === 'function' ? current() : current);
    if (call.url.startsWith(`${ASSETS}?`)) return response({ items: typeof items === 'function' ? items() : items,
      has_more: false, next_cursor: null, storage_mode: 'local' });
    if (call.url === `${BASE}/generations`) return write(call);
    if (extra) return extra(call);
    throw new Error(`未配置接口 ${call.url}`);
  };
}
function attr(node, key) { return (node.attrs ?? []).find(item => item.name === key)?.value; }
function nodes(node, predicate) {
  const result = [];
  function walk(item) { if (predicate(item)) result.push(item); for (const child of item.childNodes ?? []) walk(child); }
  walk(node); return result;
}
function text(node) { return node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(text).join(''); }
function documentOf(html) { return parseFragment(html); }
function collect(tree, predicate) {
  const result = [];
  function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object' || !node.props) return;
    if (predicate(node)) result.push(node);
    walk(node.props.children); for (const key of ['design', 'preview', 'status', 'publication']) walk(node.props[key]);
  }
  walk(tree); return result;
}
function content(node) {
  if (Array.isArray(node)) return node.map(content).join('');
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  return content(node.props?.children);
}

// 局部 React 注入，不修改共享 React，不执行有 hooks 的子组件；子树交给真实 SSR。
function componentWithReact(filename, stub) {
  const path = resolve(root, 'src', filename);
  const isolated = new Module(path, require.cache[require.resolve('react')]);
  isolated.filename = path; isolated.paths = Module._nodeModulePaths(dirname(path));
  const localRequire = createRequire(path);
  isolated.require = name => name === 'react' ? stub : localRequire(name);
  isolated._compile(compiledSource(path), path);
  return isolated.exports.default;
}
function hooksHarness(filename, initialProps) {
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
      const item = slot('state', () => ({ value: typeof initial === 'function' ? initial() : initial }));
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
  const Component = componentWithReact(filename, stub);
  function render() {
    assert.ok(!disposed); index = 0; renderNeeded = false; tree = Component(props);
    if (expectedHooks === null) expectedHooks = index;
    assert.equal(index, expectedHooks, '每次渲染 hooks 数一致');
  }
  function runEffects() {
    for (const item of slots) if (item.kind === 'effect' && item.pending) {
      item.pending = false; item.cleanup?.(); item.cleanup = item.callback();
    }
  }
  function commit() {
    for (let guard = 0; guard < 20; guard += 1) {
      if (renderNeeded) render(); runEffects(); if (!renderNeeded) return;
    }
    assert.fail('harness 渲染未稳定');
  }
  const elements = predicate => collect(tree, predicate);
  function button(label) {
    const matches = elements(node => node.type === 'button' && content(node) === label);
    assert.equal(matches.length, 1, `应存在唯一按钮 ${label}`); return matches[0];
  }
  function checkbox(label) {
    const labels = elements(node => node.type === 'label' && content(node).includes(label));
    assert.equal(labels.length, 1, `应存在唯一标签 ${label}`);
    const inputs = collect(labels[0], node => node.type === 'input' && node.props.type === 'checkbox');
    assert.equal(inputs.length, 1); return inputs[0];
  }
  const h = {
    get tree() { return tree; }, updates, elements, content, button, checkbox, commit,
    text() { return content(tree); },
    markup() { return renderToStaticMarkup(tree); },
    click(label) { const node = button(label); assert.ok(!node.props.disabled, `${label} 应可点击`); node.props.onClick(); commit(); },
    check(label, checked = true) {
      const node = checkbox(label); assert.ok(!node.props.disabled, `${label} 应可修改`);
      node.props.onChange({ target: { checked } }); commit();
    },
    change(suffix, value) {
      const matches = elements(node => ['input', 'textarea'].includes(node.type) && node.props.id?.endsWith(suffix));
      assert.equal(matches.length, 1); assert.ok(!matches[0].props.disabled);
      matches[0].props.onChange({ target: { value } }); commit();
    },
    setProps(next) { props = { ...props, ...next }; render(); commit(); },
    async settle() { await turn(); if (!disposed) commit(); },
    unmount() {
      if (disposed) return;
      for (const item of slots) if (item.kind === 'effect') { item.cleanup?.(); item.cleanup = undefined; }
      disposed = true; harnesses.delete(h);
    },
  };
  render(); commit(); harnesses.add(h); return h;
}
function panelHarness(overrides = {}) {
  const busy = [], dirty = [], jobs = [], conflicts = [];
  const props = { restaurant: restaurant(), active: true, busy: false, restaurantDirty: false,
    onBusyChange: value => busy.push(value), onJobsChange: value => jobs.push(value),
    onDirtyChange: value => dirty.push(value), onRestaurantConflict: () => conflicts.push(true), ...overrides };
  return Object.assign(hooksHarness('WebsitePanel.tsx', props), { busy, dirty, jobs, conflicts });
}
function thumbnailHarness(item = asset(), overrides = {}) {
  return hooksHarness('WebsiteAssetThumbnail.tsx', { restaurantId: RID, asset: item, selected: true, active: true, ...overrides });
}
async function selectAndConfirm(h, item = asset(), vision = true) {
  await h.settle(); h.check(item.original_filename); h.check(FACTS);
  if (vision) h.check(VISION);
}
function savedAttempt() { return JSON.parse(storage.get(STORAGE) ?? 'null'); }
function saveAttempt(input = body(), key = KEY) { storage.set(STORAGE, JSON.stringify({ kind: 'generate', key, body: input })); }
function renderedImage(h) {
  const matches = h.elements(node => node.type === 'img'); assert.equal(matches.length, 1); return matches[0];
}
async function decode(h, width = 2048, height = 1024) {
  await h.settle(); const image = images.at(-1); assert.ok(image?.onload, '应等待假 Image 解码');
  image.naturalWidth = width; image.naturalHeight = height; image.onload(); await h.settle(); return image;
}

before(() => {
  const compile = (module, filename) => module._compile(compiledSource(filename), filename);
  Module._extensions['.ts'] = compile; Module._extensions['.tsx'] = compile; Module._extensions['.css'] = () => {};
  transport = load('api.ts'); ({ websiteApi } = load('website-api.ts')); ({ assetApi } = load('asset-api.ts'));
  WebsitePanel = load('WebsitePanel.tsx').default; Thumbnail = load('WebsiteAssetThumbnail.tsx').default;
});
beforeEach(() => {
  calls = []; timers = new Map(); unexpected = []; nextTimer = 0; storage = new Map();
  images = []; canvases = []; created = []; revoked = []; liveUrls = new Set(); encodings = [];
  canvasMode = { context: true, blob: true, deferred: false };
  responder = () => { throw new Error('没有配置测试回包'); };
  csrfResponder = () => response({ csrf_token: CSRF });
  globalThis.window = {
    location: { pathname: '/app', origin: 'https://localhost:5173', hash: '', search: '' },
    addEventListener() {}, removeEventListener() {},
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  globalThis.sessionStorage = { getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  globalThis.fetch = async (url, options) => {
    const call = { url: String(url), options }; calls.push(call);
    try { return call.url === '/api/v1/auth/csrf' ? csrfResponder(call) : responder(call); }
    catch (error) { unexpected.push({ url: call.url, error }); throw error; }
  };
  globalThis.Image = class {
    naturalWidth = 2048; naturalHeight = 1024; onload = null; onerror = null; src = '';
    constructor() { images.push(this); }
  };
  globalThis.document = { createElement(name) {
    assert.equal(name, 'canvas');
    const canvas = { width: 0, height: 0, draws: [],
      getContext(kind) {
        assert.equal(kind, '2d'); return canvasMode.context ? { drawImage: (...args) => canvas.draws.push(args) } : null;
      },
      toBlob(callback, mime) {
        assert.equal(mime, 'image/png');
        const value = canvasMode.blob ? new Blob(['本地缩略图'], { type: mime }) : null;
        if (canvasMode.deferred) encodings.push({ callback, value }); else callback(value);
      },
    };
    canvases.push(canvas); return canvas;
  } };
  globalThis.createImageBitmap = undefined;
  globalThis.FileReader = class {
    onload = null; onerror = null; result = null;
    readAsDataURL(blob) {
      blob.arrayBuffer().then(bytes => {
        this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`; this.onload?.();
      }, () => this.onerror?.());
    }
  };
  URL.createObjectURL = blob => {
    assert.ok(blob instanceof Blob); const url = `blob:https://localhost:5173/fixture-${created.length + 1}`;
    created.push({ url, blob }); liveUrls.add(url); return url;
  };
  URL.revokeObjectURL = url => { assert.ok(created.some(item => item.url === url), '只能释放本测试创建的 URL'); revoked.push(url); liveUrls.delete(url); };
  transport.clearCsrf();
});
afterEach(async () => {
  for (const h of [...harnesses].reverse()) h.unmount();
  harnesses.clear(); await turn();
  assert.deepEqual(unexpected, [], '不得访问未配置接口或真实网络');
  assert.equal(timers.size, 0, '所有 transport 与轮询超时器须释放');
  assert.equal(liveUrls.size, 0, '所有 source/thumbnail/preview blob URL 须释放');
  for (const [name, hook] of Object.entries(originalHooks)) assert.equal(React[name], hook, '局部 hook 注入不能污染真实 React');
  transport.clearCsrf();
});
after(() => {
  for (const [name, handler] of Object.entries(extensions)) {
    if (handler) Module._extensions[name] = handler; else delete Module._extensions[name];
    assert.equal(Module._extensions[name], handler);
  }
  for (const [name, descriptor] of Object.entries(originalGlobals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, name), descriptor);
  }
  for (const [name, descriptor] of Object.entries(urlDescriptors)) {
    if (descriptor) Object.defineProperty(URL, name, descriptor); else delete URL[name];
    assert.deepEqual(Object.getOwnPropertyDescriptor(URL, name), descriptor);
  }
  for (const filename of Object.keys(require.cache)) {
    if (!initialCache.has(filename) && filename.startsWith(resolve(root, 'src') + '/')) delete require.cache[filename];
  }
  // 恢复完扩展和全局环境，已经加载的真实组件仍可 SSR，无非法 hook 调用。
  const html = renderToStaticMarkup(React.createElement(Thumbnail, { restaurantId: RID, asset: asset(), selected: false, active: false }));
  assert.ok(text(documentOf(html)).includes('真实餐厅.jpg'));
});

test('内存类型检查：vision 为 optional true，runtime false/null 不合法，生产组件无 demo props', () => {
  const filename = resolve(root, 'test', '__website_images_type_fixture__.tsx');
  const source = `
    import type { ComponentProps } from 'react';
    import type { WebsiteGenerateInput, WebsiteAttempt } from '../src/website-types';
    import Thumbnail from '../src/WebsiteAssetThumbnail';
    import WebsitePanel from '../src/WebsitePanel';
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
    type Assert<T extends true> = T;
    type Consent = Assert<Equal<WebsiteGenerateInput['image_vision_confirmed'], true | undefined>>;
    type Optional = Assert<{} extends Pick<WebsiteGenerateInput, 'image_vision_confirmed'> ? true : false>;
    type Persisted = Assert<Equal<Extract<WebsiteAttempt, { kind: 'generate' }>['body'], WebsiteGenerateInput>>;
    type ThumbnailProps = Assert<Equal<keyof ComponentProps<typeof Thumbnail>, 'restaurantId' | 'asset' | 'selected' | 'active'>>;
    type PanelProps = Assert<Equal<keyof ComponentProps<typeof WebsitePanel>, 'restaurant' | 'active' | 'busy' | 'restaurantDirty' | 'onBusyChange' | 'onJobsChange' | 'onDirtyChange' | 'onRestaurantConflict' | 'onContentSaved' | 'onContentDirtyChange'>>;
    const legacy: WebsiteGenerateInput = { brief: '真实图片网页', asset_ids: [], public_assets_confirmed: true, expected_restaurant_revision: 7 };
    const authorized: WebsiteGenerateInput = { ...legacy, image_vision_confirmed: true };
    // @ts-expect-error 独立授权不能为 false。
    const rejectedFalse: WebsiteGenerateInput = { ...legacy, image_vision_confirmed: false };
    // @ts-expect-error 独立授权不能为 null。
    const rejectedNull: WebsiteGenerateInput = { ...legacy, image_vision_confirmed: null };
    // @ts-expect-error 独立授权不能为字符串。
    const rejectedString: WebsiteGenerateInput = { ...legacy, image_vision_confirmed: 'true' };
    // @ts-expect-error 公开授权同样必须为 true。
    const rejectedPublic: WebsiteGenerateInput = { ...authorized, public_assets_confirmed: false };
  `;
  const options = { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX, strict: true, skipLibCheck: true, noEmit: true, esModuleInterop: true,
    allowImportingTsExtensions: true, typeRoots: [resolve(root, 'node_modules/@types')], types: ['node'] };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => path === filename
    ? ts.createSourceFile(filename, source, languageVersion, true, ts.ScriptKind.TSX)
    : getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([filename], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(item => item.file?.fileName === filename);
  assert.deepEqual(diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')), []);
  assert.equal(existsSync(filename), false, '类型夹具只存在内存'); assert.equal(calls.length, 0);
});

for (const confirmed of [undefined, true]) test(`真实 generate transport：${confirmed === true ? '显式图片授权' : 'legacy 缺省'}，CSRF 与同键 body 保真`, async () => {
  const input = body(confirmed === true ? { image_vision_confirmed: true } : {});
  responder = () => response({ job_id: JID, status: 'queued', private_model_payload: '不可展示' }, 202);
  assert.deepEqual(await websiteApi.generate(RID, input, KEY), { job_id: JID, status: 'queued' });
  assert.equal(calls[0].url, '/api/v1/auth/csrf'); checkTransport(calls[0], 'GET');
  assert.equal(calls[1].url, `${BASE}/generations`); checkTransport(calls[1], 'POST', input);
  assert.equal(Object.hasOwn(JSON.parse(calls[1].options.body), 'image_vision_confirmed'), confirmed === true);
  assert.deepEqual(input, body(confirmed === true ? { image_vision_confirmed: true } : {}));
});
for (const value of [false, null, 'true', 1, 0, {}, []]) test(`generate runtime 拒绝 vision=${JSON.stringify(value)}，不请求 CSRF 或网络`, async () => {
  await assert.rejects(Promise.resolve().then(() => websiteApi.generate(RID, body({ image_vision_confirmed: value }), KEY)), apiError(422, 'REQUEST_INVALID'));
  assert.equal(calls.length, 0);
});
test('generate CSRF 失败不发生成请求；服务端 403 不自动重放生成', async () => {
  csrfResponder = () => rejection(503, 'CSRF_UNAVAILABLE');
  await assert.rejects(websiteApi.generate(RID, body({ image_vision_confirmed: true }), KEY), apiError(503, 'CSRF_UNAVAILABLE'));
  assert.equal(writes().length, 0);
  csrfResponder = () => response({ csrf_token: CSRF }); responder = () => rejection(403, 'CSRF_INVALID');
  await assert.rejects(websiteApi.generate(RID, body({ image_vision_confirmed: true }), KEY), apiError(403, 'CSRF_INVALID'));
  await turn(); assert.equal(writes().length, 1);
});

for (const [kind, mime, filename] of [
  ['restaurant_photo', 'image/jpeg', '餐厅.JPG'], ['restaurant_photo', 'image/png', '餐厅.PNG'],
  ['logo', 'image/jpeg', 'Logo.JPG'], ['logo', 'image/png', 'Logo.PNG'],
  ['dish_photo', 'image/jpeg', '菜品.JPG'], ['dish_photo', 'image/png', '菜品.PNG'],
]) test(`WebsitePanel：${kind}/${mime} 独立授权默认 false，公开授权不能替代看图授权`, async () => {
  const item = asset({ kind, mime_type: mime, original_filename: filename }); panelResponses({ items: [item] });
  const h = panelHarness(); await h.settle();
  assert.equal(h.elements(node => node.type === 'input' && node.props['aria-describedby']?.endsWith('-vision-help')).length, 0);
  h.check(filename); assert.equal(h.checkbox(VISION).props.checked, false); assert.equal(h.checkbox(FACTS).props.checked, false);
  h.check(FACTS); assert.equal(h.checkbox(VISION).props.checked, false); assert.equal(h.button(GENERATE).props.disabled, true);
  h.button(GENERATE).props.onClick(); h.commit(); await h.settle(); assert.equal(writes().length, 0, '不能绕过 disabled 发新生成');
  const child = h.elements(node => typeof node.type === 'function' && node.type.name === 'WebsiteAssetThumbnail');
  assert.equal(child.length, 1); assert.deepEqual(child[0].props.asset, item);
  assert.equal(child[0].props.active, true); assert.equal(child[0].props.selected, true);
  h.check(VISION); assert.equal(h.button(GENERATE).props.disabled, false);
  h.click(GENERATE); await h.settle();
  const request = writes()[0]; assert.equal(writes().length, 1);
  checkTransport(request, 'POST', body({ image_vision_confirmed: true }), request.options.headers.get('Idempotency-Key'));
  assert.equal(savedAttempt().body.image_vision_confirmed, true);
  assert.equal(contentCalls().length, 0, '父 harness 不执行子 hooks；缩略图由独立生命周期用例验证');
});
for (const [mime, filename] of [['image/jpeg', '菜单原图.jpg'], ['image/png', '菜单原图.png'], ['application/pdf', '菜单.pdf']]) {
  test(`WebsitePanel：menu_source/${mime} 不需要视觉授权，仍需公开授权`, async () => {
    const item = asset({ kind: 'menu_source', mime_type: mime, original_filename: filename }); panelResponses({ items: [item] });
    const h = panelHarness(); await selectAndConfirm(h, item, false);
    assert.equal(h.elements(node => node.type === 'label' && content(node).includes(VISION)).length, 0);
    assert.equal(h.button(GENERATE).props.disabled, false); h.click(GENERATE); await h.settle();
    assert.equal(writes().length, 1); assert.equal(Object.hasOwn(JSON.parse(writes()[0].options.body), 'image_vision_confirmed'), false);
    const html = h.markup(); assert.ok(text(documentOf(html)).includes('Menu images / PDF'));
    if (mime === 'application/pdf') assert.ok(text(documentOf(html)).includes('Menu images / PDF are not sent'));
  });
}
test('WebsitePanel：不选素材可生成纯文字网页，不请求独立视觉授权', async () => {
  panelResponses({ items: [] }); const h = panelHarness(); await h.settle(); h.check(FACTS);
  assert.equal(h.button(GENERATE).props.disabled, false); h.click(GENERATE); await h.settle();
  assert.deepEqual(JSON.parse(writes()[0].options.body), body({ asset_ids: [] }));
});
for (const change of ['brief', 'selection', 'restaurant_revision', 'asset_revision', 'asset_checksum', 'asset_rights', 'asset_kind', 'asset_mime']) {
  test(`WebsitePanel：${change} 变化使公开和视觉授权失效`, async () => {
    let item = asset(); panelResponses({ items: () => [item] }); const h = panelHarness(); await selectAndConfirm(h);
    assert.equal(h.checkbox(VISION).props.checked, true); assert.equal(h.checkbox(FACTS).props.checked, true);
    if (change === 'brief') h.change('-brief', '更改排版摘要，仍使用真实图片');
    else if (change === 'selection') h.check(item.original_filename, false);
    else if (change === 'restaurant_revision') h.setProps({ restaurant: restaurant({ revision: 8 }) });
    else {
      const changes = { asset_revision: { revision: 2 }, asset_checksum: { checksum: 'changed-checksum' },
        asset_rights: { rights_confirmed_at: '2026-03-02T10:00:00.000Z' }, asset_kind: { kind: 'dish_photo' }, asset_mime: { mime_type: 'image/png' } };
      item = { ...item, ...changes[change] }; h.click('Refresh assets'); await h.settle();
    }
    assert.equal(h.checkbox(FACTS).props.checked, false);
    if (change !== 'selection') assert.equal(h.checkbox(VISION).props.checked, false);
    else { h.check(item.original_filename); assert.equal(h.checkbox(VISION).props.checked, false); }
    assert.equal(h.button(GENERATE).props.disabled, true); assert.equal(writes().length, 0);
  });
}
test('WebsitePanel：无关未选素材更新不撤销已核对图片授权，取消公开授权仍阻止生成', async () => {
  let other = asset({ id: BID, kind: 'dish_photo', original_filename: '未选菜品.png', mime_type: 'image/png' });
  panelResponses({ items: () => [asset(), other] }); const h = panelHarness(); await selectAndConfirm(h);
  other = { ...other, revision: 2 }; h.click('Refresh assets'); await h.settle();
  assert.equal(h.checkbox(VISION).props.checked, true); assert.equal(h.checkbox(FACTS).props.checked, true);
  h.check(FACTS, false); assert.equal(h.checkbox(VISION).props.checked, true); assert.equal(h.button(GENERATE).props.disabled, true);
});

for (const confirmed of [undefined, true]) test(`WebsitePanel restore：${confirmed === true ? '保存 true 授权' : 'legacy 不补 true'}，新生成禁用，retry 冻结原 key/body`, async () => {
  const input = body(confirmed === true ? { image_vision_confirmed: true } : {}); saveAttempt(input);
  panelResponses(); const h = panelHarness(); await h.settle();
  assert.equal(h.checkbox(VISION).props.checked, confirmed === true); assert.equal(h.checkbox(VISION).props.disabled, true);
  assert.equal(h.button(GENERATE).props.disabled, true); assert.equal(writes().length, 0, '恢复不能自动提交');
  const html = h.markup(); const copy = text(documentOf(html));
  assert.ok(copy.includes(confirmed === true ? 'The original request includes separate image consent' : 'The original request has no image consent'));
  assert.equal(h.elements(node => node.type === 'textarea' && node.props.id?.endsWith('-brief'))[0].props.value, input.brief);
  h.setProps({ restaurant: restaurant({ revision: 8 }) });
  assert.equal(h.checkbox(VISION).props.checked, false, '当前草稿授权失效，但原请求不能被改写');
  const start = calls.length; h.click('Check result / Retry same request'); await h.settle();
  assert.equal(calls[start].url, BASE, '先只读核查'); assert.equal(writes().length, 1);
  checkTransport(writes()[0], 'POST', input); assert.deepEqual(savedAttempt(), { kind: 'generate', key: KEY, body: input });
  assert.equal(Object.hasOwn(JSON.parse(writes()[0].options.body), 'image_vision_confirmed'), confirmed === true);
});
for (const value of [false, null]) test(`WebsitePanel restore：拒绝持久化 vision=${value}，不伪造授权或重试`, async () => {
  saveAttempt(body({ image_vision_confirmed: value })); panelResponses(); const h = panelHarness(); await h.settle();
  assert.equal(h.elements(node => node.type === 'button' && content(node) === 'Check result / Retry same request').length, 0);
  assert.equal(h.elements(node => node.type === 'input' && node.props['aria-describedby']?.endsWith('-vision-help')).length, 0);
  h.check(asset().original_filename); assert.equal(h.checkbox(VISION).props.checked, false); assert.equal(writes().length, 0);
});
test('WebsitePanel：新授权请求网络结果未知，持久化 true；刷新和 doubleclick retry 同 key/body 不换键', async () => {
  panelResponses({ write: () => Promise.reject(new TypeError('夹具网络结果未知')) });
  const h = panelHarness(); await selectAndConfirm(h);
  const handler = h.button(GENERATE).props.onClick; handler(); handler(); h.commit(); await h.settle();
  assert.equal(writes().length, 1); const original = savedAttempt(); assert.equal(original.body.image_vision_confirmed, true);
  checkTransport(writes()[0], 'POST', original.body, original.key);
  h.unmount(); const restored = panelHarness(); await restored.settle();
  assert.equal(restored.checkbox(VISION).props.checked, true); assert.equal(writes().length, 1);
  const start = calls.length; const retry = restored.button('Check result / Retry same request').props.onClick;
  retry(); retry(); restored.commit(); await restored.settle();
  assert.equal(calls[start].url, BASE); assert.equal(writes().length, 2);
  checkTransport(writes()[1], 'POST', original.body, original.key); assert.deepEqual(savedAttempt(), original);
  assert.equal(restored.button(GENERATE).props.disabled, true); assert.deepEqual(restored.busy, [true, false]);
});
test('WebsitePanel：放弃 legacy 请求只清本地；重新选择图片仍必须单独授权', async () => {
  saveAttempt(); panelResponses(); const h = panelHarness(); await h.settle();
  const section = h.elements(node => node.type === 'section' && node.props['aria-labelledby']?.endsWith('-uncertain'));
  assert.equal(section.length, 1);
  const discard = collect(section[0], node => node.type === 'button' && content(node) === 'Discard local request');
  assert.equal(discard.length, 1); assert.equal(discard[0].props.disabled, false);
  discard[0].props.onClick(); h.commit(); await h.settle();
  assert.equal(savedAttempt(), null); assert.equal(writes().length, 0);
  h.check(asset().original_filename); h.check(FACTS);
  assert.equal(h.checkbox(VISION).props.checked, false); assert.equal(h.button(GENERATE).props.disabled, true);
});

test('真实 SSR：素材种类、独立隐私说明、checkbox types/ARIA；不展示额外私有字段或外部素材链接', async () => {
  const items = [asset({ original_filename: '<script>餐厅</script>.jpg', storage_key: 'private-storage-secret' }),
    asset({ id: BID, kind: 'logo', mime_type: 'image/png', original_filename: '品牌 Logo.png' }),
    asset({ id: `ast_${'c'.repeat(24)}`, kind: 'dish_photo', original_filename: '招牌菜.jpg' }),
    asset({ id: `ast_${'d'.repeat(24)}`, kind: 'menu_source', mime_type: 'application/pdf', original_filename: '菜单.pdf' })];
  panelResponses({ items }); const h = panelHarness(); await h.settle();
  for (const item of items) h.check(item.original_filename);
  const before = calls.length, html = h.markup(), doc = documentOf(html), copy = text(doc);
  assert.equal(calls.length, before, '真实 SSR 不执行 effect 或请求');
  for (const label of ['Restaurant photo', 'Logo', 'Dish photo', 'PDF (download only)', 'I separately authorize', 'not menu OCR',
    'do not mean AI has seen', 'does not authorize image sharing', 'Nothing publishes automatically', 'Multiple model calls']) assert.ok(copy.includes(label), label);
  assert.ok(html.includes('&lt;script&gt;')); assert.equal(nodes(doc, node => node.tagName === 'script').length, 0);
  assert.equal(copy.includes('private-storage-secret'), false);
  const vision = nodes(doc, node => node.tagName === 'input' && attr(node, 'aria-describedby')?.endsWith('-vision-help'));
  assert.equal(vision.length, 1); assert.equal(attr(vision[0], 'type'), 'checkbox'); assert.equal(attr(vision[0], 'checked'), undefined);
  assert.equal(nodes(doc, node => attr(node, 'id') === attr(vision[0], 'aria-describedby')).length, 1);
  const generate = nodes(doc, node => node.tagName === 'button' && text(node) === GENERATE)[0];
  assert.equal(attr(generate, 'type'), 'button'); assert.notEqual(attr(generate, 'disabled'), undefined);
  assert.equal(nodes(doc, node => node.tagName === 'a' && /\/assets\/|^https?:/.test(attr(node, 'href') ?? '')).length, 0);
});

test('真实 preview transport + SSR：照片实际嵌入网页，原图/PDF 下载链接与隔离隐私策略正确', async () => {
  const photo = asset(), pdf = asset({ id: BID, kind: 'menu_source', mime_type: 'application/pdf', original_filename: '菜单.pdf' });
  const v = version([AID, BID]);
  const page = `<!doctype html><html><head><title>真实照片网页</title></head><body><img src="__SITE_ASSET_${AID}__" alt="商家餐厅"><a href="__SITE_ASSET_${BID}__">菜单原文件</a></body></html>`;
  panelResponses({ items: [photo, pdf], current: state({ versions: [v] }), extra: call => {
    if (call.url === `${BASE}/versions/${VID}/preview`) return response({ html: page, checksum: v.checksum, assets: [photo, pdf]
      .map(item => ({ id: item.id, content_url: item.content_url, mime_type: item.mime_type })) });
    if (call.url === photo.content_url) return contentResponse(photo);
    if (call.url === pdf.content_url) return contentResponse(pdf, '%PDF');
    throw new Error(`未预期接口 ${call.url}`);
  } });
  const h = panelHarness(); await h.settle(); h.tree.props.onPreview(v); h.commit(); await h.settle(); await h.settle();
  assert.equal(writes().length, 0, '预览绝不生成或发布');
  assert.equal(contentCalls().length, 2); contentCalls().forEach((call, i) => checkTransport(call, 'GET', undefined, KEY, i ? 'application/pdf' : 'image/jpeg'));
  const before = calls.length, doc = documentOf(h.markup()); assert.equal(calls.length, before);
  const iframe = nodes(doc, node => node.tagName === 'iframe')[0]; assert.ok(iframe);
  assert.equal(attr(iframe, 'referrerpolicy'), 'no-referrer');
  const sandbox = attr(iframe, 'sandbox').split(' ');
  assert.equal(sandbox.includes('allow-scripts'), false); assert.equal(sandbox.includes('allow-same-origin'), false); assert.equal(sandbox.includes('allow-forms'), false);
  const decoded = decodeURIComponent(attr(iframe, 'src').split(',').slice(1).join(','));
  const image = nodes(documentOf(decoded), node => node.tagName === 'img')[0];
  assert.equal(attr(image, 'src'), 'data:image/jpeg;base64,SlBFRw==', '商家字节确实进入网页图片，不是文件名或 metadata');
  assert.equal(decoded.includes('__SITE_ASSET_'), false); assert.ok(decoded.includes("connect-src 'none'")); assert.ok(decoded.includes("script-src 'none'"));
  const links = nodes(doc, node => node.tagName === 'a');
  const full = links.find(node => text(node).includes('full preview'));
  assert.equal(attr(full, 'target'), '_blank'); assert.equal(attr(full, 'rel'), 'noopener noreferrer');
  const fullBlob = created.find(item => item.url === attr(full, 'href')).blob;
  const fullImage = nodes(documentOf(await fullBlob.text()), node => node.tagName === 'img')[0];
  assert.equal(attr(fullImage, 'src'), created[0].url);
  const photoDownload = links.find(node => attr(node, 'download') === 'image-1.jpg');
  const pdfDownload = links.find(node => attr(node, 'download') === `menu-${BID}.pdf`);
  assert.equal(attr(photoDownload, 'href'), created[0].url); assert.equal(attr(photoDownload, 'rel'), 'noopener');
  assert.equal(attr(pdfDownload, 'href'), created[1].url); assert.equal(attr(pdfDownload, 'rel'), 'noopener');
  assert.equal(liveUrls.size, 3); h.click('Close preview'); assert.equal(liveUrls.size, 0);
});

for (const [label, item, props] of [
  ['inactive', asset(), { active: false }], ['unselected', asset(), { selected: false }],
  ['other restaurant', asset({ restaurant_id: 'restaurant_other_0000001' }), {}],
  ['not upload', asset({ origin: 'generated' }), {}], ['deleted', asset({ status: 'deleted' }), {}],
  ['not approved', asset({ safety_status: 'pending' }), {}],
  ['PDF', asset({ kind: 'menu_source', mime_type: 'application/pdf' }), {}], ['unsupported MIME', asset({ mime_type: 'image/webp' }), {}],
]) test(`Thumbnail：${label} 不读取字节、不建 Image/canvas/blob URL`, async () => {
  const h = thumbnailHarness(item, props); await h.settle();
  assert.equal(calls.length, 0); assert.equal(images.length, 0); assert.equal(canvases.length, 0); assert.equal(created.length, 0);
  const html = h.markup(); assert.equal(nodes(documentOf(html), node => node.tagName === 'img').length, 0);
  if (item.mime_type === 'application/pdf') assert.ok(text(documentOf(html)).includes('不发送建站视觉分析'));
});
for (const [width, height, expectedWidth, expectedHeight] of [[2048, 1024, 512, 256], [1000, 2000, 256, 512], [500, 300, 500, 300], [1, 1, 1, 1]]) {
  test(`Thumbnail：${width}x${height} 授权 GET→canvas ${expectedWidth}x${expectedHeight}，PNG URL 展示与卸载清理`, async () => {
    const item = asset({ content_url: 'https://untrusted.invalid/raw.jpg' }); responder = () => contentResponse(item);
    const h = thumbnailHarness(item); await h.settle();
    assert.equal(calls[0].url, `${ASSETS}/${AID}/content`, '真实 assetApi 构造授权路径，不导航任意 content_url');
    checkTransport(calls[0], 'GET', undefined, KEY, 'image/jpeg');
    const sourceUrl = created[0].url; assert.equal(images[0].src, sourceUrl); assert.equal(created[0].blob.type, 'image/jpeg');
    const image = await decode(h, width, height), canvas = canvases[0];
    assert.deepEqual([canvas.width, canvas.height], [expectedWidth, expectedHeight]);
    assert.deepEqual(canvas.draws, [[image, 0, 0, expectedWidth, expectedHeight]]);
    assert.equal(created.length, 2); assert.equal(created[1].blob.type, 'image/png');
    assert.deepEqual(revoked, [sourceUrl]); assert.equal(image.src, ''); assert.equal(image.onload, null); assert.equal(image.onerror, null);
    const shown = renderedImage(h); assert.equal(shown.props.src, created[1].url); assert.equal(shown.props.alt, '所选素材：真实餐厅.jpg');
    const doc = documentOf(h.markup()); assert.equal(attr(nodes(doc, node => node.tagName === 'img')[0], 'src'), created[1].url);
    h.unmount(); assert.deepEqual(revoked, [sourceUrl, created[1].url]); assert.equal(timers.size, 0);
  });
}
for (const prop of ['active', 'selected']) test(`Thumbnail：${prop} 关闭时释放展示 URL，重新启用重新授权读取`, async () => {
  responder = () => contentResponse(); const h = thumbnailHarness(); await decode(h); const old = renderedImage(h).props.src;
  h.setProps({ [prop]: false }); assert.equal(h.elements(node => node.type === 'img').length, 0); assert.ok(revoked.includes(old));
  await h.settle(); assert.equal(contentCalls().length, 1);
  h.setProps({ [prop]: true }); await decode(h); assert.equal(contentCalls().length, 2); assert.notEqual(renderedImage(h).props.src, old);
});
for (const switchBy of ['asset_id', 'restaurant_id', 'revision', 'checksum', 'mime', 'rights']) test(`Thumbnail：${switchBy} 切换后旧 fetch 迟到不会展示新资源或创建旧图 URL`, async () => {
  const late = deferred(); responder = call => contentCalls().length === 1 ? late.promise : contentResponse(next);
  let next = asset(); const h = thumbnailHarness(); await h.settle(); const oldCall = calls[0];
  if (switchBy === 'asset_id') next = asset({ id: BID, original_filename: '新图片.jpg' });
  else if (switchBy === 'restaurant_id') next = asset({ restaurant_id: 'restaurant_other_0000001' });
  else {
    const changes = { revision: { revision: 2 }, checksum: { checksum: 'next-checksum' }, mime: { mime_type: 'image/png' },
      rights: { rights_confirmed_at: '2026-03-02T10:00:00.000Z' } }; next = asset(changes[switchBy]);
  }
  h.setProps({ asset: next, ...(switchBy === 'restaurant_id' ? { restaurantId: next.restaurant_id } : {}) });
  assert.equal(oldCall.options.signal.aborted, true); await decode(h); const currentUrl = renderedImage(h).props.src;
  const createdCount = created.length, updates = h.updates.length;
  late.resolve(contentResponse()); await h.settle();
  assert.equal(renderedImage(h).props.src, currentUrl); assert.equal(created.length, createdCount); assert.equal(h.updates.length, updates);
  assert.equal(contentCalls().length, 2); assert.equal(contentCalls()[1].url, `/api/v1/restaurants/${next.restaurant_id}/assets/${next.id}/content`);
});
test('Thumbnail：卸载后 fetch 成功迟到不创建 Image/URL、不 setState', async () => {
  const late = deferred(); responder = () => late.promise; const h = thumbnailHarness(); await h.settle();
  h.unmount(); const updates = h.updates.length; late.resolve(contentResponse()); await h.settle();
  assert.equal(calls[0].options.signal.aborted, true); assert.equal(images.length, 0); assert.equal(created.length, 0); assert.equal(h.updates.length, updates);
});
test('Thumbnail：解码中切图 abort 清 source，已捕获旧 onload 迟到不覆盖新图', async () => {
  responder = call => contentResponse(call.url.includes(BID) ? asset({ id: BID }) : asset());
  const h = thumbnailHarness(); await h.settle(); const oldImage = images[0], oldLoad = oldImage.onload, source = created[0].url;
  h.setProps({ asset: asset({ id: BID }) }); assert.equal(oldImage.src, ''); assert.ok(revoked.includes(source));
  await decode(h); const current = renderedImage(h).props.src, count = created.length, updates = h.updates.length;
  oldLoad(); await h.settle(); assert.equal(renderedImage(h).props.src, current); assert.equal(created.length, count); assert.equal(h.updates.length, updates);
});
for (const action of ['switch', 'unmount']) test(`Thumbnail：canvas.toBlob 待回包时 ${action}，旧编码迟到不建展示 URL`, async () => {
  canvasMode.deferred = true; responder = () => contentResponse(); const h = thumbnailHarness(); await decode(h);
  assert.equal(encodings.length, 1); assert.equal(liveUrls.size, 0, 'source 在编码前已释放');
  if (action === 'switch') h.setProps({ asset: asset({ revision: 2 }) }); else h.unmount();
  const updates = h.updates.length; encodings[0].callback(encodings[0].value); await h.settle();
  assert.equal(created.filter(item => item.blob.type === 'image/png').length, 0); assert.equal(h.updates.length, updates);
});
for (const failure of ['decode', 'dimensions', 'context', 'encoding']) test(`Thumbnail：${failure} 失败释放 source、不更改选择；点击 retry 真正重取成功`, async () => {
  responder = () => contentResponse(); const h = thumbnailHarness(); await h.settle();
  if (failure === 'decode') { images[0].onerror(); await h.settle(); }
  else {
    if (failure === 'context') canvasMode.context = false;
    if (failure === 'encoding') canvasMode.blob = false;
    await decode(h, failure === 'dimensions' ? 0 : 2048);
  }
  assert.equal(liveUrls.size, 0); assert.equal(h.elements(node => node.type === 'img').length, 0);
  const copy = text(documentOf(h.markup())); assert.ok(copy.includes('不代表 AI 已看图')); assert.ok(copy.includes('不更改已选素材'));
  assert.equal(h.button('重试缩略图').props.type, 'button'); await h.settle(); assert.equal(contentCalls().length, 1, '失败不自动重取');
  canvasMode.context = true; canvasMode.blob = true; h.click('重试缩略图'); await decode(h);
  assert.equal(contentCalls().length, 2); assert.equal(h.elements(node => node.type === 'img').length, 1);
});
for (const failure of ['403', 'mime', 'size']) test(`Thumbnail：真实 content transport ${failure} 失败不解码，手动 retry 使用原授权路径`, async () => {
  let count = 0; responder = () => ++count > 1 ? contentResponse() : failure === '403' ? rejection(403, 'ASSET_ACCESS_DENIED')
    : contentResponse(asset(), failure === 'size' ? 'BAD' : 'JPEG', 200, failure === 'mime' ? 'image/png' : 'image/jpeg');
  const h = thumbnailHarness(); await h.settle(); assert.equal(images.length, 0); assert.equal(created.length, 0);
  assert.equal(h.button('重试缩略图').props.disabled, undefined); h.click('重试缩略图'); await decode(h);
  assert.equal(contentCalls().length, 2); contentCalls().forEach(call => assert.equal(call.url, `${ASSETS}/${AID}/content`));
});
test('Thumbnail：展示 img.onerror 撤销失效 URL，retry 新图后旧 onError 不破坏新图', async () => {
  responder = () => contentResponse(); const h = thumbnailHarness(); await decode(h);
  const old = renderedImage(h), oldUrl = old.props.src; old.props.onError(); h.commit();
  assert.ok(revoked.includes(oldUrl)); assert.equal(liveUrls.size, 0); assert.equal(h.elements(node => node.type === 'img').length, 0);
  h.click('重试缩略图'); await decode(h); const current = renderedImage(h).props.src, updates = h.updates.length;
  old.props.onError(); h.commit(); assert.equal(renderedImage(h).props.src, current); assert.equal(h.updates.length, updates); assert.ok(liveUrls.has(current));
});
test('真实 React SSR 在 hook harness 后仍可渲染初始 WebsitePanel，不请求字节或恢复自动授权', async () => {
  responder = () => contentResponse(); const h = thumbnailHarness(); await decode(h); h.unmount();
  const before = calls.length;
  const html = renderToStaticMarkup(React.createElement(WebsitePanel, { restaurant: restaurant(), active: true, busy: false, restaurantDirty: false,
    onBusyChange() {}, onJobsChange() {}, onDirtyChange() {}, onRestaurantConflict() {} }));
  assert.equal(calls.length, before); const doc = documentOf(html);
  assert.equal(nodes(doc, node => node.tagName === 'input' && attr(node, 'checked') !== undefined).length, 0);
  assert.ok(text(doc).includes('No image sharing consent is requested'));
  for (const [name, hook] of Object.entries(originalHooks)) assert.equal(React[name], hook);
});

test('后端合法幂等键含点/冒号的legacy恢复仍exactunknown，不补图片授权或换target', async () => {
  const key = 'original.request:key-0001', input = body(); saveAttempt(input, key); panelResponses();
  const h = panelHarness(); await h.settle(); assert.equal(writes().length, 0);
  h.click('Check result / Retry same request'); await h.settle(); checkTransport(writes()[0], 'POST', input, key);
  assert.deepEqual(savedAttempt(), { kind: 'generate', key, body: input }); assert.equal(Object.hasOwn(JSON.parse(writes()[0].options.body), 'image_vision_confirmed'), false);
});
