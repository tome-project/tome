-- Native EPUB bookmarks are private, account scoped, and retain deletion
-- tombstones so an offline device cannot resurrect a removed bookmark.
BEGIN;
CREATE TABLE IF NOT EXISTS public.reader_bookmarks (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  book_id uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) <= 512),
  locator text NOT NULL CHECK (length(locator) <= 131072),
  percentage double precision NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS reader_bookmarks_account ON public.reader_bookmarks(user_id);
ALTER TABLE public.reader_bookmarks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reader_bookmarks_own ON public.reader_bookmarks;
CREATE POLICY reader_bookmarks_own ON public.reader_bookmarks FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reader_bookmarks TO authenticated;
REVOKE ALL ON public.reader_bookmarks FROM anon;
CREATE OR REPLACE FUNCTION public.save_reader_bookmark(
  p_id uuid, p_book_id uuid, p_title text, p_locator text,
  p_percentage double precision, p_created_at timestamptz,
  p_updated_at timestamptz, p_deleted boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE saved public.reader_bookmarks%ROWTYPE;
BEGIN
  INSERT INTO public.reader_bookmarks(id,user_id,book_id,title,locator,percentage,created_at,updated_at,deleted)
  VALUES(p_id,auth.uid(),p_book_id,p_title,p_locator,p_percentage,p_created_at,p_updated_at,p_deleted)
  ON CONFLICT(id) DO UPDATE SET title=excluded.title,locator=excluded.locator,
    percentage=excluded.percentage,updated_at=excluded.updated_at,deleted=excluded.deleted
    WHERE reader_bookmarks.updated_at < excluded.updated_at;
  SELECT * INTO saved FROM public.reader_bookmarks WHERE id=p_id AND user_id=auth.uid();
  RETURN to_jsonb(saved);
END; $$;
REVOKE ALL ON FUNCTION public.save_reader_bookmark(uuid,uuid,text,text,double precision,timestamptz,timestamptz,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_reader_bookmark(uuid,uuid,text,text,double precision,timestamptz,timestamptz,boolean) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
