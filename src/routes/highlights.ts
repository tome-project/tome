import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const highlightsRouter = Router();

// GET /api/v1/books/:bookId/highlights — get highlights for a book
highlightsRouter.get('/api/v1/books/:bookId/highlights', requireAuth, async (req: Request, res: Response) => {
  const { bookId } = req.params;

  const { data, error } = await supabaseAdmin
    .from('highlights')
    .select('*')
    .eq('user_id', req.userId!)
    .eq('book_id', bookId)
    .order('created_at', { ascending: true });

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data);
});

// POST /api/v1/books/:bookId/highlights — add a highlight
highlightsRouter.post('/api/v1/books/:bookId/highlights', requireAuth, async (req: Request, res: Response) => {
  const { bookId } = req.params;
  const { text, note, cfi_range, chapter, color } = req.body;

  if (!text) {
    sendError(res, 'text is required');
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('highlights')
    .insert({
      user_id: req.userId,
      book_id: bookId,
      text,
      note: note || null,
      cfi_range: cfi_range || null,
      chapter: chapter || null,
      color: color || 'yellow',
    })
    .select()
    .single();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data, 201);
});

// DELETE /api/v1/highlights/:id — delete a highlight
highlightsRouter.delete('/api/v1/highlights/:id', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;

  const { error } = await supabaseAdmin
    .from('highlights')
    .delete()
    .eq('id', id)
    .eq('user_id', req.userId!);

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, { message: 'Highlight deleted' });
});

// GET /api/v1/highlights — get all highlights across all books
highlightsRouter.get('/api/v1/highlights', requireAuth, async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('highlights')
    .select(`
      *,
      books:book_id (title, author, cover_url)
    `)
    .eq('user_id', req.userId!)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data);
});
