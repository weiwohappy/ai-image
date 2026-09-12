import { useEffect, useId, useSyncExternalStore } from 'react';

type Blocker = { dirty: boolean; pending: boolean; discard: () => void };
const blockers = new Map<string, Blocker>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

export function useDirtyRegistration(blocker: Blocker) {
  const id = useId();
  useEffect(() => {
    blockers.set(id, blocker);
    notify();
    return () => {
      blockers.delete(id);
      notify();
    };
  }, [blocker.dirty, blocker.pending, blocker.discard, id]);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  const entries = [...blockers.values()];
  return `${entries.some((entry) => entry.dirty)}:${entries.some((entry) => entry.pending)}:${entries.length}`;
}

export function useDirtyGuard() {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const entries = [...blockers.values()];
  return {
    dirty: entries.some((entry) => entry.dirty),
    pending: entries.some((entry) => entry.pending),
    discard() {
      entries.forEach((entry) => entry.discard());
    },
  };
}

export function useBeforeUnloadGuard(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [active]);
}
