-- Migration 010: Harden share-roadmap rate limiting, refresh locking, and table security (IT-153)

-- 1. Restrict direct PostgREST mutations on public.shared_roadmaps.
-- All mutations must go through the share-roadmap Edge Function (service_role).
DROP POLICY IF EXISTS "owner_all" ON public.shared_roadmaps;
DROP POLICY IF EXISTS "owner_select" ON public.shared_roadmaps;

CREATE POLICY "owner_select" ON public.shared_roadmaps
  FOR SELECT TO authenticated
  USING (auth.uid() = owner_id);

REVOKE INSERT, UPDATE, DELETE ON public.shared_roadmaps FROM anon, authenticated;
REVOKE SELECT ON public.shared_roadmaps FROM anon;
GRANT SELECT ON public.shared_roadmaps TO authenticated;

-- 2. Add refresh lease timestamp column to prevent cache stampedes
ALTER TABLE public.shared_roadmaps
  ADD COLUMN IF NOT EXISTS refreshing_until timestamptz;

-- 3. Invalidate / delete legacy static-salt SHA-256 passwords.
-- Share links had a maximum expiry of 90 days; legacy static-salt hashes from 2024 have long expired.
-- NEVER set password_hash = NULL (which would fail open as an unprotected public share).
DELETE FROM public.shared_roadmaps
WHERE password_hash IS NOT NULL
  AND password_hash NOT LIKE 'pbkdf2:%';

-- 4. Harden share_access_attempts table for per-(share_token, client_ip_hash) rate limiting.
ALTER TABLE public.share_access_attempts
  ADD COLUMN IF NOT EXISTS client_ip_hash text;

-- Truncate ephemeral legacy attempt logs
TRUNCATE TABLE public.share_access_attempts;

ALTER TABLE public.share_access_attempts
  ALTER COLUMN client_ip_hash SET NOT NULL;

-- Add UNIQUE constraint on (share_token, client_ip_hash) for atomic upserts.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_share_access_attempts_token_client'
  ) THEN
    ALTER TABLE public.share_access_attempts
      ADD CONSTRAINT uq_share_access_attempts_token_client UNIQUE (share_token, client_ip_hash);
  END IF;
END $$;

REVOKE ALL ON public.share_access_attempts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.share_access_attempts TO service_role;

-- 5. Atomic RPC: claim_share_refresh
-- Prevents cache stampede: only one concurrent request can acquire the lease to refresh stale cache.
CREATE OR REPLACE FUNCTION public.claim_share_refresh(
  p_share_id uuid,
  p_lease_seconds integer DEFAULT 30,
  p_stale_age_seconds integer DEFAULT 300
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed boolean;
BEGIN
  UPDATE public.shared_roadmaps
  SET refreshing_until = now() + make_interval(secs => p_lease_seconds)
  WHERE id = p_share_id
    AND (cached_at IS NULL OR cached_at <= now() - make_interval(secs => p_stale_age_seconds))
    AND (refreshing_until IS NULL OR refreshing_until <= now())
  RETURNING true INTO v_claimed;

  RETURN coalesce(v_claimed, false);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_share_refresh(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_share_refresh(uuid, integer, integer) TO service_role;

-- 6. Atomic RPC: check_share_rate_limit
-- Read-only check for pre-auth prompts: checks whether a (share_token, client_ip_hash)
-- or the aggregate share_token attempt count is currently blocked without consuming an attempt slot.
-- Caps each client row's contribution to p_max_attempts so a single blocked IP cannot exhaust the aggregate limit.
CREATE OR REPLACE FUNCTION public.check_share_rate_limit(
  p_share_token text,
  p_client_ip_hash text,
  p_max_attempts integer DEFAULT 5,
  p_window_seconds integer DEFAULT 900,
  p_max_aggregate_attempts integer DEFAULT 25
)
RETURNS TABLE (
  blocked boolean,
  retry_after_seconds integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_client_first timestamptz;
  v_client_count integer;
  v_agg_count integer;
  v_agg_earliest timestamptz;
  v_retry_after integer := 0;
BEGIN
  -- 1. Check aggregate attempts across all IPs for this share token within active window.
  -- Cap each IP's contribution to p_max_attempts so one blocked IP cannot exhaust aggregate cap.
  SELECT COALESCE(SUM(LEAST(attempt_count, p_max_attempts)), 0), MIN(first_attempt_at)
  INTO v_agg_count, v_agg_earliest
  FROM public.share_access_attempts
  WHERE share_token = p_share_token
    AND first_attempt_at + make_interval(secs => p_window_seconds) > now();

  IF v_agg_count >= p_max_aggregate_attempts THEN
    v_retry_after := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_agg_earliest + make_interval(secs => p_window_seconds) - now())))::integer);
    RETURN QUERY SELECT true, v_retry_after;
    RETURN;
  END IF;

  -- 2. Check per-(share_token, client_ip_hash) attempts within active window
  SELECT first_attempt_at, attempt_count
  INTO v_client_first, v_client_count
  FROM public.share_access_attempts
  WHERE share_token = p_share_token
    AND client_ip_hash = p_client_ip_hash;

  IF FOUND AND v_client_first + make_interval(secs => p_window_seconds) > now() THEN
    IF v_client_count >= p_max_attempts THEN
      v_retry_after := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_client_first + make_interval(secs => p_window_seconds) - now())))::integer);
      RETURN QUERY SELECT true, v_retry_after;
      RETURN;
    END IF;
  END IF;

  RETURN QUERY SELECT false, 0;
END;
$$;

REVOKE ALL ON FUNCTION public.check_share_rate_limit(text, text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_share_rate_limit(text, text, integer, integer, integer) TO service_role;

-- 7. Atomic RPC: reserve_share_attempt
-- Called BEFORE verifyPassword to atomically reserve an attempt slot.
-- Serializes on share_token advisory lock and ON CONFLICT row lock.
-- Returns blocked = true if limit exceeded; caller then avoids computing 100k PBKDF2 iterations.
CREATE OR REPLACE FUNCTION public.reserve_share_attempt(
  p_share_token text,
  p_client_ip_hash text,
  p_max_attempts integer DEFAULT 5,
  p_window_seconds integer DEFAULT 900,
  p_max_aggregate_attempts integer DEFAULT 25
)
RETURNS TABLE (
  blocked boolean,
  attempt_count integer,
  retry_after_seconds integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agg_count integer;
  v_agg_earliest timestamptz;
  v_retry_after integer := 0;
  v_cur_count integer;
  v_cur_first timestamptz;
BEGIN
  -- Take transaction-scoped advisory lock per share token to serialize
  -- aggregate limit evaluation and prevent race conditions overshooting.
  PERFORM pg_advisory_xact_lock(hashtext(p_share_token));

  -- 1. Check if aggregate cap is exceeded (capping each IP's contribution to p_max_attempts)
  SELECT COALESCE(SUM(LEAST(share_access_attempts.attempt_count, p_max_attempts)), 0), MIN(share_access_attempts.first_attempt_at)
  INTO v_agg_count, v_agg_earliest
  FROM public.share_access_attempts
  WHERE share_token = p_share_token
    AND first_attempt_at + make_interval(secs => p_window_seconds) > now();

  IF v_agg_count >= p_max_aggregate_attempts THEN
    v_retry_after := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_agg_earliest + make_interval(secs => p_window_seconds) - now())))::integer);
    RETURN QUERY SELECT true, v_agg_count, v_retry_after;
    RETURN;
  END IF;

  -- 2. Atomically reserve / increment attempt slot for this client
  INSERT INTO public.share_access_attempts (
    share_token,
    client_ip_hash,
    attempt_count,
    first_attempt_at,
    last_attempt_at
  )
  VALUES (
    p_share_token,
    p_client_ip_hash,
    1,
    now(),
    now()
  )
  ON CONFLICT (share_token, client_ip_hash) DO UPDATE
  SET
    attempt_count = CASE
      WHEN share_access_attempts.first_attempt_at + make_interval(secs => p_window_seconds) <= now() THEN 1
      ELSE LEAST(share_access_attempts.attempt_count + 1, p_max_attempts + 1)
    END,
    first_attempt_at = CASE
      WHEN share_access_attempts.first_attempt_at + make_interval(secs => p_window_seconds) <= now() THEN now()
      ELSE share_access_attempts.first_attempt_at
    END,
    last_attempt_at = now()
  RETURNING
    share_access_attempts.attempt_count,
    share_access_attempts.first_attempt_at
  INTO v_cur_count, v_cur_first;

  -- If attempt_count > p_max_attempts, this client has exceeded their limit
  IF v_cur_count > p_max_attempts THEN
    v_retry_after := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_cur_first + make_interval(secs => p_window_seconds) - now())))::integer);
    RETURN QUERY SELECT true, v_cur_count, v_retry_after;
    RETURN;
  END IF;

  -- Successfully reserved slot
  RETURN QUERY SELECT false, v_cur_count, 0;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_share_attempt(text, text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_share_attempt(text, text, integer, integer, integer) TO service_role;

-- 8. Atomic RPC: reset_share_failed_attempts
-- Clears attempts for client on successful password verification.
CREATE OR REPLACE FUNCTION public.reset_share_failed_attempts(
  p_share_token text,
  p_client_ip_hash text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.share_access_attempts
  WHERE share_token = p_share_token
    AND client_ip_hash = p_client_ip_hash;
END;
$$;

REVOKE ALL ON FUNCTION public.reset_share_failed_attempts(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_share_failed_attempts(text, text) TO service_role;
