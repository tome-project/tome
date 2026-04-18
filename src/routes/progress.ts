import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const progressRouter = Router();

// POST /api/v1/progress — save position/percentage for a book the user is reading.
// Body: { book_id, position, percentage, source_kind? }
//
// Status / rating / review now live on /api/v1/user-books. This route is
// strictly for streaming position updates from the reader.
//
// When percentage hits 100, auto-mark the corresponding user_book as 'finished'
// (if one exists). We don't auto-create the user_book — adding a book to the
// library is a deliberate action and goes through POST /api/v1/user-books.
progressRouter.post('/api/v1/progress', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const { book_id, position, percentage, source_kind } = req.body ?? {};

  if (!book_id || position === undefined || percentage === undefined) {
    sendError(res, 'book_id, position, and percentage are required');
    return;
  }
  const pct = Number(percentage);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    sendError(res, 'percentage must be between 0 and 100');
    return;
  }

  const upsertData: Record<string, unknown> = {
    user_id: me,
    book_id,
    position: String(position),
    percentage: pct,
    updated_at: new Date().toISOString(),
  };
  if (source_kind !== undefined) upsertData.source_kind = source_kind === null ? null : String(source_kind);

  const { data, error } = await supabaseAdmin
    .from('reading_progress')
    .upsert(upsertData, { onConflict: 'user_id,book_id' })
    .select()
    .single();
  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  // Bridge to user_books.
  //  - On first progress > 0, transition 'want' → 'reading' so the book
  //    shows up in the dashboard's currently-reading carousel.
  //  - On completion, auto-finish.
  // Both are best-effort; ignore errors so a user_books miss never breaks
  // the primary progress write.
  if (pct > 0 && pct < 100) {
    await supabaseAdmin
      .from('user_books')
      .update({
        status: 'reading',
        started_at: new Date().toISOString().slice(0, 10),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', me)
      .eq('book_id', book_id)
      .eq('status', 'want');
  }

  if (pct >= 100) {
    const today = new Date().toISOString().slice(0, 10);
    await supabaseAdmin
      .from('user_books')
      .update({
        status: 'finished',
        finished_at: today,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', me)
      .eq('book_id', book_id)
      .neq('status', 'finished');
  }

  sendSuccess(res, data);
});

// GET /api/v1/progress/:bookId — current reading position for a book
progressRouter.get('/api/v1/progress/:bookId', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const bookId = String(req.params.bookId);

  const { data, error } = await supabaseAdmin
    .from('reading_progress')
    .select('*')
    .eq('user_id', me)
    .eq('book_id', bookId)
    .maybeSingle();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data ?? { book_id: bookId, position: '0', percentage: 0 });
});
