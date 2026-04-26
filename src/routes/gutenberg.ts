import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { requireAuth } from '../middleware/auth';
import { upsertOne } from '../services/db';
import { ensureMinimalCatalogBook } from '../services/catalog';
import { sendSuccess, sendError } from '../utils';

export const gutenbergRouter = Router();

const libraryPath = process.env.LIBRARY_PATH || './library';
const GUTENBERG_API = 'https://gutendex.com';

interface GutendexAuthor { name?: string }
interface GutendexBook {
  id: number;
  title: string;
  authors?: GutendexAuthor[];
  subjects?: string[];
  languages?: string[];
  formats?: Record<string, string>;
  download_count?: number;
}

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
    const data = await response.json() as { results?: GutendexBook[]; count?: number; next?: unknown; previous?: unknown };

    const books = (data.results ?? []).map((book) => ({
      gutenberg_id: book.id,
      title: book.title,
      author: book.authors?.[0]?.name ?? 'Unknown',
      cover_url: book.formats?.['image/jpeg'] ?? null,
      epub_url: book.formats?.['application/epub+zip'] ?? null,
      subjects: book.subjects ?? [],
      download_count: book.download_count ?? 0,
    }));

    sendSuccess(res, {
      books,
      count: data.count ?? 0,
      next: !!data.next,
      previous: !!data.previous,
    });
  } catch {
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
    const data = await response.json() as { results?: GutendexBook[] };

    const books = (data.results ?? []).map((book) => ({
      gutenberg_id: book.id,
      title: book.title,
      author: book.authors?.[0]?.name ?? 'Unknown',
      cover_url: book.formats?.['image/jpeg'] ?? null,
      epub_url: book.formats?.['application/epub+zip'] ?? null,
      subjects: book.subjects ?? [],
      download_count: book.download_count ?? 0,
    }));

    sendSuccess(res, { books });
  } catch {
    sendError(res, 'Failed to fetch popular books', 502);
  }
});

// POST /api/v1/gutenberg/download — download a Gutenberg book, ensure a catalog
// row, create a book_sources row, and (optionally) add to the user's library.
// Body: { gutenberg_id, title, author?, cover_url?, epub_url, subjects?, add_to_library? }
gutenbergRouter.post('/api/v1/gutenberg/download', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const {
    gutenberg_id,
    title,
    author,
    cover_url,
    epub_url,
    subjects,
    add_to_library,
  } = req.body ?? {};

  if (!gutenberg_id || !title || !epub_url) {
    sendError(res, 'gutenberg_id, title, and epub_url are required');
    return;
  }

  try {
    const gutenbergDir = path.join(libraryPath, 'gutenberg');
    await fs.promises.mkdir(gutenbergDir, { recursive: true });

    const filename = `gutenberg-${gutenberg_id}.epub`;
    const relativePath = `gutenberg/${filename}`;
    const filePath = path.join(gutenbergDir, filename);

    const response = await fetch(epub_url);
    if (!response.ok) {
      sendError(res, 'Failed to download epub from Gutenberg', 502);
      return;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(filePath, buffer);

    // Ensure catalog entry (Gutenberg books rarely have ISBNs; the minimal-
    // catalog path will dedup by title+author on re-download).
    const catalogBook = await ensureMinimalCatalogBook({
      title,
      authors: author ? [String(author)] : [],
      cover_url: cover_url ?? null,
      genres: Array.isArray(subjects) ? subjects.slice(0, 10) : [],
      language: 'en',
    });

    // Attach the downloaded file as a source owned by this user.
    const source = await upsertOne(
      'book_sources',
      {
        book_id: catalogBook.id,
        owner_id: me,
        kind: 'gutenberg',
        media_type: 'epub',
        file_path: relativePath,
        external_id: String(gutenberg_id),
        external_url: epub_url,
      },
      { onConflict: 'book_id,owner_id,kind' }
    );

    // Optionally add to the user's library with status='want'.
    let userBook: unknown = null;
    if (add_to_library !== false) {
      try {
        userBook = await upsertOne(
          'user_books',
          { user_id: me, book_id: catalogBook.id, status: 'want' },
          { onConflict: 'user_id,book_id', ignoreDuplicates: true }
        );
      } catch (err) {
        // Not fatal — the download still succeeded.
        const message = err instanceof Error ? err.message : 'Unknown error';
        // eslint-disable-next-line no-console
        console.warn(`Failed to add Gutenberg book to user library: ${message}`);
      }
    }

    sendSuccess(res, { book: catalogBook, source, user_book: userBook }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to download and save book';
    sendError(res, message, 500);
  }
});
