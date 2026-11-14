import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rewritePublicAssetReferences } from '../src/sites.js';
const aid = 'ast_' + 'a'.repeat(24), vid = 'wsv_' + 'b'.repeat(24);
test('公共素材仅替换真实资源属性，不误杀或改写正文的占位符文字', () => {
  const token = `__SITE_ASSET_${aid}__`, url = `/s/my-restaurant/media/${aid}?version=${vid}`;
  const html = `<!DOCTYPE html><html><head><title>Website</title></head><body><p>Literal ${token} text __SITE_ASSET_</p><img src="${token}" alt="Photo"><a href="${token}">Menu</a></body></html>`;
  const rewritten = rewritePublicAssetReferences(html, new Map([[aid, url]]));
  assert.ok(rewritten.includes(`Literal ${token} text __SITE_ASSET_`));
  assert.ok(rewritten.includes(`src="${url}"`) && rewritten.includes(`href="${url}"`));
  assert.throws(() => rewritePublicAssetReferences(html, new Map()), { code: 'WEBSITE_MANIFEST_INVALID' });
});
