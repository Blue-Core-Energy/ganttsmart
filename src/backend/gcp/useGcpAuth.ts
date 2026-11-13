import { useCallback, useEffect, useMemo, useState } from 'react';
import { toastError } from '@/components/toastStore';
import { buildGcpLinearAuthorizeUrl } from '@/utils/projectDeepLink';
import type { AuthState } from '../types';
import { getJson, onSessionExpired, postJson, SessionExpiredError } from './api';
import { readLinearError } from './linearError';
import { sessionErrorMessage } from './sessionError';

/** Stands in for the Linear token: the real one never leaves the server. */
const SERVER_TOKEN = 'server';

/** IAP special URL that clears the app's IAP login cookie and returns to `/`. */
export const GCP_SIGN_OUT_URL = '/?gcp-iap-mode=CLEAR_LOGIN_COOKIE';

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
  const [signedOutMessage, setSignedOutMessage] = useState<string | null>(null);

  const applyMe = useCallback((me: Me) => {
    setEmail(me.email);
    setLinearConnected(me.linearConnected);
  }, []);

  useEffect(() => {
    clearLinearErrorParam();

    // Any API call that finds the session gone drops the user, which shows the SessionExpired screen
    const unsubscribe = onSessionExpired(() => {
      setSignedOutMessage(null);
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
        // Only an expired session says so; a network error or 5xx says the server couldn't be reached
        setSignedOutMessage(sessionErrorMessage(e));
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
    window.location.href = buildGcpLinearAuthorizeUrl(window.location.search);
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

  // Clears the IAP login cookie for GanttSmart only (not Google) and reloads `/`.
  const signOut = useCallback(async () => {
    window.location.href = GCP_SIGN_OUT_URL;
  }, []);

  const user = useMemo(() => (email !== null ? { id: email, email } : null), [email]);

  return {
    user,
    loading,
    linearToken: linearConnected ? SERVER_TOKEN : null,
    linearError,
    signedOutMessage,
    connectLinear,
    refreshLinearToken,
    disconnectLinear,
    signOut,
  };
}
