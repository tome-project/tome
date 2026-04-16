import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
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

// GET /api/v1/friendships — grouped view of the current user's circle + pending requests
friendshipsRouter.get('/api/v1/friendships', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;

  const { data: friendships, error } = await supabaseAdmin
    .from('friendships')
    .select('*')
    .or(`user_a_id.eq.${me},user_b_id.eq.${me}`);
  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  const rows = (friendships ?? []) as FriendshipRow[];
  const otherIds = Array.from(new Set(rows.map((r) => (r.user_a_id === me ? r.user_b_id : r.user_a_id))));

  let profilesById = new Map<string, PublicProfileRow>();
  if (otherIds.length > 0) {
    const { data: profiles, error: pErr } = await supabaseAdmin
      .from('user_profiles')
      .select('user_id, handle, display_name, bio, avatar_url')
      .in('user_id', otherIds);
    if (pErr) {
      sendError(res, pErr.message, 500);
      return;
    }
    profilesById = new Map((profiles as PublicProfileRow[] | null ?? []).map((p) => [p.user_id, p]));
  }

  const decorated = rows.map((r) => ({
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
});

// POST /api/v1/friendships/request — send a friend request by handle
// Body: { handle: string }
friendshipsRouter.post('/api/v1/friendships/request', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const raw = req.body?.handle;
  if (!raw || typeof raw !== 'string') {
    sendError(res, 'handle is required');
    return;
  }
  const handle = raw.toLowerCase().trim();

  const { data: target, error: lookupErr } = await supabaseAdmin
    .from('user_profiles')
    .select('user_id')
    .eq('handle', handle)
    .maybeSingle();
  if (lookupErr) {
    sendError(res, lookupErr.message, 500);
    return;
  }
  if (!target) {
    sendError(res, 'No user with that handle', 404);
    return;
  }
  if (target.user_id === me) {
    sendError(res, "Can't befriend yourself");
    return;
  }

  const [user_a_id, user_b_id] = [me, target.user_id].sort();

  // Check existing
  const { data: existing, error: existErr } = await supabaseAdmin
    .from('friendships')
    .select('*')
    .eq('user_a_id', user_a_id)
    .eq('user_b_id', user_b_id)
    .maybeSingle();
  if (existErr) {
    sendError(res, existErr.message, 500);
    return;
  }

  if (existing) {
    const row = existing as FriendshipRow;
    if (row.status === 'accepted') {
      sendError(res, 'Already friends', 409);
      return;
    }
    if (row.status === 'blocked') {
      sendError(res, 'Cannot send a request to this user', 403);
      return;
    }
    // Pending. If the other user had already requested, treat this as an accept.
    if (row.status === 'pending' && row.requested_by !== me) {
      const { data: accepted, error: accErr } = await supabaseAdmin
        .from('friendships')
        .update({ status: 'accepted', accepted_at: new Date().toISOString() })
        .eq('id', row.id)
        .select()
        .single();
      if (accErr) {
        sendError(res, accErr.message, 500);
        return;
      }
      sendSuccess(res, accepted, 200);
      return;
    }
    // Already pending request from me
    sendError(res, 'Request already sent', 409);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('friendships')
    .insert({
      user_a_id,
      user_b_id,
      status: 'pending',
      requested_by: me,
    })
    .select()
    .single();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }
  sendSuccess(res, data, 201);
});

// POST /api/v1/friendships/:id/accept — accept a pending incoming request
friendshipsRouter.post('/api/v1/friendships/:id/accept', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const id = String(req.params.id);

  const { data: row, error: fetchErr } = await supabaseAdmin
    .from('friendships')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (fetchErr) {
    sendError(res, fetchErr.message, 500);
    return;
  }
  if (!row) {
    sendError(res, 'Friendship not found', 404);
    return;
  }

  const f = row as FriendshipRow;
  if (f.user_a_id !== me && f.user_b_id !== me) {
    sendError(res, 'Not your friendship', 403);
    return;
  }
  if (f.requested_by === me) {
    sendError(res, "Can't accept your own request");
    return;
  }
  if (f.status !== 'pending') {
    sendError(res, `Cannot accept a ${f.status} friendship`);
    return;
  }

  const { data: accepted, error: accErr } = await supabaseAdmin
    .from('friendships')
    .update({ status: 'accepted', accepted_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (accErr) {
    sendError(res, accErr.message, 500);
    return;
  }
  sendSuccess(res, accepted);
});

// POST /api/v1/friendships/:id/decline — decline/cancel a pending request (deletes the row)
friendshipsRouter.post('/api/v1/friendships/:id/decline', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const id = String(req.params.id);

  const { data: row, error: fetchErr } = await supabaseAdmin
    .from('friendships')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (fetchErr) {
    sendError(res, fetchErr.message, 500);
    return;
  }
  if (!row) {
    sendError(res, 'Friendship not found', 404);
    return;
  }

  const f = row as FriendshipRow;
  if (f.user_a_id !== me && f.user_b_id !== me) {
    sendError(res, 'Not your friendship', 403);
    return;
  }
  if (f.status !== 'pending') {
    sendError(res, `Cannot decline a ${f.status} friendship`);
    return;
  }

  const { error: delErr } = await supabaseAdmin.from('friendships').delete().eq('id', id);
  if (delErr) {
    sendError(res, delErr.message, 500);
    return;
  }
  sendSuccess(res, { id });
});

// DELETE /api/v1/friendships/:id — unfriend (for accepted friendships)
friendshipsRouter.delete('/api/v1/friendships/:id', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const id = String(req.params.id);

  const { data: row, error: fetchErr } = await supabaseAdmin
    .from('friendships')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (fetchErr) {
    sendError(res, fetchErr.message, 500);
    return;
  }
  if (!row) {
    sendError(res, 'Friendship not found', 404);
    return;
  }

  const f = row as FriendshipRow;
  if (f.user_a_id !== me && f.user_b_id !== me) {
    sendError(res, 'Not your friendship', 403);
    return;
  }

  const { error: delErr } = await supabaseAdmin.from('friendships').delete().eq('id', id);
  if (delErr) {
    sendError(res, delErr.message, 500);
    return;
  }
  sendSuccess(res, { id });
});
