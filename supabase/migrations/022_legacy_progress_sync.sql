BEGIN;
-- Keep installed older clients interoperable with independent audio/ebook progress.
CREATE OR REPLACE FUNCTION public.mirror_legacy_reading_position() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NEW.updated_at > now()+interval '5 minutes' THEN RETURN NEW; END IF;
 INSERT INTO public.reading_positions(user_id,book_id,format,position,chapter,percentage,updated_at)
 VALUES(NEW.user_id,NEW.book_id,CASE WHEN NEW.position ~ '^[0-9]+$' THEN 'audiobook' ELSE 'epub' END,
        NEW.position,NEW.chapter,NEW.percentage,NEW.updated_at)
 ON CONFLICT(user_id,book_id,format) DO UPDATE SET position=excluded.position,chapter=excluded.chapter,
 percentage=excluded.percentage,updated_at=excluded.updated_at
 WHERE public.reading_positions.updated_at < excluded.updated_at;
 RETURN NEW;
END $$;
CREATE TRIGGER mirror_legacy_reading_position AFTER INSERT OR UPDATE ON public.reading_progress
 FOR EACH ROW EXECUTE FUNCTION public.mirror_legacy_reading_position();
NOTIFY pgrst,'reload schema';
COMMIT;
