import { existsSync, readFileSync } from 'node:fs';
import type { WebsiteSnapshot } from './website-html.js';
import type { WebsiteToolDefinition } from './website-agent-types.js';

const source = new URL('../contracts/website-agent-capabilities.json', import.meta.url);
export const websiteAgentContract: unknown = JSON.parse(readFileSync(existsSync(source) ? source : new URL('../../contracts/website-agent-capabilities.json', import.meta.url), 'utf8'));
export function publicWebsiteSnapshot(snapshot: WebsiteSnapshot): unknown {
  return {
    restaurant: { ...snapshot.restaurant }, opening_hours: snapshot.opening_hours.map(h => ({ ...h })),
    assets: snapshot.assets.map(a => ({ id: a.id, kind: a.kind, mime_type: a.mime_type, checksum: a.checksum, width_px: a.width_px, height_px: a.height_px })),
    menu: snapshot.menu ? { revision: snapshot.menu.revision, data: { categories: snapshot.menu.data.categories.map(category => ({ name: category.name, items: category.items.map(item => ({ name: item.name, description: item.description, price_text: item.price_text })) })) } } : null,
  };
}
function tool(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): WebsiteToolDefinition {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}
export const websiteAgentTools: WebsiteToolDefinition[] = [
  tool('read_context', 'Read the immutable authorized restaurant/menu/asset snapshot and implemented interface/HTML-component contract. No credentials or direct merchant writes.'),
  tool('update_plan', 'Create/update your own task TODO. Plan before writing; update statuses as actions really complete.', { items: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', properties: { id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,39}$' }, title: { type: 'string', minLength: 1, maxLength: 150 }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, required: ['id', 'title', 'status'], additionalProperties: false } } }, ['items']),
  tool('write_draft', 'Write or repair virtual HTML body/CSS. Not published. Each write invalidates the previous check. Continue repairs until actual validation passes; there is no overall draft or repair-count limit in observation mode.', { html_body: { type: 'string', minLength: 1, maxLength: 102400 }, css: { type: 'string', maxLength: 40960 }, summary: { type: 'string', minLength: 1, maxLength: 800 } }, ['html_body', 'css', 'summary']),
  tool('validate_draft', 'Run the actual deterministic server HTML/CSS/asset inspection on the current draft. Read ok plus file/line/column/code feedback. Fix errors with write_draft then check again.'),
  tool('finish', 'Finish this generation only after current draft passes validation and all plan items completed. Saves a preview version; does not publish.'),
];
