import { writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { callWebsiteAgent, generateWebsite } from '../src/deepseek.js';
import { renderWebsite, type WebsiteSnapshot } from '../src/website-html.js';

async function main() {
  const config = loadConfig();
  const snapshot: WebsiteSnapshot = { restaurant: { id: 'rst_example_not_a_real_record', name: 'Willow Table — Example restaurant', description: 'A demonstration restaurant website using fictional business information for model integration review.', cuisine_type: 'Seasonal dining', address_line1: null, address_line2: null, city: null, region: null, postal_code: null, country_code: null, contact_email: null, contact_phone: null, timezone: null, currency: null, primary_locale: 'en' }, opening_hours: [], assets: [] };
  const agent = await callWebsiteAgent(config, [{ role: 'user', content: '做一个白底、极简、细字体、深绿色点缀的餐厅官网，大留白，品牌和介绍在首屏，菜单和联系信息在下方。没有照片就不要编造照片，无需再追问，给我生成方向。' }], snapshot);
  const output = await generateWebsite(config, agent.design_brief || 'Minimal white restaurant homepage with generous whitespace and dark green accent.', snapshot);
  const page = renderWebsite(output, snapshot);
  await writeFile(new URL('../../outputs/网页生成-真实模型样例.html', import.meta.url), page.html, { mode: 0o644 });
  process.stdout.write(JSON.stringify({ model: output.model, agent_connected: true, generation_connected: true, safe_html_generated: true, html_bytes: Buffer.byteLength(page.html), usage: output.usage, sample_is_fictional: true, database_modified: false }) + '\n');
}
main().catch(error => { process.stderr.write(JSON.stringify({ model_probe_failed: true, error_code: error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'PROBE_FAILED' }) + '\n'); process.exitCode = 1; });
