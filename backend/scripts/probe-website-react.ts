import { writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { runWebsiteAgent } from '../src/website-react.js';
import type { WebsiteSnapshot } from '../src/website-html.js';
import type { WebsiteAgentObservation } from '../src/website-agent-types.js';

async function main() {
  const config = loadConfig();
  const snapshot: WebsiteSnapshot = { restaurant: { id: 'sample', name: 'Willow Table — Example restaurant', description: 'An explicitly fictional restaurant used to review website generation. Seasonal food, a quiet setting and a simple menu.', cuisine_type: 'Seasonal dining', address_line1: null, address_line2: null, city: null, region: null, postal_code: null, country_code: null, contact_email: null, contact_phone: null, timezone: null, currency: null, primary_locale: 'en' }, opening_hours: [], assets: [], menu: { revision: 1, data: { categories: [{ name: 'Example menu', items: [{ name: 'Margherita Pizza', description: 'Tomato, mozzarella, basil', price_text: '$12.50', review_note: null }, { name: 'Mushroom Pasta', description: 'Mushrooms and cream sauce', price_text: '$15.00', review_note: null }] }], warnings: [] } } };
  const trace: Array<Omit<WebsiteAgentObservation, 'draft'>> = [];
  const output = await runWebsiteAgent(config, '创建白底、大留白、细字体、深绿色点缀的餐厅官网。先读取真实能力契约，自行制定计划，生成页面并调用校验；失败修复后再次校验，计划完成再结束。使用table或details和现代CSS函数等正常静态写法都可以，菜单使用restaurant-menu。没有照片不要造图片。', snapshot, async observation => {
    trace.push({ progress: structuredClone(observation.progress), event: structuredClone(observation.event) });
    process.stdout.write(JSON.stringify({ action: observation.event.action, round: observation.progress.round, model_calls: observation.progress.model_calls, valid_step: observation.event.status }) + '\n');
  });
  if (!output.html.includes('Margherita Pizza') || !output.html.includes('$12.50') || !trace.some(step => step.event.action === 'validate_draft' && step.event.status === 'ok') || !output.progress.plan.every(item => item.status === 'completed')) throw new Error('Agent sample failed deterministic verification');
  await writeFile(new URL('../../outputs/网页ReAct-真实模型样例.html', import.meta.url), output.html);
  await writeFile(new URL('../../outputs/网页ReAct-执行轨迹样例.json', import.meta.url), JSON.stringify({ sample_is_fictional: true, database_modified: false, public_deployed: false, model: output.model, usage: output.usage, progress: output.progress, trace }, null, 2));
  process.stdout.write(JSON.stringify({ actual_native_tool_calls: true, completed_plan: true, validated_html: true, published: false, model: output.model, usage: output.usage }) + '\n');
}
main().catch(error => { process.stderr.write(JSON.stringify({ react_probe_failed: true, error_code: error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'PROBE_FAILED' }) + '\n'); process.exitCode = 1; });
