import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  clearLinearTokens,
  LinearReauthRequired,
  refreshLinearToken,
  revokeLinearToken,
} from "../_shared/linear-token.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Body: { action?: "refresh" | "disconnect" }
//   refresh (default): exchanges the caller's stored Linear refresh token for a new
//     access token. Returns { accessToken, expiresAt } or { reconnect: true }.
//     The refresh token itself never leaves the server.
//   disconnect: revokes the access token at Linear (best effort), deletes both the
//     access token and the refresh token, and returns { success: true }.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing authorization header" }, 401);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !user) return json({ error: "Invalid token" }, 401);

    // The body is optional; an empty body means "refresh".
    let action = "refresh";
    const rawBody = await req.text();
    if (rawBody) {
      try {
        const body = JSON.parse(rawBody);
        if (body && typeof body.action === "string") action = body.action;
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
    }

    if (action === "disconnect") {
      const { data: settings } = await supabase
        .from("user_settings")
        .select("linear_access_token")
        .eq("id", user.id)
        .maybeSingle();
      if (settings?.linear_access_token) await revokeLinearToken(settings.linear_access_token);
      await clearLinearTokens(supabase, user.id);
      return json({ success: true });
    }

    if (action !== "refresh") return json({ error: "Unknown action" }, 400);

    const { accessToken, expiresAt } = await refreshLinearToken(supabase, user.id);
    return json({ accessToken, expiresAt });
  } catch (err) {
    if (err instanceof LinearReauthRequired) {
      return json({ error: "Linear connection expired. Please reconnect.", reconnect: true });
    }
    return json({ error: (err as Error).message }, 500);
  }
});
