import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { recognizeMenuImages } from '../src/deepseek.js';

async function main() {
  const image = await sharp(Buffer.from('<svg width="1000" height="750" xmlns="http://www.w3.org/2000/svg"><rect width="1000" height="750" fill="white"/><g fill="#242b26" font-family="sans-serif"><text x="70" y="95" font-size="48">SAMPLE MENU</text><text x="70" y="175" font-size="34">MAINS</text><text x="70" y="260" font-size="30">Margherita Pizza</text><text x="760" y="260" font-size="30">$12.50</text><text x="70" y="310" font-size="24">Tomato, mozzarella, basil</text><text x="70" y="395" font-size="30">Mushroom Pasta</text><text x="760" y="395" font-size="30">$15.00</text><text x="70" y="445" font-size="24">Mushrooms and cream sauce</text><text x="70" y="535" font-size="34">DRINKS</text><text x="70" y="620" font-size="30">Lemonade</text><text x="790" y="620" font-size="30">$4.00</text></g></svg>')).png().toBuffer();
  const output = await recognizeMenuImages(loadConfig(), [{ bytes: image, mime_type: 'image/png' }]);
  const items = output.data.categories.flatMap(category => category.items);
  if (!items.some(item => item.name === 'Margherita Pizza' && item.price_text === '$12.50') || !items.some(item => item.name === 'Mushroom Pasta' && item.price_text === '$15.00') || !items.some(item => item.name === 'Lemonade' && item.price_text === '$4.00')) throw new Error('Visual sample did not match readable prices');
  await writeFile(new URL('../../outputs/菜单识图-合成测试图片.png', import.meta.url), image);
  await writeFile(new URL('../../outputs/菜单识图-真实模型结果.json', import.meta.url), JSON.stringify({ sample_is_synthetic: true, merchant_confirmed: false, model: output.model, data: output.data, usage: output.usage }, null, 2));
  process.stdout.write(JSON.stringify({ model: output.model, direct_image_input: true, independent_ocr: false, sample_price_check: 'passed', item_count: items.length, database_modified: false, usage: output.usage }) + '\n');
}
main().catch(error => { process.stderr.write(JSON.stringify({ vision_probe_failed: true, error_code: error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'SAMPLE_CHECK_FAILED' }) + '\n'); process.exitCode = 1; });
