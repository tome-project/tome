-- ============================================================================
-- Phase 1 — Media servers + per-server sharing
-- ============================================================================
-- Introduces `media_servers` (persistent ABS / Calibre / Plex / OPDS
-- connections) and `server_shares` (per-friend access grants). Connects
-- `book_sources` to its originating server via a new FK.
-- Tokens live encrypted at rest; encryption is done in the app layer using
-- a server-side symmetric key (ENCRYPTION_KEY env var).
-- ============================================================================

-- media_servers: one row per owned connection
CREATE TABLE IF NOT EXISTS public.media_servers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name            text NOT NULL,                    -- user-visible label
  kind            text NOT NULL CHECK (kind IN ('audiobookshelf', 'calibre', 'opds', 'plex')),
  url             text NOT NULL,
  token_encrypted text NOT NULL,                    -- ciphertext of the API token
  last_sync_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_servers_owner ON public.media_servers (owner_id);

ALTER TABLE public.media_servers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owner manages own media servers" ON public.media_servers
  FOR ALL TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- server_shares: (media_server, grantee) access grants
CREATE TABLE IF NOT EXISTS public.server_shares (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_server_id uuid NOT NULL REFERENCES public.media_servers(id) ON DELETE CASCADE,
  grantee_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (media_server_id, grantee_id)
);
CREATE INDEX IF NOT EXISTS idx_server_shares_server ON public.server_shares (media_server_id);
CREATE INDEX IF NOT EXISTS idx_server_shares_grantee ON public.server_shares (grantee_id);

ALTER TABLE public.server_shares ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owner manages their server shares" ON public.server_shares
  FOR ALL TO authenticated
  USING (
    media_server_id IN (SELECT id FROM public.media_servers WHERE owner_id = auth.uid())
  )
  WITH CHECK (
    media_server_id IN (SELECT id FROM public.media_servers WHERE owner_id = auth.uid())
  );
CREATE POLICY "Grantee sees own shares" ON public.server_shares
  FOR SELECT TO authenticated
  USING (grantee_id = auth.uid());

-- Tie book_sources to its originating server. Nullable so upload/gutenberg
-- sources (which don't come from a server) stay clean.
ALTER TABLE public.book_sources
  ADD COLUMN IF NOT EXISTS media_server_id uuid REFERENCES public.media_servers(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_book_sources_media_server ON public.book_sources (media_server_id);

-- Replace the broad "anyone in my circle can see my sources" policy with
-- the per-server share model. Upload/gutenberg sources (media_server_id NULL)
-- stay owner-only; server-backed sources are visible to each grantee.
DROP POLICY IF EXISTS "Circle sees sources" ON public.book_sources;

CREATE POLICY "Grantee sees shared server sources" ON public.book_sources
  FOR SELECT TO authenticated
  USING (
    media_server_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.server_shares ss
      WHERE ss.media_server_id = book_sources.media_server_id
        AND ss.grantee_id = auth.uid()
    )
  );

-- Helper function: can a user access a given source?
-- Used by the file-serving route and RLS-conscious callers.
CREATE OR REPLACE FUNCTION public.can_access_source(user_id uuid, source_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.book_sources s
    WHERE s.id = source_id
      AND (
        s.owner_id = user_id
        OR (
          s.media_server_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.server_shares ss
            WHERE ss.media_server_id = s.media_server_id
              AND ss.grantee_id = user_id
          )
        )
      )
  );
$$;
