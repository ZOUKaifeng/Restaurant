import { createHash } from 'node:crypto';
import { parseFragment, Tokenizer, type DefaultTreeAdapterMap } from 'parse5';
import type { PoolClient } from 'pg';
import { id, type Database } from './db.js';
import { ApiError } from './errors.js';
import { renderWebsite, type WebsiteSnapshot } from './website-html.js';
import { verifyWebsiteVersion, type WebsiteVersion } from './website-access.js';
import type { WebsiteContentDifference, WebsiteRawSource, WebsiteSourceStatus, WebsiteStoredSource } from './website-content-types.js';

export const WEBSITE_RENDERER_VERSION = 'website-v1';
export function websiteSourceChecksum(raw: { html_body: string; css: string }): string {
  return createHash('sha256').update(JSON.stringify({ html_body: raw.html_body, css: raw.css }), 'utf8').digest('hex');
}
export function publicWebsiteContent(snapshot: WebsiteSnapshot) {
  const r = snapshot.restaurant;
  const reservationEnabled = r.reservation_enabled === true;
  return {
    restaurant: { id: r.id, name: r.name, description: r.description ?? '', cuisine_type: r.cuisine_type ?? '',
      address_line1: r.address_line1 ?? '', address_line2: r.address_line2 ?? '', city: r.city ?? '', region: r.region ?? '',
      postal_code: r.postal_code ?? '', country_code: r.country_code ?? '', contact_email: r.contact_email ?? '',
      contact_phone: r.contact_phone ?? '', timezone: r.timezone ?? '', currency: r.currency ?? '', primary_locale: r.primary_locale,
      reservation_enabled: reservationEnabled, reservation_notice: reservationEnabled ? r.reservation_notice ||
        (r.primary_locale.startsWith('zh') ? '提交的是订位申请，需餐厅确认；提交不代表已订位。' :
          'Requests need restaurant confirmation. Submitting does not guarantee a table.') : null },
    opening_hours: snapshot.opening_hours.map(h => ({ weekday: h.weekday, opens_at_local: h.opens_at_local,
      closes_at_local: h.closes_at_local, closes_day_offset: h.closes_day_offset })),
    menu: snapshot.menu ? { categories: snapshot.menu.data.categories.map(category => ({ name: category.name,
      items: category.items.map(item => ({ name: item.name, description: item.description ?? '', price_text: item.price_text })) })) } : null,
    assets: snapshot.assets.map(a => ({ id: a.id, kind: a.kind, mime_type: a.mime_type, checksum: a.checksum,
      width_px: a.width_px, height_px: a.height_px })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  };
}
export function websiteContentHash(snapshot: WebsiteSnapshot): string {
  return createHash('sha256').update(JSON.stringify(publicWebsiteContent(snapshot)), 'utf8').digest('hex');
}
export function websiteContentDifferences(before: WebsiteSnapshot, after: WebsiteSnapshot): WebsiteContentDifference[] {
  const a = publicWebsiteContent(before), b = publicWebsiteContent(after), differences: WebsiteContentDifference[] = [];
  const add = (field: WebsiteContentDifference['field'], label: string, oldText: string, newText: string, oldData?: unknown, newData?: unknown) => {
    if (oldText !== newText) differences.push({ field, label, before: oldText, after: newText });
    else if (JSON.stringify(oldData) !== JSON.stringify(newData)) differences.push({ field, label,
      before: JSON.stringify(oldData, null, 2), after: JSON.stringify(newData, null, 2) });
  };
  add('name', '餐厅名称', a.restaurant.name, b.restaurant.name);
  add('description', '餐厅介绍', a.restaurant.description, b.restaurant.description);
  add('cuisine', '菜系', a.restaurant.cuisine_type, b.restaurant.cuisine_type);
  const address = (v: typeof a) => [v.restaurant.address_line1, v.restaurant.address_line2, v.restaurant.city,
    v.restaurant.region, v.restaurant.postal_code, v.restaurant.country_code].filter(Boolean).join(', ');
  add('address', '餐厅地址', address(a), address(b));
  const contact = (v: typeof a) => [v.restaurant.contact_email, v.restaurant.contact_phone].filter(Boolean).join(' · ');
  add('contact', '联系方式', contact(a), contact(b));
  add('timezone', '时区', a.restaurant.timezone, b.restaurant.timezone);
  add('locale', '网站语言', a.restaurant.primary_locale, b.restaurant.primary_locale);
  add('currency', '货币', a.restaurant.currency, b.restaurant.currency);
  const hours = (v: typeof a) => v.opening_hours.map(h => `${h.weekday} ${h.opens_at_local}–${h.closes_at_local}${h.closes_day_offset ? '（次日）' : ''}`).join('\n');
  add('hours', '营业时间', hours(a), hours(b));
  // 菜单没有稳定 item ID；按原顺序给出分类及完整文本，不声称识别了同一道菜。
  const menu = (v: typeof a) => v.menu?.categories.map(c => `${c.name}\n${c.items.map(i =>
    [i.name, i.price_text, i.description].filter(value => value !== null && value !== '').join(' · ')).join('\n')}`).join('\n\n') ?? '';
  add('menu', '已确认菜单（按分类文本）', menu(a), menu(b), a.menu, b.menu);
  const reservation = (v: typeof a) => v.restaurant.reservation_enabled ? `已开启\n${v.restaurant.reservation_notice}` : '未开启';
  add('reservation', '在线订位', reservation(a), reservation(b));
  return differences;
}
const sourceColumns = 'restaurant_id,version_id,base_version_id,origin,html_body,css,source_checksum,renderer_version,source_schema_version,public_content_hash,restaurant_revision,menu_revision,source_job_id';
export async function readWebsiteSource(db: Database, rid: string, vid: string): Promise<WebsiteStoredSource | null> {
  return (await db.query<WebsiteStoredSource>(`SELECT ${sourceColumns} FROM website_version_sources WHERE restaurant_id=$1 AND version_id=$2`, [rid, vid])).rows[0] ?? null;
}
const components = new Set(['restaurant-name', 'restaurant-description', 'restaurant-cuisine', 'restaurant-address',
  'restaurant-contact', 'restaurant-hours', 'restaurant-menu', 'restaurant-image', 'restaurant-reservation']);
function freelyBoundFacts(raw: WebsiteRawSource, snapshot: WebsiteSnapshot): boolean {
  // 与现有渲染器一样展开合法自闭合组件，避免 parse5 把后续自由文本误吞进组件子树。
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const tokenizer = new Tokenizer({ sourceCodeLocationInfo: true }, {
    onStartTag(token) {
      if (token.selfClosing && components.has(token.tagName) && token.location) {
        const { startOffset: start, endOffset: end } = token.location;
        edits.push({ start, end, text: raw.html_body.slice(start, end).replace(/\/\s*>$/, '>') + `</${token.tagName}>` });
      }
    },
    onEndTag() {}, onCharacter() {}, onWhitespaceCharacter() {}, onNullCharacter() {}, onComment() {}, onDoctype() {}, onEof() {},
  });
  let cursor = 0;
  const chunks: string[] = [];
  tokenizer.write(raw.html_body, true);
  for (const edit of edits) { chunks.push(raw.html_body.slice(cursor, edit.start), edit.text); cursor = edit.end; }
  chunks.push(raw.html_body.slice(cursor));
  const free: string[] = [], phoneText: string[] = [], phoneAttributes: string[] = [];
  const textBreaks = new Set('address article aside blockquote br dd details div dl dt fieldset figcaption figure footer h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table td th tr ul'.split(' '));
  let fixedContact = false;
  const walk = (node: DefaultTreeAdapterMap['node']) => {
    if (node.nodeName === '#text') {
      const value = (node as DefaultTreeAdapterMap['textNode']).value;
      free.push(value); phoneText.push(value); return;
    }
    if (!('tagName' in node)) return;
    for (const attr of node.attrs) {
      if ((node.tagName === 'a' || node.tagName === 'area') && attr.name === 'href' && /^(?:tel|mailto):/i.test(attr.value)) fixedContact = true;
      if (['title', 'alt', 'aria-label'].includes(attr.name)) { free.push(attr.value); phoneAttributes.push(attr.value); }
    }
    // 组件保留自身属性，仅替换子内容；电话只能在同一文案流中跨行内标签拼接。
    if (components.has(node.tagName)) { phoneText.push('\n'); return; }
    if (textBreaks.has(node.tagName)) phoneText.push('\n');
    for (const child of node.childNodes) walk(child);
    if (textBreaks.has(node.tagName)) phoneText.push('\n');
  };
  for (const node of parseFragment(chunks.join('')).childNodes) walk(node);
  if (fixedContact) return true;
  const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  const text = normalize(free.join(' '));
  const r = snapshot.restaurant;
  const wordCharacter = '(?![\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}])[\\p{L}\\p{M}\\p{N}_-]';
  // 拉丁等有分词边界的文字不能嵌在更长单词中；CJK 不要求空格，但必须匹配完整事实文本。
  const wordEdge = (value: string) => /[\p{L}\p{M}\p{N}_-]/u.test(value) &&
    !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
  const containsFact = (value: string) => {
    const fact = normalize(value);
    if (!fact) return false;
    const edges = Array.from(fact);
    for (let start = text.indexOf(fact); start !== -1; start = text.indexOf(fact, start + 1)) {
      const end = start + fact.length;
      const before = Array.from(text.slice(Math.max(0, start - 2), start)).at(-1) ?? '', after = Array.from(text.slice(end, end + 2))[0] ?? '';
      if (/\d/u.test(edges[0]!) && /\d[.,:]$/.test(text.slice(Math.max(0, start - 2), start)) ||
          /\d/u.test(edges.at(-1)!) && /^[.,:]\d/.test(text.slice(end, end + 2))) continue;
      if ((!wordEdge(edges[0]!) || !wordEdge(before)) && (!wordEdge(edges.at(-1)!) || !wordEdge(after))) return true;
    }
    return false;
  };
  const facts = [r.name, r.description, r.cuisine_type, r.address_line1, r.address_line2, r.city, r.region, r.postal_code,
    r.country_code, r.currency, r.contact_email, r.timezone, r.reservation_enabled ? r.reservation_notice : null,
    ...snapshot.opening_hours.flatMap(h => [h.opens_at_local, h.closes_at_local, h.opens_at_local.replace(/^0/, ''), h.closes_at_local.replace(/^0/, '')]),
    ...(snapshot.menu?.data.categories.flatMap(c => [c.name, ...c.items.flatMap(i => [i.name, i.description])]) ?? [])];
  if (facts.some(value => value && containsFact(value))) return true;
  const phone = r.contact_phone?.normalize('NFKC').replace(/[^0-9]/g, '');
  const phoneExpression = new RegExp(`(?<!${wordCharacter}|[.,:])\\+?\\d[\\d() .\\t-]*\\d(?!${wordCharacter}|[.,:]\\d)`, 'gu');
  if (phone && phone.length >= 3 && [phoneText.join(''), ...phoneAttributes].some(value =>
    [...value.normalize('NFKC').matchAll(phoneExpression)].some(match => match[0].replace(/[^0-9]/g, '') === phone))) return true;
  const prices = snapshot.menu?.data.categories.flatMap(c => c.items.flatMap(i => i.price_text === null ? [] : [normalize(i.price_text)])) ?? [];
  const currency = r.currency && /^[a-z]{3}$/.test(normalize(r.currency)) ? `|${normalize(r.currency)}` : '';
  const currencyCodes = `(?:usd|eur|gbp|cny|rmb|jpy|hkd|twd|aud|cad|chf|krw|sgd|inr${currency})`;
  const currencyPrefix = `(?:[$€£¥₹₩₽₫฿₱]|(?<!${wordCharacter})${currencyCodes})`;
  const currencySuffix = `(?:[$€£¥₹₩₽₫฿₱]|${currencyCodes}|元|圆)`;
  const amount = '\\d+(?:[.,]\\d+)*';
  // 裸价只在完整金额及货币上下文中匹配；不把比例、日期或无关数字当作价格。
  const priceExpression = new RegExp(`(?<![\\d.,:])${currencyPrefix}\\s*(${amount})(?!${wordCharacter}|[.,:]\\d)|(?<!${wordCharacter}|[\\d.,:])(${amount})\\s*${currencySuffix}(?!${wordCharacter})`, 'gu');
  const normalizeAmount = (value: string) => value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  const amounts = new Set([...text.matchAll(priceExpression)].map(match => normalizeAmount((match[1] ?? match[2])!)));
  return prices.some(price => {
    const numbers = price.match(/\d+(?:[.,]\d+)*/g) ?? [];
    if (!numbers.length) return containsFact(price);
    if (numbers.some(number => amounts.has(normalizeAmount(number)))) return true;
    return !new RegExp(`^${amount}$`).test(price) && containsFact(price);
  });
}
export function websiteSourceBindingsAvailable(raw: WebsiteRawSource, snapshot: WebsiteSnapshot): boolean {
  return !freelyBoundFacts(raw, snapshot);
}
export async function websiteSourceStatus(db: Database, version: WebsiteVersion): Promise<WebsiteSourceStatus> {
  const source = await readWebsiteSource(db, version.restaurant_id, version.id);
  if (!source) return 'missing';
  try {
    const raw = { html_body: source.html_body, css: source.css, summary: version.summary };
    if (source.renderer_version !== WEBSITE_RENDERER_VERSION || source.source_schema_version !== 1 ||
        websiteSourceChecksum(raw) !== source.source_checksum || websiteContentHash(version.snapshot) !== source.public_content_hash) return 'incompatible';
    verifyWebsiteVersion(version);
    const rendered = renderWebsite(raw, version.snapshot);
    if (rendered.html !== version.html || rendered.checksum !== version.checksum || !websiteSourceBindingsAvailable(raw, version.snapshot)) return 'incompatible';
    // 缺少组件的合法旧稿由渲染器补齐；不把 fallback 错判为缺失绑定。
    return 'available';
  } catch { return 'incompatible'; }
}
export async function insertWebsiteSource(db: PoolClient, version: WebsiteVersion, raw: WebsiteRawSource,
  metadata: { origin: 'generation' | 'content_refresh'; baseVersionId?: string; jobId?: string; restaurantRevision: number; menuRevision: number | null }): Promise<void> {
  verifyWebsiteVersion(version);
  const rendered = renderWebsite(raw, version.snapshot);
  if (rendered.html !== version.html || rendered.checksum !== version.checksum) throw new ApiError(409, 'WEBSITE_SOURCE_INCOMPATIBLE');
  await db.query('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE', [version.restaurant_id]);
  await db.query('SELECT id FROM assets WHERE restaurant_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE', [version.restaurant_id, version.asset_ids]);
  for (const asset of version.snapshot.assets) {
    await db.query(`INSERT INTO asset_references(id,restaurant_id,asset_id,purpose,resource_id)
      VALUES($1,$2,$3,'website_version',$4) ON CONFLICT(asset_id,purpose,resource_id) DO NOTHING`, [id('ref'), version.restaurant_id, asset.id, version.id]);
  }
  await db.query(`INSERT INTO website_version_sources(${sourceColumns}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12)`,
  [version.restaurant_id, version.id, metadata.baseVersionId ?? null, metadata.origin, raw.html_body, raw.css,
    websiteSourceChecksum(raw), WEBSITE_RENDERER_VERSION, websiteContentHash(version.snapshot), metadata.restaurantRevision,
    metadata.menuRevision, metadata.jobId ?? null]);
}
