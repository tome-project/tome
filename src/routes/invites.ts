import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { selectOne, selectMany, upsertOne, upsertMany } from '../services/db';
import { sendSuccess, sendError } from '../utils';

export const invitesRouter = Router();

interface InviterProfile {
  user_id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
  bio?: string | null;
}

// GET /api/v1/invites/:code/preview — unauthenticated lookup
invitesRouter.get('/api/v1/invites/:code/preview', async (req: Request, res: Response) => {
  const code = String(req.params.code ?? '').toLowerCase();
  if (!code) {
    sendError(res, 'invite code required', 400);
    return;
  }
  try {
    const data = await selectOne<InviterProfile>(
      `SELECT user_id, handle, display_name, avatar_url, bio
         FROM user_profiles WHERE invite_code = $1`,
      [code]
    );
    if (!data) {
      sendError(res, 'invite not found', 404);
      return;
    }
    sendSuccess(res, data);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});

// POST /api/v1/invites/:code/accept — redeem an invite (atomic friendship +
// server_shares + auto-seed wishlist).
invitesRouter.post('/api/v1/invites/:code/accept', requireAuth, async (req: Request, res: Response) => {
  const code = String(req.params.code ?? '').toLowerCase();
  if (!code) {
    sendError(res, 'invite code required', 400);
    return;
  }
  const accepter = req.userId!;
  try {
    const inviter = await selectOne<InviterProfile>(
      `SELECT user_id, handle, display_name, avatar_url
         FROM user_profiles WHERE invite_code = $1`,
      [code]
    );
    if (!inviter) {
      sendError(res, 'invalid invite code', 404);
      return;
    }
    if (inviter.user_id === accepter) {
      sendError(res, "you can't redeem your own invite", 400);
      return;
    }

    const [userA, userB] = accepter < inviter.user_id
      ? [accepter, inviter.user_id]
      : [inviter.user_id, accepter];

    await upsertOne(
      'friendships',
      {
        user_a_id: userA,
        user_b_id: userB,
        status: 'accepted',
        requested_by: inviter.user_id,
        accepted_at: new Date().toISOString(),
      },
      { onConflict: 'user_a_id,user_b_id' }
    );

    // Auto-share every media_server the inviter owns to the accepter.
    const servers = await selectMany<{ id: string }>(
      'SELECT id FROM media_servers WHERE owner_id = $1',
      [inviter.user_id]
    );
    let serversShared = 0;
    if (servers.length > 0) {
      serversShared = await upsertMany(
        'server_shares',
        servers.map((s) => ({ media_server_id: s.id, grantee_id: accepter })),
        { onConflict: 'media_server_id,grantee_id', ignoreDuplicates: true }
      );
    }

    // Auto-seed the accepter's shelf with the inviter's tracked books as
    // 'want' / 'private'.
    const inviterBooks = await selectMany<{ book_id: string }>(
      `SELECT book_id FROM user_books
        WHERE user_id = $1 AND status IN ('reading', 'want', 'finished')`,
      [inviter.user_id]
    );
    let booksAdded = 0;
    if (inviterBooks.length > 0) {
      booksAdded = await upsertMany(
        'user_books',
        inviterBooks.map((b) => ({
          user_id: accepter,
          book_id: b.book_id,
          status: 'want',
          privacy: 'private',
        })),
        { onConflict: 'user_id,book_id', ignoreDuplicates: true }
      );
    }

    sendSuccess(res, { inviter, servers_shared: serversShared, books_added: booksAdded });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Accept failed', 500);
  }
});

// POST /api/v1/invites/rotate — generate a new code for the caller.
invitesRouter.post('/api/v1/invites/rotate', requireAuth, async (req: Request, res: Response) => {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const user = req.userId!;
  for (let attempt = 0; attempt < 5; attempt++) {
    let code = '';
    for (let i = 0; i < 8; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    try {
      const data = await selectOne<{ invite_code: string }>(
        `UPDATE user_profiles SET invite_code = $1, updated_at = now()
          WHERE user_id = $2 RETURNING invite_code`,
        [code, user]
      );
      if (data) {
        sendSuccess(res, { invite_code: data.invite_code });
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      // Postgres unique_violation; retry with a new code.
      if (!/duplicate|unique/i.test(message)) {
        sendError(res, message || 'Update failed', 500);
        return;
      }
    }
  }
  sendError(res, 'failed to generate invite code after retries', 500);
});
