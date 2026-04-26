-- Add new fields to books table
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS genre text;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS page_count integer;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS publisher text;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS series_name text;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS series_number integer;

-- Reading status & dates on progress table
ALTER TABLE public.progress ADD COLUMN IF NOT EXISTS status text DEFAULT 'want_to_read' CHECK (status IN ('want_to_read', 'reading', 'finished', 'dnf'));
ALTER TABLE public.progress ADD COLUMN IF NOT EXISTS start_date date;
ALTER TABLE public.progress ADD COLUMN IF NOT EXISTS finish_date date;
ALTER TABLE public.progress ADD COLUMN IF NOT EXISTS rating integer CHECK (rating >= 1 AND rating <= 5);
ALTER TABLE public.progress ADD COLUMN IF NOT EXISTS review text;
ALTER TABLE public.progress ADD COLUMN IF NOT EXISTS favorite_quote text;

-- Wishlist / TBR table
CREATE TABLE IF NOT EXISTS public.wishlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  author text NOT NULL,
  cover_url text,
  genre text,
  priority text DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  notes text,
  added_at timestamptz DEFAULT now()
);

ALTER TABLE public.wishlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own wishlist" ON public.wishlist FOR ALL USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_user ON public.wishlist(user_id);
