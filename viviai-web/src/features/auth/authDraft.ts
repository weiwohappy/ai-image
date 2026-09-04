const redirectKey = 'viviai-auth-redirect';

export function rememberAuthRedirect(path: string): void {
  if (typeof window !== 'undefined') sessionStorage.setItem(redirectKey, path);
}

export function consumeAuthRedirect(fallback = '/create'): string {
  if (typeof window === 'undefined') return fallback;
  const path = sessionStorage.getItem(redirectKey) ?? fallback;
  sessionStorage.removeItem(redirectKey);
  return path.startsWith('/') ? path : fallback;
}
