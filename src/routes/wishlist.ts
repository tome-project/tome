import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const wishlistRouter = Router();

// GET /api/v1/wishlist — list user's wishlist items
wishlistRouter.get('/api/v1/wishlist', requireAuth, async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('wishlist')
    .select('*')
    .eq('user_id', req.userId!)
    .order('added_at', { ascending: false });

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data);
});

// POST /api/v1/wishlist — add to wishlist
wishlistRouter.post('/api/v1/wishlist', requireAuth, async (req: Request, res: Response) => {
  const { title, author, cover_url, genre, priority, notes } = req.body;

  if (!title || !author) {
    sendError(res, 'title and author are required');
    return;
  }

  const validPriorities = ['low', 'medium', 'high'];
  if (priority !== undefined && !validPriorities.includes(priority)) {
    sendError(res, `priority must be one of: ${validPriorities.join(', ')}`);
    return;
  }

  const insert: Record<string, unknown> = {
    user_id: req.userId,
    title,
    author,
  };

  if (cover_url !== undefined) insert.cover_url = cover_url;
  if (genre !== undefined) insert.genre = genre;
  if (priority !== undefined) insert.priority = priority;
  if (notes !== undefined) insert.notes = notes;

  const { data, error } = await supabaseAdmin
    .from('wishlist')
    .insert(insert)
    .select()
    .single();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data, 201);
});

// PATCH /api/v1/wishlist/:id — update wishlist item
wishlistRouter.patch('/api/v1/wishlist/:id', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { title, author, cover_url, genre, priority, notes } = req.body;

  const updates: Record<string, unknown> = {};
  if (title !== undefined) updates.title = title;
  if (author !== undefined) updates.author = author;
  if (cover_url !== undefined) updates.cover_url = cover_url;
  if (genre !== undefined) updates.genre = genre;
  if (priority !== undefined) updates.priority = priority;
  if (notes !== undefined) updates.notes = notes;

  if (Object.keys(updates).length === 0) {
    sendError(res, 'No fields to update', 400);
    return;
  }

  const validPriorities = ['low', 'medium', 'high'];
  if (priority !== undefined && !validPriorities.includes(priority)) {
    sendError(res, `priority must be one of: ${validPriorities.join(', ')}`);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('wishlist')
    .update(updates)
    .eq('id', id)
    .eq('user_id', req.userId!)
    .select()
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      sendError(res, 'Wishlist item not found', 404);
      return;
    }
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data);
});

// DELETE /api/v1/wishlist/:id — remove from wishlist
wishlistRouter.delete('/api/v1/wishlist/:id', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;

  const { error } = await supabaseAdmin
    .from('wishlist')
    .delete()
    .eq('id', id)
    .eq('user_id', req.userId!);

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, { message: 'Wishlist item removed' });
});
