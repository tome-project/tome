-- ============================================================================
-- Filesystem-backed book sources (native scanner)
-- ============================================================================
-- Adds 'filesystem' to the book_sources.kind CHECK constraint so the native
-- scanner can ingest audiobook/ebook files directly from a configured library
-- root, replacing the dependency on Audiobookshelf.
--
-- Adds last_scanned_at so re-scans can be incremental (only re-parse files
-- whose mtime is newer than the last scan).
-- ============================================================================

ALTER TABLE public.book_sources
  DROP CONSTRAINT IF EXISTS book_sources_kind_check;

ALTER TABLE public.book_sources
  ADD CONSTRAINT book_sources_kind_check
  CHECK (kind IN ('upload', 'gutenberg', 'audiobookshelf', 'calibre', 'opds', 'filesystem'));

ALTER TABLE public.book_sources
  ADD COLUMN IF NOT EXISTS last_scanned_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_book_sources_kind_owner
  ON public.book_sources (kind, owner_id);
