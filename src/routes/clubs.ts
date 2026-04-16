import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const clubsRouter = Router();

// GET /api/v1/clubs — list clubs the current user is a member of
clubsRouter.get('/api/v1/clubs', requireAuth, async (req: Request, res: Response) => {
  // Get all club IDs the user is a member of
  const { data: memberships, error: memberError } = await supabaseAdmin
    .from('club_members')
    .select('club_id')
    .eq('user_id', req.userId!);

  if (memberError) {
    sendError(res, memberError.message, 500);
    return;
  }

  if (!memberships || memberships.length === 0) {
    sendSuccess(res, []);
    return;
  }

  const clubIds = memberships.map((m) => m.club_id);

  const { data, error } = await supabaseAdmin
    .from('clubs')
    .select(`
      *,
      club_members (
        user_id,
        joined_at
      )
    `)
    .in('id', clubIds)
    .order('created_at', { ascending: false });

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data);
});

// POST /api/v1/clubs — create a club
clubsRouter.post('/api/v1/clubs', requireAuth, async (req: Request, res: Response) => {
  const { name, book_id, start_date, end_date } = req.body;

  if (!name || !book_id) {
    sendError(res, 'name and book_id are required');
    return;
  }

  const inviteCode = crypto.randomBytes(6).toString('hex');

  const { data: club, error: clubError } = await supabaseAdmin
    .from('clubs')
    .insert({
      name,
      book_id,
      host_id: req.userId,
      invite_code: inviteCode,
      start_date: start_date || new Date().toISOString(),
      end_date: end_date || null,
    })
    .select()
    .single();

  if (clubError) {
    sendError(res, clubError.message, 500);
    return;
  }

  // Auto-add host as a member
  await supabaseAdmin.from('club_members').insert({
    club_id: club.id,
    user_id: req.userId,
  });

  sendSuccess(res, club, 201);
});

// GET /api/v1/clubs/invite/:inviteCode — get club by invite code
clubsRouter.get('/api/v1/clubs/invite/:inviteCode', async (req: Request, res: Response) => {
  const { inviteCode } = req.params;

  const { data, error } = await supabaseAdmin
    .from('clubs')
    .select(`
      *,
      club_members (
        user_id,
        joined_at
      )
    `)
    .eq('invite_code', inviteCode)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      sendError(res, 'Club not found', 404);
      return;
    }
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data);
});

// GET /api/v1/clubs/:id — hydrated club detail (club + members with public profiles)
clubsRouter.get('/api/v1/clubs/:id', requireAuth, async (req: Request, res: Response) => {
  const id = String(req.params.id);

  const { data: club, error: clubErr } = await supabaseAdmin
    .from('clubs')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (clubErr) {
    sendError(res, clubErr.message, 500);
    return;
  }
  if (!club) {
    sendError(res, 'Club not found', 404);
    return;
  }

  // Only members can see club detail (including invite_code).
  const { data: ownMembership } = await supabaseAdmin
    .from('club_members')
    .select('id')
    .eq('club_id', id)
    .eq('user_id', req.userId!)
    .maybeSingle();
  if (!ownMembership) {
    sendError(res, 'Not a member of this club', 403);
    return;
  }

  const { data: memberRows, error: membersErr } = await supabaseAdmin
    .from('club_members')
    .select('id, user_id, role, joined_at')
    .eq('club_id', id);
  if (membersErr) {
    sendError(res, membersErr.message, 500);
    return;
  }

  const userIds = (memberRows ?? []).map((m) => m.user_id as string);
  const profilesById = new Map<string, Record<string, unknown>>();
  if (userIds.length > 0) {
    const { data: profiles } = await supabaseAdmin
      .from('user_profiles')
      .select('user_id, handle, display_name, avatar_url')
      .in('user_id', userIds);
    for (const p of profiles ?? []) {
      profilesById.set(p.user_id as string, p as Record<string, unknown>);
    }
  }

  const members = (memberRows ?? []).map((m) => ({
    id: m.id,
    user_id: m.user_id,
    role: m.role,
    joined_at: m.joined_at,
    profile: profilesById.get(m.user_id as string) ?? null,
  }));

  sendSuccess(res, { club, members });
});

// DELETE /api/v1/clubs/:id — host deletes the club (cascades to members + discussions)
clubsRouter.delete('/api/v1/clubs/:id', requireAuth, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { data: club, error: fetchErr } = await supabaseAdmin
    .from('clubs')
    .select('host_id')
    .eq('id', id)
    .maybeSingle();
  if (fetchErr) {
    sendError(res, fetchErr.message, 500);
    return;
  }
  if (!club) {
    sendError(res, 'Club not found', 404);
    return;
  }
  if (club.host_id !== req.userId) {
    sendError(res, 'Only the host can delete this club', 403);
    return;
  }

  const { error } = await supabaseAdmin.from('clubs').delete().eq('id', id);
  if (error) {
    sendError(res, error.message, 500);
    return;
  }
  sendSuccess(res, { id });
});

// POST /api/v1/clubs/:id/leave — remove own membership. Hosts must delete
// the club instead (otherwise they'd leave a club they own with discussions
// that can't be posted in).
clubsRouter.post('/api/v1/clubs/:id/leave', requireAuth, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const me = req.userId!;

  const { data: club, error: fetchErr } = await supabaseAdmin
    .from('clubs')
    .select('host_id')
    .eq('id', id)
    .maybeSingle();
  if (fetchErr) {
    sendError(res, fetchErr.message, 500);
    return;
  }
  if (!club) {
    sendError(res, 'Club not found', 404);
    return;
  }
  if (club.host_id === me) {
    sendError(res, "Hosts can't leave their own club — delete it instead", 400);
    return;
  }

  const { error, count } = await supabaseAdmin
    .from('club_members')
    .delete({ count: 'exact' })
    .eq('club_id', id)
    .eq('user_id', me);
  if (error) {
    sendError(res, error.message, 500);
    return;
  }
  if (!count) {
    sendError(res, 'Not a member of this club', 404);
    return;
  }
  sendSuccess(res, { id });
});

// POST /api/v1/clubs/:id/join — join a club
clubsRouter.post('/api/v1/clubs/:id/join', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;

  // Check club exists
  const { data: club, error: clubError } = await supabaseAdmin
    .from('clubs')
    .select('id')
    .eq('id', id)
    .single();

  if (clubError || !club) {
    sendError(res, 'Club not found', 404);
    return;
  }

  // Check if already a member
  const { data: existing } = await supabaseAdmin
    .from('club_members')
    .select('id')
    .eq('club_id', id)
    .eq('user_id', req.userId!)
    .single();

  if (existing) {
    sendError(res, 'Already a member of this club');
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('club_members')
    .insert({
      club_id: id,
      user_id: req.userId,
    })
    .select()
    .single();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data, 201);
});
