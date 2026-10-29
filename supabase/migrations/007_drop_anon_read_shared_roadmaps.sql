-- The anon_read policy from 004 let anyone holding the public anon key SELECT every
-- shared roadmap row via PostgREST, including cached_data and password_hash.
-- Shared views are served by the share-roadmap Edge Function, which uses the
-- service_role key and bypasses RLS, so anon needs no direct table access.

DROP POLICY IF EXISTS "anon_read" ON public.shared_roadmaps;
