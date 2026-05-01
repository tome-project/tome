-- Libraries: multi-library support with sharing
-- Each user gets a personal library on registration.
-- Users can create additional libraries and invite others.

CREATE TABLE IF NOT EXISTS public.libraries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  invite_code text UNIQUE,
  is_public boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- Library members: tracks who has access to which libraries
CREATE TABLE IF NOT EXISTS public.library_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES public.libraries(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at timestamptz DEFAULT now(),
  UNIQUE(library_id, user_id)
);

-- Add library_id to books (nullable for migration — we'll backfill)
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS library_id uuid REFERENCES public.libraries(id) ON DELETE CASCADE;

-- Add external source tracking to books (for ABS sync, Gutenberg, etc.)
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS external_source text CHECK (external_source IN ('audiobookshelf', 'gutenberg', 'upload', 'scan'));

-- Indexes
CREATE INDEX IF NOT EXISTS idx_libraries_owner ON public.libraries(owner_id);
CREATE INDEX IF NOT EXISTS idx_libraries_invite_code ON public.libraries(invite_code);
CREATE INDEX IF NOT EXISTS idx_library_members_library ON public.library_members(library_id);
CREATE INDEX IF NOT EXISTS idx_library_members_user ON public.library_members(user_id);
CREATE INDEX IF NOT EXISTS idx_books_library ON public.books(library_id);
CREATE INDEX IF NOT EXISTS idx_books_external ON public.books(external_source, external_id);

-- RLS
ALTER TABLE public.libraries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.library_members ENABLE ROW LEVEL SECURITY;

-- Libraries: viewable if public, owned by user, or user is a member
CREATE POLICY "Users can view accessible libraries" ON public.libraries FOR SELECT USING (
  is_public = true
  OR owner_id = auth.uid()
  OR id IN (SELECT library_id FROM public.library_members WHERE user_id = auth.uid())
);

CREATE POLICY "Users can create libraries" ON public.libraries FOR INSERT WITH CHECK (
  auth.uid() = owner_id
);

CREATE POLICY "Owners can update libraries" ON public.libraries FOR UPDATE USING (
  auth.uid() = owner_id
);

CREATE POLICY "Owners can delete libraries" ON public.libraries FOR DELETE USING (
  auth.uid() = owner_id
);

-- Library members: visible to other members of the same library
CREATE POLICY "Members can view library members" ON public.library_members FOR SELECT USING (
  library_id IN (SELECT library_id FROM public.library_members WHERE user_id = auth.uid())
  OR library_id IN (SELECT id FROM public.libraries WHERE owner_id = auth.uid())
);

CREATE POLICY "Users can join libraries" ON public.library_members FOR INSERT WITH CHECK (
  auth.uid() = user_id
);

CREATE POLICY "Owners can manage members" ON public.library_members FOR DELETE USING (
  library_id IN (SELECT id FROM public.libraries WHERE owner_id = auth.uid())
  OR auth.uid() = user_id
);

-- Update books policy: users can see books in libraries they have access to,
-- plus any book they added themselves (backwards compat for books without library_id)
DROP POLICY IF EXISTS "Anyone can view books" ON public.books;
CREATE POLICY "Users can view accessible books" ON public.books FOR SELECT USING (
  -- Books in libraries the user can access
  library_id IN (
    SELECT id FROM public.libraries WHERE owner_id = auth.uid() OR is_public = true
    UNION
    SELECT library_id FROM public.library_members WHERE user_id = auth.uid()
  )
  -- Or books with no library (legacy / personal uploads)
  OR library_id IS NULL
);

-- Update books insert policy to allow adding to owned libraries
DROP POLICY IF EXISTS "Authenticated users can add books" ON public.books;
CREATE POLICY "Users can add books to their libraries" ON public.books FOR INSERT WITH CHECK (
  auth.uid() = added_by
  AND (
    library_id IS NULL
    OR library_id IN (SELECT id FROM public.libraries WHERE owner_id = auth.uid())
  )
);

-- Update books update policy
CREATE POLICY "Library owners can update books" ON public.books FOR UPDATE USING (
  auth.uid() = added_by
  OR library_id IN (SELECT id FROM public.libraries WHERE owner_id = auth.uid())
);
