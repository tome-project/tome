BEGIN;
CREATE TABLE public.notification_devices(
 token text PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 platform text NOT NULL CHECK(platform IN('ios','android')), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.notification_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "devices own" ON public.notification_devices FOR ALL TO authenticated USING(user_id=auth.uid()) WITH CHECK(user_id=auth.uid());
GRANT SELECT,DELETE ON public.notification_devices TO authenticated;
GRANT ALL ON public.notification_devices TO service_role;
CREATE OR REPLACE FUNCTION public.register_notification_device(p_token text,p_platform text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF auth.uid() IS NULL OR length(p_token)<20 OR length(p_token)>4096 THEN RAISE EXCEPTION 'Invalid device'; END IF;
 INSERT INTO public.notification_devices(token,user_id,platform) VALUES(p_token,auth.uid(),p_platform)
 ON CONFLICT(token) DO UPDATE SET user_id=excluded.user_id,platform=excluded.platform,updated_at=now();
END $$;
REVOKE ALL ON FUNCTION public.register_notification_device(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_notification_device(text,text) TO authenticated;
CREATE TABLE public.notification_outbox(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 request_id uuid NOT NULL REFERENCES public.book_requests(id) ON DELETE CASCADE,book_id uuid REFERENCES public.books(id),
 title text NOT NULL, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz,
 attempts int NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),UNIQUE(request_id)
);
ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.notification_outbox TO service_role;
CREATE OR REPLACE FUNCTION public.queue_ready_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NEW.status='fulfilled' AND OLD.status<>'fulfilled' THEN
  INSERT INTO public.notification_outbox(user_id,request_id,book_id,title,body)
  VALUES(NEW.requester_id,NEW.id,NEW.fulfilled_book_id,
   CASE WHEN NEW.requested_format='epub' THEN 'Ready to read' ELSE 'Your book is ready' END,NEW.title)
  ON CONFLICT(request_id) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER queue_ready_notification AFTER UPDATE ON public.book_requests FOR EACH ROW EXECUTE FUNCTION public.queue_ready_notification();
NOTIFY pgrst,'reload schema';
COMMIT;
