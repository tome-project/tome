import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { selectOne, selectMany } from '../services/db';
import { sendSuccess, sendError } from '../utils';

export const activityRouter = Router();

interface ProfileRow {
  user_id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
  activity_privacy: 'public' | 'circle' | 'private';
}

interface UserBookRow {
  user_id: string;
  book_id: string;
  status: 'want' | 'reading' | 'finished' | 'dnf';
  rating: number | null;
  review: string | null;
  favorite_quote: string | null;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  created_at: string;
  privacy: 'public' | 'circle' | 'private';
}

interface HighlightRow {
  user_id: string;
  book_id: string;
  text: string;
  note: string | null;
  chapter: number | null;
  color: string;
  privacy: 'public' | 'circle' | 'private';
  created_at: string;
}

interface ClubMemberRow {
  user_id: string;
  club_id: string;
  joined_at: string;
}

interface DiscussionRow {
  user_id: string;
  club_id: string;
  chapter: number;
  content: string | null;
  created_at: string;
}

interface BookRow {
  id: string;
  title: string;
  cover_url: string | null;
}

interface ClubRow {
  id: string;
  name: string;
  book_id: string;
}

type ActivityEvent = {
  type: 'finished' | 'started' | 'want' | 'dnf' | 'highlight' | 'joined_club' | 'discussion';
  user_id: string;
  timestamp: string;
  data: Record<string, unknown>;
};

activityRouter.get('/api/v1/activity', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const LIMIT = 50;
  const PER_SOURCE = 30;

  const targetParam = typeof req.query.user_id === 'string' ? req.query.user_id : null;

  let allowedIds: string[] = [];
  const profilesById = new Map<string, ProfileRow>();
  let allowedPrivacies: Array<'public' | 'circle' | 'private'> = ['public', 'circle'];

  try {
    if (targetParam) {
      const target = await selectOne<ProfileRow>(
        `SELECT user_id, handle, display_name, avatar_url, activity_privacy
           FROM user_profiles WHERE user_id = $1`,
        [targetParam]
      );
      if (!target) { sendError(res, 'User not found', 404); return; }
      profilesById.set(target.user_id, target);

      const isSelf = target.user_id === me;
      let isFriend = false;
      if (!isSelf) {
        const [a, b] = [me, target.user_id].sort();
        const fship = await selectOne(
          `SELECT id FROM friendships
            WHERE status = 'accepted' AND user_a_id = $1 AND user_b_id = $2`,
          [a, b]
        );
        isFriend = !!fship;
      }

      if (!isSelf) {
        if (target.activity_privacy === 'private') {
          sendSuccess(res, { items: [] });
          return;
        }
        if (target.activity_privacy === 'circle' && !isFriend) {
          sendSuccess(res, { items: [] });
          return;
        }
      }

      allowedIds = [target.user_id];
      if (isSelf) allowedPrivacies = ['public', 'circle', 'private'];
      else if (isFriend) allowedPrivacies = ['public', 'circle'];
      else allowedPrivacies = ['public'];
    } else {
      const friendships = await selectMany<{ user_a_id: string; user_b_id: string }>(
        `SELECT user_a_id, user_b_id FROM friendships
          WHERE status = 'accepted' AND (user_a_id = $1 OR user_b_id = $1)`,
        [me]
      );
      const friendIds = friendships.map((f) => (f.user_a_id === me ? f.user_b_id : f.user_a_id));
      const circleIds = Array.from(new Set([me, ...friendIds]));

      const profiles = await selectMany<ProfileRow>(
        `SELECT user_id, handle, display_name, avatar_url, activity_privacy
           FROM user_profiles WHERE user_id = ANY($1)`,
        [circleIds]
      );
      for (const p of profiles) {
        profilesById.set(p.user_id, p);
        if (p.user_id === me || p.activity_privacy !== 'private') allowedIds.push(p.user_id);
      }
    }

    if (allowedIds.length === 0) {
      sendSuccess(res, { items: [] });
      return;
    }

    const [userBooks, highlights, clubMembers, discussions] = await Promise.all([
      selectMany<UserBookRow>(
        `SELECT user_id, book_id, status, rating, review, favorite_quote,
                started_at, finished_at, updated_at, created_at, privacy
           FROM user_books
          WHERE user_id = ANY($1) AND privacy = ANY($2)
          ORDER BY updated_at DESC LIMIT ${PER_SOURCE}`,
        [allowedIds, allowedPrivacies]
      ),
      selectMany<HighlightRow>(
        `SELECT user_id, book_id, text, note, chapter, color, privacy, created_at
           FROM highlights
          WHERE user_id = ANY($1) AND privacy = ANY($2)
          ORDER BY created_at DESC LIMIT ${PER_SOURCE}`,
        [allowedIds, allowedPrivacies]
      ),
      selectMany<ClubMemberRow>(
        `SELECT user_id, club_id, joined_at FROM club_members
          WHERE user_id = ANY($1) ORDER BY joined_at DESC LIMIT ${PER_SOURCE}`,
        [allowedIds]
      ),
      selectMany<DiscussionRow>(
        `SELECT user_id, club_id, chapter, content, created_at FROM discussions
          WHERE user_id = ANY($1) ORDER BY created_at DESC LIMIT ${PER_SOURCE}`,
        [allowedIds]
      ),
    ]);

    const clubIdSet = new Set<string>();
    for (const r of clubMembers) clubIdSet.add(r.club_id);
    for (const r of discussions) clubIdSet.add(r.club_id);
    const bookIdSet = new Set<string>();
    for (const r of userBooks) bookIdSet.add(r.book_id);
    for (const r of highlights) bookIdSet.add(r.book_id);

    let clubs: ClubRow[] = [];
    if (clubIdSet.size > 0) {
      clubs = await selectMany<ClubRow>(
        'SELECT id, name, book_id FROM clubs WHERE id = ANY($1)',
        [Array.from(clubIdSet)]
      );
      for (const c of clubs) if (c.book_id) bookIdSet.add(c.book_id);
    }

    let books: BookRow[] = [];
    if (bookIdSet.size > 0) {
      books = await selectMany<BookRow>(
        'SELECT id, title, cover_url FROM books WHERE id = ANY($1)',
        [Array.from(bookIdSet)]
      );
    }
    const bookById = new Map(books.map((b) => [b.id, b]));
    const clubById = new Map(clubs.map((c) => [c.id, c]));

    const events: ActivityEvent[] = [];
    for (const ub of userBooks) {
      const book = bookById.get(ub.book_id);
      const baseData = {
        book_id: ub.book_id,
        book_title: book?.title ?? 'Unknown',
        book_cover_url: book?.cover_url ?? null,
      };
      if (ub.status === 'finished' || ub.finished_at) {
        events.push({
          type: 'finished',
          user_id: ub.user_id,
          timestamp: ub.updated_at,
          data: { ...baseData, rating: ub.rating, review: ub.review, favorite_quote: ub.favorite_quote, finished_at: ub.finished_at },
        });
      } else if (ub.status === 'reading') {
        events.push({ type: 'started', user_id: ub.user_id, timestamp: ub.updated_at, data: { ...baseData, started_at: ub.started_at } });
      } else if (ub.status === 'want') {
        events.push({ type: 'want', user_id: ub.user_id, timestamp: ub.updated_at, data: baseData });
      } else if (ub.status === 'dnf') {
        events.push({ type: 'dnf', user_id: ub.user_id, timestamp: ub.updated_at, data: baseData });
      }
    }
    for (const hl of highlights) {
      const book = bookById.get(hl.book_id);
      events.push({
        type: 'highlight',
        user_id: hl.user_id,
        timestamp: hl.created_at,
        data: {
          book_id: hl.book_id,
          book_title: book?.title ?? 'Unknown',
          book_cover_url: book?.cover_url ?? null,
          highlight_text: hl.text,
          highlight_note: hl.note,
          highlight_color: hl.color,
          chapter: hl.chapter,
        },
      });
    }
    for (const cm of clubMembers) {
      const club = clubById.get(cm.club_id);
      if (!club) continue;
      const book = bookById.get(club.book_id);
      events.push({
        type: 'joined_club',
        user_id: cm.user_id,
        timestamp: cm.joined_at,
        data: {
          club_id: cm.club_id,
          club_name: club.name,
          book_id: club.book_id,
          book_title: book?.title ?? null,
          book_cover_url: book?.cover_url ?? null,
        },
      });
    }
    for (const dc of discussions) {
      const club = clubById.get(dc.club_id);
      if (!club) continue;
      events.push({
        type: 'discussion',
        user_id: dc.user_id,
        timestamp: dc.created_at,
        data: {
          club_id: dc.club_id,
          club_name: club.name,
          chapter: dc.chapter,
          preview: (dc.content ?? '').slice(0, 140),
        },
      });
    }

    events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const trimmed = events.slice(0, LIMIT);
    const items = trimmed.map((e) => {
      const profile = profilesById.get(e.user_id);
      return {
        ...e,
        profile: profile
          ? {
              user_id: profile.user_id,
              handle: profile.handle,
              display_name: profile.display_name,
              avatar_url: profile.avatar_url,
            }
          : null,
      };
    });

    sendSuccess(res, { items });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});
