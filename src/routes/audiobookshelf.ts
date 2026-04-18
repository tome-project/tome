import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
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
import { decryptToken } from '../services/crypto';
import { ensureMinimalCatalogBook } from '../services/catalog';

const libraryPath = process.env.LIBRARY_PATH || './library';
const coversDir = path.join(libraryPath, 'covers');
if (!fs.existsSync(coversDir)) {
  fs.mkdirSync(coversDir, { recursive: true });
}

// Pull a best-effort author list out of ABS metadata. The expanded item
// endpoint gives us a structured `authors: [{name}]`; the list endpoint only
// gives us `authorName` (sometimes a single name, sometimes slash-joined).
function collectAuthors(meta: ABSLibraryItem['media']['metadata']): string[] {
  if (meta.authors && meta.authors.length > 0) {
    return meta.authors.map((a) => a.name).filter((n) => n && n.trim().length > 0);
  }
  if (meta.authorName && meta.authorName.trim().length > 0) {
    // ABS sometimes stores narrator lists in authorName as "A/B/C". A plain
    // single author never contains '/', so splitting is safe and drops the
    // narrator-list noise onto the first entry — which is usually the real
    // author for audiobook rips.
    return meta.authorName
      .split('/')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 1);
  }
  return [];
}

// Update a catalog row's authors when we have better data than what's stored.
// Used when re-syncing an ABS item whose previous sync left authors empty.
async function refreshCatalogBookAuthors(bookId: string, authors: string[]) {
  const { data: book } = await supabaseAdmin
    .from('books')
    .select('*')
    .eq('id', bookId)
    .single();
  if (!book) throw new Error(`Catalog book ${bookId} not found`);

  const currentAuthors = (book.authors as string[] | null) ?? [];
  if (currentAuthors.length > 0 || authors.length === 0) {
    return book;
  }

  const { data: updated, error } = await supabaseAdmin
    .from('books')
    .update({ authors })
    .eq('id', bookId)
    .select()
    .single();
  if (error) throw new Error(`Failed to refresh authors for ${bookId}: ${error.message}`);
  return updated;
}

export const audiobookshelfRouter = Router();

// POST /api/v1/abs/sync — sync an ABS library into the catalog + book_sources,
// using the caller's stored media_server row (Phase 1).
//
// Body: { server_id, abs_library_id, add_to_library?: boolean }
//
// Per item:
//   1. Ensure a catalog entry (ISBN-first via importBook, else minimal insert)
//   2. Upsert a book_sources row (kind='audiobookshelf', owner_id=me,
//      media_server_id=server_id) — unique per (book, owner, kind)
//   3. Optionally auto-add to the caller's library with status='want'
//
// Credentials are no longer passed in the request body; they live encrypted
// on media_servers.token_encrypted and are decrypted here for the call.
audiobookshelfRouter.post('/api/v1/abs/sync', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const { server_id, abs_library_id, add_to_library } = req.body ?? {};

  if (!server_id || typeof server_id !== 'string') {
    sendError(res, 'server_id is required (register via POST /api/v1/servers first)');
    return;
  }
  if (!abs_library_id || typeof abs_library_id !== 'string') {
    sendError(res, 'abs_library_id is required');
    return;
  }

  // Fetch + ownership check
  const { data: server, error: serverErr } = await supabaseAdmin
    .from('media_servers')
    .select('*')
    .eq('id', server_id)
    .eq('owner_id', me)
    .maybeSingle();
  if (serverErr) {
    sendError(res, serverErr.message, 500);
    return;
  }
  if (!server) {
    sendError(res, 'Server not found', 404);
    return;
  }
  if (server.kind !== 'audiobookshelf') {
    sendError(res, `Server is kind='${server.kind}', not audiobookshelf`, 400);
    return;
  }

  let token: string;
  try {
    token = decryptToken(server.token_encrypted as string);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token decryption failed';
    sendError(res, message, 500);
    return;
  }

  try {
    const abs = new AudiobookshelfService(server.url as string, token);
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

        // The list endpoint only gives us `authorName`. When that's missing —
        // which happens for plenty of real ABS libraries — fetch the expanded
        // item so we can pull from the structured `authors` array instead.
        let authors = collectAuthors(meta);
        if (authors.length === 0) {
          const detail = await abs.getItemDetail(item.id);
          if (detail) authors = collectAuthors(detail.media.metadata);
        }

        const primaryAuthor = authors[0] ?? 'Unknown';

        // If we've synced this ABS item before, reuse the same catalog book
        // row rather than letting ensureMinimalCatalogBook insert a duplicate.
        // Duplicates happen when (title, author) dedup can't match — e.g. when
        // ABS returns an empty authorName on one sync and a real one later.
        let catalogBookId: string | null = null;
        const { data: existingSource } = await supabaseAdmin
          .from('book_sources')
          .select('book_id')
          .eq('owner_id', me)
          .eq('kind', 'audiobookshelf')
          .eq('external_id', item.id)
          .maybeSingle();
        if (existingSource) {
          catalogBookId = existingSource.book_id as string;
        }

        const catalogBook = catalogBookId
          ? await refreshCatalogBookAuthors(catalogBookId, authors)
          : await ensureMinimalCatalogBook({
              title,
              authors,
              subtitle: meta.subtitle ?? null,
              description: meta.description ?? null,
              publisher: meta.publisher ?? null,
              published_year: absPublishedYear(meta.publishedYear),
              genres: meta.genres ?? [],
              language: meta.language ?? 'en',
              isbn: meta.isbn ?? null,
            });

        const { data: source, error: sourceErr } = await supabaseAdmin
          .from('book_sources')
          .upsert(
            {
              book_id: catalogBook.id,
              owner_id: me,
              kind: 'audiobookshelf',
              media_type,
              external_id: item.id,
              external_url: server.url,
              media_server_id: server.id,
            },
            { onConflict: 'book_id,owner_id,kind' }
          )
          .select()
          .single();
        if (sourceErr) {
          errors.push(`Failed to attach source for "${title}": ${sourceErr.message}`);
          continue;
        }

        // Cover: make sure there's a local file AND the catalog row points at
        // it. Re-sync is idempotent — if a previous sync wrote the file but
        // not the DB (or wrote the DB but not the file), we reconcile here.
        //   1. If the file is on disk already, just stamp cover_url.
        //   2. Else if ABS has a coverPath, fetch + write both.
        //   3. Else leave as-is (book has no cover upstream).
        if (item.media.coverPath) {
          const dest = path.join(coversDir, `${catalogBook.id}.jpg`);
          const targetUrl = `/api/v1/covers/${catalogBook.id}`;
          try {
            if (fs.existsSync(dest)) {
              if (catalogBook.cover_url !== targetUrl) {
                await supabaseAdmin
                  .from('books')
                  .update({ cover_url: targetUrl })
                  .eq('id', catalogBook.id);
              }
            } else {
              const buf = await abs.getItemCover(item.id);
              if (buf) {
                await sharp(buf)
                  .resize({ width: 400, withoutEnlargement: true })
                  .jpeg()
                  .toFile(dest);
                await supabaseAdmin
                  .from('books')
                  .update({ cover_url: targetUrl })
                  .eq('id', catalogBook.id);
              }
            }
          } catch {
            // best-effort; covers can be re-fetched on next sync
          }
        }

        if (add_to_library !== false) {
          await supabaseAdmin
            .from('user_books')
            .upsert(
              { user_id: me, book_id: catalogBook.id, status: 'want' },
              { onConflict: 'user_id,book_id', ignoreDuplicates: true }
            );
        }

        const wasNew = new Date(source.created_at as string).getTime() > Date.now() - 5_000;
        if (wasNew) added++;
        else reused++;

        books.push({ title, author: primaryAuthor, media_type });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        errors.push(`Failed to process item ${item.id}: ${message}`);
      }
    }

    // Stamp last_sync_at on the server row for the UI
    await supabaseAdmin
      .from('media_servers')
      .update({ last_sync_at: new Date().toISOString() })
      .eq('id', server.id);

    sendSuccess(res, {
      server_id: server.id,
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
