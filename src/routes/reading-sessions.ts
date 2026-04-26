import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { selectOne, selectMany, insertOne, query } from '../services/db';
import { sendSuccess, sendError } from '../utils';

export const readingSessionsRouter = Router();

readingSessionsRouter.post('/api/v1/sessions/start', requireAuth, async (req: Request, res: Response) => {
  const { book_id } = req.body;
  const userId = req.userId!;
  if (!book_id) {
    sendError(res, 'book_id is required');
    return;
  }
  try {
    const book = await selectOne<{ id: string }>('SELECT id FROM books WHERE id = $1', [book_id]);
    if (!book) {
      sendError(res, 'Book not found', 404);
      return;
    }
    const data = await insertOne('reading_sessions', {
      user_id: userId,
      book_id,
      started_at: new Date().toISOString(),
    });
    sendSuccess(res, data, 201);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Insert failed', 500);
  }
});

readingSessionsRouter.post('/api/v1/sessions/:id/end', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { pages_read, notes } = req.body;
  const userId = req.userId!;

  try {
    const session = await selectOne<{
      id: string;
      started_at: string;
      ended_at: string | null;
    }>('SELECT * FROM reading_sessions WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!session) {
      sendError(res, 'Session not found', 404);
      return;
    }
    if (session.ended_at) {
      sendError(res, 'Session has already ended');
      return;
    }
    const now = new Date();
    const startedAt = new Date(session.started_at);
    const durationMinutes = Math.round((now.getTime() - startedAt.getTime()) / 60000);

    const fields: string[] = [
      `ended_at = $1`,
      `duration_minutes = $2`,
    ];
    const params: unknown[] = [now.toISOString(), durationMinutes];
    if (pages_read !== undefined) { fields.push(`pages_read = $${params.length + 1}`); params.push(pages_read); }
    if (notes !== undefined) { fields.push(`notes = $${params.length + 1}`); params.push(notes); }
    params.push(id, userId);

    const data = await selectOne(
      `UPDATE reading_sessions SET ${fields.join(', ')}
        WHERE id = $${params.length - 1} AND user_id = $${params.length}
       RETURNING *`,
      params
    );
    sendSuccess(res, data);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Update failed', 500);
  }
});

readingSessionsRouter.get('/api/v1/sessions', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  try {
    const sessions = await selectMany<{
      id: string;
      book_id: string;
      started_at: string;
      ended_at: string | null;
      duration_minutes: number | null;
    }>(
      `SELECT * FROM reading_sessions
        WHERE user_id = $1 AND started_at >= $2
        ORDER BY started_at DESC`,
      [userId, thirtyDaysAgo.toISOString()]
    );
    if (sessions.length === 0) {
      sendSuccess(res, []);
      return;
    }
    const bookIds = [...new Set(sessions.map((s) => s.book_id))];
    const books = await selectMany<{ id: string; title: string; authors: string[] }>(
      `SELECT id, title, authors FROM books WHERE id = ANY($1)`,
      [bookIds]
    );
    const booksMap = new Map(books.map((b) => [b.id, b]));
    const enriched = sessions.map((s) => {
      const book = booksMap.get(s.book_id);
      return {
        ...s,
        book_title: book?.title ?? null,
        book_author: book?.authors?.[0] ?? null,
      };
    });
    sendSuccess(res, enriched);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});

readingSessionsRouter.get('/api/v1/sessions/stats', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  try {
    const now = new Date();
    const startOfWeek = new Date(now);
    const day = startOfWeek.getDay();
    const diff = day === 0 ? 6 : day - 1;
    startOfWeek.setDate(startOfWeek.getDate() - diff);
    startOfWeek.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const sessions = await selectMany<{ duration_minutes: number; started_at: string }>(
      `SELECT duration_minutes, started_at FROM reading_sessions
        WHERE user_id = $1 AND duration_minutes IS NOT NULL AND started_at >= $2`,
      [userId, startOfMonth.toISOString()]
    );

    let totalMinutesThisWeek = 0;
    let totalMinutesThisMonth = 0;
    let sessionsThisWeek = 0;
    let longestSessionMinutes = 0;
    const allDurations: number[] = [];

    for (const s of sessions) {
      const duration = s.duration_minutes;
      const sessionDate = new Date(s.started_at);
      totalMinutesThisMonth += duration;
      allDurations.push(duration);
      if (duration > longestSessionMinutes) longestSessionMinutes = duration;
      if (sessionDate >= startOfWeek) {
        totalMinutesThisWeek += duration;
        sessionsThisWeek++;
      }
    }

    const averageSessionMinutes = allDurations.length > 0
      ? Math.round(allDurations.reduce((a, b) => a + b, 0) / allDurations.length)
      : 0;

    sendSuccess(res, {
      total_minutes_this_week: totalMinutesThisWeek,
      total_minutes_this_month: totalMinutesThisMonth,
      average_session_minutes: averageSessionMinutes,
      longest_session_minutes: longestSessionMinutes,
      sessions_this_week: sessionsThisWeek,
    });
  } catch {
    sendError(res, 'Failed to fetch session stats', 500);
  }
});

void query;
