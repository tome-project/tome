/**
 * Prune stale catalog `books` rows that no longer exist on any library
 * server — mostly merge artifacts (Part 1/2 splits, Shadows of Self - NN)
 * and duplicate Gutenberg/import rows.
 *
 * Safe rules:
 *   • Never touches books still in library_server_books
 *   • Never touches books with highlights or book_requests refs
 *   • Migrates reading_progress to the on-library canonical title match
 *     before deleting duplicates
 *
 * Usage (from server/):
 *   npx tsx scripts/prune-orphan-catalog.ts --dry-run
 *   npx tsx scripts/prune-orphan-catalog.ts --apply
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import {
  cleanTitleForSeriesLookup,
} from '../src/services/series-lookup';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const dryRun = !apply || process.argv.includes('--dry-run');

const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface BookRow {
  id: string;
  title: string;
  created_at: string | null;
}

function normalizeTitle(title: string): string {
  let t = cleanTitleForSeriesLookup(title).toLowerCase();
  t = t.replace(/,\s*part\s+\d+\s*$/i, '');
  t = t.replace(/\s[-–]\s*\d{1,3}$/, '');
  t = t.replace(/^\s*[a-z]{1,6}-\d+(?:\.\d+)?\s+/i, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function isMergeArtifact(title: string): boolean {
  if (/,\s*part\s+\d+/i.test(title)) return true;
  if (/shadows of self\s*-\s*\d+/i.test(title)) return true;
  if (/brandon sanderson\s*-\s*mistborn.*part\s+\d+/i.test(title)) return true;
  if (/mistborn \d+.*part\s+\d+/i.test(title)) return true;
  return false;
}

async function fetchAll<T>(
  table: string,
  select: string,
): Promise<T[]> {
  const out: T[] = [];
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    const { data, error } = await sb
      .from(table)
      .select(select)
      .range(offset, offset + page - 1);
    if (error) throw error;
    if (!data?.length) break;
    out.push(...(data as T[]));
    if (data.length < page) break;
  }
  return out;
}

async function main() {
  const books = await fetchAll<BookRow>('books', 'id,title,created_at');
  const lsb = await fetchAll<{ book_id: string }>(
    'library_server_books',
    'book_id',
  );
  const onLibrary = new Set(lsb.map((r) => r.book_id));

  const liveBooks = books.filter((b) => onLibrary.has(b.id));
  const canonicalByNorm = new Map<string, string>();
  for (const b of liveBooks) {
    canonicalByNorm.set(normalizeTitle(b.title), b.id);
  }

  const orphans = books.filter((b) => !onLibrary.has(b.id));

  const highlights = await fetchAll<{ book_id: string }>(
    'highlights',
    'book_id',
  );
  const hlRefs = new Set(highlights.map((h) => h.book_id));

  const requests = await fetchAll<{
    source_book_id: string | null;
    fulfilled_book_id: string | null;
  }>('book_requests', 'source_book_id,fulfilled_book_id');
  const reqRefs = new Set<string>();
  for (const r of requests) {
    if (r.source_book_id) reqRefs.add(r.source_book_id);
    if (r.fulfilled_book_id) reqRefs.add(r.fulfilled_book_id);
  }

  const blocked = new Set<string>();
  for (const id of [...hlRefs, ...reqRefs]) blocked.add(id);

  const clubs = await fetchAll<{ book_id: string | null }>('clubs', 'book_id');
  for (const c of clubs) {
    if (c.book_id) blocked.add(c.book_id);
  }

  try {
    const clubPicks = await fetchAll<{ book_id: string | null }>(
      'club_picks',
      'book_id',
    );
    for (const c of clubPicks) {
      if (c.book_id) blocked.add(c.book_id);
    }
  } catch {
    // optional table
  }

  const progress = await fetchAll<{
    id: string;
    user_id: string;
    book_id: string;
    percentage: number | null;
  }>('reading_progress', 'id,user_id,book_id,percentage');

  const userBooks = await fetchAll<{ user_id: string; book_id: string }>(
    'user_books',
    'user_id,book_id',
  );

  const toDelete = new Set<string>();
  const migrate: Array<{ from: string; to: string; userId: string }> = [];

  // Pass 1: merge artifacts (unless blocked)
  for (const b of orphans) {
    if (blocked.has(b.id)) continue;
    if (!isMergeArtifact(b.title)) continue;
    toDelete.add(b.id);
  }

  // Pass 2: duplicate orphans — same normalized title, not on library
  const dupGroups = new Map<string, BookRow[]>();
  for (const b of orphans) {
    if (toDelete.has(b.id) || blocked.has(b.id)) continue;
    const norm = normalizeTitle(b.title);
    if (!norm) continue;
    const group = dupGroups.get(norm) ?? [];
    group.push(b);
    dupGroups.set(norm, group);
  }

  for (const [, group] of dupGroups) {
    if (group.length < 2) continue;
    const canonical = canonicalByNorm.get(normalizeTitle(group[0]!.title));
    // Sort: prefer keeping rows with more progress, else oldest
    const score = (id: string) => {
      const rows = progress.filter((p) => p.book_id === id);
      return Math.max(0, ...rows.map((p) => p.percentage ?? 0));
    };
    group.sort((a, b) => {
      const d = score(b.id) - score(a.id);
      if (d !== 0) return d;
      return (a.created_at ?? '').localeCompare(b.created_at ?? '');
    });
    const keeper = group[0]!;
    for (const dup of group.slice(1)) {
      if (blocked.has(dup.id)) continue;
      toDelete.add(dup.id);
      if (canonical && canonical !== dup.id) {
        for (const p of progress.filter((pr) => pr.book_id === dup.id)) {
          migrate.push({ from: dup.id, to: canonical, userId: p.user_id });
        }
      }
    }
    // If a canonical exists on library, delete all dupes including keeper
    if (canonical) {
      for (const dup of group) {
        if (blocked.has(dup.id)) continue;
        toDelete.add(dup.id);
        for (const p of progress.filter((pr) => pr.book_id === dup.id)) {
          migrate.push({ from: dup.id, to: canonical, userId: p.user_id });
        }
      }
    }
  }

  // Pass 3: zero-ref orphans (no user_books, no progress, not blocked)
  const ubRefs = new Set(userBooks.map((u) => u.book_id));
  const progRefs = new Set(progress.map((p) => p.book_id));
  for (const b of orphans) {
    if (toDelete.has(b.id) || blocked.has(b.id)) continue;
    if (ubRefs.has(b.id) || progRefs.has(b.id)) continue;
    toDelete.add(b.id);
  }

  // Pass 4: orphans with ONLY user_books (stale scan shelf rows)
  for (const b of orphans) {
    if (toDelete.has(b.id) || blocked.has(b.id)) continue;
    if (!ubRefs.has(b.id)) continue;
    if (progRefs.has(b.id)) continue;
    if (isMergeArtifact(b.title) || canonicalByNorm.has(normalizeTitle(b.title))) {
      toDelete.add(b.id);
    }
  }

  const deleteIds = [...toDelete].filter((id) => !onLibrary.has(id));
  const uniqueMigrate = migrate.filter(
    (m, i, arr) =>
      arr.findIndex(
        (x) => x.from === m.from && x.to === m.to && x.userId === m.userId,
      ) === i,
  );

  console.log(
    `${dryRun ? '[dry-run] ' : ''}orphans=${orphans.length} delete=${deleteIds.length} migrate=${uniqueMigrate.length} blocked=${blocked.size}`,
  );

  if (deleteIds.length <= 40) {
    for (const id of deleteIds) {
      const b = books.find((x) => x.id === id);
      console.log(`  delete ${b?.title?.slice(0, 70) ?? id}`);
    }
  } else {
    for (const id of deleteIds.slice(0, 25)) {
      const b = books.find((x) => x.id === id);
      console.log(`  delete ${b?.title?.slice(0, 70) ?? id}`);
    }
    console.log(`  … and ${deleteIds.length - 25} more`);
  }

  if (dryRun) {
    console.log('\nRe-run with --apply to execute.');
    return;
  }

  for (const m of uniqueMigrate) {
    const { data: existing } = await sb
      .from('reading_progress')
      .select('id,percentage')
      .eq('user_id', m.userId)
      .eq('book_id', m.to)
      .maybeSingle();
    const fromRow = progress.find(
      (p) => p.user_id === m.userId && p.book_id === m.from,
    );
    if (!fromRow) continue;
    if (existing) {
      const keep =
        (existing.percentage ?? 0) >= (fromRow.percentage ?? 0)
          ? existing
          : fromRow;
      await sb
        .from('reading_progress')
        .update({ percentage: keep.percentage })
        .eq('id', existing.id);
      await sb.from('reading_progress').delete().eq('id', fromRow.id);
    } else {
      await sb
        .from('reading_progress')
        .update({ book_id: m.to })
        .eq('id', fromRow.id);
    }
  }

  const batch = 50;
  for (let i = 0; i < deleteIds.length; i += batch) {
    const chunk = deleteIds.slice(i, i + batch);
    await sb.from('user_books').delete().in('book_id', chunk);
    await sb.from('reading_progress').delete().in('book_id', chunk);
    const { error } = await sb.from('books').delete().in('id', chunk);
    if (error) throw error;
    console.log(`deleted ${Math.min(i + batch, deleteIds.length)}/${deleteIds.length}`);
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
