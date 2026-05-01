-- ============================================================================
-- Tome — Supabase-as-hub initial schema (Plex-of-books rewrite)
-- ============================================================================
-- Architecture (see /docs/architecture.md):
--   - Supabase is the identity + social hub. Auth, friendships, clubs,
--     reading log, reviews, tracker shelves, the universal book catalog —
--     all live here. The Flutter app talks directly to Supabase via
--     supabase_flutter; RLS is the security perimeter.
--   - Library servers are optional, federated. A user runs the
--     `tome-library-server` Node service on their own hardware. It
--     registers with this Supabase project (one row in library_servers),
--     scans a directory of books, and streams files via HTTP range
--     requests. The owner can grant access to friends. The hub knows
--     *which* books exist on *which* servers; files never move to the hub.
--   - Cold installer (no library server, no friends) gets a working
--     tracker + Gutenberg + sideload-from-device experience. Library
--     server is a power-user upgrade.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
CREATE TYPE public.privacy AS ENUM ('public', 'circle', 'private');
CREATE TYPE public.shelf_status AS ENUM ('want', 'reading', 'finished', 'dnf');
CREATE TYPE public.book_source AS ENUM ('library_server', 'device', 'gutenberg');
CREATE TYPE public.media_type AS ENUM ('epub', 'audiobook');
CREATE TYPE public.friendship_status AS ENUM ('pending', 'accepted', 'blocked');
CREATE TYPE public.club_role AS ENUM ('host', 'moderator', 'member');
CREATE TYPE public.grant_role AS ENUM ('read', 'admin');

-- ============================================================================
-- USER PROFILES (1:1 with auth.users via trigger)
-- ============================================================================
CREATE TABLE public.user_profiles (
  user_id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  handle             citext UNIQUE NOT NULL,
  display_name       text NOT NULL,
  bio                text,
  avatar_url         text,
  invite_code        text UNIQUE NOT NULL DEFAULT upper(substring(replace(uuid_generate_v4()::text, '-', ''), 1, 8)),
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
CREATE INDEX idx_user_profiles_invite_code ON public.user_profiles (invite_code);

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles readable by all authed" ON public.user_profiles
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "profile self-insert" ON public.user_profiles
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "profile self-update" ON public.user_profiles
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
  status        public.friendship_status NOT NULL,
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
CREATE POLICY "friendships visible to participants" ON public.friendships
  FOR SELECT TO authenticated USING (auth.uid() IN (user_a_id, user_b_id));
CREATE POLICY "friendships requested by self" ON public.friendships
  FOR INSERT TO authenticated WITH CHECK (
    auth.uid() = requested_by AND auth.uid() IN (user_a_id, user_b_id)
  );
CREATE POLICY "friendships managed by participants" ON public.friendships
  FOR UPDATE TO authenticated USING (auth.uid() IN (user_a_id, user_b_id));
CREATE POLICY "friendships removable by participants" ON public.friendships
  FOR DELETE TO authenticated USING (auth.uid() IN (user_a_id, user_b_id));

-- Helper used by other RLS policies — "is `b` in my (`a`'s) accepted circle?"
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
-- BOOKS (universal catalog; one row per real-world book)
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

ALTER TABLE public.books ENABLE ROW LEVEL SECURITY;
CREATE POLICY "catalog readable by all authed" ON public.books
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "catalog insertable by authed" ON public.books
  FOR INSERT TO authenticated WITH CHECK (true);
-- Updates restricted to service role (for catalog enrichment); no DELETE.

-- ============================================================================
-- USER ↔ BOOK (per-user shelf)
-- ============================================================================
CREATE TABLE public.user_books (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  book_id         uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  status          public.shelf_status NOT NULL,
  source          public.book_source NOT NULL DEFAULT 'library_server',
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
CREATE POLICY "shelf — own visible" ON public.user_books
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "shelf — public visible" ON public.user_books
  FOR SELECT TO authenticated USING (privacy = 'public');
CREATE POLICY "shelf — circle visible" ON public.user_books
  FOR SELECT TO authenticated USING (
    privacy = 'circle' AND public.is_in_circle(auth.uid(), user_id)
  );
CREATE POLICY "shelf — own manage" ON public.user_books
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- READING PROGRESS (position only; status lives on user_books)
-- ============================================================================
CREATE TABLE public.reading_progress (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  book_id      uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  position     text NOT NULL DEFAULT '0',          -- ms for audio, CFI for epub
  percentage   numeric NOT NULL DEFAULT 0 CHECK (percentage >= 0 AND percentage <= 100),
  chapter      int,                                 -- 1-indexed for multi-track audio
  source_kind  text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, book_id)
);
CREATE INDEX idx_reading_progress_user ON public.reading_progress (user_id);

ALTER TABLE public.reading_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY "progress — own only" ON public.reading_progress
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- READING SESSIONS (intervals — drives streaks + minutes-read goals)
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
CREATE POLICY "sessions — own only" ON public.reading_sessions
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
CREATE POLICY "goals — own only" ON public.reading_goals
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- HIGHLIGHTS (epub-only for now; cfi_range pinpoints location)
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
CREATE POLICY "highlights — own visible" ON public.highlights
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "highlights — public visible" ON public.highlights
  FOR SELECT TO authenticated USING (privacy = 'public');
CREATE POLICY "highlights — circle visible" ON public.highlights
  FOR SELECT TO authenticated USING (
    privacy = 'circle' AND public.is_in_circle(auth.uid(), user_id)
  );
CREATE POLICY "highlights — own manage" ON public.highlights
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- AUDIO BOOKMARKS
-- ============================================================================
CREATE TABLE public.audio_bookmarks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  book_id           uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  position_seconds  numeric NOT NULL,
  label             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audio_bookmarks_user_book ON public.audio_bookmarks (user_id, book_id);

ALTER TABLE public.audio_bookmarks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audio bookmarks — own only" ON public.audio_bookmarks
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- CLUBS (time-boxed group reads)
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
CREATE POLICY "clubs visible to all authed" ON public.clubs
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "clubs created by host-self" ON public.clubs
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = host_id);
CREATE POLICY "clubs managed by host" ON public.clubs
  FOR UPDATE TO authenticated USING (host_id = auth.uid());
CREATE POLICY "clubs deletable by host" ON public.clubs
  FOR DELETE TO authenticated USING (host_id = auth.uid());

CREATE TABLE public.club_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id    uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       public.club_role NOT NULL DEFAULT 'member',
  joined_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (club_id, user_id)
);
CREATE INDEX idx_club_members_club ON public.club_members (club_id);
CREATE INDEX idx_club_members_user ON public.club_members (user_id);

ALTER TABLE public.club_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rosters readable by all authed" ON public.club_members
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "join self only" ON public.club_members
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "leave self only" ON public.club_members
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
CREATE POLICY "discussions visible to all authed" ON public.discussions
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "members post discussions" ON public.discussions
  FOR INSERT TO authenticated WITH CHECK (
    user_id = auth.uid()
    AND club_id IN (SELECT club_id FROM public.club_members WHERE user_id = auth.uid())
  );
CREATE POLICY "author updates own" ON public.discussions
  FOR UPDATE TO authenticated USING (user_id = auth.uid());
CREATE POLICY "author deletes own" ON public.discussions
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- ============================================================================
-- LIBRARY SERVER FEDERATION
-- ============================================================================
-- A library server is a Tome instance running on a user's hardware.
-- It scans a directory for books and streams them via HTTP. The hub
-- (this Supabase project) knows about the server, what books it hosts,
-- and who has access. File bytes never live in Supabase.
-- ============================================================================

CREATE TABLE public.library_servers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name            text NOT NULL,                  -- "Chris's basement NAS"
  url             text NOT NULL,                  -- "http://192.168.86.188:3000" — what the app hits
  public_url      text,                            -- optional: cloudflare tunnel / public hostname
  platform        text,                            -- "linux", "macos", informational
  version         text,                            -- "0.1.0"
  is_active       boolean NOT NULL DEFAULT true,
  registered_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_library_servers_owner ON public.library_servers (owner_id);

ALTER TABLE public.library_servers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "library servers — owner sees own" ON public.library_servers
  FOR SELECT TO authenticated USING (owner_id = auth.uid());
CREATE POLICY "library servers — grantee sees granted" ON public.library_servers
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.library_server_grants g
      WHERE g.server_id = library_servers.id
        AND g.grantee_id = auth.uid()
        AND g.revoked_at IS NULL
    )
  );
CREATE POLICY "library servers — owner manages" ON public.library_servers
  FOR ALL TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
-- INSERT also flows via service role from the server's pairing flow.

-- Pairing codes — ephemeral. App generates on user's behalf, server consumes.
CREATE TABLE public.library_server_pairings (
  code            text PRIMARY KEY CHECK (code ~ '^[0-9]{6}$'),
  claimer_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  consumed_by_server_id uuid REFERENCES public.library_servers(id) ON DELETE SET NULL
);
CREATE INDEX idx_pairings_expires ON public.library_server_pairings (expires_at);

ALTER TABLE public.library_server_pairings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pairings — self insert" ON public.library_server_pairings
  FOR INSERT TO authenticated WITH CHECK (claimer_user_id = auth.uid());
CREATE POLICY "pairings — self select" ON public.library_server_pairings
  FOR SELECT TO authenticated USING (claimer_user_id = auth.uid());
-- Server consumes via service role — no anon SELECT to prevent code-scanning.

-- Auto-expire old pairings (housekeeping helper; called periodically).
CREATE OR REPLACE FUNCTION public.expire_old_pairings()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.library_server_pairings
  WHERE expires_at < now() - interval '1 hour';
$$;

-- Access grants — owner shares a library with friends.
CREATE TABLE public.library_server_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   uuid NOT NULL REFERENCES public.library_servers(id) ON DELETE CASCADE,
  grantee_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_by  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        public.grant_role NOT NULL DEFAULT 'read',
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE UNIQUE INDEX uq_active_grants ON public.library_server_grants (server_id, grantee_id)
  WHERE revoked_at IS NULL;

ALTER TABLE public.library_server_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "grants — owner sees + manages" ON public.library_server_grants
  FOR ALL TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.library_servers s
      WHERE s.id = library_server_grants.server_id AND s.owner_id = auth.uid()
    )
  );
CREATE POLICY "grants — grantee sees own" ON public.library_server_grants
  FOR SELECT TO authenticated USING (grantee_id = auth.uid());

-- What books each library server hosts. Server writes via service role
-- after a scan; readers query via RLS that mirrors library_servers.
CREATE TABLE public.library_server_books (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id        uuid NOT NULL REFERENCES public.library_servers(id) ON DELETE CASCADE,
  book_id          uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  file_path        text NOT NULL,                  -- relative to the server's library dir
  media_type       public.media_type NOT NULL,
  file_size_bytes  bigint,
  tracks           jsonb,                          -- multi-track audiobook chapters
  last_scanned_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (server_id, book_id)
);
CREATE INDEX idx_lib_server_books_server ON public.library_server_books (server_id);
CREATE INDEX idx_lib_server_books_book ON public.library_server_books (book_id);

ALTER TABLE public.library_server_books ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lib books — visible to owner + grantees" ON public.library_server_books
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.library_servers s
      WHERE s.id = library_server_books.server_id
        AND (
          s.owner_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.library_server_grants g
            WHERE g.server_id = s.id AND g.grantee_id = auth.uid() AND g.revoked_at IS NULL
          )
        )
    )
  );
-- Writes happen via service role from the server's scanner.

-- ============================================================================
-- updated_at triggers (for tables where we care about staleness)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
CREATE TRIGGER user_profiles_touch BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER user_books_touch BEFORE UPDATE ON public.user_books
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
