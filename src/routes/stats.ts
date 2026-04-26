import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { selectOne, selectMany } from '../services/db';
import { sendSuccess, sendError } from '../utils';

export const statsRouter = Router();

async function computeDayStreak(userId: string): Promise<number> {
  const data = await selectMany<{ updated_at: string }>(
    'SELECT updated_at FROM reading_progress WHERE user_id = $1 ORDER BY updated_at DESC',
    [userId]
  );
  if (data.length === 0) return 0;
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
    } else if (day < dateStr) break;
  }
  return streak;
}

statsRouter.get('/api/v1/stats', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  try {
    const [booksReadRow, booksInProgressRow, totalClubsRow, currentRows, streak] = await Promise.all([
      selectOne<{ n: string }>(
        `SELECT count(*)::text AS n FROM user_books WHERE user_id = $1 AND status = 'finished'`,
        [userId]
      ),
      selectOne<{ n: string }>(
        `SELECT count(*)::text AS n FROM user_books WHERE user_id = $1 AND status = 'reading'`,
        [userId]
      ),
      selectOne<{ n: string }>(
        `SELECT count(*)::text AS n FROM club_members WHERE user_id = $1`,
        [userId]
      ),
      selectMany<{
        book_id: string;
        updated_at: string;
        title: string;
        authors: string[];
        cover_url: string | null;
      }>(
        `SELECT ub.book_id, ub.updated_at, b.title, b.authors, b.cover_url
           FROM user_books ub
           LEFT JOIN books b ON b.id = ub.book_id
          WHERE ub.user_id = $1 AND ub.status = 'reading'
          ORDER BY ub.updated_at DESC LIMIT 5`,
        [userId]
      ),
      computeDayStreak(userId),
    ]);

    const bookIds = currentRows.map((r) => r.book_id);
    const progressByBook = new Map<string, number>();
    if (bookIds.length > 0) {
      const progress = await selectMany<{ book_id: string; percentage: number }>(
        'SELECT book_id, percentage FROM reading_progress WHERE user_id = $1 AND book_id = ANY($2)',
        [userId, bookIds]
      );
      for (const p of progress) progressByBook.set(p.book_id, Number(p.percentage));
    }

    const currently_reading = currentRows.map((r) => ({
      book_id: r.book_id,
      title: r.title,
      author: r.authors?.[0] ?? null,
      cover_url: r.cover_url,
      percentage: progressByBook.get(r.book_id) ?? 0,
    }));

    sendSuccess(res, {
      books_read: Number(booksReadRow?.n ?? 0),
      books_in_progress: Number(booksInProgressRow?.n ?? 0),
      current_streak: streak,
      total_clubs: Number(totalClubsRow?.n ?? 0),
      currently_reading,
    });
  } catch {
    sendError(res, 'Failed to fetch user stats', 500);
  }
});

statsRouter.get('/api/v1/stats/dashboard', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  try {
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
    const cutoff = twelveMonthsAgo.toISOString().slice(0, 10);

    const finishedRows = await selectMany<{ finished_at: string }>(
      `SELECT finished_at FROM user_books
        WHERE user_id = $1 AND status = 'finished' AND finished_at IS NOT NULL AND finished_at >= $2`,
      [userId, cutoff]
    );

    const monthlyCounts: Record<string, number> = {};
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      monthlyCounts[d.toISOString().slice(0, 7)] = 0;
    }
    for (const row of finishedRows) {
      const month = row.finished_at.slice(0, 7);
      if (month in monthlyCounts) monthlyCounts[month]++;
    }
    const monthly_books = Object.entries(monthlyCounts).map(([month, count]) => ({ month, count }));

    const allUserBooks = await selectMany<{ book_id: string; status: string; rating: number | null }>(
      'SELECT book_id, status, rating FROM user_books WHERE user_id = $1',
      [userId]
    );
    const bookIds = [...new Set(allUserBooks.map((r) => r.book_id))];

    let bookMeta = new Map<string, { genres: string[]; page_count: number | null }>();
    if (bookIds.length > 0) {
      const books = await selectMany<{ id: string; genres: string[] | null; page_count: number | null }>(
        'SELECT id, genres, page_count FROM books WHERE id = ANY($1)',
        [bookIds]
      );
      bookMeta = new Map(
        books.map((b) => [b.id, { genres: b.genres ?? [], page_count: b.page_count }])
      );
    }

    const genreCounts: Record<string, number> = {};
    for (const r of allUserBooks) {
      const g = bookMeta.get(r.book_id)?.genres?.[0];
      if (g) genreCounts[g] = (genreCounts[g] ?? 0) + 1;
    }
    const genre_breakdown = Object.entries(genreCounts).map(([genre, count]) => ({ genre, count }));

    let total_pages_read = 0;
    for (const r of allUserBooks) {
      if (r.status !== 'finished') continue;
      const pages = bookMeta.get(r.book_id)?.page_count;
      if (pages) total_pages_read += pages;
    }

    const ratings = allUserBooks.filter((r) => typeof r.rating === 'number').map((r) => r.rating as number);
    const average_rating = ratings.length > 0
      ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100
      : null;

    const reading_status_counts = { want: 0, reading: 0, finished: 0, dnf: 0 };
    for (const r of allUserBooks) {
      const s = r.status as keyof typeof reading_status_counts;
      if (s in reading_status_counts) reading_status_counts[s]++;
    }

    const ownSources = await selectMany<{ media_type: string }>(
      'SELECT media_type FROM book_sources WHERE owner_id = $1',
      [userId]
    );
    const books_by_format: Record<string, number> = { epub: 0, audiobook: 0 };
    for (const s of ownSources) {
      books_by_format[s.media_type] = (books_by_format[s.media_type] ?? 0) + 1;
    }

    const day_streak = await computeDayStreak(userId);

    const nowDate = new Date();
    const startOfWeek = new Date(nowDate);
    const diff = startOfWeek.getDay() === 0 ? 6 : startOfWeek.getDay() - 1;
    startOfWeek.setDate(startOfWeek.getDate() - diff);
    startOfWeek.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1);

    const sessions = await selectMany<{ duration_minutes: number; started_at: string }>(
      `SELECT duration_minutes, started_at FROM reading_sessions
        WHERE user_id = $1 AND duration_minutes IS NOT NULL AND started_at >= $2`,
      [userId, startOfMonth.toISOString()]
    );
    let reading_time_this_month = 0;
    let reading_time_this_week = 0;
    for (const s of sessions) {
      reading_time_this_month += s.duration_minutes;
      if (new Date(s.started_at) >= startOfWeek) reading_time_this_week += s.duration_minutes;
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

statsRouter.get('/api/v1/stats/friends-reading', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  try {
    const friendships = await selectMany<{ user_a_id: string; user_b_id: string }>(
      `SELECT user_a_id, user_b_id FROM friendships
        WHERE status = 'accepted' AND (user_a_id = $1 OR user_b_id = $1)`,
      [me]
    );
    const friendIds = friendships.map((f) => (f.user_a_id === me ? f.user_b_id : f.user_a_id));
    if (friendIds.length === 0) {
      sendSuccess(res, { items: [] });
      return;
    }

    const profiles = await selectMany<{
      user_id: string;
      handle: string;
      display_name: string;
      avatar_url: string | null;
      activity_privacy: string;
    }>(
      `SELECT user_id, handle, display_name, avatar_url, activity_privacy
         FROM user_profiles WHERE user_id = ANY($1)`,
      [friendIds]
    );
    const profilesById = new Map<string, typeof profiles[number]>();
    const visibleFriendIds: string[] = [];
    for (const p of profiles) {
      if (p.activity_privacy !== 'private') {
        profilesById.set(p.user_id, p);
        visibleFriendIds.push(p.user_id);
      }
    }
    if (visibleFriendIds.length === 0) {
      sendSuccess(res, { items: [] });
      return;
    }

    const userBooks = await selectMany<{ user_id: string; book_id: string; updated_at: string }>(
      `SELECT user_id, book_id, updated_at FROM user_books
        WHERE user_id = ANY($1) AND status = 'reading' AND privacy IN ('public', 'circle')
        ORDER BY updated_at DESC`,
      [visibleFriendIds]
    );
    if (userBooks.length === 0) {
      sendSuccess(res, { items: [] });
      return;
    }

    const byBook = new Map<string, { book_id: string; most_recent_update: string; friend_ids: string[] }>();
    for (const ub of userBooks) {
      const existing = byBook.get(ub.book_id);
      if (existing) {
        if (!existing.friend_ids.includes(ub.user_id)) existing.friend_ids.push(ub.user_id);
        if (ub.updated_at > existing.most_recent_update) existing.most_recent_update = ub.updated_at;
      } else {
        byBook.set(ub.book_id, {
          book_id: ub.book_id,
          most_recent_update: ub.updated_at,
          friend_ids: [ub.user_id],
        });
      }
    }

    const bookIds = Array.from(byBook.keys());
    const books = await selectMany<{ id: string; title: string; authors: string[]; cover_url: string | null }>(
      'SELECT id, title, authors, cover_url FROM books WHERE id = ANY($1)',
      [bookIds]
    );
    const bookById = new Map(books.map((b) => [b.id, b]));

    const items = Array.from(byBook.values())
      .sort((a, b) => b.most_recent_update.localeCompare(a.most_recent_update))
      .map((group) => ({
        book: bookById.get(group.book_id) ?? { id: group.book_id, title: 'Unknown' },
        friends: group.friend_ids
          .map((id) => profilesById.get(id))
          .filter((p): p is typeof profiles[number] => !!p)
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
