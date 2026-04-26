import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { selectOne, upsertOne, query } from '../services/db';
import { sendError, sendSuccess } from '../utils';
import { scanLibrary, ScannedBook } from '../services/scanner';
import { ensureMinimalCatalogBook } from '../services/catalog';

const libraryPath = process.env.LIBRARY_PATH || './library';
// Scan source root. Defaults to LIBRARY_PATH so dev/local setups (where the
// scanner walks the same dir Tome owns for uploads/covers) keep working
// without explicit configuration. In production, point this at a read-only
// mount of the host's audiobook + ebook directories so Tome can ingest
// existing libraries without copying them.
const scanPath = process.env.SCAN_PATH || libraryPath;
const coversDir = path.join(libraryPath, 'covers');
if (!fs.existsSync(coversDir)) {
  fs.mkdirSync(coversDir, { recursive: true });
}

export const scannerRouter = Router();

// POST /api/v1/scanner/sync — walk LIBRARY_PATH and ingest every supported
// book file (m4b/m4a/epub) into the caller's library.
//
// Body: { subdir?: string, add_to_library?: boolean }
//   - subdir: optional sub-path under LIBRARY_PATH to limit the scan
//   - add_to_library: when true (default), each scanned book is auto-added
//     to user_books with status='want'
//
// Per scanned file:
//   1. Resolve catalog book via existing book_sources(file_path) match,
//      else ensureMinimalCatalogBook (ISBN-first via OpenLibrary, else
//      title+author dedup, else minimal insert).
//   2. Upsert book_sources row (kind='filesystem', owner_id=me,
//      file_path=relative-to-library) — unique per (book, owner, kind).
//   3. Best-effort cover write to <library>/covers/<book_id>.jpg.
//   4. Stamp last_scanned_at on the source.
scannerRouter.post('/api/v1/scanner/sync', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const { subdir, add_to_library } = (req.body ?? {}) as { subdir?: string; add_to_library?: boolean };

  // Resolve and harden the scan root: must stay inside SCAN_PATH.
  const scanBase = path.resolve(scanPath);
  const scanRoot = subdir ? path.resolve(scanBase, subdir) : scanBase;
  if (!scanRoot.startsWith(scanBase)) {
    sendError(res, 'subdir must be inside SCAN_PATH', 400);
    return;
  }

  let scan;
  try {
    scan = await scanLibrary(scanRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Scan failed';
    sendError(res, message, 500);
    return;
  }

  let added = 0;
  let reused = 0;
  const sourceErrors: string[] = [];
  const ingested: Array<{ title: string; author: string; media_type: string; relative_path: string }> = [];

  for (const book of scan.books) {
    try {
      // file_path is stored relative to SCAN_PATH. The streaming endpoint
      // resolves filesystem sources under SCAN_PATH (separate from
      // LIBRARY_PATH which holds covers/uploads/gutenberg).
      const filePathRelToScan = path.relative(scanBase, book.absolutePath);

      const { catalogBookId, wasReused } = await resolveCatalogBook(book, me, filePathRelToScan);

      try {
        await upsertOne(
          'book_sources',
          {
            book_id: catalogBookId,
            owner_id: me,
            kind: 'filesystem',
            media_type: book.mediaType,
            file_path: filePathRelToScan,
            tracks: book.tracks ? JSON.stringify(book.tracks) : null,
            last_scanned_at: new Date().toISOString(),
          },
          { onConflict: 'book_id,owner_id,kind' }
        );
      } catch (sourceErr) {
        const message = sourceErr instanceof Error ? sourceErr.message : 'Unknown error';
        sourceErrors.push(`Failed to attach source for "${book.metadata.title}": ${message}`);
        continue;
      }

      // Cover: write a normalized 400px JPEG to <library>/covers/<book_id>.jpg
      // and stamp catalog.cover_url. Best-effort; failures don't block ingest.
      if (book.coverImage) {
        const dest = path.join(coversDir, `${catalogBookId}.jpg`);
        const targetUrl = `/api/v1/covers/${catalogBookId}`;
        try {
          if (!fs.existsSync(dest)) {
            await sharp(book.coverImage)
              .resize({ width: 400, withoutEnlargement: true })
              .jpeg()
              .toFile(dest);
          }
          await query(
            'UPDATE books SET cover_url = $1 WHERE id = $2 AND cover_url IS NULL',
            [targetUrl, catalogBookId]
          );
        } catch {
          // Best-effort; cover can be re-fetched on next scan.
        }
      }

      if (add_to_library !== false) {
        await upsertOne(
          'user_books',
          { user_id: me, book_id: catalogBookId, status: 'want' },
          { onConflict: 'user_id,book_id', ignoreDuplicates: true }
        );
      }

      if (wasReused) reused++; else added++;
      ingested.push({
        title: book.metadata.title,
        author: book.metadata.authors[0] ?? 'Unknown',
        media_type: book.mediaType,
        relative_path: filePathRelToScan,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      sourceErrors.push(`Failed to process ${book.relativePath}: ${message}`);
    }
  }

  sendSuccess(res, {
    scan_root: scan.rootPath,
    found: scan.books.length,
    added,
    reused,
    skipped: scan.skipped.length > 0 ? scan.skipped : undefined,
    scan_errors: scan.errors.length > 0 ? scan.errors : undefined,
    source_errors: sourceErrors.length > 0 ? sourceErrors : undefined,
    books: ingested,
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Resolve (or create) a catalog book id for a scanned file. We dedup along
// two axes:
//   1. Same owner + filesystem source already pointing at this file_path:
//      reuse the existing book row.
//   2. Otherwise call ensureMinimalCatalogBook, which itself dedups by ISBN
//      (via OpenLibrary import) or by (title, primary author).
async function resolveCatalogBook(
  book: ScannedBook,
  ownerId: string,
  filePathRelToScan: string
): Promise<{ catalogBookId: string; wasReused: boolean }> {
  const existingSource = await selectOne<{ book_id: string }>(
    `SELECT book_id FROM book_sources
      WHERE owner_id = $1 AND kind = 'filesystem' AND file_path = $2`,
    [ownerId, filePathRelToScan]
  );
  if (existingSource) {
    return { catalogBookId: existingSource.book_id, wasReused: true };
  }

  const catalog = await ensureMinimalCatalogBook({
    title: book.metadata.title,
    authors: book.metadata.authors,
    subtitle: book.metadata.subtitle,
    description: book.metadata.description,
    publisher: book.metadata.publisher,
    published_year: book.metadata.publishedYear,
    genres: [],
    language: book.metadata.language ?? 'en',
    isbn: book.metadata.isbn,
  });
  return { catalogBookId: catalog.id, wasReused: false };
}
