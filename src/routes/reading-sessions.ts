import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const readingSessionsRouter = Router();

// POST /api/v1/sessions/start — start a new reading session
readingSessionsRouter.post('/api/v1/sessions/start', requireAuth, async (req: Request, res: Response) => {
  const { book_id } = req.body;
  const userId = req.userId!;

  if (!book_id) {
    sendError(res, 'book_id is required');
    return;
  }

  // Verify the book exists
  const { data: book, error: bookError } = await supabaseAdmin
    .from('books')
    .select('id')
    .eq('id', book_id)
    .single();

  if (bookError || !book) {
    sendError(res, 'Book not found', 404);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('reading_sessions')
    .insert({
      user_id: userId,
      book_id,
      started_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data, 201);
});

// POST /api/v1/sessions/:id/end — end a reading session
readingSessionsRouter.post('/api/v1/sessions/:id/end', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { pages_read, notes } = req.body;
  const userId = req.userId!;

  // Fetch the session to get started_at and verify ownership
  const { data: session, error: fetchError } = await supabaseAdmin
    .from('reading_sessions')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .single();

  if (fetchError || !session) {
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

  const updateData: Record<string, unknown> = {
    ended_at: now.toISOString(),
    duration_minutes: durationMinutes,
  };

  if (pages_read !== undefined) updateData.pages_read = pages_read;
  if (notes !== undefined) updateData.notes = notes;

  const { data, error } = await supabaseAdmin
    .from('reading_sessions')
    .update(updateData)
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data);
});

// GET /api/v1/sessions — list user's recent sessions (last 30 days)
readingSessionsRouter.get('/api/v1/sessions', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const { data: sessions, error } = await supabaseAdmin
    .from('reading_sessions')
    .select('*')
    .eq('user_id', userId)
    .gte('started_at', thirtyDaysAgo.toISOString())
    .order('started_at', { ascending: false });

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  if (!sessions || sessions.length === 0) {
    sendSuccess(res, []);
    return;
  }

  // Join with books to include title and author
  const bookIds = [...new Set(sessions.map((s: any) => s.book_id))];

  const { data: books, error: booksError } = await supabaseAdmin
    .from('books')
    .select('id, title, authors')
    .in('id', bookIds);

  if (booksError) {
    sendError(res, booksError.message, 500);
    return;
  }

  const booksMap = new Map((books || []).map((b: any) => [b.id, b]));

  const enriched = sessions.map((s: any) => {
    const book = booksMap.get(s.book_id);
    return {
      ...s,
      book_title: book?.title ?? null,
      book_author: (book?.authors as string[] | undefined)?.[0] ?? null,
    };
  });

  sendSuccess(res, enriched);
});

// GET /api/v1/sessions/stats — reading session statistics
readingSessionsRouter.get('/api/v1/sessions/stats', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;

  try {
    // Get the start of this week (Monday) and this month
    const now = new Date();

    const startOfWeek = new Date(now);
    const day = startOfWeek.getDay();
    const diff = day === 0 ? 6 : day - 1; // Monday = 0 offset
    startOfWeek.setDate(startOfWeek.getDate() - diff);
    startOfWeek.setHours(0, 0, 0, 0);

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Fetch all completed sessions this month (covers both week and month)
    const { data: sessions, error } = await supabaseAdmin
      .from('reading_sessions')
      .select('duration_minutes, started_at')
      .eq('user_id', userId)
      .not('duration_minutes', 'is', null)
      .gte('started_at', startOfMonth.toISOString());

    if (error) {
      sendError(res, error.message, 500);
      return;
    }

    let totalMinutesThisWeek = 0;
    let totalMinutesThisMonth = 0;
    let sessionsThisWeek = 0;
    let longestSessionMinutes = 0;
    let allDurations: number[] = [];

    for (const s of sessions || []) {
      const duration = s.duration_minutes as number;
      const sessionDate = new Date(s.started_at);

      totalMinutesThisMonth += duration;
      allDurations.push(duration);

      if (duration > longestSessionMinutes) {
        longestSessionMinutes = duration;
      }

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
  } catch (_e) {
    sendError(res, 'Failed to fetch session stats', 500);
  }
});
