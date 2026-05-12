-- Migration 012: community primitives for clubs.
--
-- Three new tables that turn a club from "shared book" into "shared
-- reading experience":
--
--   reactions          — polymorphic emoji reactions on anything in a
--                        club (discussions, quotes, audio comments).
--   club_quotes        — passages from an EPUB shared to the club.
--                        Anchored to a chapter; carries the highlight
--                        text + cfi range + an optional caption note.
--   club_audio_comments — timestamp-anchored comments on the audiobook
--                        the club is reading.

CREATE TABLE IF NOT EXISTS public.reactions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_type text NOT NULL
                CHECK (target_type IN (
                  'discussion','club_quote','club_audio_comment'
                )),
  target_id   uuid NOT NULL,
  emoji       text NOT NULL
                CHECK (emoji IN ('🔥','😂','🤯','📖','❤️','👍')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, target_type, target_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_reactions_target
  ON public.reactions (target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_reactions_user
  ON public.reactions (user_id);

ALTER TABLE public.reactions ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.club_quotes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id     uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  book_id     uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  text        text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
  note        text CHECK (note IS NULL OR char_length(note) <= 500),
  cfi_range   text,
  chapter     integer,
  color       text NOT NULL DEFAULT 'yellow'
                CHECK (color IN ('yellow','blue','green','pink')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_club_quotes_club_recent
  ON public.club_quotes (club_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_club_quotes_book
  ON public.club_quotes (book_id);

ALTER TABLE public.club_quotes ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.club_audio_comments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id          uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  book_id          uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  position_seconds numeric NOT NULL CHECK (position_seconds >= 0),
  content          text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 1000),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_club_audio_comments_club_recent
  ON public.club_audio_comments (club_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_club_audio_comments_book_pos
  ON public.club_audio_comments (book_id, position_seconds);

ALTER TABLE public.club_audio_comments ENABLE ROW LEVEL SECURITY;

-- RLS policies for reactions: anyone who can see the target row can
-- see + add reactions to it. Polymorphic predicate joins through the
-- target table to club_members.
DROP POLICY IF EXISTS "reactions — readable by target club members"
  ON public.reactions;
CREATE POLICY "reactions — readable by target club members"
  ON public.reactions FOR SELECT TO authenticated
  USING (
    (target_type = 'discussion' AND EXISTS (
      SELECT 1 FROM public.discussions d
      JOIN public.club_members cm ON cm.club_id = d.club_id
      WHERE d.id = reactions.target_id AND cm.user_id = auth.uid()
    ))
    OR (target_type = 'club_quote' AND EXISTS (
      SELECT 1 FROM public.club_quotes q
      JOIN public.club_members cm ON cm.club_id = q.club_id
      WHERE q.id = reactions.target_id AND cm.user_id = auth.uid()
    ))
    OR (target_type = 'club_audio_comment' AND EXISTS (
      SELECT 1 FROM public.club_audio_comments c
      JOIN public.club_members cm ON cm.club_id = c.club_id
      WHERE c.id = reactions.target_id AND cm.user_id = auth.uid()
    ))
  );

DROP POLICY IF EXISTS "reactions — react as self" ON public.reactions;
CREATE POLICY "reactions — react as self"
  ON public.reactions FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid() AND (
      (target_type = 'discussion' AND EXISTS (
        SELECT 1 FROM public.discussions d
        JOIN public.club_members cm ON cm.club_id = d.club_id
        WHERE d.id = reactions.target_id AND cm.user_id = auth.uid()
      ))
      OR (target_type = 'club_quote' AND EXISTS (
        SELECT 1 FROM public.club_quotes q
        JOIN public.club_members cm ON cm.club_id = q.club_id
        WHERE q.id = reactions.target_id AND cm.user_id = auth.uid()
      ))
      OR (target_type = 'club_audio_comment' AND EXISTS (
        SELECT 1 FROM public.club_audio_comments c
        JOIN public.club_members cm ON cm.club_id = c.club_id
        WHERE c.id = reactions.target_id AND cm.user_id = auth.uid()
      ))
    )
  );

DROP POLICY IF EXISTS "reactions — un-react" ON public.reactions;
CREATE POLICY "reactions — un-react"
  ON public.reactions FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- club_quotes policies
DROP POLICY IF EXISTS "club_quotes — members read" ON public.club_quotes;
CREATE POLICY "club_quotes — members read"
  ON public.club_quotes FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.club_members cm
      WHERE cm.club_id = club_quotes.club_id AND cm.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "club_quotes — members post own" ON public.club_quotes;
CREATE POLICY "club_quotes — members post own"
  ON public.club_quotes FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.club_members cm
      WHERE cm.club_id = club_quotes.club_id AND cm.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "club_quotes — authors delete own" ON public.club_quotes;
CREATE POLICY "club_quotes — authors delete own"
  ON public.club_quotes FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- club_audio_comments policies
DROP POLICY IF EXISTS "club_audio_comments — members read"
  ON public.club_audio_comments;
CREATE POLICY "club_audio_comments — members read"
  ON public.club_audio_comments FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.club_members cm
      WHERE cm.club_id = club_audio_comments.club_id
        AND cm.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "club_audio_comments — members post own"
  ON public.club_audio_comments;
CREATE POLICY "club_audio_comments — members post own"
  ON public.club_audio_comments FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.club_members cm
      WHERE cm.club_id = club_audio_comments.club_id
        AND cm.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "club_audio_comments — authors delete own"
  ON public.club_audio_comments;
CREATE POLICY "club_audio_comments — authors delete own"
  ON public.club_audio_comments FOR DELETE TO authenticated
  USING (user_id = auth.uid());
