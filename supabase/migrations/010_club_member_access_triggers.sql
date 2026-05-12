-- Migration 010: triggers that wire club_members ↔ club_book_access.
--
-- The Flutter client writes club membership directly via Supabase
-- (server/src/routes/clubs.ts is on disk but not mounted in v0.6+),
-- so the only place we can guarantee the book grant fires is inside
-- the database. These triggers do three things atomically with the
-- membership change:
--
--   On INSERT into club_members:
--     1. Mint an active club_book_access row for (club, user, book).
--     2. Auto-shelf the club's book onto the member's library (a
--        user_books row with status='want'), so it pops up in their
--        Library tab the moment they join.
--
--   On DELETE from club_members:
--     1. Stamp revoked_at = now() on the matching active club_book_access
--        row, which immediately 403s /files/:bookId for that user.
--     2. We leave the user_books row alone — if they want to clean up,
--        they remove it from their shelf themselves. (Auto-removing
--        could nuke a row they edited, e.g. set a rating before leaving.)
--
-- SECURITY DEFINER on both functions: the trigger fires under the
-- inserting/deleting user's role (authenticated), which has no policies
-- on club_book_access. The functions are owned by postgres and bypass
-- RLS to insert the grant. We tighten search_path to prevent shadowing.

-- ---------------------------------------------------------------------------
-- INSERT: mint access + auto-shelf
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.club_member_mint_access()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_book_id uuid;
BEGIN
  SELECT book_id INTO v_book_id FROM public.clubs WHERE id = NEW.club_id;
  IF v_book_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Grant time-bounded read access on the host's book. The partial
  -- unique index on (club_id, user_id, book_id) WHERE revoked_at IS NULL
  -- prevents duplicate active grants; ON CONFLICT keeps re-joins idempotent.
  INSERT INTO public.club_book_access (club_id, user_id, book_id, granted_by)
  VALUES (NEW.club_id, NEW.user_id, v_book_id, NEW.user_id)
  ON CONFLICT (club_id, user_id, book_id) WHERE revoked_at IS NULL
  DO NOTHING;

  -- Auto-shelf the book so it shows up in the member's Library tab.
  -- Don't clobber an existing row (the member may have already shelved
  -- this book independently, possibly with a rating/review/status).
  INSERT INTO public.user_books (user_id, book_id, status, source)
  VALUES (NEW.user_id, v_book_id, 'want', 'library_server')
  ON CONFLICT (user_id, book_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_club_members_mint_access ON public.club_members;
CREATE TRIGGER trg_club_members_mint_access
AFTER INSERT ON public.club_members
FOR EACH ROW EXECUTE FUNCTION public.club_member_mint_access();

-- ---------------------------------------------------------------------------
-- DELETE: revoke access (leaves user_books alone, see header)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.club_member_revoke_access()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.club_book_access
     SET revoked_at = now()
   WHERE club_id = OLD.club_id
     AND user_id = OLD.user_id
     AND revoked_at IS NULL;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_club_members_revoke_access ON public.club_members;
CREATE TRIGGER trg_club_members_revoke_access
AFTER DELETE ON public.club_members
FOR EACH ROW EXECUTE FUNCTION public.club_member_revoke_access();

-- ---------------------------------------------------------------------------
-- Backfill: existing club_members rows have no club_book_access. Mint
-- one for each (assumes they're all still active members of clubs that
-- haven't ended). This only matters in prod for the single live test
-- club we have right now; greenfield installs no-op.
-- ---------------------------------------------------------------------------
INSERT INTO public.club_book_access (club_id, user_id, book_id, granted_by)
SELECT cm.club_id, cm.user_id, c.book_id, cm.user_id
  FROM public.club_members cm
  JOIN public.clubs c ON c.id = cm.club_id
ON CONFLICT (club_id, user_id, book_id) WHERE revoked_at IS NULL
DO NOTHING;

INSERT INTO public.user_books (user_id, book_id, status, source)
SELECT cm.user_id, c.book_id, 'want', 'library_server'
  FROM public.club_members cm
  JOIN public.clubs c ON c.id = cm.club_id
ON CONFLICT (user_id, book_id) DO NOTHING;
