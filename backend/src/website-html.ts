import { createHash } from 'node:crypto';
import { parseFragment, defaultTreeAdapter, html as parse5Html, Tokenizer, TokenizerMode, type Token, type DefaultTreeAdapterMap } from 'parse5';
import type { WebsiteDiagnostic } from './website-agent-types.js';
import * as cssTree from 'css-tree';
import { ApiError } from './errors.js';
import { normalizeMenuData, type ConfirmedMenuSnapshot } from './menu-data.js';

export interface WebsiteSnapshot {
  menu?: ConfirmedMenuSnapshot | null;
  restaurant: { id: string; name: string; description: string | null; cuisine_type: string | null; address_line1: string | null; address_line2: string | null; city: string | null; region: string | null; postal_code: string | null; country_code: string | null; contact_email: string | null; contact_phone: string | null; timezone: string | null; currency: string | null; primary_locale: string;
    reservation_enabled?: boolean; reservation_notice?: string | null };
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
const forbiddenTags = new Set('script iframe frame frameset object embed applet portal fencedframe form input textarea select option optgroup keygen link base meta style svg math audio video source track template noscript xmp plaintext noembed noframes title'.split(' '));
const voidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const tokenTags = new Set(['restaurant-name', 'restaurant-description', 'restaurant-cuisine', 'restaurant-address', 'restaurant-contact', 'restaurant-hours', 'restaurant-menu', 'restaurant-image', 'restaurant-reservation']);
const customTag = /^[a-z][a-z0-9._-]*-[a-z0-9._-]*$/;
const messages = {
  HTML_SYNTAX_ERROR: 'HTML 语法错误，请检查属性引号、实体和标签格式。',
  HTML_MISSING_END_TAG: '缺少必须的结束标签，请显式关闭该元素。',
  HTML_UNEXPECTED_END_TAG: '结束标签没有匹配的开始标签，或标签嵌套顺序错误。',
  HTML_SELF_CLOSING_FORBIDDEN: '普通非 void HTML 元素不能自闭合，请使用成对标签。',
  HTML_INVALID_NESTING: 'HTML 嵌套导致解析器丢弃、移动或隐式重建元素；请修正父子结构，不依赖浏览器修补。',
  BODY_FRAGMENT_REQUIRED: 'html_body 必须是 body 内的片段，不得包含 doctype、html、head 或 body。',
  HTML_TAG_FORBIDDEN: '禁止脚本、嵌入内容、表单、独立样式、媒体加载和非 HTML 命名空间；请使用静态 HTML 与独立 CSS。',
  HTML_ATTRIBUTE_FORBIDDEN: '禁止事件属性、srcdoc、命名空间属性及未受控的资源或导航属性。',
  HTML_ATTRIBUTE_INVALID: '静态 HTML 属性格式或长度不合法。',
  HTML_LINK_FORBIDDEN: '链接仅允许本地锚点、确认联系方式的精确 mailto/tel 或菜单素材占位符。',
  HTML_IMAGE_INVALID: 'img 必须使用确认清单中图片的 __SITE_ASSET_id__ 占位符；不得使用外部地址或非图片素材。',
  CSS_SYNTAX_ERROR: 'CSS 语法错误，请检查声明、引号和括号。',
  CSS_UNCLOSED_DELIMITER: 'CSS 括号未关闭；校验不会自动补齐括号。',
  CSS_UNEXPECTED_DELIMITER: 'CSS 关闭括号与开始括号不匹配。',
  CSS_VALUE_INVALID: '该 CSS 声明的值类型明显不合法。',
  CSS_URL_FORBIDDEN: '禁止 CSS URL 和可加载图片的函数（包括本地 URL）；请用受控 img，不要使用背景 URL。',
  CSS_ATRULE_FORBIDDEN: '禁止 CSS 导入、字体源和其他资源或命名空间规则。',
  CSS_EXECUTION_FORBIDDEN: '禁止 CSS expression、behavior 与浏览器绑定。',
  CSS_CONTENT_FORBIDDEN: 'CSS content 仅允许 none、normal 或空字符串；文案请放入 HTML，事实请用餐厅组件。',
  SOURCE_TOO_LARGE: 'HTML/CSS 源码超过预算（HTML 100 KiB、CSS 40 KiB）。',
  STRUCTURE_TOO_LARGE: 'HTML/CSS 的节点数或嵌套深度超过预算。',
  COMPILED_TOO_LARGE: '编译后的 HTML 超过 200 KiB 预算。',
  COMPILED_INVALID_NESTING: '编译后的组件嵌套不合法：请将 restaurant-menu、restaurant-hours、restaurant-image 放在 section/div 等块容器内，不要放入 p、h1–h6 或行内容器；restaurant-contact 和菜单链接不得嵌入 a。',
  SNAPSHOT_INVALID: '确认的餐厅、菜单或素材快照不合法。',
  WARNING_FACT_FALLBACK: '缺少必需餐厅事实组件，后端已按确认快照补齐；建议在布局中显式放置组件。',
  WARNING_IMAGE_FALLBACK: '餐厅图片组件未匹配确认素材，后端保留确认图片补齐逻辑。',
  WARNING_FACT_CHILDREN: '事实组件的子内容不能替换确认事实或菜单价格；后端使用确认快照。',
} as const;
type DiagnosticCode = keyof typeof messages;
type Report = (code: DiagnosticCode, offset?: number) => void;
type WebsiteOutput = { html_body: string; css: string; summary: string };
type RenderedWebsite = { html: string; checksum: string };

export class WebsiteValidationError extends ApiError {
  public readonly diagnostics: WebsiteDiagnostic[];
  constructor(diagnostics: WebsiteDiagnostic[]) {
    super(503, 'WEBSITE_HTML_INVALID');
    this.name = 'WebsiteValidationError';
    this.message = '网站 HTML/CSS 校验失败';
    this.diagnostics = diagnostics.slice(0, 20).map(d => ({ ...d }));
  }
}
function position(source: string, offset = 0): { line: number; column: number } {
  const before = source.slice(0, Math.max(0, Math.min(offset, source.length)));
  const lines = before.split(/\r\n|\r|\n/);
  return { line: lines.length, column: lines[lines.length - 1]!.length + 1 };
}
const cssTokens = cssTree as typeof cssTree & {
  tokenize(source: string, callback: (type: number, start: number, end: number) => void): void;
  tokenTypes: Record<string, number>;
};
const networkRules = new Set(['import', 'font-face', 'namespace', 'document', '-moz-document']);
const networkFunctions = new Set(['url', 'image', 'image-set', '-webkit-image-set', 'src']);
function safeCss(source: string, report: Report, inline = false): string {
  if (Buffer.byteLength(source) > 40 * 1024) { report('SOURCE_TOO_LARGE'); return ''; }
  const forbidden = source.search(/\0|<\/style/i);
  if (forbidden !== -1) { report('CSS_SYNTAX_ERROR', forbidden); return ''; }
  const delimiters: Array<{ type: number; offset: number }> = [];
  const t = cssTokens.tokenTypes;
  let tokens = 0;
  cssTokens.tokenize(source, (type, start, end) => {
    if (++tokens > 20000 || delimiters.length > 80) { report('STRUCTURE_TOO_LARGE', start); throw new WebsiteValidationError([]); }
    const raw = source.slice(start, end);
    if (type === t.Url || type === t.BadUrl) report('CSS_URL_FORBIDDEN', start);
    if (type === t.BadString || (type === t.Comment && !raw.endsWith('*/')) || (type === t.String && (raw.length < 2 || raw.at(-1) !== raw[0] || /(?:^|[^\\])(?:\\\\)*\\$/.test(raw.slice(0, -1))))) report('CSS_SYNTAX_ERROR', start);
    if (type === t.Function || type === t.AtKeyword || type === t.Ident) {
      const name = cssTree.ident.decode(type === t.Function ? raw.slice(0, -1) : type === t.AtKeyword ? raw.slice(1) : raw).toLowerCase();
      if (type === t.Function && networkFunctions.has(name)) report('CSS_URL_FORBIDDEN', start);
      if (type === t.Function && name === 'expression') report('CSS_EXECUTION_FORBIDDEN', start);
      if (type === t.AtKeyword && networkRules.has(name)) report('CSS_ATRULE_FORBIDDEN', start);
    }
    if ([t.Function, t.LeftParenthesis, t.LeftCurlyBracket, t.LeftSquareBracket].includes(type)) delimiters.push({ type: type === t.Function ? t.LeftParenthesis! : type, offset: start });
    if ([t.RightParenthesis, t.RightCurlyBracket, t.RightSquareBracket].includes(type)) {
      const expected = type === t.RightParenthesis ? t.LeftParenthesis : type === t.RightCurlyBracket ? t.LeftCurlyBracket : t.LeftSquareBracket;
      if (delimiters.at(-1)?.type !== expected) report('CSS_UNEXPECTED_DELIMITER', start);
      else delimiters.pop();
    }
  });
  for (const delimiter of delimiters) report('CSS_UNCLOSED_DELIMITER', delimiter.offset);
  let tree: cssTree.CssNode;
  const parseError = (error: unknown) => report('CSS_SYNTAX_ERROR', typeof error === 'object' && error !== null && 'offset' in error && typeof error.offset === 'number' ? error.offset : 0);
  try {
    tree = cssTree.parse(source, { context: inline ? 'declarationList' : 'stylesheet', positions: true, parseValue: true, parseCustomProperty: false, parseRulePrelude: true, onParseError: parseError });
  } catch (error) { parseError(error); return ''; }
  let count = 0, depth = 0;
  cssTree.walk(tree, {
    enter(node: cssTree.CssNode) {
      if (++count > 10000 || ++depth > 80) { report('STRUCTURE_TOO_LARGE', node.loc?.start.offset); throw new WebsiteValidationError([]); }
      const offset = node.loc?.start.offset ?? 0;
      if (node.type === 'Url') report('CSS_URL_FORBIDDEN', offset);
      if (node.type === 'Atrule' && networkRules.has(cssTree.ident.decode(node.name).toLowerCase())) report('CSS_ATRULE_FORBIDDEN', offset);
      if (node.type === 'Function') {
        const name = cssTree.ident.decode(node.name).toLowerCase();
        if (networkFunctions.has(name)) report('CSS_URL_FORBIDDEN', offset);
        if (name === 'expression') report('CSS_EXECUTION_FORBIDDEN', offset);
      }
      if (node.type === 'Declaration') {
        const property = cssTree.ident.decode(node.property).toLowerCase();
        if (['behavior', '-moz-binding'].includes(property)) report('CSS_EXECUTION_FORBIDDEN', offset);
        if (property === 'content' && !/^(?:none|normal|""|'')$/i.test(cssTree.generate(node.value))) report('CSS_CONTENT_FORBIDDEN', offset);
        if (!property.startsWith('--') && node.value.type === 'Value' && node.value.children.isEmpty) report('CSS_SYNTAX_ERROR', offset);
        // 仅对标准中明确不接受字符串的值使用 lexer；未知属性和新函数不受小白名单限制。
        if (/^(?:color|background-color|border(?:-(?:top|right|bottom|left))?-color|opacity|width|height|(?:min|max)-(?:width|height)|margin(?:-(?:top|right|bottom|left))?|padding(?:-(?:top|right|bottom|left))?)$/.test(property) && node.value.type === 'Value' && node.value.children.some(child => child.type === 'String')) {
          if (cssTree.lexer.matchProperty(property, node.value).error) report('CSS_VALUE_INVALID', node.value.loc?.start.offset ?? offset);
        }
      }
    },
    leave() { depth--; },
  });
  // 未知现代规则可能保留 Raw；tokenizer 已检查其 URL、执行函数和括号，不能仅因 Raw 拒绝。
  const generated = cssTree.generate(tree);
  if (/<\/style/i.test(generated)) report('CSS_SYNTAX_ERROR');
  return generated;
}
function contactHrefs(snapshot: WebsiteSnapshot): Set<string> {
  const r = snapshot.restaurant, links = new Set<string>();
  if (r.contact_email && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(r.contact_email)) links.add(`mailto:${encodeURIComponent(r.contact_email).replaceAll('%40', '@')}`);
  if (r.contact_phone && /^[+0-9() .-]{3,40}$/.test(r.contact_phone)) links.add(`tel:${r.contact_phone.replace(/[^+0-9]/g, '')}`);
  return links;
}
const resourceAttrs = new Set('src srcset href xlink:href srcdoc action formaction poster background ping data codebase archive manifest profile longdesc usemap cite lowsrc dynsrc'.split(' '));
const passiveAttrs = new Set('class id title lang dir role tabindex hidden inert open disabled reversed start value colspan rowspan scope headers abbr datetime loading decoding width height alt type download target rel'.split(' '));
function inlineOffset(raw: string, cssOffset: number): number {
  const prefix = raw.match(/^style\s*=\s*["']?/i)?.[0].length ?? 0;
  const value = raw.slice(prefix);
  const entities = new Map<string, string>();
  let sourceOffset = 0, decodedOffset = 0;
  while (sourceOffset < value.length && decodedOffset < cssOffset) {
    const entity = value[sourceOffset] === '&' ? value.slice(sourceOffset).match(/^&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]+);/)?.[0] : undefined;
    if (entity) {
      let decoded = entities.get(entity);
      if (decoded === undefined) {
        const node = parseFragment(`<i title="${entity}"></i>`).childNodes[0];
        decoded = node && 'tagName' in node ? node.attrs[0]!.value : entity;
        entities.set(entity, decoded);
      }
      if (decodedOffset + decoded.length > cssOffset) break;
      decodedOffset += decoded.length;
      sourceOffset += entity.length;
    } else {
      sourceOffset += value.slice(sourceOffset, sourceOffset + 2) === '\r\n' ? 2 : 1;
      decodedOffset++;
    }
  }
  return prefix + sourceOffset;
}
function attributesFor(tag: string, attrs: Token.Attribute[], snapshot: WebsiteSnapshot, report: Report, location: Token.LocationWithAttributes | null, styles: Map<string, string>, html: string): string {
  let result = '';
  const contacts = contactHrefs(snapshot);
  for (const attr of attrs) {
    const key = attr.name, value = attr.value;
    const loc = location?.attrs?.[key], offset = loc?.startOffset ?? location?.startOffset ?? 0;
    if (key.startsWith('on') || key === 'srcdoc' || key === 'is' || key === 'xmlns' || key.includes(':') || attr.namespace || attr.prefix) { report('HTML_ATTRIBUTE_FORBIDDEN', offset); continue; }
    if (key === 'style') {
      if (!styles.has(value)) {
        const raw = html.slice(offset, loc?.endOffset ?? offset);
        let reports = 0;
        styles.set(value, safeCss(value, (code, cssOffset = 0) => {
          if (reports++ < 20) report(code, offset + inlineOffset(raw, cssOffset));
        }, true));
      }
      result += ` style="${escapeHtml(styles.get(value))}"`;
      continue;
    }
    if (key === 'src' && tag === 'img') {
      const asset = snapshot.assets.find(a => value === assetPlaceholder(a.id));
      if (!asset || !/^image\/(?:jpeg|png|gif|webp|avif)$/.test(asset.mime_type)) report('HTML_IMAGE_INVALID', offset);
      else result += ` src="${escapeHtml(value)}"`;
      continue;
    }
    if (key === 'href' && (tag === 'a' || tag === 'area')) {
      const menu = snapshot.assets.find(a => a.kind === 'menu_source');
      if (!/^#(?:[^\s\u0000-\u001f<>"']*)$/.test(value) && !contacts.has(value) && !(menu && value === assetPlaceholder(menu.id))) report('HTML_LINK_FORBIDDEN', offset);
      else result += ` href="${escapeHtml(value)}"`;
      continue;
    }
    if (resourceAttrs.has(key)) { report('HTML_ATTRIBUTE_FORBIDDEN', offset); continue; }
    if (key === 'data-asset-id' && tag === 'restaurant-image') continue;
    if (!passiveAttrs.has(key) && !/^aria-[a-z-]+$/.test(key)) continue;
    let valid = value.length <= 500 && !/[\u0000-\u001f]/.test(value);
    if (key === 'class') valid = value.length <= 240;
    if (key === 'id') valid = value.length <= 80 && !/[\s\u0000-\u001f]/.test(value);
    if (['width', 'height'].includes(key)) valid = /^[1-9]\d{0,4}$/.test(value);
    if (['colspan', 'rowspan', 'start', 'value', 'tabindex'].includes(key)) valid = /^-?\d{1,6}$/.test(value);
    if (key === 'dir') valid = ['ltr', 'rtl', 'auto'].includes(value);
    if (key === 'loading') valid = ['lazy', 'eager'].includes(value);
    if (key === 'decoding') valid = ['async', 'sync', 'auto'].includes(value);
    if (key === 'type' && tag === 'button') valid = value === 'button';
    if (key === 'target') valid = ['_blank', '_self'].includes(value);
    if (!valid) { report('HTML_ATTRIBUTE_INVALID', offset); continue; }
    if (key === 'rel') continue;
    result += ` ${key}="${escapeHtml(value)}"`;
  }
  if (tag === 'img' && !attrs.some(a => a.name === 'src')) report('HTML_IMAGE_INVALID', location?.startOffset);
  if (tag === 'button' && !attrs.some(a => a.name === 'type')) result += ' type="button"';
  if (tag === 'a' || tag === 'area') result += ' rel="noopener noreferrer"';
  return result;
}
const paragraphClosers = new Set('address article aside blockquote details div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre search section table ul'.split(' '));
function optionalEnd(tag: string, parent?: string): boolean {
  if (tag === 'p') return !parent || !new Set(['a', 'audio', 'del', 'ins', 'map', 'noscript', 'video']).has(parent) && !customTag.test(parent);
  return (tag === 'li' && (!parent || ['ul', 'ol', 'menu'].includes(parent))) || (tag === 'dd' && parent === 'dl') || (['rb', 'rt', 'rtc', 'rp'].includes(tag) && parent === 'ruby') || (['tbody', 'tfoot', 'colgroup'].includes(tag) && parent === 'table') || (tag === 'tr' && ['table', 'thead', 'tbody', 'tfoot'].includes(parent ?? '')) || (['td', 'th'].includes(tag) && parent === 'tr');
}
type ElementOrigins = WeakMap<DefaultTreeAdapterMap['element'], number>;
function verifyParsedParents(fragment: DefaultTreeAdapterMap['documentFragment'], parents: Map<number, number | undefined>, originalOffsets: Map<number, number>, report: Report, code: DiagnosticCode, origins?: ElementOrigins) {
  const visited = new Set<number>();
  let nodes = 0;
  const verify = (node: DefaultTreeAdapterMap['node'], parent?: number, depth = 0) => {
    if (++nodes > 5000 || depth > 80) { report('STRUCTURE_TOO_LARGE'); throw new WebsiteValidationError([]); }
    if (!('tagName' in node)) return;
    const start = node.sourceCodeLocation?.startOffset;
    const original = start === undefined ? undefined : originalOffsets.get(start);
    if (original !== undefined) {
      if (visited.has(original) || parents.get(original) !== parent) report(code, original);
      visited.add(original);
      origins?.set(node, original);
    } else if (code === 'COMPILED_INVALID_NESTING') {
      // 编译器输出完整标签，不能依赖 parser 自动插入 tbody、空 p 等元素。
      report(code, parent);
    }
    // 源片段中的合法省略（如隐式 tbody）不改变有源码元素的父子关系。
    for (const child of node.childNodes) verify(child, original ?? parent, depth + 1);
  };
  for (const node of fragment.childNodes) verify(node);
  for (const original of parents.keys()) if (!visited.has(original)) report(code, original);
}
function inspectCompiledBody(body: string, report: Report) {
  const stack: Token.TagToken[] = [];
  const parents = new Map<number, number | undefined>();
  let count = 0;
  const tokenizer = new Tokenizer({ sourceCodeLocationInfo: true }, {
    onStartTag(token) {
      if (++count > 5000 || stack.length > 80) { report('STRUCTURE_TOO_LARGE', token.location?.startOffset); throw new WebsiteValidationError([]); }
      parents.set(token.location!.startOffset, stack.at(-1)?.location?.startOffset);
      if (!voidTags.has(token.tagName)) stack.push(token);
    },
    onEndTag(token) {
      if (stack.at(-1)?.tagName !== token.tagName) report('COMPILED_INVALID_NESTING', token.location?.startOffset);
      else stack.pop();
    },
    onCharacter(token) {
      if (['table', 'thead', 'tbody', 'tfoot', 'tr', 'colgroup'].includes(stack.at(-1)?.tagName ?? '')) report('COMPILED_INVALID_NESTING', token.location?.startOffset);
    },
    onEof() { for (const token of stack) report('COMPILED_INVALID_NESTING', token.location?.startOffset); },
    onDoctype(token) { report('COMPILED_INVALID_NESTING', token.location?.startOffset); },
    onComment() {}, onNullCharacter() {}, onWhitespaceCharacter() {},
    onParseError(error) { report('COMPILED_INVALID_NESTING', error.startOffset); },
  });
  tokenizer.write(body, true);
  // 只检查最终结构，不再次应用模型属性策略；运行时事实含受控 href 和 data-menu-revision。
  const context = defaultTreeAdapter.createElement('body', parse5Html.NS.HTML, []);
  const fragment = parseFragment(context, body, { sourceCodeLocationInfo: true, onParseError: error => report('COMPILED_INVALID_NESTING', error.startOffset) });
  verifyParsedParents(fragment, parents, new Map([...parents.keys()].map(offset => [offset, offset])), report, 'COMPILED_INVALID_NESTING');
}
function inspectHtml(source: string, snapshot: WebsiteSnapshot, report: Report, styles: Map<string, string>, origins: ElementOrigins): DefaultTreeAdapterMap['documentFragment'] {
  const stack: Token.TagToken[] = [], selfClosing: Token.TagToken[] = [];
  const parents = new Map<number, number | undefined>();
  const missing = (token: Token.TagToken) => report('HTML_MISSING_END_TAG', token.location?.startOffset);
  const closeThrough = (index: number) => {
    for (let i = stack.length - 1; i > index; i--) if (!optionalEnd(stack[i]!.tagName, stack[i - 1]?.tagName)) missing(stack[i]!);
    stack.length = index;
  };
  const closeOptional = (tags: string[], barriers: string[]) => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (tags.includes(stack[i]!.tagName)) { closeThrough(i); return; }
      if (barriers.includes(stack[i]!.tagName)) return;
    }
  };
  let count = 0;
  const tokenizer = new Tokenizer({ sourceCodeLocationInfo: true }, {
    onStartTag(token) {
      if (++count > 5000 || stack.length > 80) throw new WebsiteValidationError([{ file: 'index.html', ...position(source, token.location?.startOffset), code: 'STRUCTURE_TOO_LARGE', message: messages.STRUCTURE_TOO_LARGE }]);
      const tag = token.tagName;
      if (['html', 'head', 'body'].includes(tag)) report('BODY_FRAGMENT_REQUIRED', token.location?.startOffset);
      else if (forbiddenTags.has(tag) || tag.includes(':')) report('HTML_TAG_FORBIDDEN', token.location?.startOffset);
      attributesFor(tag, token.attrs, snapshot, report, token.location, styles, source);
      if (tag === 'script') tokenizer.state = TokenizerMode.SCRIPT_DATA;
      else if (['style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'].includes(tag)) tokenizer.state = TokenizerMode.RAWTEXT;
      else if (['title', 'textarea'].includes(tag)) tokenizer.state = TokenizerMode.RCDATA;
      else if (tag === 'plaintext') tokenizer.state = TokenizerMode.PLAINTEXT;
      if (paragraphClosers.has(tag)) closeOptional(['p'], ['button', 'table']);
      if (tag === 'li') closeOptional(['li'], ['ul', 'ol', 'menu']);
      if (['dt', 'dd'].includes(tag)) closeOptional(['dt', 'dd'], ['dl']);
      if (['rb', 'rt', 'rtc', 'rp'].includes(tag)) closeOptional(['rb', 'rt', 'rtc', 'rp'], ['ruby']);
      if (['td', 'th', 'tr', 'thead', 'tbody', 'tfoot'].includes(tag)) closeOptional(['td', 'th'], ['tr', 'table']);
      if (['tr', 'thead', 'tbody', 'tfoot'].includes(tag)) closeOptional(['tr'], ['table']);
      if (['thead', 'tbody', 'tfoot'].includes(tag)) closeOptional(['thead', 'tbody', 'tfoot'], ['table']);
      if (['caption', 'colgroup', 'thead', 'tbody', 'tfoot', 'tr'].includes(tag)) closeOptional(['colgroup'], ['table']);
      parents.set(token.location!.startOffset, stack.at(-1)?.location?.startOffset);
      if (voidTags.has(tag)) return;
      if (token.selfClosing) {
        if (customTag.test(tag)) selfClosing.push(token);
        else report('HTML_SELF_CLOSING_FORBIDDEN', token.location?.startOffset);
        return;
      }
      stack.push(token);
    },
    onEndTag(token) {
      if (['html', 'head', 'body'].includes(token.tagName)) report('BODY_FRAGMENT_REQUIRED', token.location?.startOffset);
      const index = stack.findLastIndex(open => open.tagName === token.tagName);
      if (index < 0) report('HTML_UNEXPECTED_END_TAG', token.location?.startOffset);
      else closeThrough(index);
    },
    onDoctype(token) { report('BODY_FRAGMENT_REQUIRED', token.location?.startOffset); },
    onEof() { for (let i = stack.length - 1; i >= 0; i--) if (!optionalEnd(stack[i]!.tagName, stack[i - 1]?.tagName)) missing(stack[i]!); },
    onComment() {},
    onCharacter(token) { if (['table', 'thead', 'tbody', 'tfoot', 'tr', 'colgroup'].includes(stack.at(-1)?.tagName ?? '')) report('HTML_INVALID_NESTING', token.location?.startOffset); },
    onNullCharacter() {}, onWhitespaceCharacter() {},
    onParseError(error) { report('HTML_SYNTAX_ERROR', error.startOffset); },
  });
  tokenizer.write(source, true);
  const parseErrors = (error: { code: string; startOffset: number }) => {
    if (error.code === 'non-void-html-element-start-tag-with-trailing-solidus' && selfClosing.some(t => t.location?.startOffset === error.startOffset)) return;
    report('HTML_SYNTAX_ERROR', error.startOffset);
  };
  parseFragment(source, { sourceCodeLocationInfo: true, onParseError: parseErrors });
  // 自闭合 custom tag 是本接口支持的语法，显式展开以防 HTML parser 将后续兄弟误吞入组件。
  const edits = selfClosing.map(token => {
    const loc = token.location!;
    const replacement = source.slice(loc.startOffset, loc.endOffset).replace(/\/\s*>$/, '>') + `</${token.tagName}>`;
    return { start: loc.startOffset, end: loc.endOffset, replacement, delta: replacement.length - (loc.endOffset - loc.startOffset) };
  });
  const chunks: string[] = [];
  let cursor = 0;
  for (const edit of edits) { chunks.push(source.slice(cursor, edit.start), edit.replacement); cursor = edit.end; }
  chunks.push(source.slice(cursor));
  const originalOffsets = new Map<number, number>();
  let delta = 0, editIndex = 0;
  for (const offset of parents.keys()) {
    while (edits[editIndex] && edits[editIndex]!.end <= offset) delta += edits[editIndex++]!.delta;
    originalOffsets.set(offset + delta, offset);
  }
  const fragment = parseFragment(chunks.join(''), { sourceCodeLocationInfo: true });
  verifyParsedParents(fragment, parents, originalOffsets, report, 'HTML_INVALID_NESTING', origins);
  return fragment;
}
export function inspectWebsite(output: WebsiteOutput, snapshot: WebsiteSnapshot): { valid: boolean; diagnostics: WebsiteDiagnostic[]; rendered?: RenderedWebsite } {
  const errors: WebsiteDiagnostic[] = [], warnings: WebsiteDiagnostic[] = [];
  let hasError = false;
  const reportFor = (file: WebsiteDiagnostic['file'], source: string): Report => (code, offset) => {
    const warning = code.startsWith('WARNING_');
    if (!warning) hasError = true;
    const entries = warning ? warnings : errors;
    if (entries.length >= 20) return;
    const diagnostic = { file, ...position(source, offset), code, message: messages[code] };
    if (entries.length < 20 && !entries.some(d => d.file === file && d.line === diagnostic.line && d.column === diagnostic.column && d.code === code)) entries.push(diagnostic);
  };
  const fail = () => ({ valid: false, diagnostics: errors.concat(warnings).slice(0, 20) });
  const htmlReport = reportFor('index.html', typeof output?.html_body === 'string' ? output.html_body : '');
  const cssReport = reportFor('styles.css', typeof output?.css === 'string' ? output.css : '');
  if (typeof output?.html_body !== 'string' || Buffer.byteLength(output.html_body) > 100 * 1024) htmlReport('SOURCE_TOO_LARGE');
  if (typeof output?.css !== 'string' || Buffer.byteLength(output.css) > 40 * 1024) cssReport('SOURCE_TOO_LARGE');
  if (hasError) return fail();
  if (!snapshot.restaurant.name || snapshot.assets.length > 8 || snapshot.assets.some(a => !/^ast_[A-Za-z0-9_-]{24}$/.test(a.id))) { reportFor('assets', '')('SNAPSHOT_INVALID'); return fail(); }
  const styles = new Map<string, string>();
  const origins: ElementOrigins = new WeakMap();
  let fragment: DefaultTreeAdapterMap['documentFragment'], css: string;
  try {
    fragment = inspectHtml(output.html_body, snapshot, htmlReport, styles, origins);
    if (Buffer.byteLength(output.css) + [...styles.keys()].reduce((bytes, value) => bytes + Buffer.byteLength(value), 0) > 40 * 1024) cssReport('SOURCE_TOO_LARGE');
    css = safeCss(output.css, cssReport);
  } catch (error) {
    if (!(error instanceof WebsiteValidationError)) throw error;
    hasError = true;
    errors.push(...error.diagnostics.slice(0, 20 - errors.length));
    return fail();
  }
  if (hasError) return fail();
  try {
    const rendered = compileWebsite(fragment, css, snapshot, styles, reportFor('agent', ''), htmlReport, origins);
    return hasError ? fail() : { valid: true, diagnostics: warnings.slice(0, 20), rendered };
  } catch (error) {
    if (error instanceof WebsiteValidationError) { hasError = true; errors.push(...error.diagnostics.slice(0, 20 - errors.length)); }
    else if (error instanceof ApiError) reportFor('assets', '')('SNAPSHOT_INVALID');
    else throw error;
    return fail();
  }
}
export function renderWebsite(output: WebsiteOutput, snapshot: WebsiteSnapshot): RenderedWebsite {
  const inspection = inspectWebsite(output, snapshot);
  if (!inspection.valid || !inspection.rendered) throw new WebsiteValidationError(inspection.diagnostics);
  return inspection.rendered;
}
const blockComponents = new Set(['restaurant-menu', 'restaurant-hours', 'restaurant-image', 'restaurant-reservation']);
const inlineParents = new Set('p h1 h2 h3 h4 h5 h6 span a abbr b bdi bdo cite code data dfn em i kbd mark q rp rt ruby s samp small strong sub sup time u var button pre summary legend picture label output progress meter'.split(' '));
function compileWebsite(fragment: DefaultTreeAdapterMap['documentFragment'], css: string, snapshot: WebsiteSnapshot, styles: Map<string, string>, report: Report, htmlReport: Report, origins: ElementOrigins): RenderedWebsite {
  const invalid = (code: DiagnosticCode = 'SNAPSHOT_INVALID'): never => { throw new WebsiteValidationError([{ file: code === 'SNAPSHOT_INVALID' ? 'assets' : 'index.html', line: 1, column: 1, code, message: messages[code] }]); };
  const imageIds = new Set(snapshot.assets.filter(a => /^image\/(?:jpeg|png|gif|webp|avif)$/.test(a.mime_type)).map(a => a.id));
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
      if (!aid || !imageIds.has(aid)) { report('WARNING_IMAGE_FALLBACK'); return ''; }
      if (renderedImages.has(aid)) return '';
      renderedImages.add(aid);
      const asset = snapshot.assets.find(a => a.id === aid)!;
      return `<img src="${assetPlaceholder(aid)}" alt="${escapeHtml(r.name)}" width="${asset.width_px ?? 1}" height="${asset.height_px ?? 1}" loading="lazy" decoding="async">`;
    }
    if (tag === 'restaurant-reservation') {
      // 未开启订位时不显示任何订位块：既不承诺可订，也不留下“暂未开放”的多余提示。
      if (!r.reservation_enabled) return '';
      const notice = r.reservation_notice
        ? escapeHtml(r.reservation_notice)
        : escapeHtml(generic('Requests need restaurant confirmation. Submitting does not guarantee a table.',
          '提交的是订位申请，需餐厅确认；提交不代表已订位。'));
      return `<section class="site-reservation"><h2>${escapeHtml(generic('Reserve a table', '在线订位'))}</h2><p class="site-reservation-notice">${notice}</p><a class="site-reservation-link" href="__SITE_RESERVE__">${escapeHtml(generic('Request a table', '提交订位申请'))}</a></section>`;
    }
    return '';
  };
  const chunks: string[] = [];
  const compiledOrigins: Array<{ start: number; source: number }> = [];
  let length = 0, count = 0, invalidComponentNesting = false;
  const append = (value: string, source = 0) => {
    if (!value) return;
    chunks.push(value);
    compiledOrigins.push({ start: length, source });
    length += value.length;
  };
  const render = (node: DefaultTreeAdapterMap['node'], ancestors: string[] = [], parentSource = 0) => {
    if (++count > 5000 || ancestors.length > 80) invalid('STRUCTURE_TOO_LARGE');
    if (node.nodeName === '#text') { append(escapeHtml((node as DefaultTreeAdapterMap['textNode']).value), parentSource); return; }
    if (!('tagName' in node)) return;
    if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml') invalid('HTML_TAG_FORBIDDEN');
    const tag = node.tagName.toLowerCase(), source = origins.get(node) ?? parentSource;
    if (forbiddenTags.has(tag) || tag.includes(':')) invalid('HTML_TAG_FORBIDDEN');
    const attrs = new Map(node.attrs.map(a => [a.name, a.value]));
    const attributes = attributesFor(tag, node.attrs, snapshot, report, null, styles, '');
    if (tokenTags.has(tag)) {
      if ((blockComponents.has(tag) && ancestors.some(parent => inlineParents.has(parent))) || (tag === 'restaurant-contact' && ancestors.includes('a'))) {
        invalidComponentNesting = true;
        htmlReport('COMPILED_INVALID_NESTING', source);
      }
      if (node.childNodes.some(child => child.nodeName !== '#text' || (child as DefaultTreeAdapterMap['textNode']).value.trim())) report('WARNING_FACT_CHILDREN');
      const value = component(tag, attrs), container = blockComponents.has(tag) ? 'div' : 'span';
      append(`<${container}${attributes}>${value}</${container}>`, source);
      return;
    }
    if (tag === 'img') {
      const asset = snapshot.assets.find(a => attrs.get('src') === assetPlaceholder(a.id));
      if (asset) renderedImages.add(asset.id);
    }
    append(`<${tag}${attributes}>`, source);
    if (!voidTags.has(tag)) {
      for (const child of node.childNodes) render(child, [...ancestors, tag], source);
      append(`</${tag}>`, source);
    }
  };
  for (const node of fragment.childNodes) render(node);
  const missing: string[] = [];
  for (const tag of ['restaurant-name','restaurant-description','restaurant-address','restaurant-contact','restaurant-hours','restaurant-menu']) {
    if (!seen.has(tag)) missing.push(`<div class="site-required-fact">${component(tag, new Map())}</div>`);
  }
  for (const aid of imageIds) if (!renderedImages.has(aid)) missing.push(`<div class="site-required-image">${component('restaurant-image', new Map([['data-asset-id', aid]]))}</div>`);
  // 已开启订位的餐厅即使模型没写组件，也在页面补一个真实入口，避免网站没有订位方式。
  if (r.reservation_enabled && !seen.has('restaurant-reservation')) missing.push(`<div class="site-required-fact">${component('restaurant-reservation', new Map())}</div>`);
  if (missing.length) {
    report('WARNING_FACT_FALLBACK');
    append(`<footer class="site-required">${missing.join('')}</footer>`);
  }
  const base = '*,*::before,*::after{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;min-height:100vh;color:#242820;background:#fff;font-family:system-ui,sans-serif}img{max-width:100%;height:auto}a:focus-visible{outline:2px solid currentColor;outline-offset:4px}.site-required{padding:32px;max-width:1100px;margin:auto}.site-menu-category ul{list-style:none;padding:0}.site-menu-item{padding:14px 0;border-bottom:1px solid #e4e6e1}.site-menu-item-heading{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}.site-menu-price{white-space:pre-wrap}.site-menu-description{font-size:14px;line-height:1.7}.site-hours{list-style:none;padding:0}.site-required-image img{max-height:520px;object-fit:cover}.site-service-note{padding:20px;text-align:center;font:12px system-ui;color:#585d54;border-top:1px solid #e4e6e1}.site-reservation{padding:44px 20px;margin:24px auto;max-width:720px;border-top:1px solid #e4e6e1;text-align:center}.site-reservation h2{font-size:22px;font-weight:500;margin:0 0 12px}.site-reservation-notice{color:#585d54;font-size:14px;line-height:1.7;margin:0 0 20px}.site-reservation-link{display:inline-block;padding:12px 22px;border:1px solid currentColor;color:inherit;text-decoration:none}.site-reservation-link:focus-visible{outline:2px solid currentColor;outline-offset:4px}';
  const motion = '@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}';
  const note = r.reservation_enabled
    ? generic('Reservation requests are confirmed by the restaurant.', '订位申请由餐厅确认。')
    : generic('Online reservations are not available on this website. Please contact the restaurant directly.', '本网站尚未提供在线订位，请直接联系餐厅。');
  append(`<footer class="site-service-note">${escapeHtml(note)}</footer>`);
  const body = chunks.join('');
  const html = `<!DOCTYPE html><html lang="${escapeHtml(r.primary_locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(WEBSITE_CSP)}"><meta name="referrer" content="no-referrer"><title>${escapeHtml(r.name)}</title><meta name="description" content="${escapeHtml((r.description ?? '').slice(0, 240))}"><style>${base}${css}${motion}</style></head><body>${body}</body></html>`;
  if (Buffer.byteLength(html) > 200 * 1024) invalid('COMPILED_TOO_LARGE');
  inspectCompiledBody(body, (code, offset = 0) => {
    // 已在原始组件标签报告的布局错误，不再用 parser 的连锁重排误定位外层 p/a。
    if (code === 'COMPILED_INVALID_NESTING' && invalidComponentNesting) return;
    let low = 0, high = compiledOrigins.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high + 1) / 2);
      if (compiledOrigins[middle]!.start <= offset) low = middle;
      else high = middle - 1;
    }
    htmlReport(code, compiledOrigins[low]?.source ?? 0);
  });
  return { html, checksum: createHash('sha256').update(html).digest('hex') };
}
