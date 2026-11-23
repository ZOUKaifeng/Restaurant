import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// 仅准备证据脚本，本次不执行；截图只允许包含专用测试账户的合成数据，不含生产客户记录。
test.use({ ignoreHTTPSErrors: true, trace: 'off', screenshot: 'off', video: 'off' });
test('账户与餐厅真实页面及移动布局证据', async ({ page }) => {
  if (!process.env.E2E_EMAIL || !process.env.E2E_PASSWORD) throw new Error('Dedicated UI test fixture required');
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.goto('/auth/login');
  await expect(page.getByRole('heading', { name: 'Welcome back', exact: true })).toBeVisible();
  await page.screenshot({ path: fileURLToPath(new URL('../../outputs/商家登录页面.png', import.meta.url)), fullPage: true });
  await page.getByLabel('Email address', { exact: true }).fill(process.env.E2E_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(process.env.E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('heading', { name: 'My restaurants', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Open workspace for UI冒烟-/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Restaurant workspace', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '餐厅管理', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '餐厅资料', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存餐厅资料', exact: true })).toBeVisible();
  await page.screenshot({ path: fileURLToPath(new URL('../../outputs/商家餐厅管理页面.png', import.meta.url)), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('时区', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: fileURLToPath(new URL('../../outputs/商家餐厅管理移动端.png', import.meta.url)), fullPage: true });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/auth\/login$/);
  await expect(page.getByRole('heading', { name: 'Welcome back', exact: true })).toBeVisible();
});
