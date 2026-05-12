-- Migration 013: add community + reading tables to the supabase_realtime
-- publication so the Flutter client's `supabase.channel(...)` subscriptions
-- actually receive change events.
--
-- Without this the publication is empty by default and any
-- `.onPostgresChanges(...)` listener silently gets nothing. The pace bar's
-- realtime tween, the live-reading-ring presence updates, and the activity
-- feed's auto-refresh all depend on this. We learned about it the hard
-- way — every Realtime call was a no-op until we discovered the
-- publication didn't include any of our tables.

ALTER PUBLICATION supabase_realtime ADD TABLE
  public.club_quotes,
  public.discussions,
  public.club_members,
  public.club_picks,
  public.reading_progress,
  public.reading_sessions,
  public.reactions;
