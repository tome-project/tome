import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { selectOne, upsertOne, query } from '../services/db';
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

interface CatalogBookRow {
  id: string;
  title: string;
  authors: string[] | null;
  cover_url: string | null;
}

async function refreshCatalogBookAuthors(bookId: string, authors: string[]): Promise<CatalogBookRow> {
  const book = await selectOne<CatalogBookRow>('SELECT * FROM books WHERE id = $1', [bookId]);
  if (!book) throw new Error(`Catalog book ${bookId} not found`);
  const currentAuthors = book.authors ?? [];
  if (currentAuthors.length > 0 || authors.length === 0) return book;
  const updated = await selectOne<CatalogBookRow>(
    'UPDATE books SET authors = $1 WHERE id = $2 RETURNING *',
    [authors, bookId]
  );
  if (!updated) throw new Error(`Failed to refresh authors for ${bookId}`);
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

  let server: {
    id: string;
    url: string;
    kind: string;
    token_encrypted: string;
  } | null;
  try {
    server = await selectOne(
      'SELECT id, url, kind, token_encrypted FROM media_servers WHERE id = $1 AND owner_id = $2',
      [server_id, me]
    );
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
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
    token = decryptToken(server.token_encrypted);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token decryption failed';
    sendError(res, message, 500);
    return;
  }

  try {
    const abs = new AudiobookshelfService(server.url, token);
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

        // Reuse existing catalog book if we've synced this ABS item before.
        let catalogBookId: string | null = null;
        const existingSource = await selectOne<{ book_id: string }>(
          `SELECT book_id FROM book_sources
            WHERE owner_id = $1 AND kind = 'audiobookshelf' AND external_id = $2`,
          [me, item.id]
        );
        if (existingSource) catalogBookId = existingSource.book_id;

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

        let sourceCreatedAt: string | null = null;
        try {
          const source = await upsertOne<{ created_at: string }>(
            'book_sources',
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
          );
          sourceCreatedAt = source?.created_at ?? null;
        } catch (sourceErr) {
          const message = sourceErr instanceof Error ? sourceErr.message : 'Source upsert failed';
          errors.push(`Failed to attach source for "${title}": ${message}`);
          continue;
        }

        // Cover: write a local thumbnail if missing and stamp catalog.cover_url.
        if (item.media.coverPath) {
          const dest = path.join(coversDir, `${catalogBook.id}.jpg`);
          const targetUrl = `/api/v1/covers/${catalogBook.id}`;
          try {
            if (fs.existsSync(dest)) {
              if (catalogBook.cover_url !== targetUrl) {
                await query('UPDATE books SET cover_url = $1 WHERE id = $2', [targetUrl, catalogBook.id]);
              }
            } else {
              const buf = await abs.getItemCover(item.id);
              if (buf) {
                await sharp(buf)
                  .resize({ width: 400, withoutEnlargement: true })
                  .jpeg()
                  .toFile(dest);
                await query('UPDATE books SET cover_url = $1 WHERE id = $2', [targetUrl, catalogBook.id]);
              }
            }
          } catch {
            // best-effort; covers can be re-fetched on next sync
          }
        }

        if (add_to_library !== false) {
          await upsertOne(
            'user_books',
            { user_id: me, book_id: catalogBook.id, status: 'want' },
            { onConflict: 'user_id,book_id', ignoreDuplicates: true }
          );
        }

        const wasNew = sourceCreatedAt
          ? new Date(sourceCreatedAt).getTime() > Date.now() - 5_000
          : false;
        if (wasNew) added++;
        else reused++;

        books.push({ title, author: primaryAuthor, media_type });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        errors.push(`Failed to process item ${item.id}: ${message}`);
      }
    }

    await query(
      'UPDATE media_servers SET last_sync_at = $1 WHERE id = $2',
      [new Date().toISOString(), server.id]
    );

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
