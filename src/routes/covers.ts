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

// Ensure covers directory exists
if (!fs.existsSync(coversDir)) {
  fs.mkdirSync(coversDir, { recursive: true });
}

export const coversRouter = Router();

// POST /api/v1/books/:id/extract-metadata — extract metadata from epub and update book record
coversRouter.post('/api/v1/books/:id/extract-metadata', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;

  // Fetch the book record
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

  const epubPath = path.join(libraryPath, book.file_path);

  if (!fs.existsSync(epubPath)) {
    sendError(res, 'Epub file not found on disk', 404);
    return;
  }

  try {
    const metadata = await extractEpubMetadata(epubPath);

    // Build update object
    const update: Record<string, unknown> = {
      title: metadata.title,
      author: metadata.author,
    };

    if (metadata.description) {
      update.description = metadata.description;
    }
    if (metadata.publisher) {
      update.publisher = metadata.publisher;
    }
    if (metadata.language) {
      update.language = metadata.language;
    }

    // Save cover image if available
    if (metadata.coverImage) {
      const coverPath = path.join(coversDir, `${id}.jpg`);
      await sharp(metadata.coverImage)
        .resize({ width: 400, withoutEnlargement: true })
        .jpeg()
        .toFile(coverPath);

      update.cover_url = `/api/v1/covers/${id}`;
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

// GET /api/v1/covers/:bookId — serve cover image (no auth required)
coversRouter.get('/api/v1/covers/:bookId', (req: Request, res: Response) => {
  const { bookId } = req.params;
  const coverPath = path.join(coversDir, `${bookId}.jpg`);

  if (!fs.existsSync(coverPath)) {
    sendError(res, 'Cover not found', 404);
    return;
  }

  res.type('image/jpeg').sendFile(path.resolve(coverPath));
});

// POST /api/v1/library/extract-all — extract metadata for all books missing cover_url
coversRouter.post('/api/v1/library/extract-all', requireAuth, async (_req: Request, res: Response) => {
  try {
    const { data: books, error: fetchError } = await supabaseAdmin
      .from('books')
      .select('*')
      .is('cover_url', null)
      .eq('type', 'epub');

    if (fetchError) {
      sendError(res, fetchError.message, 500);
      return;
    }

    let processed = 0;
    let updated = 0;

    for (const book of books || []) {
      processed++;

      const epubPath = path.join(libraryPath, book.file_path);
      if (!fs.existsSync(epubPath)) {
        continue;
      }

      try {
        const metadata = await extractEpubMetadata(epubPath);

        const updateFields: Record<string, unknown> = {
          title: metadata.title,
          author: metadata.author,
        };

        if (metadata.description) {
          updateFields.description = metadata.description;
        }
        if (metadata.publisher) {
          updateFields.publisher = metadata.publisher;
        }
        if (metadata.language) {
          updateFields.language = metadata.language;
        }

        if (metadata.coverImage) {
          const coverPath = path.join(coversDir, `${book.id}.jpg`);
          await sharp(metadata.coverImage)
            .resize({ width: 400, withoutEnlargement: true })
            .jpeg()
            .toFile(coverPath);

          updateFields.cover_url = `/api/v1/covers/${book.id}`;
        }

        const { error: updateError } = await supabaseAdmin
          .from('books')
          .update(updateFields)
          .eq('id', book.id);

        if (!updateError) {
          updated++;
        }
      } catch {
        // Skip books that fail extraction
        continue;
      }
    }

    sendSuccess(res, { processed, updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to extract metadata';
    sendError(res, message, 500);
  }
});
