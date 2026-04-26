-- Highlights and bookmarks
CREATE TABLE IF NOT EXISTS public.highlights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  book_id uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  text text NOT NULL,
  note text,
  cfi_range text, -- epub CFI for the highlighted range
  chapter integer,
  color text DEFAULT 'yellow' CHECK (color IN ('yellow', 'blue', 'green', 'pink')),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.highlights ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own highlights" ON public.highlights FOR ALL USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_highlights_user_book ON public.highlights(user_id, book_id);
