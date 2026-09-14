import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { AdminActor, AdminDetail } from '../contracts';
import { AdminClient } from '../http';
import { json } from '../test/fixtures';
import { BatchOperations, type BatchDetail } from './BatchOperations';

const batchId = 'b0f1c1a4-6a2c-4f6e-9b3d-2f5f8a1c7d40';
const operator: AdminActor = {
  id: 'ops',
  email: 'ops@example.test',
  displayName: '任务运营',
  roles: ['model_operator'],
  permissions: ['workflows.read', 'batches.read', 'batches.manage'],
  sessionExpiresAt: '2099-01-01T00:00:00Z',
};
const reader: AdminActor = { ...operator, permissions: ['workflows.read', 'batches.read'] };

/** Field values the server would redact: none of these may reach the DOM. */
const promptSecret = 'private-prompt-7f3a';
const referenceSecret = 'private-reference-9c1d';

function batchDetail(overrides: Partial<BatchDetail> = {}): BatchDetail {
  return {
    id: batchId,
    title: '批次 商品批量主图',
    fields: [
      { label: '批次状态', value: 'queued', kind: 'status' },
      { label: '工作流', value: '商品批量主图' },
      { label: '工作流版本', value: 1 },
      { label: '用户', value: 'u***@example.test' },
      { label: '任务总数', value: 2 },
      { label: '预计积分', value: 60, kind: 'credits' },
      { label: '已扣积分', value: 0, kind: 'credits' },
    ],
    tables: [
      {
        title: '批次明细',
        columns: [
          { key: 'rowKey', label: '行' },
          { key: 'columnKey', label: '列' },
          { key: 'columnName', label: '列名称' },
          { key: 'status', label: '状态', kind: 'status' },
          { key: 'errorCode', label: '错误码' },
          { key: 'retryable', label: '可重试' },
        ],
        rows: [
          {
            id: 'i1',
            rowKey: 'row-1',
            columnKey: 'gen',
            columnName: '主图',
            status: 'queued',
            errorCode: null,
            retryable: true,
          },
          {
            id: 'i2',
            rowKey: 'row-2',
            columnKey: 'gen',
            columnName: '主图',
            status: 'failed',
            errorCode: 'PROVIDER_ERROR',
            retryable: true,
          },
        ],
        nextCursor: null,
        asOf: '2026-09-14T00:00:00.000Z',
        notices: [],
      },
    ],
    notices: [],
    actions: [
      { action: 'cancel', allowed: true, reasonCode: null },
      { action: 'retryFailed', allowed: false, reasonCode: 'BATCH_NOT_SETTLED' },
    ],
    ...overrides,
  };
}

function renderBatch(
  detail: BatchDetail | AdminDetail,
  actor: AdminActor = operator,
  onChanged = vi.fn(),
) {
  return render(
    <BatchOperations
      batchId={batchId}
      actor={actor}
      client={new AdminClient()}
      writeEnabled
      onChanged={onChanged}
    />,
  );
}

/** The detail read every case starts from, followed by the responses a command needs. */
function fetcherFor(detail: BatchDetail, ...rest: Array<() => Response | Promise<Response>>) {
  const fetcher = vi.fn().mockResolvedValueOnce(json(detail));
  for (const next of rest) fetcher.mockImplementationOnce(next as never);
  return fetcher;
}

/** The server's error envelope, which is what an administrator gets to read. */
function failure(code: string, message: string, status: number) {
  return new Response(JSON.stringify({ data: null, code, message, requestId: 'test' }), { status });
}

it('lists the batch and its items without exposing prompts, cells or asset references', async () => {
  vi.stubGlobal('fetch', fetcherFor(batchDetail()));
  renderBatch(batchDetail());

  expect(await screen.findByRole('heading', { name: '批次 商品批量主图' })).toBeInTheDocument();
  expect(await screen.findByText('排队中')).toBeInTheDocument();
  const items = await screen.findByRole('table', { name: /批次明细/ });
  expect(within(items).getByText('row-1')).toBeInTheDocument();
  expect(within(items).getByText('row-2')).toBeInTheDocument();
  expect(within(items).getAllByText('主图')).toHaveLength(2);
  expect(within(items).getByText('PROVIDER_ERROR')).toBeInTheDocument();

  const body = document.body.textContent ?? '';
  expect(body).not.toContain(promptSecret);
  expect(body).not.toContain(referenceSecret);
});

it('cancels a queued batch with a typed reason and a fresh idempotency key', async () => {
  vi.stubGlobal(
    'fetch',
    fetcherFor(batchDetail(), () => json({ resourceId: batchId, status: 'cancelled' }), () =>
      json(batchDetail({ fields: [{ label: '批次状态', value: 'cancelled', kind: 'status' }] })),
    ),
  );
  const onChanged = vi.fn();
  renderBatch(batchDetail(), operator, onChanged);

  fireEvent.click(await screen.findByRole('button', { name: '取消剩余任务' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('操作原因'), {
    target: { value: '用户申请取消，按运营规范释放冻结积分' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: '确认取消批次' }));

  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  const command = vi
    .mocked(fetch)
    .mock.calls.find(([url]) => String(url).includes('/cancel'))!;
  expect(command[0]).toBe(`/api/admin/batches/${batchId}/cancel`);
  const init = command[1] as RequestInit;
  expect(init.method).toBe('POST');
  expect(init.headers).toEqual(
    expect.objectContaining({ 'Idempotency-Key': expect.stringMatching(/^[0-9a-f-]{36}$/) }),
  );
  expect(JSON.parse(String(init.body))).toEqual({
    reason: '用户申请取消，按运营规范释放冻结积分',
  });
  expect(await screen.findByRole('status')).toHaveTextContent('批次已取消');
});

it('hides every disposal control from an administrator without the manage permission', async () => {
  vi.stubGlobal('fetch', fetcherFor(batchDetail()));
  renderBatch(batchDetail(), reader);

  expect(await screen.findByRole('heading', { name: '批次 商品批量主图' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '取消剩余任务' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '重试失败项' })).not.toBeInTheDocument();
  expect(screen.getByText(/只读权限/)).toBeInTheDocument();
});

it('shows a refused action disabled together with the reason the server gave', async () => {
  vi.stubGlobal('fetch', fetcherFor(batchDetail()));
  renderBatch(batchDetail());

  const cancel = await screen.findByRole('button', { name: '取消剩余任务' });
  expect(cancel).toBeEnabled();
  const retry = screen.getByRole('button', { name: '重试失败项' });
  expect(retry).toBeDisabled();
  expect(screen.getByText('批次尚未结束，无法重试')).toBeInTheDocument();
});

it('does not send a command when the reason is too short or carries sensitive content', async () => {
  const fetcher = fetcherFor(batchDetail());
  vi.stubGlobal('fetch', fetcher);
  renderBatch(batchDetail());

  fireEvent.click(await screen.findByRole('button', { name: '取消剩余任务' }));
  const dialog = await screen.findByRole('dialog');
  const reason = within(dialog).getByLabelText('操作原因');
  fireEvent.change(reason, { target: { value: '取消' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '确认取消批次' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('操作原因需为 5–500 个字符');

  fireEvent.change(reason, { target: { value: '客户把 sk-abc123 贴进了工单，需要取消' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '确认取消批次' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('原因中不得包含密钥');

  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(dialog).toBeInTheDocument();
});

it('keeps the dialog open on an unknown outcome and reuses the same key when retrying', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json(batchDetail()))
    .mockRejectedValueOnce(new TypeError('network outcome unknown'))
    .mockResolvedValueOnce(json({ resourceId: batchId, status: 'cancelled' }))
    .mockResolvedValueOnce(json(batchDetail()));
  vi.stubGlobal('fetch', fetcher);
  renderBatch(batchDetail());

  fireEvent.click(await screen.findByRole('button', { name: '取消剩余任务' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('操作原因'), {
    target: { value: '按运营规范取消排队中的批次' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: '确认取消批次' }));

  expect(await screen.findByRole('button', { name: '检查结果/重试同请求' })).toBeInTheDocument();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '检查结果/重试同请求' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  const keys = fetcher.mock.calls
    .filter(([url]) => String(url).includes('/cancel'))
    .map(([, init]) => (init as RequestInit).headers as Record<string, string>);
  expect(keys).toHaveLength(2);
  expect(keys[1]!['Idempotency-Key']).toBe(keys[0]!['Idempotency-Key']);
});

it('retries only the failed items of a settled batch', async () => {
  const detail = batchDetail({
    fields: [
      { label: '批次状态', value: 'partial', kind: 'status' },
      { label: '任务总数', value: 2 },
    ],
    actions: [
      { action: 'cancel', allowed: false, reasonCode: 'BATCH_NOT_QUEUED' },
      { action: 'retryFailed', allowed: true, reasonCode: null },
    ],
  });
  vi.stubGlobal(
    'fetch',
    fetcherFor(detail, () => json({ resourceId: batchId, status: 'queued' }), () =>
      json(detail),
    ),
  );
  const onChanged = vi.fn();
  renderBatch(detail, operator, onChanged);

  fireEvent.click(await screen.findByRole('button', { name: '重试失败项' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('操作原因'), {
    target: { value: '供应商故障已恢复，重试系统失败的项' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: '确认重试' }));

  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  const command = vi
    .mocked(fetch)
    .mock.calls.find(([url]) => String(url).includes('/retry-failed'))!;
  expect(command[0]).toBe(`/api/admin/batches/${batchId}/retry-failed`);
  expect(JSON.parse(String((command[1] as RequestInit).body))).toEqual({
    reason: '供应商故障已恢复，重试系统失败的项',
  });
});

it('surfaces a server refusal without pretending the batch changed', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json(batchDetail()))
    .mockResolvedValueOnce(failure('BATCH_NOT_QUEUED', '批次已开始执行', 409));
  vi.stubGlobal('fetch', fetcher);
  const onChanged = vi.fn();
  renderBatch(batchDetail(), operator, onChanged);

  fireEvent.click(await screen.findByRole('button', { name: '取消剩余任务' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('操作原因'), {
    target: { value: '按运营规范取消排队中的批次' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: '确认取消批次' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('批次已开始执行');
  expect(onChanged).not.toHaveBeenCalled();
});
