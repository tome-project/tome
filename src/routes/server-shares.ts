import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { selectOne, selectMany, upsertOne, query } from '../services/db';
import { sendSuccess, sendError } from '../utils';

export const serverSharesRouter = Router();

interface PublicProfileRow {
  user_id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
}

async function assertOwner(serverId: string, userId: string): Promise<boolean> {
  const row = await selectOne<{ id: string }>(
    'SELECT id FROM media_servers WHERE id = $1 AND owner_id = $2',
    [serverId, userId]
  );
  return !!row;
}

serverSharesRouter.get('/api/v1/servers/:id/shares', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const serverId = String(req.params.id);
  try {
    if (!(await assertOwner(serverId, me))) {
      sendError(res, 'Server not found', 404);
      return;
    }
    const shares = await selectMany<{ id: string; grantee_id: string; created_at: string }>(
      'SELECT id, grantee_id, created_at FROM server_shares WHERE media_server_id = $1',
      [serverId]
    );
    let profilesById = new Map<string, PublicProfileRow>();
    if (shares.length > 0) {
      const profiles = await selectMany<PublicProfileRow>(
        `SELECT user_id, handle, display_name, avatar_url
           FROM user_profiles WHERE user_id = ANY($1)`,
        [shares.map((s) => s.grantee_id)]
      );
      profilesById = new Map(profiles.map((p) => [p.user_id, p]));
    }
    sendSuccess(res, {
      shares: shares.map((s) => ({
        id: s.id,
        created_at: s.created_at,
        grantee: profilesById.get(s.grantee_id) ?? null,
      })),
    });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});

serverSharesRouter.post('/api/v1/servers/:id/shares', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const serverId = String(req.params.id);
  const raw = req.body?.handle;
  if (!raw || typeof raw !== 'string') {
    sendError(res, 'handle is required');
    return;
  }
  const handle = raw.toLowerCase().trim();
  try {
    if (!(await assertOwner(serverId, me))) {
      sendError(res, 'Server not found', 404);
      return;
    }
    const target = await selectOne<{ user_id: string }>(
      'SELECT user_id FROM user_profiles WHERE handle = $1',
      [handle]
    );
    if (!target) {
      sendError(res, 'No user with that handle', 404);
      return;
    }
    if (target.user_id === me) {
      sendError(res, "Can't share with yourself");
      return;
    }
    const [a, b] = [me, target.user_id].sort();
    const friendship = await selectOne<{ status: string }>(
      'SELECT status FROM friendships WHERE user_a_id = $1 AND user_b_id = $2',
      [a, b]
    );
    if (!friendship || friendship.status !== 'accepted') {
      sendError(res, 'You can only share with users in your circle', 403);
      return;
    }
    const data = await upsertOne(
      'server_shares',
      { media_server_id: serverId, grantee_id: target.user_id },
      { onConflict: 'media_server_id,grantee_id' }
    );
    sendSuccess(res, data, 201);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Insert failed', 500);
  }
});

serverSharesRouter.delete(
  '/api/v1/servers/:id/shares/:shareId',
  requireAuth,
  async (req: Request, res: Response) => {
    const me = req.userId!;
    const serverId = String(req.params.id);
    const shareId = String(req.params.shareId);
    try {
      if (!(await assertOwner(serverId, me))) {
        sendError(res, 'Server not found', 404);
        return;
      }
      const result = await query(
        'DELETE FROM server_shares WHERE id = $1 AND media_server_id = $2',
        [shareId, serverId]
      );
      if (!result.rowCount) {
        sendError(res, 'Share not found', 404);
        return;
      }
      sendSuccess(res, { id: shareId });
    } catch (err) {
      sendError(res, err instanceof Error ? err.message : 'Delete failed', 500);
    }
  }
);
