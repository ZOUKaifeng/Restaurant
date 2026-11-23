import { existsSync, readFileSync } from 'node:fs';
import type { WebsiteSnapshot } from './website-html.js';
import type { WebsiteToolDefinition, WebsiteVisionImage } from './website-agent-types.js';

const source = new URL('../contracts/website-agent-capabilities.json', import.meta.url);
export const websiteAgentContract: unknown = JSON.parse(readFileSync(existsSync(source) ? source : new URL('../../contracts/website-agent-capabilities.json', import.meta.url), 'utf8'));
export function publicWebsiteSnapshot(snapshot: WebsiteSnapshot, images: WebsiteVisionImage[] = []): unknown {
  return {
    restaurant: { ...snapshot.restaurant }, opening_hours: snapshot.opening_hours.map(h => ({ ...h })),
    assets: snapshot.assets.map(a => ({ id: a.id, kind: a.kind, mime_type: a.mime_type, checksum: a.checksum, width_px: a.width_px, height_px: a.height_px })),
    ...(images.length ? { vision: {
      available_asset_ids: images.map(image => image.asset_id),
      images: images.map(image => ({ asset_id: image.asset_id, kind: snapshot.assets.find(asset => asset.id === image.asset_id)!.kind,
        mime_type: image.mime_type, width_px: image.width_px, height_px: image.height_px })),
      source: '当前可看像素仅在固定的第二条 user 消息；此处只有授权缩图清单，不含图片数据。',
    } } : {}),
    menu: snapshot.menu ? { revision: snapshot.menu.revision, data: { categories: snapshot.menu.data.categories.map(category => ({ name: category.name, items: category.items.map(item => ({ name: item.name, description: item.description, price_text: item.price_text })) })) } } : null,
  };
}
function tool(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): WebsiteToolDefinition {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}
export const websiteAgentTools: WebsiteToolDefinition[] = [
  tool('read_context', '读取冻结的公开餐厅事实、人工确认菜单、选中素材元数据和能力契约。若有 vision 清单，仅说明第二条 user 消息当前可看的授权缩图 ID；不是独立识图调用，不含图片数据、凭证或商家写入能力。'),
  tool('update_plan', 'Create/update your own task TODO. Plan before writing; update statuses as actions really complete.', { items: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', properties: { id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,39}$' }, title: { type: 'string', minLength: 1, maxLength: 150 }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, required: ['id', 'title', 'status'], additionalProperties: false } } }, ['items']),
  tool('write_draft', 'Write or repair virtual HTML body/CSS. Not published. Each write invalidates the previous check. Continue repairs until actual validation passes; there is no overall draft or repair-count limit in observation mode.', { html_body: { type: 'string', minLength: 1, maxLength: 102400 }, css: { type: 'string', maxLength: 40960 }, summary: { type: 'string', minLength: 1, maxLength: 800 } }, ['html_body', 'css', 'summary']),
  tool('validate_draft', 'Run the actual deterministic server HTML/CSS/asset inspection on the current draft. Read ok plus file/line/column/code feedback. Fix errors with write_draft then check again.'),
  tool('finish', 'Finish this generation only after current draft passes validation and all plan items completed. Saves a preview version; does not publish.'),
];
