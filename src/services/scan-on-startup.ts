import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { hubClient } from './hub';
import { loadIdentity } from './server-identity';
import { scanLibrary, ScannedBook } from './scanner';

const libraryPath = process.env.LIBRARY_PATH || './library';
const coversDir = path.join(libraryPath, 'covers');

interface CatalogBook {
  id: string;
  cover_url: string | null;
}

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

/// Scan LIBRARY_PATH and register every supported book under the owner's
/// shelf. Called once on server startup (if paired) and reusable as the
/// implementation behind POST /scan. Doesn't require an HTTP request, so
/// can run from anywhere with access to the env vars.
export async function runScanForOwner(): Promise<void> {
  const identity = loadIdentity();
  if (!identity) return;
  if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });

  console.log(`[scan] starting from ${libraryPath} for owner ${identity.ownerId}`);
  const scan = await scanLibrary(libraryPath);
  console.log(`[scan] found ${scan.books.length} book file(s)`);

  const hub = hubClient();
  let added = 0;
  let updated = 0;

  for (const book of scan.books) {
    try {
      const catalog = await ensureCatalog(book);
      const filePath = path.relative(libraryPath, book.absolutePath);

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

      await hub.from('user_books').upsert(
        { user_id: identity.ownerId, book_id: catalog.id, status: 'want', source: 'library_server' },
        { onConflict: 'user_id,book_id', ignoreDuplicates: true },
      );

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
          const coverUrl = baseUrl ? `${baseUrl}/covers/${catalog.id}` : `/covers/${catalog.id}`;
          await hub.from('books').update({ cover_url: coverUrl }).eq('id', catalog.id).is('cover_url', null);
        } catch {
          // best-effort
        }
      }
    } catch (err) {
      console.error(`[scan] failed for "${book.metadata.title}":`, err);
    }
  }

  console.log(`[scan] done — ${added} added, ${updated} updated`);
}
