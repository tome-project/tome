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
