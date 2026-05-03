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
-- Schema-only migration. The helper-function and library_server_books policy
-- updates that depend on the new collection_id column live in 004 — Postgres
-- validates SQL function bodies at CREATE time, so they need a separate
-- transaction after the column commits.
--
-- Backfill is non-destructive: existing single-library servers get one
-- default collection holding all their books, and existing grants are
-- repointed at it so current shares keep working.
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

-- collection_id columns first, so the RLS policies below validate against
-- an existing column. Postgres parses CREATE POLICY USING clauses at
-- creation time.
ALTER TABLE public.library_server_grants
  ADD COLUMN collection_id uuid REFERENCES public.library_collections(id) ON DELETE CASCADE;

ALTER TABLE public.library_server_books
  ADD COLUMN collection_id uuid REFERENCES public.library_collections(id) ON DELETE CASCADE;

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

CREATE TRIGGER library_collections_touch BEFORE UPDATE ON public.library_collections
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Old uniqueness was per-server; new is per-collection (created below).
DROP INDEX IF EXISTS public.uq_active_grants;

-- ----------------------------------------------------------------------------
-- Backfill: one default collection per existing server, all books into it,
-- repoint each existing grant.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  srv RECORD;
  default_collection_id uuid;
BEGIN
  FOR srv IN SELECT id FROM public.library_servers LOOP
    INSERT INTO public.library_collections (server_id, name, rel_path)
    VALUES (srv.id, 'Library', '')
    RETURNING id INTO default_collection_id;

    UPDATE public.library_server_books
       SET collection_id = default_collection_id
     WHERE server_id = srv.id;

    UPDATE public.library_server_grants
       SET collection_id = default_collection_id
     WHERE server_id = srv.id
       AND collection_id IS NULL;
  END LOOP;
END $$;

ALTER TABLE public.library_server_books
  ALTER COLUMN collection_id SET NOT NULL;

ALTER TABLE public.library_server_grants
  ALTER COLUMN collection_id SET NOT NULL;

CREATE UNIQUE INDEX uq_active_collection_grants
  ON public.library_server_grants (collection_id, grantee_id)
  WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.library_collections TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.library_collections TO service_role;
