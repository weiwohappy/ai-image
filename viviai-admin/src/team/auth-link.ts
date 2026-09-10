import { useEffect, useState } from 'react';
// Shared by invitation entry, reset entry and the actual-client smoke harness.
export interface AuthLink {
  kind: 'invite' | 'reset';
  token: string;
  email: string;
  displayName?: string;
}
export interface AuthEntry {
  link: AuthLink | null;
  invalid: boolean;
}
const known = (hash: string) => /^#\/(accept|reset-password)(?:\?|$)/.test(hash);
export function readAuthLink(hash: string): AuthLink | null {
  const match = /^#\/(accept|reset-password)\?([^#]*)$/.exec(hash);
  if (!match || hash.length > 2048) return null;
  const params = new URLSearchParams(match[2]);
  const token = params.get('token') ?? '';
  if (params.getAll('token').length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const email = (params.get('email') ?? '').trim().toLowerCase();
  const displayName = (params.get('displayName') ?? '').trim();
  if (email.length > 254 || displayName.length > 80 || /[\r\n]/.test(email + displayName))
    return null;
  return {
    kind: match[1] === 'accept' ? 'invite' : 'reset',
    token,
    email,
    ...(displayName ? { displayName } : {}),
  };
}
function current(): AuthEntry {
  const hash = typeof window === 'undefined' ? '' : window.location.hash;
  const link = readAuthLink(hash);
  return { link, invalid: known(hash) && !link };
}
export function useAuthEntry(enabled = true) {
  const [entry, setEntry] = useState<AuthEntry>(() =>
    enabled ? current() : { link: null, invalid: false },
  );
  useEffect(() => {
    if (!enabled) return;
    function scrub() {
      if (known(window.location.hash))
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}${window.location.search}#/login`,
        );
    }
    scrub();
    function changed() {
      setEntry(current());
      scrub();
    }
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, [enabled]);
  return { entry, dismiss: () => setEntry({ link: null, invalid: false }) };
}
