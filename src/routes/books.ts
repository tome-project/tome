import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { decryptToken } from '../services/crypto';
import { AudiobookshelfService } from '../services/audiobookshelf';
import { sendSuccess, sendError } from '../utils';

export const booksRouter = Router();

// GET /api/v1/books/:id — hydrated book detail for the reading-UI
// Returns: { book, user_book | null, sources: [...] }
// The book is the catalog row. user_book is the caller's relationship row
// (status/rating/review) if present. sources are the book_source rows the
// caller can read from (their own, plus circle-shared ones per RLS).
booksRouter.get('/api/v1/books/:id', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const id = String(req.params.id);

  const { data: book, error: bookErr } = await supabaseAdmin
    .from('books')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (bookErr) {
    sendError(res, bookErr.message, 500);
    return;
  }
  if (!book) {
    sendError(res, 'Book not found', 404);
    return;
  }

  const [{ data: userBook }, { data: sources }] = await Promise.all([
    supabaseAdmin
      .from('user_books')
      .select('*')
      .eq('user_id', me)
      .eq('book_id', id)
      .maybeSingle(),
    supabaseAdmin
      .from('book_sources')
      .select('*')
      .eq('book_id', id),
  ]);

  sendSuccess(res, {
    book,
    user_book: userBook ?? null,
    sources: sources ?? [],
  });
});

// GET /api/v1/books/:id/community
// Returns user_books rows for a book from other users, respecting visibility:
//   public rows from anyone; circle rows only from friends; rating-only
//   entries (no review) included — the client uses them for social signal.
// Excludes the caller so this screen never shows your own review alongside
// others'.
booksRouter.get('/api/v1/books/:id/community', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const id = String(req.params.id);

  const { data: rows, error } = await supabaseAdmin
    .from('user_books')
    .select('user_id, status, rating, review, review_privacy, privacy, finished_at')
    .eq('book_id', id)
    .neq('user_id', me);
  if (error) {
    sendError(res, error.message, 500);
    return;
  }
  if (!rows || rows.length === 0) {
    sendSuccess(res, { items: [] });
    return;
  }

  const otherIds = [...new Set(rows.map((r) => r.user_id as string))];

  // Find which of these are in my circle.
  const { data: friendships } = await supabaseAdmin
    .from('friendships')
    .select('user_a_id, user_b_id, status')
    .eq('status', 'accepted')
    .or(`user_a_id.eq.${me},user_b_id.eq.${me}`);
  const inCircle = new Set<string>();
  for (const f of friendships ?? []) {
    const a = f.user_a_id as string;
    const b = f.user_b_id as string;
    inCircle.add(a === me ? b : a);
  }

  const visible = rows.filter((r) => {
    const p = r.privacy as string;
    if (p === 'public') return true;
    if (p === 'circle') return inCircle.has(r.user_id as string);
    return false; // 'private'
  });

  if (visible.length === 0) {
    sendSuccess(res, { items: [] });
    return;
  }

  const visibleIds = [...new Set(visible.map((r) => r.user_id as string))];
  const { data: profiles } = await supabaseAdmin
    .from('user_profiles')
    .select('user_id, handle, display_name, avatar_url')
    .in('user_id', visibleIds);
  const profilesById = new Map<string, Record<string, unknown>>();
  for (const p of profiles ?? []) profilesById.set(p.user_id as string, p as Record<string, unknown>);

  const items = visible.map((r) => ({
    user_id: r.user_id,
    status: r.status,
    rating: r.rating,
    review: r.review,
    finished_at: r.finished_at,
    in_circle: inCircle.has(r.user_id as string),
    profile: profilesById.get(r.user_id as string) ?? null,
  }));

  sendSuccess(res, { items });
});

// GET /api/v1/books/:id/chapters — audiobook chapter list, sourced from
// whichever Audiobookshelf server holds a source the caller can read.
// Returns {chapters: [{index, start_ms, end_ms, title}]}. Empty array is
// a valid response — not every file has chapter metadata.
booksRouter.get('/api/v1/books/:id/chapters', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const bookId = String(req.params.id);

  // Same "prefer own, else any accessible row" policy as the file streamer;
  // RLS already filters book_sources to readable rows.
  const { data: sources, error } = await supabaseAdmin
    .from('book_sources')
    .select('*')
    .eq('book_id', bookId);
  if (error) {
    sendError(res, error.message, 500);
    return;
  }
  const audiobookshelfSources = (sources ?? []).filter((s: { kind: string }) => s.kind === 'audiobookshelf');
  if (audiobookshelfSources.length === 0) {
    sendSuccess(res, { chapters: [] });
    return;
  }
  const source = (audiobookshelfSources.find((s: { owner_id: string }) => s.owner_id === me) ??
    audiobookshelfSources[0]) as {
    external_id: string | null;
    media_server_id: string | null;
  };
  if (!source.media_server_id || !source.external_id) {
    sendSuccess(res, { chapters: [] });
    return;
  }

  const { data: server } = await supabaseAdmin
    .from('media_servers')
    .select('url, token_encrypted')
    .eq('id', source.media_server_id)
    .maybeSingle();
  if (!server) {
    sendSuccess(res, { chapters: [] });
    return;
  }

  let token: string;
  try {
    token = decryptToken(server.token_encrypted as string);
  } catch {
    sendSuccess(res, { chapters: [] });
    return;
  }

  const abs = new AudiobookshelfService(server.url as string, token);
  const item = await abs.getItemDetail(source.external_id);
  const raw = item?.media.chapters ?? [];
  // Normalize to ms and stable indices so the client doesn't have to care
  // about the ABS shape.
  const chapters = raw.map((c, i) => ({
    index: i,
    start_ms: Math.round(c.start * 1000),
    end_ms: Math.round(c.end * 1000),
    title: c.title,
  }));
  sendSuccess(res, { chapters });
});
