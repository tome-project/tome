import { Router, Request, Response } from 'express';
import { sendSuccess, sendError } from '../utils';

export const gutenbergRouter = Router();

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
