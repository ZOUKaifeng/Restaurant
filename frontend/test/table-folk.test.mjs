import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// In-memory TS compilation and React server rendering; no browser or network requests.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'package.json'));
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const originals = Object.fromEntries(['.ts', '.tsx', '.css'].map((name) => [name, Module._extensions[name]]));
let writes = 0;
let routes;
function stubWindow(path = '/', hash = '', search = '') {
  const replacements = [];
  globalThis.window = {
    location: { pathname: path, origin: 'https://localhost:5173', hash, search },
    history: { replaceState: (...args) => replacements.push(args) },
  };
  return replacements;
}
function component(name) { return require(resolve(root, 'src', name)).default; }
const navigation = () => { throw new Error('SSR must not navigate'); };
const policy = { terms_version: 'draft-v1', terms_url: '/legal/terms', privacy_notice_version: 'draft-v1', privacy_url: '/legal/privacy', supported_locales: ['zh-CN', 'en'], password_min_length: 15, password_max_length: 128 };
function authProps(page, token = null) {
  return { route: { page, path: `/auth/${page}`, token }, policy, policyError: null, policyLoading: false,
    reloadPolicy: () => { writes += 1; }, navigate: navigation, busy: false, onBusyChange: () => {},
    onLogin: () => { writes += 1; }, onConsumed: () => { writes += 1; } };
}
before(() => {
  const compile = (module, filename) => {
    const output = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true, moduleResolution: ts.ModuleResolutionKind.NodeJs,
    }, fileName: filename }).outputText;
    const resolved = output.replace(/require\(["'](\.\.?\/[^"']+)\.js["']\)/g, (match, relative) => {
      for (const extension of ['.ts', '.tsx']) {
        const target = resolve(dirname(filename), relative + extension);
        if (existsSync(target)) return `require(${JSON.stringify(target)})`;
      }
      return match;
    });
    module._compile(resolved, filename);
  };
  Module._extensions['.ts'] = compile;
  Module._extensions['.tsx'] = compile;
  Module._extensions['.css'] = () => {};
  stubWindow();
  routes = require(resolve(root, 'src/routing.ts'));
});
after(() => {
  for (const [name, handler] of Object.entries(originals)) {
    if (handler) Module._extensions[name] = handler;
    else delete Module._extensions[name];
  }
  delete globalThis.window;
});

test('homepage renders while session boot is pending, with real routes and color images', () => {
  stubWindow('/');
  const html = renderToStaticMarkup(React.createElement(component('App.tsx'), { initialRoute: { page: 'home', path: '/', token: null } }));
  assert.match(html, />TABLE FOLK/);
  assert.doesNotMatch(html, />table folk/);
  assert.match(html, /Your restaurant/);
  assert.match(html, /A better first impression/);
  assert.match(html, /href="\/examples"/);
  assert.match(html, /href="\/auth\/register"/);
  assert.match(html, /\/brand\/table-editorial\.jpg/);
  assert.doesNotMatch(html, /Checking your account session/);
});
test('authenticated marketing CTA leads to the real workspace', () => {
  const html = renderToStaticMarkup(React.createElement(component('HomePage.tsx'), { navigate: navigation, busy: false, authenticated: true }));
  assert.match(html, /href="\/app"/);
  assert.match(html, /Illustrative examples/);
  assert.doesNotMatch(html, /grayscale/);
});
test('homepage shows static design illustrations without an explore affordance', () => {
  const html = renderToStaticMarkup(React.createElement(component('HomePage.tsx'), { navigate: navigation, busy: false, authenticated: false }));
  assert.doesNotMatch(html, /Explore the example|Explore website/);
  assert.doesNotMatch(html, /aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /<dialog/);
  assert.doesNotMatch(html, /View menu|Design illustration/i);
  assert.match(html, /Not live restaurant websites/);
  assert.match(html, /href="\/examples"/);
  assert.equal((html.match(/class="tf-cover"/g) || []).length, 6);
});
test('homepage hero keeps only its headline, introduction, actions and device illustration', () => {
  const html = renderToStaticMarkup(React.createElement(component('HomePage.tsx'), { navigate: navigation, busy: false, authenticated: false }));
  const { parseFragment } = require('parse5');
  const tree = parseFragment(html);
  function byClass(node, name) {
    if ((node.attrs || []).some(attr => attr.name === 'class' && attr.value.split(' ').includes(name))) return node;
    for (const child of node.childNodes || []) { const result = byClass(child, name); if (result) return result; }
  }
  const copy = byClass(tree, 'tf-hero-copy');
  assert.deepEqual(copy.childNodes.filter(node => node.tagName).map(node => node.tagName), ['h1', 'p', 'div']);
  const hero = byClass(tree, 'tf-hero');
  assert.equal(hero.childNodes.filter(node => node.tagName).length, 2);
  const visual = byClass(tree, 'tf-hero-visual');
  assert.equal(visual.childNodes.filter(node => node.tagName).length, 1);
  assert.ok(byClass(visual, 'tf-desktop-device'));
  assert.ok(byClass(visual, 'tf-phone-device'));
  assert.doesNotMatch(html, /Independent restaurants\. Individual points of view\.|One point of view\. Every screen\.|Your content\. Your style\.|Menus you can review|Room for your photos|Desktop &amp; mobile previews|For the people behind the restaurant/);
  const sections = byClass(tree, 'tf-home').childNodes.filter(node => node.tagName);
  assert.equal(sections[0].attrs.find(attr => attr.name === 'class')?.value, 'tf-hero');
  assert.ok(sections[1].attrs.some(attr => attr.name === 'class' && attr.value === 'tf-examples-section'));
  const css = readFileSync(resolve(root, 'src/marketing.css'), 'utf8');
  assert.doesNotMatch(css, /tf-principles|tf-hero-caption|tf-visual-caption/);
});

test('homepage motion is an enhancement, not an initially hidden content gate', () => {
  const html = renderToStaticMarkup(React.createElement(component('HomePage.tsx'), { navigate: navigation, busy: false, authenticated: false }));
  assert.equal((html.match(/data-tf-reveal=""/g) || []).length, 3);
  assert.doesNotMatch(html, /tf-reveal-enter|tf-photo-active|style="[^"]*(?:opacity|visibility)/);
  const css = readFileSync(resolve(root, 'src/marketing.css'), 'utf8');
  const cssTree = require('css-tree');
  const animations = [];
  cssTree.walk(cssTree.parse(css), { visit: 'Rule', enter(node) {
    const body = cssTree.generate(node.block);
    if (/tf-home-(?:enter|photo)/.test(body)) node.prelude.children.forEach(selector => animations.push(cssTree.generate(selector)));
  } });
  assert.equal(animations.length, 4);
  assert.ok(animations.every(selector => selector.startsWith('.tf-home')));
  assert.match(css, /\.tf-hero-visual \.tf-cover-photo img \{ animation: tf-home-photo 10s/);
  assert.match(css, /scale\(1\.03\)/);
  assert.match(css, /animation-play-state: paused/);
  assert.match(css, /\.tf-home \* \{ animation: none !important/);
});

// Small DOM/observer doubles exercise the imperative lifecycle without a browser.
function motionFixture(reduced = false) {
  function signal() {
    const listeners = new Map();
    return { listeners,
      addEventListener(type, fn) { listeners.set(type, fn); },
      removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
      fire(type, event = {}) { listeners.get(type)?.(event); },
    };
  }
  function element(top, bottom = top + 300) {
    const classes = new Set();
    return { ...signal(), getBoundingClientRect: () => ({ top, bottom }), classList: {
      add: (...values) => values.forEach(value => classes.add(value)),
      remove: (...values) => values.forEach(value => classes.delete(value)),
      contains: value => classes.has(value),
      toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); },
    } };
  }
  const preference = { ...signal(), matches: reduced };
  const hero = element(40);
  const sections = [element(200), element(900), element(1500)];
  const observers = [];
  class Observer {
    targets = new Set(); disconnected = false;
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); this.disconnected = true; }
    emit(target, isIntersecting = true) { this.callback([{ target, isIntersecting }]); }
  }
  const view = { innerHeight: 800, matchMedia: () => preference, IntersectionObserver: Observer };
  const document = { ...signal(), defaultView: view, hidden: false };
  const page = { ...element(0), ownerDocument: document,
    querySelector: () => hero, querySelectorAll: () => sections,
    contains: target => sections.includes(target),
  };
  const attach = require(resolve(root, 'src/home-motion.ts')).attachHomeMotion;
  return { root: page, hero, sections, preference, document, view, observers, attach };
}

test('motion reveals offscreen sections once and leaves already visible content alone', () => {
  const f = motionFixture(); const cleanup = f.attach(f.root); const observer = f.observers[0];
  assert.deepEqual(observer.targets, new Set([f.hero, f.sections[1], f.sections[2]]));
  observer.emit(f.sections[1]);
  assert.ok(f.sections[1].classList.contains('tf-reveal-enter'));
  assert.ok(!observer.targets.has(f.sections[1]));
  f.sections[1].classList.remove('tf-reveal-enter');
  observer.emit(f.sections[1]);
  assert.ok(!f.sections[1].classList.contains('tf-reveal-enter'));
  cleanup();
});
test('photo motion pauses offscreen, in background and on reduced-motion preference', () => {
  const f = motionFixture(); const cleanup = f.attach(f.root); const observer = f.observers[0];
  assert.ok(f.root.classList.contains('tf-photo-active'));
  observer.emit(f.hero, false); assert.ok(!f.root.classList.contains('tf-photo-active'));
  observer.emit(f.hero, true); assert.ok(f.root.classList.contains('tf-photo-active'));
  f.document.hidden = true; f.document.fire('visibilitychange');
  assert.ok(!f.root.classList.contains('tf-photo-active'));
  f.document.hidden = false; f.document.fire('visibilitychange');
  assert.ok(f.root.classList.contains('tf-photo-active'));
  observer.emit(f.sections[1]);
  f.preference.matches = true; f.preference.fire('change');
  assert.ok(!f.root.classList.contains('tf-photo-active'));
  assert.ok(!f.sections[1].classList.contains('tf-reveal-enter'));
  observer.emit(f.sections[2]); assert.ok(!f.sections[2].classList.contains('tf-reveal-enter'));
  f.preference.matches = false; f.preference.fire('change');
  assert.ok(f.root.classList.contains('tf-photo-active'));
  cleanup();
});
test('keyboard focus bypasses entrances; cleanup handles late callbacks and remount', () => {
  const f = motionFixture(); const cleanup = f.attach(f.root); const observer = f.observers[0];
  f.root.fire('focusin', { target: { closest: selector => selector === '[data-tf-reveal]' ? f.sections[1] : null } });
  observer.emit(f.sections[1]); assert.ok(!f.sections[1].classList.contains('tf-reveal-enter'));
  f.root.fire('focusin', { target: { closest: selector => selector === '.tf-hero-copy' ? {} : null } });
  assert.ok(f.root.classList.contains('tf-hero-focused'));
  cleanup();
  assert.ok(observer.disconnected);
  for (const target of [f.root, f.document, f.preference]) assert.equal(target.listeners.size, 0);
  observer.emit(f.hero); observer.emit(f.sections[2]);
  assert.ok(!f.root.classList.contains('tf-photo-active'));
  assert.ok(!f.root.classList.contains('tf-hero-focused'));
  assert.ok(!f.sections[2].classList.contains('tf-reveal-enter'));
  const cleanupAgain = f.attach(f.root);
  assert.ok(f.root.classList.contains('tf-photo-active')); cleanupAgain();
});
test('reduced motion starts static; missing or legacy APIs fail open', () => {
  const reduced = motionFixture(true); const cleanup = reduced.attach(reduced.root);
  reduced.observers[0].emit(reduced.sections[1]);
  assert.ok(!reduced.root.classList.contains('tf-photo-active'));
  assert.ok(!reduced.sections[1].classList.contains('tf-reveal-enter')); cleanup();
  for (const missing of ['view', 'matchMedia', 'IntersectionObserver', 'mediaListeners']) {
    const f = motionFixture();
    if (missing === 'view') f.document.defaultView = null;
    else if (missing === 'mediaListeners') f.preference.addEventListener = undefined;
    else f.view[missing] = undefined;
    assert.doesNotThrow(() => f.attach(f.root)());
    assert.equal(f.observers.length, 0);
    assert.ok(!f.root.classList.contains('tf-photo-active'));
  }
});

test('example gallery contains four distinctly identified fictional restaurant previews', () => {
  const html = renderToStaticMarkup(React.createElement(component('ExamplesPage.tsx'), { navigate: navigation, busy: false, authenticated: false }));
  for (const name of ['Marlow &amp; Pine', 'Forma', 'June Supper House', 'Miso Room']) assert.ok(html.includes(name));
  for (const layout of ['split-editorial', 'poster-diner', 'immersive-night', 'quiet-rail']) assert.ok(html.includes(`data-design="${layout}"`));
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /Not live restaurant websites/);
  assert.doesNotMatch(html, /<iframe|srcDoc=/);
});
test('every example has distinct cover structure, page composition and its own photography', () => {
  const { RESTAURANT_EXAMPLES, RestaurantCover, RestaurantWebsite } = require(resolve(root, 'src/restaurant-examples.tsx'));
  assert.equal(RESTAURANT_EXAMPLES.length, 4);
  assert.equal(new Set(RESTAURANT_EXAMPLES.map(item => item.photo.src)).size, 4);
  const structures = ['tf-editorial-opening', 'tf-diner-opening', 'tf-night-opening', 'tf-quiet-opening'];
  for (const [index, example] of RESTAURANT_EXAMPLES.entries()) {
    const cover = renderToStaticMarkup(React.createElement(RestaurantCover, { example }));
    assert.match(cover, new RegExp(`data-design="${example.layout}"`));
    assert.ok(cover.includes(example.photo.src));
    for (const mobile of [false, true]) {
      const html = renderToStaticMarkup(React.createElement(RestaurantWebsite, { example, mobile }));
      assert.ok(html.includes(structures[index]));
      for (const other of structures.filter(item => item !== structures[index])) assert.ok(!html.includes(other));
      for (const dish of example.menu) assert.ok(html.includes(dish.price));
      assert.match(html, /Example only — no reservation is submitted/);
      assert.match(html, /type="submit" disabled/);
      assert.doesNotMatch(html, /<script|<iframe|action="http/);
      assert.equal((html.match(/aria-label="[^"]*illustrative restaurant website"/g) || []).length, 1);
    }
  }
});
test('all example sections have unique valid navigation and accessible label targets', () => {
  const { RESTAURANT_EXAMPLES, RestaurantWebsite } = require(resolve(root, 'src/restaurant-examples.tsx'));
  const { parseFragment } = require('parse5');
  for (const example of RESTAURANT_EXAMPLES) {
    const html = renderToStaticMarkup(React.createElement(RestaurantWebsite, { example, mobile: true }));
    const ids = new Set(); const references = [];
    function walk(node) {
      const attributes = Object.fromEntries((node.attrs || []).map(item => [item.name, item.value]));
      if (attributes.id) { assert.ok(!ids.has(attributes.id)); ids.add(attributes.id); }
      for (const key of ['for', 'aria-labelledby', 'aria-describedby']) if (attributes[key]) references.push(...attributes[key].split(' '));
      for (const child of node.childNodes || []) walk(child);
    }
    walk(parseFragment(html));
    for (const id of references) assert.ok(ids.has(id), `${example.id}: missing ${id}`);
    for (const section of ['menu', 'story', 'visit', 'booking']) assert.equal([...ids].filter(id => id.endsWith(`-${section}`)).length, 1);
  }
});
test('new page routes are explicit and unknown routes remain not-found', () => {
  for (const [path, page] of [['/', 'home'], ['/examples', 'examples'], ['/app', 'app'], ['/app/restaurants', 'app'], ['/auth/login', 'login'], ['/account/sessions', 'sessions'], ['/missing', 'not-found']]) {
    stubWindow(path);
    assert.equal(routes.readRoute().page, page);
  }
});
test('action tokens are read into memory then stripped from the address before mount', () => {
  const token = 't'.repeat(43);
  const calls = stubWindow('/auth/reset', `#token=${token}`);
  assert.equal(routes.readRoute().token, token);
  assert.deepEqual(calls[0], [null, '', '/auth/reset']);
  assert.ok(!JSON.stringify(calls).includes(token));
});
test('registration still needs explicit unchecked terms and chooses supported English', () => {
  stubWindow('/auth/register');
  const html = renderToStaticMarkup(React.createElement(component('AuthView.tsx'), authProps('register')));
  assert.match(html, /type="checkbox"/);
  assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
  assert.match(html, /value="en" selected=""/);
  assert.match(html, /minLength="15"/i);
  assert.match(html, /draft-v1/);
  assert.match(html, /\/brand\/bistro-interior\.jpg/);
});
test('verification and password reset do not auto-consume tokens', () => {
  stubWindow('/auth/verify');
  const token = 'v'.repeat(43);
  for (const page of ['verify', 'reset']) {
    const html = renderToStaticMarkup(React.createElement(component('AuthView.tsx'), authProps(page, token)));
    assert.match(html, /type="submit"/);
    assert.ok(!html.includes(token));
  }
  assert.equal(writes, 0);
});
test('missing mail token disables submission and directs to a new request', () => {
  stubWindow('/auth/reset');
  const html = renderToStaticMarkup(React.createElement(component('AuthView.tsx'), authProps('reset')));
  assert.match(html, /<fieldset disabled/);
  assert.match(html, /href="\/auth\/forgot"/);
});
test('protected workspace does not render restaurant data before session verification', () => {
  stubWindow('/app');
  const html = renderToStaticMarkup(React.createElement(component('App.tsx'), { initialRoute: { page: 'app', path: '/app', token: null } }));
  assert.match(html, /Checking your account session/);
  assert.doesNotMatch(html, /restaurant-card|restaurant-name-/);
});
test('new styles parse without errors and preserve color, small-screen and reduced-motion rules', () => {
  const cssTree = require('css-tree');
  for (const file of ['styles.css', 'marketing.css', 'example-designs.css', 'auth.css', 'dashboard.css']) {
    const css = readFileSync(resolve(root, 'src', file), 'utf8');
    cssTree.parse(css, { onParseError: (error) => { throw error; } });
    assert.doesNotMatch(css, /filter\s*:\s*grayscale/i);
  }
  const shell = readFileSync(resolve(root, 'src/styles.css'), 'utf8');
  assert.match(shell, /max-width: 420px/);
  assert.match(shell, /prefers-reduced-motion/);
});
