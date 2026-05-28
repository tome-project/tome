-- Migration 016: Postgres RPC functions for reading streaks, activity
-- calendar, and dashboard stats. Called from the Flutter client via
-- supabase.rpc(). All use SECURITY INVOKER so auth.uid() resolves to
-- the calling user and RLS applies naturally.

--------------------------------------------------------------------------------
-- 1. compute_reading_streaks()
--    Returns {current_streak, longest_streak} by walking unique reading
--    days derived from reading_progress.updated_at.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_reading_streaks()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  WITH
    days AS (
      SELECT DISTINCT (updated_at AT TIME ZONE 'UTC')::date AS d
      FROM public.reading_progress
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
-- 2. reading_activity_dates(p_start, p_end)
--    Returns one row per active reading day with a count of activity
--    events. Powers the GitHub-style contribution heatmap.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reading_activity_dates(
  p_start date DEFAULT (CURRENT_DATE - 365),
  p_end   date DEFAULT CURRENT_DATE
)
RETURNS TABLE(activity_date date, session_count int)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  SELECT d, COUNT(*)::int AS session_count
  FROM (
    SELECT (updated_at AT TIME ZONE 'UTC')::date AS d
    FROM public.reading_progress
    WHERE user_id = auth.uid()
      AND (updated_at AT TIME ZONE 'UTC')::date BETWEEN p_start AND p_end
    UNION ALL
    SELECT (started_at AT TIME ZONE 'UTC')::date AS d
    FROM public.reading_sessions
    WHERE user_id = auth.uid()
      AND (started_at AT TIME ZONE 'UTC')::date BETWEEN p_start AND p_end
  ) active_days
  GROUP BY d
  ORDER BY d;
$$;

GRANT EXECUTE ON FUNCTION public.reading_activity_dates(date, date) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.reading_activity_dates(date, date) FROM public;

--------------------------------------------------------------------------------
-- 3. dashboard_stats(p_year)
--    Single-call aggregation for the Year Review and dashboard. Returns
--    a JSON blob with monthly books, genres, formats, reading time,
--    ratings, status counts, and streaks.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dashboard_stats(
  p_year int DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::int
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_streaks   jsonb;
  v_monthly   jsonb;
  v_genres    jsonb;
  v_formats   jsonb;
  v_statuses  jsonb;
  v_pages     int;
  v_avg_rat   numeric;
  v_time_mo   int;
  v_time_wk   int;
  v_year_start date := make_date(p_year, 1, 1);
  v_year_end   date := make_date(p_year, 12, 31);
  v_month_start date := date_trunc('month', CURRENT_DATE)::date;
  v_week_start  date := date_trunc('week', CURRENT_DATE)::date;
BEGIN
  -- Streaks
  v_streaks := public.compute_reading_streaks();

  -- Monthly finished-book counts for the year
  SELECT COALESCE(jsonb_agg(jsonb_build_object('month', m, 'count', cnt) ORDER BY m), '[]'::jsonb)
  INTO v_monthly
  FROM (
    SELECT to_char(finished_at, 'YYYY-MM') AS m, COUNT(*)::int AS cnt
    FROM public.user_books
    WHERE user_id = v_uid
      AND status = 'finished'
      AND finished_at BETWEEN v_year_start AND v_year_end
    GROUP BY m
  ) sq;

  -- Genre breakdown (first genre per book, top 8)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('genre', g, 'count', cnt) ORDER BY cnt DESC), '[]'::jsonb)
  INTO v_genres
  FROM (
    SELECT b.genres[1] AS g, COUNT(*)::int AS cnt
    FROM public.user_books ub
    JOIN public.books b ON b.id = ub.book_id
    WHERE ub.user_id = v_uid
      AND ub.status = 'finished'
      AND ub.finished_at BETWEEN v_year_start AND v_year_end
      AND array_length(b.genres, 1) > 0
    GROUP BY g
    ORDER BY cnt DESC
    LIMIT 8
  ) sq;

  -- Format split: count audiobooks vs epubs via library_server_books or device source
  SELECT COALESCE(jsonb_object_agg(fmt, cnt), '{}'::jsonb)
  INTO v_formats
  FROM (
    SELECT
      CASE
        WHEN lsb.media_type = 'audiobook' THEN 'audiobook'
        ELSE 'epub'
      END AS fmt,
      COUNT(*)::int AS cnt
    FROM public.user_books ub
    LEFT JOIN public.library_server_books lsb ON lsb.book_id = ub.book_id
    WHERE ub.user_id = v_uid
      AND ub.status = 'finished'
      AND ub.finished_at BETWEEN v_year_start AND v_year_end
    GROUP BY fmt
  ) sq;

  -- Status counts (all time, not year-scoped)
  SELECT COALESCE(jsonb_object_agg(status::text, cnt), '{}'::jsonb)
  INTO v_statuses
  FROM (
    SELECT status, COUNT(*)::int AS cnt
    FROM public.user_books
    WHERE user_id = v_uid
    GROUP BY status
  ) sq;

  -- Total pages read this year
  SELECT COALESCE(SUM(b.page_count), 0)::int
  INTO v_pages
  FROM public.user_books ub
  JOIN public.books b ON b.id = ub.book_id
  WHERE ub.user_id = v_uid
    AND ub.status = 'finished'
    AND ub.finished_at BETWEEN v_year_start AND v_year_end
    AND b.page_count IS NOT NULL;

  -- Average rating this year
  SELECT ROUND(COALESCE(AVG(rating), 0), 1)
  INTO v_avg_rat
  FROM public.user_books
  WHERE user_id = v_uid
    AND rating IS NOT NULL
    AND finished_at BETWEEN v_year_start AND v_year_end;

  -- Reading time this month (minutes)
  SELECT COALESCE(SUM(duration_minutes), 0)::int
  INTO v_time_mo
  FROM public.reading_sessions
  WHERE user_id = v_uid
    AND (started_at AT TIME ZONE 'UTC')::date >= v_month_start;

  -- Reading time this week (minutes)
  SELECT COALESCE(SUM(duration_minutes), 0)::int
  INTO v_time_wk
  FROM public.reading_sessions
  WHERE user_id = v_uid
    AND (started_at AT TIME ZONE 'UTC')::date >= v_week_start;

  RETURN jsonb_build_object(
    'books_read_this_year', (v_statuses->>'finished')::int,
    'monthly_books',        v_monthly,
    'genre_breakdown',      v_genres,
    'books_by_format',      v_formats,
    'reading_status_counts', v_statuses,
    'total_pages_read',     v_pages,
    'average_rating',       v_avg_rat,
    'reading_time_this_month', v_time_mo,
    'reading_time_this_week',  v_time_wk,
    'day_streak',           (v_streaks->>'current_streak')::int,
    'longest_streak',       (v_streaks->>'longest_streak')::int
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.dashboard_stats(int) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.dashboard_stats(int) FROM public;
