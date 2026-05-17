-- Migration 015: club_files — transient host-shared files for book clubs.
--
-- The Morgan flow: Morgan downloads a book to her phone, imports it via
-- Tome's device-import flow (it lives on her device only). She creates a
-- club around that book and invites friends. For her friends to read or
-- listen, *one* file needs to be on a server they can reach — the hub.
--
-- club_files holds the metadata for that upload:
--   - one row per (club_id, book_id): the host's shared file for the club
--   - the bytes live on the hub's disk under LIBRARY_PATH/club-shares/<club_id>/
--   - rows are visible to all club members; mutations are host-only
--   - purge_after = club.end_date + 30d when set; auto-purge job (next
--     migration / cron) will delete the file + flip purged_at
--
-- This is intentionally NOT a permanent library share. The file goes away
-- after the club ends + grace. App Store posture stays defensible: this
-- is "transient private group share for a defined activity," same shape
-- as Slack/WhatsApp file attachments, not "books locker."

CREATE TABLE public.club_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id       uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  book_id       uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  host_user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  media_type    text NOT NULL CHECK (media_type IN ('epub', 'audiobook')),
  file_ext      text NOT NULL,
  file_size     bigint,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  purge_after   timestamptz,
  purged_at     timestamptz,
  UNIQUE (club_id, book_id)
);

CREATE INDEX idx_club_files_club ON public.club_files (club_id);
CREATE INDEX idx_club_files_purge
  ON public.club_files (purge_after)
  WHERE purged_at IS NULL AND purge_after IS NOT NULL;

ALTER TABLE public.club_files ENABLE ROW LEVEL SECURITY;

-- Members of a club can see whether the file has been uploaded yet (drives
-- the "share with club" CTA visibility on the host's side and the "join the
-- listen" affordance on members' sides).
CREATE POLICY "club_files — visible to members"
  ON public.club_files
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.club_members cm
       WHERE cm.club_id = club_files.club_id
         AND cm.user_id = auth.uid()
    )
  );

-- Only the club host inserts/updates: confirms host_user_id matches caller
-- AND the row's club_id is actually a club they host.
CREATE POLICY "club_files — host inserts"
  ON public.club_files
  FOR INSERT TO authenticated
  WITH CHECK (
    host_user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.clubs c
       WHERE c.id = club_files.club_id
         AND c.host_id = auth.uid()
    )
  );

CREATE POLICY "club_files — host updates"
  ON public.club_files
  FOR UPDATE TO authenticated
  USING (host_user_id = auth.uid())
  WITH CHECK (host_user_id = auth.uid());

CREATE POLICY "club_files — host deletes"
  ON public.club_files
  FOR DELETE TO authenticated
  USING (host_user_id = auth.uid());
