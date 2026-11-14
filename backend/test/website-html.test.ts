import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectWebsite, renderWebsite, WebsiteValidationError, WEBSITE_CSP, WEBSITE_SANDBOX, type WebsiteSnapshot } from '../src/website-html.js';
import { ApiError } from '../src/errors.js';
import { parse, parseFragment, serialize, Tokenizer, type DefaultTreeAdapterMap, type Token } from 'parse5';
const snapshot: WebsiteSnapshot = { restaurant: { id: 'rst_sample', name: '真实名称 <餐厅>', description: '商家确认的介绍', cuisine_type: 'Italian', address_line1: '10 Sample Street', address_line2: null, city: 'Sample City', region: null, postal_code: null, country_code: 'US', contact_email: 'hello@example.com', contact_phone: '+1 234 567 8901', timezone: 'America/New_York', currency: 'USD', primary_locale: 'en' }, opening_hours: [{ weekday: 1, opens_at_local: '18:00', closes_at_local: '01:00', closes_day_offset: 1 }], assets: [] };
const output = { html_body: '<main><h1><restaurant-name></restaurant-name></h1><p>About</p><p>Invented award 2026 and $99 price</p><restaurant-description></restaurant-description></main>', css: ':root{--accent:#163d2b}main{padding:clamp(20px,5vw,70px);color:var(--accent)}@media(max-width:600px){main{padding:20px}}', summary: 'test' };
test('生成HTML保留模型普通文案，事实组件独立使用确认快照并补固定资料', () => {
  const result = renderWebsite(output, snapshot);
  assert.ok(result.html.includes('真实名称 &lt;餐厅&gt;'));
  assert.ok(result.html.includes('商家确认的介绍') && result.html.includes('10 Sample Street'));
  assert.ok(result.html.includes('18:00–01:00 (next day)'));
  assert.ok(result.html.includes('Invented award 2026 and $99 price'));
  assert.ok(result.html.includes('mailto:hello@example.com') && result.html.includes('Online reservations are not available'));
  assert.ok(!result.html.includes('<script') && !result.html.includes('<form'));
  assert.ok(result.html.includes('prefers-reduced-motion'));
});
test('HTML禁止脚本、事件、外部图片、iframe和SVG', () => {
  for (const html_body of ['<script>alert(1)</script>', '<div onclick="alert(1)">About</div>', '<img src="https://example.com/track">', '<iframe src="https://example.com"></iframe>', '<svg><script></script></svg>', '<form></form>']) {
    assert.throws(() => renderWebsite({ ...output, html_body }, snapshot), { code: 'WEBSITE_HTML_INVALID' });
  }
});
test('CSS语法树阻断外网、导入、伪造content与浏览器绑定', () => {
  for (const css of ['@import "https://example.com/style.css";', 'body{background:url(https://example.com/track)}', 'p::before{content:"fake award"}', 'body{behavior:expression(alert(1))}', '@font-face{font-family:leak;src:url(https://example.com)}', '</style><script>alert(1)</script>']) {
    assert.throws(() => renderWebsite({ ...output, css }, snapshot), { code: 'WEBSITE_HTML_INVALID' });
  }
});
test('订位组件使用平台固定入口，开启时自动补全，未开启不渲染任何订位提示', () => {
  const enabled = { ...snapshot, restaurant: { ...snapshot.restaurant, reservation_enabled: true, reservation_notice: 'Requests need restaurant confirmation.' } };
  const explicit = renderWebsite({ ...output, html_body: '<main><restaurant-reservation></restaurant-reservation></main>' }, enabled).html;
  assert.ok(explicit.includes('__SITE_RESERVE__') && explicit.includes('Requests need restaurant confirmation.'));
  const automatic = renderWebsite(output, enabled).html;
  assert.ok(automatic.includes('__SITE_RESERVE__') && automatic.includes('site-reservation-link'));
  const disabled = renderWebsite({ ...output, html_body: '<main><restaurant-reservation></restaurant-reservation></main>' }, snapshot).html;
  assert.ok(!disabled.includes('__SITE_RESERVE__'));
  assert.ok(!/class="site-reservation/.test(disabled));
  assert.ok(!disabled.includes('site-reservation-unavailable'));
});
test('素材仅限确认清单，图片与菜单占位符可替换但不带私有地址', () => {
  const aid = 'ast_' + 'a'.repeat(24), unknown = 'ast_' + 'b'.repeat(24);
  const media = { ...snapshot, assets: [{ id: aid, kind: 'menu_source', mime_type: 'image/png', checksum: 'a'.repeat(64), width_px: 10, height_px: 10 }] };
  const html = renderWebsite({ ...output, html_body: `<restaurant-image data-asset-id="${unknown}"></restaurant-image><restaurant-menu></restaurant-menu>` }, media).html;
  assert.ok(html.includes(`__SITE_ASSET_${aid}__`) && !html.includes(unknown));
  assert.ok(!html.includes('storage_key') && !html.includes('/api/v1/'));
});

function checkInvalid(html_body: string, css: string, code: string, file: 'index.html' | 'styles.css' = 'index.html') {
  const inspection = inspectWebsite({ html_body, css, summary: '不应公开的内部摘要' }, snapshot);
  assert.equal(inspection.valid, false);
  assert.equal(inspection.rendered, undefined);
  assert.ok(inspection.diagnostics.some(d => d.code === code && d.file === file), JSON.stringify(inspection.diagnostics));
  assert.throws(() => renderWebsite({ html_body, css, summary: '' }, snapshot), error => {
    assert.ok(error instanceof WebsiteValidationError && error instanceof ApiError);
    assert.equal(error.code, 'WEBSITE_HTML_INVALID');
    assert.ok(error.diagnostics.length > 0 && error.diagnostics.length <= 20);
    return true;
  });
  return inspection;
}
const aid = 'ast_' + 'c'.repeat(24), pdfId = 'ast_' + 'd'.repeat(24);
const mediaSnapshot: WebsiteSnapshot = { ...snapshot, assets: [
  { id: aid, kind: 'gallery', mime_type: 'image/png', checksum: 'c'.repeat(64), width_px: 800, height_px: 600 },
  { id: pdfId, kind: 'menu_source', mime_type: 'application/pdf', checksum: 'd'.repeat(64), width_px: null, height_px: null },
] };

test('现代静态语义 HTML、图片、内联样式和未知无 active 自定义标签可通过', () => {
  const html_body = `<main><h1>新文案</h1><h2>About</h2><h3>三级</h3><h4>四级</h4><h5>五级</h5><h6>六级</h6>
    <table><caption>参考说明</caption><thead><tr><th scope="col">栏目</th></tr></thead><tbody><tr><td colspan="2">文字</td></tr></tbody><tfoot><tr><td>页脚</td></tr></tfoot></table>
    <figure><picture><img src="__SITE_ASSET_${aid}__" alt="菜品 &quot;说明&quot; &lt;不执行&gt;" width="800" height="600" loading="lazy"></picture><figcaption>图注</figcaption></figure>
    <details open><summary>展开介绍</summary><dl><dt>静态标签</dt><dd>自由表达 &amp; 文案</dd></dl></details>
    <address>地址组件：<restaurant-address /></address><p><abbr title="说明">缩写</abbr><kbd>Enter</kbd><code>&lt;button&gt;</code><mark>标记</mark><time datetime="12:00">午间</time><wbr></p>
    <pre>逐行\n  保留空白 &amp; 实体</pre><button disabled>静态按钮</button><safe-card class="卡片 card" aria-label="介绍" style="transform:translate3d(0,0,0);filter:drop-shadow(0 4px 8px #0003);color:oklch(.6 .2 30)">不丢弃的自定义文案</safe-card></main>`;
  const result = inspectWebsite({ html_body, css: '', summary: '私有摘要' }, mediaSnapshot);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  const html = result.rendered!.html;
  for (const text of ['<h6>', '<caption>', '<thead>', '<tbody>', '<tfoot>', '<figcaption>', '<summary>', '<dl>', '<kbd>', '<safe-card class="卡片 card"', '不丢弃的自定义文案', '逐行\n  保留空白 &amp; 实体', 'alt="菜品 &quot;说明&quot; &lt;不执行&gt;"', 'type="button"']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('私有摘要'));
  assert.equal((html.match(new RegExp(`<img src="__SITE_ASSET_${aid}__"`, 'g')) ?? []).length, 1);
});

test('现代 CSS 函数和安全 at-rule 不依赖函数小白名单', () => {
  const css = `@layer reset, theme;
  @property --accent{syntax:"<color>";inherits:false;initial-value:oklch(.5 .1 30)}
  @layer theme{main{color:color-mix(in oklch,oklch(.6 .2 30) 60%,#fff);transform:translate3d(1px,2px,0);filter:drop-shadow(0 2px 4px #0005);background:conic-gradient(from 90deg,#fff,#eee);--future:future-pure-style(1 2);--empty:}}
  @container card (width < 600px){main{padding:clamp(1rem,5vw,4rem)}}
  @supports (display:grid){main{display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr))}}
  @media (prefers-color-scheme:dark){main{color:light-dark(#333,#eee)}}
  @keyframes appear{from{opacity:0;transform:translateY(2px)}to{opacity:1}}
  @future-rule future-pure-style(1){p{color:oklch(.5 .1 10)}}
  .tokens{--theme:{color:red;padding:5px};--value:future-token(foo:bar);--blank:;font-family:"Example Local Font",sans-serif}
  .decor::before{content:""}`;
  const result = inspectWebsite({ ...output, css }, snapshot);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  for (const functionName of ['color-mix(', 'oklch(', 'translate3d(', 'drop-shadow(', 'future-pure-style(', 'light-dark(']) assert.ok(result.rendered!.html.includes(functionName));
  assert.ok(result.rendered!.html.includes('@container'));
});

test('HTML optional end 标签合法省略，custom 自闭合不会吞掉后续文案', () => {
  const html_body = '<section><restaurant-name/><p>第一段<p>第二段<ul><li>一<li><p>二</ul><dl><dt>术语<dd>解释</dl><ruby>字<rt>注音<rp>说明</ruby><table><colgroup><col><thead><tr><th>A<th>B<tbody><tr><td>1<td>2<tr><td>3<td>4<tfoot><tr><td>尾</table><safe-card/><h4>保留兄弟标题</h4><p>末段</section>';
  const result = inspectWebsite({ ...output, html_body }, snapshot);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.ok(result.rendered!.html.includes('<safe-card></safe-card><h4>保留兄弟标题</h4>'));
  assert.ok(result.rendered!.html.includes('第一段') && result.rendered!.html.includes('第二段'));
});

test('缺失或错序闭标签报告原始位置，不接受 parser 自动修复成功', () => {
  const missing = checkInvalid('<section>\n  <h1>About</section>', '', 'HTML_MISSING_END_TAG');
  assert.ok(missing.diagnostics.some(d => d.line === 2 && d.column === 3 && d.code === 'HTML_MISSING_END_TAG'));
  checkInvalid('<main><strong>文字</main></strong>', '', 'HTML_MISSING_END_TAG');
  checkInvalid('<section><div>尾部', '', 'HTML_MISSING_END_TAG');
  checkInvalid('<div/>', '', 'HTML_SELF_CLOSING_FORBIDDEN');
  checkInvalid('</br>', '', 'HTML_UNEXPECTED_END_TAG');
});

test('闭标签齐全但会被 parser 重排的嵌套也必须拒绝，位置不受 custom 展开影响', () => {
  for (const html of ['<table><div>文字</div></table>', '<table>文字<tr><td>格</td></tr></table>', '<h1><h2>标题</h2></h1>', '<a><a>嵌套链接</a></a>', '<section><tr><td>被丢弃的行</td></tr></section>']) checkInvalid(html, '', 'HTML_INVALID_NESTING');
  const source = '<section>\n<restaurant-name/><h1><h2>标题</h2></h1></section>';
  const result = checkInvalid(source, '', 'HTML_INVALID_NESTING');
  assert.ok(result.diagnostics.some(d => d.code === 'HTML_INVALID_NESTING' && d.line === 2 && d.column === 23));
});

test('坏属性和完整 document 返回片段诊断，不会静默丢掉 head', () => {
  const bad = checkInvalid('<main>\n<div class="a" class="b">内容</div>\n</main>', '', 'HTML_SYNTAX_ERROR');
  assert.ok(bad.diagnostics.some(d => d.line === 2 && d.column > 1));
  checkInvalid('<p title="缺结束>文字</p>', '', 'HTML_SYNTAX_ERROR');
  checkInvalid('<!DOCTYPE html><html><head><title>隐私</title></head><body><p>正文</p></body></html>', '', 'BODY_FRAGMENT_REQUIRED');
  checkInvalid('<body><main>正文</main></body>', '', 'BODY_FRAGMENT_REQUIRED');
});

test('CSS 真语法错误有行列，缺括号和缺结束大括号不假成功', () => {
  const result = checkInvalid('<p>文字</p>', 'p{color:red}\nmain {\n  color: rgb(1, 2, 3;\n}', 'CSS_UNCLOSED_DELIMITER', 'styles.css');
  assert.ok(result.diagnostics.some(d => d.code === 'CSS_UNCLOSED_DELIMITER' && d.line === 3 && d.column === 10));
  checkInvalid('<p>文字</p>', 'p { color:red', 'CSS_UNCLOSED_DELIMITER', 'styles.css');
  checkInvalid('<p>文字</p>', 'p { color:red; ] }', 'CSS_UNEXPECTED_DELIMITER', 'styles.css');
  const badValue = checkInvalid('<p>文字</p>', 'p{\n  color:"no";\n}', 'CSS_VALUE_INVALID', 'styles.css');
  assert.ok(badValue.diagnostics.some(d => d.line === 2 && d.column === 9));
  checkInvalid('<p>文字</p>', 'p{color red}', 'CSS_SYNTAX_ERROR', 'styles.css');
  checkInvalid('<p>文字</p>', 'p{color:red padding:5px}', 'CSS_SYNTAX_ERROR', 'styles.css');
  checkInvalid('<p>文字</p>', 'p{--x:"unterminated}', 'CSS_SYNTAX_ERROR', 'styles.css');
  checkInvalid('<p>文字</p>', '/*未关闭', 'CSS_SYNTAX_ERROR', 'styles.css');
});

test('内联样式使用同一 CSS 检查且诊断定位 HTML 属性', () => {
  const bad = checkInvalid('<main>\n  <p style="color:red; background:url(#x)">内容</p>\n</main>', '', 'CSS_URL_FORBIDDEN');
  assert.ok(bad.diagnostics.some(d => d.line === 2 && d.column >= 12 && d.code === 'CSS_URL_FORBIDDEN'));
  checkInvalid('<p style="color:rgb(1,2,3">内容</p>', '', 'CSS_UNCLOSED_DELIMITER');
  checkInvalid('<p style="color:&quot;no&quot;">内容</p>', '', 'CSS_VALUE_INVALID');
  const encoded = '<p style="--x:&quot;q&quot;; color:&quot;no&quot;">内容</p>';
  const encodedResult = checkInvalid(encoded, '', 'CSS_VALUE_INVALID');
  assert.ok(encodedResult.diagnostics.some(d => d.code === 'CSS_VALUE_INVALID' && d.column === encoded.indexOf('&quot;no') + 1));
});

test('安全拒绝事件、活动命名空间和所有未受控加载或导航属性', () => {
  for (const html_body of ['<div ONPOINTERENTER="x()">文字</div>', '<p srcdoc="私有"></p>', '<math><mtext>文字</mtext></math>', '<svg><animate></animate></svg>', '<html:div>文字</html:div>', '<safe-card xmlns="https://example.com"></safe-card>', '<p xlink:href="javascript:alert(1)">文字</p>', '<button formaction="https://example.com">发送</button>', '<img srcset="https://example.com/x 1x">', '<a ping="https://example.com">文字</a>', '<video poster="https://example.com"></video>', '<template><img src="https://example.com"></template>', '<div is="active-element"></div>']) {
    const result = inspectWebsite({ ...output, html_body }, snapshot);
    assert.equal(result.valid, false, html_body);
    assert.equal(result.rendered, undefined);
  }
});

test('CSS Raw、自定义变量和转义名称也不能绕过 URL、执行与导入检查', () => {
  for (const css of ['p{--image:url(#x);background:var(--image)}', '@future-rule url(https://example.com) {}', String.raw`p{background:u\72l("https://example.com")}`, String.raw`@\69mport "https://example.com";`, String.raw`p{b\65havior: e\78pression(alert(1))}`, 'p{background:image-set("https://example.com/x" 1x)}', 'p{--src:"https://example.com";background:image-set(var(--src) 1x)}', 'p{background:src("https://example.com")}']) {
    const result = inspectWebsite({ ...output, css }, snapshot);
    assert.equal(result.valid, false, css);
    assert.equal(result.rendered, undefined);
    assert.ok(result.diagnostics.some(d => ['CSS_URL_FORBIDDEN', 'CSS_EXECUTION_FORBIDDEN', 'CSS_ATRULE_FORBIDDEN'].includes(d.code)), JSON.stringify(result.diagnostics));
  }
  for (const content of ['"伪造文字"', 'attr(title)', 'var(--price)', 'counter(item)', 'open-quote', '"—"']) checkInvalid('<p>内容</p>', `p::before{content:${content}}`, 'CSS_CONTENT_FORBIDDEN', 'styles.css');
  for (const content of ['none', 'normal', '""', "''"]) assert.equal(inspectWebsite({ ...output, css: `p::before{content:${content}}` }, snapshot).valid, true);
});

test('普通 img 必须精确匹配图片清单，alt 转义且有长度和尺寸检查', () => {
  const good = inspectWebsite({ ...output, html_body: `<img src="__SITE_ASSET_${aid}__" alt="&quot; onerror=&quot;不执行 &lt;script&gt;" width="32" height="24">` }, mediaSnapshot);
  assert.equal(good.valid, true, JSON.stringify(good.diagnostics));
  assert.ok(good.rendered!.html.includes('alt="&quot; onerror=&quot;不执行 &lt;script&gt;"'));
  for (const src of ['https://example.com', '/api/v1/private', 'data:image/png;base64,eA==', 'javascript:alert(1)', `__SITE_ASSET_${pdfId}__`, '__SITE_ASSET_ast_' + 'z'.repeat(24) + '__', `__SITE_ASSET_${aid}__?x=1`]) {
    const result = inspectWebsite({ ...output, html_body: `<img src="${src}">` }, mediaSnapshot);
    assert.equal(result.valid, false, src);
    assert.ok(result.diagnostics.some(d => d.code === 'HTML_IMAGE_INVALID'));
  }
  for (const attrs of ['width="-1"', 'height="NaN"', 'width="1 onerror=x"', `alt="${'长'.repeat(501)}"`]) assert.equal(inspectWebsite({ ...output, html_body: `<img src="__SITE_ASSET_${aid}__" ${attrs}>` }, mediaSnapshot).valid, false);
});

test('anchor 仅支持本地锚点、快照联系方式与菜单源占位符', () => {
  const valid = inspectWebsite({ ...output, html_body: `<nav><a href="#菜单">菜单</a><a href="#">首页</a><a href="mailto:hello@example.com">联系</a><a href="tel:+12345678901">电话</a><a href="__SITE_ASSET_${pdfId}__" target="_blank" rel="opener">菜单文件</a></nav>` }, mediaSnapshot);
  assert.equal(valid.valid, true, JSON.stringify(valid.diagnostics));
  assert.ok(valid.rendered!.html.includes('rel="noopener noreferrer"'));
  assert.ok(!valid.rendered!.html.includes('rel="opener"'));
  for (const href of ['https://example.com', '//example.com', '/api/v1/menu', 'data:text/html,test', 'javascript:alert(1)', 'java&#x73;cript:alert(1)', 'mailto:someone@example.com', 'tel:+999', 'mailto:hello@example.com?body=private', `__SITE_ASSET_${aid}__`]) {
    const result = inspectWebsite({ ...output, html_body: `<a href="${href}">文字</a>` }, mediaSnapshot);
    assert.equal(result.valid, false, href);
    assert.ok(result.diagnostics.some(d => d.code === 'HTML_LINK_FORBIDDEN'));
  }
});

test('实体与自由文案被转义，而不是过滤成十四个标签；脚本文本不会干扰栈诊断', () => {
  const html_body = '<section><p>Our fresh idea &amp; &lt;script&gt;not executable&lt;/script&gt; &quot;引号&quot; &#39;单引号&#39;</p></section>';
  const result = renderWebsite({ ...output, html_body }, snapshot);
  assert.ok(result.html.includes('Our fresh idea &amp; &lt;script&gt;not executable&lt;/script&gt; &quot;引号&quot; &#39;单引号&#39;'));
  assert.ok(!result.html.includes('&amp;lt;'));
  const script = checkInvalid('<section><script>const text="</section><h1>";</script></section>', '', 'HTML_TAG_FORBIDDEN');
  assert.ok(!script.diagnostics.some(d => d.code === 'HTML_MISSING_END_TAG' || d.code === 'HTML_UNEXPECTED_END_TAG'));
});

test('菜单冻结快照价格不受组件子内容替换，review_note/warnings/summary 不公开', () => {
  const menu = { revision: 7, data: { categories: [{ name: '确认分类', items: [{ name: '确认菜品 <新>', description: '确认介绍 & 好吃', price_text: '€18.50', review_note: '内部审核备注 secret-note' }] }], warnings: ['内部识别警告 secret-warning'] } };
  Object.freeze(menu.data.categories[0]!.items[0]);
  Object.freeze(menu.data.categories[0]!.items);
  Object.freeze(menu.data.categories[0]);
  Object.freeze(menu.data.categories);
  Object.freeze(menu.data.warnings);
  Object.freeze(menu.data);
  Object.freeze(menu);
  const input = { ...mediaSnapshot, menu };
  const before = JSON.stringify(input);
  const result = inspectWebsite({ html_body: '<restaurant-menu><p>替换组件原价 $99</p></restaurant-menu><p>模型文案仍保留，验证器不判断虚构</p>', css: '', summary: '内部摘要 secret-summary' }, input);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  const html = result.rendered!.html;
  assert.ok(html.includes('data-menu-revision="7"') && html.includes('确认菜品 &lt;新&gt;') && html.includes('€18.50'));
  assert.ok(html.includes('确认介绍 &amp; 好吃') && html.includes('模型文案仍保留'));
  for (const privateText of ['secret-note', 'secret-warning', 'secret-summary', '$99', 'WARNING_FACT_CHILDREN']) assert.ok(!html.includes(privateText), privateText);
  assert.ok(result.diagnostics.some(d => d.code === 'WARNING_FACT_CHILDREN'));
  assert.ok(result.diagnostics.some(d => d.code === 'WARNING_FACT_FALLBACK'));
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(renderWebsite({ html_body: '<restaurant-menu><p>替换组件原价 $99</p></restaurant-menu><p>模型文案仍保留，验证器不判断虚构</p>', css: '', summary: '' }, input), result.rendered);
});

test('fallback warning 非致命且不进入公开 HTML；菜单缺组件仍由后端补齐', () => {
  const result = inspectWebsite({ html_body: '<main><p>自定义介绍</p></main>', css: '', summary: '' }, snapshot);
  assert.equal(result.valid, true);
  assert.ok(result.diagnostics.some(d => d.code === 'WARNING_FACT_FALLBACK'));
  assert.ok(result.rendered!.html.includes('site-required') && result.rendered!.html.includes('10 Sample Street'));
  assert.ok(!result.rendered!.html.includes(result.diagnostics[0]!.message));
  const all = inspectWebsite({ html_body: [...['name', 'description', 'address', 'contact', 'hours', 'menu']].map(name => `<restaurant-${name}/>`).join(''), css: '', summary: '' }, snapshot);
  assert.equal(all.valid, true, JSON.stringify(all.diagnostics));
  assert.deepEqual(all.diagnostics, []);
});

test('诊断至多 20 条、消息不含原文和 PII，render invalid 统一抛自定义错误', () => {
  const privateText = 'secret-person@example.com';
  const result = checkInvalid(Array.from({ length: 30 }, () => `<p onclick="${privateText}">${privateText}</p>`).join('\n'), 'p{color:"private"}', 'HTML_ATTRIBUTE_FORBIDDEN');
  assert.equal(result.diagnostics.length, 20);
  assert.ok(!JSON.stringify(result.diagnostics).includes(privateText));
  assert.throws(() => renderWebsite({ html_body: `<script>${privateText}</script>`, css: '', summary: privateText }, snapshot), error => {
    assert.ok(error instanceof WebsiteValidationError);
    assert.ok(!error.message.includes(privateText));
    assert.ok(!JSON.stringify(error.diagnostics).includes(privateText));
    assert.equal(error.message, '网站 HTML/CSS 校验失败');
    return true;
  });
});

test('源码、编译体积、节点与深度预算不被放宽', () => {
  checkInvalid('x'.repeat(100 * 1024 + 1), '', 'SOURCE_TOO_LARGE');
  checkInvalid('<p>字</p>', ' '.repeat(40 * 1024 + 1), 'SOURCE_TOO_LARGE', 'styles.css');
  checkInvalid(`<p style="${' '.repeat(40 * 1024 + 1)}">字</p>`, '', 'SOURCE_TOO_LARGE');
  checkInvalid(`<p style="${' '.repeat(21 * 1024)}">字</p>`, ' '.repeat(20 * 1024), 'SOURCE_TOO_LARGE', 'styles.css');
  checkInvalid('"'.repeat(40 * 1024), '', 'COMPILED_TOO_LARGE');
  checkInvalid('<div>'.repeat(82) + '字' + '</div>'.repeat(82), '', 'STRUCTURE_TOO_LARGE');
  checkInvalid('<hr>'.repeat(5001), '', 'STRUCTURE_TOO_LARGE');
  checkInvalid('<p>字</p>', 'p{--x:' + 'future('.repeat(82) + '1' + ')'.repeat(82) + '}', 'STRUCTURE_TOO_LARGE', 'styles.css');
  checkInvalid('<p>\0</p>', '', 'HTML_SYNTAX_ERROR');
});

test('不合法菜单快照不是假成功，错误不会泄漏内部警告', () => {
  const bad = { ...snapshot, menu: { revision: 0, data: { categories: [], warnings: ['内部警告'] } } };
  const result = inspectWebsite({ html_body: '<restaurant-menu/>', css: '', summary: '' }, bad);
  assert.equal(result.valid, false);
  assert.equal(result.rendered, undefined);
  assert.ok(result.diagnostics.some(d => d.code === 'SNAPSHOT_INVALID'));
  assert.ok(!JSON.stringify(result.diagnostics).includes('内部警告'));
});

test('运行隔离和受控事实布局保留，公开文档再解析不产生活动节点', () => {
  const html = renderWebsite({ ...output, html_body: '<p title="&quot;&gt;&lt;script&gt;">&lt;img onerror=alert(1)&gt;</p>' }, snapshot).html;
  assert.ok(WEBSITE_CSP.includes("script-src 'none'") && WEBSITE_CSP.includes("connect-src 'none'") && WEBSITE_CSP.includes("form-action 'none'"));
  assert.equal(WEBSITE_SANDBOX, 'sandbox allow-popups allow-popups-to-escape-sandbox allow-downloads');
  const tree = parse(html);
  const visit = (node: { nodeName: string; childNodes?: unknown[]; attrs?: Array<{ name: string }> }) => {
    assert.ok(!['script', 'iframe', 'form', 'input', 'svg', 'math'].includes(node.nodeName));
    assert.ok(!node.attrs?.some(attr => attr.name.startsWith('on')));
    for (const child of node.childNodes ?? []) visit(child as typeof node);
  };
  visit(tree);
});

const componentSnapshot: WebsiteSnapshot = { ...mediaSnapshot, menu: { revision: 9, data: { categories: [{ name: '已确认分类', items: [{ name: '真实菜品 <文字>', description: '介绍 & 配料', price_text: '$18.00', review_note: '内部审核不可公开' }] }], warnings: ['内部识别警告不可公开'] } } };

function assertCompiledParents(html: string) {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const root = document.childNodes.find(node => 'tagName' in node && node.tagName === 'html') as DefaultTreeAdapterMap['element'];
  const body = root.childNodes.find(node => 'tagName' in node && node.tagName === 'body') as DefaultTreeAdapterMap['element'];
  const start = body.sourceCodeLocation!.startTag!.endOffset, end = body.sourceCodeLocation!.endTag!.startOffset;
  const source = html.slice(start, end);
  const stack: Token.TagToken[] = [], parents = new Map<number, number | undefined>();
  const texts: Array<{ start: number; end: number; parent: number | undefined }> = [];
  const text = (token: Token.CharacterToken) => texts.push({ start: token.location!.startOffset, end: token.location!.endOffset, parent: stack.at(-1)?.location?.startOffset });
  const tokenizer = new Tokenizer({ sourceCodeLocationInfo: true }, {
    onStartTag(token) {
      parents.set(token.location!.startOffset, stack.at(-1)?.location?.startOffset);
      if (!['area', 'br', 'col', 'hr', 'img', 'wbr'].includes(token.tagName)) stack.push(token);
    },
    onEndTag(token) { assert.equal(stack.pop()?.tagName, token.tagName); },
    onCharacter: text, onWhitespaceCharacter: text, onNullCharacter: text,
    onEof() { assert.equal(stack.length, 0); },
    onComment() {}, onDoctype() { assert.fail('body 不应含 doctype'); },
    onParseError(error) { assert.fail(error.code); },
  });
  tokenizer.write(source, true);
  const visited = new Set<number>(), visitedTexts = new Set<number>();
  const visit = (node: DefaultTreeAdapterMap['node'], parent?: number) => {
    const loc = 'sourceCodeLocation' in node ? node.sourceCodeLocation : undefined;
    if (node.nodeName === '#text') {
      assert.ok(loc);
      for (let i = 0; i < texts.length; i++) {
        const expected = texts[i]!;
        if (expected.start >= loc.startOffset - start && expected.end <= loc.endOffset - start) {
          assert.equal(expected.parent, parent);
          visitedTexts.add(i);
        }
      }
      return;
    }
    if (!('tagName' in node)) return;
    assert.ok(loc, `不允许 parser 自动插入 ${node.tagName}`);
    const offset = loc.startOffset - start;
    assert.ok(parents.has(offset), `不允许 parser 重建 ${node.tagName}`);
    assert.ok(!visited.has(offset), `不允许 parser 复制 ${node.tagName}`);
    assert.equal(parents.get(offset), parent, `父子结构必须保持：${node.tagName}`);
    visited.add(offset);
    for (const child of node.childNodes) visit(child, offset);
  };
  for (const node of body.childNodes) visit(node);
  assert.equal(visited.size, parents.size, '不允许 parser 丢弃编译元素');
  assert.equal(visitedTexts.size, texts.length, '不允许 parser 移动或丢弃编译文本');
  const shape = (node: DefaultTreeAdapterMap['node']): unknown => node.nodeName === '#text' ? (node as DefaultTreeAdapterMap['textNode']).value : 'tagName' in node ? { tag: node.tagName, attrs: node.attrs, children: node.childNodes.map(shape) } : null;
  const reparsed = parseFragment(body, serialize(body), {});
  assert.deepEqual(reparsed.childNodes.map(shape), body.childNodes.map(shape), '序列化再解析的最终 body 结构必须稳定');
  return body;
}

test('menu/hours/image 不能进入 p、标题或内联祖先，错误定位原始组件标签', () => {
  const parents = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'strong', 'em', 'code', 'pre', 'button', 'summary', 'a'];
  for (const tag of ['restaurant-menu', 'restaurant-hours', 'restaurant-image']) {
    for (const parent of parents) {
      const html_body = `<section><safe-card/>\n  <${parent}>\n    <${tag}${tag === 'restaurant-image' ? ` data-asset-id="${aid}"` : ''}></${tag}>\n  </${parent}></section>`;
      const result = inspectWebsite({ ...output, html_body }, componentSnapshot);
      assert.equal(result.valid, false, `${parent}/${tag}`);
      assert.equal(result.rendered, undefined);
      const errors = result.diagnostics.filter(d => !d.code.startsWith('WARNING_'));
      assert.deepEqual(errors.map(d => ({ file: d.file, line: d.line, column: d.column, code: d.code })), [{ file: 'index.html', line: 3, column: 5, code: 'COMPILED_INVALID_NESTING' }]);
      assert.ok(errors[0]!.message.includes('section/div'));
      assert.throws(() => renderWebsite({ ...output, html_body }, componentSnapshot), { code: 'WEBSITE_HTML_INVALID' });
    }
    const indirect = `<section><p><safe-layout><${tag}${tag === 'restaurant-image' ? ` data-asset-id="${aid}"` : ''}/></safe-layout></p></section>`;
    assert.equal(inspectWebsite({ ...output, html_body: indirect }, componentSnapshot).valid, false, '不能隔一个 custom tag 绕过内联祖先检查');
  }
});

test('外层 a 内 contact 和带菜单源链接的 menu 均拒绝，不受 snapshot 缺联系方式影响', () => {
  for (const tag of ['restaurant-contact', 'restaurant-menu']) {
    for (const fixture of [componentSnapshot, { ...snapshot, opening_hours: [], restaurant: { ...snapshot.restaurant, contact_email: null, contact_phone: null } }]) {
      const html_body = `<main><restaurant-name/>\n<a href="#contact"><safe-layout>\n  <${tag}/></safe-layout></a></main>`;
      const result = inspectWebsite({ ...output, html_body }, fixture);
      assert.equal(result.valid, false);
      assert.equal(result.rendered, undefined);
      assert.deepEqual(result.diagnostics.filter(d => !d.code.startsWith('WARNING_')).map(d => [d.file, d.line, d.column, d.code]), [['index.html', 3, 3, 'COMPILED_INVALID_NESTING']]);
      assert.ok(!JSON.stringify(result.diagnostics).includes('hello@example.com'));
    }
  }
});

test('块组件在 section/aside/div/custom 流容器内输出 div，最终解析和序列化父子结构相同', () => {
  const html_body = `<main><h1><restaurant-name/></h1><p><restaurant-description/></p><h2><restaurant-cuisine/></h2>
    <section><p>段落在组件外</p><restaurant-menu id="confirmed-menu" class="menu"/><p>组件之后的自由文案</p></section>
    <aside><restaurant-hours id="confirmed-hours" class="hours"/></aside>
    <div><restaurant-image id="confirmed-image" data-asset-id="${aid}"/></div>
    <safe-layout><restaurant-menu/><restaurant-hours/></safe-layout>
    <p><strong><restaurant-contact/></strong></p><a href="#confirmed-menu"><restaurant-name/></a>
    <table><tr><td>标准省略 tbody</td></tr></table></main>`;
  const result = inspectWebsite({ html_body, css: '@future-pure-rule future-style(1){.menu{color:oklch(.6 .1 40)}}', summary: '内部摘要不可公开' }, componentSnapshot);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  const html = result.rendered!.html;
  for (const id of ['confirmed-menu', 'confirmed-hours', 'confirmed-image']) assert.ok(html.includes(`<div id="${id}"`), id);
  assert.ok(html.includes('data-menu-revision="9"') && html.includes('$18.00') && html.includes('18:00–01:00'));
  assert.ok(html.includes('mailto:hello@example.com') && html.includes(`__SITE_ASSET_${pdfId}__`));
  assert.ok(html.includes('组件之后的自由文案') && html.includes('真实菜品 &lt;文字&gt;'));
  for (const hidden of ['内部审核不可公开', '内部识别警告不可公开', '内部摘要不可公开']) assert.ok(!html.includes(hidden));
  assertCompiledParents(html);
  assert.deepEqual(renderWebsite({ html_body, css: '@future-pure-rule future-style(1){.menu{color:oklch(.6 .1 40)}}', summary: '' }, componentSnapshot), result.rendered);
});

test('最终校验使用真正 body 上下文，而非模板 fragment；原生孤立表格节点也必须拒绝', () => {
  for (const html_body of ['<tr><td>不在 table 内</td></tr>', '<colgroup><col></colgroup>', '<thead><tr><th>孤立表头</th></tr></thead>']) {
    const result = checkInvalid(html_body, '', 'COMPILED_INVALID_NESTING');
    assert.ok(!result.diagnostics.some(d => d.code === 'HTML_INVALID_NESTING'), '源模板 fragment 可解析，但最终 body 不能丢弃元素');
  }
  const html_body = '\n  <tr><td>内容</td></tr>';
  const result = checkInvalid(html_body, '', 'COMPILED_INVALID_NESTING');
  assert.ok(result.diagnostics.some(d => d.code === 'COMPILED_INVALID_NESTING' && d.line === 2 && d.column === 3));
});

test('空资料和事实 fallback 也保留合法块包装，模型和快照文本转义不泄内部备注', () => {
  const empty = { ...snapshot, opening_hours: [], restaurant: { ...snapshot.restaurant, contact_email: null, contact_phone: null } };
  const valid = inspectWebsite({ html_body: '<section><restaurant-menu/><restaurant-hours/></section><p><restaurant-contact/></p>', css: '', summary: '' }, empty);
  assert.equal(valid.valid, true, JSON.stringify(valid.diagnostics));
  assert.ok(valid.rendered!.html.includes('<section><div>Please contact the restaurant for the menu.</div><div>Please contact the restaurant for opening hours.</div></section>'));
  assertCompiledParents(valid.rendered!.html);
  const raw = { ...componentSnapshot, restaurant: { ...componentSnapshot.restaurant, description: '<p>确认文本 & 不执行</p><a href="javascript:alert(1)">文案</a>' } };
  const result = inspectWebsite({ html_body: '<p><restaurant-description/></p><section><restaurant-menu/><restaurant-hours/></section><p>模型原文 &lt;p&gt;并非标签&lt;/p&gt;</p>', css: '', summary: '内部摘要不可公开' }, raw);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.ok(result.rendered!.html.includes('&lt;p&gt;确认文本 &amp; 不执行&lt;/p&gt;'));
  assert.ok(result.rendered!.html.includes('模型原文 &lt;p&gt;并非标签&lt;/p&gt;'));
  assert.ok(!result.rendered!.html.includes('内部审核不可公开') && !result.rendered!.html.includes('内部识别警告不可公开'));
  assertCompiledParents(result.rendered!.html);
  const fallback = inspectWebsite({ html_body: '<main><p>仅布局文案</p></main>', css: '', summary: '' }, raw);
  assert.equal(fallback.valid, true, JSON.stringify(fallback.diagnostics));
  assertCompiledParents(fallback.rendered!.html);
});

test('编译运行时事实的语法错误也被最终 gate 检测，定位组件而不泄事实文本', () => {
  const fixture = { ...snapshot, restaurant: { ...snapshot.restaurant, description: '私有文本\0private@example.com' } };
  const result = inspectWebsite({ html_body: '<section><safe-card/>\n  <restaurant-description/></section>', css: '', summary: '' }, fixture);
  assert.equal(result.valid, false);
  assert.equal(result.rendered, undefined);
  assert.ok(result.diagnostics.some(d => d.code === 'COMPILED_INVALID_NESTING' && d.file === 'index.html' && d.line === 2 && d.column === 3));
  assert.ok(!JSON.stringify(result.diagnostics).includes('private@example.com') && !JSON.stringify(result.diagnostics).includes('私有文本'));
});
