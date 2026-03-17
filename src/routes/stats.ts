import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const statsRouter = Router();

// GET /api/v1/stats — get user reading stats
statsRouter.get('/api/v1/stats', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;

  try {
    // Count books read (progress >= 100%)
    const { count: booksRead, error: readError } = await supabaseAdmin
      .from('progress')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('percentage', 100);

    if (readError) {
      sendError(res, readError.message, 500);
      return;
    }

    // Count books in progress (0 < progress < 100%)
    const { count: booksInProgress, error: progressError } = await supabaseAdmin
      .from('progress')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gt('percentage', 0)
      .lt('percentage', 100);

    if (progressError) {
      sendError(res, progressError.message, 500);
      return;
    }

    // Calculate current streak
    const { data: progressDates, error: streakError } = await supabaseAdmin
      .from('progress')
      .select('updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (streakError) {
      sendError(res, streakError.message, 500);
      return;
    }

    let currentStreak = 0;
    if (progressDates && progressDates.length > 0) {
      const uniqueDays = [
        ...new Set(
          progressDates.map((p: any) =>
            new Date(p.updated_at).toISOString().slice(0, 10)
          )
        ),
      ].sort((a, b) => b.localeCompare(a));

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const checkDate = new Date(today);

      for (const day of uniqueDays) {
        const dateStr = checkDate.toISOString().slice(0, 10);
        if (day === dateStr) {
          currentStreak++;
          checkDate.setDate(checkDate.getDate() - 1);
        } else if (day < dateStr) {
          break;
        }
      }
    }

    // Count clubs
    const { count: totalClubs, error: clubsError } = await supabaseAdmin
      .from('club_members')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (clubsError) {
      sendError(res, clubsError.message, 500);
      return;
    }

    // Get currently reading books
    const { data: inProgressRows, error: currentError } = await supabaseAdmin
      .from('progress')
      .select('book_id, percentage, updated_at')
      .eq('user_id', userId)
      .gt('percentage', 0)
      .lt('percentage', 100)
      .order('updated_at', { ascending: false })
      .limit(5);

    if (currentError) {
      sendError(res, currentError.message, 500);
      return;
    }

    let currentlyReading: any[] = [];

    if (inProgressRows && inProgressRows.length > 0) {
      const bookIds = inProgressRows.map((r: any) => r.book_id);

      const { data: books, error: booksError } = await supabaseAdmin
        .from('books')
        .select('id, title, author, cover_url')
        .in('id', bookIds);

      if (booksError) {
        sendError(res, booksError.message, 500);
        return;
      }

      const booksMap = new Map((books || []).map((b: any) => [b.id, b]));

      currentlyReading = inProgressRows
        .map((row: any) => {
          const book = booksMap.get(row.book_id);
          if (!book) return null;
          return {
            book_id: row.book_id,
            title: book.title,
            author: book.author,
            cover_url: book.cover_url,
            percentage: row.percentage,
          };
        })
        .filter(Boolean);
    }

    sendSuccess(res, {
      books_read: booksRead || 0,
      books_in_progress: booksInProgress || 0,
      current_streak: currentStreak,
      total_clubs: totalClubs || 0,
      currently_reading: currentlyReading,
    });
  } catch (_e) {
    sendError(res, 'Failed to fetch user stats', 500);
  }
});
