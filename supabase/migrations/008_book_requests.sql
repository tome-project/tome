-- Migration 008: book_requests + series metadata on books.
--
-- Two related capabilities:
--
-- 1. Series-aware "next up" on the Finished sheet. We cache series_name
--    and series_position on `books` after a one-shot external lookup
--    (Open Library + Google Books), gated by series_lookup_attempted_at
--    so we don't re-hit the network for books we already tried.
--
-- 2. A Jellyseerr-style request queue: a friend (grantee) finishes book
--    N, sees that book N+1 exists in the wider catalog but not on the
--    library they read N on, and pings the owner to add it. Owner sees
--    the queue, drops the file into LIBRARY_PATH, the next scan
--    auto-fulfills the request by matching ISBN / OL / Google id.
--
-- The owner can also self-request (e.g. they finished a book and want
-- the sequel on their own server) — the same row goes into book_requests
-- with requester_id = owner_id, so the queue card serves both audiences.

-- ---------------------------------------------------------------------------
-- books: cached series metadata
-- ---------------------------------------------------------------------------
ALTER TABLE public.books
  ADD COLUMN IF NOT EXISTS series_name text,
  ADD COLUMN IF NOT EXISTS series_position numeric,
  ADD COLUMN IF NOT EXISTS series_lookup_attempted_at timestamptz;

-- numeric (not int) so we can represent novellas at 1.5, 2.5, etc.
-- (Wandering Inn, DCC bonus shorts, Dresden novellas all do this.)

CREATE INDEX IF NOT EXISTS idx_books_series_name_lower
  ON public.books (LOWER(series_name))
  WHERE series_name IS NOT NULL;

-- Allow library-server service users to stamp series metadata on books
-- they don't own (mirrors the existing "books — service stamps covers"
-- policy from migration 007). Narrow to rows where we haven't tried yet,
-- so a self-hosted server can never overwrite series data on a row that
-- was previously populated.
DROP POLICY IF EXISTS "books — service stamps series" ON public.books;
CREATE POLICY "books — service stamps series" ON public.books
  FOR UPDATE TO authenticated
  USING (
    series_lookup_attempted_at IS NULL
    AND EXISTS (SELECT 1 FROM public.library_servers WHERE service_user_id = auth.uid())
  )
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- book_requests: a friend (or owner) asks the library owner to acquire a
-- book. Schema captures the *external* book identity (the requested book
-- is not in our books table at request time — it lands here later, via
-- the next scan).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.book_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id       uuid NOT NULL REFERENCES public.library_servers(id) ON DELETE CASCADE,
  requester_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Snapshot of the requested book's identity at request time.
  title           text NOT NULL,
  authors         text[] NOT NULL DEFAULT '{}',
  isbn_13         text,
  open_library_id text,
  google_books_id text,
  cover_url       text,
  series_name     text,
  series_position numeric,

  -- Why this request exists. source_book_id is the book the user just
  -- finished (when reason = 'next_in_series'); null for manual requests.
  source_book_id  uuid REFERENCES public.books(id) ON DELETE SET NULL,
  reason          text NOT NULL DEFAULT 'manual'
                    CHECK (reason IN ('next_in_series','manual')),
  note            text,

  -- Lifecycle
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','fulfilled','declined','dismissed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  fulfilled_at    timestamptz,
  fulfilled_book_id uuid REFERENCES public.books(id) ON DELETE SET NULL,
  declined_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_book_requests_server_status
  ON public.book_requests (server_id, status);
CREATE INDEX IF NOT EXISTS idx_book_requests_requester
  ON public.book_requests (requester_id);

-- Dedupe pending requests by external identifier. Each identifier is its
-- own partial unique index so any one of them can dedupe on its own; a
-- request with isbn_13 set will block a second pending request with the
-- same isbn_13 even if open_library_id differs.
CREATE UNIQUE INDEX IF NOT EXISTS uq_book_requests_pending_isbn
  ON public.book_requests (server_id, requester_id, isbn_13)
  WHERE status = 'pending' AND isbn_13 IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_book_requests_pending_ol
  ON public.book_requests (server_id, requester_id, open_library_id)
  WHERE status = 'pending' AND open_library_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_book_requests_pending_google
  ON public.book_requests (server_id, requester_id, google_books_id)
  WHERE status = 'pending' AND google_books_id IS NOT NULL;

ALTER TABLE public.book_requests ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- RLS policies
-- ---------------------------------------------------------------------------
-- Read: requester sees their own; owner sees everything on their servers;
-- the library server's service user sees its own server's requests so the
-- scanner can auto-fulfill.

DROP POLICY IF EXISTS "book_requests — requester sees own" ON public.book_requests;
CREATE POLICY "book_requests — requester sees own"
  ON public.book_requests FOR SELECT TO authenticated
  USING (requester_id = auth.uid());

DROP POLICY IF EXISTS "book_requests — owner sees server" ON public.book_requests;
CREATE POLICY "book_requests — owner sees server"
  ON public.book_requests FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.library_servers s
      WHERE s.id = book_requests.server_id AND s.owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "book_requests — service sees server" ON public.book_requests;
CREATE POLICY "book_requests — service sees server"
  ON public.book_requests FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.library_servers s
      WHERE s.id = book_requests.server_id AND s.service_user_id = auth.uid()
    )
  );

-- Insert: the caller must be inserting on their own behalf, AND must
-- have access to the server (either as owner or as an active grantee on
-- any collection of that server).
DROP POLICY IF EXISTS "book_requests — insert with access" ON public.book_requests;
CREATE POLICY "book_requests — insert with access"
  ON public.book_requests FOR INSERT TO authenticated
  WITH CHECK (
    requester_id = auth.uid() AND (
      EXISTS (
        SELECT 1 FROM public.library_servers s
        WHERE s.id = book_requests.server_id AND s.owner_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1
          FROM public.library_server_grants g
          JOIN public.library_collections c ON c.id = g.collection_id
         WHERE c.server_id = book_requests.server_id
           AND g.grantee_id = auth.uid()
           AND g.revoked_at IS NULL
      )
    )
  );

-- Update: the server owner can fulfill / decline anything on their
-- server. The library server's service user can fulfill (the auto-fulfill
-- hook in the scanner runs as the service user).
DROP POLICY IF EXISTS "book_requests — owner updates" ON public.book_requests;
CREATE POLICY "book_requests — owner updates"
  ON public.book_requests FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.library_servers s
      WHERE s.id = book_requests.server_id AND s.owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "book_requests — service updates" ON public.book_requests;
CREATE POLICY "book_requests — service updates"
  ON public.book_requests FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.library_servers s
      WHERE s.id = book_requests.server_id AND s.service_user_id = auth.uid()
    )
  );

-- Delete: requester can withdraw their own request only while it's still
-- pending. Once an owner has acted (fulfilled/declined), the row is the
-- queue's history and stays.
DROP POLICY IF EXISTS "book_requests — requester withdraws" ON public.book_requests;
CREATE POLICY "book_requests — requester withdraws"
  ON public.book_requests FOR DELETE TO authenticated
  USING (requester_id = auth.uid() AND status = 'pending');
