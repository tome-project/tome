import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { selectOne, selectMany, insertOne, query, deleteWhere } from '../services/db';
import { sendSuccess, sendError } from '../utils';

export const friendshipsRouter = Router();

type FriendshipStatus = 'pending' | 'accepted' | 'blocked';

interface FriendshipRow {
  id: string;
  user_a_id: string;
  user_b_id: string;
  status: FriendshipStatus;
  requested_by: string;
  requested_at: string;
  accepted_at: string | null;
}

interface PublicProfileRow {
  user_id: string;
  handle: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
}

// GET /api/v1/friendships/incoming-count — count of pending requests waiting
// on me. Cheap dedicated endpoint so the bottom-nav badge can poll without
// hauling the full /friendships payload (3 groups + decorated profiles).
friendshipsRouter.get(
  '/api/v1/friendships/incoming-count',
  requireAuth,
  async (req: Request, res: Response) => {
    const me = req.userId!;
    try {
      const row = await selectOne<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM friendships
          WHERE status = 'pending'
            AND (user_a_id = $1 OR user_b_id = $1)
            AND requested_by <> $1`,
        [me]
      );
      sendSuccess(res, { count: Number(row?.count ?? 0) });
    } catch (err) {
      sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
    }
  }
);

// GET /api/v1/friendships/suggestions — "people you may know" via friends-of-
// friends. Returns up to 10 candidates, sorted by mutual-count desc. Excludes
// anyone already in any friendship row with me (accepted, pending either
// direction, or blocked) so the list is purely actionable.
//
// The query is two passes for clarity: first pull my circle, then pull each
// circle-member's circle and aggregate. Linear in (my circle × their circles)
// which is fine at v1 scale (<<1k friends-of-friends per user). If this gets
// hot we can replace with a single recursive CTE.
friendshipsRouter.get(
  '/api/v1/friendships/suggestions',
  requireAuth,
  async (req: Request, res: Response) => {
    const me = req.userId!;
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 10));
    try {
      const myFriends = await selectMany<{ other_id: string }>(
        `SELECT CASE WHEN user_a_id = $1 THEN user_b_id ELSE user_a_id END AS other_id
           FROM friendships
          WHERE status = 'accepted' AND (user_a_id = $1 OR user_b_id = $1)`,
        [me]
      );
      const friendIds = myFriends.map((r) => r.other_id);
      if (friendIds.length === 0) {
        sendSuccess(res, { items: [] });
        return;
      }

      // Excluded set = me + my circle + anyone I have a pending/blocked row
      // with. That second set isn't covered by friendIds (those are only the
      // accepted ones).
      const myAnyEdges = await selectMany<{ other_id: string }>(
        `SELECT CASE WHEN user_a_id = $1 THEN user_b_id ELSE user_a_id END AS other_id
           FROM friendships
          WHERE user_a_id = $1 OR user_b_id = $1`,
        [me]
      );
      const excluded = new Set<string>([me, ...myAnyEdges.map((r) => r.other_id)]);

      // Pull friends-of-friends and tally how many of my friends each candidate
      // shares with me. SQL aggregates this in one shot.
      const candidates = await selectMany<{
        candidate_id: string;
        mutual_count: string;
      }>(
        `SELECT candidate_id, COUNT(*)::text AS mutual_count FROM (
           SELECT
             CASE WHEN user_a_id = ANY($1) THEN user_b_id ELSE user_a_id END AS candidate_id
           FROM friendships
           WHERE status = 'accepted'
             AND (user_a_id = ANY($1) OR user_b_id = ANY($1))
         ) AS edges
         WHERE candidate_id <> ALL($2::uuid[])
         GROUP BY candidate_id
         ORDER BY mutual_count DESC, candidate_id ASC
         LIMIT $3`,
        [friendIds, Array.from(excluded), limit]
      );

      if (candidates.length === 0) {
        sendSuccess(res, { items: [] });
        return;
      }

      const profiles = await selectMany<PublicProfileRow & { activity_privacy: string }>(
        `SELECT user_id, handle, display_name, bio, avatar_url, activity_privacy
           FROM user_profiles WHERE user_id = ANY($1)`,
        [candidates.map((c) => c.candidate_id)]
      );
      const profById = new Map(profiles.map((p) => [p.user_id, p]));

      const items = candidates
        .map((c) => {
          const p = profById.get(c.candidate_id);
          if (!p) return null;
          return {
            user_id: p.user_id,
            handle: p.handle,
            display_name: p.display_name,
            avatar_url: p.avatar_url,
            mutual_count: Number(c.mutual_count),
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      sendSuccess(res, { items });
    } catch (err) {
      sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
    }
  }
);

// GET /api/v1/friendships/mutual/:userId — count + list of mutual friends
// between me and another user. Used by the public-profile "X mutual friends"
// pill so users have social-graph context before deciding to add someone.
friendshipsRouter.get(
  '/api/v1/friendships/mutual/:userId',
  requireAuth,
  async (req: Request, res: Response) => {
    const me = req.userId!;
    const them = String(req.params.userId);
    if (me === them) {
      sendSuccess(res, { count: 0, items: [] });
      return;
    }
    try {
      const rows = await selectMany<{ user_id: string }>(
        `SELECT user_id FROM (
           SELECT CASE WHEN user_a_id = $1 THEN user_b_id ELSE user_a_id END AS user_id
             FROM friendships
            WHERE status = 'accepted' AND (user_a_id = $1 OR user_b_id = $1)
           INTERSECT
           SELECT CASE WHEN user_a_id = $2 THEN user_b_id ELSE user_a_id END AS user_id
             FROM friendships
            WHERE status = 'accepted' AND (user_a_id = $2 OR user_b_id = $2)
         ) AS mutual`,
        [me, them]
      );
      if (rows.length === 0) {
        sendSuccess(res, { count: 0, items: [] });
        return;
      }
      // Profile lookup is capped at 6 since the UI only shows a few avatars
      // anyway; full count is still in `count`.
      const idsForPreview = rows.slice(0, 6).map((r) => r.user_id);
      const profiles = await selectMany<PublicProfileRow>(
        `SELECT user_id, handle, display_name, bio, avatar_url
           FROM user_profiles WHERE user_id = ANY($1)`,
        [idsForPreview]
      );
      sendSuccess(res, { count: rows.length, items: profiles });
    } catch (err) {
      sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
    }
  }
);

friendshipsRouter.get('/api/v1/friendships', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  try {
    const friendships = await selectMany<FriendshipRow>(
      'SELECT * FROM friendships WHERE user_a_id = $1 OR user_b_id = $1',
      [me]
    );
    const otherIds = Array.from(new Set(friendships.map((r) => (r.user_a_id === me ? r.user_b_id : r.user_a_id))));

    let profilesById = new Map<string, PublicProfileRow>();
    if (otherIds.length > 0) {
      const profiles = await selectMany<PublicProfileRow>(
        `SELECT user_id, handle, display_name, bio, avatar_url
           FROM user_profiles WHERE user_id = ANY($1)`,
        [otherIds]
      );
      profilesById = new Map(profiles.map((p) => [p.user_id, p]));
    }

    const decorated = friendships.map((r) => ({
      id: r.id,
      status: r.status,
      requested_by_me: r.requested_by === me,
      requested_at: r.requested_at,
      accepted_at: r.accepted_at,
      other: profilesById.get(r.user_a_id === me ? r.user_b_id : r.user_a_id) ?? null,
    }));

    sendSuccess(res, {
      circle: decorated.filter((d) => d.status === 'accepted'),
      incoming: decorated.filter((d) => d.status === 'pending' && !d.requested_by_me),
      outgoing: decorated.filter((d) => d.status === 'pending' && d.requested_by_me),
    });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});

friendshipsRouter.post('/api/v1/friendships/request', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const raw = req.body?.handle;
  if (!raw || typeof raw !== 'string') {
    sendError(res, 'handle is required');
    return;
  }
  const handle = raw.toLowerCase().trim();

  try {
    const target = await selectOne<{ user_id: string }>(
      'SELECT user_id FROM user_profiles WHERE handle = $1',
      [handle]
    );
    if (!target) { sendError(res, 'No user with that handle', 404); return; }
    if (target.user_id === me) { sendError(res, "Can't befriend yourself"); return; }

    const [user_a_id, user_b_id] = [me, target.user_id].sort();
    const existing = await selectOne<FriendshipRow>(
      'SELECT * FROM friendships WHERE user_a_id = $1 AND user_b_id = $2',
      [user_a_id, user_b_id]
    );

    if (existing) {
      if (existing.status === 'accepted') {
        sendError(res, 'Already friends', 409);
        return;
      }
      if (existing.status === 'blocked') {
        sendError(res, 'Cannot send a request to this user', 403);
        return;
      }
      if (existing.status === 'pending' && existing.requested_by !== me) {
        const accepted = await selectOne<FriendshipRow>(
          `UPDATE friendships SET status = 'accepted', accepted_at = $1
            WHERE id = $2 RETURNING *`,
          [new Date().toISOString(), existing.id]
        );
        sendSuccess(res, accepted, 200);
        return;
      }
      sendError(res, 'Request already sent', 409);
      return;
    }

    const data = await insertOne<FriendshipRow>('friendships', {
      user_a_id,
      user_b_id,
      status: 'pending',
      requested_by: me,
    });
    sendSuccess(res, data, 201);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Insert failed', 500);
  }
});

async function loadFriendship(id: string): Promise<FriendshipRow | null> {
  return selectOne<FriendshipRow>('SELECT * FROM friendships WHERE id = $1', [id]);
}

friendshipsRouter.post('/api/v1/friendships/:id/accept', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const id = String(req.params.id);
  try {
    const f = await loadFriendship(id);
    if (!f) { sendError(res, 'Friendship not found', 404); return; }
    if (f.user_a_id !== me && f.user_b_id !== me) { sendError(res, 'Not your friendship', 403); return; }
    if (f.requested_by === me) { sendError(res, "Can't accept your own request"); return; }
    if (f.status !== 'pending') { sendError(res, `Cannot accept a ${f.status} friendship`); return; }

    const accepted = await selectOne<FriendshipRow>(
      `UPDATE friendships SET status = 'accepted', accepted_at = $1
        WHERE id = $2 RETURNING *`,
      [new Date().toISOString(), id]
    );
    sendSuccess(res, accepted);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Update failed', 500);
  }
});

friendshipsRouter.post('/api/v1/friendships/:id/decline', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const id = String(req.params.id);
  try {
    const f = await loadFriendship(id);
    if (!f) { sendError(res, 'Friendship not found', 404); return; }
    if (f.user_a_id !== me && f.user_b_id !== me) { sendError(res, 'Not your friendship', 403); return; }
    if (f.status !== 'pending') { sendError(res, `Cannot decline a ${f.status} friendship`); return; }
    await deleteWhere('friendships', { id });
    sendSuccess(res, { id });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Delete failed', 500);
  }
});

friendshipsRouter.delete('/api/v1/friendships/:id', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const id = String(req.params.id);
  try {
    const f = await loadFriendship(id);
    if (!f) { sendError(res, 'Friendship not found', 404); return; }
    if (f.user_a_id !== me && f.user_b_id !== me) { sendError(res, 'Not your friendship', 403); return; }
    await deleteWhere('friendships', { id });
    sendSuccess(res, { id });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Delete failed', 500);
  }
});

void query;
