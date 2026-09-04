import { expect, test } from '@playwright/test';

test('saves a workflow and runs selected rows as a batch', async ({ page }) => {
  await page.goto('/#/workflows/new');
  const run = page.getByRole('button', { name: '运行所选 2 个任务' });
  await expect(run).toBeDisabled();
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText(/已保存 · 版本 1/)).toBeVisible();
  await run.click();
  await expect(page).toHaveURL(/#\/tasks$/);
  await expect(page.getByText('批次完成')).toBeVisible({ timeout: 10_000 });
});
