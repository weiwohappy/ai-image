import { useEffect, useId, useRef, useSyncExternalStore } from 'react';

type Blocker = { dirty: boolean; pending: boolean; discard: () => void };
const blockers = new Map<string, { current: Blocker }>();
const listeners = new Set<() => void>();
let revision = 0;

function notify() {
  revision += 1;
  listeners.forEach((listener) => listener());
}

export function useDirtyRegistration(blocker: Blocker) {
  const id = useId();
  const current = useRef(blocker);
  current.current = blocker;
  useEffect(() => {
    blockers.set(id, current);
    notify();
    return () => {
      blockers.delete(id);
      notify();
    };
  }, [id]);
  useEffect(notify, [blocker.dirty, blocker.pending]);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  const entries = [...blockers.values()].map((entry) => entry.current);
  return `${revision}:${entries.some((entry) => entry.dirty)}:${entries.some((entry) => entry.pending)}:${entries.length}`;
}

export function useDirtyGuard() {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const entries = [...blockers.values()].map((entry) => entry.current);
  return {
    dirty: entries.some((entry) => entry.dirty),
    pending: entries.some((entry) => entry.pending),
    discard() {
      [...blockers.values()].forEach((entry) => entry.current.discard());
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
