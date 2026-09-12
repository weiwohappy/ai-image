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
import type { InspirationRecord, ToolRecord } from './contracts';

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

const media = {
  resourceId: 'a36646f8-c011-4186-81eb-b1cf764bf193',
  id: 'a36646f8-c011-4186-81eb-b1cf764bf193',
  externalId: 'content-media-a36646f8-c011-4186-81eb-b1cf764bf193',
  contentType: 'image/png',
  width: 16,
  height: 16,
  byteSize: 12,
  sha256: 'a'.repeat(64),
  status: 'draft' as const,
  version: 1,
  publishedAt: null,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
  previewUrl: '/api/admin/content/media/a36646f8-c011-4186-81eb-b1cf764bf193/content',
};

const tool: ToolRecord = {
  resourceId: 'db5b67c1-dddb-460b-b3ac-a31cf9cff32c',
  id: 'db5b67c1-dddb-460b-b3ac-a31cf9cff32c',
  externalId: 'white-background',
  name: '白底图',
  description: '商品白底图',
  category: '电商',
  fields: [],
  promptTemplate: '将商品置于白色背景',
  defaults: { modelId: 'gpt-image-2', resolution: '1K', ratio: '1:1', count: 1 },
  maxAssets: 3,
  maxOutputCount: 1,
  assetLabel: '商品图',
  defaultModelId: 'gpt-image-2',
  defaultOutputSpecId: 'square_1k',
  coverMediaExternalId: 'portrait-cover',
  isNew: false,
  status: 'draft',
  sortOrder: 10,
  version: 1,
  publishedAt: null,
  createdAt: inspiration.createdAt,
  updatedAt: inspiration.updatedAt,
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

it('shares dirty protection with hash navigation and beforeunload', async () => {
  window.history.replaceState(null, '', '#/content/inspirations');
  const actor = {
    ...contentActor,
    permissions: [...contentActor.permissions, 'redemptions.read'],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/status'))
        return json({
          enabled: true,
          environment: 'development',
          stage: 'B1',
          teamWritesEnabled: true,
        });
      if (url.endsWith('/me')) return json(actor);
      if (url.includes('/content/inspirations?')) return json({ rows: [], nextCursor: null });
      if (url.includes('/redemption-campaigns?')) return json({ rows: [], nextCursor: null });
      throw new Error(`unexpected route ${url}`);
    }),
  );
  render(<AdminApp />);
  fireEvent.click(await screen.findByRole('button', { name: '新建灵感' }));
  fireEvent.change(screen.getByLabelText('标题'), { target: { value: '未保存的全局草稿' } });
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole('link', { name: '兑换活动', hidden: true }));
  expect(await screen.findByRole('heading', { name: '离开并放弃修改？' })).toBeInTheDocument();
  expect(window.location.hash).toBe('#/content/inspirations');
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
  expect(screen.getByDisplayValue('未保存的全局草稿')).toBeInTheDocument();
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

it('requires an explicit field merge before resubmitting a content conflict with the latest version', async () => {
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
    .mockResolvedValueOnce(json(latest))
    .mockResolvedValueOnce(json({ ...latest, title: '保留我的草稿标题', version: 3 }));
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
  expect(screen.getByRole('dialog')).toHaveAccessibleName('确认发布内容');
  expect(screen.getByRole('dialog')).toHaveAccessibleDescription(
    '此操作会改变内容生命周期，请填写原因。',
  );
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
  expect(await screen.findByRole('heading', { name: '解决字段冲突' })).toBeInTheDocument();
  expect(screen.getByText('服务端：另一位同事保存的标题')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '保留我的 标题' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '保留我的 标题' }));
  expect(await screen.findByText('冲突已合并，将基于 v2 保存')).toBeInTheDocument();
  expect(screen.getByLabelText('标题')).toHaveValue('保留我的草稿标题');
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
  view.unmount();
  expect(JSON.parse(String((fetcher.mock.calls[3]![1] as RequestInit).body))).toMatchObject({
    version: 2,
    title: '保留我的草稿标题',
  });
});

it('uploads content media as FormData and requires confirmation for lifecycle changes', async () => {
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

it.each([
  ['draft', '发布', 'published', '/transition'],
  ['published', '下线', 'offline', '/transition'],
  ['offline', '归档', 'archived', '/archive'],
] as const)(
  'allows media %s lifecycle %s with the real write permission',
  async (status, label, target, suffix) => {
    const row = { ...media, status, version: 4 };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ rows: [row], nextCursor: null }))
      .mockResolvedValueOnce(json({ ...row, status: target, version: 5 }, 201))
      .mockResolvedValueOnce(json({ rows: [], nextCursor: null }));
    vi.stubGlobal('fetch', fetcher);
    render(<MediaLibraryPage actor={contentActor} client={new AdminClient()} writeEnabled />);
    fireEvent.click(await screen.findByRole('button', { name: label }));
    const reason = screen.getByLabelText('状态变更原因');
    fireEvent.change(reason, { target: { value: `完成媒体${label}审核流程` } });
    fireEvent.click(screen.getByRole('button', { name: '确认变更' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(fetcher.mock.calls[1]![0]).toBe(`/api/admin/content/media/${row.id}${suffix}`);
    expect(JSON.parse(String((fetcher.mock.calls[1]![1] as RequestInit).body))).toMatchObject({
      version: 4,
      ...(target === 'archived' ? {} : { status: target }),
    });
  },
);

it('binds lifecycle reason validation to the active confirmation field and focuses it', async () => {
  vi.stubGlobal('fetch', vi.fn());
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
  fireEvent.click(screen.getByRole('button', { name: '发布内容' }));
  const reason = screen.getByLabelText('发布原因');
  fireEvent.change(reason, { target: { value: 'api_key=secret' } });
  fireEvent.click(screen.getByRole('button', { name: '确认发布' }));
  expect(reason).toHaveAttribute('aria-invalid', 'true');
  expect(reason).toHaveFocus();
  expect(screen.getByText('原因中不得包含 API 密钥、提示词或图片内容')).toBeInTheDocument();
});

it('rejects a tool JSON array before dereferencing or sending it', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(
    <ContentEditor
      kind="tools"
      record={tool}
      actor={{
        ...contentActor,
        permissions: [...contentActor.permissions, 'content.tools.write'],
      }}
      client={new AdminClient()}
      writeEnabled
      onClose={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText('字段与生成限制 JSON'), {
    target: { value: '[]' },
  });
  fireEvent.change(screen.getByLabelText('操作原因'), {
    target: { value: '修改工具字段定义' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  expect(screen.getByText('JSON 顶层必须是对象')).toBeInTheDocument();
  expect(screen.getByLabelText('字段与生成限制 JSON')).toHaveAttribute('aria-invalid', 'true');
  expect(fetcher).not.toHaveBeenCalled();
});

it('sends strict updated-time filters for content and media and clears pagination state', async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(() => Promise.resolve(json({ rows: [], nextCursor: null })));
  vi.stubGlobal('fetch', fetcher);
  const content = render(
    <ContentListPage
      kind="inspirations"
      actor={contentActor}
      client={new AdminClient()}
      writeEnabled
    />,
  );
  await screen.findByText('没有符合条件的内容');
  fireEvent.change(screen.getByLabelText('更新开始时间'), {
    target: { value: '2026-10-01T09:00' },
  });
  fireEvent.change(screen.getByLabelText('更新结束时间'), {
    target: { value: '2026-10-02T09:00' },
  });
  await waitFor(() => {
    const url = new URL(String(fetcher.mock.calls.at(-1)?.[0]), 'http://admin.test');
    expect(url.searchParams.get('updatedFrom')).toBe(new Date('2026-10-01T09:00').toISOString());
    expect(url.searchParams.get('updatedTo')).toBe(new Date('2026-10-02T09:00').toISOString());
  });
  content.unmount();
  fetcher.mockClear();
  render(<MediaLibraryPage actor={contentActor} client={new AdminClient()} writeEnabled />);
  await screen.findByText('尚无内容媒体');
  fireEvent.change(screen.getByLabelText('更新开始时间'), {
    target: { value: '2026-10-03T09:00' },
  });
  await waitFor(() => {
    const url = new URL(String(fetcher.mock.calls.at(-1)?.[0]), 'http://admin.test');
    expect(url.searchParams.get('updatedFrom')).toBe(new Date('2026-10-03T09:00').toISOString());
  });
});
