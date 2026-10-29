-- Linear OAuth access tokens expire after 24 hours and must be renewed with a
-- rotating refresh token (all Linear OAuth apps since April 1, 2026).
--
-- The expiry lives on user_settings so the client can schedule a refresh.
-- The refresh token lives in its own table with RLS enabled and no policies,
-- so only Edge Functions (service_role) can read it — never the browser.

ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS linear_token_expires_at timestamptz;

CREATE TABLE public.linear_refresh_tokens (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  refresh_token text NOT NULL,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.linear_refresh_tokens ENABLE ROW LEVEL SECURITY;
-- No policies = only service_role access. Also revoke the table grants, so the
-- browser roles still cannot read it if a policy is ever added by mistake.
REVOKE ALL ON public.linear_refresh_tokens FROM anon, authenticated;
