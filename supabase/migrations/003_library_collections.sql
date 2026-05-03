-- ============================================================================
-- Library collections — sub-libraries inside a library server
-- ============================================================================
-- A library server can host multiple "collections" (e.g. Adult / Kids /
-- Audiobooks), each rooted at a top-level subdirectory of LIBRARY_PATH.
-- Grants are now scoped per-collection: when an owner shares their library
-- with a friend, they pick which collections that friend can see.
--
-- The scanner discovers collections from disk: every top-level subdir of
-- LIBRARY_PATH becomes a row in library_collections (rel_path = the dir name).
-- Books in the LIBRARY_PATH root (no subdir) land in a synthetic "Unsorted"
-- collection (rel_path = ''), only visible to the owner.
--
-- This migration is non-destructive: existing single-library servers get
-- one default collection containing all their books, and existing grants
-- are expanded into one row per collection so current shares keep working.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- library_collections
-- ----------------------------------------------------------------------------
CREATE TABLE public.library_collections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   uuid NOT NULL REFERENCES public.library_servers(id) ON DELETE CASCADE,
  -- Display name. Defaults to the directory basename; owner can rename.
  name        text NOT NULL,
  -- Path relative to LIBRARY_PATH on the host filesystem. Empty string '' is
  -- the synthetic "Unsorted" collection holding files at the library root.
  -- A non-empty rel_path names a single top-level subdirectory; nested
  -- subdirs of that root all belong to the same collection.
  rel_path    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (server_id, rel_path)
);
CREATE INDEX idx_library_collections_server ON public.library_collections (server_id);

ALTER TABLE public.library_collections ENABLE ROW LEVEL SECURITY;

-- Owner sees + manages their own server's collections.
CREATE POLICY "collections — owner sees + manages" ON public.library_collections
  FOR ALL TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.library_servers s
      WHERE s.id = library_collections.server_id AND s.owner_id = auth.uid()
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.library_servers s
      WHERE s.id = library_collections.server_id AND s.owner_id = auth.uid()
    )
  );

-- Grantee sees only the collections they were granted access to.
CREATE POLICY "collections — grantee sees granted" ON public.library_collections
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.library_server_grants g
      WHERE g.collection_id = library_collections.id
        AND g.grantee_id = auth.uid()
        AND g.revoked_at IS NULL
    )
  );

-- updated_at trigger
CREATE TRIGGER library_collections_touch BEFORE UPDATE ON public.library_collections
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- library_server_books.collection_id
-- ----------------------------------------------------------------------------
-- Add the FK as nullable first, backfill, then enforce NOT NULL.
ALTER TABLE public.library_server_books
  ADD COLUMN collection_id uuid REFERENCES public.library_collections(id) ON DELETE CASCADE;

-- ----------------------------------------------------------------------------
-- library_server_grants.collection_id
-- ----------------------------------------------------------------------------
ALTER TABLE public.library_server_grants
  ADD COLUMN collection_id uuid REFERENCES public.library_collections(id) ON DELETE CASCADE;

-- Drop the old (server_id, grantee_id) unique index — it's now (collection_id,
-- grantee_id) since a grantee can hold multiple grants on one server (one per
-- collection they have access to).
DROP INDEX IF EXISTS public.uq_active_grants;

-- ----------------------------------------------------------------------------
-- Backfill: one default collection per existing server, all books into it,
-- expand each existing grant into a per-collection grant.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  srv RECORD;
  default_collection_id uuid;
  grant_row RECORD;
BEGIN
  FOR srv IN SELECT id FROM public.library_servers LOOP
    -- Create a default "Library" collection at rel_path = '' (root).
    INSERT INTO public.library_collections (server_id, name, rel_path)
    VALUES (srv.id, 'Library', '')
    RETURNING id INTO default_collection_id;

    -- Move all of this server's books into the default collection.
    UPDATE public.library_server_books
       SET collection_id = default_collection_id
     WHERE server_id = srv.id;

    -- For each existing active grant on this server, point it at the new
    -- default collection. (Pre-migration grants were server-wide; the only
    -- collection that exists is the default, so this preserves access.)
    UPDATE public.library_server_grants
       SET collection_id = default_collection_id
     WHERE server_id = srv.id
       AND collection_id IS NULL;
  END LOOP;
END $$;

-- Now make collection_id NOT NULL on both tables. Any rows still null at
-- this point indicate an orphan — let the constraint surface them.
ALTER TABLE public.library_server_books
  ALTER COLUMN collection_id SET NOT NULL;

ALTER TABLE public.library_server_grants
  ALTER COLUMN collection_id SET NOT NULL;

-- New uniqueness: at most one active grant per (collection, grantee). A
-- friend can hold grants on multiple collections of one server (that's the
-- whole point), but they can't hold two on the same collection.
CREATE UNIQUE INDEX uq_active_collection_grants
  ON public.library_server_grants (collection_id, grantee_id)
  WHERE revoked_at IS NULL;

-- ----------------------------------------------------------------------------
-- Update SECURITY DEFINER helpers + RLS policies for collection-aware grants
-- ----------------------------------------------------------------------------
-- Migration 002 introduced helpers that took a server_id. With per-collection
-- grants we need: (a) "any active grant on any collection of this server"
-- (server-level check, used by library_servers visibility) and (b) "active
-- grant on *this specific collection*" (used by library_server_books).

-- (a) Server-level: still valid as "user holds an active grant on at least
-- one collection of this server." Redefine to join through library_collections.
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

-- (b) Collection-level: precise check used by library_server_books and the
-- file-streaming middleware on the library server.
CREATE OR REPLACE FUNCTION public.user_has_active_collection_grant(p_collection_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.library_server_grants
    WHERE collection_id = p_collection_id
      AND grantee_id = p_user_id
      AND revoked_at IS NULL
  );
$$;

-- Repoint library_server_books visibility at the precise per-collection
-- helper. Owner check is unchanged.
DROP POLICY IF EXISTS "lib books — visible to owner + grantees" ON public.library_server_books;
CREATE POLICY "lib books — visible to owner + grantees" ON public.library_server_books
  FOR SELECT TO authenticated USING (
    public.user_owns_library_server(server_id, auth.uid())
    OR public.user_has_active_collection_grant(collection_id, auth.uid())
  );

-- library_servers grantee visibility uses the (now collection-aware) helper —
-- no change to the policy itself; the helper redefinition above is enough.

-- ----------------------------------------------------------------------------
-- Permissions: same surface as the rest of v0.6 (see migration 002).
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.library_collections TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.library_collections TO service_role;
