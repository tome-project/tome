-- Additive reliability and authorization upgrade. Apply before app 0.18.
BEGIN;
ALTER TABLE public.library_server_books DROP CONSTRAINT IF EXISTS library_server_books_server_id_book_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS library_server_books_server_book_format_key ON public.library_server_books(server_id,book_id,media_type);

-- Ownership and the bound machine identity are immutable for non-admin callers.
CREATE OR REPLACE FUNCTION public.protect_library_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF auth.role() = 'authenticated' AND
     (NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.service_user_id IS DISTINCT FROM OLD.service_user_id) THEN
    RAISE EXCEPTION 'Library ownership and service identity cannot be reassigned';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_library_identity ON public.library_servers;
CREATE TRIGGER protect_library_identity BEFORE UPDATE ON public.library_servers
FOR EACH ROW EXECUTE FUNCTION public.protect_library_identity();

-- A machine may enrich its own titles, not rewrite global catalog metadata.
CREATE OR REPLACE FUNCTION public.protect_catalog_metadata() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF auth.role()='authenticated' THEN
   IF NOT EXISTS(SELECT 1 FROM public.library_server_books b JOIN public.library_servers s ON s.id=b.server_id
      WHERE b.book_id=OLD.id AND s.service_user_id=auth.uid()) THEN
     RAISE EXCEPTION 'Cannot enrich a title outside your library';
   END IF;
   IF (to_jsonb(NEW) - ARRAY['cover_url','series_name','series_position','series_lookup_attempted_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['cover_url','series_name','series_position','series_lookup_attempted_at']) THEN
     RAISE EXCEPTION 'Only cover and series enrichment is permitted';
   END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_catalog_metadata ON public.books;
CREATE TRIGGER protect_catalog_metadata BEFORE UPDATE ON public.books
FOR EACH ROW EXECUTE FUNCTION public.protect_catalog_metadata();

CREATE OR REPLACE FUNCTION public.is_club_member(p_club uuid,p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT EXISTS(SELECT 1 FROM public.club_members WHERE club_id=p_club AND user_id=p_user)
$$;
DROP POLICY IF EXISTS "discussions visible to all authed" ON public.discussions;
CREATE POLICY "discussions members read" ON public.discussions FOR SELECT TO authenticated
USING(public.is_club_member(club_id,auth.uid()));
DROP POLICY IF EXISTS "rosters readable by all authed" ON public.club_members;
CREATE POLICY "rosters members read" ON public.club_members FOR SELECT TO authenticated
USING(public.is_club_member(club_id,auth.uid()) OR EXISTS(SELECT 1 FROM public.clubs WHERE id=club_id AND host_id=auth.uid()));
DROP POLICY IF EXISTS "clubs visible to all authed" ON public.clubs;
CREATE POLICY "clubs members read" ON public.clubs FOR SELECT TO authenticated
USING(host_id=auth.uid() OR public.is_club_member(id,auth.uid()));
DROP POLICY IF EXISTS "join self only" ON public.club_members;
CREATE POLICY "host joins own club" ON public.club_members FOR INSERT TO authenticated
WITH CHECK(user_id=auth.uid() AND role='host' AND EXISTS(SELECT 1 FROM public.clubs WHERE id=club_id AND host_id=auth.uid()));
CREATE OR REPLACE FUNCTION public.join_club_by_invite(p_code text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_club uuid;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
 SELECT id INTO v_club FROM public.clubs WHERE invite_code=upper(trim(p_code));
 IF v_club IS NULL THEN RAISE EXCEPTION 'Invalid club invite'; END IF;
 INSERT INTO public.club_members(club_id,user_id,role) VALUES(v_club,auth.uid(),'member') ON CONFLICT(club_id,user_id) DO NOTHING;
 RETURN v_club;
END $$;
REVOKE ALL ON FUNCTION public.join_club_by_invite(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.join_club_by_invite(text) TO authenticated;

CREATE TABLE IF NOT EXISTS public.reading_positions(
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 book_id uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
 format text NOT NULL CHECK(format IN('epub','audiobook')),
 position text NOT NULL, chapter int, percentage double precision NOT NULL CHECK(percentage BETWEEN 0 AND 100),
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,book_id,format)
);
ALTER TABLE public.reading_positions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "positions own" ON public.reading_positions;
CREATE POLICY "positions own" ON public.reading_positions FOR ALL TO authenticated
USING(user_id=auth.uid()) WITH CHECK(user_id=auth.uid());
GRANT SELECT,INSERT,UPDATE,DELETE ON public.reading_positions TO authenticated,service_role;
CREATE OR REPLACE FUNCTION public.save_reading_position(p_book_id uuid,p_position text,p_percentage double precision,
 p_chapter int,p_format text,p_updated_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_me uuid:=auth.uid(); v_row public.reading_positions; v_legacy public.reading_progress;
BEGIN
 IF v_me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
 IF p_updated_at > now()+interval '5 minutes' THEN RAISE EXCEPTION 'Invalid progress timestamp'; END IF;
 INSERT INTO public.reading_positions(user_id,book_id,format,position,chapter,percentage,updated_at)
 VALUES(v_me,p_book_id,p_format,p_position,p_chapter,p_percentage,p_updated_at)
 ON CONFLICT(user_id,book_id,format) DO UPDATE SET position=excluded.position,chapter=excluded.chapter,
 percentage=excluded.percentage,updated_at=excluded.updated_at
 WHERE public.reading_positions.updated_at <= excluded.updated_at;
 SELECT * INTO v_row FROM public.reading_positions WHERE user_id=v_me AND book_id=p_book_id AND format=p_format;
 INSERT INTO public.reading_progress(user_id,book_id,position,chapter,percentage,updated_at)
 VALUES(v_me,p_book_id,v_row.position,v_row.chapter,v_row.percentage,v_row.updated_at)
 ON CONFLICT(user_id,book_id) DO UPDATE SET position=excluded.position,chapter=excluded.chapter,
 percentage=excluded.percentage,updated_at=excluded.updated_at
 WHERE public.reading_progress.updated_at <= excluded.updated_at;
 SELECT * INTO v_legacy FROM public.reading_progress WHERE user_id=v_me AND book_id=p_book_id;
 RETURN to_jsonb(v_row);
END $$;
REVOKE ALL ON FUNCTION public.save_reading_position(uuid,text,double precision,int,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_reading_position(uuid,text,double precision,int,text,timestamptz) TO authenticated;

-- Older positions stay readable; new writes have independent format records.
INSERT INTO public.reading_positions(user_id,book_id,format,position,chapter,percentage,updated_at)
 SELECT user_id,book_id,CASE WHEN position ~ '^[0-9]+$' THEN 'audiobook' ELSE 'epub' END,
 position,chapter,percentage,updated_at FROM public.reading_progress
 ON CONFLICT DO NOTHING;

ALTER TABLE public.library_server_pairings ADD COLUMN IF NOT EXISTS claim_token uuid;
ALTER TABLE public.library_server_pairings ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
CREATE OR REPLACE FUNCTION public.claim_pairing_code(p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_row public.library_server_pairings;
BEGIN
 UPDATE public.library_server_pairings SET claim_token=gen_random_uuid(),claimed_at=now()
 WHERE code=p_code AND consumed_at IS NULL AND expires_at>now()
 AND (claimed_at IS NULL OR claimed_at<now()-interval '5 minutes') RETURNING * INTO v_row;
 IF v_row.id IS NULL THEN RAISE EXCEPTION 'Pairing code unavailable or expired'; END IF;
 RETURN to_jsonb(v_row);
END $$;
REVOKE ALL ON FUNCTION public.claim_pairing_code(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pairing_code(text) TO service_role;
-- A request is Ready only when that reader can actually open the requested format.
ALTER TABLE public.book_requests ADD COLUMN IF NOT EXISTS requested_format text
 CHECK(requested_format IN ('epub','audiobook'));
CREATE OR REPLACE FUNCTION public.guard_request_fulfillment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NEW.status='fulfilled' AND OLD.status<>'fulfilled' AND NOT EXISTS(
  SELECT 1 FROM public.library_server_books b JOIN public.library_servers s ON s.id=b.server_id
  WHERE b.server_id=NEW.server_id AND b.book_id=NEW.fulfilled_book_id
  AND (NEW.requested_format IS NULL OR b.media_type=NEW.requested_format)
  AND (s.owner_id=NEW.requester_id OR EXISTS(SELECT 1 FROM public.library_server_grants g
    WHERE g.collection_id=b.collection_id AND g.grantee_id=NEW.requester_id AND g.revoked_at IS NULL))
 ) THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_request_fulfillment ON public.book_requests;
CREATE TRIGGER guard_request_fulfillment BEFORE UPDATE ON public.book_requests
FOR EACH ROW EXECUTE FUNCTION public.guard_request_fulfillment();

NOTIFY pgrst,'reload schema';
COMMIT;
