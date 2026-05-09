-- Migration 007: per-server service users + scoped RLS for self-hosting.
--
-- Today the library server writes via SUPABASE_SERVICE_ROLE_KEY, which
-- bypasses RLS. That key is god-mode over the entire Supabase project,
-- so we cannot ship it to strangers running their own Tome server.
--
-- This migration introduces a per-server identity: each library_servers
-- row is bound to its own auth.users row (`service_user_id`). The server
-- signs into Supabase as that user and writes via RLS — scoped to *its
-- own* rows only. The hub mints these auth users at pair time.
--
-- Migration is purely additive:
--   * adds library_servers.service_user_id (nullable for backfill)
--   * adds INSERT/UPDATE/DELETE policies the new scoped users will use
--   * does NOT remove or weaken any existing policy
--   * does NOT touch the prod server's service-role write path
-- so prod stays exactly as it is until we cut it over.

-- ---------------------------------------------------------------------------
-- library_servers: bind to a service auth user
-- ---------------------------------------------------------------------------
ALTER TABLE public.library_servers
  ADD COLUMN IF NOT EXISTS service_user_id uuid
    REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_library_servers_service_user
  ON public.library_servers (service_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_library_servers_service_user
  ON public.library_servers (service_user_id)
  WHERE service_user_id IS NOT NULL;

-- The service user can SELECT its own row (currently the existing owner
-- policy only matches the human owner; the server itself has no user
-- identity that satisfies any of the existing SELECT policies).
DROP POLICY IF EXISTS "library servers — service self select" ON public.library_servers;
CREATE POLICY "library servers — service self select" ON public.library_servers
  FOR SELECT TO authenticated USING (service_user_id = auth.uid());

-- The service user can UPDATE its own row (heartbeat: last_seen_at,
-- is_active, version, public_url). It cannot reassign owner_id or move
-- itself to a different service user — WITH CHECK prevents that.
DROP POLICY IF EXISTS "library servers — service self update" ON public.library_servers;
CREATE POLICY "library servers — service self update" ON public.library_servers
  FOR UPDATE TO authenticated
  USING (service_user_id = auth.uid())
  WITH CHECK (service_user_id = auth.uid());

-- INSERT and DELETE on library_servers stay service-role-only. The hub
-- creates rows during /pair; deletion happens via delete_my_account or
-- explicit owner action through a hub endpoint.

-- ---------------------------------------------------------------------------
-- library_collections: server writes its own collections via RLS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "collections — service writes" ON public.library_collections;
CREATE POLICY "collections — service writes" ON public.library_collections
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.library_servers s
      WHERE s.id = library_collections.server_id
        AND s.service_user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.library_servers s
      WHERE s.id = library_collections.server_id
        AND s.service_user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- library_server_books: server writes its own catalog rows via RLS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "lib books — service writes" ON public.library_server_books;
CREATE POLICY "lib books — service writes" ON public.library_server_books
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.library_servers s
      WHERE s.id = library_server_books.server_id
        AND s.service_user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.library_servers s
      WHERE s.id = library_server_books.server_id
        AND s.service_user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- library_server_grants: service users need to READ grants on their own
-- server (for file-streaming auth — middleware checks "does this caller
-- have a grant on the collection that hosts this book"). They must NOT
-- see grants on *other* servers.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "grants — service reads own server's grants" ON public.library_server_grants;
CREATE POLICY "grants — service reads own server's grants" ON public.library_server_grants
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.library_servers s
      WHERE s.id = library_server_grants.server_id
        AND s.service_user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- books (global catalog): allow library-server service users to stamp
-- cover_url on rows that don't have one yet. Today the scanner does this
-- via service-role; self-hosted servers need a scoped path.
--
-- The policy is intentionally narrow: only library-server service users
-- (those with a row in library_servers.service_user_id), only on rows
-- where cover_url IS NULL. Regular app users cannot UPDATE books at all.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "books — service stamps covers" ON public.books;
CREATE POLICY "books — service stamps covers" ON public.books
  FOR UPDATE TO authenticated
  USING (
    cover_url IS NULL
    AND EXISTS (SELECT 1 FROM public.library_servers WHERE service_user_id = auth.uid())
  )
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Notes for cutover (tracked in the README, restated here for the SQL log):
--
-- 1. After applying this migration, prod still works unchanged — its
--    service_role bypasses RLS regardless of these policies.
-- 2. The hub's POST /api/v1/hub/pair endpoint creates the auth.users
--    row for new library servers and stamps service_user_id.
-- 3. Self-hosted servers run with NO service-role key; they sign into
--    Supabase as their service user and rely on the policies above.
-- 4. To cut prod over (optional, future): create a service user for
--    the prod library_servers row, store creds, drop the env's
--    SUPABASE_SERVICE_ROLE_KEY. RLS now governs prod too.
-- ---------------------------------------------------------------------------
