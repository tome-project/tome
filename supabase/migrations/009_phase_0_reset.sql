-- ============================================================================
-- Phase 0 — Foundation Reset
-- ============================================================================
-- Drops the POC schema and rebuilds around:
--   - universal catalog (books)
--   - user_profiles with @handles + privacy defaults
--   - mutual friendships
--   - user_books (the user ↔ book relationship)
--   - book_sources (minimal; Phase 1 extends with media_servers + sharing)
-- See docs/phase-0-plan.md for rationale.
-- ============================================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Privacy enum (used everywhere)
DROP TYPE IF EXISTS public.privacy CASCADE;
CREATE TYPE public.privacy AS ENUM ('public', 'circle', 'private');

-- ---------------------------------------------------------------------------
-- Drop POC tables (CASCADE handles FKs; tables are empty per plan decision)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user() CASCADE;
DROP FUNCTION IF EXISTS public.is_in_circle(uuid, uuid) CASCADE;

DROP TABLE IF EXISTS public.highlights CASCADE;
DROP TABLE IF EXISTS public.reading_sessions CASCADE;
DROP TABLE IF EXISTS public.discussions CASCADE;
DROP TABLE IF EXISTS public.club_members CASCADE;
DROP TABLE IF EXISTS public.clubs CASCADE;
DROP TABLE IF EXISTS public.progress CASCADE;
DROP TABLE IF EXISTS public.wishlist CASCADE;
DROP TABLE IF EXISTS public.reading_goals CASCADE;
DROP TABLE IF EXISTS public.library_members CASCADE;
DROP TABLE IF EXISTS public.libraries CASCADE;
DROP TABLE IF EXISTS public.books CASCADE;

-- ============================================================================
-- CATALOG (user-agnostic; one row per real-world book)
-- ============================================================================
CREATE TABLE public.books (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  open_library_id text UNIQUE,                     -- e.g. 'OL1234W'
  isbn_13         text,
  isbn_10         text,
  google_books_id text,
  title           text NOT NULL,
  subtitle        text,
  authors         text[] NOT NULL DEFAULT '{}',
  cover_url       text,
  description     text,
  publisher       text,
  published_year  int,
  page_count      int,
  genres          text[] NOT NULL DEFAULT '{}',
  language        text NOT NULL DEFAULT 'en',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_books_ol_id ON public.books (open_library_id);
CREATE INDEX idx_books_isbn13 ON public.books (isbn_13);
CREATE INDEX idx_books_isbn10 ON public.books (isbn_10);
CREATE INDEX idx_books_title ON public.books USING gin (title gin_trgm_ops);
-- Full-text search over authors/description added in a later phase
-- (requires IMMUTABLE wrapper or generated column; not needed for Phase 0).

ALTER TABLE public.books ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users read catalog" ON public.books
  FOR SELECT TO authenticated USING (true);
-- writes restricted to service role (catalog import via /api/v1/catalog/import)

-- ============================================================================
-- USER PROFILES (1:1 with auth.users, auto-created via trigger)
-- ============================================================================
CREATE TABLE public.user_profiles (
  user_id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  handle             citext UNIQUE NOT NULL,
  display_name       text NOT NULL,
  bio                text,
  avatar_url         text,
  handle_claimed     boolean NOT NULL DEFAULT false,
  library_privacy    public.privacy NOT NULL DEFAULT 'public',
  activity_privacy   public.privacy NOT NULL DEFAULT 'circle',
  review_privacy     public.privacy NOT NULL DEFAULT 'public',
  highlight_privacy  public.privacy NOT NULL DEFAULT 'circle',
  note_privacy       public.privacy NOT NULL DEFAULT 'private',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT handle_format CHECK (handle ~ '^[a-z0-9_]{3,20}$')
);

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone authenticated reads profiles" ON public.user_profiles
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "User inserts own profile" ON public.user_profiles
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "User updates own profile" ON public.user_profiles
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Auto-create a placeholder profile when a new auth.users row is inserted.
-- The user claims a real @handle on first login (handle_claimed = false).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  placeholder citext;
  suffix      int := 0;
BEGIN
  placeholder := ('user_' || substring(NEW.id::text, 1, 8))::citext;
  WHILE EXISTS (SELECT 1 FROM public.user_profiles WHERE handle = placeholder) LOOP
    suffix := suffix + 1;
    placeholder := ('user_' || substring(NEW.id::text, 1, 8) || '_' || suffix::text)::citext;
  END LOOP;

  INSERT INTO public.user_profiles (user_id, handle, display_name, handle_claimed)
  VALUES (
    NEW.id,
    placeholder,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)),
    false
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================================
-- FRIENDSHIPS (mutual; one row per pair, user_a_id < user_b_id)
-- ============================================================================
CREATE TABLE public.friendships (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user_b_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status        text NOT NULL CHECK (status IN ('pending', 'accepted', 'blocked')),
  requested_by  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  accepted_at   timestamptz,
  UNIQUE (user_a_id, user_b_id),
  CONSTRAINT ordered_pair CHECK (user_a_id < user_b_id),
  CONSTRAINT requester_in_pair CHECK (requested_by IN (user_a_id, user_b_id))
);
CREATE INDEX idx_friendships_user_a ON public.friendships (user_a_id);
CREATE INDEX idx_friendships_user_b ON public.friendships (user_b_id);

ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own friendships" ON public.friendships
  FOR SELECT TO authenticated USING (auth.uid() IN (user_a_id, user_b_id));
CREATE POLICY "Users request friendships" ON public.friendships
  FOR INSERT TO authenticated WITH CHECK (
    auth.uid() = requested_by AND auth.uid() IN (user_a_id, user_b_id)
  );
CREATE POLICY "Users update own friendships" ON public.friendships
  FOR UPDATE TO authenticated USING (auth.uid() IN (user_a_id, user_b_id));
CREATE POLICY "Users delete own friendships" ON public.friendships
  FOR DELETE TO authenticated USING (auth.uid() IN (user_a_id, user_b_id));

-- Helper function used by RLS policies across the schema
CREATE OR REPLACE FUNCTION public.is_in_circle(a uuid, b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.friendships
    WHERE status = 'accepted'
      AND user_a_id = LEAST(a, b)
      AND user_b_id = GREATEST(a, b)
  );
$$;

-- ============================================================================
-- USER ↔ BOOK (a row per book the user has on any shelf)
-- ============================================================================
CREATE TABLE public.user_books (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  book_id         uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  status          text NOT NULL CHECK (status IN ('want', 'reading', 'finished', 'dnf')),
  rating          int CHECK (rating BETWEEN 1 AND 5),
  review          text,
  review_privacy  public.privacy,                  -- null = inherit profile default
  favorite_quote  text,
  started_at      date,
  finished_at     date,
  privacy         public.privacy NOT NULL DEFAULT 'public',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, book_id)
);
CREATE INDEX idx_user_books_user_status ON public.user_books (user_id, status);
CREATE INDEX idx_user_books_book ON public.user_books (book_id);

ALTER TABLE public.user_books ENABLE ROW LEVEL SECURITY;
CREATE POLICY "User sees own user_books" ON public.user_books
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "User sees public user_books" ON public.user_books
  FOR SELECT TO authenticated USING (privacy = 'public');
CREATE POLICY "User sees circle user_books" ON public.user_books
  FOR SELECT TO authenticated USING (
    privacy = 'circle' AND public.is_in_circle(auth.uid(), user_id)
  );
CREATE POLICY "User manages own user_books" ON public.user_books
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- BOOK SOURCES (minimal v1; Phase 1 adds media_servers + sharing grid)
-- ============================================================================
CREATE TABLE public.book_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id       uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  owner_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('upload', 'gutenberg', 'audiobookshelf', 'calibre', 'opds')),
  media_type    text NOT NULL CHECK (media_type IN ('epub', 'audiobook')),
  file_path     text,
  external_id   text,
  external_url  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (book_id, owner_id, kind)
);
CREATE INDEX idx_book_sources_book ON public.book_sources (book_id);
CREATE INDEX idx_book_sources_owner ON public.book_sources (owner_id);

ALTER TABLE public.book_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owner sees own sources" ON public.book_sources
  FOR SELECT TO authenticated USING (owner_id = auth.uid());
CREATE POLICY "Circle sees sources" ON public.book_sources
  FOR SELECT TO authenticated USING (public.is_in_circle(auth.uid(), owner_id));
CREATE POLICY "Owner manages own sources" ON public.book_sources
  FOR ALL TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

-- ============================================================================
-- READING PROGRESS (position only; status lives on user_books)
-- ============================================================================
CREATE TABLE public.reading_progress (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  book_id      uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  position     text NOT NULL DEFAULT '0',
  percentage   numeric NOT NULL DEFAULT 0 CHECK (percentage >= 0 AND percentage <= 100),
  source_kind  text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, book_id)
);
CREATE INDEX idx_reading_progress_user ON public.reading_progress (user_id);

ALTER TABLE public.reading_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY "User manages own progress" ON public.reading_progress
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- READING SESSIONS
-- ============================================================================
CREATE TABLE public.reading_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  book_id           uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  duration_minutes  int,
  pages_read        int,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_reading_sessions_user ON public.reading_sessions (user_id);
CREATE INDEX idx_reading_sessions_book ON public.reading_sessions (book_id);

ALTER TABLE public.reading_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "User manages own sessions" ON public.reading_sessions
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- READING GOALS
-- ============================================================================
CREATE TABLE public.reading_goals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('books', 'pages', 'minutes')),
  target      int NOT NULL,
  year        int NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, type, year)
);

ALTER TABLE public.reading_goals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "User manages own goals" ON public.reading_goals
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- HIGHLIGHTS (with privacy tier)
-- ============================================================================
CREATE TABLE public.highlights (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  book_id     uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  text        text NOT NULL,
  note        text,
  cfi_range   text,
  chapter     int,
  color       text NOT NULL DEFAULT 'yellow' CHECK (color IN ('yellow', 'blue', 'green', 'pink')),
  privacy     public.privacy NOT NULL DEFAULT 'circle',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_highlights_user_book ON public.highlights (user_id, book_id);

ALTER TABLE public.highlights ENABLE ROW LEVEL SECURITY;
CREATE POLICY "User sees own highlights" ON public.highlights
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "User sees public highlights" ON public.highlights
  FOR SELECT TO authenticated USING (privacy = 'public');
CREATE POLICY "User sees circle highlights" ON public.highlights
  FOR SELECT TO authenticated USING (
    privacy = 'circle' AND public.is_in_circle(auth.uid(), user_id)
  );
CREATE POLICY "User manages own highlights" ON public.highlights
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- CLUBS (now bound to the catalog books table)
-- ============================================================================
CREATE TABLE public.clubs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  book_id      uuid NOT NULL REFERENCES public.books(id),
  host_id      uuid NOT NULL REFERENCES auth.users(id),
  invite_code  text NOT NULL UNIQUE,
  start_date   timestamptz NOT NULL DEFAULT now(),
  end_date     timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_clubs_invite_code ON public.clubs (invite_code);
CREATE INDEX idx_clubs_host ON public.clubs (host_id);

ALTER TABLE public.clubs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can view clubs" ON public.clubs
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users create clubs" ON public.clubs
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = host_id);
CREATE POLICY "Host updates club" ON public.clubs
  FOR UPDATE TO authenticated USING (host_id = auth.uid());
CREATE POLICY "Host deletes club" ON public.clubs
  FOR DELETE TO authenticated USING (host_id = auth.uid());

CREATE TABLE public.club_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id    uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'member' CHECK (role IN ('host', 'moderator', 'member')),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (club_id, user_id)
);
CREATE INDEX idx_club_members_club ON public.club_members (club_id);
CREATE INDEX idx_club_members_user ON public.club_members (user_id);

ALTER TABLE public.club_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated see club rosters" ON public.club_members
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users join clubs" ON public.club_members
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users leave clubs" ON public.club_members
  FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE TABLE public.discussions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id     uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  chapter     int NOT NULL,
  content     text NOT NULL,
  parent_id   uuid REFERENCES public.discussions(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_discussions_club ON public.discussions (club_id);
CREATE INDEX idx_discussions_parent ON public.discussions (parent_id);

ALTER TABLE public.discussions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated view discussions" ON public.discussions
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Members post discussions" ON public.discussions
  FOR INSERT TO authenticated WITH CHECK (
    user_id = auth.uid()
    AND club_id IN (SELECT club_id FROM public.club_members WHERE user_id = auth.uid())
  );
CREATE POLICY "Author updates own discussion" ON public.discussions
  FOR UPDATE TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Author deletes own discussion" ON public.discussions
  FOR DELETE TO authenticated USING (user_id = auth.uid());
