/**
 * One-shot backfill of books.series_name / series_position from:
 *   1. library_server_books.file_path folder heuristics
 *   2. detectSeries() (title heuristics + Open Library / Google)
 *
 * Usage (from server/):
 *   npx tsx scripts/backfill-series.ts
 *   npx tsx scripts/backfill-series.ts --limit=50
 *   npx tsx scripts/backfill-series.ts --force   # re-run even if attempted
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import {
  detectSeries,
  inferSeriesFromFolderName,
  inferSeriesFromPath,
} from '../src/services/series-lookup';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}

const force = process.argv.includes('--force');
const pathOnly = process.argv.includes('--path-only');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]!, 10) : 0;

const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface BookRow {
  id: string;
  title: string;
  authors: string[] | null;
  isbn_13: string | null;
  series_name: string | null;
  series_position: number | null;
  series_lookup_attempted_at: string | null;
}

async function main() {
  let q = sb
    .from('books')
    .select(
      'id, title, authors, isbn_13, series_name, series_position, series_lookup_attempted_at',
    )
    .order('created_at', { ascending: true });
  if (!force) {
    q = q.is('series_lookup_attempted_at', null);
  }
  if (limit > 0) q = q.limit(limit);

  const { data: books, error } = await q;
  if (error) throw error;
  const rows = (books ?? []) as BookRow[];
  console.log(
    `Backfilling series for ${rows.length} books (force=${force} pathOnly=${pathOnly})`,
  );

  // Prefetch file paths for path-based inference
  const ids = rows.map((b) => b.id);
  const pathByBook = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { data: lsb } = await sb
      .from('library_server_books')
      .select('book_id, file_path')
      .in('book_id', chunk);
    for (const row of lsb ?? []) {
      const bid = row.book_id as string;
      if (!pathByBook.has(bid) && row.file_path) {
        pathByBook.set(bid, row.file_path as string);
      }
    }
  }

  let stamped = 0;
  let empty = 0;
  let failed = 0;

  for (const book of rows) {
    try {
      let detected =
        inferSeriesFromPath(pathByBook.get(book.id) ?? '') ??
        inferSeriesFromFolderName(book.title) ??
        (pathOnly
          ? null
          : await detectSeries(book.title, book.authors ?? [], book.isbn_13));
      const { error: upErr } = await sb
        .from('books')
        .update({
          series_name: detected?.name ?? null,
          series_position: detected?.position ?? null,
          series_lookup_attempted_at: new Date().toISOString(),
        })
        .eq('id', book.id);
      if (upErr) throw upErr;

      if (detected?.name) {
        stamped++;
        console.log(
          `  ✓ ${book.title.slice(0, 60)} → ${detected.name}` +
            (detected.position != null ? ` #${detected.position}` : ''),
        );
      } else {
        empty++;
      }

      // Be gentle on external APIs when we fall through to them
      if (!pathOnly && !detected) {
        await new Promise((r) => setTimeout(r, 120));
      }
    } catch (err) {
      failed++;
      console.error(`  ✗ ${book.title}:`, err);
    }
  }

  console.log(
    `\nDone. stamped=${stamped} empty=${empty} failed=${failed} total=${rows.length}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
