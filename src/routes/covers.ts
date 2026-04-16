import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { extractEpubMetadata } from '../services/epub-metadata';
import { sendSuccess, sendError } from '../utils';

const libraryPath = process.env.LIBRARY_PATH || './library';
const coversDir = path.join(libraryPath, 'covers');

if (!fs.existsSync(coversDir)) {
  fs.mkdirSync(coversDir, { recursive: true });
}

export const coversRouter = Router();

// Find an epub source on disk for the given book, preferring one the caller owns.
async function findLocalEpubSource(bookId: string, ownerId?: string) {
  const { data: sources } = await supabaseAdmin
    .from('book_sources')
    .select('*')
    .eq('book_id', bookId)
    .eq('media_type', 'epub')
    .not('file_path', 'is', null);
  if (!sources || sources.length === 0) return null;
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

  const { data: book, error: fetchError } = await supabaseAdmin
    .from('books')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (fetchError) {
    sendError(res, fetchError.message, 500);
    return;
  }
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

  try {
    const metadata = await extractEpubMetadata(epubPath);

    const update: Record<string, unknown> = {};
    if (metadata.title) update.title = metadata.title;
    if (metadata.author) update.authors = [metadata.author];
    if (metadata.description) update.description = metadata.description;
    if (metadata.publisher) update.publisher = metadata.publisher;
    if (metadata.language) update.language = metadata.language;

    if (metadata.coverImage) {
      const coverPath = path.join(coversDir, `${id}.jpg`);
      await sharp(metadata.coverImage)
        .resize({ width: 400, withoutEnlargement: true })
        .jpeg()
        .toFile(coverPath);
      update.cover_url = `/api/v1/covers/${id}`;
    }

    if (Object.keys(update).length === 0) {
      sendSuccess(res, book);
      return;
    }

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('books')
      .update(update)
      .eq('id', id)
      .select()
      .single();
    if (updateError) {
      sendError(res, updateError.message, 500);
      return;
    }
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
    const { data: sources, error: srcErr } = await supabaseAdmin
      .from('book_sources')
      .select('id, book_id, file_path, book:books(id, cover_url)')
      .eq('owner_id', ownerId)
      .eq('media_type', 'epub')
      .not('file_path', 'is', null);
    if (srcErr) {
      sendError(res, srcErr.message, 500);
      return;
    }

    let processed = 0;
    let updated = 0;

    for (const s of sources ?? []) {
      const book = Array.isArray(s.book) ? s.book[0] : s.book;
      if (!book || book.cover_url) continue;

      processed++;
      const epubPath = path.join(libraryPath, s.file_path as string);
      if (!fs.existsSync(epubPath)) continue;

      try {
        const metadata = await extractEpubMetadata(epubPath);
        const updateFields: Record<string, unknown> = {};
        if (metadata.title) updateFields.title = metadata.title;
        if (metadata.author) updateFields.authors = [metadata.author];
        if (metadata.description) updateFields.description = metadata.description;
        if (metadata.publisher) updateFields.publisher = metadata.publisher;
        if (metadata.language) updateFields.language = metadata.language;

        if (metadata.coverImage) {
          const coverPath = path.join(coversDir, `${book.id}.jpg`);
          await sharp(metadata.coverImage)
            .resize({ width: 400, withoutEnlargement: true })
            .jpeg()
            .toFile(coverPath);
          updateFields.cover_url = `/api/v1/covers/${book.id}`;
        }

        if (Object.keys(updateFields).length > 0) {
          const { error: updateError } = await supabaseAdmin
            .from('books')
            .update(updateFields)
            .eq('id', book.id);
          if (!updateError) updated++;
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
