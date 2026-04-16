import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const userBooksRouter = Router();

type Status = 'want' | 'reading' | 'finished' | 'dnf';
type Privacy = 'public' | 'circle' | 'private';

const STATUSES: Status[] = ['want', 'reading', 'finished', 'dnf'];
const PRIVACIES: Privacy[] = ['public', 'circle', 'private'];

function isStatus(v: unknown): v is Status {
  return typeof v === 'string' && (STATUSES as string[]).includes(v);
}
function isPrivacy(v: unknown): v is Privacy {
  return typeof v === 'string' && (PRIVACIES as string[]).includes(v);
}

// The hydrated row shape the client consumes — user_book joined with the catalog book.
const SELECT_WITH_BOOK = '*, book:books(*)';

// GET /api/v1/user-books?status=reading
// List of the current user's library, optionally filtered by status.
userBooksRouter.get('/api/v1/user-books', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  if (status && !isStatus(status)) {
    sendError(res, 'Invalid status filter');
    return;
  }

  let query = supabaseAdmin
    .from('user_books')
    .select(SELECT_WITH_BOOK)
    .eq('user_id', me)
    .order('updated_at', { ascending: false });

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) {
    sendError(res, error.message, 500);
    return;
  }
  sendSuccess(res, { items: data ?? [] });
});

// GET /api/v1/user-books/:id
userBooksRouter.get('/api/v1/user-books/:id', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const id = String(req.params.id);

  const { data, error } = await supabaseAdmin
    .from('user_books')
    .select(SELECT_WITH_BOOK)
    .eq('id', id)
    .eq('user_id', me)
    .maybeSingle();
  if (error) {
    sendError(res, error.message, 500);
    return;
  }
  if (!data) {
    sendError(res, 'Not found', 404);
    return;
  }
  sendSuccess(res, data);
});

// POST /api/v1/user-books — add a book to my library
// Body: { book_id, status, rating?, review?, privacy?, started_at?, finished_at? }
userBooksRouter.post('/api/v1/user-books', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const body = req.body ?? {};

  if (!body.book_id || typeof body.book_id !== 'string') {
    sendError(res, 'book_id is required');
    return;
  }
  if (!isStatus(body.status)) {
    sendError(res, `status must be one of: ${STATUSES.join(', ')}`);
    return;
  }

  const insert: Record<string, unknown> = {
    user_id: me,
    book_id: body.book_id,
    status: body.status,
  };

  if (body.rating !== undefined) {
    const r = Number(body.rating);
    if (!Number.isInteger(r) || r < 1 || r > 5) {
      sendError(res, 'rating must be an integer 1–5');
      return;
    }
    insert.rating = r;
  }
  if (body.review !== undefined) insert.review = body.review === null ? null : String(body.review);
  if (body.favorite_quote !== undefined) insert.favorite_quote = body.favorite_quote === null ? null : String(body.favorite_quote);
  if (body.started_at !== undefined) insert.started_at = body.started_at;
  if (body.finished_at !== undefined) insert.finished_at = body.finished_at;
  if (body.privacy !== undefined) {
    if (!isPrivacy(body.privacy)) {
      sendError(res, `privacy must be one of: ${PRIVACIES.join(', ')}`);
      return;
    }
    insert.privacy = body.privacy;
  }
  if (body.review_privacy !== undefined) {
    if (body.review_privacy !== null && !isPrivacy(body.review_privacy)) {
      sendError(res, `review_privacy must be one of: ${PRIVACIES.join(', ')}`);
      return;
    }
    insert.review_privacy = body.review_privacy;
  }

  // Catalog existence check for a friendlier error than RLS
  const { data: catalogBook, error: catalogErr } = await supabaseAdmin
    .from('books')
    .select('id')
    .eq('id', body.book_id)
    .maybeSingle();
  if (catalogErr) {
    sendError(res, catalogErr.message, 500);
    return;
  }
  if (!catalogBook) {
    sendError(res, 'book_id not in catalog — import it first via /api/v1/catalog/import', 404);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('user_books')
    .upsert(insert, { onConflict: 'user_id,book_id' })
    .select(SELECT_WITH_BOOK)
    .single();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }
  sendSuccess(res, data, 201);
});

// PATCH /api/v1/user-books/:id
userBooksRouter.patch('/api/v1/user-books/:id', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const id = String(req.params.id);
  const body = req.body ?? {};

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (body.status !== undefined) {
    if (!isStatus(body.status)) {
      sendError(res, `status must be one of: ${STATUSES.join(', ')}`);
      return;
    }
    updates.status = body.status;
    if (body.status === 'finished' && body.finished_at === undefined) {
      updates.finished_at = new Date().toISOString().slice(0, 10);
    }
    if (body.status === 'reading' && body.started_at === undefined) {
      updates.started_at = new Date().toISOString().slice(0, 10);
    }
  }
  if (body.rating !== undefined) {
    if (body.rating === null) {
      updates.rating = null;
    } else {
      const r = Number(body.rating);
      if (!Number.isInteger(r) || r < 1 || r > 5) {
        sendError(res, 'rating must be an integer 1–5 or null');
        return;
      }
      updates.rating = r;
    }
  }
  if (body.review !== undefined) updates.review = body.review === null ? null : String(body.review);
  if (body.favorite_quote !== undefined) updates.favorite_quote = body.favorite_quote === null ? null : String(body.favorite_quote);
  if (body.started_at !== undefined) updates.started_at = body.started_at;
  if (body.finished_at !== undefined) updates.finished_at = body.finished_at;
  if (body.privacy !== undefined) {
    if (!isPrivacy(body.privacy)) {
      sendError(res, `privacy must be one of: ${PRIVACIES.join(', ')}`);
      return;
    }
    updates.privacy = body.privacy;
  }
  if (body.review_privacy !== undefined) {
    if (body.review_privacy !== null && !isPrivacy(body.review_privacy)) {
      sendError(res, `review_privacy must be one of: ${PRIVACIES.join(', ')}`);
      return;
    }
    updates.review_privacy = body.review_privacy;
  }

  if (Object.keys(updates).length === 1) {
    sendError(res, 'No fields to update');
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('user_books')
    .update(updates)
    .eq('id', id)
    .eq('user_id', me)
    .select(SELECT_WITH_BOOK)
    .maybeSingle();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }
  if (!data) {
    sendError(res, 'Not found', 404);
    return;
  }
  sendSuccess(res, data);
});

// DELETE /api/v1/user-books/:id
userBooksRouter.delete('/api/v1/user-books/:id', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const id = String(req.params.id);

  const { error, count } = await supabaseAdmin
    .from('user_books')
    .delete({ count: 'exact' })
    .eq('id', id)
    .eq('user_id', me);

  if (error) {
    sendError(res, error.message, 500);
    return;
  }
  if (!count) {
    sendError(res, 'Not found', 404);
    return;
  }
  sendSuccess(res, { id });
});
