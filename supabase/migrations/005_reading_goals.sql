CREATE TABLE IF NOT EXISTS public.reading_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('books', 'pages', 'minutes')),
  target integer NOT NULL,
  year integer NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, type, year)
);
ALTER TABLE public.reading_goals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own goals" ON public.reading_goals FOR ALL USING (auth.uid() = user_id);
