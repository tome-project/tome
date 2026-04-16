import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const statsRouter = Router();

// Streak based on reading_progress.updated_at — a day counts if any progress
// update happened that day, walking backwards from today.
async function computeDayStreak(userId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('reading_progress')
    .select('updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (error || !data || data.length === 0) return 0;

  const uniqueDays = [
    ...new Set(data.map((p) => new Date(p.updated_at).toISOString().slice(0, 10))),
  ].sort((a, b) => b.localeCompare(a));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const checkDate = new Date(today);

  let streak = 0;
  for (const day of uniqueDays) {
    const dateStr = checkDate.toISOString().slice(0, 10);
    if (day === dateStr) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else if (day < dateStr) {
      break;
    }
  }
  return streak;
}

// GET /api/v1/stats — top-line user stats for the profile header
statsRouter.get('/api/v1/stats', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;

  try {
    const [{ count: booksRead }, { count: booksInProgress }, { count: totalClubs }, current, streak] =
      await Promise.all([
        supabaseAdmin
          .from('user_books')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('status', 'finished'),
        supabaseAdmin
          .from('user_books')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('status', 'reading'),
        supabaseAdmin
          .from('club_members')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', userId),
        supabaseAdmin
          .from('user_books')
          .select('book_id, updated_at, book:books(id, title, authors, cover_url)')
          .eq('user_id', userId)
          .eq('status', 'reading')
          .order('updated_at', { ascending: false })
          .limit(5),
        computeDayStreak(userId),
      ]);

    type JoinedRow = {
      book_id: string;
      updated_at: string;
      book:
        | { id: string; title: string; authors: string[]; cover_url: string | null }
        | Array<{ id: string; title: string; authors: string[]; cover_url: string | null }>
        | null;
    };
    const currentRows = (current.data ?? []) as unknown as JoinedRow[];

    const bookIds = currentRows.map((r) => r.book_id);
    const progressByBook = new Map<string, number>();
    if (bookIds.length > 0) {
      const { data: progress } = await supabaseAdmin
        .from('reading_progress')
        .select('book_id, percentage')
        .eq('user_id', userId)
        .in('book_id', bookIds);
      for (const p of progress ?? []) progressByBook.set(p.book_id as string, Number(p.percentage));
    }

    const currently_reading = currentRows
      .map((r) => {
        const book = Array.isArray(r.book) ? r.book[0] : r.book;
        if (!book) return null;
        return {
          book_id: r.book_id,
          title: book.title,
          author: book.authors?.[0] ?? null,
          cover_url: book.cover_url,
          percentage: progressByBook.get(r.book_id) ?? 0,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    sendSuccess(res, {
      books_read: booksRead ?? 0,
      books_in_progress: booksInProgress ?? 0,
      current_streak: streak,
      total_clubs: totalClubs ?? 0,
      currently_reading,
    });
  } catch {
    sendError(res, 'Failed to fetch user stats', 500);
  }
});

// GET /api/v1/stats/dashboard — richer dashboard shown on the profile tab
statsRouter.get('/api/v1/stats/dashboard', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;

  try {
    // Monthly finishes — last 12 months, keyed YYYY-MM
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
    const cutoff = twelveMonthsAgo.toISOString().slice(0, 10);

    const { data: finishedRows } = await supabaseAdmin
      .from('user_books')
      .select('finished_at')
      .eq('user_id', userId)
      .eq('status', 'finished')
      .not('finished_at', 'is', null)
      .gte('finished_at', cutoff);

    const monthlyCounts: Record<string, number> = {};
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      monthlyCounts[d.toISOString().slice(0, 7)] = 0;
    }
    for (const row of finishedRows ?? []) {
      const month = (row.finished_at as string).slice(0, 7);
      if (month in monthlyCounts) monthlyCounts[month]++;
    }
    const monthly_books = Object.entries(monthlyCounts).map(([month, count]) => ({ month, count }));

    // Genre + page stats: fetch user's book_ids + join catalog for genres/page_count
    const { data: allUserBooks } = await supabaseAdmin
      .from('user_books')
      .select('book_id, status, rating')
      .eq('user_id', userId);

    const bookIds = [...new Set((allUserBooks ?? []).map((r) => r.book_id as string))];
    let bookMeta = new Map<string, { genres: string[]; page_count: number | null }>();
    if (bookIds.length > 0) {
      const { data: books } = await supabaseAdmin
        .from('books')
        .select('id, genres, page_count')
        .in('id', bookIds);
      bookMeta = new Map(
        (books ?? []).map((b) => [
          b.id as string,
          { genres: (b.genres as string[]) ?? [], page_count: b.page_count as number | null },
        ])
      );
    }

    const genreCounts: Record<string, number> = {};
    for (const r of allUserBooks ?? []) {
      const g = bookMeta.get(r.book_id as string)?.genres?.[0];
      if (g) genreCounts[g] = (genreCounts[g] ?? 0) + 1;
    }
    const genre_breakdown = Object.entries(genreCounts).map(([genre, count]) => ({ genre, count }));

    let total_pages_read = 0;
    for (const r of allUserBooks ?? []) {
      if (r.status !== 'finished') continue;
      const pages = bookMeta.get(r.book_id as string)?.page_count;
      if (pages) total_pages_read += pages;
    }

    const ratings = (allUserBooks ?? []).filter((r) => typeof r.rating === 'number').map((r) => r.rating as number);
    const average_rating =
      ratings.length > 0 ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100 : null;

    const reading_status_counts = { want: 0, reading: 0, finished: 0, dnf: 0 };
    for (const r of allUserBooks ?? []) {
      const s = r.status as keyof typeof reading_status_counts;
      if (s in reading_status_counts) reading_status_counts[s]++;
    }

    // Format breakdown now from the caller's book_sources
    const { data: ownSources } = await supabaseAdmin
      .from('book_sources')
      .select('media_type')
      .eq('owner_id', userId);
    const books_by_format: Record<string, number> = { epub: 0, audiobook: 0 };
    for (const s of ownSources ?? []) {
      const mt = s.media_type as string;
      books_by_format[mt] = (books_by_format[mt] ?? 0) + 1;
    }

    const day_streak = await computeDayStreak(userId);

    // Reading time from reading_sessions (this week / this month)
    const nowDate = new Date();
    const startOfWeek = new Date(nowDate);
    const diff = startOfWeek.getDay() === 0 ? 6 : startOfWeek.getDay() - 1;
    startOfWeek.setDate(startOfWeek.getDate() - diff);
    startOfWeek.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1);

    const { data: sessions } = await supabaseAdmin
      .from('reading_sessions')
      .select('duration_minutes, started_at')
      .eq('user_id', userId)
      .not('duration_minutes', 'is', null)
      .gte('started_at', startOfMonth.toISOString());

    let reading_time_this_month = 0;
    let reading_time_this_week = 0;
    for (const s of sessions ?? []) {
      const d = s.duration_minutes as number;
      reading_time_this_month += d;
      if (new Date(s.started_at as string) >= startOfWeek) reading_time_this_week += d;
    }

    sendSuccess(res, {
      monthly_books,
      genre_breakdown,
      total_pages_read,
      average_rating,
      reading_status_counts,
      books_by_format,
      reading_time_this_month,
      reading_time_this_week,
      day_streak,
    });
  } catch {
    sendError(res, 'Failed to fetch dashboard stats', 500);
  }
});

// GET /api/v1/stats/friends-reading
// Returns a flat list of "friend currently reading book X" rows, grouped by
// book_id so the client can render a "N friends are reading" carousel with
// one card per book. Visibility: walks the caller's accepted friendships,
// fetches their user_books rows with status='reading' and privacy IN
// ('public','circle'), and honors profile.activity_privacy='private' (those
// friends are excluded entirely).
//
// Response: { items: [{ book, friends: [{user_id, handle, display_name, avatar_url}] }] }
statsRouter.get('/api/v1/stats/friends-reading', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;

  try {
    const { data: friendships, error: fErr } = await supabaseAdmin
      .from('friendships')
      .select('user_a_id, user_b_id')
      .eq('status', 'accepted')
      .or(`user_a_id.eq.${me},user_b_id.eq.${me}`);
    if (fErr) {
      sendError(res, fErr.message, 500);
      return;
    }
    const friendIds = (friendships ?? []).map((f) =>
      (f.user_a_id as string) === me ? (f.user_b_id as string) : (f.user_a_id as string),
    );
    if (friendIds.length === 0) {
      sendSuccess(res, { items: [] });
      return;
    }

    // Filter friends by activity_privacy — 'private' excludes them from
    // social surfaces (consistent with /api/v1/activity).
    const { data: profiles, error: pErr } = await supabaseAdmin
      .from('user_profiles')
      .select('user_id, handle, display_name, avatar_url, activity_privacy')
      .in('user_id', friendIds);
    if (pErr) {
      sendError(res, pErr.message, 500);
      return;
    }
    const profilesById = new Map<string, Record<string, unknown>>();
    const visibleFriendIds: string[] = [];
    for (const p of profiles ?? []) {
      if ((p.activity_privacy as string) !== 'private') {
        profilesById.set(p.user_id as string, p as Record<string, unknown>);
        visibleFriendIds.push(p.user_id as string);
      }
    }
    if (visibleFriendIds.length === 0) {
      sendSuccess(res, { items: [] });
      return;
    }

    const { data: userBooks, error: ubErr } = await supabaseAdmin
      .from('user_books')
      .select('user_id, book_id, updated_at')
      .in('user_id', visibleFriendIds)
      .eq('status', 'reading')
      .in('privacy', ['public', 'circle'])
      .order('updated_at', { ascending: false });
    if (ubErr) {
      sendError(res, ubErr.message, 500);
      return;
    }
    if (!userBooks || userBooks.length === 0) {
      sendSuccess(res, { items: [] });
      return;
    }

    // Group by book_id, preserving the most recent updated_at per book for
    // carousel ordering.
    const byBook = new Map<
      string,
      { book_id: string; most_recent_update: string; friend_ids: string[] }
    >();
    for (const ub of userBooks) {
      const bookId = ub.book_id as string;
      const updatedAt = ub.updated_at as string;
      const friendId = ub.user_id as string;
      const existing = byBook.get(bookId);
      if (existing) {
        if (!existing.friend_ids.includes(friendId)) existing.friend_ids.push(friendId);
        if (updatedAt > existing.most_recent_update) existing.most_recent_update = updatedAt;
      } else {
        byBook.set(bookId, {
          book_id: bookId,
          most_recent_update: updatedAt,
          friend_ids: [friendId],
        });
      }
    }

    const bookIds = Array.from(byBook.keys());
    const { data: books, error: bErr } = await supabaseAdmin
      .from('books')
      .select('id, title, authors, cover_url')
      .in('id', bookIds);
    if (bErr) {
      sendError(res, bErr.message, 500);
      return;
    }
    const bookById = new Map<string, Record<string, unknown>>();
    for (const b of books ?? []) bookById.set(b.id as string, b as Record<string, unknown>);

    const items = Array.from(byBook.values())
      .sort((a, b) => b.most_recent_update.localeCompare(a.most_recent_update))
      .map((group) => ({
        book: bookById.get(group.book_id) ?? { id: group.book_id, title: 'Unknown' },
        friends: group.friend_ids
          .map((id) => profilesById.get(id))
          .filter((p): p is Record<string, unknown> => p !== undefined)
          .map((p) => ({
            user_id: p.user_id,
            handle: p.handle,
            display_name: p.display_name,
            avatar_url: p.avatar_url,
          })),
      }));

    sendSuccess(res, { items });
  } catch {
    sendError(res, 'Failed to fetch friends-reading', 500);
  }
});
