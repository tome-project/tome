import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const libraryRouter = Router();

// GET /api/v1/library — list books with optional search/filter
libraryRouter.get('/api/v1/library', requireAuth, async (req: Request, res: Response) => {
  const { q, type, page } = req.query;
  const limit = 50;
  const offset = page ? (Number(page) - 1) * limit : 0;

  let query = supabaseAdmin
    .from('books')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  // Text search across title and author
  if (q && typeof q === 'string') {
    query = query.or(`title.ilike.%${q}%,author.ilike.%${q}%`);
  }

  // Filter by book type
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
