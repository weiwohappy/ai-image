import { expect, test } from '@playwright/test';

test('login preserves the prompt and completes generation', async ({ page }) => {
  await page.goto('/#/create');
  await expect(page.getByRole('heading', { name: '图片生成' })).toBeVisible();
  await page.evaluate(async () => {
    await fetch('/api/mock/reset', { method: 'POST' });
    await fetch('/api/auth/logout', { method: 'POST' });
  });
  await page.reload();
  await page.getByLabel('描述你想生成的画面').fill('透明香氛瓶，暖色电影光');
  await page.getByRole('button', { name: '开始生成' }).click();
  await expect(page.getByRole('heading', { name: '登录 VIVIAI' })).toBeVisible();
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('生成成功').first()).toBeVisible({ timeout: 10_000 });
});
