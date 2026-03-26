import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const booksRouter = Router();

// GET /api/v1/books/:id — get book detail
booksRouter.get('/api/v1/books/:id', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;

  const { data, error } = await supabaseAdmin
    .from('books')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      sendError(res, 'Book not found', 404);
      return;
    }
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data);
});

// PATCH /api/v1/books/:id — update book
booksRouter.patch('/api/v1/books/:id', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { title, author, cover_url, type, genre, page_count, description, publisher, series_name, series_number } = req.body;

  const updates: Record<string, unknown> = {};
  if (title !== undefined) updates.title = title;
  if (author !== undefined) updates.author = author;
  if (cover_url !== undefined) updates.cover_url = cover_url;
  if (type !== undefined) updates.type = type;
  if (genre !== undefined) updates.genre = genre;
  if (page_count !== undefined) updates.page_count = page_count;
  if (description !== undefined) updates.description = description;
  if (publisher !== undefined) updates.publisher = publisher;
  if (series_name !== undefined) updates.series_name = series_name;
  if (series_number !== undefined) updates.series_number = series_number;

  if (Object.keys(updates).length === 0) {
    sendError(res, 'No fields to update', 400);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('books')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      sendError(res, 'Book not found', 404);
      return;
    }
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data);
});

// DELETE /api/v1/books/:id — delete book (only by the user who added it)
booksRouter.delete('/api/v1/books/:id', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;

  // Fetch the book to check ownership
  const { data: book, error: fetchError } = await supabaseAdmin
    .from('books')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchError) {
    if (fetchError.code === 'PGRST116') {
      sendError(res, 'Book not found', 404);
      return;
    }
    sendError(res, fetchError.message, 500);
    return;
  }

  if (book.added_by !== req.userId) {
    sendError(res, 'You can only delete books you added', 403);
    return;
  }

  // Delete associated progress records
  await supabaseAdmin
    .from('progress')
    .delete()
    .eq('book_id', id);

  // Delete the book
  const { error: deleteError } = await supabaseAdmin
    .from('books')
    .delete()
    .eq('id', id);

  if (deleteError) {
    sendError(res, deleteError.message, 500);
    return;
  }

  sendSuccess(res, { message: 'Book deleted successfully' });
});
