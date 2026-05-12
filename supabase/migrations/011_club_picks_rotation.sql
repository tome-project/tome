-- Migration 011: clubs become persistent communities; books rotate through.
--
-- The v1 model in migration 009 treated a club as a single-book session
-- (clubs.book_id pinned the read). That isn't how real book clubs work
-- — clubs are communities that pick up a new book every few weeks. This
-- migration introduces club_picks as the rotation primitive, keeps
-- clubs.book_id around as a synced "current pick" pointer for the
-- existing client embed `clubs.select('*, book:books(*)')`, and reworks
-- the trigger logic so:
--
--   - Any active pick lights up read access for every current member of
--     its club. Joining a club mid-pick grants access to the active
--     pick(s). Leaving revokes the member's grants on that club.
--   - Setting a new active pick replaces the previous one (BEFORE
--     trigger demotes the prior active to finished and fires its
--     revoke). The new pick's grants light up via the AFTER trigger.
--   - Past picks stay around as the club's history.

-- ---------------------------------------------------------------------------
-- club_picks: a (book, time window, status) per club. status=active is
-- the currently-reading pick; finished/cancelled rows are history.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.club_picks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id       uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  book_id       uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  nominated_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  starts_at     timestamptz NOT NULL DEFAULT now(),
  ends_at       timestamptz,
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('proposed','active','finished','cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- At most one active pick per club. Partial unique so finished picks
-- can stack up without conflict.
CREATE UNIQUE INDEX IF NOT EXISTS uq_club_picks_active
  ON public.club_picks (club_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_club_picks_club_status
  ON public.club_picks (club_id, status);

CREATE INDEX IF NOT EXISTS idx_club_picks_book
  ON public.club_picks (book_id);

ALTER TABLE public.club_picks ENABLE ROW LEVEL SECURITY;

-- Members of a club see every pick of that club (active + history).
DROP POLICY IF EXISTS "club_picks — member sees" ON public.club_picks;
CREATE POLICY "club_picks — member sees"
  ON public.club_picks FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.club_members cm
      WHERE cm.club_id = club_picks.club_id AND cm.user_id = auth.uid()
    )
  );

-- A member can propose / set a pick on a club they're in. We don't
-- gate on host-only here — for MVP, anyone in the club can swap the
-- pick. A future migration can narrow this to host/moderator.
DROP POLICY IF EXISTS "club_picks — member nominates" ON public.club_picks;
CREATE POLICY "club_picks — member nominates"
  ON public.club_picks FOR INSERT TO authenticated
  WITH CHECK (
    nominated_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.club_members cm
      WHERE cm.club_id = club_picks.club_id AND cm.user_id = auth.uid()
    )
  );

-- A member can update a pick (mark finished, cancel, edit dates) of a
-- club they're in. Same rationale as INSERT.
DROP POLICY IF EXISTS "club_picks — member updates" ON public.club_picks;
CREATE POLICY "club_picks — member updates"
  ON public.club_picks FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.club_members cm
      WHERE cm.club_id = club_picks.club_id AND cm.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- clubs.book_id: relax NOT NULL. The column now mirrors the current
-- active pick's book_id (maintained by trigger) so the existing
-- `clubs.select('*, book:books(*)')` embed in the client still resolves
-- without code change. New clients should read club_picks directly.
-- ---------------------------------------------------------------------------
ALTER TABLE public.clubs ALTER COLUMN book_id DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- TRIGGERS: replace the 010 versions with rotation-aware ones.
--
-- club_picks BEFORE INSERT/UPDATE: demote any prior active pick on the
-- same club to 'finished'. Without this, the partial unique on
-- (club_id) WHERE status='active' would reject the second insert and
-- the client would have to do its own pre-update dance under a race.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.club_picks_demote_others()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'active' THEN
    UPDATE public.club_picks
       SET status   = 'finished',
           ends_at  = COALESCE(ends_at, now())
     WHERE club_id  = NEW.club_id
       AND status   = 'active'
       AND id IS DISTINCT FROM NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_club_picks_demote_others ON public.club_picks;
CREATE TRIGGER trg_club_picks_demote_others
BEFORE INSERT OR UPDATE OF status ON public.club_picks
FOR EACH ROW EXECUTE FUNCTION public.club_picks_demote_others();

-- AFTER INSERT/UPDATE → status=active: fan grants out to every member,
-- auto-shelf the book, and update clubs.book_id back-pointer.
CREATE OR REPLACE FUNCTION public.club_picks_activate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'active' AND (
       TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'active'
     ) THEN
    -- Grant every current member access to this pick's book.
    INSERT INTO public.club_book_access (club_id, user_id, book_id, granted_by)
    SELECT NEW.club_id, cm.user_id, NEW.book_id, NEW.nominated_by
      FROM public.club_members cm
     WHERE cm.club_id = NEW.club_id
    ON CONFLICT (club_id, user_id, book_id) WHERE revoked_at IS NULL
    DO NOTHING;

    -- Auto-shelf for every member (don't clobber an existing row).
    INSERT INTO public.user_books (user_id, book_id, status, source)
    SELECT cm.user_id, NEW.book_id, 'want', 'library_server'
      FROM public.club_members cm
     WHERE cm.club_id = NEW.club_id
    ON CONFLICT (user_id, book_id) DO NOTHING;

    -- Back-compat: keep clubs.book_id pointed at the active pick so the
    -- existing client embed `clubs.select('*, book:books(*))` keeps
    -- rendering the right cover.
    UPDATE public.clubs SET book_id = NEW.book_id WHERE id = NEW.club_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_club_picks_activate ON public.club_picks;
CREATE TRIGGER trg_club_picks_activate
AFTER INSERT OR UPDATE OF status ON public.club_picks
FOR EACH ROW EXECUTE FUNCTION public.club_picks_activate();

-- AFTER UPDATE: pick goes from 'active' → finished/cancelled → revoke
-- all grants on that (club, book) pair. The BEFORE-demote trigger
-- fires this too when a new pick replaces the old one.
CREATE OR REPLACE FUNCTION public.club_picks_deactivate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'active' AND NEW.status IN ('finished', 'cancelled') THEN
    UPDATE public.club_book_access
       SET revoked_at = now()
     WHERE club_id = NEW.club_id
       AND book_id = NEW.book_id
       AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_club_picks_deactivate ON public.club_picks;
CREATE TRIGGER trg_club_picks_deactivate
AFTER UPDATE OF status ON public.club_picks
FOR EACH ROW EXECUTE FUNCTION public.club_picks_deactivate();

-- ---------------------------------------------------------------------------
-- Replace the 010 club_members trigger: instead of reading clubs.book_id,
-- mint a grant for each currently-active pick on this club. (Almost
-- always one; the schema doesn't preclude multiple in the future.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.club_member_mint_access()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.club_book_access (club_id, user_id, book_id, granted_by)
  SELECT NEW.club_id, NEW.user_id, cp.book_id, NEW.user_id
    FROM public.club_picks cp
   WHERE cp.club_id = NEW.club_id
     AND cp.status  = 'active'
  ON CONFLICT (club_id, user_id, book_id) WHERE revoked_at IS NULL
  DO NOTHING;

  INSERT INTO public.user_books (user_id, book_id, status, source)
  SELECT NEW.user_id, cp.book_id, 'want', 'library_server'
    FROM public.club_picks cp
   WHERE cp.club_id = NEW.club_id
     AND cp.status  = 'active'
  ON CONFLICT (user_id, book_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- club_member_revoke_access from 010 is still correct: revokes all of
-- the leaving member's active grants on the club, regardless of pick.

-- ---------------------------------------------------------------------------
-- Data migration: every existing clubs row with book_id IS NOT NULL
-- becomes a club_picks row with status='active'. The activate trigger
-- fires and re-mints grants on top of what migration 010 already wrote
-- (ON CONFLICT DO NOTHING keeps it idempotent).
-- ---------------------------------------------------------------------------
INSERT INTO public.club_picks (
  club_id, book_id, nominated_by, starts_at, ends_at, status, created_at
)
SELECT c.id,
       c.book_id,
       c.host_id,
       COALESCE(c.start_date, c.created_at),
       c.end_date,
       'active',
       c.created_at
  FROM public.clubs c
 WHERE c.book_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.club_picks cp
     WHERE cp.club_id = c.id AND cp.status = 'active'
   );
