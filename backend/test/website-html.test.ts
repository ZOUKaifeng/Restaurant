import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderWebsite, type WebsiteSnapshot } from '../src/website-html.js';
const snapshot: WebsiteSnapshot = { restaurant: { id: 'rst_sample', name: '真实名称 <餐厅>', description: '商家确认的介绍', cuisine_type: 'Italian', address_line1: '10 Sample Street', address_line2: null, city: 'Sample City', region: null, postal_code: null, country_code: 'US', contact_email: 'hello@example.com', contact_phone: '+1 234 567 8901', timezone: 'America/New_York', currency: 'USD', primary_locale: 'en' }, opening_hours: [{ weekday: 1, opens_at_local: '18:00', closes_at_local: '01:00', closes_day_offset: 1 }], assets: [] };
const output = { html_body: '<main><h1><restaurant-name></restaurant-name></h1><p>About</p><p>Invented award 2026 and $99 price</p><restaurant-description></restaurant-description></main>', css: ':root{--accent:#163d2b}main{padding:clamp(20px,5vw,70px);color:var(--accent)}@media(max-width:600px){main{padding:20px}}', summary: 'test' };
test('生成HTML使用确认事实，删除模型虚构文本并补固定资料，不添加真实预订表单', () => {
  const result = renderWebsite(output, snapshot);
  assert.ok(result.html.includes('真实名称 &lt;餐厅&gt;'));
  assert.ok(result.html.includes('商家确认的介绍') && result.html.includes('10 Sample Street'));
  assert.ok(result.html.includes('18:00–01:00 (next day)'));
  assert.ok(!result.html.includes('Invented award') && !result.html.includes('$99'));
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
test('素材仅限确认清单，图片与菜单占位符可替换但不带私有地址', () => {
  const aid = 'ast_' + 'a'.repeat(24), unknown = 'ast_' + 'b'.repeat(24);
  const media = { ...snapshot, assets: [{ id: aid, kind: 'menu_source', mime_type: 'image/png', checksum: 'a'.repeat(64), width_px: 10, height_px: 10 }] };
  const html = renderWebsite({ ...output, html_body: `<restaurant-image data-asset-id="${unknown}"></restaurant-image><restaurant-menu></restaurant-menu>` }, media).html;
  assert.ok(html.includes(`__SITE_ASSET_${aid}__`) && !html.includes(unknown));
  assert.ok(!html.includes('storage_key') && !html.includes('/api/v1/'));
});
