import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';
import {
  AudiobookshelfService,
  absMediaType,
  absPublishedYear,
  type ABSLibraryItem,
} from '../services/audiobookshelf';
import { ensureMinimalCatalogBook } from '../services/catalog';

export const audiobookshelfRouter = Router();

// POST /api/v1/abs/connect — test connection and list ABS libraries
audiobookshelfRouter.post('/api/v1/abs/connect', requireAuth, async (req: Request, res: Response) => {
  const { url, token } = req.body ?? {};
  if (!url || !token) {
    sendError(res, 'Audiobookshelf URL and API token are required');
    return;
  }

  try {
    const abs = new AudiobookshelfService(url, token);
    const libraries = await abs.getLibraries();
    sendSuccess(res, {
      connected: true,
      libraries: libraries.map((lib) => ({
        id: lib.id,
        name: lib.name,
        mediaType: lib.mediaType,
        folders: lib.folders?.map((f) => f.fullPath).filter(Boolean) ?? [],
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to connect';
    sendError(res, `Could not connect to Audiobookshelf: ${message}`, 502);
  }
});

// POST /api/v1/abs/sync — sync an ABS library into the catalog + book_sources.
//
// Body: { abs_url, abs_token, abs_library_id, add_to_library?: boolean }
//
// For each item:
//   1. Ensure a catalog entry — ISBN-first, falls back to minimal insert
//   2. Upsert a book_sources row (kind='audiobookshelf', owner_id=me)
//   3. Optionally add to the caller's library with status='want'
//
// Credentials stay in the request body for now; the media_servers table that
// persists them per-user (encrypted) ships with Phase 1.
audiobookshelfRouter.post('/api/v1/abs/sync', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const { abs_url, abs_token, abs_library_id, add_to_library } = req.body ?? {};

  if (!abs_url || !abs_token || !abs_library_id) {
    sendError(res, 'abs_url, abs_token, and abs_library_id are required');
    return;
  }

  try {
    const abs = new AudiobookshelfService(abs_url, abs_token);
    const items = await abs.getLibraryItems(abs_library_id);

    let added = 0;
    let reused = 0;
    const errors: string[] = [];
    const books: Array<{ title: string; author: string; media_type: string }> = [];

    for (const item of items as ABSLibraryItem[]) {
      try {
        const meta = item.media.metadata;
        const media_type = absMediaType(item);
        const title = meta.title || 'Unknown Title';
        const primaryAuthor = meta.authorName ?? 'Unknown';

        // 1. Catalog entry
        const catalogBook = await ensureMinimalCatalogBook({
          title,
          authors: meta.authorName ? [meta.authorName] : [],
          subtitle: meta.subtitle ?? null,
          description: meta.description ?? null,
          publisher: meta.publisher ?? null,
          published_year: absPublishedYear(meta.publishedYear),
          genres: meta.genres ?? [],
          language: meta.language ?? 'en',
          isbn: meta.isbn ?? null,
        });

        // 2. Source row. Unique on (book_id, owner_id, kind), so re-syncs just
        //    update the external_id/url — no duplicates.
        const { data: source, error: sourceErr } = await supabaseAdmin
          .from('book_sources')
          .upsert(
            {
              book_id: catalogBook.id,
              owner_id: me,
              kind: 'audiobookshelf',
              media_type,
              external_id: item.id,
              external_url: abs_url,
            },
            { onConflict: 'book_id,owner_id,kind' }
          )
          .select()
          .single();
        if (sourceErr) {
          errors.push(`Failed to attach source for "${title}": ${sourceErr.message}`);
          continue;
        }

        // 3. Optional library add
        if (add_to_library !== false) {
          await supabaseAdmin
            .from('user_books')
            .upsert(
              { user_id: me, book_id: catalogBook.id, status: 'want' },
              { onConflict: 'user_id,book_id', ignoreDuplicates: true }
            );
        }

        const wasNew = new Date(source.created_at).getTime() > Date.now() - 5_000;
        if (wasNew) added++;
        else reused++;

        books.push({ title, author: primaryAuthor, media_type });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        errors.push(`Failed to process item ${item.id}: ${message}`);
      }
    }

    sendSuccess(res, {
      total_in_abs: items.length,
      added,
      reused,
      errors: errors.length > 0 ? errors : undefined,
      books,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sync failed';
    sendError(res, message, 500);
  }
});
