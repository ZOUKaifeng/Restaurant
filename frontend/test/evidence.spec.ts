import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Screenshots only contain synthetic test-account data, not production customer records.
test.use({ ignoreHTTPSErrors: true, trace: 'off', screenshot: 'off', video: 'off' });
test('账户与餐厅真实页面及移动布局证据', async ({ page }) => {
  if (!process.env.E2E_EMAIL || !process.env.E2E_PASSWORD) throw new Error('Dedicated UI test fixture required');
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.goto('/auth/login');
  await expect(page.getByRole('heading', { name: '登录商家账户' })).toBeVisible();
  await page.screenshot({ path: fileURLToPath(new URL('../../outputs/商家登录页面.png', import.meta.url)), fullPage: true });
  await page.getByLabel('邮箱', { exact: true }).fill(process.env.E2E_EMAIL);
  await page.getByLabel('密码', { exact: true }).fill(process.env.E2E_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '餐厅资料', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^UI冒烟-/ }).first().click();
  await expect(page.getByRole('button', { name: '保存餐厅资料', exact: true })).toBeVisible();
  await page.screenshot({ path: fileURLToPath(new URL('../../outputs/商家餐厅管理页面.png', import.meta.url)), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('时区', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: fileURLToPath(new URL('../../outputs/商家餐厅管理移动端.png', import.meta.url)), fullPage: true });
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录商家账户' })).toBeVisible();
});
