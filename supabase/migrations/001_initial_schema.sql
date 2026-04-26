-- Tome initial schema
-- Run this in your Supabase SQL Editor to set up all tables

-- Books table
create table if not exists public.books (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  author text not null,
  cover_url text,
  file_path text not null,
  type text not null check (type in ('epub', 'audiobook')),
  added_by uuid references auth.users(id),
  created_at timestamptz default now()
);

-- Reading progress
create table if not exists public.progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  position text not null default '0',
  percentage numeric not null default 0 check (percentage >= 0 and percentage <= 100),
  updated_at timestamptz default now(),
  unique(user_id, book_id)
);

-- Clubs
create table if not exists public.clubs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  book_id uuid not null references public.books(id),
  host_id uuid not null references auth.users(id),
  invite_code text not null unique,
  start_date timestamptz default now(),
  end_date timestamptz,
  created_at timestamptz default now()
);

-- Club members
create table if not exists public.club_members (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz default now(),
  unique(club_id, user_id)
);

-- Discussions
create table if not exists public.discussions (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  chapter integer not null,
  content text not null,
  created_at timestamptz default now()
);

-- Indexes
create index if not exists idx_books_added_by on public.books(added_by);
create index if not exists idx_progress_user_book on public.progress(user_id, book_id);
create index if not exists idx_clubs_invite_code on public.clubs(invite_code);
create index if not exists idx_club_members_club on public.club_members(club_id);
create index if not exists idx_club_members_user on public.club_members(user_id);
create index if not exists idx_discussions_club on public.discussions(club_id);

-- Enable RLS on all tables
alter table public.books enable row level security;
alter table public.progress enable row level security;
alter table public.clubs enable row level security;
alter table public.club_members enable row level security;
alter table public.discussions enable row level security;

-- RLS Policies

-- Books: anyone authenticated can read, only the person who added can delete
create policy "Anyone can view books" on public.books for select using (true);
create policy "Authenticated users can add books" on public.books for insert with check (auth.uid() = added_by);
create policy "Book adder can delete" on public.books for delete using (auth.uid() = added_by);

-- Progress: users can only read/write their own progress
create policy "Users see own progress" on public.progress for select using (auth.uid() = user_id);
create policy "Users write own progress" on public.progress for insert with check (auth.uid() = user_id);
create policy "Users update own progress" on public.progress for update using (auth.uid() = user_id);

-- Clubs: anyone can view (for invite links), authenticated can create
create policy "Anyone can view clubs" on public.clubs for select using (true);
create policy "Authenticated users can create clubs" on public.clubs for insert with check (auth.uid() = host_id);

-- Club members: members can view their club's members, authenticated can join
create policy "Club members can view members" on public.club_members for select using (true);
create policy "Users can join clubs" on public.club_members for insert with check (auth.uid() = user_id);

-- Discussions: club members can view and create discussions
create policy "Anyone can view discussions" on public.discussions for select using (true);
create policy "Users can create discussions" on public.discussions for insert with check (auth.uid() = user_id);
