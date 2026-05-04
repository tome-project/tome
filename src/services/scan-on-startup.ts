import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { hubClient } from './hub';
import { loadIdentity } from './server-identity';
import { scanLibrary, ScannedBook } from './scanner';
import { lookupExternalCover } from './cover-lookup';

const libraryPath = process.env.LIBRARY_PATH || './library';
const coversDir = path.join(libraryPath, 'covers');

interface CatalogBook {
  id: string;
  cover_url: string | null;
}

/// Ensure a library_collections row exists for each top-level subdir
/// observed in the scan. Returns a map: rel_path → collection_id, ready
/// to stamp onto library_server_books rows during ingestion.
///
/// Collections are owner-scoped: the scanner discovers them from disk,
/// so the owner doesn't have to manage them in the UI for the basic
/// case. Renames are a UI concern — the scanner only sets the initial
/// `name` (defaults to the directory basename, or "Unsorted" for the
/// synthetic root collection).
async function ensureCollections(
  serverId: string,
  collectionRels: string[],
): Promise<Map<string, string>> {
  const hub = hubClient();
  const { data: existingRows } = await hub
    .from('library_collections')
    .select('id, rel_path')
    .eq('server_id', serverId);
  const existing = new Map<string, string>(
    ((existingRows as Array<{ id: string; rel_path: string }>) ?? []).map(
      (r) => [r.rel_path, r.id],
    ),
  );

  for (const rel of collectionRels) {
    if (existing.has(rel)) continue;
    const name = rel === '' ? 'Unsorted' : rel;
    const { data, error } = await hub
      .from('library_collections')
      .insert({ server_id: serverId, rel_path: rel, name })
      .select('id, rel_path')
      .single();
    if (error) {
      console.error(`[scan] failed to create collection rel="${rel}":`, error);
      continue;
    }
    existing.set(data.rel_path, data.id);
  }

  return existing;
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

    // Ensure a library_collections row for every top-level subdir we saw.
    // The book ingest below stamps collection_id from this map.
    const collectionByRel = await ensureCollections(
      identity.serverId,
      scan.collectionRels,
    );

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
        const collectionId = collectionByRel.get(book.collectionRel);
        if (!collectionId) {
          console.error(
            `[scan] no collection for rel="${book.collectionRel}" — skipping "${book.metadata.title}"`,
          );
          errors++;
          return;
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

        await hub.from('user_books').upsert(
          { user_id: identity.ownerId, book_id: catalog.id, status: 'want', source: 'library_server' },
          { onConflict: 'user_id,book_id', ignoreDuplicates: true },
        );

        // Local-first cover image: ID3 embedded art, folder cover.jpg,
        // or EPUB cover (whatever the scanner could pull off disk).
        // When the scanner came up empty AND the catalog has no
        // cover_url yet, fall back to a network lookup against
        // Open Library / Google Books. This is what gives mp3-rip
        // libraries (no embedded art, no cover.jpg) real book covers
        // — the host runs the fetch once, grantees see the result.
        let coverBuffer: Buffer | null = book.coverImage;
        if (!coverBuffer && !catalog.cover_url) {
          try {
            coverBuffer = await lookupExternalCover(
              book.metadata.title,
              book.metadata.authors,
              book.metadata.isbn,
            );
            if (coverBuffer) {
              console.log(
                `[scan] external cover hit for "${book.metadata.title}" (${coverBuffer.length} bytes)`,
              );
            }
          } catch (err) {
            console.error(`[scan] cover lookup failed for "${book.metadata.title}":`, err);
          }
        }

        if (coverBuffer && !catalog.cover_url) {
          const dest = path.join(coversDir, `${catalog.id}.jpg`);
          try {
            if (!fs.existsSync(dest)) {
              await sharp(coverBuffer)
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
