-- ============================================================================
-- Collection-aware grant helpers + library_server_books policy update
-- ============================================================================
-- Migration 003 added collection_id to library_server_grants. This migration
-- repoints the access-check helpers and the lib books visibility policy at
-- the per-collection grant primitive.
--
-- Split out of 003 because Postgres validates SQL function bodies at CREATE
-- time, and the new bodies reference columns that 003 introduces. Running
-- the helper updates in a separate transaction lets the schema commit first
-- so the validator sees the new column.
-- ============================================================================

-- (a) Server-level: still useful as "user holds an active grant on at least
-- one collection of this server." Used by library_servers visibility.
CREATE OR REPLACE FUNCTION public.user_has_active_grant(p_server_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.library_server_grants g
    JOIN public.library_collections c ON c.id = g.collection_id
    WHERE c.server_id = p_server_id
      AND g.grantee_id = p_user_id
      AND g.revoked_at IS NULL
  );
$$;

-- (b) Collection-level: precise check for library_server_books visibility
-- and the file-streaming middleware on the library server.
CREATE OR REPLACE FUNCTION public.user_has_active_collection_grant(p_collection_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.library_server_grants
    WHERE collection_id = p_collection_id
      AND grantee_id = p_user_id
      AND revoked_at IS NULL
  );
$$;

DROP POLICY IF EXISTS "lib books — visible to owner + grantees" ON public.library_server_books;
CREATE POLICY "lib books — visible to owner + grantees" ON public.library_server_books
  FOR SELECT TO authenticated USING (
    public.user_owns_library_server(server_id, auth.uid())
    OR public.user_has_active_collection_grant(collection_id, auth.uid())
  );
