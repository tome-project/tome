-- ============================================================================
-- Multi-track mp3 audiobooks
-- ============================================================================
-- For mp3-folder audiobooks (a directory of mp3 files where each file is a
-- chapter), the scanner now emits a single book_sources row whose file_path
-- is the directory and whose `tracks` column holds an ordered manifest:
--
--   [{ "index": 0, "title": "Chapter 1", "file_path": "01.mp3", "duration": 1234.5 }, ...]
--
-- Each track's file_path is RELATIVE to the source's own file_path.
-- Single-file sources (m4b/m4a/single mp3/epub) leave tracks NULL.
-- Streaming endpoint accepts ?track=N to serve the requested chapter.
-- ============================================================================

ALTER TABLE public.book_sources
  ADD COLUMN IF NOT EXISTS tracks jsonb;
