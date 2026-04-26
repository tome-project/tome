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
