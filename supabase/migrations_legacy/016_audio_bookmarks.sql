-- ============================================================================
-- Audio bookmarks — saved listening positions with optional notes
-- ============================================================================
-- Distinct from public.highlights (which is text-range / CFI focused for
-- epubs). Audio bookmarks are a single timestamp into the book — multi-track
-- audiobooks store the chapter index too so resolving is unambiguous when
-- the position is intra-track.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.audio_bookmarks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  book_id     uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  position_ms integer NOT NULL CHECK (position_ms >= 0),
  -- 1-indexed, matches the convention used by reading_progress.chapter.
  -- For multi-track audiobooks position_ms is *intra-track*; pair with this
  -- column to identify the queue item. For single-file books it's optional
  -- metadata.
  chapter     integer,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audio_bookmarks_user_book
  ON public.audio_bookmarks(user_id, book_id, position_ms);

ALTER TABLE public.audio_bookmarks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own audio bookmarks"
  ON public.audio_bookmarks
  FOR ALL
  USING (auth.uid() = user_id);
