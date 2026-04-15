import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';
import { getCalibreBooks } from '../services/calibre';

export const calibreRouter = Router();

const libraryPath = process.env.LIBRARY_PATH || './library';

// POST /api/v1/calibre/import — import books from a Calibre library
calibreRouter.post('/api/v1/calibre/import', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { calibre_path, tome_library_id, download_covers } = req.body;

  if (!calibre_path || typeof calibre_path !== 'string') {
    sendError(res, 'calibre_path is required');
    return;
  }

  // Validate path exists and has metadata.db
  const dbPath = path.join(calibre_path, 'metadata.db');
  if (!fs.existsSync(dbPath)) {
    sendError(res, `Calibre library not found: metadata.db does not exist at ${calibre_path}`);
    return;
  }

  try {
    // If no Tome library specified, create one
    let libraryId = tome_library_id;
    if (!libraryId) {
      const inviteCode = crypto.randomBytes(6).toString('hex');
      const { data: newLib, error: libErr } = await supabaseAdmin
        .from('libraries')
        .insert({
          owner_id: userId,
          name: 'Calibre Library',
          description: `Imported from Calibre at ${calibre_path}`,
          invite_code: inviteCode,
          is_public: false,
        })
        .select()
        .single();

      if (libErr) {
        sendError(res, libErr.message, 500);
        return;
      }

      // Add owner as member
      await supabaseAdmin.from('library_members').insert({
        library_id: newLib.id,
        user_id: userId,
        role: 'owner',
      });

      libraryId = newLib.id;
    }

    // Verify user owns the target library
    const { data: lib } = await supabaseAdmin
      .from('libraries')
      .select('owner_id')
      .eq('id', libraryId)
      .single();

    if (!lib || lib.owner_id !== userId) {
      sendError(res, 'You can only import into libraries you own', 403);
      return;
    }

    // Get books from Calibre
    const calibreBooks = getCalibreBooks(calibre_path);

    // Get existing books in this library that came from Calibre
    const { data: existingBooks } = await supabaseAdmin
      .from('books')
      .select('external_id')
      .eq('library_id', libraryId)
      .eq('external_source', 'calibre');

    const existingIds = new Set(
      (existingBooks || []).map((b: { external_id: string }) => b.external_id)
    );

    let added = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const book of calibreBooks) {
      const externalId = String(book.calibreId);

      if (existingIds.has(externalId)) {
        skipped++;
        continue;
      }

      if (!book.filePath) {
        errors.push(`"${book.title}" — no supported file format found`);
        continue;
      }

      try {
        // Determine book type from format
        const type = book.format === 'mp3' || book.format === 'm4b' ? 'audiobook' : 'epub';

        // Insert the book record
        const { data: insertedBook, error: insertErr } = await supabaseAdmin
          .from('books')
          .insert({
            library_id: libraryId,
            title: book.title,
            author: book.author || 'Unknown',
            type,
            file_path: book.filePath,
            external_id: externalId,
            external_source: 'calibre',
            added_by: userId,
          })
          .select('id')
          .single();

        if (insertErr) {
          errors.push(`Failed to add "${book.title}": ${insertErr.message}`);
          continue;
        }

        // Copy cover if available
        if (download_covers !== false && book.coverPath && fs.existsSync(book.coverPath)) {
          const coversDir = path.join(libraryPath, 'covers');
          if (!fs.existsSync(coversDir)) {
            fs.mkdirSync(coversDir, { recursive: true });
          }
          const coverDest = path.join(coversDir, `${insertedBook.id}.jpg`);
          await fs.promises.copyFile(book.coverPath, coverDest);

          await supabaseAdmin
            .from('books')
            .update({ cover_url: `/api/v1/covers/${insertedBook.id}` })
            .eq('id', insertedBook.id);
        }

        added++;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        errors.push(`Failed to process "${book.title}": ${message}`);
      }
    }

    sendSuccess(res, {
      library_id: libraryId,
      total_in_calibre: calibreBooks.length,
      added,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Import failed';
    sendError(res, message, 500);
  }
});
