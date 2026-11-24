-- Harden Linear OAuth: server-bound single-use states with PKCE,
-- and atomic CAS for token rotation and clearing.

CREATE TABLE IF NOT EXISTS public.linear_oauth_states (
  state text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_verifier text NOT NULL,
  redirect_uri text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS linear_oauth_states_user_id_idx ON public.linear_oauth_states(user_id);
CREATE INDEX IF NOT EXISTS linear_oauth_states_expires_at_idx ON public.linear_oauth_states(expires_at);

ALTER TABLE public.linear_oauth_states ENABLE ROW LEVEL SECURITY;

-- Permissions on linear_oauth_states: strictly service_role only
REVOKE ALL ON TABLE public.linear_oauth_states FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.linear_oauth_states TO service_role;

-- Atomically consume a single-use OAuth state row and prune expired states
CREATE OR REPLACE FUNCTION public.consume_linear_oauth_state(
  p_state text,
  p_user_id uuid
)
RETURNS TABLE (
  state text,
  user_id uuid,
  code_verifier text,
  redirect_uri text,
  expires_at timestamptz
) AS $$
BEGIN
  -- Opportunistically prune expired rows
  DELETE FROM public.linear_oauth_states
  WHERE linear_oauth_states.expires_at <= now();

  RETURN QUERY
  DELETE FROM public.linear_oauth_states
  WHERE linear_oauth_states.state = p_state
    AND linear_oauth_states.user_id = p_user_id
    AND linear_oauth_states.expires_at > now()
  RETURNING
    linear_oauth_states.state,
    linear_oauth_states.user_id,
    linear_oauth_states.code_verifier,
    linear_oauth_states.redirect_uri,
    linear_oauth_states.expires_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.consume_linear_oauth_state(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_linear_oauth_state(text, uuid) TO service_role;

-- Atomically rotate Linear tokens using CAS on the previous refresh token
CREATE OR REPLACE FUNCTION public.rotate_linear_tokens(
  p_user_id uuid,
  p_old_refresh_token text,
  p_new_access_token text,
  p_new_refresh_token text,
  p_token_type text DEFAULT 'Bearer',
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS TABLE (
  status text,
  access_token text,
  expires_at timestamptz
) AS $$
DECLARE
  v_current_refresh text;
  v_stored_access text;
  v_stored_expires timestamptz;
BEGIN
  SELECT linear_refresh_tokens.refresh_token
  INTO v_current_refresh
  FROM public.linear_refresh_tokens
  WHERE linear_refresh_tokens.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- User disconnected while refresh was in flight
    RETURN QUERY SELECT 'missing'::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_current_refresh <> p_old_refresh_token THEN
    -- Conflict: another rotation or reconnect updated the token
    SELECT user_settings.linear_access_token, user_settings.linear_token_expires_at
    INTO v_stored_access, v_stored_expires
    FROM public.user_settings
    WHERE user_settings.id = p_user_id;

    RETURN QUERY SELECT 'conflict'::text, v_stored_access, v_stored_expires;
    RETURN;
  END IF;

  -- Refresh token matches: update and return rotated status
  UPDATE public.linear_refresh_tokens
  SET refresh_token = p_new_refresh_token,
      updated_at = now()
  WHERE id = p_user_id;

  UPDATE public.user_settings
  SET linear_access_token = p_new_access_token,
      linear_token_type = COALESCE(p_token_type, 'Bearer'),
      linear_token_expires_at = p_expires_at,
      updated_at = now()
  WHERE id = p_user_id;

  RETURN QUERY SELECT 'rotated'::text, p_new_access_token, p_expires_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.rotate_linear_tokens(uuid, text, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_linear_tokens(uuid, text, text, text, text, timestamptz) TO service_role;

-- Atomically clear Linear tokens using CAS on the refresh token (e.g. invalid_grant)
CREATE OR REPLACE FUNCTION public.clear_linear_tokens_cas(
  p_user_id uuid,
  p_old_refresh_token text
)
RETURNS boolean AS $$
DECLARE
  v_deleted boolean := false;
BEGIN
  DELETE FROM public.linear_refresh_tokens
  WHERE id = p_user_id AND refresh_token = p_old_refresh_token;

  IF FOUND THEN
    UPDATE public.user_settings
    SET linear_access_token = NULL,
        linear_token_expires_at = NULL,
        updated_at = now()
    WHERE id = p_user_id;

    v_deleted := true;
  END IF;

  RETURN v_deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.clear_linear_tokens_cas(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_linear_tokens_cas(uuid, text) TO service_role;
