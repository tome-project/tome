-- Migration 014: scoped clubmate visibility for reading_progress +
-- reading_sessions.
--
-- The existing policies are FOR ALL with USING (user_id = auth.uid()),
-- which means every club member only ever sees their own progress on
-- the pace bar — the avatars for other members silently disappear
-- under RLS. The live "reading right now" ring has the same blind
-- spot.
--
-- Replace the FOR ALL "own only" policies with:
--   * FOR SELECT: own rows + clubmates' rows on shared picks
--   * FOR INSERT/UPDATE/DELETE: own only (unchanged semantics)
--
-- The SELECT scope is intentionally narrow: a clubmate's progress is
-- only visible on a book that is, or was, an active pick in a club
-- both users belong to. Reading a private book or being in a
-- different club doesn't leak progress.

-- reading_progress -------------------------------------------------

DROP POLICY IF EXISTS "progress — own only" ON public.reading_progress;

DROP POLICY IF EXISTS "progress — visible to clubmates on shared picks"
  ON public.reading_progress;
CREATE POLICY "progress — visible to clubmates on shared picks"
  ON public.reading_progress FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.club_picks cp
      JOIN public.club_members me   ON me.club_id   = cp.club_id
      JOIN public.club_members them ON them.club_id = cp.club_id
      WHERE me.user_id   = auth.uid()
        AND them.user_id = reading_progress.user_id
        AND cp.book_id   = reading_progress.book_id
        AND cp.status IN ('active', 'finished')
    )
  );

DROP POLICY IF EXISTS "progress — insert own" ON public.reading_progress;
CREATE POLICY "progress — insert own"
  ON public.reading_progress FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "progress — update own" ON public.reading_progress;
CREATE POLICY "progress — update own"
  ON public.reading_progress FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "progress — delete own" ON public.reading_progress;
CREATE POLICY "progress — delete own"
  ON public.reading_progress FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- reading_sessions -------------------------------------------------

DROP POLICY IF EXISTS "sessions — own only" ON public.reading_sessions;

DROP POLICY IF EXISTS "sessions — visible to clubmates on shared picks"
  ON public.reading_sessions;
CREATE POLICY "sessions — visible to clubmates on shared picks"
  ON public.reading_sessions FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.club_picks cp
      JOIN public.club_members me   ON me.club_id   = cp.club_id
      JOIN public.club_members them ON them.club_id = cp.club_id
      WHERE me.user_id   = auth.uid()
        AND them.user_id = reading_sessions.user_id
        AND cp.book_id   = reading_sessions.book_id
        AND cp.status IN ('active', 'finished')
    )
  );

DROP POLICY IF EXISTS "sessions — insert own" ON public.reading_sessions;
CREATE POLICY "sessions — insert own"
  ON public.reading_sessions FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "sessions — update own" ON public.reading_sessions;
CREATE POLICY "sessions — update own"
  ON public.reading_sessions FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "sessions — delete own" ON public.reading_sessions;
CREATE POLICY "sessions — delete own"
  ON public.reading_sessions FOR DELETE TO authenticated
  USING (user_id = auth.uid());
