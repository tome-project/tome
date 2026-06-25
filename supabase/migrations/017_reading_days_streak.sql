-- Migration 017: Fix reading streaks with an append-only daily activity log.
--
-- THE BUG: streaks were derived from `reading_progress.updated_at`, but that
-- table is UNIQUE(user_id, book_id) and every save upserts/overwrites
-- updated_at. So the "distinct reading days" set was really "the last day
-- each book was touched" — re-reading any book moved its date to today and
-- erased the prior day. A daily reader of one book was stuck at streak = 1,
-- and the activity heatmap silently lost all past days too.
--
-- THE FIX: a dedicated append-only `reading_days` table (one row per user per
-- active day, never overwritten), populated automatically by an AFTER trigger
-- on every progress/session write. Because it's enforced at the database
-- layer, every client — including old app versions — starts accumulating
-- correct streaks immediately, with no client release required.
--
-- Day boundary is UTC, matching the prior behavior and the heatmap's existing
-- AT TIME ZONE 'UTC' convention. (Per-user timezone is a separate enhancement.)

--------------------------------------------------------------------------------
-- 1. The append-only activity log
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reading_days (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day        date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

CREATE INDEX IF NOT EXISTS idx_reading_days_user_day
  ON public.reading_days (user_id, day DESC);

ALTER TABLE public.reading_days ENABLE ROW LEVEL SECURITY;

-- Read-your-own. Writes happen through the SECURITY DEFINER trigger below,
-- so no INSERT policy for end users is needed.
DROP POLICY IF EXISTS "reading_days — own only" ON public.reading_days;
CREATE POLICY "reading_days — own only" ON public.reading_days
  FOR SELECT TO authenticated USING (user_id = auth.uid());

--------------------------------------------------------------------------------
-- 2. Trigger: record an active day on every progress / session write.
--    SECURITY DEFINER so the insert bypasses reading_days RLS; user_id is
--    copied straight from the source row (already pinned to auth.uid() by the
--    source table's own RLS), so this cannot forge another user's activity.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_reading_day()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ts timestamptz;
BEGIN
  -- reading_sessions has no updated_at column; branch so we never reference
  -- a field the source table lacks. (NEW.<field> binds lazily per branch.)
  IF TG_TABLE_NAME = 'reading_sessions' THEN
    v_ts := COALESCE(NEW.started_at, now());
  ELSE
    v_ts := COALESCE(NEW.updated_at, now());
  END IF;

  INSERT INTO public.reading_days (user_id, day)
  VALUES (NEW.user_id, (v_ts AT TIME ZONE 'UTC')::date)
  ON CONFLICT (user_id, day) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reading_progress_day ON public.reading_progress;
CREATE TRIGGER trg_reading_progress_day
  AFTER INSERT OR UPDATE ON public.reading_progress
  FOR EACH ROW EXECUTE FUNCTION public.record_reading_day();

DROP TRIGGER IF EXISTS trg_reading_sessions_day ON public.reading_sessions;
CREATE TRIGGER trg_reading_sessions_day
  AFTER INSERT OR UPDATE ON public.reading_sessions
  FOR EACH ROW EXECUTE FUNCTION public.record_reading_day();

--------------------------------------------------------------------------------
-- 3. Backfill from whatever history exists today. This recovers the (partial)
--    days still visible in reading_progress.updated_at and every
--    reading_sessions.started_at. Idempotent via ON CONFLICT.
--------------------------------------------------------------------------------
INSERT INTO public.reading_days (user_id, day)
SELECT user_id, (updated_at AT TIME ZONE 'UTC')::date
FROM public.reading_progress
ON CONFLICT (user_id, day) DO NOTHING;

INSERT INTO public.reading_days (user_id, day)
SELECT user_id, (started_at AT TIME ZONE 'UTC')::date
FROM public.reading_sessions
ON CONFLICT (user_id, day) DO NOTHING;

--------------------------------------------------------------------------------
-- 4. Repoint compute_reading_streaks() at the new log. Same gap-island window
--    trick, now over a real activity history instead of last-touched dates.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_reading_streaks()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  WITH
    days AS (
      SELECT day AS d
      FROM public.reading_days
      WHERE user_id = auth.uid()
    ),
    ordered AS (
      SELECT d,
             d - (ROW_NUMBER() OVER (ORDER BY d))::int AS grp
      FROM days
    ),
    runs AS (
      SELECT grp,
             COUNT(*)::int AS run_len,
             MAX(d) AS run_end
      FROM ordered
      GROUP BY grp
    ),
    current AS (
      SELECT COALESCE(
        (SELECT run_len FROM runs
         WHERE run_end >= CURRENT_DATE - 1
         ORDER BY run_end DESC LIMIT 1),
        0
      ) AS streak
    ),
    longest AS (
      SELECT COALESCE(MAX(run_len), 0) AS streak FROM runs
    )
  SELECT jsonb_build_object(
    'current_streak', (SELECT streak FROM current),
    'longest_streak', (SELECT streak FROM longest)
  );
$$;

GRANT EXECUTE ON FUNCTION public.compute_reading_streaks() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.compute_reading_streaks() FROM public;

--------------------------------------------------------------------------------
-- 5. Repoint the activity heatmap at the same log (it had the identical
--    last-touched-only blind spot). One row per active day.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reading_activity_dates(
  p_start date DEFAULT (CURRENT_DATE - 365),
  p_end   date DEFAULT CURRENT_DATE
)
RETURNS TABLE(activity_date date, session_count int)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  SELECT day AS activity_date, 1 AS session_count
  FROM public.reading_days
  WHERE user_id = auth.uid()
    AND day BETWEEN p_start AND p_end
  ORDER BY day;
$$;

GRANT EXECUTE ON FUNCTION public.reading_activity_dates(date, date) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.reading_activity_dates(date, date) FROM public;
