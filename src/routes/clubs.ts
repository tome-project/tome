import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const clubsRouter = Router();

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

// GET /api/v1/clubs/:inviteCode — get club by invite code
clubsRouter.get('/api/v1/clubs/:inviteCode', async (req: Request, res: Response) => {
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
