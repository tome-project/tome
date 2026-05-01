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

/// Module-level state so /pair/status can show "currently scanning" and
/// the last completion summary without waking the database.
interface ScanState {
  inProgress: boolean;
  startedAt: string | null;
  completedAt: string | null;
  lastSummary: ScanSummary | null;
}

export interface ScanSummary {
  found: number;
  added: number;
  updated: number;
  pruned: number;
  errors: number;
  durationMs: number;
}

const _state: ScanState = {
  inProgress: false,
  startedAt: null,
  completedAt: null,
  lastSummary: null,
};

export function scanState(): ScanState {
  return { ..._state };
}

/// Scan LIBRARY_PATH and reconcile library_server_books. Adds new files,
/// updates existing rows, prunes rows whose file no longer exists on
/// disk. Concurrency-bounded so we don't choke on large libraries.
///
/// Idempotent — safe to call on every boot. Skipped if a previous scan
/// is already in progress (so a manual POST /scan during the boot scan
/// returns the in-progress status instead of doubling the work).
export async function runScanForOwner(): Promise<ScanSummary | null> {
  const identity = loadIdentity();
  if (!identity) return null;
  if (_state.inProgress) {
    console.log('[scan] skipping — another scan is already in progress');
    return null;
  }

  _state.inProgress = true;
  _state.startedAt = new Date().toISOString();
  if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });

  const startMs = Date.now();
  console.log(`[scan] starting from ${libraryPath} for owner ${identity.ownerId}`);

  let summary: ScanSummary;
  try {
    const scan = await scanLibrary(libraryPath);
    console.log(`[scan] found ${scan.books.length} book file(s) — ingesting`);

    const hub = hubClient();
    const seenBookIds = new Set<string>();
    let added = 0;
    let updated = 0;
    let errors = 0;

    // Bounded concurrency — too parallel and Supabase rate-limits us;
    // serial is too slow for a 200-book library.
    const WORKERS = 4;
    const queue = [...scan.books];
    const inFlight: Array<Promise<void>> = [];

    const worker = async (book: typeof scan.books[number]) => {
      try {
        const catalog = await ensureCatalog(book);
        seenBookIds.add(catalog.id);
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
        errors++;
        console.error(`[scan] failed for "${book.metadata.title}":`, err);
      }
    };

    while (queue.length > 0 || inFlight.length > 0) {
      while (inFlight.length < WORKERS && queue.length > 0) {
        const book = queue.shift()!;
        const p = worker(book).then(() => {
          const idx = inFlight.indexOf(p);
          if (idx >= 0) inFlight.splice(idx, 1);
        });
        inFlight.push(p);
      }
      if (inFlight.length > 0) await Promise.race(inFlight);
    }

    // Prune: drop library_server_books rows whose file is no longer on
    // disk (user deleted the file, renamed, etc.). The user_books rows
    // stay — the user might have rated/reviewed; just losing the file
    // doesn't mean losing the shelf entry.
    let pruned = 0;
    try {
      const { data: existingRows } = await hub
        .from('library_server_books')
        .select('id, book_id')
        .eq('server_id', identity.serverId);
      const stale = (existingRows ?? []).filter((r: { book_id: string }) => !seenBookIds.has(r.book_id));
      if (stale.length > 0) {
        const ids = stale.map((r: { id: string }) => r.id);
        await hub.from('library_server_books').delete().in('id', ids);
        pruned = stale.length;
      }
    } catch (err) {
      console.error('[scan] prune step failed:', err);
    }

    summary = {
      found: scan.books.length,
      added,
      updated,
      pruned,
      errors,
      durationMs: Date.now() - startMs,
    };
    console.log(
      `[scan] done — ${added} added, ${updated} updated, ${pruned} pruned, ${errors} errors in ${summary.durationMs}ms`,
    );
  } finally {
    _state.inProgress = false;
    _state.completedAt = new Date().toISOString();
  }
  _state.lastSummary = summary;
  return summary;
}
