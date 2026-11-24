// Linear OAuth token storage and refresh, shared by Edge Functions.
// Access tokens expire after 24h; each refresh returns a new refresh token
// (rotation), with a 30-minute grace period for reusing the previous one.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const g = globalThis as {
  Deno?: { env?: { get(k: string): string | undefined } };
  process?: { env?: Record<string, string | undefined> };
};

const LINEAR_CLIENT_ID = g.Deno?.env?.get?.('LINEAR_CLIENT_ID') ?? g.process?.env?.['LINEAR_CLIENT_ID'] ?? '';
const LINEAR_CLIENT_SECRET =
  g.Deno?.env?.get?.('LINEAR_CLIENT_SECRET') ?? g.process?.env?.['LINEAR_CLIENT_SECRET'] ?? '';

// Refresh tokens this close to expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface LinearTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
}

export class LinearReauthRequired extends Error {}

/** Persist a token response from Linear's /oauth/token endpoint (used on initial connect / reconnect). */
export async function saveLinearTokens(supabase: SupabaseClient, userId: string, tokenData: LinearTokenResponse) {
  const expiresAt = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString() : null;
  const now = new Date().toISOString();

  const { error } = await supabase.from('user_settings').upsert({
    id: userId,
    linear_access_token: tokenData.access_token,
    linear_token_type: tokenData.token_type || 'Bearer',
    linear_token_expires_at: expiresAt,
    updated_at: now,
  });
  if (error) throw new Error(`Failed to save token: ${error.message}`);

  if (tokenData.refresh_token) {
    const { error: rtError } = await supabase
      .from('linear_refresh_tokens')
      .upsert({ id: userId, refresh_token: tokenData.refresh_token, updated_at: now });
    if (rtError) throw new Error(`Failed to save refresh token: ${rtError.message}`);
  }

  return { accessToken: tokenData.access_token, expiresAt };
}

/**
 * Rotate tokens using atomic Compare-And-Swap (CAS) on the previous refresh token.
 * Prevents race conditions where concurrent refreshes, reconnects, or disconnects
 * resurrect revoked tokens or overwrite fresh ones.
 */
export async function rotateLinearTokensWithCas(
  supabase: SupabaseClient,
  userId: string,
  oldRefreshToken: string,
  tokenData: LinearTokenResponse,
): Promise<{ accessToken: string; expiresAt: string | null }> {
  const expiresAt = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString() : null;
  const newRefreshToken = tokenData.refresh_token ?? oldRefreshToken;

  const { data, error: rpcError } = await supabase.rpc('rotate_linear_tokens', {
    p_user_id: userId,
    p_old_refresh_token: oldRefreshToken,
    p_new_access_token: tokenData.access_token,
    p_new_refresh_token: newRefreshToken,
    p_token_type: tokenData.token_type || 'Bearer',
    p_expires_at: expiresAt,
  });

  if (rpcError) {
    throw new Error(`Database error during token rotation: ${rpcError.message}`);
  }

  const row = Array.isArray(data) ? data[0] : data;
  const status = row?.status;

  if (status === 'rotated') {
    return { accessToken: tokenData.access_token, expiresAt };
  }

  if (status === 'conflict') {
    // Another worker rotated or user reconnected while refresh was in flight.
    // DO NOT revoke the sibling refresh token! Return currently stored tokens.
    if (row?.access_token) {
      return {
        accessToken: row.access_token,
        expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      };
    }
    throw new LinearReauthRequired('Concurrent token conflict without valid access token');
  }

  if (status === 'missing') {
    // User disconnected while refresh was in flight; revoke orphaned new tokens.
    await Promise.allSettled([
      revokeLinearToken(tokenData.access_token),
      tokenData.refresh_token ? revokeLinearToken(tokenData.refresh_token) : Promise.resolve(),
    ]);
    throw new LinearReauthRequired('User disconnected while refresh was in flight');
  }

  throw new Error(`Unexpected token rotation status: ${status}`);
}

/**
 * Clear tokens using atomic CAS on the refresh token.
 * Used on invalid_grant so that if the user already reconnected while a refresh
 * was in flight, the fresh connection is NOT wiped.
 */
export async function clearLinearTokensCas(
  supabase: SupabaseClient,
  userId: string,
  oldRefreshToken: string,
): Promise<boolean> {
  const { data: cleared, error: rpcError } = await supabase.rpc('clear_linear_tokens_cas', {
    p_user_id: userId,
    p_old_refresh_token: oldRefreshToken,
  });

  if (rpcError) {
    throw new Error(`Database error during token clear: ${rpcError.message}`);
  }

  return Boolean(cleared);
}

/**
 * Exchange the stored refresh token for a new access token.
 * Throws LinearReauthRequired only when no refresh token is stored or Linear
 * answers `invalid_grant`. Every other failure (DB error, invalid_client,
 * 5xx, unparseable body) throws a plain Error and leaves stored tokens alone,
 * so a transient problem or a server misconfiguration can't disconnect users.
 */
export async function refreshLinearToken(supabase: SupabaseClient, userId: string) {
  const { data: row, error: readError } = await supabase
    .from('linear_refresh_tokens')
    .select('refresh_token')
    .eq('id', userId)
    .maybeSingle();
  if (readError) throw new Error(`Failed to read refresh token: ${readError.message}`);
  if (!row?.refresh_token) throw new LinearReauthRequired('No refresh token stored');

  const currentRefreshToken = row.refresh_token;

  const res = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: currentRefreshToken,
      client_id: LINEAR_CLIENT_ID,
      client_secret: LINEAR_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    let errorCode: string | undefined;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed.error === 'string') errorCode = parsed.error;
    } catch {
      // unparseable body: not a recognised OAuth error
    }
    if (errorCode === 'invalid_grant') {
      // Refresh token revoked, expired or invalid.
      // Conditionally clear with CAS; if clearing returned false, another worker rotated or
      // user reconnected. Check if fresh tokens exist before forcing reauth.
      const cleared = await clearLinearTokensCas(supabase, userId, currentRefreshToken).catch(() => false);
      if (!cleared) {
        const { data: rtRow } = await supabase
          .from('linear_refresh_tokens')
          .select('refresh_token')
          .eq('id', userId)
          .maybeSingle();

        if (rtRow?.refresh_token && rtRow.refresh_token !== currentRefreshToken) {
          const { data: settings } = await supabase
            .from('user_settings')
            .select('linear_access_token, linear_token_expires_at')
            .eq('id', userId)
            .maybeSingle();

          if (settings?.linear_access_token) {
            return {
              accessToken: settings.linear_access_token,
              expiresAt: settings.linear_token_expires_at
                ? new Date(settings.linear_token_expires_at).toISOString()
                : null,
            };
          }
        }
      }
      throw new LinearReauthRequired(`Linear refresh failed: ${errorCode}`);
    }
    // invalid_client (wrong LINEAR_CLIENT_SECRET), invalid_request, 5xx, …: keep stored
    // tokens so fixing the configuration or waiting out the outage recovers every user.
    console.error(`Linear token refresh failed: status=${res.status} error=${errorCode ?? 'unparseable body'}`);
    throw new Error(`Linear refresh failed (${res.status}${errorCode ? `: ${errorCode}` : ''})`);
  }

  const tokenData: LinearTokenResponse = await res.json();
  return rotateLinearTokensWithCas(supabase, userId, currentRefreshToken, tokenData);
}

/** Return a usable access token for the user, refreshing it first if it is about to expire. */
export async function getValidLinearToken(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const { data: settings, error } = await supabase
    .from('user_settings')
    .select('linear_access_token, linear_token_expires_at')
    .eq('id', userId)
    .maybeSingle();
  // A DB failure must not look like "not connected"
  if (error) throw new Error(`Failed to read Linear token: ${error.message}`);
  if (!settings?.linear_access_token) return null;

  const expiresAt = settings.linear_token_expires_at ? new Date(settings.linear_token_expires_at).getTime() : null;
  if (expiresAt === null || expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return settings.linear_access_token;
  }

  try {
    const { accessToken } = await refreshLinearToken(supabase, userId);
    return accessToken;
  } catch (e) {
    if (e instanceof LinearReauthRequired) return null;
    throw e;
  }
}

/** Remove both the access token (user_settings) and the refresh token (linear_refresh_tokens). Throws on DB errors. */
export async function clearLinearTokens(supabase: SupabaseClient, userId: string) {
  const { error } = await supabase
    .from('user_settings')
    .update({ linear_access_token: null, linear_token_expires_at: null, updated_at: new Date().toISOString() })
    .eq('id', userId);
  const { error: rtError } = await supabase.from('linear_refresh_tokens').delete().eq('id', userId);
  if (error) throw new Error(`Failed to clear access token: ${error.message}`);
  if (rtError) throw new Error(`Failed to clear refresh token: ${rtError.message}`);
}

/** Revoke a token at Linear. Best effort: the result (200 revoked, 400 already invalid) and network errors are ignored. */
export async function revokeLinearToken(token: string): Promise<void> {
  try {
    const res = await fetch('https://api.linear.app/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(5000),
    });
    await res.body?.cancel();
  } catch {
    // ignore — disconnecting locally must not depend on Linear being reachable
  }
}
