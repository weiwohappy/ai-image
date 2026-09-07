import { expect, test } from '@playwright/test';

test('cannot purchase before merchant activation', async ({ page }) => {
  await page.route('**/api/billing/catalog', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          enabled: false,
          plans: [],
          channels: [
            { channel: 'wechat', enabled: false },
            { channel: 'alipay', enabled: false },
          ],
        },
        message: 'ok',
        requestId: 'test',
      }),
    }),
  );
  await page.goto('/#/pricing');
  await expect(
    page.getByRole('heading', { name: '支付暂未开通' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '模拟支付成功' })).toHaveCount(
    0,
  );
});
