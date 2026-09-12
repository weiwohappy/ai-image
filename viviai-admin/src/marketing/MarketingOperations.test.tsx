import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

it('reloads a conflicting campaign version without discarding the operator draft', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json({ rows: [campaign], nextCursor: null }))
    .mockResolvedValueOnce(json(null, 409))
    .mockResolvedValueOnce(json({ ...campaign, version: 8, name: '服务端最新活动名' }));
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
  expect(await screen.findByText('已加载最新版本 v8')).toBeInTheDocument();
  expect(screen.getByLabelText('总兑换上限')).toHaveValue(450);
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
