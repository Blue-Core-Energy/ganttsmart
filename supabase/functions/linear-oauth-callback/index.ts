import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { revokeLinearToken, saveLinearTokens } from '../_shared/linear-token.ts';
import { generateCodeChallenge, generateCodeVerifier, isAllowedRedirectUri } from '../_shared/oauth-utils.ts';

const LINEAR_CLIENT_ID = Deno.env.get('LINEAR_CLIENT_ID') ?? '';
const LINEAR_CLIENT_SECRET = Deno.env.get('LINEAR_CLIENT_SECRET') ?? '';
const LINEAR_REDIRECT_URI = Deno.env.get('LINEAR_REDIRECT_URI') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return json({ error: 'Missing authorization header' }, 401);
    }

    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const token = authHeader.replace('Bearer ', '');
    const {
      data: { user },
      error: authError,
    } = await supabaseClient.auth.getUser(token);

    if (authError || !user) {
      return json({ error: 'Invalid token' }, 401);
    }

    let body: Record<string, unknown> = {};
    const rawBody = await req.text();
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }
    }

    if ('redirect_uri' in body && typeof body.redirect_uri !== 'string') {
      return json({ error: 'Invalid redirect_uri parameter' }, 400);
    }

    const action = body.action ?? (body.code ? 'exchange' : 'unknown');

    if (action === 'start') {
      // Opportunistically prune expired state records
      await supabaseClient.from('linear_oauth_states').delete().lte('expires_at', new Date().toISOString());

      const requestedRedirectUri = (typeof body.redirect_uri === 'string' && body.redirect_uri) || LINEAR_REDIRECT_URI;
      if (!isAllowedRedirectUri(requestedRedirectUri)) {
        return json({ error: 'Invalid or disallowed redirect_uri' }, 400);
      }

      const state = crypto.randomUUID();
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const { error: insertError } = await supabaseClient.from('linear_oauth_states').insert({
        state,
        user_id: user.id,
        code_verifier: codeVerifier,
        redirect_uri: requestedRedirectUri,
        expires_at: expiresAt,
      });

      if (insertError) {
        return json({ error: `Failed to store OAuth state: ${insertError.message}` }, 500);
      }

      const params = new URLSearchParams({
        client_id: LINEAR_CLIENT_ID,
        redirect_uri: requestedRedirectUri,
        response_type: 'code',
        scope: 'read,write',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });

      return json({
        authorizeUrl: `https://linear.app/oauth/authorize?${params.toString()}`,
        state,
      });
    }

    if (action === 'exchange') {
      const code = typeof body.code === 'string' ? body.code : null;
      const state = typeof body.state === 'string' ? body.state : null;
      const redirect_uri = typeof body.redirect_uri === 'string' ? body.redirect_uri : null;

      if (!code) {
        return json({ error: 'Missing authorization code' }, 400);
      }

      if (!state || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(state)) {
        return json({ error: 'Invalid or missing state parameter' }, 400);
      }

      // Atomically consume single-use state row bound to this user
      const { data: rpcData, error: rpcErr } = await supabaseClient.rpc('consume_linear_oauth_state', {
        p_state: state,
        p_user_id: user.id,
      });

      if (rpcErr) {
        return json({ error: `Database error consuming OAuth state: ${rpcErr.message}` }, 500);
      }

      const storedState = Array.isArray(rpcData) && rpcData.length > 0 ? rpcData[0] : null;
      if (!storedState) {
        return json({ error: 'Invalid or expired state parameter' }, 400);
      }

      // Strictly validate redirect_uri against stored redirect_uri and allowlist
      if (redirect_uri && redirect_uri !== storedState.redirect_uri) {
        return json({ error: 'Redirect URI mismatch' }, 400);
      }

      if (!isAllowedRedirectUri(storedState.redirect_uri)) {
        return json({ error: 'Disallowed redirect URI' }, 400);
      }

      const effectiveRedirectUri = storedState.redirect_uri;

      // Exchange code for tokens with Linear, passing code_verifier
      const tokenRes = await fetch('https://api.linear.app/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: LINEAR_CLIENT_ID,
          client_secret: LINEAR_CLIENT_SECRET,
          redirect_uri: effectiveRedirectUri,
          code_verifier: storedState.code_verifier,
        }),
      });

      if (!tokenRes.ok) {
        const errBody = await tokenRes.text();
        return json({ error: `Linear token exchange failed: ${errBody}` }, 400);
      }

      const tokenData = await tokenRes.json();

      // Read prior tokens before saving new credentials
      const { data: oldSettings } = await supabaseClient
        .from('user_settings')
        .select('linear_access_token')
        .eq('id', user.id)
        .maybeSingle();

      const { data: oldRt } = await supabaseClient
        .from('linear_refresh_tokens')
        .select('refresh_token')
        .eq('id', user.id)
        .maybeSingle();

      // Save new tokens FIRST; if saving fails, revoke unsaved new tokens and return 500
      try {
        await saveLinearTokens(supabaseClient, user.id, tokenData);
      } catch (dbError) {
        await Promise.allSettled([
          revokeLinearToken(tokenData.access_token),
          tokenData.refresh_token ? revokeLinearToken(tokenData.refresh_token) : Promise.resolve(),
        ]);
        return json({ error: (dbError as Error).message }, 500);
      }

      // Best-effort revoke prior tokens at Linear, skipping any token equal to the new tokens
      const priorTokens = [oldSettings?.linear_access_token, oldRt?.refresh_token]
        .filter((t): t is string => Boolean(t))
        .filter((t) => t !== tokenData.access_token && t !== tokenData.refresh_token);

      await Promise.allSettled(priorTokens.map((t) => revokeLinearToken(t)));

      return json({ success: true });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
