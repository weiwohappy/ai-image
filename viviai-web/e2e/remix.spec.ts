import { expect, test } from '@playwright/test';

test('creates a viral remix task from a curated template', async ({ page }) => {
  await page.goto('/#/remix/template-1');
  await expect(page.getByRole('heading', { name: '高透香氛主图' })).toBeVisible();
  await page.getByLabel('描述你要修改的内容').fill('替换为新款咖啡礼盒，棕金配色');
  await page.getByRole('button', { name: '开始复刻' }).click();
  await expect(page.getByText('复刻任务已提交，正在排队。')).toBeVisible();
});
