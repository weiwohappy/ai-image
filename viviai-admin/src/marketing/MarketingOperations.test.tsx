import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import type { AdminActor } from '../contracts';
import { AdminClient } from '../http';
import { json } from '../test/fixtures';
import { CampaignPage } from './CampaignPage';
import { CodeBatchDialog } from './CodeBatchDialog';

const marketer: AdminActor = {
  id: 'marketing-admin',
  email: 'marketing@example.test',
  displayName: '营销同事',
  roles: ['owner'],
  permissions: ['redemptions.read', 'redemptions.write', 'referrals.read'],
  sessionExpiresAt: '2099-01-01T00:00:00Z',
};

const campaign = {
  resourceId: '18fd61ee-0da2-4e92-a36e-d4f3eb5deebe',
  id: '18fd61ee-0da2-4e92-a36e-d4f3eb5deebe',
  name: '十月邀请礼',
  startsAt: '2030-10-01T00:00:00.000Z',
  endsAt: '2030-11-01T00:00:00.000Z',
  perUserLimit: 1,
  credits: 100,
  totalLimit: 500,
  status: 'active' as const,
  version: 7,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

it('updates campaigns with the current version and surfaces capacity rejection', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json({ rows: [campaign], nextCursor: null }))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: null,
          code: 'REDEMPTION_CAMPAIGN_LIMIT_EXCEEDED',
          message: 'private capacity',
          requestId: 'capacity',
        }),
        { status: 422 },
      ),
    );
  vi.stubGlobal('fetch', fetcher);
  render(
    <CampaignPage view="campaigns" actor={marketer} client={new AdminClient()} writeEnabled />,
  );
  fireEvent.click(await screen.findByRole('button', { name: '编辑十月邀请礼' }));
  fireEvent.change(screen.getByLabelText('总兑换上限'), { target: { value: '20' } });
  fireEvent.change(screen.getByLabelText('操作原因'), {
    target: { value: '按最新活动预算调整总量' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存活动' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('低于已承诺的兑换容量');
  const body = JSON.parse(String((fetcher.mock.calls[1]![1] as RequestInit).body));
  expect(body).toMatchObject({ version: 7, totalLimit: 20, reason: '按最新活动预算调整总量' });
});

it('requires explicit campaign field choices before resubmitting with the latest version', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json({ rows: [campaign], nextCursor: null }))
    .mockResolvedValueOnce(json(null, 409))
    .mockResolvedValueOnce(json({ ...campaign, version: 8, name: '服务端最新活动名' }))
    .mockResolvedValueOnce(
      json({ ...campaign, version: 9, name: '服务端最新活动名', totalLimit: 450 }),
    );
  vi.stubGlobal('fetch', fetcher);
  render(
    <CampaignPage view="campaigns" actor={marketer} client={new AdminClient()} writeEnabled />,
  );
  fireEvent.click(await screen.findByRole('button', { name: '编辑十月邀请礼' }));
  fireEvent.change(screen.getByLabelText('总兑换上限'), { target: { value: '450' } });
  fireEvent.change(screen.getByLabelText('操作原因'), {
    target: { value: '调整活动预算但保留草稿' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存活动' }));
  fireEvent.click(await screen.findByRole('button', { name: '加载最新版本' }));
  expect(await screen.findByRole('heading', { name: '解决活动冲突' })).toBeInTheDocument();
  expect(screen.getByText('服务端：服务端最新活动名')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '采用服务端 活动名称' }));
  fireEvent.click(screen.getByRole('button', { name: '保留我的 总兑换上限' }));
  expect(await screen.findByText('冲突已合并，将基于 v8 保存')).toBeInTheDocument();
  expect(screen.getByLabelText('总兑换上限')).toHaveValue(450);
  expect(screen.getByLabelText('活动名称')).toHaveValue('服务端最新活动名');
  fireEvent.click(screen.getByRole('button', { name: '保存活动' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
  expect(JSON.parse(String((fetcher.mock.calls[3]![1] as RequestInit).body))).toMatchObject({
    version: 8,
    name: '服务端最新活动名',
    totalLimit: 450,
  });
});

it('keeps a dirty campaign editor open until discard is explicitly confirmed', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ rows: [campaign], nextCursor: null })));
  render(
    <CampaignPage view="campaigns" actor={marketer} client={new AdminClient()} writeEnabled />,
  );
  fireEvent.click(await screen.findByRole('button', { name: '编辑十月邀请礼' }));
  fireEvent.change(screen.getByLabelText('活动名称'), { target: { value: '尚未保存的活动名' } });
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(await screen.findByRole('heading', { name: '放弃未保存修改？' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
  expect(screen.getByDisplayValue('尚未保存的活动名')).toBeInTheDocument();
});

it('requires explicit confirmation and versions campaign lifecycle commands', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json({ rows: [campaign], nextCursor: null }))
    .mockResolvedValueOnce(json({ ...campaign, status: 'disabled', version: 8 }, 201))
    .mockResolvedValueOnce(json({ rows: [], nextCursor: null }));
  vi.stubGlobal('fetch', fetcher);
  render(
    <CampaignPage view="campaigns" actor={marketer} client={new AdminClient()} writeEnabled />,
  );
  fireEvent.click(await screen.findByRole('button', { name: '停用十月邀请礼' }));
  expect(screen.getByRole('heading', { name: '确认停用活动' })).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText('停用原因'), {
    target: { value: '活动预算周期已经结束' },
  });
  fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  expect(JSON.parse(String((fetcher.mock.calls[1]![1] as RequestInit).body))).toEqual({
    version: 7,
    reason: '活动预算周期已经结束',
  });
});

it('destroys one-time plaintext codes when the result closes and never restores them on reopen', async () => {
  const secret = 'VIVIAI-0123456789ABCDEF0123456789ABCDEF';
  const fetcher = vi.fn().mockResolvedValue(
    json(
      {
        resourceId: campaign.id,
        campaignId: campaign.id,
        campaignVersion: 8,
        generated: 1,
        codes: [
          {
            id: 'a10c2d5f-20ad-4b5a-aa19-c750726d8676',
            campaignId: campaign.id,
            displayMask: 'VIVIAI-****-CDEF',
            status: 'active',
            maxUses: 1,
            usedCount: 0,
            version: 1,
            createdAt: '2026-09-12T00:00:00.000Z',
            updatedAt: '2026-09-12T00:00:00.000Z',
            code: secret,
          },
        ],
      },
      201,
    ),
  );
  vi.stubGlobal('fetch', fetcher);

  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>生成兑换码</button>
        {open && (
          <CodeBatchDialog
            client={new AdminClient()}
            onClose={() => setOpen(false)}
            onChanged={vi.fn()}
          />
        )}
      </>
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: '生成兑换码' }));
  fireEvent.change(screen.getByLabelText('活动 ID'), { target: { value: campaign.id } });
  fireEvent.change(screen.getByLabelText('活动版本'), { target: { value: '7' } });
  fireEvent.change(screen.getByLabelText('生成数量'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('单码可用次数'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('生成原因'), {
    target: { value: '为线下活动生成单次兑换码' },
  });
  fireEvent.click(screen.getByRole('button', { name: '确认生成' }));
  expect(await screen.findByText(secret)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '关闭并销毁明文' }));
  expect(screen.queryByText(secret)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '生成兑换码' }));
  expect(screen.queryByText(secret)).not.toBeInTheDocument();
  expect(screen.getByLabelText('活动 ID')).toHaveValue('');
});

it('keeps one code-generation attempt locked to its payload and idempotency key until resolved', async () => {
  const pending = deferred<Response>();
  const fetcher = vi
    .fn()
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValueOnce(
      json(
        {
          resourceId: campaign.id,
          campaignId: campaign.id,
          campaignVersion: 8,
          generated: 1,
          codeIds: ['a10c2d5f-20ad-4b5a-aa19-c750726d8676'],
          codesUnavailable: true,
        },
        201,
      ),
    );
  vi.stubGlobal('fetch', fetcher);
  const onClose = vi.fn();
  render(<CodeBatchDialog client={new AdminClient()} onClose={onClose} onChanged={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('活动 ID'), { target: { value: campaign.id } });
  fireEvent.change(screen.getByLabelText('活动版本'), { target: { value: '7' } });
  fireEvent.change(screen.getByLabelText('生成数量'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('单码可用次数'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('生成原因'), {
    target: { value: '为合作活动生成一次性批次' },
  });
  fireEvent.click(screen.getByRole('button', { name: '确认生成' }));
  const cancel = screen.getByRole('button', { name: '取消' });
  expect(cancel).toBeDisabled();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '正在生成…' }));
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => pending.reject(new TypeError('network outcome unknown')));
  fireEvent.click(await screen.findByRole('button', { name: '检查结果/重试同请求' }));
  expect(await screen.findByText('批次已创建，但明文无法恢复')).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(2);
  const firstHeaders = fetcher.mock.calls[0]![1]!.headers as Record<string, string>;
  const secondHeaders = fetcher.mock.calls[1]![1]!.headers as Record<string, string>;
  expect(secondHeaders['Idempotency-Key']).toBe(firstHeaders['Idempotency-Key']);
  expect(fetcher.mock.calls[1]![1]!.body).toBe(fetcher.mock.calls[0]![1]!.body);
});

it('hides every marketing mutation when the actor lacks write permission', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ rows: [campaign], nextCursor: null })));
  render(
    <CampaignPage
      view="campaigns"
      actor={{ ...marketer, permissions: ['redemptions.read'] }}
      client={new AdminClient()}
      writeEnabled
    />,
  );
  await screen.findByText('十月邀请礼');
  expect(screen.queryByRole('button', { name: '新建兑换活动' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '编辑十月邀请礼' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '停用十月邀请礼' })).not.toBeInTheDocument();
});

it('disables a code only after confirmation and sends its current version', async () => {
  const code = {
    resourceId: 'a10c2d5f-20ad-4b5a-aa19-c750726d8676',
    id: 'a10c2d5f-20ad-4b5a-aa19-c750726d8676',
    campaignId: campaign.id,
    displayMask: 'VIVIAI-****-CDEF',
    status: 'active',
    maxUses: 1,
    usedCount: 0,
    version: 4,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
  } as const;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json({ rows: [code], nextCursor: null }))
    .mockResolvedValueOnce(json({ ...code, status: 'disabled', version: 5 }, 201))
    .mockResolvedValueOnce(json({ rows: [], nextCursor: null }));
  vi.stubGlobal('fetch', fetcher);
  render(<CampaignPage view="codes" actor={marketer} client={new AdminClient()} writeEnabled />);
  fireEvent.click(await screen.findByRole('button', { name: '停用VIVIAI-****-CDEF' }));
  expect(screen.getByRole('heading', { name: '确认停用兑换码' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('停用原因'), {
    target: { value: '线下批次已经结束使用' },
  });
  fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  expect(JSON.parse(String((fetcher.mock.calls[1]![1] as RequestInit).body))).toEqual({
    version: 4,
    reason: '线下批次已经结束使用',
  });
});

it('applies backend code, claim, and referral filters with strict identifiers and time ranges', async () => {
  const fetcher = vi.fn().mockResolvedValue(json({ rows: [], nextCursor: null }));
  vi.stubGlobal('fetch', fetcher);
  const codes = render(
    <CampaignPage view="codes" actor={marketer} client={new AdminClient()} writeEnabled />,
  );
  await screen.findByText('生成兑换码');
  fireEvent.change(screen.getByLabelText('活动 ID 筛选'), { target: { value: campaign.id } });
  fireEvent.change(screen.getByLabelText('兑换码状态'), { target: { value: 'disabled' } });
  fireEvent.change(screen.getByLabelText('创建开始时间'), {
    target: { value: '2026-10-01T09:00' },
  });
  await waitFor(() => {
    const url = new URL(String(fetcher.mock.calls.at(-1)?.[0]), 'http://admin.test');
    expect(url.searchParams.get('campaignId')).toBe(campaign.id);
    expect(url.searchParams.get('status')).toBe('disabled');
    expect(url.searchParams.get('from')).toBe(new Date('2026-10-01T09:00').toISOString());
  });
  fireEvent.click(screen.getByRole('button', { name: '兑换记录' }));
  fireEvent.change(await screen.findByLabelText('用户 ID 筛选'), {
    target: { value: '22222222-2222-4222-8222-222222222222' },
  });
  await waitFor(() => {
    const url = new URL(String(fetcher.mock.calls.at(-1)?.[0]), 'http://admin.test');
    expect(url.pathname).toContain('/redemption-claims');
    expect(url.searchParams.get('userId')).toBe('22222222-2222-4222-8222-222222222222');
  });
  codes.unmount();
  render(
    <CampaignPage view="referrals" actor={marketer} client={new AdminClient()} writeEnabled />,
  );
  fireEvent.change(await screen.findByLabelText('邀请人或被邀请人 ID'), {
    target: { value: '33333333-3333-4333-8333-333333333333' },
  });
  fireEvent.change(screen.getByLabelText('返利状态'), { target: { value: 'rewarded' } });
  await waitFor(() => {
    const url = new URL(String(fetcher.mock.calls.at(-1)?.[0]), 'http://admin.test');
    expect(url.pathname).toContain('/referrals');
    expect(url.searchParams.get('userId')).toBe('33333333-3333-4333-8333-333333333333');
    expect(url.searchParams.get('status')).toBe('rewarded');
  });
});
