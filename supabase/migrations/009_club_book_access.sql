-- Migration 009: club_book_access — temporary in-club book sharing.
--
-- The killer "Discord replacement" feature: when a host creates a book
-- club for, say, "Dungeon Crawler Carl" with a book they own, every
-- member who joins the club gets time-bounded read access to the
-- host's file for the duration of the club. The book auto-appears on
-- the member's shelf (via a sibling user_books row inserted on join).
-- When the club ends (parent club deleted, member leaves, or club
-- end_date passes), the access is revoked and /files/:bookId 403s.
--
-- Why a sibling table instead of extending library_server_grants:
-- library_server_grants is per-COLLECTION (the entire kids/ or adult/
-- subdirectory). Club access is per-BOOK — the host is lending exactly
-- one file, not opening up their whole library. Different access
-- primitive, different table.

CREATE TABLE IF NOT EXISTS public.club_book_access (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id     uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  book_id     uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  granted_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

-- Per-request middleware lookup ("does this user have an active club
-- grant on this book?") runs on every /files/:bookId hit, so this
-- index has to exist.
CREATE INDEX IF NOT EXISTS idx_club_book_access_user_book_active
  ON public.club_book_access (user_id, book_id)
  WHERE revoked_at IS NULL;

-- For finding all active grants on a club (member-leave, club-delete,
-- and the host's "who has access" view).
CREATE INDEX IF NOT EXISTS idx_club_book_access_club_active
  ON public.club_book_access (club_id)
  WHERE revoked_at IS NULL;

-- Active uniqueness only: prevent double-active grants for the same
-- (club, user, book). Revoked rows stay around for audit + rejoin
-- history, so the partial predicate lets a member leave + rejoin
-- without an UPSERT dance.
CREATE UNIQUE INDEX IF NOT EXISTS uq_club_book_access_active
  ON public.club_book_access (club_id, user_id, book_id)
  WHERE revoked_at IS NULL;

ALTER TABLE public.club_book_access ENABLE ROW LEVEL SECURITY;

-- Writes happen exclusively from the server backend (service role
-- bypasses RLS). Client-side reads are scoped: a member sees their
-- own grants; a host sees every grant on clubs they own.

DROP POLICY IF EXISTS "club_book_access — grantee sees own"
  ON public.club_book_access;
CREATE POLICY "club_book_access — grantee sees own"
  ON public.club_book_access FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "club_book_access — host sees club"
  ON public.club_book_access;
CREATE POLICY "club_book_access — host sees club"
  ON public.club_book_access FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.clubs c
      WHERE c.id = club_book_access.club_id AND c.host_id = auth.uid()
    )
  );
