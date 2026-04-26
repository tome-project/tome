-- Add an explicit chapter column to reading_progress so the server can
-- tell what chapter a member is on without trying to derive it from the
-- format-specific `position` string. Clients (audio player, reader) send
-- this when they have it. Spoiler protection in club discussions reads
-- this column directly.
ALTER TABLE public.reading_progress
  ADD COLUMN IF NOT EXISTS chapter int;
