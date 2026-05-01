-- ============================================================================
-- v0.6 follow-up — restore role grants + fix RLS recursion
-- ============================================================================
-- 001 dropped + recreated the public schema, which wiped the default
-- Supabase grants on service_role / authenticated / anon. The library
-- server uses service_role for its own writes (registering itself,
-- recording scanned books, marking pairings consumed), and the app uses
-- authenticated for everything else.
--
-- Separately: the recursive policies on library_servers ↔
-- library_server_grants triggered Postgres' 42P17 cycle detector. Routing
-- the cross-table lookups through SECURITY DEFINER helpers breaks the
-- cycle while keeping the same authorization rules.
-- ============================================================================

GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON SCHEMA public TO postgres, service_role;

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;

-- SECURITY DEFINER helpers to break the library_servers ↔ grants cycle.
CREATE OR REPLACE FUNCTION public.user_has_active_grant(p_server_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.library_server_grants
    WHERE server_id = p_server_id AND grantee_id = p_user_id AND revoked_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.user_owns_library_server(p_server_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.library_servers
    WHERE id = p_server_id AND owner_id = p_user_id
  );
$$;

DROP POLICY IF EXISTS "library servers — grantee sees granted" ON public.library_servers;
CREATE POLICY "library servers — grantee sees granted" ON public.library_servers
  FOR SELECT TO authenticated USING (public.user_has_active_grant(id, auth.uid()));

DROP POLICY IF EXISTS "grants — owner sees + manages" ON public.library_server_grants;
CREATE POLICY "grants — owner sees + manages" ON public.library_server_grants
  FOR ALL TO authenticated USING (public.user_owns_library_server(server_id, auth.uid()));

DROP POLICY IF EXISTS "lib books — visible to owner + grantees" ON public.library_server_books;
CREATE POLICY "lib books — visible to owner + grantees" ON public.library_server_books
  FOR SELECT TO authenticated USING (
    public.user_owns_library_server(server_id, auth.uid())
    OR public.user_has_active_grant(server_id, auth.uid())
  );
