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

// GET /api/v1/stats/dashboard — rich tracking dashboard
statsRouter.get('/api/v1/stats/dashboard', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;

  try {
    // Monthly books finished (last 12 months) based on finish_date
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
    const cutoff = twelveMonthsAgo.toISOString().slice(0, 10);

    const { data: finishedRows, error: finishedError } = await supabaseAdmin
      .from('progress')
      .select('finish_date')
      .eq('user_id', userId)
      .eq('status', 'finished')
      .not('finish_date', 'is', null)
      .gte('finish_date', cutoff);

    if (finishedError) {
      sendError(res, finishedError.message, 500);
      return;
    }

    // Build monthly_books from the last 12 months
    const monthlyCounts: Record<string, number> = {};
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.toISOString().slice(0, 7);
      monthlyCounts[key] = 0;
    }
    for (const row of finishedRows || []) {
      const month = (row.finish_date as string).slice(0, 7);
      if (month in monthlyCounts) {
        monthlyCounts[month]++;
      }
    }
    const monthly_books = Object.entries(monthlyCounts).map(([month, count]) => ({ month, count }));

    // Genre breakdown — join progress with books to get genres for books the user has progress on
    const { data: progressWithBooks, error: genreError } = await supabaseAdmin
      .from('progress')
      .select('book_id')
      .eq('user_id', userId);

    if (genreError) {
      sendError(res, genreError.message, 500);
      return;
    }

    let genre_breakdown: { genre: string; count: number }[] = [];
    if (progressWithBooks && progressWithBooks.length > 0) {
      const bookIds = progressWithBooks.map((r: any) => r.book_id);
      const { data: booksWithGenre, error: booksGenreError } = await supabaseAdmin
        .from('books')
        .select('genre')
        .in('id', bookIds)
        .not('genre', 'is', null);

      if (booksGenreError) {
        sendError(res, booksGenreError.message, 500);
        return;
      }

      const genreCounts: Record<string, number> = {};
      for (const b of booksWithGenre || []) {
        const g = b.genre as string;
        genreCounts[g] = (genreCounts[g] || 0) + 1;
      }
      genre_breakdown = Object.entries(genreCounts).map(([genre, count]) => ({ genre, count }));
    }

    // Total pages read — sum page_count for finished books
    const { data: finishedBookIds, error: finBookError } = await supabaseAdmin
      .from('progress')
      .select('book_id')
      .eq('user_id', userId)
      .eq('status', 'finished');

    if (finBookError) {
      sendError(res, finBookError.message, 500);
      return;
    }

    let total_pages_read = 0;
    if (finishedBookIds && finishedBookIds.length > 0) {
      const ids = finishedBookIds.map((r: any) => r.book_id);
      const { data: finishedBooks, error: pagesError } = await supabaseAdmin
        .from('books')
        .select('page_count')
        .in('id', ids)
        .not('page_count', 'is', null);

      if (pagesError) {
        sendError(res, pagesError.message, 500);
        return;
      }

      total_pages_read = (finishedBooks || []).reduce((sum: number, b: any) => sum + (b.page_count || 0), 0);
    }

    // Average rating
    const { data: ratings, error: ratingsError } = await supabaseAdmin
      .from('progress')
      .select('rating')
      .eq('user_id', userId)
      .not('rating', 'is', null);

    if (ratingsError) {
      sendError(res, ratingsError.message, 500);
      return;
    }

    let average_rating: number | null = null;
    if (ratings && ratings.length > 0) {
      const sum = ratings.reduce((acc: number, r: any) => acc + r.rating, 0);
      average_rating = Math.round((sum / ratings.length) * 100) / 100;
    }

    // Reading status counts
    const { data: allProgress, error: statusError } = await supabaseAdmin
      .from('progress')
      .select('status')
      .eq('user_id', userId);

    if (statusError) {
      sendError(res, statusError.message, 500);
      return;
    }

    const reading_status_counts = { want_to_read: 0, reading: 0, finished: 0, dnf: 0 };
    for (const row of allProgress || []) {
      const s = row.status as keyof typeof reading_status_counts;
      if (s in reading_status_counts) {
        reading_status_counts[s]++;
      }
    }

    // Books by format — count book types for books the user has progress on
    let books_by_format: Record<string, number> = { epub: 0, audiobook: 0 };
    if (progressWithBooks && progressWithBooks.length > 0) {
      const bookIds = progressWithBooks.map((r: any) => r.book_id);
      const { data: booksWithType, error: typeError } = await supabaseAdmin
        .from('books')
        .select('type')
        .in('id', bookIds);

      if (typeError) {
        sendError(res, typeError.message, 500);
        return;
      }

      for (const b of booksWithType || []) {
        const t = b.type as string;
        books_by_format[t] = (books_by_format[t] || 0) + 1;
      }
    }

    sendSuccess(res, {
      monthly_books,
      genre_breakdown,
      total_pages_read,
      average_rating,
      reading_status_counts,
      books_by_format,
    });
  } catch (_e) {
    sendError(res, 'Failed to fetch dashboard stats', 500);
  }
});
