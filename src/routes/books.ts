import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
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
