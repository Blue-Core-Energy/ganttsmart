import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { toastError } from '@/components/Toast';

// Refresh session 5 minutes before it expires
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
// Retry a failed Linear token refresh (network / server error) after 1 minute
const LINEAR_RETRY_MS = 60 * 1000;

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [linearToken, setLinearToken] = useState<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const linearRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const linearRefreshInFlightRef = useRef<Promise<string | null> | null>(null);
  // Bumped on sign-out and disconnect so a refresh that is still running can't restore the token
  const linearGenerationRef = useRef(0);

  // Schedule automatic session refresh before expiry
  const scheduleRefresh = useCallback((sess: Session) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);

    const expiresAt = sess.expires_at;
    if (!expiresAt) return;

    const expiresInMs = expiresAt * 1000 - Date.now() - REFRESH_BUFFER_MS;
    if (expiresInMs <= 0) {
      // Already close to expiry — refresh immediately
      supabase.auth.refreshSession().catch(() => {
        toastError('Session expired. Please sign in again.');
      });
      return;
    }

    refreshTimerRef.current = setTimeout(async () => {
      try {
        const { data, error } = await supabase.auth.refreshSession();
        if (error) throw error;
        if (data.session) {
          setSession(data.session);
          setUser(data.session.user);
          scheduleRefresh(data.session);
        }
      } catch {
        toastError('Session expired. Please sign in again.');
      }
    }, expiresInMs);
  }, []);

  // Load session and Linear token
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        loadLinearToken(session.user.id);
        scheduleRefresh(session);
      } else {
        setLoading(false);
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        loadLinearToken(session.user.id);
        scheduleRefresh(session);
      } else {
        linearGenerationRef.current += 1;
        setLinearToken(null);
        setLoading(false);
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        if (linearRefreshTimerRef.current) clearTimeout(linearRefreshTimerRef.current);
      }
    });

    return () => {
      subscription.unsubscribe();
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      if (linearRefreshTimerRef.current) clearTimeout(linearRefreshTimerRef.current);
    };
  }, [scheduleRefresh]);

  // Handle visibility change — refresh if returning from background
  useEffect(() => {
    const handleVisibility = async () => {
      if (document.visibilityState !== 'visible') return;
      if (!session?.expires_at) return;

      const expiresInMs = session.expires_at * 1000 - Date.now();
      if (expiresInMs < REFRESH_BUFFER_MS) {
        try {
          const { data, error } = await supabase.auth.refreshSession();
          if (error) throw error;
          if (data.session) {
            setSession(data.session);
            setUser(data.session.user);
            scheduleRefresh(data.session);
          }
        } catch {
          toastError('Session expired. Please sign in again.');
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [session, scheduleRefresh]);

  // Linear access tokens expire after 24h. The refresh token is held server-side
  // (service-role-only table) and exchanged by the linear-token-refresh function;
  // the browser only ever sees the new access token and its expiry.

  const clearLinearTimer = useCallback(() => {
    if (linearRefreshTimerRef.current) clearTimeout(linearRefreshTimerRef.current);
    linearRefreshTimerRef.current = null;
  }, []);

  // Called by the scheduled timer; set below once refreshLinearToken exists.
  const runScheduledLinearRefreshRef = useRef<() => void>(() => {});

  const scheduleLinearRefreshIn = useCallback(
    (delayMs: number) => {
      clearLinearTimer();
      linearRefreshTimerRef.current = setTimeout(() => runScheduledLinearRefreshRef.current(), Math.max(delayMs, 0));
    },
    [clearLinearTimer],
  );

  const scheduleLinearRefresh = useCallback(
    (expiresAt: string | null) => {
      clearLinearTimer();
      if (!expiresAt) return; // legacy token without expiry: refreshed on the first auth error instead
      scheduleLinearRefreshIn(new Date(expiresAt).getTime() - Date.now() - REFRESH_BUFFER_MS);
    },
    [clearLinearTimer, scheduleLinearRefreshIn],
  );

  /**
   * Exchange the server-held refresh token for a new access token.
   * Resolves to the new token, or null if the user has to reconnect Linear.
   * Rejects on transient failures (network, 5xx) without touching the current
   * token; a retry is scheduled in that case.
   */
  const refreshLinearToken = useCallback((): Promise<string | null> => {
    // Share one in-flight request between the timer, initial load and auth-error handlers
    if (linearRefreshInFlightRef.current) return linearRefreshInFlightRef.current;
    const generation = linearGenerationRef.current;

    const request = (async () => {
      clearLinearTimer();
      try {
        const { data, error } = await supabase.functions.invoke('linear-token-refresh', {
          body: { action: 'refresh' },
        });
        if (error) throw error;
        // Signed out or disconnected while the request was running: drop the result
        if (generation !== linearGenerationRef.current) return null;
        if (data?.reconnect === true) {
          setLinearToken(null);
          return null;
        }
        if (typeof data?.accessToken !== 'string') throw new Error('Unexpected linear-token-refresh response');
        setLinearToken(data.accessToken);
        scheduleLinearRefresh(data.expiresAt ?? null);
        return data.accessToken as string;
      } catch (e) {
        if (generation === linearGenerationRef.current) scheduleLinearRefreshIn(LINEAR_RETRY_MS);
        throw e;
      }
    })().finally(() => {
      linearRefreshInFlightRef.current = null;
    });

    linearRefreshInFlightRef.current = request;
    return request;
  }, [clearLinearTimer, scheduleLinearRefresh, scheduleLinearRefreshIn]);

  useEffect(() => {
    runScheduledLinearRefreshRef.current = () => {
      // Failures are handled inside (retry scheduled, or token cleared on reconnect)
      refreshLinearToken().catch(() => {});
    };
  }, [refreshLinearToken]);

  const loadLinearToken = async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('user_settings')
        .select('linear_access_token, linear_token_expires_at')
        .eq('id', userId)
        .single();

      if (error) throw error;
      const token = data?.linear_access_token ?? null;
      const expiresAt = data?.linear_token_expires_at ?? null;
      if (token && expiresAt && new Date(expiresAt).getTime() - Date.now() < REFRESH_BUFFER_MS) {
        try {
          await refreshLinearToken();
        } catch {
          // Transient failure: keep the stored token; a retry is already scheduled
          setLinearToken(token);
        }
      } else {
        setLinearToken(token);
        if (token) scheduleLinearRefresh(expiresAt);
        else clearLinearTimer();
      }
    } catch {
      setLinearToken(null);
    } finally {
      setLoading(false);
    }
  };

  const signUp = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }, []);

  const signInWithGoogle = useCallback(async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/app` },
    });
    if (error) throw error;
  }, []);

  const signOut = useCallback(async () => {
    linearGenerationRef.current += 1;
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    clearLinearTimer();
    await supabase.auth.signOut();
    setLinearToken(null);
  }, [clearLinearTimer]);

  const saveLinearToken = useCallback(
    async (token: string) => {
      if (!user) return;
      const { error } = await supabase
        .from('user_settings')
        .upsert({ id: user.id, linear_access_token: token, updated_at: new Date().toISOString() });
      if (error) throw error;
      setLinearToken(token);
    },
    [user],
  );

  const disconnectLinear = useCallback(async () => {
    if (!user) return;
    linearGenerationRef.current += 1;
    clearLinearTimer();
    // The function revokes the token at Linear and deletes both the access token
    // and the server-only refresh token.
    let disconnected = false;
    try {
      const { data, error } = await supabase.functions.invoke('linear-token-refresh', {
        body: { action: 'disconnect' },
      });
      disconnected = !error && data?.success === true;
    } catch {
      disconnected = false;
    }
    if (!disconnected) {
      // Fallback: at least clear the access token the browser can see
      await supabase
        .from('user_settings')
        .update({ linear_access_token: null, linear_token_expires_at: null, updated_at: new Date().toISOString() })
        .eq('id', user.id);
    }
    setLinearToken(null);
  }, [user, clearLinearTimer]);

  return {
    session,
    user,
    loading,
    linearToken,
    signUp,
    signIn,
    signInWithGoogle,
    signOut,
    saveLinearToken,
    refreshLinearToken,
    disconnectLinear,
  };
}
