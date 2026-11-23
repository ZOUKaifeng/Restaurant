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
  const modules = new Map();
  function compile(path) {
    if (modules.has(path)) return modules.get(path).exports;
    const isolated = new Module(path, require.cache[require.resolve('react')]);
    isolated.filename = path; isolated.paths = Module._nodeModulePaths(dirname(path)); modules.set(path, isolated);
    const localRequire = createRequire(path);
    isolated.require = name => {
      if (name === 'react') return stub;
      const dependency = localRequire.resolve(name);
      return filename === 'RestaurantWorkspace.tsx' && dependency === resolve(root, 'src/ui.tsx') ? compile(dependency) : localRequire(name);
    };
    isolated._compile(compiledSource(path), path);
    return isolated.exports;
  }
  return compile(resolve(root, 'src', filename)).default;
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

const HASH = 'a'.repeat(64), HASH2 = 'b'.repeat(64), VID2 = `wsv_${'n'.repeat(24)}`;
const client = () => load('website-content-client.ts');
function cv(overrides = {}) { return { ...version([]), checksum: HASH, source_status: 'available', origin: 'generation', base_version_id: null, public_content_hash: HASH, ...overrides }; }
function canonical(overrides = {}) {
  const r = restaurant({ primary_locale: 'en', timezone: 'UTC' });
  const keys = ['name','description','cuisine_label','country_code','region','city','address_line1','address_line2','postal_code','contact_email','phone','timezone','currency_code','primary_locale'];
  return { restaurant: Object.fromEntries(keys.map(key => [key, r[key]])), restaurant_revision: 7,
    opening_hours: [{ weekday: 1, opens_at_local: '09:00', closes_at_local: '17:00', closes_day_offset: 0, accepts_requests: true, sort_order: 4 }],
    menu: { revision: 3, status: 'confirmed', data: { categories: [{ name: 'Main', items: [{ name: 'Rice', description: null, price_text: '$12', review_note: '核对过敏原' }] }], warnings: ['原菜单价格须核对'] } }, ...overrides };
}
function wb(overrides = {}) { return { restaurant_id: RID, generated_at: NOW, publication: { revision: 0, published_version_id: null, slug: null, url: null, deployment_mode: 'local' }, published_version: null, editing_version: cv(), latest_version: cv(), content: canonical(), current_public_content_hash: HASH, differences: [], blockers: [], model_configured: false, ai_usage_mode: 'observation', ...overrides }; }
function input(overrides = {}) { return { base_version_id: VID, expected_restaurant_revision: 7, expected_menu_revision: 3, expected_public_content_hash: HASH, expected_publication_revision: 0, ...overrides }; }
function result(overrides = {}) { return { version: cv({ id: VID2, version_number: 2, checksum: HASH2, origin: 'content_refresh', base_version_id: VID, public_content_hash: HASH2 }), content: canonical({ restaurant_revision: 8, menu: { ...canonical().menu, revision: 4 } }), public_content_hash: HASH2, base_publication_revision: 0, differences: [{ field: 'menu', label: 'Menu', before: '$12', after: '$15' }], changed: true, ai_called: false, warnings: ['MENU_FILE_MAY_BE_OUTDATED'], ...overrides }; }
function workbenchHarness(overrides = {}) {
  const previews = [], reports = [], dirty = [], busy = [], saved = [], reviews = [];
  const h = hooksHarness('WebsiteWorkbench.tsx', { restaurantId: RID, active: true, busy: false, restaurantDirty: false, selectedId: null, refreshToken: '1', design: React.createElement('textarea', { defaultValue: 'Design preserved' }), preview: React.createElement('iframe', { src: 'data:text/html;charset=utf-8,test', sandbox: '', title: 'Saved preview' }), status: null, publication: null,
    onPreview: v => previews.push(v), onReport: r => reports.push(r), onSaved: c => saved.push(c), onContentReview: r => reviews.push(r), onDirtyChange: d => dirty.push(d), onBusyChange: b => busy.push(b), ...overrides });
  return Object.assign(h, { previews, reports, dirty, busy, saved, reviews });
}
function editor(h) { const e = h.elements(n => typeof n.type === 'function' && n.type.name === 'WebsiteContentPanel'); assert.equal(e.length, 1); return e[0]; }
function changeContent(h, run) { const e = editor(h), next = structuredClone(e.props.draft); run(next); e.props.onChange(next); h.commit(); }
function wbResponses(current = wb(), write = () => response(result()), more) {
  let saved = null;
  responder = async call => {
    if (call.url.startsWith(`${BASE}/workbench`)) {
      const value = structuredClone(typeof current === 'function' ? current(call) : current);
      if (saved) { value.content = saved.content; value.current_public_content_hash = saved.public_content_hash; value.latest_version = saved.version; }
      const id = new URL(call.url, 'http://localhost').searchParams.get('base_version_id');
      if (id && value.editing_version?.id !== id) value.editing_version = [value.published_version, value.latest_version, cv(), cv({ id: VID2, version_number: 2 })].find(v => v?.id === id);
      if (value.editing_version && (!value.latest_version || value.editing_version.version_number > value.latest_version.version_number)) value.latest_version = value.editing_version;
      return response(value);
    }
    if (call.url === `${BASE}/content-previews`) { const reply = await write(call); if (reply.ok) saved = await reply.clone().json(); return reply; }
    if (call.url.startsWith(`${BASE}/versions?`)) return response(more ?? { items: [cv()], has_more: false, next_cursor: null });
    throw new Error(`未配置接口 ${call.url}`);
  };
}

test('契约夹具与严格响应：无源码、无版本、跨店、未知键、false AI 与 hash/revision 枚举', () => {
  const c = client(); assert.deepEqual(c.readWorkbench(wb(), RID), wb());
  const empty = wb({ editing_version: null, latest_version: null, blockers: ['WEBSITE_BASE_REQUIRED'] }); assert.equal(c.readWorkbench(empty, RID).latest_version, null);
  const legacy = cv({ origin: 'legacy', source_status: 'missing', public_content_hash: null });
  assert.equal(c.readWorkbench(wb({ editing_version: legacy, latest_version: legacy, blockers: ['WEBSITE_SOURCE_MISSING'] }), RID).editing_version.public_content_hash, null);
  for (const mutate of [d => d.raw_html = '私有源码', d => d.restaurant_id = 'restaurant_other_000001', d => d.ai_usage_mode = 'paid', d => d.current_public_content_hash = 'bad', d => d.content.restaurant.note = '私有', d => d.content.restaurant_revision = -1, d => d.content.menu.data.categories[0].items[0].extra = '私有', d => d.publication.published_version_id = VID, d => d.editing_version.id = VID2]) {
    const d = wb(); mutate(d); assert.throws(() => c.readWorkbench(d, RID), apiError(502, 'RESPONSE_INVALID'));
  }
  for (const mutate of [d => d.ai_called = true, d => d.version.origin = 'generation', d => d.version.base_version_id = null, d => d.version.restaurant_id = 'restaurant_other_000001', d => d.public_content_hash = HASH, d => d.raw_source = '不可泄露']) { const d = result(); mutate(d); assert.throws(() => c.readContentResult(d, RID, input()), apiError(502, 'RESPONSE_INVALID')); }
  assert.equal(c.readContentResult(result({ changed: false, version: cv(), public_content_hash: HASH, content: canonical() }), RID, input()).changed, false);
  const notes = canonical(); notes.menu.data.categories[0].items[0].review_note = '新人工备注'; notes.menu.revision = 4;
  assert.equal(c.readContentResult(result({ changed: false, version: cv(), public_content_hash: HASH, content: notes }), RID, input()).content.menu.revision, 4);
});

test('真实组合 POST：价格与营业时间、原菜单备注警告保留，无 AI 请求、CSRF/同源', async () => {
  const c = client(), r = wb(), draft = load('WebsiteContentPanel.tsx').contentDraft(r.content);
  draft.menu.categories[0].items[0].price_text = '$15'; draft.opening_hours[0].closes_at_local = '19:00';
  const body = load('WebsiteWorkbench.tsx').contentChanges(r, draft, true);
  assert.equal(body.menu_data.categories[0].items[0].review_note, '核对过敏原'); assert.deepEqual(body.menu_data.warnings, ['原菜单价格须核对']);
  assert.equal(body.opening_hours[0].sort_order, 4); assert.equal(body.opening_hours[0].accepts_requests, true);
  wbResponses(); await c.websiteContentClient.savePreview(RID, body, KEY);
  assert.equal(writes().length, 1); checkTransport(writes()[0], 'POST', body);
  assert.equal(calls.some(c => /generations|messages|recognitions|model/.test(c.url)), false);
  for (const extra of [{ ai_consent: true }, { snapshot: {} }, { menu_review_confirmed: false }]) await assert.rejects(Promise.resolve().then(() => c.websiteContentClient.savePreview(RID, { ...body, ...extra }, KEY)), apiError(422, 'REQUEST_INVALID'));
  assert.equal(writes().length, 1);
});

test('请求冻结：等待 CSRF 时调用者修改输入不会改变 POST 原正文', async () => {
  const wait = deferred(); csrfResponder = () => wait.promise; wbResponses(); const body = input({ restaurant_patch: { name: 'Original' } });
  const frozen = structuredClone(body), promise = client().websiteContentClient.savePreview(RID, body, KEY);
  body.restaurant_patch.name = 'Changed'; body.base_version_id = VID2; wait.resolve(response({ csrf_token: CSRF }));
  await promise; checkTransport(writes()[0], 'POST', frozen);
});

test('真实 Content UI 输入：共享 workbench callback，价格与小时一次保存并自动 preview', async () => {
  wbResponses(); const h = workbenchHarness(); await h.settle();
  let e = editor(h); let child = hooksHarness('WebsiteContentPanel.tsx', e.props);
  child.change('wb-price-0-0', '$15'); await h.settle(); e = editor(h); child.setProps(e.props);
  child.change('wb-closes-0', '19:00'); await h.settle(); e = editor(h); child.setProps(e.props);
  child.check('I have checked this menu'); await h.settle(); child.setProps(editor(h).props);
  const form = child.elements(n => n.type === 'form')[0]; form.props.onSubmit({ preventDefault() {} }); h.commit(); await h.settle(); await h.settle();
  const body = JSON.parse(writes()[0].options.body); assert.equal(body.menu_data.categories[0].items[0].price_text, '$15'); assert.equal(body.opening_hours[0].closes_at_local, '19:00');
  assert.equal(h.previews.at(-1).id, VID2); assert.equal(h.saved.length, 1); assert.ok(h.text().includes('original menu image / PDF was not changed'));
});

test('未知保存不自动重放：冻结 base、键、正文；手动 Retry 先 GET，不随后续选择换请求', async () => {
  wbResponses(wb(), () => Promise.reject(new TypeError('结果未知'))); const h = workbenchHarness(); await h.settle();
  changeContent(h, d => { d.restaurant.name = 'Changed'; }); const save = editor(h).props.onSave; save(); save(); h.commit(); await h.settle();
  assert.equal(writes().length, 1); const original = writes()[0], body = JSON.parse(original.options.body), key = original.options.headers.get('Idempotency-Key');
  assert.equal(editor(h).props.disabled, true); await h.settle(); assert.equal(writes().length, 1);
  h.setProps({ selectedId: VID2 }); await h.settle(); const start = calls.length;
  h.click('Check result / Retry same request'); await h.settle(); assert.ok(calls[start].url.includes(`/workbench?base_version_id=${VID}`));
  assert.equal(writes().length, 2); checkTransport(writes()[1], 'POST', body, key); assert.equal(storage.size, 0);
});

test('写入已确认、同步 GET 失败不变未知、不重复 POST', async () => {
  wbResponses(); const h = workbenchHarness({ onSaved: async () => { throw new transport.ApiError(0, 'NETWORK_ERROR'); } }); await h.settle();
  editor(h).props.onSave(); h.commit(); await h.settle(); assert.equal(writes().length, 1);
  assert.ok(h.text().includes('Content was saved')); assert.equal(h.elements(n => n.type === 'button' && content(n) === 'Check result / Retry same request').length, 0);
});

test('父级脏稿不覆盖、不允写；模型未配置不锁 Content；缺源码仅锁 Content', async () => {
  wbResponses(); const h = workbenchHarness({ restaurantDirty: true }); await h.settle(); assert.equal(h.elements(n => typeof n.type === 'function' && n.type.name === 'WebsiteContentPanel').length, 0);
  assert.ok(h.text().includes('will not overwrite that draft'));
  h.setProps({ restaurantDirty: false }); assert.equal(editor(h).props.disabled, false);
  const missing = cv({ source_status: 'missing', origin: 'legacy', public_content_hash: null });
  wbResponses(wb({ editing_version: missing, latest_version: missing, blockers: ['WEBSITE_SOURCE_MISSING'] }));
  h.setProps({ refreshToken: '2' }); await h.settle(); assert.equal(editor(h).props.disabled, true); h.click('AI design'); assert.ok(h.markup().includes('Design preserved'));
});

test('后续 GET canonical 变化不覆盖未保存稿；base 选择不会漂移为 latest', async () => {
  let current = wb(); wbResponses(() => current); const h = workbenchHarness(); await h.settle(); changeContent(h, d => { d.restaurant.name = 'Unsaved'; });
  current = wb({ content: canonical({ restaurant_revision: 9 }) }); h.setProps({ refreshToken: '2' }); await h.settle();
  assert.equal(editor(h).props.draft.restaurant.name, 'Unsaved'); assert.equal(editor(h).props.disabled, true);
  assert.ok(calls.at(-1).url.includes(`base_version_id=${VID}`));
});

test('active=false 与会话 epoch：迟到 GET/POST 不 apply，不显示旧私有内容，不 replay', async () => {
  const late = deferred(); wbResponses(wb(), () => late.promise); const h = workbenchHarness(); await h.settle();
  editor(h).props.onSave(); h.commit(); await h.settle(); const call = writes()[0];
  h.setProps({ active: false }); assert.equal(call.options.signal.aborted, true); late.resolve(response(result())); await h.settle(); assert.equal(h.saved.length, 0);
  transport.notifySessionExpired(); h.commit(); assert.equal(h.text().includes('Rice'), false); assert.equal(h.text().includes('Session expired'), true); assert.equal(writes().length, 1);
});

test('跨餐厅迟到读取不会覆盖新餐厅报告', async () => {
  const late = deferred(); const RID2 = 'restaurant_fixture_000002';
  responder = call => call.url.startsWith(BASE) ? late.promise : response({ ...wb(), restaurant_id: RID2, editing_version: null, latest_version: null, blockers: ['WEBSITE_BASE_REQUIRED'] });
  const h = workbenchHarness(); await h.settle(); h.setProps({ restaurantId: RID2 }); await h.settle(); late.resolve(response(wb())); await h.settle();
  assert.equal(h.reports.at(-1).restaurant_id, RID2); assert.equal(h.previews.length, 0);
});

test('桌面 / 移动原生按钮只隐藏列；iframe 和编辑文本节点保持，SSR 不泄露 source', async () => {
  wbResponses(); const h = workbenchHarness(); await h.settle(); const frame = h.elements(n => n.type === 'iframe')[0];
  h.click('Preview'); assert.equal(h.elements(n => n.type === 'iframe')[0], frame); h.click('Editor'); assert.equal(h.elements(n => n.type === 'iframe')[0], frame);
  changeContent(h, d => { d.restaurant.name = 'Preserved draft'; });
  h.click('AI design'); assert.ok(h.markup().includes('Design preserved')); assert.equal(h.elements(n => typeof n.type === 'function' && n.type.name === 'WebsiteContentPanel').length, 0);
  h.click('Content'); assert.equal(h.markup().includes('Design preserved'), false); assert.equal(editor(h).props.draft.restaurant.name, 'Preserved draft');
  const doc = documentOf(h.markup()); const buttons = nodes(doc, n => n.tagName === 'button' && ['Editor','Preview'].includes(text(n)));
  assert.equal(buttons.length, 2); buttons.forEach(n => assert.equal(attr(n, 'type'), 'button'));
  assert.ok(readFileSync(resolve(root, 'src/website-workbench.css'), 'utf8').includes('[data-mobile-view="preview"] > .wb-editor'));
});

test('分页历史严格 cursor 与按 ID 读 metadata，不以20条 latest 回退', async () => {
  const cursor = `opaque_cursor.${'s'.repeat(43)}`, c = client().websiteContentClient;
  wbResponses(wb(), undefined, { items: [cv()], has_more: true, next_cursor: cursor });
  const first = await c.versions(RID); assert.equal(first.next_cursor, cursor); checkTransport(calls.at(-1), 'GET');
  responder = call => call.url.includes('cursor=') ? response({ items: [cv({ id: VID2, version_number: 1 })], has_more: false, next_cursor: null }) : response(cv({ id: VID2 }));
  assert.equal((await c.version(RID, VID2)).id, VID2); assert.equal(calls.at(-1).url, `${BASE}/versions/${VID2}`);
  await c.versions(RID, cursor); assert.ok(calls.at(-1).url.includes('limit=20')); assert.ok(calls.at(-1).url.includes('cursor='));
});

test('generation真实受理→成功轮询自动 GET preview，不手动选版本', async () => {
  let current = state({ publication: wb().publication });
  panelResponses({ items: [], current: () => current, write: () => { current = { ...current, jobs: [{ id: JID, kind: 'generate', status: 'running', error_code: null, result_version_id: null, created_at: NOW }] }; return response({ job_id: JID, status: 'queued' }, 202); }, extra: call => {
    if (call.url === `${BASE}/versions/${VID}/preview`) return response({ html: '<!doctype html><html><head><title>Saved</title></head><body>Saved real preview</body></html>', checksum: HASH, assets: [] });
    throw new Error(`未配置接口 ${call.url}`);
  } });
  const h = panelHarness(); await h.settle(); h.check(FACTS); h.click(GENERATE); await h.settle(); await h.settle();
  current = { ...current, versions: [cv()], jobs: [{ ...current.jobs[0], status: 'succeeded', result_version_id: VID }] };
  const timer = [...timers.values()].find(t => t.ms === 2000); assert.ok(timer); timer.fn(); await h.settle(); await h.settle(); await h.settle();
  assert.equal(calls.filter(c => c.url === `${BASE}/versions/${VID}/preview`).length, 1);
  const iframe = h.elements(n => n.type === 'iframe')[0]; assert.ok(iframe); assert.equal(iframe.key, VID); const before = iframe.props.src;
  h.click('Mobile'); assert.equal(h.elements(n => n.type === 'iframe')[0].props.src, before); assert.equal(h.elements(n => n.type === 'iframe')[0].key, VID);
  assert.equal(writes().length, 1); assert.equal(iframe.props.sandbox.includes('allow-scripts'), false); assert.ok(decodeURIComponent(before).includes("connect-src 'none'"));
});

test('未知发布目标锁定 enhanced字段：恢复/重试保留 hash checksum current 原revision，不跟预览变', async () => {
  const body = { version_id: VID, expected_revision: 0, expected_checksum: HASH, expected_public_content_hash: HASH, content_mode: 'current', review_confirmed: true, slug: 'fixture-dining' };
  storage.set(STORAGE, JSON.stringify({ kind: 'publish', key: KEY, body })); panelResponses({ items: [], current: state({ versions: [cv()], publication: wb().publication }), extra: call => {
    if (call.url === `${BASE}/versions/${VID}`) return response(cv());
    if (call.url === `${BASE}/versions/${VID2}`) return response(cv({ id: VID2, version_number: 2 }));
    if (call.url.endsWith('/preview')) return response({ html: '<html><head><title>Saved</title></head><body>Saved</body></html>', checksum: HASH, assets: [] });
    if (call.url.endsWith('/publication')) return Promise.reject(new TypeError('未知发布'));
    throw new Error(`未配置接口 ${call.url}`);
  } });
  const h = panelHarness(); await h.settle(); await h.settle();
  const wbElement = h.tree; wbElement.props.onPreview(cv({ id: VID2 })); h.commit(); await h.settle();
  h.click('Check result / Retry same request'); await h.settle(); checkTransport(writes()[0], 'POST', body, KEY);
  assert.equal(savedAttempt().body.version_id, VID); assert.equal(savedAttempt().body.content_mode, 'current');
});

test('真实 Publish review→Confirm：发送 current hash/checksum，回执后的 GET失败不重放', async () => {
  let acked = false;
  panelResponses({ items: [], current: state({ versions: [cv()], publication: wb().publication }), extra: call => {
    if (call.url === `${BASE}/workbench?base_version_id=${VID}`) return response(wb());
    if (call.url.endsWith('/preview')) return response({ html: '<html><head></head><body>Saved</body></html>', checksum: HASH, assets: [] });
    if (call.url.endsWith('/publication')) { acked = true; return response({ ...wb().publication, published_version_id: VID, revision: 1, slug: 'fixture-dining', url: 'http://localhost:3000/s/fixture-dining' }); }
    throw new Error(`未配置接口 ${call.url}`);
  } });
  const currentResponder = responder; responder = call => acked && call.url === BASE ? Promise.reject(new TypeError('读取失败')) : currentResponder(call);
  const h = panelHarness(); await h.settle(); h.tree.props.onPreview(cv()); h.commit(); await h.settle(); await h.settle();
  h.click('Publish preview v1'); await h.settle(); h.change('-slug', 'fixture-dining'); h.click('Confirm publish'); await h.settle();
  assert.equal(writes().length, 1); const body = JSON.parse(writes()[0].options.body);
  assert.deepEqual(body, { version_id: VID, expected_revision: 0, expected_checksum: HASH, expected_public_content_hash: HASH, content_mode: 'current', review_confirmed: true, slug: 'fixture-dining' });
  assert.equal(savedAttempt(), null); assert.ok(content(h.tree.props.status).includes('current state read failed'));
  assert.equal(h.elements(n => n.type === 'button' && content(n) === 'Check result / Retry same request').length, 0);
});

test('人工核对菜单与营业段添加删除边界：不丢原备注警告，稳定分配sort_order', () => {
  const data = load('WebsiteContentPanel.tsx').contentDraft(canonical()), edits = [];
  const h = hooksHarness('WebsiteContentPanel.tsx', { draft: data, disabled: false, menuReview: false, menuNeedsReview: false, onChange: d => edits.push(d), onMenuReview() {}, onSave() {}, onDiscard() {}, dirty: false, saving: false });
  h.click('Add hours'); let next = edits.at(-1); assert.equal(next.opening_hours[1].sort_order, 0); assert.equal(next.opening_hours[0].sort_order, 4); assert.equal(next.opening_hours[0].accepts_requests, true);
  h.setProps({ draft: next }); h.click('Add item'); next = edits.at(-1); assert.equal(next.menu.categories[0].items[0].review_note, '核对过敏原'); assert.deepEqual(next.menu.warnings, ['原菜单价格须核对']);
  const bounded = structuredClone(next); bounded.menu.categories[0].items = Array.from({ length: 80 }, () => ({ name: 'Item', description: null, price_text: '$1', review_note: null }));
  h.setProps({ draft: bounded }); assert.equal(h.button('Add item').props.disabled, true); assert.equal(h.button('Add category').props.disabled, true);
});

test('server422字段错误可编辑清除；模型忙仍可只读 Content/History', async () => {
  wbResponses(wb(), () => response({ code: 'MENU_DATA_INVALID', details: [{ field: '/menu_data', code: 'INVALID' }] }, 422));
  const h = workbenchHarness(); await h.settle(); editor(h).props.onSave(); h.commit(); await h.settle(); assert.equal(editor(h).props.disabled, false);
  changeContent(h, d => { d.restaurant.name = 'Corrected'; }); assert.equal(h.text().includes('Check the fields'), false);
  wbResponses(wb({ blockers: ['WEBSITE_JOB_BUSY'] })); h.setProps({ refreshToken: '2' }); await h.settle(); assert.equal(editor(h).props.disabled, true);
  h.click('History'); await h.settle(); assert.ok(h.text().includes('Version history')); assert.equal(writes().length, 1);
});

test('初始真实 preview 优先 published，即使不在旧20条版本列表内；标题标示实际preview.id/version', async () => {
  const published = cv(), latest = cv({ id: VID2, version_number: 22 });
  const publication = { revision: 5, published_version_id: VID, slug: 'fixture-dining', url: 'http://localhost:3000/s/fixture-dining', deployment_mode: 'local' };
  panelResponses({ items: [], current: state({ versions: [latest], publication }), extra: call => {
    if (call.url === `${BASE}/versions/${VID}`) return response(published);
    if (call.url === `${BASE}/versions/${VID}/preview`) return response({ html: '<html><head></head><body>Published real content</body></html>', checksum: HASH, assets: [] });
    throw new Error(`未配置接口 ${call.url}`);
  } });
  const h = panelHarness(); await h.settle(); await h.settle(); await h.settle();
  assert.equal(h.tree.props.selectedId, VID); assert.deepEqual(h.tree.props.previewVersion, { id: VID, version_number: 1 });
  assert.ok(content(h.tree.props.preview).includes('Preview v1 · Published')); assert.equal(writes().length, 0);
  wbResponses(wb({ publication, published_version: published, editing_version: published, latest_version: latest }));
  const w = workbenchHarness({ previewVersion: h.tree.props.previewVersion }); await w.settle();
  assert.equal(w.previews[0].id, VID); assert.ok(w.text().includes('Preview · v1 · Published')); assert.ok(w.text().includes(`Preview ID: ${VID}`));
  assert.equal(w.text().includes('Current draft'), false); assert.equal(calls.some(c => c.url === `${BASE}/versions/${VID2}/preview`), false);
});

test('保存阻断旧读取回流：新base固定，callback更新refresh时不选回旧版', async () => {
  const write = deferred(); wbResponses(wb(), () => write.promise);
  const h = workbenchHarness({ selectedId: VID }); await h.settle();
  changeContent(h, d => { d.restaurant.name = 'Saved new name'; }); editor(h).props.onSave(); h.commit(); await h.settle();
  const before = calls.filter(c => c.url.includes('/workbench')).length;
  h.setProps({ refreshToken: 'callback-while-saving' }); await h.settle();
  assert.equal(calls.filter(c => c.url.includes('/workbench')).length, before);
  const saved = result({ content: canonical({ restaurant: { ...canonical().restaurant, name: 'Saved new name' }, restaurant_revision: 8 }) });
  write.resolve(response(saved)); await h.settle(); await h.settle(); await h.settle();
  assert.equal(h.previews.at(-1).id, VID2); assert.equal(editor(h).props.draft.restaurant.name, 'Saved new name');
  assert.ok(calls.at(-1).url.includes(`base_version_id=${VID2}`)); assert.equal(editor(h).props.disabled, false); assert.equal(writes().length, 1);
});

test('同会话active停用再恢复：迟到POST不应用，原key/body保留，Retry不失联且不换targets', async () => {
  const late = deferred(); let first = true;
  wbResponses(wb(), () => first ? (first = false, late.promise) : response(result()));
  const h = workbenchHarness(); await h.settle(); changeContent(h, d => { d.restaurant.name = 'Frozen original'; });
  editor(h).props.onSave(); h.commit(); await h.settle(); const original = writes()[0], originalBody = JSON.parse(original.options.body), key = original.options.headers.get('Idempotency-Key');
  h.setProps({ active: false }); assert.equal(original.options.signal.aborted, true);
  late.resolve(response(result())); await h.settle(); assert.equal(h.saved.length, 0);
  h.setProps({ active: true, selectedId: VID2 }); await h.settle(); await h.settle();
  assert.equal(writes().length, 1); assert.equal(editor(h).props.draft.restaurant.name, 'Frozen original');
  h.click('Check result / Retry same request'); await h.settle(); await h.settle(); await h.settle();
  assert.equal(writes().length, 2); checkTransport(writes()[1], 'POST', originalBody, key); assert.equal(h.saved.length, 1); assert.equal(storage.size, 0);
});

test('正在读取的迟到canonical不能覆盖同一事件中的用户脏稿', async () => {
  let late = null; wbResponses(() => wb()); const existing = responder;
  responder = call => late && call.url.includes('/workbench') ? late.promise : existing(call);
  const h = workbenchHarness(); await h.settle(); const originalHandler = editor(h).props.onChange;
  const next = structuredClone(editor(h).props.draft); next.restaurant.name = 'User input before commit'; originalHandler(next);
  late = deferred(); h.setProps({ refreshToken: 'new-read' });
  late.resolve(response(wb({ content: canonical({ restaurant_revision: 9 }) }))); await h.settle();
  assert.equal(editor(h).props.draft.restaurant.name, 'User input before commit'); assert.equal(editor(h).props.disabled, true); assert.equal(writes().length, 0);
});

test('已有draft菜单即使只改资料也必须人工confirmedmanual，原warnings/review_note不丢', async () => {
  const current = wb({ content: canonical({ menu: { ...canonical().menu, status: 'draft' } }), blockers: ['MENU_UNCONFIRMED'] });
  wbResponses(current); const h = workbenchHarness(); await h.settle();
  assert.equal(editor(h).props.menuNeedsReview, true); changeContent(h, d => { d.restaurant.name = 'Profile only'; });
  editor(h).props.onSave(); h.commit(); await h.settle(); assert.equal(writes().length, 0);
  editor(h).props.onMenuReview(true); h.commit(); editor(h).props.onSave(); h.commit(); await h.settle();
  const body = JSON.parse(writes()[0].options.body); assert.equal(body.menu_review_confirmed, true);
  assert.deepEqual(body.menu_data, current.content.menu.data); assert.equal(body.restaurant_patch.name, 'Profile only');
  assert.equal(body.menu_data.categories[0].items[0].review_note, '核对过敏原'); assert.deepEqual(body.menu_data.warnings, ['原菜单价格须核对']);
});

test('分类summary默认折叠，80菜品不铺长页，菜单人工备注仍在原始draft', () => {
  const d = load('WebsiteContentPanel.tsx').contentDraft(canonical());
  d.menu.categories[0].items = Array.from({ length: 80 }, (_, i) => ({ name: `Dish ${i}`, description: null, price_text: '$10', review_note: 'Keep note' }));
  const html = renderToStaticMarkup(React.createElement(load('WebsiteContentPanel.tsx').default, { draft: d, onChange() {}, disabled: false, menuReview: false, onMenuReview() {}, menuNeedsReview: false, onSave() {}, onDiscard() {}, dirty: false, saving: false }));
  const doc = documentOf(html), details = nodes(doc, n => n.tagName === 'details');
  assert.equal(details.filter(n => (attr(n, 'class') ?? '').includes('wb-menu-category')).length, 1);
  assert.equal(details.filter(n => attr(n, 'class') === 'wb-menu-item').length, 80);
  details.forEach(n => assert.equal(attr(n, 'open'), undefined)); assert.ok(text(doc).includes('Click a category to edit')); assert.equal(d.menu.categories[0].items[0].review_note, 'Keep note');
});

function workspaceHarness() {
  const busy = [], dirty = [], updated = [];
  const h = hooksHarness('RestaurantWorkspace.tsx', { id: RID, locales: ['en', 'zh-CN'], active: true, busy: false, onBusyChange: b => busy.push(b), onDirtyChange: d => dirty.push(d), onUpdated: r => updated.push(r) });
  return Object.assign(h, { busy, dirty, updated });
}
function workspaceResponses({ read = restaurant({ timezone: 'UTC' }), hours = canonical().opening_hours, extra } = {}) {
  responder = call => {
    const r = typeof read === 'function' ? read() : read, etag = `\"restaurant-${RID}-v${r.revision}\"`;
    if (call.url === `/api/v1/restaurants/${RID}`) return response(r, 200, { ETag: etag });
    if (call.url === `/api/v1/restaurants/${RID}/opening-hours`) return response({ restaurant_id: RID, restaurant_revision: r.revision, timezone: r.timezone, intervals: hours }, 200, { ETag: etag });
    if (extra) return extra(call);
    throw new Error(`未配置接口 ${call.url}`);
  };
}
function workspaceWebsite(h) { const matches = h.elements(n => typeof n.type === 'function' && n.type.name === 'WebsitePanel'); assert.equal(matches.length, 1); return matches[0]; }

test('真实Parent互斥owner：Website脏稿期间不渲染旧profile/hour，仍能返回原owner且不向DB写', async () => {
  workspaceResponses(); const h = workspaceHarness(); await h.settle(); await h.settle(); h.click('Website');
  let panel = workspaceWebsite(h); panel.props.onContentDirtyChange(true); panel.props.onDirtyChange(true); h.commit();
  h.click('餐厅资料'); assert.equal(h.elements(n => n.type === 'form').length, 0); assert.equal(workspaceWebsite(h).props.active, false);
  h.click('周营业时间'); assert.equal(h.elements(n => n.type === 'form').length, 0);
  h.click('Website · Unsaved'); assert.equal(workspaceWebsite(h).props.active, true);
  panel = workspaceWebsite(h); panel.props.onContentDirtyChange(false); panel.props.onDirtyChange(false); h.commit(); h.click('餐厅资料');
  assert.equal(h.elements(n => n.type === 'form').length, 1); assert.equal(writes().length, 0);
});

test('真实Parent canonical同步只读最新资料、不用历史回执回写；另一owner脏稿被保护', async () => {
  let current = restaurant({ revision: 7, timezone: 'UTC' }); workspaceResponses({ read: () => current });
  const h = workspaceHarness(); await h.settle(); await h.settle();
  h.change('profile-name', 'Other owner unsaved'); h.click('Website');
  await assert.rejects(workspaceWebsite(h).props.onContentSaved(canonical()), apiError(412, 'REVISION_CONFLICT')); h.commit();
  h.click('餐厅资料 · 未保存'); assert.equal(h.elements(n => n.props.id === 'profile-name')[0].props.value, 'Other owner unsaved');
  h.click('查看刷新确认'); h.click('确认刷新并放弃未保存内容'); await h.settle(); await h.settle(); h.click('Website');
  current = restaurant({ name: 'Newer real restaurant', revision: 10, timezone: 'UTC' });
  await workspaceWebsite(h).props.onContentSaved(canonical({ restaurant_revision: 8 })); h.commit();
  assert.equal(h.updated.at(-1).name, 'Newer real restaurant'); assert.equal(h.updated.at(-1).revision, 10); assert.equal(writes().length, 0);
});

test('Content401缺省认证头仍清私有内容与原请求，不把会话失效变成可重放未知态', async () => {
  wbResponses(wb(), () => rejection(401, 'UNAUTHENTICATED')); const h = workbenchHarness(); await h.settle();
  changeContent(h, d => { d.restaurant.name = 'Private input'; }); editor(h).props.onSave(); h.commit(); await h.settle();
  assert.ok(h.text().includes('Session expired')); assert.equal(h.markup().includes('Private input'), false);
  assert.equal(h.elements(n => n.type === 'button' && content(n) === 'Check result / Retry same request').length, 0); assert.equal(writes().length, 1);
});

test('来源missing后仍可放弃脏稿：写入锁不锁死Discard，不让父级profile/hour/menu永久失联', async () => {
  let current = wb(); wbResponses(() => current); const h = workbenchHarness(); await h.settle();
  changeContent(h, d => { d.restaurant.name = 'Local unsaved'; });
  const missing = cv({ source_status: 'missing' }); current = wb({ editing_version: missing, latest_version: missing, blockers: ['WEBSITE_SOURCE_MISSING'] });
  h.setProps({ refreshToken: 'source-removed' }); await h.settle(); const child = hooksHarness('WebsiteContentPanel.tsx', editor(h).props);
  assert.equal(child.button('Save & preview').props.disabled, true); assert.equal(child.button('Discard changes').props.disabled, false);
  const discard = child.button('Discard changes'); assert.equal(child.elements(n => n.type === 'fieldset').some(n => collect(n, x => x === discard).length), false);
  child.click('Discard changes'); h.commit(); await h.settle(); assert.equal(h.dirty.at(-1), false); assert.equal(writes().length, 0);
});

for (const unknown of [false, true]) test(`原AI停止流程${unknown ? '结果未知仅手动核查' : '真实受理后读终态'}：不改job target、不自动重发/重启/发布`, async () => {
  let current = state({ jobs: [{ id: JID, kind: 'generate', status: 'running', error_code: null, result_version_id: null, created_at: NOW }] });
  panelResponses({ items: [], current: () => current, extra: call => {
    if (call.url === `${BASE}/jobs/${JID}/cancel`) {
      if (unknown) return Promise.reject(new TypeError('stop unknown'));
      current = { ...current, jobs: [{ ...current.jobs[0], status: 'failed', error_code: 'AGENT_CANCELLED' }] };
      return response({ job_id: JID, status: 'failed' });
    }
    throw new Error(`未配置接口 ${call.url}`);
  } });
  const h = panelHarness(); await h.settle(); h.click('Stop generation'); h.click('Confirm stop'); await h.settle(); await h.settle();
  assert.equal(writes().length, 1); assert.equal(writes()[0].url, `${BASE}/jobs/${JID}/cancel`); assert.deepEqual(JSON.parse(writes()[0].options.body), { confirmed: true });
  if (unknown) { assert.ok(content(h.tree.props.status).includes('Stop result unknown')); h.click('Check website status'); await h.settle(); }
  else assert.ok(h.markup().includes('Generation failed'));
  assert.equal(writes().length, 1); assert.equal(calls.some(c => /\/generations$|\/publication$/.test(c.url)), false);
});

function priceSave() {
  const before = canonical(); before.menu.data.categories[0].items[0].price_text = '$18';
  const after = structuredClone(before); after.restaurant_revision = 8; after.menu.revision = 4;
  after.menu.data.categories[0].items[0].price_text = '$20'; after.opening_hours[0].closes_at_local = '19:00';
  const differences = [{ field: 'menu', label: '菜单', before: 'Rice: $18', after: 'Rice: $20' }, { field: 'hours', label: '营业时间', before: 'Monday 09:00–17:00', after: 'Monday 09:00–19:00' }];
  return { initial: wb({ content: before }), saved: result({ content: after, differences }) };
}
async function savePrice(h) {
  changeContent(h, d => { d.menu.categories[0].items[0].price_text = '$20'; d.opening_hours[0].closes_at_local = '19:00'; });
  editor(h).props.onMenuReview(true); h.commit(); editor(h).props.onSave(); h.commit();
  await h.settle(); await h.settle(); await h.settle();
}
function visibleSaveReview(h) {
  return h.elements(n => typeof n.type === 'function' && n.type.name === 'WebsiteContentReviewPanel');
}

test('成功候选18→20和营业变化在reload零差异后仍显示英文Before/After、Design unchanged / No AI', async () => {
  const f = priceSave(); wbResponses(f.initial, () => response(f.saved));
  const h = workbenchHarness({ selectedId: VID }); await h.settle(); await savePrice(h);
  h.setProps({ selectedId: VID2, previewVersion: { id: VID2, version_number: 2 } }); await h.settle();
  assert.deepEqual(h.reports.at(-1).differences, []); assert.ok(calls.at(-1).url.includes(`base_version_id=${VID2}`));
  const review = visibleSaveReview(h)[0].props.review; assert.deepEqual(review.differences, f.saved.differences);
  const doc = documentOf(h.markup()), section = nodes(doc, n => attr(n, 'data-candidate-id') === VID2)[0];
  assert.ok(section); const view = text(section);
  for (const value of ['Content changes', 'Design unchanged / No AI', 'Menu', 'Opening hours', 'Before', 'After', 'Rice: $18', 'Rice: $20', '09:00–17:00', '09:00–19:00', VID, VID2]) assert.ok(view.includes(value), value);
  assert.equal(view.includes('营业时间'), false); assert.equal(storage.size, 0); assert.equal(writes().length, 1);
  h.click('Check result'); await h.settle(); assert.deepEqual(visibleSaveReview(h)[0].props.review, review);
  h.click('AI design'); assert.equal(h.button('AI design').props['aria-pressed'], true); assert.deepEqual(visibleSaveReview(h)[0].props.review, review);
});

test('差异仅属于候选/previewID：旧预览不显示，切其它版本清空，返回候选不伪造上次回执', async () => {
  const f = priceSave(); wbResponses(f.initial, () => response(f.saved)); const h = workbenchHarness({ selectedId: VID });
  await h.settle(); await savePrice(h); assert.equal(visibleSaveReview(h).length, 0);
  h.setProps({ selectedId: VID2, previewVersion: { id: VID, version_number: 1 } }); await h.settle(); assert.equal(visibleSaveReview(h).length, 0);
  h.setProps({ previewVersion: { id: VID2, version_number: 2 } }); assert.equal(visibleSaveReview(h).length, 1);
  h.setProps({ selectedId: VID, previewVersion: { id: VID2, version_number: 2 } }); await h.settle(); assert.equal(visibleSaveReview(h).length, 0); assert.equal(h.reviews.at(-1), null);
  h.setProps({ selectedId: VID2, previewVersion: { id: VID2, version_number: 2 } }); await h.settle(); assert.equal(visibleSaveReview(h).length, 0);
});

test('已发布候选清scope，changed=false不从旧回执或报告制造新changes', async () => {
  const f = priceSave(); let next = f.saved; wbResponses(f.initial, () => response(next));
  const h = workbenchHarness({ selectedId: VID }); await h.settle(); await savePrice(h);
  h.setProps({ selectedId: VID2, previewVersion: { id: VID2, version_number: 2 } }); await h.settle(); assert.equal(visibleSaveReview(h).length, 1);
  next = { ...f.saved, changed: false }; editor(h).props.onSave(); h.commit(); await h.settle(); await h.settle();
  assert.equal(visibleSaveReview(h).length, 0); assert.equal(h.reviews.at(-1), null); assert.ok(h.text().includes('no new website version was created'));
  wbResponses(f.initial, () => response(f.saved)); h.setProps({ selectedId: VID, refreshToken: 'again' }); await h.settle(); await savePrice(h);
  h.setProps({ selectedId: VID2 }); await h.settle(); assert.equal(visibleSaveReview(h).length, 1);
  const publication = { revision: 1, published_version_id: VID2, slug: 'fixture-dining', url: 'http://localhost:3000/s/fixture-dining', deployment_mode: 'local' };
  wbResponses(wb({ publication, published_version: f.saved.version, editing_version: f.saved.version, latest_version: f.saved.version, content: f.saved.content, current_public_content_hash: HASH2 }));
  h.setProps({ refreshToken: 'published' }); await h.settle(); assert.equal(visibleSaveReview(h).length, 0); assert.equal(h.reviews.at(-1), null);
});

test('未保存编辑、current report待同步差异与成功候选回执分开，不用新hash覆盖18→20', async () => {
  const f = priceSave(); let current = f.initial; wbResponses(() => current, () => response(f.saved));
  const h = workbenchHarness({ selectedId: VID }); await h.settle(); await savePrice(h);
  h.setProps({ selectedId: VID2, previewVersion: { id: VID2, version_number: 2 } }); await h.settle();
  changeContent(h, d => { d.restaurant.name = 'Unsaved new name'; });
  current = { ...f.initial, differences: [{ field: 'contact', label: '联系', before: 'Old phone', after: 'New saved phone' }] };
  h.setProps({ refreshToken: 'new-canonical' }); await h.settle();
  assert.ok(h.text().includes('Unsaved edits are not included')); assert.ok(h.text().includes('Saved facts not in this preview'));
  assert.deepEqual(visibleSaveReview(h)[0].props.review.differences, f.saved.differences);
  const doc = documentOf(h.markup()), saveSection = nodes(doc, n => attr(n, 'data-candidate-id') === VID2)[0];
  assert.equal(text(saveSection).includes('New saved phone'), false); assert.equal(text(saveSection).includes('Unsaved new name'), false);
});

test('unknown不造保存差异，迟到旧GET不能覆盖成功回执，session清私有差异与callback', async () => {
  const f = priceSave(), late = deferred(); let fail = false;
  wbResponses(f.initial, () => fail ? Promise.reject(new TypeError('unknown')) : response(f.saved));
  const original = responder; let pauseRead = false;
  responder = call => pauseRead && call.url.includes('/workbench') ? late.promise : original(call);
  const h = workbenchHarness({ selectedId: VID }); await h.settle();
  changeContent(h, d => { d.menu.categories[0].items[0].price_text = '$20'; d.opening_hours[0].closes_at_local = '19:00'; });
  editor(h).props.onMenuReview(true); h.commit(); const oldSave = editor(h).props.onSave;
  pauseRead = true; h.click('Check result'); const pendingRead = calls.at(-1);
  pauseRead = false; oldSave(); h.commit(); await h.settle(); await h.settle(); await h.settle();
  assert.equal(writes().length, 1); assert.equal(pendingRead.options.signal.aborted, true);
  h.setProps({ selectedId: VID2, previewVersion: { id: VID2, version_number: 2 } }); await h.settle();
  late.resolve(response(f.initial)); await h.settle();
  assert.deepEqual(visibleSaveReview(h)[0].props.review.differences, f.saved.differences);
  fail = true; changeContent(h, d => { d.restaurant.name = 'Unknown private save'; }); editor(h).props.onSave(); h.commit(); await h.settle();
  assert.equal(visibleSaveReview(h).length, 0); assert.equal(h.reviews.at(-1), null); assert.ok(h.text().includes('Save result unknown')); assert.equal(writes().length, 2);
  transport.notifySessionExpired(); h.commit(); assert.equal(h.reviews.at(-1), null); assert.equal(h.markup().includes('Rice: $18'), false); assert.equal(storage.size, 0);
});

async function connectedPriceWorkbench({ historical = false, onSaved } = {}) {
  const f = priceSave(); let current = f.initial, saved = null, nextSave = f.saved;
  panelResponses({ items: [], current: state({ versions: [cv()], publication: f.initial.publication }), extra: call => {
    if (call.url === `${BASE}/content-previews`) { saved = nextSave; current = wb({ editing_version: saved.version, latest_version: saved.version, content: saved.content, current_public_content_hash: HASH2 }); return response(saved); }
    if (call.url.includes('/workbench')) {
      const id = new URL(call.url, 'http://localhost').searchParams.get('base_version_id');
      return response({ ...current, editing_version: id === VID2 ? f.saved.version : cv() });
    }
    if (call.url.endsWith('/preview')) return response({ html: '<html><head></head><body>Real saved website</body></html>', checksum: call.url.includes(VID2) ? HASH2 : HASH, assets: [] });
    throw new Error(`未配置接口 ${call.url}`);
  } });
  const parent = panelHarness({ onContentSaved: onSaved }); await parent.settle(); await parent.settle();
  const child = hooksHarness('WebsiteWorkbench.tsx', parent.tree.props);
  async function settle() { for (let i = 0; i < 4; i++) { await parent.settle(); child.setProps(parent.tree.props); await child.settle(); } }
  await settle(); await savePrice(child); await settle();
  if (historical) current = { ...current, current_public_content_hash: HASH, differences: [{ field: 'menu', label: '菜单', before: 'Rice: $20', after: 'Rice: $25 saved later' }] };
  return { parent, child, settle, f, setSaveResult(value) { nextSave = value; } };
}

test('正式Parent+Workbench：普通候选发布审核显示成功差异，GET零diff不抹，选另一版清审核', async () => {
  const { parent, child, settle, f } = await connectedPriceWorkbench();
  assert.equal(visibleSaveReview(child).length, 1); assert.deepEqual(visibleSaveReview(child)[0].props.review.differences, f.saved.differences);
  parent.click('Publish preview v2'); await settle();
  const reviews = visibleSaveReview(parent); assert.equal(reviews.length, 1); assert.deepEqual(reviews[0].props.review.differences, f.saved.differences);
  assert.ok(parent.markup().includes('Rice: $18')); assert.ok(parent.markup().includes('Rice: $20'));
  assert.equal(parent.elements(n => n.type === 'input' && n.props.type === 'checkbox' && n.props.checked === false).filter(n => collect(parent.tree.props.publication, x => x === n).length).length, 0);
  assert.equal(writes().length, 1); parent.click('Cancel');
  parent.tree.props.onPreview(cv()); parent.commit(); await settle(); assert.equal(visibleSaveReview(child).length, 0);
  parent.tree.props.onPreview(f.saved.version); parent.commit(); await settle(); parent.click('Publish preview v2'); await settle();
  assert.equal(visibleSaveReview(parent).length, 0); assert.ok(parent.markup().includes('previous content-save comparison is not retained')); assert.equal(writes().length, 1);
});

test('历史候选审核分别显示保存18→20和historical20→25，保留安全checkbox与session清除', async () => {
  const { parent, child, settle } = await connectedPriceWorkbench({ historical: true });
  parent.click('Publish preview v2'); await settle();
  assert.ok(parent.markup().includes('Rice: $18')); assert.ok(parent.markup().includes('Rice: $25 saved later'));
  assert.ok(parent.markup().includes('Historical version vs saved restaurant')); assert.equal(parent.button('Confirm publish').props.disabled, true);
  parent.change('-slug', 'fixture-dining'); parent.check('I reviewed the historical facts'); assert.equal(parent.button('Confirm publish').props.disabled, false);
  transport.notifySessionExpired(); parent.commit(); child.commit();
  assert.equal(parent.markup().includes('Rice: $18'), false); assert.equal(child.markup().includes('Rice: $18'), false); assert.equal(storage.size, 0);
});

test('保存已确认但Parent同步失败仍保留差异与No AI，check result不重POST', async () => {
  let failed = true;
  const { child, parent, settle } = await connectedPriceWorkbench({ onSaved: async () => { if (failed) throw new transport.ApiError(0, 'NETWORK_ERROR'); } });
  assert.equal(visibleSaveReview(child).length, 1); assert.ok(child.text().includes('Content was saved'));
  failed = false; child.click('Check result'); await settle(); assert.equal(visibleSaveReview(child).length, 1); assert.equal(writes().length, 1);
  parent.click('Publish preview v2'); await settle(); assert.equal(visibleSaveReview(parent).length, 1);
});

test('changed=false清除已打开发布审核的旧回执：同version且无脏稿事件也不能继续确认旧差异', async () => {
  const { parent, child, settle, f, setSaveResult } = await connectedPriceWorkbench();
  parent.click('Publish preview v2'); await settle(); assert.equal(visibleSaveReview(parent).length, 1);
  setSaveResult({ ...f.saved, changed: false }); editor(child).props.onSave(); child.commit(); await settle();
  assert.equal(visibleSaveReview(parent).length, 0); assert.equal(visibleSaveReview(child).length, 0);
  assert.equal(parent.elements(n => n.type === 'button' && content(n) === 'Confirm publish').length, 0);
  parent.click('Publish preview v2'); await settle(); assert.equal(visibleSaveReview(parent).length, 0);
  assert.ok(parent.markup().includes('previous content-save comparison is not retained')); assert.equal(writes().length, 2); assert.equal(storage.size, 0);
});

function restoredReport(overrides = {}) {
  const f = priceSave();
  return wb({ editing_version: f.saved.version, latest_version: f.saved.version, content: f.saved.content,
    current_public_content_hash: HASH2, saved_differences: f.saved.differences, ...overrides });
}

test('saved_differences可选契约：旧fixture保持缺省，新数组严格验证并隔离当前differences', async () => {
  const c = client(), old = c.readWorkbench(wb(), RID); assert.equal(Object.hasOwn(old, 'saved_differences'), false);
  assert.deepEqual(c.readWorkbench(wb({ saved_differences: [] }), RID).saved_differences, []);
  const d = restoredReport({ differences: [{ field: 'contact', label: 'Contact', before: 'Old', after: 'Canonical' }] });
  assert.deepEqual(c.readWorkbench(d, RID, VID2), d);
  for (const value of [null, {}, 'menu', 1, [null], [{ field: 'price', label: 'Price', before: '$18', after: '$20' }],
    [{ field: 'menu', label: 'Menu', before: 18, after: '$20' }], [{ field: 'menu', before: '$18', after: '$20' }],
    [{ field: 'menu', label: 'Menu', before: '$18', after: '$20', raw_source: 'private' }]]) {
    assert.throws(() => c.readWorkbench({ ...d, saved_differences: value }, RID, VID2), apiError(502, 'RESPONSE_INVALID'));
  }
  wbResponses(d); const received = await c.websiteContentClient.workbench(RID, VID2);
  assert.deepEqual(received.saved_differences, d.saved_differences); checkTransport(calls.at(-1), 'GET'); assert.equal(writes().length, 0);
});

test('全页刷新首次GET恢复候选18→20差异、No AI和Content模式，hash来自editing而不是canonical', async () => {
  const d = restoredReport({ current_public_content_hash: HASH, differences: [{ field: 'menu', label: 'Menu', before: '$20', after: '$25 current' }] });
  wbResponses(d); const h = workbenchHarness({ selectedId: VID2, previewVersion: { id: VID2, version_number: 2 } }); await h.settle();
  assert.equal(h.button('Content').props['aria-pressed'], true); assert.equal(visibleSaveReview(h).length, 1);
  const review = visibleSaveReview(h)[0].props.review;
  assert.equal(review.checksum, d.editing_version.checksum); assert.equal(review.public_content_hash, HASH2); assert.equal(review.base_version_id, VID);
  assert.deepEqual(review.differences, d.saved_differences); assert.deepEqual(h.reviews.at(-1), review);
  assert.ok(h.markup().includes('Design unchanged / No AI')); assert.ok(h.markup().includes('Rice: $18'));
  assert.equal(text(nodes(documentOf(h.markup()), n => attr(n, 'data-candidate-id') === VID2)[0]).includes('$25 current'), false);
  assert.equal(writes().length, 0); assert.equal(storage.size, 0); h.unmount();
  const fresh = workbenchHarness({ selectedId: VID2, previewVersion: { id: VID2, version_number: 2 } }); await fresh.settle();
  assert.deepEqual(visibleSaveReview(fresh)[0].props.review, review);
});

test('本页成功回执优先：GET saved_differences与canonical变化都不能替换成功18→20，用户脏稿独立', async () => {
  const f = priceSave(); let current = f.initial; wbResponses(() => current, () => response(f.saved));
  const h = workbenchHarness({ selectedId: VID }); await h.settle(); await savePrice(h);
  h.setProps({ selectedId: VID2, previewVersion: { id: VID2, version_number: 2 } }); await h.settle();
  const original = structuredClone(visibleSaveReview(h)[0].props.review);
  changeContent(h, d => { d.restaurant.name = 'Private unsaved input'; });
  current = { ...f.initial, saved_differences: [{ field: 'menu', label: 'Menu', before: '$1 server', after: '$99 server' }] };
  h.setProps({ refreshToken: 'new-read' }); await h.settle();
  assert.deepEqual(visibleSaveReview(h)[0].props.review, original); assert.equal(editor(h).props.draft.restaurant.name, 'Private unsaved input');
  assert.equal(text(nodes(documentOf(h.markup()), n => attr(n, 'data-candidate-id') === VID2)[0]).includes('Private unsaved input'), false);
});

for (const kind of ['published', 'generation', 'legacy', 'empty']) test(`saved_differences ${kind}范围不显示伪造候选review`, async () => {
  let d = restoredReport();
  if (kind === 'published') d = { ...d, publication: { revision: 1, published_version_id: VID2, slug: 'fixture-dining', url: 'http://localhost:3000/s/fixture-dining', deployment_mode: 'local' }, published_version: d.editing_version };
  if (kind === 'generation') d = wb({ saved_differences: priceSave().saved.differences });
  if (kind === 'legacy') {
    const v = cv({ origin: 'legacy', source_status: 'missing', public_content_hash: null });
    d = wb({ editing_version: v, latest_version: v, blockers: ['WEBSITE_SOURCE_MISSING'], saved_differences: priceSave().saved.differences });
  }
  if (kind === 'empty') d.saved_differences = [];
  wbResponses(d); const h = workbenchHarness({ selectedId: d.editing_version.id, previewVersion: d.editing_version }); await h.settle();
  assert.equal(visibleSaveReview(h).length, 0); assert.equal(h.reviews.at(-1), null); assert.equal(writes().length, 0);
  assert.equal(load('WebsiteWorkbench.tsx').savedContentReview(d), null);
});

test('切版和已发布清恢复scope，返回候选从新GET恢复，迟到GET及session不会复活私有差异', async () => {
  let current = restoredReport(); wbResponses(() => current);
  const h = workbenchHarness({ selectedId: VID2, previewVersion: { id: VID2, version_number: 2 } }); await h.settle(); assert.equal(visibleSaveReview(h).length, 1);
  current = wb({ latest_version: current.latest_version, saved_differences: [] });
  h.setProps({ selectedId: VID, previewVersion: { id: VID2, version_number: 2 } }); await h.settle(); assert.equal(visibleSaveReview(h).length, 0);
  current = restoredReport(); h.setProps({ selectedId: VID2 }); await h.settle(); assert.equal(visibleSaveReview(h).length, 1);
  const late = deferred(), original = responder; responder = call => call.url.includes('/workbench') ? late.promise : original(call);
  h.click('Check result'); const read = calls.at(-1); transport.notifySessionExpired(); h.commit(); assert.equal(read.options.signal.aborted, true);
  late.resolve(response(current)); await h.settle(); assert.equal(visibleSaveReview(h).length, 0); assert.equal(h.reviews.at(-1), null);
  assert.equal(h.markup().includes('Rice: $18'), false); assert.equal(storage.size, 0);
});

test('未知保存后GET即使有saved_differences也不冒充本次写入成功、不改变冻结targets', async () => {
  const d = restoredReport(); wbResponses(d, () => Promise.reject(new TypeError('unknown')));
  const h = workbenchHarness({ selectedId: VID2, previewVersion: d.editing_version }); await h.settle();
  assert.equal(visibleSaveReview(h).length, 1); changeContent(h, next => { next.restaurant.name = 'Unknown save'; }); editor(h).props.onSave(); h.commit(); await h.settle();
  const original = writes()[0]; h.click('Check result'); await h.settle(); assert.equal(visibleSaveReview(h).length, 0); assert.equal(h.reviews.at(-1), null);
  assert.ok(h.text().includes('Save result unknown')); assert.equal(writes().length, 1);
  h.click('Check result / Retry same request'); await h.settle(); checkTransport(writes()[1], 'POST', JSON.parse(original.options.body), original.options.headers.get('Idempotency-Key'));
  assert.equal(storage.size, 0);
});

test('正常发布审核单独GET saved_differences fallback，不要求本页先保存；historical仍保安全确认', async () => {
  let current = restoredReport();
  panelResponses({ items: [], current: state({ versions: [current.editing_version], publication: current.publication }), extra: call => {
    if (call.url.includes('/workbench')) return response(current);
    if (call.url.endsWith('/preview')) return response({ html: '<html><head></head><body>Saved candidate</body></html>', checksum: HASH2, assets: [] });
    throw new Error(`未配置接口 ${call.url}`);
  } });
  const parent = panelHarness(); await parent.settle(); await parent.settle(); await parent.settle();
  parent.click('Publish preview v2'); await parent.settle();
  assert.equal(visibleSaveReview(parent).length, 1); assert.deepEqual(visibleSaveReview(parent)[0].props.review.differences, current.saved_differences);
  assert.ok(parent.markup().includes('Rice: $18')); assert.ok(parent.markup().includes('Design unchanged / No AI'));
  parent.change('-slug', 'fixture-dining'); assert.equal(parent.button('Confirm publish').props.disabled, false); assert.equal(writes().length, 0);
  parent.click('Cancel'); current = { ...current, current_public_content_hash: HASH, differences: [{ field: 'menu', label: 'Menu', before: '$20 saved', after: '$25 canonical' }] };
  parent.click('Publish preview v2'); await parent.settle(); assert.equal(visibleSaveReview(parent)[0].props.review.public_content_hash, HASH2);
  assert.equal(parent.button('Confirm publish').props.disabled, true); parent.check('I reviewed the historical facts'); assert.equal(parent.button('Confirm publish').props.disabled, false);
});

for (const status of ['running', 'failed']) test(`AI design进度${status}默认可见，长trace仍原生折叠`, async () => {
  const job = { id: JID, kind: 'generate', status, error_code: status === 'failed' ? 'MODEL_OUTPUT_INVALID' : null, result_version_id: null, created_at: NOW,
    trace: Array.from({ length: 30 }, (_, i) => ({ action: 'check', status: 'ok', round: i, message: `Recorded check ${i}`, diagnostics: [] })) };
  panelResponses({ items: [], current: state({ jobs: [job] }) }); const h = panelHarness(); await h.settle();
  const doc = documentOf(h.markup()), section = nodes(doc, n => (attr(n, 'class') ?? '').includes('website-agent-progress'))[0];
  assert.ok(text(section).includes('AI design progress'));
  const details = nodes(section, n => attr(n, 'class') === 'website-agent-details')[0]; assert.ok(details); assert.equal(attr(details, 'open'), undefined);
  const statusText = (section.childNodes ?? []).filter(n => n !== details).map(text).join('');
  assert.ok(statusText.includes(status === 'running' ? 'Running' : 'Generation failed')); if (status === 'failed') assert.ok(statusText.includes('MODEL_OUTPUT_INVALID'));
});
