import { expect, test } from '@playwright/test';
import {
  buildPreviewDocument, PREVIEW_DOCUMENT_LIMIT, PREVIEW_PLACEHOLDER_IMAGE,
  previewDocumentUrl, rewriteWebsitePreview, textDataUrl,
} from '../src/website-preview';

const assetId = 'ast_1234567890123456789012';
const sample = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>sample</title></head><body>` +
  `<h1 id="top">Preview</h1><nav><a href="#menu">Menu</a></nav>` +
  `<img id="photo" src="__SITE_ASSET_${assetId}__" alt="sample">` +
  `<div style="height:1800px"></div><h2 id="menu">Menu section</h2></body></html>`;

test('预览文档改写保留锚点并只接受安全资源地址', () => {
  const rewritten = rewriteWebsitePreview(sample, new Map([[assetId, PREVIEW_PLACEHOLDER_IMAGE]]));
  expect(rewritten).toContain('href="#menu"');
  expect(rewritten).toContain(PREVIEW_PLACEHOLDER_IMAGE);
  expect(rewritten).toContain('Content-Security-Policy');
  expect(previewDocumentUrl(rewritten)).toMatch(/^data:text\/html;charset=utf-8,/);
  expect(textDataUrl('请下载菜单 PDF')).toMatch(/^data:text\/plain;base64,/);

  expect(() => rewriteWebsitePreview(sample, new Map([[assetId, 'javascript:alert(1)']]))).toThrow();
  expect(() => rewriteWebsitePreview(sample, new Map())).toThrow();
  expect(() => previewDocumentUrl('x'.repeat(1_100_000))).toThrow();
});

test('新窗口完整预览的 blob 文档可以正常打开', async ({ page, context }) => {
  await page.goto('/');
  const url = await page.evaluate(() => URL.createObjectURL(new Blob([
    '<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" ' +
    'content="default-src \'none\'; img-src blob: data:; style-src \'unsafe-inline\'; script-src \'none\'"></head>' +
    '<body><h1>Full preview</h1></body></html>',
  ], { type: 'text/html;charset=utf-8' })));
  const popup = await context.newPage();
  await popup.goto(url);
  await expect(popup.locator('h1')).toHaveText('Full preview');
  await popup.close();
});

test('大图超出隔离预览预算时降级为占位，不让整个预览失效', () => {
  const first = 'ast_1111111111111111111111';
  const second = 'ast_2222222222222222222222';
  const large = `data:image/png;base64,${'A'.repeat(600_000)}`;
  const html = `<html><head></head><body><img src="__SITE_ASSET_${first}__"><img src="__SITE_ASSET_${second}__"></body></html>`;
  const urls = new Map([[first, large], [second, large]]);
  const result = buildPreviewDocument(html, urls, [{ id: first, length: large.length }, { id: second, length: large.length }]);
  expect(result.reducedImages).toBeGreaterThan(0);
  expect(result.documentUrl.length).toBeLessThanOrEqual(PREVIEW_DOCUMENT_LIMIT);
  expect(result.documentUrl).toContain(encodeURIComponent(PREVIEW_PLACEHOLDER_IMAGE));
});

test('沙箱预览内菜单锚点可跳转、内嵌图片可见、切换尺寸后内容仍在', async ({ page }) => {
  const url = previewDocumentUrl(rewriteWebsitePreview(sample, new Map([[assetId, PREVIEW_PLACEHOLDER_IMAGE]])));
  const harness = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0">` +
    `<div id="wrap" style="width:100%"><iframe id="pv" sandbox="allow-popups allow-popups-to-escape-sandbox allow-downloads" style="display:block;width:100%;height:600px;border:0"></iframe></div></body></html>`;
  await page.setContent(harness);
  await page.evaluate((src: string) => {
    (document.getElementById('pv') as HTMLIFrameElement).src = src;
  }, url);

  // iframe 加载期间执行上下文会被销毁，轮询时把这类瞬时异常当成「尚未就绪」。
  async function frameValue<T>(read: () => T): Promise<T | null> {
    const frame = page.frames().find(item => item !== page.mainFrame());
    if (!frame) return null;
    try { return await frame.evaluate(read); } catch { return null; }
  }
  await expect.poll(() => frameValue(() => document.querySelector('h1')?.textContent ?? null)).toBe('Preview');
  expect(await frameValue(() => (document.getElementById('photo') as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  await page.frameLocator('#pv').locator('a[href="#menu"]').click();
  await expect.poll(() => frameValue(() => Math.round(window.scrollY))).toBeGreaterThan(200);

  // 模拟界面切换桌面／手机时按 viewport 重建 iframe：文档必须重新完整显示，且回到顶部。
  await page.evaluate((src: string) => {
    const previous = document.getElementById('pv') as HTMLIFrameElement;
    const next = document.createElement('iframe');
    next.id = 'pv';
    next.setAttribute('sandbox', previous.getAttribute('sandbox') ?? '');
    next.style.cssText = previous.style.cssText;
    next.src = src;
    previous.replaceWith(next);
    (document.getElementById('wrap') as HTMLElement).style.width = '390px';
  }, url);
  await expect.poll(() => frameValue(() => document.querySelector('h1')?.textContent ?? null)).toBe('Preview');
  await expect.poll(() => frameValue(() => Math.round(window.scrollY))).toBe(0);
});
