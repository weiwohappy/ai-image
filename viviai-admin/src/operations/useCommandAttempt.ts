import { useRef, useState } from 'react';
import { AdminError } from '../http';

export type CommandIdentity = {
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  action: string;
  target: string;
};

export type CommandResult<T> =
  | { kind: 'success'; value: T }
  | { kind: 'blocked'; reason: 'uncertain-attempt' | 'no-attempt' };

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

type StoredAttempt = {
  fingerprint: string;
  key: string;
  command: (key: string) => Promise<unknown>;
};

export function useCommandAttempt() {
  const attempt = useRef<StoredAttempt | undefined>(undefined);
  const inFlight = useRef<
    { fingerprint: string; promise: Promise<CommandResult<unknown>> } | undefined
  >(undefined);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);

  function execute<T>(stored: StoredAttempt): Promise<CommandResult<T>> {
    if (inFlight.current) {
      if (inFlight.current.fingerprint === stored.fingerprint)
        return inFlight.current.promise as Promise<CommandResult<T>>;
      return Promise.resolve({ kind: 'blocked', reason: 'uncertain-attempt' });
    }
    setPending(true);
    setUncertain(false);
    let promise!: Promise<CommandResult<T>>;
    promise = (async (): Promise<CommandResult<T>> => {
      try {
        const value = (await stored.command(stored.key)) as T;
        attempt.current = undefined;
        return { kind: 'success', value };
      } catch (failure) {
        if (failure instanceof AdminError && failure.status < 500) attempt.current = undefined;
        else setUncertain(true);
        throw failure;
      } finally {
        if (inFlight.current?.promise === promise) inFlight.current = undefined;
        setPending(false);
      }
    })();
    inFlight.current = { fingerprint: stored.fingerprint, promise };
    return promise;
  }

  function run<T>(
    identity: CommandIdentity,
    payload: unknown,
    command: (key: string) => Promise<T>,
  ): Promise<CommandResult<T>> {
    const fingerprint = stable({ identity, payload });
    if (inFlight.current) {
      if (inFlight.current.fingerprint === fingerprint)
        return inFlight.current.promise as Promise<CommandResult<T>>;
      return Promise.resolve({ kind: 'blocked', reason: 'uncertain-attempt' });
    }
    if (attempt.current && attempt.current.fingerprint !== fingerprint)
      return Promise.resolve({ kind: 'blocked', reason: 'uncertain-attempt' });
    if (!attempt.current)
      attempt.current = {
        fingerprint,
        key: crypto.randomUUID(),
        command: command as (key: string) => Promise<unknown>,
      };
    else attempt.current.command = command as (key: string) => Promise<unknown>;
    return execute<T>(attempt.current);
  }

  function retry<T>(): Promise<CommandResult<T>> {
    if (!attempt.current) return Promise.resolve({ kind: 'blocked', reason: 'no-attempt' });
    return execute<T>(attempt.current);
  }

  function abandon() {
    if (inFlight.current) return false;
    attempt.current = undefined;
    setUncertain(false);
    return true;
  }

  return { pending, uncertain, run, retry, abandon, reset: abandon };
}
