import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const progressRouter = Router();

// POST /api/v1/progress — save reading progress
progressRouter.post('/api/v1/progress', requireAuth, async (req: Request, res: Response) => {
  const { book_id, position, percentage, status, start_date, finish_date, rating, review, favorite_quote } = req.body;

  if (!book_id || position === undefined || percentage === undefined) {
    sendError(res, 'book_id, position, and percentage are required');
    return;
  }

  if (percentage < 0 || percentage > 100) {
    sendError(res, 'percentage must be between 0 and 100');
    return;
  }

  if (rating !== undefined && (rating < 1 || rating > 5)) {
    sendError(res, 'rating must be between 1 and 5');
    return;
  }

  const validStatuses = ['want_to_read', 'reading', 'finished', 'dnf'];
  if (status !== undefined && !validStatuses.includes(status)) {
    sendError(res, `status must be one of: ${validStatuses.join(', ')}`);
    return;
  }

  const upsertData: Record<string, unknown> = {
    user_id: req.userId,
    book_id,
    position: String(position),
    percentage,
    updated_at: new Date().toISOString(),
  };

  if (status !== undefined) upsertData.status = status;
  if (start_date !== undefined) upsertData.start_date = start_date;
  if (finish_date !== undefined) upsertData.finish_date = finish_date;
  if (rating !== undefined) upsertData.rating = rating;
  if (review !== undefined) upsertData.review = review;
  if (favorite_quote !== undefined) upsertData.favorite_quote = favorite_quote;

  // Upsert — update if progress already exists for this user+book
  const { data, error } = await supabaseAdmin
    .from('progress')
    .upsert(upsertData, { onConflict: 'user_id,book_id' })
    .select()
    .single();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data);
});

// GET /api/v1/progress/:bookId — get progress for a book
progressRouter.get('/api/v1/progress/:bookId', requireAuth, async (req: Request, res: Response) => {
  const { bookId } = req.params;

  const { data, error } = await supabaseAdmin
    .from('progress')
    .select('*')
    .eq('user_id', req.userId!)
    .eq('book_id', bookId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      // No progress yet — return zero state
      sendSuccess(res, { book_id: bookId, position: '0', percentage: 0 });
      return;
    }
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data);
});
