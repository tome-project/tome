import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const serverSharesRouter = Router();

interface PublicProfileRow {
  user_id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
}

// Ensure the caller owns the given server before we touch its shares.
async function assertOwner(serverId: string, userId: string) {
  const { data, error } = await supabaseAdmin
    .from('media_servers')
    .select('id')
    .eq('id', serverId)
    .eq('owner_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return !!data;
}

// GET /api/v1/servers/:id/shares — list grantees with their public profiles
serverSharesRouter.get('/api/v1/servers/:id/shares', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const serverId = String(req.params.id);

  if (!(await assertOwner(serverId, me))) {
    sendError(res, 'Server not found', 404);
    return;
  }

  const { data: shares, error } = await supabaseAdmin
    .from('server_shares')
    .select('id, grantee_id, created_at')
    .eq('media_server_id', serverId);
  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  const granteeIds = (shares ?? []).map((s) => s.grantee_id as string);
  let profilesById = new Map<string, PublicProfileRow>();
  if (granteeIds.length > 0) {
    const { data: profiles, error: pErr } = await supabaseAdmin
      .from('user_profiles')
      .select('user_id, handle, display_name, avatar_url')
      .in('user_id', granteeIds);
    if (pErr) {
      sendError(res, pErr.message, 500);
      return;
    }
    profilesById = new Map((profiles as PublicProfileRow[] | null ?? []).map((p) => [p.user_id, p]));
  }

  sendSuccess(res, {
    shares: (shares ?? []).map((s) => ({
      id: s.id,
      created_at: s.created_at,
      grantee: profilesById.get(s.grantee_id as string) ?? null,
    })),
  });
});

// POST /api/v1/servers/:id/shares — grant access to a friend
// Body: { handle }
serverSharesRouter.post('/api/v1/servers/:id/shares', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const serverId = String(req.params.id);
  const raw = req.body?.handle;
  if (!raw || typeof raw !== 'string') {
    sendError(res, 'handle is required');
    return;
  }
  const handle = raw.toLowerCase().trim();

  if (!(await assertOwner(serverId, me))) {
    sendError(res, 'Server not found', 404);
    return;
  }

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
    sendError(res, "Can't share with yourself");
    return;
  }

  // Require an accepted friendship before granting access — keeps the sharing
  // surface inside the "circle" concept rather than spraying links at strangers.
  const [a, b] = [me, target.user_id].sort();
  const { data: friendship } = await supabaseAdmin
    .from('friendships')
    .select('status')
    .eq('user_a_id', a)
    .eq('user_b_id', b)
    .maybeSingle();
  if (!friendship || friendship.status !== 'accepted') {
    sendError(res, 'You can only share with users in your circle', 403);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('server_shares')
    .upsert(
      { media_server_id: serverId, grantee_id: target.user_id },
      { onConflict: 'media_server_id,grantee_id', ignoreDuplicates: false }
    )
    .select()
    .single();
  if (error) {
    sendError(res, error.message, 500);
    return;
  }
  sendSuccess(res, data, 201);
});

// DELETE /api/v1/servers/:id/shares/:shareId — revoke a grant
serverSharesRouter.delete(
  '/api/v1/servers/:id/shares/:shareId',
  requireAuth,
  async (req: Request, res: Response) => {
    const me = req.userId!;
    const serverId = String(req.params.id);
    const shareId = String(req.params.shareId);

    if (!(await assertOwner(serverId, me))) {
      sendError(res, 'Server not found', 404);
      return;
    }

    const { error, count } = await supabaseAdmin
      .from('server_shares')
      .delete({ count: 'exact' })
      .eq('id', shareId)
      .eq('media_server_id', serverId);
    if (error) {
      sendError(res, error.message, 500);
      return;
    }
    if (!count) {
      sendError(res, 'Share not found', 404);
      return;
    }
    sendSuccess(res, { id: shareId });
  }
);
