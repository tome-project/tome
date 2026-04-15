import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';
import { AudiobookshelfService, ABSLibraryItem } from '../services/audiobookshelf';

export const audiobookshelfRouter = Router();

const libraryPath = process.env.LIBRARY_PATH || './library';

// POST /api/v1/abs/connect — test connection and list ABS libraries
audiobookshelfRouter.post('/api/v1/abs/connect', requireAuth, async (req: Request, res: Response) => {
  const { url, token } = req.body;

  if (!url || !token) {
    sendError(res, 'Audiobookshelf URL and API token are required');
    return;
  }

  try {
    const abs = new AudiobookshelfService(url, token);
    const libraries = await abs.getLibraries();

    sendSuccess(res, {
      connected: true,
      libraries: libraries.map((lib: any) => ({
        id: lib.id,
        name: lib.name,
        mediaType: lib.mediaType,
        folders: lib.folders?.map((f: any) => f.fullPath) || [],
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to connect';
    sendError(res, `Could not connect to Audiobookshelf: ${message}`, 502);
  }
});

// POST /api/v1/abs/sync — sync an ABS library into a Tome library
audiobookshelfRouter.post('/api/v1/abs/sync', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { abs_url, abs_token, abs_library_id, tome_library_id, download_covers } = req.body;

  if (!abs_url || !abs_token || !abs_library_id) {
    sendError(res, 'abs_url, abs_token, and abs_library_id are required');
    return;
  }

  try {
    const abs = new AudiobookshelfService(abs_url, abs_token);

    // If no Tome library specified, create one
    let libraryId = tome_library_id;
    if (!libraryId) {
      const absLibraries = await abs.getLibraries();
      const absLib = absLibraries.find((l: any) => l.id === abs_library_id);
      const libName = absLib?.name || 'Audiobookshelf Library';

      const inviteCode = crypto.randomBytes(6).toString('hex');
      const { data: newLib, error: libErr } = await supabaseAdmin
        .from('libraries')
        .insert({
          owner_id: userId,
          name: libName,
          description: `Synced from Audiobookshelf`,
          invite_code: inviteCode,
          is_public: false,
          abs_url: abs_url,
          abs_token: abs_token,
          abs_library_id: abs_library_id,
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
      sendError(res, 'You can only sync into libraries you own', 403);
      return;
    }

    // Update ABS connection details on the library
    await supabaseAdmin
      .from('libraries')
      .update({ abs_url: abs_url, abs_token: abs_token, abs_library_id: abs_library_id })
      .eq('id', libraryId);

    // Fetch all items from ABS
    const items = await abs.getLibraryItems(abs_library_id);

    // Get existing books in this library that came from ABS
    const { data: existingBooks } = await supabaseAdmin
      .from('books')
      .select('external_id')
      .eq('library_id', libraryId)
      .eq('external_source', 'audiobookshelf');

    const existingIds = new Set(
      (existingBooks || []).map((b: { external_id: string }) => b.external_id)
    );

    let added = 0;
    let skipped = 0;
    const errors: string[] = [];
    const addedBooks: Array<{ title: string; author: string; type: string }> = [];

    for (const item of items) {
      if (existingIds.has(item.id)) {
        skipped++;
        continue;
      }

      try {
        const bookData = abs.mapToBook(item, abs_library_id);

        // Insert the book first to get its ID
        const { data: insertedBook, error: insertErr } = await supabaseAdmin
          .from('books')
          .insert({
            ...bookData,
            library_id: libraryId,
            added_by: userId,
          })
          .select('id')
          .single();

        if (insertErr) {
          errors.push(`Failed to add "${bookData.title}": ${insertErr.message}`);
          continue;
        }

        // Download cover using the Tome book ID so it matches the covers endpoint
        if (download_covers !== false) {
          const coverData = await abs.getItemCover(item.id);
          if (coverData) {
            const coversDir = path.join(libraryPath, 'covers');
            if (!fs.existsSync(coversDir)) {
              fs.mkdirSync(coversDir, { recursive: true });
            }
            const coverFilePath = path.join(coversDir, `${insertedBook.id}.jpg`);
            await fs.promises.writeFile(coverFilePath, coverData);

            await supabaseAdmin
              .from('books')
              .update({ cover_url: `/api/v1/covers/${insertedBook.id}` })
              .eq('id', insertedBook.id);
          }
        }

        added++;
        addedBooks.push({
          title: bookData.title,
          author: bookData.author,
          type: bookData.type,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        errors.push(`Failed to process item ${item.id}: ${message}`);
      }
    }

    sendSuccess(res, {
      library_id: libraryId,
      total_in_abs: items.length,
      added,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
      books: addedBooks,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sync failed';
    sendError(res, message, 500);
  }
});

// GET /api/v1/abs/status/:libraryId — check sync status for a Tome library
audiobookshelfRouter.get('/api/v1/abs/status/:libraryId', requireAuth, async (req: Request, res: Response) => {
  const { libraryId } = req.params;

  const { data, error, count } = await supabaseAdmin
    .from('books')
    .select('*', { count: 'exact' })
    .eq('library_id', libraryId)
    .eq('external_source', 'audiobookshelf');

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  const types = (data || []).reduce(
    (acc: { epub: number; audiobook: number }, b: { type: string }) => {
      if (b.type === 'epub') acc.epub++;
      else acc.audiobook++;
      return acc;
    },
    { epub: 0, audiobook: 0 }
  );

  sendSuccess(res, {
    total_synced: count || 0,
    by_type: types,
  });
});
