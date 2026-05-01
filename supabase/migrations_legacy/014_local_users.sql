-- ============================================================================
-- Local users table — replaces auth.users as the identity source of truth
-- ============================================================================
-- Tome's auth is moving from Supabase Auth to local bcrypt + JWT. This
-- migration:
--   1. Creates public.users (same id space as auth.users so FKs preserve
--      existing data — every public.users row has the same uuid as the
--      corresponding auth.users row).
--   2. Copies every existing auth.users row into public.users, including
--      the encrypted_password (Supabase uses standard $2a$10$ bcrypt, so
--      bcryptjs.compare() reads it natively — existing users keep their
--      passwords without a reset).
--   3. Repoints every public-schema FK from auth.users → public.users.
--   4. Drops the on_auth_user_created trigger; profile creation moves to
--      the app layer (called from POST /api/v1/auth/register).
--
-- The Supabase auth.* schema (auth.users, auth.sessions, auth.identities,
-- etc.) stays in place — Tome doesn't manage those, and Supabase's own
-- console keeps working. They just stop being our source of truth.
-- ============================================================================

-- 1. Create the local users table. password_hash is nullable to allow
-- magic-link / passwordless flows in the future, but for the standard
-- email+password path it's required at the application layer.
CREATE TABLE IF NOT EXISTS public.users (
  id              uuid PRIMARY KEY,
  email           citext UNIQUE NOT NULL,
  password_hash   text,
  display_name    text,
  email_confirmed boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users (email);

-- 2. Copy existing auth.users into public.users. This is idempotent — if
-- the migration has run before, ON CONFLICT skips dupes.
INSERT INTO public.users (id, email, password_hash, display_name, email_confirmed, created_at, updated_at)
SELECT
  id,
  email::citext,
  encrypted_password,
  COALESCE(raw_user_meta_data->>'display_name', split_part(email, '@', 1)),
  email_confirmed_at IS NOT NULL,
  created_at,
  updated_at
FROM auth.users
WHERE email IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- 3. Repoint every public-schema FK from auth.users(id) → public.users(id).
-- Same column name, same ON DELETE behavior — only the target changes.
-- IDs already exist in public.users (we copied them above), so the new
-- constraint is satisfied without any data movement.

-- book_sources.owner_id
ALTER TABLE public.book_sources DROP CONSTRAINT IF EXISTS book_sources_owner_id_fkey;
ALTER TABLE public.book_sources ADD CONSTRAINT book_sources_owner_id_fkey
  FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- club_members.user_id
ALTER TABLE public.club_members DROP CONSTRAINT IF EXISTS club_members_user_id_fkey;
ALTER TABLE public.club_members ADD CONSTRAINT club_members_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- clubs.host_id (NO cascade — preserve original behavior)
ALTER TABLE public.clubs DROP CONSTRAINT IF EXISTS clubs_host_id_fkey;
ALTER TABLE public.clubs ADD CONSTRAINT clubs_host_id_fkey
  FOREIGN KEY (host_id) REFERENCES public.users(id);

-- discussions.user_id
ALTER TABLE public.discussions DROP CONSTRAINT IF EXISTS discussions_user_id_fkey;
ALTER TABLE public.discussions ADD CONSTRAINT discussions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- friendships (3 columns)
ALTER TABLE public.friendships DROP CONSTRAINT IF EXISTS friendships_user_a_id_fkey;
ALTER TABLE public.friendships ADD CONSTRAINT friendships_user_a_id_fkey
  FOREIGN KEY (user_a_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.friendships DROP CONSTRAINT IF EXISTS friendships_user_b_id_fkey;
ALTER TABLE public.friendships ADD CONSTRAINT friendships_user_b_id_fkey
  FOREIGN KEY (user_b_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.friendships DROP CONSTRAINT IF EXISTS friendships_requested_by_fkey;
ALTER TABLE public.friendships ADD CONSTRAINT friendships_requested_by_fkey
  FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE CASCADE;

-- highlights.user_id
ALTER TABLE public.highlights DROP CONSTRAINT IF EXISTS highlights_user_id_fkey;
ALTER TABLE public.highlights ADD CONSTRAINT highlights_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- media_servers.owner_id
ALTER TABLE public.media_servers DROP CONSTRAINT IF EXISTS media_servers_owner_id_fkey;
ALTER TABLE public.media_servers ADD CONSTRAINT media_servers_owner_id_fkey
  FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- reading_goals.user_id
ALTER TABLE public.reading_goals DROP CONSTRAINT IF EXISTS reading_goals_user_id_fkey;
ALTER TABLE public.reading_goals ADD CONSTRAINT reading_goals_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- reading_progress.user_id
ALTER TABLE public.reading_progress DROP CONSTRAINT IF EXISTS reading_progress_user_id_fkey;
ALTER TABLE public.reading_progress ADD CONSTRAINT reading_progress_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- reading_sessions.user_id
ALTER TABLE public.reading_sessions DROP CONSTRAINT IF EXISTS reading_sessions_user_id_fkey;
ALTER TABLE public.reading_sessions ADD CONSTRAINT reading_sessions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- server_shares.grantee_id
ALTER TABLE public.server_shares DROP CONSTRAINT IF EXISTS server_shares_grantee_id_fkey;
ALTER TABLE public.server_shares ADD CONSTRAINT server_shares_grantee_id_fkey
  FOREIGN KEY (grantee_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- user_books.user_id
ALTER TABLE public.user_books DROP CONSTRAINT IF EXISTS user_books_user_id_fkey;
ALTER TABLE public.user_books ADD CONSTRAINT user_books_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- user_profiles.user_id
ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_user_id_fkey;
ALTER TABLE public.user_profiles ADD CONSTRAINT user_profiles_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- 4. Drop the on_auth_user_created trigger. Profile creation moves to the
-- app layer (POST /api/v1/auth/register inserts into public.users AND
-- public.user_profiles in one transaction).
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();
