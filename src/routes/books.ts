import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const booksRouter = Router();

// GET /api/v1/books/:id — get book detail
booksRouter.get('/api/v1/books/:id', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;

  const { data, error } = await supabaseAdmin
    .from('books')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      sendError(res, 'Book not found', 404);
      return;
    }
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data);
});
