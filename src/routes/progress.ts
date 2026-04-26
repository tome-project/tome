import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { selectOne, upsertOne, query } from '../services/db';
import { sendSuccess, sendError } from '../utils';

export const progressRouter = Router();

// POST /api/v1/progress — save position/percentage for a book.
// Body: { book_id, position, percentage, source_kind? }
//
// Status / rating / review live on /api/v1/user-books. This route is just
// streaming position updates from the reader. When percentage hits 100,
// auto-mark the corresponding user_book as 'finished' if one exists; on
// first progress > 0, transition 'want' → 'reading'. Both are best-effort.
progressRouter.post('/api/v1/progress', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const { book_id, position, percentage, source_kind, chapter } = req.body ?? {};

  if (!book_id || position === undefined || percentage === undefined) {
    sendError(res, 'book_id, position, and percentage are required');
    return;
  }
  const pct = Number(percentage);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    sendError(res, 'percentage must be between 0 and 100');
    return;
  }

  const upsertRecord: Record<string, unknown> = {
    user_id: me,
    book_id,
    position: String(position),
    percentage: pct,
    updated_at: new Date().toISOString(),
  };
  if (source_kind !== undefined) {
    upsertRecord.source_kind = source_kind === null ? null : String(source_kind);
  }
  if (chapter !== undefined) {
    if (chapter === null) {
      upsertRecord.chapter = null;
    } else {
      const ch = Number(chapter);
      if (Number.isFinite(ch) && ch >= 1) upsertRecord.chapter = Math.floor(ch);
    }
  }

  try {
    const data = await upsertOne('reading_progress', upsertRecord, {
      onConflict: 'user_id,book_id',
    });

    // Bridge to user_books — ignore errors so a miss never breaks the
    // primary progress write.
    const today = new Date().toISOString().slice(0, 10);
    if (pct > 0 && pct < 100) {
      await query(
        `UPDATE user_books
            SET status = 'reading', started_at = $1, updated_at = now()
          WHERE user_id = $2 AND book_id = $3 AND status = 'want'`,
        [today, me, book_id]
      );
    }
    if (pct >= 100) {
      await query(
        `UPDATE user_books
            SET status = 'finished', finished_at = $1, updated_at = now()
          WHERE user_id = $2 AND book_id = $3 AND status <> 'finished'`,
        [today, me, book_id]
      );
    }

    sendSuccess(res, data);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});

// GET /api/v1/progress/:bookId — current reading position
progressRouter.get('/api/v1/progress/:bookId', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const bookId = String(req.params.bookId);
  try {
    const data = await selectOne(
      'SELECT * FROM reading_progress WHERE user_id = $1 AND book_id = $2',
      [me, bookId]
    );
    sendSuccess(res, data ?? { book_id: bookId, position: '0', percentage: 0 });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});
