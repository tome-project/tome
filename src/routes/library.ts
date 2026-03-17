import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const libraryRouter = Router();

// GET /api/v1/library — list all books in the user's library
libraryRouter.get('/api/v1/library', requireAuth, async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('books')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data);
});

// POST /api/v1/library/books — add a book to the library
libraryRouter.post('/api/v1/library/books', requireAuth, async (req: Request, res: Response) => {
  const { title, author, cover_url, file_path, type } = req.body;

  if (!title || !author || !file_path || !type) {
    sendError(res, 'title, author, file_path, and type are required');
    return;
  }

  if (!['epub', 'audiobook'].includes(type)) {
    sendError(res, 'type must be "epub" or "audiobook"');
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('books')
    .insert({
      title,
      author,
      cover_url: cover_url || null,
      file_path,
      type,
      added_by: req.userId,
    })
    .select()
    .single();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data, 201);
});
