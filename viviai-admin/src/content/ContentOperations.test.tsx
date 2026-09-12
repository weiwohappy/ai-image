import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { AdminActor } from '../contracts';
import { AdminClient } from '../http';
import { availableNavigation } from '../navigation';
import { json } from '../test/fixtures';
import AdminApp from '../AdminApp';
import { ContentEditor } from './ContentEditor';
import { ContentListPage } from './ContentListPage';
import { MediaLibraryPage } from './MediaLibraryPage';
import type { InspirationRecord } from './contracts';

const contentActor: AdminActor = {
  id: 'content-admin',
  email: 'content@example.test',
  displayName: '内容同事',
  roles: ['content_operator'],
  permissions: [
    'content.inspirations.read',
    'content.inspirations.write',
    'content.inspirations.publish',
    'content.templates.read',
    'content.tools.read',
    'content.media.read',
    'content.media.write',
  ],
  sessionExpiresAt: '2099-01-01T00:00:00Z',
};

const inspiration: InspirationRecord = {
  resourceId: 'b77c8aa1-0b24-4d1b-8071-f8bb3e878625',
  id: 'b77c8aa1-0b24-4d1b-8071-f8bb3e878625',
  externalId: 'studio-portrait',
  title: '影棚肖像',
  description: '用于编辑测试的内容描述',
  category: '人像',
  creatorName: 'VIVIAI',
  sourceType: 'platform',
  sourceName: '内容团队',
  sourceUrl: 'https://example.test/source',
  editorialLabel: '精选',
  baseLikes: 12,
  tags: ['人像', '影棚'],
  defaultPrompt: '生成一张影棚肖像',
  defaultModelId: 'gpt-image-2',
  defaultOutputSpecId: 'square_1k',
  coverMediaExternalId: 'portrait-cover',
  caseMediaExternalId: 'portrait-case',
  status: 'draft',
  sortOrder: 10,
  version: 1,
  publishedAt: null,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
};

it('adds permission-filtered content and marketing navigation with icons owned by each item', () => {
  const visible = availableNavigation(contentActor);
  expect(visible.map((item) => [item.group, item.label])).toEqual(
    expect.arrayContaining([
      ['内容运营', '灵感库'],
      ['内容运营', '爆款模板'],
      ['内容运营', 'AI 工具'],
      ['内容运营', '内容媒体库'],
    ]),
  );
  expect(visible.every((item) => item.icon)).toBe(true);
  expect(
    availableNavigation({ ...contentActor, permissions: ['redemptions.read'] }).map(
      (item) => item.label,
    ),
  ).toEqual(['兑换活动', '兑换码']);
});

it('routes content pages explicitly through the console instead of the generic resource table', async () => {
  window.history.replaceState(null, '', '#/content/inspirations');
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/status'))
      return json({
        enabled: true,
        environment: 'development',
        stage: 'B1',
        teamWritesEnabled: true,
      });
    if (url.endsWith('/me')) return json(contentActor);
    if (url.includes('/content/inspirations?')) return json({ rows: [], nextCursor: null });
    throw new Error(`unexpected route ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<AdminApp />);
  expect(await screen.findByRole('button', { name: '新建灵感' })).toBeInTheDocument();
  expect(
    fetcher.mock.calls.some(([url]) => String(url).includes('/content/inspirations?limit=30')),
  ).toBe(true);
});

it('creates an inspiration as a draft with a reason, version-safe key, and no mock fallback', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json({ rows: [], nextCursor: null }))
    .mockResolvedValueOnce(json(inspiration, 201))
    .mockResolvedValueOnce(json({ rows: [inspiration], nextCursor: null }));
  vi.stubGlobal('fetch', fetcher);
  render(
    <ContentListPage
      kind="inspirations"
      actor={contentActor}
      client={new AdminClient()}
      writeEnabled
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: '新建灵感' }));
  fireEvent.change(screen.getByLabelText('公开标识'), { target: { value: 'studio-portrait' } });
  fireEvent.change(screen.getByLabelText('标题'), { target: { value: '影棚肖像' } });
  fireEvent.change(screen.getByLabelText('描述'), { target: { value: '用于运营编辑的内容描述' } });
  fireEvent.change(screen.getByLabelText('分类'), { target: { value: '人像' } });
  fireEvent.change(screen.getByLabelText('默认提示词'), { target: { value: '生成一张影棚肖像' } });
  fireEvent.change(screen.getByLabelText('默认模型'), { target: { value: 'gpt-image-2' } });
  fireEvent.change(screen.getByLabelText('默认规格'), { target: { value: 'square_1k' } });
  fireEvent.change(screen.getByLabelText('封面媒体标识'), { target: { value: 'portrait-cover' } });
  fireEvent.change(screen.getByLabelText('操作原因'), {
    target: { value: '创建新灵感草稿供内容审核' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  const request = fetcher.mock.calls[1]![1] as RequestInit;
  expect(fetcher.mock.calls[1]![0]).toBe('/api/admin/content/inspirations');
  expect(request.headers).toEqual(
    expect.objectContaining({ 'Idempotency-Key': expect.stringMatching(/^[0-9a-f-]{36}$/) }),
  );
  expect(JSON.parse(String(request.body))).toMatchObject({
    externalId: 'studio-portrait',
    status: 'draft',
    reason: '创建新灵感草稿供内容审核',
  });
});

it('warns before discarding a dirty content draft', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ rows: [], nextCursor: null })));
  render(
    <ContentListPage
      kind="inspirations"
      actor={contentActor}
      client={new AdminClient()}
      writeEnabled
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: '新建灵感' }));
  fireEvent.change(screen.getByLabelText('标题'), { target: { value: '尚未保存' } });
  fireEvent.click(screen.getByRole('button', { name: '取消编辑' }));
  expect(screen.getByRole('alert')).toHaveTextContent('放弃未保存修改？');
  expect(screen.getByDisplayValue('尚未保存')).toBeInTheDocument();
});

it('rejects sensitive material in audit reasons before issuing a request', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(
    <ContentEditor
      kind="inspirations"
      record={inspiration}
      actor={contentActor}
      client={new AdminClient()}
      writeEnabled
      onClose={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText('操作原因'), {
    target: { value: 'prompt: copy customer image data:image/png;base64,AAAA' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  expect(screen.getByText('原因中不得包含 API 密钥、提示词或图片内容')).toBeInTheDocument();
  expect(fetcher).not.toHaveBeenCalled();
});

it('hides published edit and reorder commands without publish authority', async () => {
  const published = { ...inspiration, status: 'published' as const };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ rows: [published], nextCursor: null })));
  render(
    <ContentListPage
      kind="inspirations"
      actor={{
        ...contentActor,
        permissions: ['content.inspirations.read', 'content.inspirations.write'],
      }}
      client={new AdminClient()}
      writeEnabled
    />,
  );
  await screen.findByText('影棚肖像');
  expect(screen.queryByRole('button', { name: '编辑影棚肖像' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '上移studio-portrait' })).not.toBeInTheDocument();
});

it('binds publish field errors and reloads a conflict version without losing the draft', async () => {
  const latest = { ...inspiration, version: 2, title: '另一位同事保存的标题' };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: null,
          code: 'CONTENT_NOT_PUBLISHABLE',
          message: 'private validation detail',
          requestId: 'publish-field',
          field: 'defaultModelId',
          details: { reason: 'not_publishable' },
        }),
        { status: 422 },
      ),
    )
    .mockResolvedValueOnce(json(null, 409))
    .mockResolvedValueOnce(json(latest));
  vi.stubGlobal('fetch', fetcher);
  const view = render(
    <ContentEditor
      kind="inspirations"
      record={inspiration}
      actor={contentActor}
      client={new AdminClient()}
      writeEnabled
      onClose={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '发布内容' }));
  fireEvent.change(screen.getByLabelText('发布原因'), {
    target: { value: '内容和媒体已经完成审核' },
  });
  fireEvent.click(screen.getByRole('button', { name: '确认发布' }));
  expect(await screen.findByText('默认模型未通过发布校验')).toBeInTheDocument();
  expect(screen.getByLabelText('默认模型')).toHaveAttribute('aria-invalid', 'true');

  fireEvent.change(screen.getByLabelText('标题'), { target: { value: '保留我的草稿标题' } });
  fireEvent.change(screen.getByLabelText('操作原因'), {
    target: { value: '修订内容标题供再次审核' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  expect(await screen.findByRole('button', { name: '加载最新版本' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '加载最新版本' }));
  expect(await screen.findByText('已加载最新版本 v2')).toBeInTheDocument();
  expect(screen.getByLabelText('标题')).toHaveValue('保留我的草稿标题');
  view.unmount();
  expect(JSON.parse(String((fetcher.mock.calls[1]![1] as RequestInit).body))).toMatchObject({
    version: 1,
  });
});

it('uploads content media as FormData and requires confirmation for lifecycle changes', async () => {
  const media = {
    resourceId: 'a36646f8-c011-4186-81eb-b1cf764bf193',
    id: 'a36646f8-c011-4186-81eb-b1cf764bf193',
    externalId: 'content-media-a36646f8-c011-4186-81eb-b1cf764bf193',
    contentType: 'image/png',
    width: 16,
    height: 16,
    byteSize: 12,
    sha256: 'a'.repeat(64),
    status: 'draft',
    version: 1,
    publishedAt: null,
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
    previewUrl: '/api/admin/content/media/a36646f8-c011-4186-81eb-b1cf764bf193/content',
  } as const;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json({ rows: [], nextCursor: null }))
    .mockResolvedValueOnce(json(media, 201))
    .mockResolvedValueOnce(json({ rows: [media], nextCursor: null }));
  vi.stubGlobal('fetch', fetcher);
  render(<MediaLibraryPage actor={contentActor} client={new AdminClient()} writeEnabled />);
  fireEvent.change(await screen.findByLabelText('选择图片'), {
    target: { files: [new File(['safe-image'], 'cover.png', { type: 'image/png' })] },
  });
  fireEvent.change(screen.getByLabelText('上传原因'), {
    target: { value: '上传已授权的运营封面' },
  });
  fireEvent.click(screen.getByRole('button', { name: '上传媒体' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  const upload = fetcher.mock.calls[1]![1] as RequestInit;
  expect(upload.body).toBeInstanceOf(FormData);
  expect(upload.headers).not.toHaveProperty('Content-Type');
});
