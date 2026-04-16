import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const activityRouter = Router();

// ---------------------------------------------------------------------------
// Types (for narrowing supabase rows)
// ---------------------------------------------------------------------------

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

// GET /api/v1/activity — activity feed
//
// Two modes driven by the optional `?user_id=<uuid>` query param:
//
//   • No param (default): the friend-scoped feed — caller + accepted
//     friends. Honors each user's profile.activity_privacy; rows with
//     per-item privacy of 'private' never surface.
//   • With param: activity for a single target user. Visibility is a
//     three-way function of the caller↔target relationship:
//       - target is caller → all privacies (public + circle + private)
//       - target is an accepted friend → public + circle
//       - target is a stranger → public only
//     Target's profile.activity_privacy is also respected: 'private'
//     returns empty for anyone other than the caller; 'circle' requires
//     caller to be a friend (or self).
//
// Unioned sources:
//   - user_books (finished / started / want / dnf, rating + review carried
//     along with finished events)
//   - highlights (carries passage text + note + chapter + color)
//   - club_members (joined a club)
//   - discussions (posted in a club)
//
// Response: { items: ActivityEvent[] } where ActivityEvent carries a
// hydrated `profile` summary plus event-specific `data`.
activityRouter.get('/api/v1/activity', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const LIMIT = 50;
  const PER_SOURCE = 30;

  const targetParam = typeof req.query.user_id === 'string' ? req.query.user_id : null;

  let allowedIds: string[] = [];
  const profilesById = new Map<string, ProfileRow>();
  let allowedPrivacies: Array<'public' | 'circle' | 'private'> = ['public', 'circle'];

  if (targetParam) {
    // Single-user mode
    const { data: profileRow, error: profileErr } = await supabaseAdmin
      .from('user_profiles')
      .select('user_id, handle, display_name, avatar_url, activity_privacy')
      .eq('user_id', targetParam)
      .maybeSingle();
    if (profileErr) {
      sendError(res, profileErr.message, 500);
      return;
    }
    if (!profileRow) {
      sendError(res, 'User not found', 404);
      return;
    }
    const target = profileRow as ProfileRow;
    profilesById.set(target.user_id, target);

    const isSelf = target.user_id === me;
    let isFriend = false;
    if (!isSelf) {
      const [a, b] = [me, target.user_id].sort();
      const { data: fships } = await supabaseAdmin
        .from('friendships')
        .select('id')
        .eq('status', 'accepted')
        .eq('user_a_id', a)
        .eq('user_b_id', b)
        .limit(1);
      isFriend = (fships ?? []).length > 0;
    }

    // Honor the target's profile-level activity_privacy before fetching any rows.
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
    // Friend-scoped feed
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
    const circleIds = Array.from(new Set([me, ...friendIds]));

    const { data: profileRows, error: pErr } = await supabaseAdmin
      .from('user_profiles')
      .select('user_id, handle, display_name, avatar_url, activity_privacy')
      .in('user_id', circleIds);
    if (pErr) {
      sendError(res, pErr.message, 500);
      return;
    }
    const profiles = (profileRows ?? []) as ProfileRow[];
    for (const p of profiles) {
      profilesById.set(p.user_id, p);
      if (p.user_id === me || p.activity_privacy !== 'private') allowedIds.push(p.user_id);
    }
  }

  if (allowedIds.length === 0) {
    sendSuccess(res, { items: [] });
    return;
  }

  // 3. Parallel fetch across the four source tables
  const [ubResp, hlResp, cmResp, dcResp] = await Promise.all([
    supabaseAdmin
      .from('user_books')
      .select(
        'user_id, book_id, status, rating, review, favorite_quote, started_at, finished_at, updated_at, created_at, privacy',
      )
      .in('user_id', allowedIds)
      .in('privacy', allowedPrivacies)
      .order('updated_at', { ascending: false })
      .limit(PER_SOURCE),
    supabaseAdmin
      .from('highlights')
      .select('user_id, book_id, text, note, chapter, color, privacy, created_at')
      .in('user_id', allowedIds)
      .in('privacy', allowedPrivacies)
      .order('created_at', { ascending: false })
      .limit(PER_SOURCE),
    supabaseAdmin
      .from('club_members')
      .select('user_id, club_id, joined_at')
      .in('user_id', allowedIds)
      .order('joined_at', { ascending: false })
      .limit(PER_SOURCE),
    supabaseAdmin
      .from('discussions')
      .select('user_id, club_id, chapter, content, created_at')
      .in('user_id', allowedIds)
      .order('created_at', { ascending: false })
      .limit(PER_SOURCE),
  ]);
  for (const r of [ubResp, hlResp, cmResp, dcResp]) {
    if (r.error) {
      sendError(res, r.error.message, 500);
      return;
    }
  }
  const userBooks = (ubResp.data ?? []) as UserBookRow[];
  const highlights = (hlResp.data ?? []) as HighlightRow[];
  const clubMembers = (cmResp.data ?? []) as ClubMemberRow[];
  const discussions = (dcResp.data ?? []) as DiscussionRow[];

  // 4. Hydrate clubs and books.
  const clubIdSet = new Set<string>();
  for (const r of clubMembers) clubIdSet.add(r.club_id);
  for (const r of discussions) clubIdSet.add(r.club_id);
  const bookIdSet = new Set<string>();
  for (const r of userBooks) bookIdSet.add(r.book_id);
  for (const r of highlights) bookIdSet.add(r.book_id);

  let clubs: ClubRow[] = [];
  if (clubIdSet.size > 0) {
    const { data, error } = await supabaseAdmin
      .from('clubs')
      .select('id, name, book_id')
      .in('id', Array.from(clubIdSet));
    if (error) {
      sendError(res, error.message, 500);
      return;
    }
    clubs = (data ?? []) as ClubRow[];
    for (const c of clubs) if (c.book_id) bookIdSet.add(c.book_id);
  }

  let books: BookRow[] = [];
  if (bookIdSet.size > 0) {
    const { data, error } = await supabaseAdmin
      .from('books')
      .select('id, title, cover_url')
      .in('id', Array.from(bookIdSet));
    if (error) {
      sendError(res, error.message, 500);
      return;
    }
    books = (data ?? []) as BookRow[];
  }
  const bookById = new Map<string, BookRow>();
  for (const b of books) bookById.set(b.id, b);
  const clubById = new Map<string, ClubRow>();
  for (const c of clubs) clubById.set(c.id, c);

  // 5. Build event list
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
        data: {
          ...baseData,
          rating: ub.rating,
          review: ub.review,
          favorite_quote: ub.favorite_quote,
          finished_at: ub.finished_at,
        },
      });
    } else if (ub.status === 'reading') {
      events.push({
        type: 'started',
        user_id: ub.user_id,
        timestamp: ub.updated_at,
        data: { ...baseData, started_at: ub.started_at },
      });
    } else if (ub.status === 'want') {
      events.push({
        type: 'want',
        user_id: ub.user_id,
        timestamp: ub.updated_at,
        data: baseData,
      });
    } else if (ub.status === 'dnf') {
      events.push({
        type: 'dnf',
        user_id: ub.user_id,
        timestamp: ub.updated_at,
        data: baseData,
      });
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

  // 6. Sort desc by timestamp, trim, attach profile
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
});
