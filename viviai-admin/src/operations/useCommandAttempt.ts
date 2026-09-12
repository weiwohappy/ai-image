import { useRef, useState } from 'react';
import { AdminError } from '../http';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function useCommandAttempt() {
  const attempt = useRef<{ digest: string; key: string } | undefined>(undefined);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);

  async function run<T>(
    payload: unknown,
    command: (key: string) => Promise<T>,
  ): Promise<T | undefined> {
    if (inFlight.current) return undefined;
    const digest = stable(payload);
    if (!attempt.current || attempt.current.digest !== digest)
      attempt.current = { digest, key: crypto.randomUUID() };
    inFlight.current = true;
    setPending(true);
    setUncertain(false);
    try {
      const value = await command(attempt.current.key);
      attempt.current = undefined;
      return value;
    } catch (failure) {
      if (failure instanceof AdminError && failure.status < 500) attempt.current = undefined;
      else setUncertain(true);
      throw failure;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function reset() {
    attempt.current = undefined;
    setUncertain(false);
  }

  return { pending, uncertain, run, reset };
}
