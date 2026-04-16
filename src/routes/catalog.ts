import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { searchOpenLibrary, importBook, getCatalogBook } from '../services/catalog';
import { sendSuccess, sendError } from '../utils';

export const catalogRouter = Router();

// GET /api/v1/catalog/search?q=…
// Live OpenLibrary search. No DB write. Returns candidates the client can
// show in an add-book picker.
catalogRouter.get('/api/v1/catalog/search', requireAuth, async (req: Request, res: Response) => {
  const { q, limit } = req.query;
  if (!q || typeof q !== 'string' || q.trim().length < 2) {
    sendError(res, 'Query "q" must be at least 2 characters');
    return;
  }
  const parsedLimit = Math.min(Math.max(parseInt(String(limit ?? '20'), 10) || 20, 1), 40);

  try {
    const results = await searchOpenLibrary(q.trim(), parsedLimit);
    sendSuccess(res, { results });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Catalog search failed';
    sendError(res, message, 502);
  }
});

// POST /api/v1/catalog/import
// Ensures a catalog entry exists for the given OpenLibrary work id or ISBN.
// Idempotent: returns the existing row if already present.
// Body: { ol_id?: string, isbn?: string }
catalogRouter.post('/api/v1/catalog/import', requireAuth, async (req: Request, res: Response) => {
  const { ol_id, isbn } = req.body ?? {};
  if (!ol_id && !isbn) {
    sendError(res, 'Provide ol_id or isbn in the request body');
    return;
  }
  if (ol_id && typeof ol_id !== 'string') {
    sendError(res, 'ol_id must be a string');
    return;
  }
  if (isbn && typeof isbn !== 'string') {
    sendError(res, 'isbn must be a string');
    return;
  }

  try {
    const book = await importBook({ ol_id, isbn });
    sendSuccess(res, book);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Catalog import failed';
    sendError(res, message, 502);
  }
});

// GET /api/v1/catalog/books/:id — fetch a catalog row by id
catalogRouter.get('/api/v1/catalog/books/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const book = await getCatalogBook(String(req.params.id));
    if (!book) {
      sendError(res, 'Book not found in catalog', 404);
      return;
    }
    sendSuccess(res, book);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch catalog book';
    sendError(res, message, 500);
  }
});
