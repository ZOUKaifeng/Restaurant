import { createHash } from 'node:crypto';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import * as cssTree from 'css-tree';
import { ApiError } from './errors.js';
import { normalizeMenuData, type ConfirmedMenuSnapshot } from './menu-data.js';

export interface WebsiteSnapshot {
  menu?: ConfirmedMenuSnapshot | null;
  restaurant: { id: string; name: string; description: string | null; cuisine_type: string | null; address_line1: string | null; address_line2: string | null; city: string | null; region: string | null; postal_code: string | null; country_code: string | null; contact_email: string | null; contact_phone: string | null; timezone: string | null; currency: string | null; primary_locale: string };
  opening_hours: Array<{ weekday: number; opens_at_local: string; closes_at_local: string; closes_day_offset: number }>;
  assets: Array<{ id: string; kind: string; mime_type: string; checksum: string; width_px: number | null; height_px: number | null }>;
}
export const WEBSITE_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' blob: data:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export const WEBSITE_SANDBOX = 'sandbox allow-popups allow-popups-to-escape-sandbox allow-downloads';
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
export function assetPlaceholder(id: string): string {
  if (!/^ast_[A-Za-z0-9_-]{24}$/.test(id)) throw new ApiError(503, 'WEBSITE_MANIFEST_INVALID');
  return `__SITE_ASSET_${id}__`;
}
const tags = new Set('section header footer main nav div article aside h1 h2 h3 p span strong em small ul ol li br hr a'.split(' '));
const labels = new Set('Welcome|About|Our story|Menu|Visit us|Contact|Opening hours|Gallery|Discover|Explore|Home|Restaurant|Cuisine|Find us|欢迎|关于我们|我们的故事|菜单|到店指南|联系我们|营业时间|图集|首页|餐厅|菜系|地址'.split('|'));
const tokenTags = new Set(['restaurant-name', 'restaurant-description', 'restaurant-cuisine', 'restaurant-address', 'restaurant-contact', 'restaurant-hours', 'restaurant-menu', 'restaurant-image']);
function invalid(): never { throw new ApiError(503, 'WEBSITE_HTML_INVALID'); }
function safeCss(source: string): string {
  if (Buffer.byteLength(source) > 40 * 1024 || source.includes('<') || source.includes('\0')) invalid();
  let tree: cssTree.CssNode;
  try { tree = cssTree.parse(source, { parseValue: true, parseCustomProperty: true, parseRulePrelude: true, onParseError: () => invalid() }); } catch { invalid(); }
  cssTree.walk(tree!, node => {
    if (node.type === 'Raw' || node.type === 'Url') invalid();
    if (node.type === 'Atrule' && !['media', 'supports', 'keyframes'].includes(node.name.toLowerCase())) invalid();
    if (node.type === 'Function' && !/^(?:rgb|rgba|hsl|hsla|calc|min|max|clamp|var|linear-gradient|radial-gradient|repeat|translate|translatex|translatey|scale|rotate|cubic-bezier|steps|not|is|where|nth-child|nth-of-type)$/i.test(node.name)) invalid();
    if (node.type === 'Declaration') {
      if (!/^(?:--[a-z0-9-]+|[a-z-]+)$/i.test(node.property) || ['behavior', '-moz-binding'].includes(node.property.toLowerCase())) invalid();
      if (node.property.toLowerCase() === 'content' && !/^(?:none|normal|""|'')$/.test(cssTree.generate(node.value))) invalid();
    }
  });
  return cssTree.generate(tree!);
}
export function renderWebsite(output: { html_body: string; css: string; summary: string }, snapshot: WebsiteSnapshot): { html: string; checksum: string } {
  if (typeof output.html_body !== 'string' || Buffer.byteLength(output.html_body) > 100 * 1024 || typeof output.css !== 'string' || output.html_body.includes('\0')) invalid();
  if (!snapshot.restaurant.name || snapshot.assets.length > 8) invalid();
  const imageIds = new Set(snapshot.assets.filter(a => a.mime_type !== 'application/pdf').map(a => a.id));
  const seen = new Set<string>();
  const renderedImages = new Set<string>();
  const r = snapshot.restaurant;
  const chinese = r.primary_locale.startsWith('zh');
  const generic = (en: string, zh: string) => chinese ? zh : en;
  const component = (tag: string, attrs: Map<string, string>): string => {
    seen.add(tag);
    if (tag === 'restaurant-name') return escapeHtml(r.name);
    if (tag === 'restaurant-description') return escapeHtml(r.description ?? '');
    if (tag === 'restaurant-cuisine') return escapeHtml(r.cuisine_type ?? '');
    if (tag === 'restaurant-address') return escapeHtml([r.address_line1, r.address_line2, r.city, r.region, r.postal_code, r.country_code].filter(Boolean).join(', '));
    if (tag === 'restaurant-contact') {
      const links: string[] = [];
      if (r.contact_email && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(r.contact_email)) links.push(`<a href="mailto:${escapeHtml(encodeURIComponent(r.contact_email).replaceAll('%40', '@'))}">${escapeHtml(r.contact_email)}</a>`);
      if (r.contact_phone && /^[+0-9() .-]{3,40}$/.test(r.contact_phone)) links.push(`<a href="tel:${escapeHtml(r.contact_phone.replace(/[^+0-9]/g, ''))}">${escapeHtml(r.contact_phone)}</a>`);
      return links.join(' · ') || escapeHtml(generic('Contact details have not been provided.', '餐厅尚未提供联系方式。'));
    }
    if (tag === 'restaurant-hours') {
      if (!snapshot.opening_hours.length) return escapeHtml(generic('Please contact the restaurant for opening hours.', '请联系餐厅确认营业时间。'));
      const days = chinese ? ['周一','周二','周三','周四','周五','周六','周日'] : ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
      return `<ul class="site-hours">${snapshot.opening_hours.map(h => `<li>${escapeHtml(days[h.weekday - 1])} ${escapeHtml(h.opens_at_local)}–${escapeHtml(h.closes_at_local)}${h.closes_day_offset ? escapeHtml(generic(' (next day)', '（次日）')) : ''}</li>`).join('')}</ul>${r.timezone ? `<small>${escapeHtml(r.timezone)}</small>` : ''}`;
    }
    if (tag === 'restaurant-menu') {
      const menu = snapshot.assets.find(a => a.kind === 'menu_source');
      let structured = '';
      if (snapshot.menu) {
        const data = normalizeMenuData(snapshot.menu.data, true);
        if (!Number.isSafeInteger(snapshot.menu.revision) || snapshot.menu.revision < 1) invalid();
        structured = `<div class="site-menu" data-menu-revision="${snapshot.menu.revision}">${data.categories.map(category => `<section class="site-menu-category"><h3>${escapeHtml(category.name)}</h3><ul>${category.items.map(item => `<li class="site-menu-item"><div class="site-menu-item-heading"><strong>${escapeHtml(item.name)}</strong>${item.price_text !== null ? `<span class="site-menu-price">${escapeHtml(item.price_text)}</span>` : ''}</div>${item.description ? `<p class="site-menu-description">${escapeHtml(item.description)}</p>` : ''}</li>`).join('')}</ul></section>`).join('')}</div>`;
      }
      const file = menu ? `<a class="site-menu-link" href="${assetPlaceholder(menu.id)}" download="${menu.mime_type === 'application/pdf' ? 'menu.pdf' : 'menu-image'}" target="_blank" rel="noopener noreferrer">${escapeHtml(generic('View menu file', '查看菜单原文件'))}</a>` : '';
      return structured + file || escapeHtml(generic('Please contact the restaurant for the menu.', '请联系餐厅获取菜单。'));
    }
    if (tag === 'restaurant-image') {
      const aid = attrs.get('data-asset-id');
      if (!aid || !imageIds.has(aid) || renderedImages.has(aid)) return '';
      renderedImages.add(aid);
      const asset = snapshot.assets.find(a => a.id === aid)!;
      return `<img src="${assetPlaceholder(aid)}" alt="${escapeHtml(r.name)}" width="${asset.width_px ?? 1}" height="${asset.height_px ?? 1}" loading="lazy" decoding="async">`;
    }
    return '';
  };
  let count = 0;
  const render = (node: DefaultTreeAdapterMap['node'], depth = 0): string => {
    if (++count > 5000 || depth > 80) invalid();
    if (node.nodeName === '#text') {
      const value = (node as DefaultTreeAdapterMap['textNode']).value;
      return value.trim() ? labels.has(value.trim()) ? escapeHtml(value) : '' : ' ';
    }
    if (!('tagName' in node)) return '';
    if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml') invalid();
    const tag = node.tagName.toLowerCase();
    if (!tags.has(tag) && !tokenTags.has(tag)) invalid();
    const attrs = new Map(node.attrs.map(a => [a.name, a.value]));
    if (node.attrs.some(a => a.name.startsWith('on') || a.name === 'style' || a.name === 'srcdoc')) invalid();
    let attributes = '';
    for (const key of ['class', 'id']) {
      const value = attrs.get(key);
      if (value && (key === 'class' ? /^[A-Za-z0-9_ -]{1,240}$/ : /^[A-Za-z][A-Za-z0-9_-]{0,80}$/).test(value)) attributes += ` ${key}="${escapeHtml(value)}"`;
    }
    if (tokenTags.has(tag)) {
      const value = component(tag, attrs);
      return tag === 'restaurant-image' ? `<div${attributes}>${value}</div>` : `<span${attributes}>${value}</span>`;
    }
    if (tag === 'a') {
      const href = attrs.get('href');
      if (href && /^#[A-Za-z][A-Za-z0-9_-]{0,80}$/.test(href)) attributes += ` href="${escapeHtml(href)}"`;
    }
    return ['br','hr'].includes(tag) ? `<${tag}${attributes}>` : `<${tag}${attributes}>${node.childNodes.map(child => render(child, depth + 1)).join('')}</${tag}>`;
  };
  let content = parseFragment(output.html_body).childNodes.map(node => render(node)).join('');
  const missing: string[] = [];
  for (const tag of ['restaurant-name','restaurant-description','restaurant-address','restaurant-contact','restaurant-hours','restaurant-menu']) {
    if (!seen.has(tag)) missing.push(`<div class="site-required-fact">${component(tag, new Map())}</div>`);
  }
  for (const aid of imageIds) if (!renderedImages.has(aid)) missing.push(`<div class="site-required-image">${component('restaurant-image', new Map([['data-asset-id', aid]]))}</div>`);
  if (missing.length) content += `<footer class="site-required">${missing.join('')}</footer>`;
  const css = safeCss(output.css);
  const base = '*,*::before,*::after{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;min-height:100vh;color:#242820;background:#fff;font-family:system-ui,sans-serif}img{max-width:100%;height:auto}a:focus-visible{outline:2px solid currentColor;outline-offset:4px}.site-required{padding:32px;max-width:1100px;margin:auto}.site-menu-category ul{list-style:none;padding:0}.site-menu-item{padding:14px 0;border-bottom:1px solid #e4e6e1}.site-menu-item-heading{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}.site-menu-price{white-space:pre-wrap}.site-menu-description{font-size:14px;line-height:1.7}.site-hours{list-style:none;padding:0}.site-required-image img{max-height:520px;object-fit:cover}.site-service-note{padding:20px;text-align:center;font:12px system-ui;color:#585d54;border-top:1px solid #e4e6e1}';
  const motion = '@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}';
  const note = generic('Online reservations are not available on this website. Please contact the restaurant directly.', '本网站尚未提供在线订位，请直接联系餐厅。');
  const html = `<!DOCTYPE html><html lang="${escapeHtml(r.primary_locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(WEBSITE_CSP)}"><meta name="referrer" content="no-referrer"><title>${escapeHtml(r.name)}</title><meta name="description" content="${escapeHtml((r.description ?? '').slice(0, 240))}"><style>${base}${css}${motion}</style></head><body>${content}<footer class="site-service-note">${escapeHtml(note)}</footer></body></html>`;
  if (Buffer.byteLength(html) > 200 * 1024) throw new ApiError(503, 'WEBSITE_HTML_TOO_LARGE');
  return { html, checksum: createHash('sha256').update(html).digest('hex') };
}
