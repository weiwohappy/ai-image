import { expect, test } from '@playwright/test';

for (const viewport of [
  { width: 1440, height: 900, name: 'desktop' },
  { width: 1024, height: 768, name: 'tablet' },
  { width: 390, height: 844, name: 'mobile' },
]) {
  test(`creation workspace fits ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/#/create');
    await expect(page.getByRole('button', { name: '开始生成' })).toBeVisible();
    const noPageOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noPageOverflow).toBe(true);
    if (viewport.width === 390) await expect(page.getByRole('button', { name: '打开导航' })).toBeVisible();
  });
}
