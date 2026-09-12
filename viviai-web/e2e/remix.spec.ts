import { expect, test, type Page } from '@playwright/test';

async function imageFile(page: Page, name: string) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#c69662';
    context.fillRect(0, 0, 800, 600);
    context.fillStyle = '#fff0df';
    context.fillRect(240, 110, 220, 340);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return { name, mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
}

test('uploads a user reference and optional subject, then creates a remix with both images', async ({ page }) => {
  await page.goto('/#/remix');
  await expect(page.getByRole('heading', { name: '爆款复刻', exact: true })).toBeVisible();
  await page.getByLabel(/描述希望保留和修改的内容/).fill('保留暖色光影和构图，替换为我的咖啡礼盒');
  await expect(page.getByRole('button', { name: '开始复刻' })).toBeDisabled();
  await page.getByLabel('上传爆款参考图', { exact: true }).setInputFiles(await imageFile(page, '爆款海报.png'));
  await expect(page.getByAltText('爆款参考图预览')).toBeVisible();
  await page.getByText('加入我的商品 / 主体素材').click();
  await page.getByLabel('上传主体素材', { exact: true }).setInputFiles(await imageFile(page, '我的商品.png'));
  await expect(page.getByAltText('主体素材预览')).toBeVisible();
  const request = page.waitForRequest((request) => request.url().endsWith('/api/remix-tasks'));
  await page.getByRole('button', { name: '开始复刻' }).click();
  const payload = (await request).postDataJSON();
  expect(payload.referenceAssetId).toMatch(/^remix-upload-/);
  expect(payload.subjectAssetId).toMatch(/^remix-upload-/);
  expect(payload.referenceAssetId).not.toBe(payload.subjectAssetId);
  expect(payload.templateId).toBeUndefined();
  await expect(page.getByText('生成成功', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('img', { name: /保留暖色光影和构图/ })).toBeVisible();
});

test('preserves uploaded reference and prompt through the login redirect', async ({ page }) => {
  await page.goto('/#/remix');
  await expect(page.getByRole('heading', { name: '爆款复刻', exact: true })).toBeVisible();
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await page.reload();
  await page.getByLabel('上传爆款参考图', { exact: true }).setInputFiles(await imageFile(page, '我的参考图.png'));
  await expect(page.getByAltText('爆款参考图预览')).toBeVisible();
  await page.getByLabel(/描述希望保留和修改的内容/).fill('保留构图，把主体改成咖啡');
  let submissions = 0;
  page.on('request', (request) => { if (request.url().endsWith('/api/remix-tasks')) submissions += 1; });
  await page.getByRole('button', { name: '开始复刻' }).click();
  await expect(page.getByRole('heading', { name: '登录 VIVIAI' })).toBeVisible();
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByAltText('爆款参考图预览')).toBeVisible();
  await expect(page.getByText('生成成功', { exact: true }).first()).toBeVisible();
  expect(submissions).toBe(1);
});

test('validates, replaces and removes uploads and preserves text after refresh on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/remix');
  const upload = page.getByLabel('上传爆款参考图', { exact: true });
  await upload.setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not a real image') });
  await expect(page.getByRole('alert')).toContainText('图片无法读取');
  await upload.setInputFiles({ name: 'oversize.png', mimeType: 'image/png', buffer: Buffer.alloc(6 * 1024 * 1024) });
  await expect(page.getByRole('alert')).toContainText('5MB');
  await upload.setInputFiles(await imageFile(page, '第一张.png'));
  await expect(page.getByText('第一张.png', { exact: true })).toBeVisible();
  await upload.setInputFiles(await imageFile(page, '第二张.png'));
  await expect(page.getByText('第二张.png', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '移除爆款参考图' }).click();
  await expect(page.getByAltText('爆款参考图预览')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '开始复刻' })).toBeDisabled();
  await upload.setInputFiles(await imageFile(page, '重新上传.png'));
  await expect(page.getByAltText('爆款参考图预览')).toBeVisible();
  await page.getByLabel(/描述希望保留和修改的内容/).fill('保留光影，修改商品');
  await page.reload();
  await expect(page.getByLabel(/描述希望保留和修改的内容/)).toHaveValue('保留光影，修改商品');
  await expect(page.getByText('你的复刻要求已保留，请重新上传参考图后继续。')).toBeVisible();
  await expect(page.getByRole('button', { name: '开始复刻' })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
