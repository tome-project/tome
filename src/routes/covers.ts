import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { requireAuth } from '../middleware/auth';
import { selectOne, selectMany, query } from '../services/db';
import { extractEpubMetadata } from '../services/epub-metadata';
import { sendSuccess, sendError } from '../utils';

const libraryPath = process.env.LIBRARY_PATH || './library';
const coversDir = path.join(libraryPath, 'covers');

if (!fs.existsSync(coversDir)) {
  fs.mkdirSync(coversDir, { recursive: true });
}

export const coversRouter = Router();

interface CoverSource {
  id: string;
  book_id: string;
  owner_id: string;
  file_path: string | null;
}

// Find an epub source on disk for the given book, preferring one the caller owns.
async function findLocalEpubSource(bookId: string, ownerId?: string): Promise<CoverSource | null> {
  const sources = await selectMany<CoverSource>(
    `SELECT id, book_id, owner_id, file_path FROM book_sources
      WHERE book_id = $1 AND media_type = 'epub' AND file_path IS NOT NULL`,
    [bookId]
  );
  if (sources.length === 0) return null;
  if (ownerId) {
    const own = sources.find((s) => s.owner_id === ownerId);
    if (own) return own;
  }
  return sources[0];
}

// POST /api/v1/books/:id/extract-metadata
// Reads metadata from a local epub source for the book and updates the catalog row.
coversRouter.post('/api/v1/books/:id/extract-metadata', requireAuth, async (req: Request, res: Response) => {
  const id = String(req.params.id);

  try {
    const book = await selectOne<{ id: string; cover_url: string | null }>(
      'SELECT * FROM books WHERE id = $1',
      [id]
    );
    if (!book) {
      sendError(res, 'Book not found', 404);
      return;
    }

    const source = await findLocalEpubSource(id, req.userId);
    if (!source?.file_path) {
      sendError(res, 'No local epub source available for this book', 404);
      return;
    }

    const epubPath = path.join(libraryPath, source.file_path);
    if (!fs.existsSync(epubPath)) {
      sendError(res, 'Epub file not found on disk', 404);
      return;
    }

    const metadata = await extractEpubMetadata(epubPath);
    const updateFields: string[] = [];
    const params: unknown[] = [];
    if (metadata.title) { updateFields.push(`title = $${params.length + 1}`); params.push(metadata.title); }
    if (metadata.author) { updateFields.push(`authors = $${params.length + 1}`); params.push([metadata.author]); }
    if (metadata.description) { updateFields.push(`description = $${params.length + 1}`); params.push(metadata.description); }
    if (metadata.publisher) { updateFields.push(`publisher = $${params.length + 1}`); params.push(metadata.publisher); }
    if (metadata.language) { updateFields.push(`language = $${params.length + 1}`); params.push(metadata.language); }

    if (metadata.coverImage) {
      const coverPath = path.join(coversDir, `${id}.jpg`);
      await sharp(metadata.coverImage)
        .resize({ width: 400, withoutEnlargement: true })
        .jpeg()
        .toFile(coverPath);
      updateFields.push(`cover_url = $${params.length + 1}`);
      params.push(`/api/v1/covers/${id}`);
    }

    if (updateFields.length === 0) {
      sendSuccess(res, book);
      return;
    }

    params.push(id);
    const updated = await selectOne(
      `UPDATE books SET ${updateFields.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    sendSuccess(res, updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to extract metadata';
    sendError(res, message, 500);
  }
});

// GET /api/v1/covers/:bookId — serve a cover image from disk
coversRouter.get('/api/v1/covers/:bookId', (req: Request, res: Response) => {
  const bookId = String(req.params.bookId);
  const coverPath = path.join(coversDir, `${bookId}.jpg`);
  if (!fs.existsSync(coverPath)) {
    sendError(res, 'Cover not found', 404);
    return;
  }
  res.type('image/jpeg').sendFile(path.resolve(coverPath));
});

// POST /api/v1/library/extract-all
// Iterate over the caller's own epub sources whose catalog book has no cover yet,
// and extract metadata from each.
coversRouter.post('/api/v1/library/extract-all', requireAuth, async (req: Request, res: Response) => {
  const ownerId = req.userId!;
  try {
    const sources = await selectMany<{
      book_id: string;
      file_path: string;
      cover_url: string | null;
    }>(
      `SELECT bs.book_id, bs.file_path, b.cover_url
         FROM book_sources bs
         JOIN books b ON b.id = bs.book_id
        WHERE bs.owner_id = $1 AND bs.media_type = 'epub' AND bs.file_path IS NOT NULL`,
      [ownerId]
    );

    let processed = 0;
    let updated = 0;

    for (const s of sources) {
      if (s.cover_url) continue;
      processed++;
      const epubPath = path.join(libraryPath, s.file_path);
      if (!fs.existsSync(epubPath)) continue;

      try {
        const metadata = await extractEpubMetadata(epubPath);
        const fields: string[] = [];
        const params: unknown[] = [];
        if (metadata.title) { fields.push(`title = $${params.length + 1}`); params.push(metadata.title); }
        if (metadata.author) { fields.push(`authors = $${params.length + 1}`); params.push([metadata.author]); }
        if (metadata.description) { fields.push(`description = $${params.length + 1}`); params.push(metadata.description); }
        if (metadata.publisher) { fields.push(`publisher = $${params.length + 1}`); params.push(metadata.publisher); }
        if (metadata.language) { fields.push(`language = $${params.length + 1}`); params.push(metadata.language); }

        if (metadata.coverImage) {
          const coverPath = path.join(coversDir, `${s.book_id}.jpg`);
          await sharp(metadata.coverImage)
            .resize({ width: 400, withoutEnlargement: true })
            .jpeg()
            .toFile(coverPath);
          fields.push(`cover_url = $${params.length + 1}`);
          params.push(`/api/v1/covers/${s.book_id}`);
        }

        if (fields.length > 0) {
          params.push(s.book_id);
          await query(`UPDATE books SET ${fields.join(', ')} WHERE id = $${params.length}`, params);
          updated++;
        }
      } catch {
        // skip individual failures
      }
    }

    sendSuccess(res, { processed, updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to extract metadata';
    sendError(res, message, 500);
  }
});
