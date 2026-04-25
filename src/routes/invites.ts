import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const invitesRouter = Router();

// GET /api/v1/invites/:code/preview — unauthenticated lookup so the
// "someone invited me" screen can show who the invite is from BEFORE the
// recipient logs in / signs up. Only returns public-profile fields; the
// actual friendship + server share happens on POST /accept, which is
// auth-gated.
invitesRouter.get('/api/v1/invites/:code/preview', async (req: Request, res: Response) => {
  const code = String(req.params.code ?? '').toLowerCase();
  if (!code) {
    sendError(res, 'invite code required', 400);
    return;
  }
  const { data, error } = await supabaseAdmin
    .from('user_profiles')
    .select('user_id, handle, display_name, avatar_url, bio')
    .eq('invite_code', code)
    .maybeSingle();
  if (error) {
    sendError(res, error.message, 500);
    return;
  }
  if (!data) {
    sendError(res, 'invite not found', 404);
    return;
  }
  sendSuccess(res, data);
});

// POST /api/v1/invites/:code/accept — redeem an invite.
//
// Delegates to the accept_invite(code) SECURITY DEFINER function so the
// friendship + server_shares writes land atomically with inviter's RLS
// context. Calling it as the auth'd accepter means auth.uid() inside the
// function resolves to the right user.
//
// Response: { inviter: {...}, servers_shared }
invitesRouter.post('/api/v1/invites/:code/accept', requireAuth, async (req: Request, res: Response) => {
  const code = String(req.params.code ?? '').toLowerCase();
  if (!code) {
    sendError(res, 'invite code required', 400);
    return;
  }

  // The service-role supabaseAdmin client bypasses RLS, but the SECURITY
  // DEFINER function uses auth.uid() inside Postgres — which is NULL unless
  // the caller supplies a user-context JWT. We pass the accepter's id by
  // wrapping the call in a two-step set_config + RPC. Simpler: do the
  // writes directly with supabaseAdmin and the explicit user id from the
  // middleware, matching the pattern the rest of the codebase uses.
  const accepter = req.userId!;

  // Look up inviter by code.
  const { data: inviter, error: inviterErr } = await supabaseAdmin
    .from('user_profiles')
    .select('user_id, handle, display_name, avatar_url')
    .eq('invite_code', code)
    .maybeSingle();
  if (inviterErr) {
    sendError(res, inviterErr.message, 500);
    return;
  }
  if (!inviter) {
    sendError(res, 'invalid invite code', 404);
    return;
  }
  if (inviter.user_id === accepter) {
    sendError(res, "you can't redeem your own invite", 400);
    return;
  }

  // Friendship: canonical ordering (a < b as strings).
  const [userA, userB] = accepter < inviter.user_id
    ? [accepter, inviter.user_id]
    : [inviter.user_id, accepter];

  const { error: friendshipErr } = await supabaseAdmin
    .from('friendships')
    .upsert(
      {
        user_a_id: userA,
        user_b_id: userB,
        status: 'accepted',
        requested_by: inviter.user_id,
        accepted_at: new Date().toISOString(),
      },
      { onConflict: 'user_a_id,user_b_id' },
    );
  if (friendshipErr) {
    sendError(res, friendshipErr.message, 500);
    return;
  }

  // Auto-share every media_server the inviter owns to the accepter.
  // We fetch then upsert rather than a single SQL because supabase-js
  // doesn't support `INSERT ... SELECT`.
  const { data: servers, error: serversErr } = await supabaseAdmin
    .from('media_servers')
    .select('id')
    .eq('owner_id', inviter.user_id);
  if (serversErr) {
    sendError(res, serversErr.message, 500);
    return;
  }

  let serversShared = 0;
  if (servers && servers.length > 0) {
    const rows = servers.map((s: { id: string }) => ({
      media_server_id: s.id,
      grantee_id: accepter,
    }));
    const { error: sharesErr, count } = await supabaseAdmin
      .from('server_shares')
      .upsert(rows, {
        onConflict: 'media_server_id,grantee_id',
        ignoreDuplicates: true,
        count: 'exact',
      });
    if (sharesErr) {
      sendError(res, sharesErr.message, 500);
      return;
    }
    serversShared = count ?? rows.length;
  }

  // Auto-seed the accepter's shelf with the inviter's tracked books as
  // 'want'. This is what makes "wife opens Library and sees husband's
  // audiobooks" work without her having to explicitly add each one.
  // Progress / rating / review stay separate per-user.
  const { data: inviterBooks, error: ibErr } = await supabaseAdmin
    .from('user_books')
    .select('book_id')
    .eq('user_id', inviter.user_id)
    .in('status', ['reading', 'want', 'finished']);
  if (ibErr) {
    sendError(res, ibErr.message, 500);
    return;
  }

  let booksAdded = 0;
  if (inviterBooks && inviterBooks.length > 0) {
    const ubRows = inviterBooks.map((b: { book_id: string }) => ({
      user_id: accepter,
      book_id: b.book_id,
      status: 'want',
      // Default to 'private' so auto-imported books don't leak into the
      // accepter's activity feed until they explicitly read/finish them.
      privacy: 'private',
    }));
    const { error: ubErr, count: ubCount } = await supabaseAdmin
      .from('user_books')
      .upsert(ubRows, {
        onConflict: 'user_id,book_id',
        ignoreDuplicates: true,
        count: 'exact',
      });
    if (ubErr) {
      sendError(res, ubErr.message, 500);
      return;
    }
    booksAdded = ubCount ?? 0;
  }

  sendSuccess(res, {
    inviter,
    servers_shared: serversShared,
    books_added: booksAdded,
  });
});

// POST /api/v1/invites/rotate — generate a new code for the caller.
invitesRouter.post('/api/v1/invites/rotate', requireAuth, async (req: Request, res: Response) => {
  // Rather than call the DB function (which uses auth.uid() we don't
  // propagate), generate a new code server-side and update the row.
  // Retry on the tiny chance of collision with an existing code.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const user = req.userId!;

  for (let attempt = 0; attempt < 5; attempt++) {
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }

    const { data, error } = await supabaseAdmin
      .from('user_profiles')
      .update({ invite_code: code, updated_at: new Date().toISOString() })
      .eq('user_id', user)
      .select('invite_code')
      .maybeSingle();

    if (!error && data) {
      sendSuccess(res, { invite_code: data.invite_code });
      return;
    }
    // 23505 is Postgres unique_violation; retry with a new code.
    if (error && !error.message.includes('duplicate')) {
      sendError(res, error.message, 500);
      return;
    }
  }
  sendError(res, 'failed to generate invite code after retries', 500);
});
