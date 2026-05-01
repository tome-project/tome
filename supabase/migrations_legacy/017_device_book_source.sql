-- ============================================================================
-- Add 'device' to book_sources.kind so the client can register books that
-- live on the user's phone (sideloaded via Files / AirDrop / Apple Books).
-- The actual file URI is stored on-device (LocalBookStore on the client);
-- this row exists so the user's shelf, friends' views, and clubs all know
-- "this user has this book on a device."
-- ============================================================================

ALTER TABLE public.book_sources
  DROP CONSTRAINT IF EXISTS book_sources_kind_check;

ALTER TABLE public.book_sources
  ADD CONSTRAINT book_sources_kind_check
  CHECK (kind IN ('upload', 'gutenberg', 'audiobookshelf', 'calibre', 'opds', 'filesystem', 'device'));
