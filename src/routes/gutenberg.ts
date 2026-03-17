import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const gutenbergRouter = Router();

const libraryPath = process.env.LIBRARY_PATH || './library';

// Gutenberg API base URL
const GUTENBERG_API = 'https://gutendex.com';

// GET /api/v1/gutenberg/search — search Project Gutenberg catalog
gutenbergRouter.get('/api/v1/gutenberg/search', async (req: Request, res: Response) => {
  const { q, page } = req.query;

  if (!q || typeof q !== 'string') {
    sendError(res, 'Query parameter "q" is required');
    return;
  }

  try {
    const url = new URL('/books', GUTENBERG_API);
    url.searchParams.set('search', q);
    url.searchParams.set('mime_type', 'application/epub');
    if (page) url.searchParams.set('page', String(page));

    const response = await fetch(url.toString());
    const data = await response.json() as any;

    // Transform Gutenberg response to our format
    const books = (data.results || []).map((book: any) => ({
      gutenberg_id: book.id,
      title: book.title,
      author: book.authors?.[0]?.name || 'Unknown',
      cover_url: book.formats?.['image/jpeg'] || null,
      epub_url: book.formats?.['application/epub+zip'] || null,
      subjects: book.subjects || [],
      download_count: book.download_count || 0,
    }));

    sendSuccess(res, {
      books,
      count: data.count || 0,
      next: !!data.next,
      previous: !!data.previous,
    });
  } catch (_e) {
    sendError(res, 'Failed to search Gutenberg catalog', 502);
  }
});

// GET /api/v1/gutenberg/popular — get popular public domain books
gutenbergRouter.get('/api/v1/gutenberg/popular', async (_req: Request, res: Response) => {
  try {
    const url = new URL('/books', GUTENBERG_API);
    url.searchParams.set('mime_type', 'application/epub');
    url.searchParams.set('sort', 'popular');

    const response = await fetch(url.toString());
    const data = await response.json() as any;

    const books = (data.results || []).map((book: any) => ({
      gutenberg_id: book.id,
      title: book.title,
      author: book.authors?.[0]?.name || 'Unknown',
      cover_url: book.formats?.['image/jpeg'] || null,
      epub_url: book.formats?.['application/epub+zip'] || null,
      subjects: book.subjects || [],
      download_count: book.download_count || 0,
    }));

    sendSuccess(res, { books });
  } catch (_e) {
    sendError(res, 'Failed to fetch popular books', 502);
  }
});

// POST /api/v1/gutenberg/download — download a Gutenberg book and add to library
gutenbergRouter.post('/api/v1/gutenberg/download', requireAuth, async (req: Request, res: Response) => {
  const { gutenberg_id, title, author, cover_url, epub_url } = req.body;

  if (!gutenberg_id || !title || !epub_url) {
    sendError(res, 'gutenberg_id, title, and epub_url are required');
    return;
  }

  try {
    // Ensure the gutenberg download directory exists
    const gutenbergDir = path.join(libraryPath, 'gutenberg');
    await fs.promises.mkdir(gutenbergDir, { recursive: true });

    // Download the epub file
    const filename = `gutenberg-${gutenberg_id}.epub`;
    const filePath = path.join(gutenbergDir, filename);

    const response = await fetch(epub_url);
    if (!response.ok) {
      sendError(res, 'Failed to download epub from Gutenberg', 502);
      return;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(filePath, buffer);

    // Insert book record into the database
    const { data: book, error } = await supabaseAdmin
      .from('books')
      .insert({
        title,
        author: author || 'Unknown',
        cover_url: cover_url || null,
        file_path: `gutenberg/${filename}`,
        type: 'epub',
        added_by: req.userId,
      })
      .select()
      .single();

    if (error) {
      sendError(res, error.message, 500);
      return;
    }

    sendSuccess(res, book, 201);
  } catch (_e) {
    sendError(res, 'Failed to download and save book', 500);
  }
});
