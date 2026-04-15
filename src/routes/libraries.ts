import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const librariesRouter = Router();

// GET /api/v1/libraries — list libraries the user can access
librariesRouter.get('/api/v1/libraries', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;

  // Get libraries the user owns
  const { data: owned, error: ownedErr } = await supabaseAdmin
    .from('libraries')
    .select('*')
    .eq('owner_id', userId)
    .order('created_at', { ascending: true });

  if (ownedErr) {
    sendError(res, ownedErr.message, 500);
    return;
  }

  // Get libraries the user is a member of (but doesn't own)
  const { data: memberships, error: memberErr } = await supabaseAdmin
    .from('library_members')
    .select('library_id')
    .eq('user_id', userId)
    .eq('role', 'member');

  if (memberErr) {
    sendError(res, memberErr.message, 500);
    return;
  }

  const memberLibraryIds = (memberships || []).map((m: { library_id: string }) => m.library_id);

  let shared: any[] = [];
  if (memberLibraryIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from('libraries')
      .select('*')
      .in('id', memberLibraryIds)
      .order('created_at', { ascending: true });

    if (error) {
      sendError(res, error.message, 500);
      return;
    }
    shared = data || [];
  }

  sendSuccess(res, {
    owned: owned || [],
    shared,
  });
});

// POST /api/v1/libraries — create a new library
librariesRouter.post('/api/v1/libraries', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { name, description, is_public } = req.body;

  if (!name) {
    sendError(res, 'Library name is required');
    return;
  }

  const inviteCode = crypto.randomBytes(6).toString('hex');

  const { data, error } = await supabaseAdmin
    .from('libraries')
    .insert({
      owner_id: userId,
      name,
      description: description || null,
      invite_code: inviteCode,
      is_public: is_public || false,
    })
    .select()
    .single();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  // Add owner as a member with 'owner' role
  await supabaseAdmin.from('library_members').insert({
    library_id: data.id,
    user_id: userId,
    role: 'owner',
  });

  sendSuccess(res, data, 201);
});

// GET /api/v1/libraries/:id — get library details with book count
librariesRouter.get('/api/v1/libraries/:id', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { id } = req.params;

  const { data: library, error } = await supabaseAdmin
    .from('libraries')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !library) {
    sendError(res, 'Library not found', 404);
    return;
  }

  // Check access
  const hasAccess = library.owner_id === userId || library.is_public;
  if (!hasAccess) {
    const { data: membership } = await supabaseAdmin
      .from('library_members')
      .select('id')
      .eq('library_id', id)
      .eq('user_id', userId)
      .single();

    if (!membership) {
      sendError(res, 'Access denied', 403);
      return;
    }
  }

  // Get book count
  const { count } = await supabaseAdmin
    .from('books')
    .select('*', { count: 'exact', head: true })
    .eq('library_id', id);

  // Get member count
  const { count: memberCount } = await supabaseAdmin
    .from('library_members')
    .select('*', { count: 'exact', head: true })
    .eq('library_id', id);

  sendSuccess(res, {
    ...library,
    book_count: count || 0,
    member_count: memberCount || 0,
  });
});

// PATCH /api/v1/libraries/:id — update library details
librariesRouter.patch('/api/v1/libraries/:id', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { id } = req.params;

  // Only owner can update
  const { data: library } = await supabaseAdmin
    .from('libraries')
    .select('owner_id')
    .eq('id', id)
    .single();

  if (!library || library.owner_id !== userId) {
    sendError(res, 'Only the library owner can update it', 403);
    return;
  }

  const updates: Record<string, any> = {};
  const { name, description, is_public } = req.body;
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (is_public !== undefined) updates.is_public = is_public;

  const { data, error } = await supabaseAdmin
    .from('libraries')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data);
});

// GET /api/v1/libraries/join/:inviteCode — preview a library by invite code
librariesRouter.get('/api/v1/libraries/join/:inviteCode', requireAuth, async (req: Request, res: Response) => {
  const { inviteCode } = req.params;

  const { data: library, error } = await supabaseAdmin
    .from('libraries')
    .select('id, name, description, owner_id, created_at')
    .eq('invite_code', inviteCode)
    .single();

  if (error || !library) {
    sendError(res, 'Invalid invite code', 404);
    return;
  }

  // Get book count for preview
  const { count } = await supabaseAdmin
    .from('books')
    .select('*', { count: 'exact', head: true })
    .eq('library_id', library.id);

  sendSuccess(res, {
    ...library,
    book_count: count || 0,
  });
});

// POST /api/v1/libraries/join/:inviteCode — join a library by invite code
librariesRouter.post('/api/v1/libraries/join/:inviteCode', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { inviteCode } = req.params;

  const { data: library, error: libErr } = await supabaseAdmin
    .from('libraries')
    .select('id, owner_id, name')
    .eq('invite_code', inviteCode)
    .single();

  if (libErr || !library) {
    sendError(res, 'Invalid invite code', 404);
    return;
  }

  if (library.owner_id === userId) {
    sendError(res, 'You already own this library');
    return;
  }

  // Check if already a member
  const { data: existing } = await supabaseAdmin
    .from('library_members')
    .select('id')
    .eq('library_id', library.id)
    .eq('user_id', userId)
    .single();

  if (existing) {
    sendError(res, 'You are already a member of this library');
    return;
  }

  const { error: joinErr } = await supabaseAdmin
    .from('library_members')
    .insert({
      library_id: library.id,
      user_id: userId,
      role: 'member',
    });

  if (joinErr) {
    sendError(res, joinErr.message, 500);
    return;
  }

  sendSuccess(res, { library_id: library.id, name: library.name, message: 'Joined successfully' }, 201);
});

// GET /api/v1/libraries/:id/members — list members of a library
librariesRouter.get('/api/v1/libraries/:id/members', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;

  const { data, error } = await supabaseAdmin
    .from('library_members')
    .select('user_id, role, joined_at')
    .eq('library_id', id)
    .order('joined_at', { ascending: true });

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data || []);
});

// DELETE /api/v1/libraries/:id/members/:userId — remove a member (owner only)
librariesRouter.delete('/api/v1/libraries/:id/members/:memberId', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { id, memberId } = req.params;

  // Check ownership
  const { data: library } = await supabaseAdmin
    .from('libraries')
    .select('owner_id')
    .eq('id', id)
    .single();

  if (!library) {
    sendError(res, 'Library not found', 404);
    return;
  }

  // Allow owner to remove anyone, or users to remove themselves
  if (library.owner_id !== userId && memberId !== userId) {
    sendError(res, 'Only the library owner can remove members', 403);
    return;
  }

  const { error } = await supabaseAdmin
    .from('library_members')
    .delete()
    .eq('library_id', id)
    .eq('user_id', memberId);

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, { message: 'Member removed' });
});

// GET /api/v1/libraries/:id/books — list books in a specific library
librariesRouter.get('/api/v1/libraries/:id/books', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { q, type, page } = req.query;
  const limit = 50;
  const offset = page ? (Number(page) - 1) * limit : 0;

  let query = supabaseAdmin
    .from('books')
    .select('*', { count: 'exact' })
    .eq('library_id', id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (q && typeof q === 'string') {
    query = query.or(`title.ilike.%${q}%,author.ilike.%${q}%`);
  }

  if (type && typeof type === 'string') {
    query = query.eq('type', type);
  }

  const { data, error, count } = await query;

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, { books: data, total: count });
});
