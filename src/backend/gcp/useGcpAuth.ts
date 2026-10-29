import { useCallback, useEffect, useMemo, useState } from 'react';
import { toastError } from '@/components/Toast';
import type { AuthState } from '../types';
import { getJson, onSessionExpired, postJson, SessionExpiredError } from './api';
import { readLinearError } from './linearError';

/** Stands in for the Linear token: the real one never leaves the server. */
const SERVER_TOKEN = 'server';

interface Me {
  email: string;
  linearConnected: boolean;
}

/** Strips `linear_error` from the address bar so a reload does not show the message again. */
function clearLinearErrorParam() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('linear_error')) return;
  url.searchParams.delete('linear_error');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

/** Identity comes from IAP via the server: there is no sign-in form and no browser-held token. */
export function useGcpAuth(): AuthState {
  const [email, setEmail] = useState<string | null>(null);
  const [linearConnected, setLinearConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [linearError, setLinearError] = useState<string | null>(() => readLinearError(window.location.search));

  const applyMe = useCallback((me: Me) => {
    setEmail(me.email);
    setLinearConnected(me.linearConnected);
  }, []);

  useEffect(() => {
    clearLinearErrorParam();

    // Any API call that finds the session gone drops the user, which shows the SessionExpired screen
    const unsubscribe = onSessionExpired(() => {
      setEmail(null);
      setLinearConnected(false);
    });

    let cancelled = false;
    getJson<Me>('/api/me')
      .then((me) => {
        if (!cancelled) applyMe(me);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (!(e instanceof SessionExpiredError)) toastError(`Could not load your account: ${(e as Error).message}`);
        setEmail(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyMe]);

  const connectLinear = useCallback(() => {
    setLinearError(null);
    window.location.href = '/api/linear/authorize';
  }, []);

  /** The server refreshes Linear tokens itself; this only re-reads whether Linear is still connected. */
  const refreshLinearToken = useCallback(async (): Promise<string | null> => {
    const me = await getJson<Me>('/api/me');
    applyMe(me);
    return me.linearConnected ? SERVER_TOKEN : null;
  }, [applyMe]);

  const disconnectLinear = useCallback(async () => {
    try {
      await postJson('/api/linear/disconnect');
    } catch (e) {
      // An expired session already switches to the SessionExpired screen
      if (!(e instanceof SessionExpiredError)) toastError(`Could not disconnect Linear: ${(e as Error).message}`);
      return;
    }
    setLinearConnected(false);
  }, []);

  // Not offered in the UI (capabilities.signOut is false): this IAP parameter is unconfirmed.
  const signOut = useCallback(async () => {
    window.location.href = '/?gcp-iap-mode=CLEAR_LOGIN_COOKIE';
  }, []);

  const user = useMemo(() => (email !== null ? { id: email, email } : null), [email]);

  return {
    user,
    loading,
    linearToken: linearConnected ? SERVER_TOKEN : null,
    linearError,
    connectLinear,
    refreshLinearToken,
    disconnectLinear,
    signOut,
  };
}
