BEGIN;
-- A retry for one device must not resend alerts already delivered to others.
ALTER TABLE public.notification_outbox ADD COLUMN delivered_tokens text[] NOT NULL DEFAULT '{}';
NOTIFY pgrst,'reload schema';
COMMIT;
