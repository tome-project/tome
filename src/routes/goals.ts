import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
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
    const { data, error } = await supabaseAdmin
      .from('reading_goals')
      .upsert(
        { user_id: userId, type, target, year },
        { onConflict: 'user_id,type,year' }
      )
      .select()
      .single();

    if (error) {
      sendError(res, error.message, 500);
      return;
    }

    sendSuccess(res, data);
  } catch (_e) {
    sendError(res, 'Failed to set goal', 500);
  }
});

// GET /api/v1/goals — get user's goals for current year with progress
goalsRouter.get('/api/v1/goals', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const year = new Date().getFullYear();
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  try {
    // Fetch goals for this year
    const { data: goals, error: goalsError } = await supabaseAdmin
      .from('reading_goals')
      .select('*')
      .eq('user_id', userId)
      .eq('year', year);

    if (goalsError) {
      sendError(res, goalsError.message, 500);
      return;
    }

    if (!goals || goals.length === 0) {
      sendSuccess(res, []);
      return;
    }

    // Calculate progress for each goal type
    const goalTypes = goals.map((g: any) => g.type as string);

    let booksFinished = 0;
    let pagesRead = 0;
    let minutesRead = 0;

    // Books finished this year
    if (goalTypes.includes('books') || goalTypes.includes('pages')) {
      const { data: finishedRows, error: finError } = await supabaseAdmin
        .from('progress')
        .select('book_id')
        .eq('user_id', userId)
        .eq('status', 'finished')
        .gte('finish_date', yearStart)
        .lte('finish_date', yearEnd);

      if (finError) {
        sendError(res, finError.message, 500);
        return;
      }

      booksFinished = finishedRows?.length ?? 0;

      // Pages for finished books this year
      if (goalTypes.includes('pages') && finishedRows && finishedRows.length > 0) {
        const bookIds = finishedRows.map((r: any) => r.book_id);
        const { data: books, error: booksError } = await supabaseAdmin
          .from('books')
          .select('page_count')
          .in('id', bookIds)
          .not('page_count', 'is', null);

        if (booksError) {
          sendError(res, booksError.message, 500);
          return;
        }

        pagesRead = (books || []).reduce((sum: number, b: any) => sum + (b.page_count || 0), 0);
      }
    }

    // Minutes from reading sessions this year
    if (goalTypes.includes('minutes')) {
      const { data: sessions, error: sessError } = await supabaseAdmin
        .from('reading_sessions')
        .select('duration_minutes')
        .eq('user_id', userId)
        .not('duration_minutes', 'is', null)
        .gte('started_at', `${yearStart}T00:00:00Z`)
        .lte('started_at', `${yearEnd}T23:59:59Z`);

      if (sessError) {
        sendError(res, sessError.message, 500);
        return;
      }

      minutesRead = (sessions || []).reduce((sum: number, s: any) => sum + (s.duration_minutes || 0), 0);
    }

    const progressMap: Record<string, number> = {
      books: booksFinished,
      pages: pagesRead,
      minutes: minutesRead,
    };

    const result = goals.map((g: any) => ({
      id: g.id,
      type: g.type,
      target: g.target,
      year: g.year,
      current: progressMap[g.type as string] ?? 0,
    }));

    sendSuccess(res, result);
  } catch (_e) {
    sendError(res, 'Failed to fetch goals', 500);
  }
});
