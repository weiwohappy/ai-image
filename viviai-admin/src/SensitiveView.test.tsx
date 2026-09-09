import { act, fireEvent, render, screen } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { SensitiveView } from './SensitiveView';
import { AdminClient } from './http';
import { json } from './test/fixtures';

it('requires a reason, uses private bytes, and removes prompt and object URLs on expiry', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
  const revoke = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:private-preview'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json({ id: 'grant-1', expiresAt: '2026-09-09T00:00:05Z' }))
    .mockResolvedValueOnce(
      json({
        prompt: 'private prompt',
        assets: [
          {
            id: 'asset-1',
            role: 'reference',
            width: 1024,
            height: 1024,
            previewPath: '/api/admin/assets/asset-1/preview',
          },
        ],
      }),
    )
    .mockResolvedValueOnce(
      new Response('test-only-image', { headers: { 'Content-Type': 'image/png' } }),
    );
  vi.stubGlobal('fetch', fetcher);
  render(<SensitiveView jobId="job-1" client={new AdminClient()} />);
  expect(screen.queryByText('private prompt')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '申请查看 5 分钟' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('查看原因'), {
    target: { value: '处理工单 CASE-123 的参考图问题' },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '申请查看 5 分钟' }));
  });
  expect(screen.getByText('private prompt')).toBeInTheDocument();
  expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:private-preview');
  expect(fetcher.mock.calls[2][0]).toBe('/api/admin/assets/asset-1/preview?grantId=grant-1');
  await act(async () => {
    vi.advanceTimersByTime(5001);
  });
  expect(screen.queryByText('private prompt')).not.toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(revoke).toHaveBeenCalledWith('blob:private-preview');
  vi.useRealTimers();
});

it('aborts pending sensitive requests when the task unmounts', async () => {
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    }),
  );
  const view = render(<SensitiveView jobId="job-2" client={new AdminClient()} />);
  fireEvent.change(screen.getByLabelText('查看原因'), {
    target: { value: '处理客户的输出图片问题工单' },
  });
  fireEvent.click(screen.getByRole('button', { name: '申请查看 5 分钟' }));
  view.unmount();
  expect(signal?.aborted).toBe(true);
});
