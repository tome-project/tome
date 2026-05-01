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

  for (const book of scan.books) {
    try {
      const catalog = await ensureCatalog(book);
      const filePath = path.relative(scanBase, book.absolutePath);

      const { data: existing } = await hub
        .from('library_server_books')
        .select('id')
        .eq('server_id', identity.serverId)
        .eq('book_id', catalog.id)
        .maybeSingle();

      const payload = {
        server_id: identity.serverId,
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

      // Cover (best-effort): write a 400px JPEG to LIBRARY_PATH/covers/
      // and stamp catalog.cover_url if not already set.
      if (book.coverImage && !catalog.cover_url) {
        const dest = path.join(coversDir, `${catalog.id}.jpg`);
        try {
          if (!fs.existsSync(dest)) {
            await sharp(book.coverImage)
              .resize({ width: 400, withoutEnlargement: true })
              .jpeg()
              .toFile(dest);
          }
          // Cover URL points to this server — clients fetch via the
          // covers route. Could later fall back to Open Library cover
          // CDN for portability across servers.
          await hub
            .from('books')
            .update({ cover_url: `/covers/${catalog.id}` })
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
