import { useEffect, useState } from 'react';
import { AdminClient, errorText } from './http';

export function useAdminQuery<T>(client: AdminClient, path: string, revision = 0) {
  const key = `${path}:${revision}`;
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>({ key });
  useEffect(() => {
    const controller = new AbortController();
    setState({ key });
    client
      .get<T>(path, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ key, data });
      })
      .catch((error) => {
        if (!controller.signal.aborted && error?.name !== 'AbortError')
          setState({ key, error: errorText(error) });
      });
    return () => controller.abort();
  }, [client, key, path]);
  // Never render a previous route's record, even for the first render before its effect.
  return state.key === key
    ? { ...state, loading: !state.data && !state.error }
    : { key, loading: true, data: undefined, error: undefined };
}
