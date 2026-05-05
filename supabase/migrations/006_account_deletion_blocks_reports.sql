-- Migration 006: account deletion + UGC moderation primitives.
--
-- Apple Guideline 5.1.1(v) requires in-app account deletion. Apple
-- Guideline 1.2 (UGC) requires user-blocking + content reporting before
-- the App Store will accept an app with discussions/clubs.
--
-- This migration adds:
--   - public.user_blocks         : (blocker, blocked) edges
--   - public.content_reports     : reports filed by users against users / discussions
--   - public.delete_my_account() : RPC that wipes the caller's data + auth.users row

-- ---------------------------------------------------------------------------
-- user_blocks
-- ---------------------------------------------------------------------------
create table if not exists public.user_blocks (
  blocker_id uuid not null,
  blocked_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create index if not exists user_blocks_blocked_idx on public.user_blocks(blocked_id);

alter table public.user_blocks enable row level security;

-- Users can see + manage their own blocks. They cannot see who has
-- blocked them; that is intentional (Apple's bar is one-way blocking
-- visibility, and exposing it leaks abuse signals).
drop policy if exists user_blocks_self_select on public.user_blocks;
create policy user_blocks_self_select on public.user_blocks
  for select using (auth.uid() = blocker_id);

drop policy if exists user_blocks_self_insert on public.user_blocks;
create policy user_blocks_self_insert on public.user_blocks
  for insert with check (auth.uid() = blocker_id);

drop policy if exists user_blocks_self_delete on public.user_blocks;
create policy user_blocks_self_delete on public.user_blocks
  for delete using (auth.uid() = blocker_id);

grant select, insert, delete on public.user_blocks to authenticated;

-- ---------------------------------------------------------------------------
-- content_reports
-- ---------------------------------------------------------------------------
create table if not exists public.content_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null,
  reported_user_id uuid not null,
  content_type text not null check (content_type in ('user', 'discussion', 'highlight', 'review')),
  content_id uuid,
  reason text not null check (char_length(reason) between 1 and 64),
  details text check (details is null or char_length(details) <= 2000),
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed', 'actioned')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid
);

create index if not exists content_reports_status_idx on public.content_reports(status, created_at desc);
create index if not exists content_reports_reporter_idx on public.content_reports(reporter_id, created_at desc);

alter table public.content_reports enable row level security;

-- Reporters can read + create their own reports. Admin review happens
-- through the service role outside RLS.
drop policy if exists content_reports_self_select on public.content_reports;
create policy content_reports_self_select on public.content_reports
  for select using (auth.uid() = reporter_id);

drop policy if exists content_reports_self_insert on public.content_reports;
create policy content_reports_self_insert on public.content_reports
  for insert with check (auth.uid() = reporter_id);

grant select, insert on public.content_reports to authenticated;

-- ---------------------------------------------------------------------------
-- delete_my_account RPC
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER + owned by postgres so it can reach auth.users.
-- Wipes every table that holds the caller's data, then deletes the
-- auth.users row. Reports filed *against* the user are preserved for
-- moderation history — those rows reference the user by uuid only and
-- become orphaned, which is fine.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  delete from public.audio_bookmarks where user_id = uid;
  delete from public.highlights where user_id = uid;
  delete from public.reading_progress where user_id = uid;
  delete from public.reading_sessions where user_id = uid;
  delete from public.reading_goals where user_id = uid;
  delete from public.user_books where user_id = uid;
  delete from public.discussions where user_id = uid;
  delete from public.club_members where user_id = uid;
  -- Owned clubs disappear; member rows + discussions on those clubs
  -- come along via FK cascades configured in 001.
  delete from public.clubs where host_id = uid;
  delete from public.friendships where user_a_id = uid or user_b_id = uid;
  delete from public.library_server_grants where grantee_id = uid or granted_by = uid;
  delete from public.library_server_pairings where claimer_user_id = uid;
  -- Owned library servers vanish — collections, books, and remaining
  -- grants on them cascade. Files on disk are not touched.
  delete from public.library_servers where owner_id = uid;
  delete from public.user_blocks where blocker_id = uid or blocked_id = uid;
  delete from public.content_reports where reporter_id = uid;
  delete from public.user_profiles where user_id = uid;

  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;
