-- Migration 018: Streaks should only count days where progress actually moved.
--
-- THE BUG: migration 017 stamped a `reading_days` row on EVERY
-- reading_progress write. But the app saves position aggressively and
-- unconditionally:
--   * reader_screen saves on dispose, on app-background, and on a 30s timer
--     while the reader is open — even if the user never turned a page
--     (open book → glance → close = a "reading day" with zero reading).
--   * audio_player saves on a 15s timer guarded only by `hasEverPlayed`,
--     which persists in the long-lived audio handler across screen opens
--     (open the player days later, never press play → the timer saves the
--     unchanged position and stamps a day anyway).
-- Result: streaks that never break as long as the app is opened in the
-- evening, e.g. a 20+ day "streak" spanning days with no reading at all.
--
-- THE FIX: the trigger now skips no-op writes — an UPDATE that changes
-- neither position, percentage, nor chapter records no activity. Because
-- this is enforced at the database layer (same argument as 017), every
-- installed app version gets honest streaks immediately, no client
-- release required. A paused player re-saving the same millisecond and an
-- open-and-close ebook both write identical values, so both phantom paths
-- are suppressed. Paging backwards (re-reading) still changes the position,
-- so it still counts — as it should.
--
-- reading_sessions rows are explicit user sessions and keep counting as
-- before. Existing reading_days history is NOT rewritten here; inflated
-- runs already recorded can be cleaned up manually per-user if desired.

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
    -- reading_progress: a save that moves nothing is not activity. This is
    -- the open-and-close / paused-player-tick / lifecycle-flush case.
    IF TG_OP = 'UPDATE'
       AND NEW.position   IS NOT DISTINCT FROM OLD.position
       AND NEW.percentage IS NOT DISTINCT FROM OLD.percentage
       AND NEW.chapter    IS NOT DISTINCT FROM OLD.chapter THEN
      RETURN NEW;
    END IF;
    v_ts := COALESCE(NEW.updated_at, now());
  END IF;

  INSERT INTO public.reading_days (user_id, day)
  VALUES (NEW.user_id, (v_ts AT TIME ZONE 'UTC')::date)
  ON CONFLICT (user_id, day) DO NOTHING;
  RETURN NEW;
END;
$$;
