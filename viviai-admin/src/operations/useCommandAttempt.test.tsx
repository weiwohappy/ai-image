import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useCommandAttempt, type CommandIdentity } from './useCommandAttempt';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const identity: CommandIdentity = {
  method: 'PATCH',
  path: '/content/inspirations/11111111-1111-4111-8111-111111111111',
  action: 'content.inspirations.update',
  target: '11111111-1111-4111-8111-111111111111',
};

it('reuses one inflight promise and returns a discriminated success value', async () => {
  const pending = deferred<{ version: number }>();
  const command = vi.fn(() => pending.promise);
  const { result } = renderHook(() => useCommandAttempt());

  let first!: ReturnType<typeof result.current.run<{ version: number }>>;
  let second!: ReturnType<typeof result.current.run<{ version: number }>>;
  act(() => {
    first = result.current.run(identity, { title: 'A' }, command);
    second = result.current.run(identity, { title: 'A' }, command);
  });

  expect(second).toBe(first);
  expect(command).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({ version: 2 }));
  await expect(first).resolves.toEqual({ kind: 'success', value: { version: 2 } });
});

it('keeps the same key for an uncertain retry and never reuses it across command identities', async () => {
  const keys: string[] = [];
  const command = vi
    .fn<(key: string) => Promise<string>>()
    .mockImplementationOnce(async (key) => {
      keys.push(key);
      throw new TypeError('unknown network outcome');
    })
    .mockImplementationOnce(async (key) => {
      keys.push(key);
      return 'replayed';
    });
  const { result } = renderHook(() => useCommandAttempt());

  await act(async () => {
    await expect(result.current.run(identity, { title: 'A' }, command)).rejects.toThrow(
      'unknown network outcome',
    );
  });
  expect(result.current.uncertain).toBe(true);

  let replay;
  await act(async () => {
    replay = await result.current.retry<string>();
  });
  expect(replay).toEqual({ kind: 'success', value: 'replayed' });
  expect(keys[1]).toBe(keys[0]);

  await expect(
    result.current.run(
      {
        ...identity,
        action: 'content.inspirations.transition',
        path: `${identity.path}/transition`,
      },
      { title: 'A' },
      async (key) => {
        keys.push(key);
        throw new TypeError('unknown network outcome');
      },
    ),
  ).rejects.toThrow('unknown network outcome');
  await act(async () => result.current.abandon());
  await act(async () => {
    await result.current.run(
      { ...identity, action: 'content.inspirations.archive', path: `${identity.path}/archive` },
      { title: 'A' },
      async (key) => {
        keys.push(key);
        return 'new-command';
      },
    );
  });
  expect(keys.at(-1)).not.toBe(keys[0]);
});

it('blocks a changed payload while an earlier outcome is uncertain until explicitly abandoned', async () => {
  const { result } = renderHook(() => useCommandAttempt());
  await expect(
    result.current.run(identity, { title: 'A' }, async () => {
      throw new TypeError('unknown network outcome');
    }),
  ).rejects.toThrow();
  const changedCommand = vi.fn(async () => 'changed');

  await expect(result.current.run(identity, { title: 'B' }, changedCommand)).resolves.toEqual({
    kind: 'blocked',
    reason: 'uncertain-attempt',
  });
  expect(changedCommand).not.toHaveBeenCalled();
});
