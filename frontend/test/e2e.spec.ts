import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// 只使用真实服务和界面；已验证账户由项目方通过环境变量提供。
// 禁止通过 API、数据库或日志提取邮件令牌；关闭凭据可能进入的媒体与追踪。
test.use({
  baseURL: process.env.FRONTEND_BASE_URL ?? 'https://localhost:5173',
  ignoreHTTPSErrors: true,
  trace: 'off',
  screenshot: 'off',
  video: 'off',
});
const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;
async function login(page: Page) {
  await page.goto('/auth/login');
  await page.getByLabel('Email address', { exact: true }).fill(email!);
  await page.getByLabel('Password', { exact: true }).fill(password!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('heading', { name: 'My restaurants', exact: true })).toBeVisible();
  await expect(page.locator('.dashboard-page-heading').getByRole('button', { name: 'Create restaurant', exact: true })).toBeEnabled();
}

test('根路由显示英文公开首页，不是登录页或餐厅列表', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Your restaurant. A better first impression.', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute('href', '/auth/login');
  await expect(page.getByRole('heading', { name: 'Welcome back', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'My restaurants', exact: true })).toHaveCount(0);
});

test('匿名启动正常显示登录，不把 me 的 401 显示为报错', async ({ page }) => {
  const me = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/me'));
  await page.goto('/auth/login');
  expect((await me).status()).toBe(401);
  await expect(page.getByRole('heading', { name: 'Welcome back', exact: true })).toBeVisible();
  await expect(page.getByText('Error code: UNAUTHENTICATED', { exact: false })).toHaveCount(0);
});

for (const action of ['verify', 'reset'] as const) {
  test(`${action} 链接清除 URL，加载不自动消费令牌`, async ({ page }) => {
    const token = `synthetic-action-${crypto.randomUUID()}`;
    const posts: string[] = [];
    page.on('request', (request) => { if (request.method() === 'POST') posts.push(new URL(request.url()).pathname); });
    await page.goto(`/auth/${action}?token=${encodeURIComponent(token)}`);
    await expect(page.getByRole('heading', { name: action === 'verify' ? 'Confirm your email' : 'Set a new password', exact: true })).toBeVisible();
    expect(new URL(page.url()).search).toBe('');
    expect(await page.locator('body').innerText()).not.toContain(token);
    expect(await page.evaluate(() => JSON.stringify(window.history.state))).not.toContain(token);
    expect(posts).toEqual([]);
    await expect(page.getByRole('button', { name: action === 'verify' ? 'Verify and continue' : 'Confirm new password', exact: true })).toBeVisible();
  });
}

test('真实注册返回中性受理文案，不声称邮件送达或验证完成', async ({ page }) => {
  test.skip(!process.env.E2E_REGISTER_EMAIL, '需项目方提供专用注册邮箱；此测试不取得邮件令牌。');
  await page.goto('/auth/register');
  await page.getByLabel('Email address', { exact: true }).fill(process.env.E2E_REGISTER_EMAIL!);
  await page.getByLabel('Password', { exact: true }).fill(`Smoke-password-${crypto.randomUUID()}`);
  await page.getByLabel('Language', { exact: true }).selectOption('en');
  await page.getByRole('checkbox', { name: 'I have read and accept the current draft terms', exact: false }).check();
  const accepted = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/register') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  expect((await accepted).status()).toBe(202);
  await expect(page.getByRole('heading', { name: 'Check your email', exact: true })).toBeVisible();
  await expect(page.getByText('Open the verification link to continue.', { exact: true })).toBeVisible();
  expect(await page.locator('.tf-auth').innerText()).not.toMatch(/\b(?:sent|delivered|success)\b/i);
});

test.describe('已验证账户的真实商家闭环', () => {
  test.beforeEach(() => { test.skip(!email || !password, '需要项目方准备 E2E_EMAIL 和 E2E_PASSWORD；缺 SMTP 时不绕过验证。'); });

  test('登录、建店、改资料、跨日营业、重读、退出', async ({ page }) => {
    const name = `UI冒烟-${crypto.randomUUID().slice(0, 8)}`;
    await login(page);
    await page.locator('.dashboard-page-heading').getByRole('button', { name: 'Create restaurant', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Create restaurant', exact: true })).toBeVisible();
    const creationPanel = page.getByRole('region', { name: 'Start with the essentials.', exact: true });
    await creationPanel.getByLabel('Restaurant name', { exact: true }).fill(name);
    await creationPanel.getByLabel('Primary language', { exact: true }).selectOption('en');
    const creation = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/restaurants' && response.request().method() === 'POST');
    await creationPanel.getByRole('button', { name: 'Create restaurant', exact: true }).click();
    const result = await creation;
    expect(result.status()).toBe(201);
    const key = result.request().headers()['idempotency-key'];
    expect(key.length).toBeGreaterThanOrEqual(16);
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Restaurant workspace', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '餐厅管理', exact: true })).toBeVisible();
    await expect(page.getByText('Connected workspace · Existing restaurant tools', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '餐厅资料', exact: true }).click();
    await page.getByLabel('城市', { exact: false }).fill('测试城市');
    await page.getByLabel('时区', { exact: false }).fill('UTC');
    await page.getByRole('button', { name: '保存餐厅资料', exact: true }).click();
    await expect(page.getByText('餐厅资料已保存。仅更新草稿', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: '周营业时间', exact: true }).click();
    await page.getByRole('button', { name: '添加营业时段', exact: true }).click();
    await page.getByLabel('星期', { exact: true }).selectOption('7');
    await page.getByLabel('开始时间', { exact: true }).fill('18:00');
    await page.getByLabel('结束时间', { exact: true }).fill('02:00');
    await page.getByLabel('结束日期', { exact: true }).selectOption('1');
    await page.getByRole('button', { name: '保存周营业时间', exact: true }).click();
    await expect(page.getByText('周营业时间已保存，餐厅资料版本已同步。', { exact: false })).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole('heading', { name: 'My restaurants', exact: true })).toBeVisible();
    await page.getByRole('button', { name: `Open workspace for ${name}`, exact: true }).click();
    await page.getByRole('button', { name: '餐厅资料', exact: true }).click();
    await expect(page.getByLabel('时区', { exact: false })).toHaveValue('UTC');
    await page.getByRole('button', { name: '周营业时间', exact: true }).click();
    await expect(page.getByLabel('星期', { exact: true })).toHaveValue('7');
    await expect(page.getByLabel('结束日期', { exact: true })).toHaveValue('1');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(/\/auth\/login$/);
    await expect(page.getByRole('heading', { name: 'Welcome back', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Welcome back', exact: true })).toBeVisible();
  });

  test('两个窗口的旧版本不能覆盖，新内容保留至确认刷新', async ({ page, context }) => {
    const name = `UI冲突-${crypto.randomUUID().slice(0, 8)}`;
    await login(page);
    await page.locator('.dashboard-page-heading').getByRole('button', { name: 'Create restaurant', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Create restaurant', exact: true })).toBeVisible();
    const creationPanel = page.getByRole('region', { name: 'Start with the essentials.', exact: true });
    await creationPanel.getByLabel('Restaurant name', { exact: true }).fill(name);
    await creationPanel.getByLabel('Primary language', { exact: true }).selectOption('en');
    await creationPanel.getByRole('button', { name: 'Create restaurant', exact: true }).click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await page.getByRole('button', { name: '餐厅资料', exact: true }).click();
    const other = await context.newPage();
    await other.goto('/app');
    await expect(other.getByRole('heading', { name: 'My restaurants', exact: true })).toBeVisible();
    await other.getByRole('button', { name: `Open workspace for ${name}`, exact: true }).click();
    await other.getByRole('button', { name: '餐厅资料', exact: true }).click();
    await expect(other.getByLabel('城市', { exact: false })).toBeVisible();
    await page.getByLabel('城市', { exact: false }).fill('第一窗口');
    await page.getByRole('button', { name: '保存餐厅资料', exact: true }).click();
    await expect(page.getByText('餐厅资料已保存。仅更新草稿', { exact: false })).toBeVisible();
    await other.getByLabel('城市', { exact: false }).fill('第二窗口未保存');
    const conflict = other.waitForResponse((response) => response.request().method() === 'PATCH');
    await other.getByRole('button', { name: '保存餐厅资料', exact: true }).click();
    expect((await conflict).status()).toBe(412);
    await expect(other.getByLabel('城市', { exact: false })).toHaveValue('第二窗口未保存');
    await expect(other.getByRole('button', { name: '保存餐厅资料', exact: true })).toBeDisabled();
    await other.getByRole('button', { name: '刷新资料', exact: true }).click();
    await expect(other.getByRole('heading', { name: '确认用服务端资料替换本页内容？', exact: true })).toBeVisible();
    await expect(other.getByLabel('城市', { exact: false })).toHaveValue('第二窗口未保存');
    await other.getByRole('button', { name: '确认刷新并放弃未保存内容', exact: true }).click();
    await expect(other.getByLabel('城市', { exact: false })).toHaveValue('第一窗口');
    await other.close();
  });
});
