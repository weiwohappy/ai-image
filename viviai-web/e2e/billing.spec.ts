import { expect, test } from '@playwright/test';

test('simulates payment and updates account entitlements', async ({ page }) => {
  await page.goto('/#/pricing');
  await page.getByRole('button', { name: '购买高级版月卡' }).click();
  await page.getByRole('radio', { name: '支付宝' }).check();
  await page.getByRole('button', { name: '模拟支付成功' }).click();
  await expect(page.getByText('高级版月卡已到账')).toBeVisible();
  await expect(page.getByText('2,000 积分')).toBeVisible();
});
