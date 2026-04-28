import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { selectMany, insertOne, deleteWhere } from '../services/db';
import { sendSuccess, sendError } from '../utils';

export const audioBookmarksRouter = Router();

// GET /api/v1/books/:bookId/audio-bookmarks — list a user's audio bookmarks
// for a single book, sorted by position. Position-sorted (rather than
// created_at) so the slider overlay and the bookmark sheet both read in
// timeline order naturally.
audioBookmarksRouter.get(
  '/api/v1/books/:bookId/audio-bookmarks',
  requireAuth,
  async (req: Request, res: Response) => {
    const { bookId } = req.params;
    try {
      const data = await selectMany(
        `SELECT id, book_id, position_ms, chapter, note, created_at
           FROM audio_bookmarks
          WHERE user_id = $1 AND book_id = $2
          ORDER BY position_ms ASC`,
        [req.userId!, bookId]
      );
      console.log('[bookmarks GET] user=%s book=%s rows=%d ua=%s', req.userId, bookId, (data as unknown[]).length, req.headers['user-agent']);
      sendSuccess(res, data);
    } catch (err) {
      sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
    }
  }
);

// POST /api/v1/books/:bookId/audio-bookmarks — save a bookmark at the given
// position. Note is optional ("a thought to come back to") and clamped to a
// short single-line length so it doesn't grow into a journal feature.
audioBookmarksRouter.post(
  '/api/v1/books/:bookId/audio-bookmarks',
  requireAuth,
  async (req: Request, res: Response) => {
    const { bookId } = req.params;
    const { position_ms, chapter, note } = req.body ?? {};
    if (typeof position_ms !== 'number' || position_ms < 0) {
      sendError(res, 'position_ms (non-negative integer) is required');
      return;
    }
    try {
      const data = await insertOne('audio_bookmarks', {
        user_id: req.userId,
        book_id: bookId,
        position_ms: Math.round(position_ms),
        chapter: typeof chapter === 'number' ? chapter : null,
        note: typeof note === 'string' && note.trim().length > 0
          ? note.trim().slice(0, 240)
          : null,
      });
      sendSuccess(res, data, 201);
    } catch (err) {
      sendError(res, err instanceof Error ? err.message : 'Insert failed', 500);
    }
  }
);

// DELETE /api/v1/audio-bookmarks/:id — remove a bookmark.
audioBookmarksRouter.delete(
  '/api/v1/audio-bookmarks/:id',
  requireAuth,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      await deleteWhere('audio_bookmarks', { id, user_id: req.userId! });
      sendSuccess(res, { message: 'Bookmark deleted' });
    } catch (err) {
      sendError(res, err instanceof Error ? err.message : 'Delete failed', 500);
    }
  }
);
