import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { Router, Request, Response } from 'express';
import { requireSupabaseAuth } from '../middleware/supabase-auth';
import { hubClient } from '../services/hub';
import { loadIdentity } from '../services/server-identity';
import { scanLibrary, ScannedBook } from '../services/scanner';

export const scannerRouter = Router();

const libraryPath = process.env.LIBRARY_PATH || './library';
const coversDir = path.join(libraryPath, 'covers');
if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });

interface CatalogBook {
  id: string;
  title: string;
  authors: string[];
  cover_url: string | null;
}

/// Look up (or create) a catalog row for a scanned book. Dedup order:
///   1. ISBN-13 / ISBN-10 if the file's metadata has it.
///   2. Exact (title, primary_author) match (case-sensitive — same as the
///      legacy ensureMinimalCatalogBook behavior).
///   3. Insert a new minimal row.
async function ensureCatalog(book: ScannedBook): Promise<CatalogBook> {
  const hub = hubClient();
  const isbn = book.metadata.isbn?.replace(/[-\s]/g, '');

  if (isbn && isbn.length === 13) {
    const { data } = await hub.from('books').select('*').eq('isbn_13', isbn).maybeSingle();
    if (data) return data as CatalogBook;
  }
  if (isbn && isbn.length === 10) {
    const { data } = await hub.from('books').select('*').eq('isbn_10', isbn).maybeSingle();
    if (data) return data as CatalogBook;
  }

  // Title + first-author match.
  const primary = book.metadata.authors[0];
  if (primary) {
    const { data } = await hub
      .from('books')
      .select('*')
      .eq('title', book.metadata.title)
      .contains('authors', [primary])
      .maybeSingle();
    if (data) return data as CatalogBook;
  }

  // Insert minimal row.
  const { data: inserted, error } = await hub
    .from('books')
    .insert({
      title: book.metadata.title,
      subtitle: book.metadata.subtitle ?? null,
      authors: book.metadata.authors,
      description: book.metadata.description ?? null,
      publisher: book.metadata.publisher ?? null,
      published_year: book.metadata.publishedYear ?? null,
      language: book.metadata.language ?? 'en',
      isbn_13: isbn && isbn.length === 13 ? isbn : null,
      isbn_10: isbn && isbn.length === 10 ? isbn : null,
    })
    .select()
    .single();
  if (error) throw error;
  return inserted as CatalogBook;
}

/// POST /scan — walk LIBRARY_PATH and register every supported book in
/// library_server_books. Owner-only.
///
/// Body (optional): { subdir?: string }
scannerRouter.post('/scan', requireSupabaseAuth, async (req: Request, res: Response) => {
  const identity = loadIdentity();
  if (!identity) {
    res.status(503).json({ success: false, error: 'Library server not paired' });
    return;
  }
  if (req.supabaseUserId !== identity.ownerId) {
    res.status(403).json({ success: false, error: 'Only the library owner can trigger a scan' });
    return;
  }

  const subdir = (req.body?.subdir ?? '').toString();
  const scanBase = path.resolve(libraryPath);
  const scanRoot = subdir ? path.resolve(scanBase, subdir) : scanBase;
  if (!scanRoot.startsWith(scanBase)) {
    res.status(400).json({ success: false, error: 'subdir must be inside LIBRARY_PATH' });
    return;
  }

  let scan;
  try {
    scan = await scanLibrary(scanRoot);
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Scan failed',
    });
    return;
  }

  const hub = hubClient();
  let added = 0;
  let updated = 0;
  const errors: string[] = [];

  // Ensure a library_collections row exists for each top-level subdir we
  // observed. Mirrors the auto-scan path in scan-on-startup.ts.
  const { data: existingCollectionRows } = await hub
    .from('library_collections')
    .select('id, rel_path')
    .eq('server_id', identity.serverId);
  const collectionByRel = new Map<string, string>(
    ((existingCollectionRows as Array<{ id: string; rel_path: string }>) ?? []).map(
      (r) => [r.rel_path, r.id],
    ),
  );
  for (const rel of scan.collectionRels) {
    if (collectionByRel.has(rel)) continue;
    const name = rel === '' ? 'Unsorted' : rel;
    const { data, error } = await hub
      .from('library_collections')
      .insert({ server_id: identity.serverId, rel_path: rel, name })
      .select('id, rel_path')
      .single();
    if (error) {
      errors.push(`Failed to create collection "${rel}": ${error.message}`);
      continue;
    }
    collectionByRel.set(data.rel_path, data.id);
  }

  for (const book of scan.books) {
    try {
      const catalog = await ensureCatalog(book);
      const filePath = path.relative(scanBase, book.absolutePath);
      const collectionId = collectionByRel.get(book.collectionRel);
      if (!collectionId) {
        errors.push(
          `No collection for rel="${book.collectionRel}" on "${book.metadata.title}"`,
        );
        continue;
      }

      const { data: existing } = await hub
        .from('library_server_books')
        .select('id')
        .eq('server_id', identity.serverId)
        .eq('book_id', catalog.id)
        .maybeSingle();

      const payload = {
        server_id: identity.serverId,
        collection_id: collectionId,
        book_id: catalog.id,
        file_path: filePath,
        media_type: book.mediaType,
        file_size_bytes: book.fileSize ?? null,
        tracks: book.tracks ? book.tracks : null,
        last_scanned_at: new Date().toISOString(),
      };

      if (existing) {
        await hub.from('library_server_books').update(payload).eq('id', existing.id);
        updated++;
      } else {
        await hub.from('library_server_books').insert(payload);
        added++;
      }

      // Also add the book to the owner's shelf so it shows up in their
      // Library tab on first scan. Idempotent — if the row already
      // exists (the owner manually added it), upsert preserves their
      // status / rating / review.
      await hub.from('user_books').upsert(
        {
          user_id: identity.ownerId,
          book_id: catalog.id,
          status: 'want',
          source: 'library_server',
        },
        { onConflict: 'user_id,book_id', ignoreDuplicates: true },
      );

      // Cover (best-effort): write a 400px JPEG to LIBRARY_PATH/covers/
      // and stamp catalog.cover_url with the absolute URL of this
      // server's covers route. Using PUBLIC_URL when set so clients
      // (potentially behind a tunnel) can fetch from anywhere.
      if (book.coverImage && !catalog.cover_url) {
        const dest = path.join(coversDir, `${catalog.id}.jpg`);
        try {
          if (!fs.existsSync(dest)) {
            await sharp(book.coverImage)
              .resize({ width: 400, withoutEnlargement: true })
              .jpeg()
              .toFile(dest);
          }
          const baseUrl = (process.env.PUBLIC_URL ?? '').replace(/\/$/, '');
          const coverUrl = baseUrl
            ? `${baseUrl}/covers/${catalog.id}`
            : `/covers/${catalog.id}`;
          await hub
            .from('books')
            .update({ cover_url: coverUrl })
            .eq('id', catalog.id)
            .is('cover_url', null);
        } catch {
          // best-effort
        }
      }
    } catch (err) {
      errors.push(
        `Failed to register "${book.metadata.title}": ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  res.json({
    success: true,
    data: {
      scan_root: scan.rootPath,
      found: scan.books.length,
      added,
      updated,
      skipped: scan.skipped.length > 0 ? scan.skipped : undefined,
      scan_errors: scan.errors.length > 0 ? scan.errors : undefined,
      errors: errors.length > 0 ? errors : undefined,
    },
  });
});
