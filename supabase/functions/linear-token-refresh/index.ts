import 'jsr:@supabase/functions-js@2.118.0/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { handleCorsPreflight, jsonResponse } from '../_shared/cors.ts';
import {
  clearLinearTokens,
  LinearReauthRequired,
  refreshLinearToken,
  revokeLinearToken,
} from '../_shared/linear-token.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// Body: { action?: "refresh" | "disconnect" }
//   refresh (default): exchanges the caller's stored Linear refresh token for a new
//     access token. Returns { accessToken, expiresAt } or { reconnect: true }.
//     The refresh token itself never leaves the server.
//   disconnect: revokes both the access token and refresh token at Linear (best
//     effort), deletes both, and returns { success: true }.
Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  const json = (body: unknown, status = 200) => jsonResponse(body, status, req, { 'Cache-Control': 'no-store' });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Missing authorization header' }, 401);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (authError || !user) return json({ error: 'Invalid token' }, 401);

    // The body is optional; an empty body means "refresh".
    let action = 'refresh';
    const rawBody = await req.text();
    if (rawBody) {
      try {
        const body = JSON.parse(rawBody);
        if (body && typeof body.action === 'string') action = body.action;
      } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }
    }

    if (action === 'disconnect') {
      const { data: settings } = await supabase
        .from('user_settings')
        .select('linear_access_token')
        .eq('id', user.id)
        .maybeSingle();
      const { data: rtRow } = await supabase
        .from('linear_refresh_tokens')
        .select('refresh_token')
        .eq('id', user.id)
        .maybeSingle();

      await Promise.allSettled([
        settings?.linear_access_token ? revokeLinearToken(settings.linear_access_token) : Promise.resolve(),
        rtRow?.refresh_token ? revokeLinearToken(rtRow.refresh_token) : Promise.resolve(),
      ]);

      await clearLinearTokens(supabase, user.id);
      return json({ success: true });
    }

    if (action !== 'refresh') return json({ error: 'Unknown action' }, 400);

    const { accessToken, expiresAt } = await refreshLinearToken(supabase, user.id);
    return json({ accessToken, expiresAt });
  } catch (err) {
    if (err instanceof LinearReauthRequired) {
      return json({ error: 'Linear connection expired. Please reconnect.', reconnect: true });
    }
    console.error('Unhandled token refresh error:', err);
    return json({ error: 'Failed to refresh token' }, 500);
  }
});
