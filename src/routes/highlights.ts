import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { selectMany, insertOne, deleteWhere } from '../services/db';
import { sendSuccess, sendError } from '../utils';

export const highlightsRouter = Router();

// GET /api/v1/books/:bookId/highlights — get highlights for a book
highlightsRouter.get('/api/v1/books/:bookId/highlights', requireAuth, async (req: Request, res: Response) => {
  const { bookId } = req.params;
  try {
    const data = await selectMany(
      'SELECT * FROM highlights WHERE user_id = $1 AND book_id = $2 ORDER BY created_at ASC',
      [req.userId!, bookId]
    );
    sendSuccess(res, data);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});

// POST /api/v1/books/:bookId/highlights — add a highlight
highlightsRouter.post('/api/v1/books/:bookId/highlights', requireAuth, async (req: Request, res: Response) => {
  const { bookId } = req.params;
  const { text, note, cfi_range, chapter, color } = req.body;
  if (!text) {
    sendError(res, 'text is required');
    return;
  }
  try {
    const data = await insertOne('highlights', {
      user_id: req.userId,
      book_id: bookId,
      text,
      note: note || null,
      cfi_range: cfi_range || null,
      chapter: chapter || null,
      color: color || 'yellow',
    });
    sendSuccess(res, data, 201);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Insert failed', 500);
  }
});

// DELETE /api/v1/highlights/:id — delete a highlight
highlightsRouter.delete('/api/v1/highlights/:id', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await deleteWhere('highlights', { id, user_id: req.userId! });
    sendSuccess(res, { message: 'Highlight deleted' });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Delete failed', 500);
  }
});

// GET /api/v1/highlights — all highlights across all books, joined with book metadata
highlightsRouter.get('/api/v1/highlights', requireAuth, async (req: Request, res: Response) => {
  try {
    const data = await selectMany(
      `SELECT h.*, jsonb_build_object('title', b.title, 'authors', b.authors, 'cover_url', b.cover_url) AS books
       FROM highlights h
       LEFT JOIN books b ON b.id = h.book_id
       WHERE h.user_id = $1
       ORDER BY h.created_at DESC
       LIMIT 100`,
      [req.userId!]
    );
    sendSuccess(res, data);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});
