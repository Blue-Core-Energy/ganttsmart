-- Migration 012: Harden functions search_path and share_access_attempts table permissions (IT-157)

-- 1. Harden public.handle_new_user() by explicitly setting search_path to public
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_settings (id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;

-- 2. Ensure public.share_access_attempts is accessible only by service_role
REVOKE ALL ON TABLE public.share_access_attempts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.share_access_attempts TO service_role;
