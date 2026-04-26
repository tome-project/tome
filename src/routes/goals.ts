import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { selectMany, upsertOne } from '../services/db';
import { sendSuccess, sendError } from '../utils';

export const goalsRouter = Router();

// POST /api/v1/goals — set reading goal (upsert per user+type+year)
goalsRouter.post('/api/v1/goals', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { type, target, year } = req.body;

  if (!type || !target || !year) {
    sendError(res, 'type, target, and year are required', 400);
    return;
  }
  if (!['books', 'pages', 'minutes'].includes(type)) {
    sendError(res, 'type must be books, pages, or minutes', 400);
    return;
  }
  if (typeof target !== 'number' || target < 1) {
    sendError(res, 'target must be a positive number', 400);
    return;
  }

  try {
    const data = await upsertOne(
      'reading_goals',
      { user_id: userId, type, target, year },
      { onConflict: 'user_id,type,year' }
    );
    sendSuccess(res, data);
  } catch {
    sendError(res, 'Failed to set goal', 500);
  }
});

// GET /api/v1/goals — current-year goals + computed progress
goalsRouter.get('/api/v1/goals', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const year = new Date().getFullYear();
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  try {
    const goals = await selectMany<{ id: string; type: string; target: number; year: number }>(
      'SELECT * FROM reading_goals WHERE user_id = $1 AND year = $2',
      [userId, year]
    );
    if (goals.length === 0) {
      sendSuccess(res, []);
      return;
    }
    const goalTypes = new Set(goals.map((g) => g.type));

    let booksFinished = 0;
    let pagesRead = 0;
    let minutesRead = 0;

    if (goalTypes.has('books') || goalTypes.has('pages')) {
      const finishedRows = await selectMany<{ book_id: string }>(
        `SELECT book_id FROM user_books
          WHERE user_id = $1 AND status = 'finished'
            AND finished_at >= $2 AND finished_at <= $3`,
        [userId, yearStart, yearEnd]
      );
      booksFinished = finishedRows.length;

      if (goalTypes.has('pages') && finishedRows.length > 0) {
        const bookIds = finishedRows.map((r) => r.book_id);
        const books = await selectMany<{ page_count: number | null }>(
          'SELECT page_count FROM books WHERE id = ANY($1) AND page_count IS NOT NULL',
          [bookIds]
        );
        pagesRead = books.reduce((sum, b) => sum + (b.page_count ?? 0), 0);
      }
    }

    if (goalTypes.has('minutes')) {
      const sessions = await selectMany<{ duration_minutes: number | null }>(
        `SELECT duration_minutes FROM reading_sessions
          WHERE user_id = $1 AND duration_minutes IS NOT NULL
            AND started_at >= $2 AND started_at <= $3`,
        [userId, `${yearStart}T00:00:00Z`, `${yearEnd}T23:59:59Z`]
      );
      minutesRead = sessions.reduce((sum, s) => sum + (s.duration_minutes ?? 0), 0);
    }

    const progressMap: Record<string, number> = {
      books: booksFinished,
      pages: pagesRead,
      minutes: minutesRead,
    };

    const result = goals.map((g) => ({
      id: g.id,
      type: g.type,
      target: g.target,
      year: g.year,
      current: progressMap[g.type] ?? 0,
    }));

    sendSuccess(res, result);
  } catch {
    sendError(res, 'Failed to fetch goals', 500);
  }
});
