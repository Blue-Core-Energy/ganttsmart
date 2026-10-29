// Linear OAuth token storage and refresh, shared by Edge Functions.
// Access tokens expire after 24h; each refresh returns a new refresh token
// (rotation), with a 30-minute grace period for reusing the previous one.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const LINEAR_CLIENT_ID = Deno.env.get("LINEAR_CLIENT_ID") ?? "";
const LINEAR_CLIENT_SECRET = Deno.env.get("LINEAR_CLIENT_SECRET") ?? "";

// Refresh tokens this close to expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface LinearTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
}

export class LinearReauthRequired extends Error {}

/** Persist a token response from Linear's /oauth/token endpoint. */
export async function saveLinearTokens(supabase: SupabaseClient, userId: string, tokenData: LinearTokenResponse) {
  const expiresAt = tokenData.expires_in
    ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
    : null;
  const now = new Date().toISOString();

  const { error } = await supabase.from("user_settings").upsert({
    id: userId,
    linear_access_token: tokenData.access_token,
    linear_token_type: tokenData.token_type || "Bearer",
    linear_token_expires_at: expiresAt,
    updated_at: now,
  });
  if (error) throw new Error(`Failed to save token: ${error.message}`);

  if (tokenData.refresh_token) {
    const { error: rtError } = await supabase
      .from("linear_refresh_tokens")
      .upsert({ id: userId, refresh_token: tokenData.refresh_token, updated_at: now });
    if (rtError) throw new Error(`Failed to save refresh token: ${rtError.message}`);
  }

  return { accessToken: tokenData.access_token, expiresAt };
}

/** Exchange the stored refresh token for a new access token. Throws LinearReauthRequired if Linear rejects it. */
export async function refreshLinearToken(supabase: SupabaseClient, userId: string) {
  const { data: row } = await supabase
    .from("linear_refresh_tokens")
    .select("refresh_token")
    .eq("id", userId)
    .maybeSingle();
  if (!row?.refresh_token) throw new LinearReauthRequired("No refresh token stored");

  const res = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: row.refresh_token,
      client_id: LINEAR_CLIENT_ID,
      client_secret: LINEAR_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 400 || res.status === 401) {
      // Refresh token revoked or invalid — the user has to reconnect Linear.
      // Clearing is best effort; the caller must still learn that reauth is needed.
      await clearLinearTokens(supabase, userId).catch(() => {});
      throw new LinearReauthRequired(`Linear refresh failed: ${body}`);
    }
    throw new Error(`Linear refresh failed (${res.status}): ${body}`);
  }

  return saveLinearTokens(supabase, userId, await res.json());
}

/** Return a usable access token for the user, refreshing it first if it is about to expire. */
export async function getValidLinearToken(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const { data: settings } = await supabase
    .from("user_settings")
    .select("linear_access_token, linear_token_expires_at")
    .eq("id", userId)
    .single();
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
    .from("user_settings")
    .update({ linear_access_token: null, linear_token_expires_at: null, updated_at: new Date().toISOString() })
    .eq("id", userId);
  const { error: rtError } = await supabase.from("linear_refresh_tokens").delete().eq("id", userId);
  if (error) throw new Error(`Failed to clear access token: ${error.message}`);
  if (rtError) throw new Error(`Failed to clear refresh token: ${rtError.message}`);
}

/** Revoke a token at Linear. Best effort: the result (200 revoked, 400 already invalid) and network errors are ignored. */
export async function revokeLinearToken(token: string): Promise<void> {
  try {
    await fetch("https://api.linear.app/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // ignore — disconnecting locally must not depend on Linear being reachable
  }
}
