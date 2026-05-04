-- ============================================================================
-- library_server_grants.server_id auto-fill from collection_id
-- ============================================================================
-- Migration 003 made collection_id the access primitive but left the legacy
-- server_id column NOT NULL (it's still referenced by the
-- "grants — owner sees + manages" RLS policy via user_owns_library_server).
-- The new client inserts only collection_id, which 23502s on the NOT NULL
-- constraint. A BEFORE INSERT trigger fills server_id from the collection
-- so existing policies keep working and the column stays consistent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fill_grant_server_id_from_collection()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.server_id IS NULL AND NEW.collection_id IS NOT NULL THEN
    SELECT server_id INTO NEW.server_id
      FROM public.library_collections
      WHERE id = NEW.collection_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS library_server_grants_fill_server_id ON public.library_server_grants;
CREATE TRIGGER library_server_grants_fill_server_id
  BEFORE INSERT OR UPDATE OF collection_id ON public.library_server_grants
  FOR EACH ROW EXECUTE FUNCTION public.fill_grant_server_id_from_collection();
