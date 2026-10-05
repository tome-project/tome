import { Router, Request, Response } from 'express';
import { requireSupabaseAuth } from '../middleware/supabase-auth';
import { callerClient } from '../services/caller-client';
import { hubClient } from '../services/hub';
import { sendSuccess, sendError } from '../utils';
import {
  detectSeries,
  findInSeries,
  SeriesBookCandidate,
} from '../services/series-lookup';

export const requestsRouter = Router();

// ---------------------------------------------------------------------------
// GET /api/v1/books/:id/next-in-series
//
// Powers the Finished sheet's "Next up" section. Given a book the caller
// just finished, return:
//
//   { source_book: { id, title, series_name, series_position },
//     series_name: string | null,
//     next: SeriesNextCandidate[] }
//
// where each candidate carries its external metadata + the IDs of any
// servers the caller has access to that already host this book.
//
// Series metadata is detected lazily and cached on the books row
// (series_lookup_attempted_at gates re-attempts so we never re-hit the
// network for a book we've already tried). Detection is best-effort —
// indie/self-pub series often miss; clients should treat next=[] as
// "no series-aware suggestion, fall back to other shelves."
// ---------------------------------------------------------------------------

interface BookRow {
  id: string;
  title: string;
  authors: string[];
  isbn_13: string | null;
  series_name: string | null;
  series_position: number | null;
  series_lookup_attempted_at: Date | null;
}

interface CatalogMatch {
  id: string;
  isbn_13: string | null;
  title: string;
  authors: string[];
}

interface AvailableOn {
  server_id: string;
  owner_id: string;
  owner_display_name: string | null;
}

interface NextCandidate {
  title: string;
  authors: string[];
  isbn_13: string | null;
  open_library_id: string | null;
  google_books_id: string | null;
  cover_url: string | null;
  position: number | null;
  published_year: number | null;
  catalog_book_id: string | null;
  available_on: AvailableOn[];
}

requestsRouter.get(
  '/api/v1/books/:id/next-in-series',
  requireSupabaseAuth,
  async (req: Request, res: Response) => {
    const me = req.supabaseUserId!;
    const bookId = String(req.params.id);

    let book: BookRow | null;
    try {
      const { data, error } = await callerClient(req).from('books').select('*').eq('id', bookId).maybeSingle();
      if (error) throw error;
      book = data;

    } catch (err) {
      sendError(res, err instanceof Error ? err.message : 'Lookup failed', 500);
      return;
    }
    if (!book) {
      sendError(res, 'Book not found', 404);
      return;
    }

    // Lazy series detection. Cache result (or the empty attempt) on the
    // books row so we never re-hit external APIs for books we've already
    // tried.
    if (!book.series_lookup_attempted_at) {
      try {
        const detected = await detectSeries(book.title, book.authors, book.isbn_13);
        await hubClient().from('books').update({ series_name: detected?.name ?? null,
          series_position: detected?.position ?? null, series_lookup_attempted_at: new Date().toISOString() }).eq('id', bookId);
        book.series_name = detected?.name ?? null;
        book.series_position = detected?.position ?? null;
      } catch (err) {
        console.error('[next-in-series] detectSeries failed:', err);
      }
    }

    if (!book.series_name) {
      sendSuccess(res, {
        source_book: {
          id: book.id,
          title: book.title,
          authors: book.authors,
          series_name: null,
          series_position: null,
        },
        series_name: null,
        next: [] as NextCandidate[],
      });
      return;
    }

    // Pull every book in the series we can find externally. This is a
    // network hit on each call (no caching) — series compositions
    // change as new entries publish, and the volume is low (one call
    // per book completion).
    let allInSeries: SeriesBookCandidate[];
    try {
      allInSeries = await findInSeries(book.series_name, book.authors);
    } catch (err) {
      console.error('[next-in-series] findInSeries failed:', err);
      allInSeries = [];
    }

    // Filter to "after this one." When we know our position, drop
    // anything <= it. When we don't, return the whole list (let the
    // client decide).
    const nextOnly = book.series_position != null
      ? allInSeries.filter((c) => c.position != null && c.position > book.series_position!)
      : allInSeries;

    // Dedup: a candidate that came back with the same isbn / OL key as
    // the source book itself shouldn't appear (happens when the OL series
    // search returns the source book in its own list).
    const filtered = nextOnly.filter((c) => {
      if (book.isbn_13 && c.isbn_13 === book.isbn_13) return false;
      return true;
    });

    // Resolve catalog matches for everything we returned. One query
    // batched by isbn_13 (the strongest signal); a second pass tries
    // (title, first author) for anything that didn't isbn-match.
    const isbns = filtered.map((c) => c.isbn_13).filter((x): x is string => !!x);
    const { data: isbnRows, error: isbnError } = isbns.length > 0
      ? await callerClient(req).from('books').select('id,isbn_13,title,authors').in('isbn_13', isbns)
      : { data: [], error: null };
    if (isbnError) { sendError(res, 'Catalog unavailable', 503); return; }
    const isbnMatches = (isbnRows || []) as CatalogMatch[];
    const isbnMap = new Map(isbnMatches.map((r) => [r.isbn_13!, r.id]));

    // For candidates without isbn matches, try (title, first_author).
    const tplKey = (t: string, a: string) =>
      `${t.trim().toLowerCase()}|${a.trim().toLowerCase()}`;
    const titleAuthorPairs = filtered
      .filter((c) => !c.isbn_13 || !isbnMap.has(c.isbn_13))
      .map((c) => ({ title: c.title, author: c.authors[0] ?? '' }))
      .filter((p) => p.title && p.author);

    let titleMap = new Map<string, string>();
    if (titleAuthorPairs.length > 0) {
      const { data: titleRows, error } = await callerClient(req).from('books')
        .select('id,isbn_13,title,authors').in('title', titleAuthorPairs.map(p => p.title));
      if (error) { sendError(res, 'Catalog unavailable', 503); return; }
      const rows = (titleRows || []) as CatalogMatch[];
      for (const r of rows) {
        const a = r.authors[0] ?? '';
        titleMap.set(tplKey(r.title, a), r.id);
      }
    }

    // Resolve "where can the caller read it?" — every server that
    // hosts a matched book AND that the caller has access to (owner or
    // active grantee on the book's collection).
    const matchedBookIds = new Set<string>();
    const candidateToCatalogId = new Map<number, string>();
    filtered.forEach((c, i) => {
      let id = c.isbn_13 ? isbnMap.get(c.isbn_13) : undefined;
      if (!id) {
        const author = c.authors[0] ?? '';
        if (author) id = titleMap.get(tplKey(c.title, author));
      }
      if (id) {
        candidateToCatalogId.set(i, id);
        matchedBookIds.add(id);
      }
    });

    let availabilityByBook = new Map<string, AvailableOn[]>();
    if (matchedBookIds.size > 0) {
      const { data: hosted, error } = await callerClient(req).from('library_server_books')
        .select('book_id,server_id,library_servers!inner(owner_id)').in('book_id', Array.from(matchedBookIds));
      if (error) { sendError(res, 'Libraries unavailable', 503); return; }
      const rows = (hosted || []).map((r: any) => ({ ...r, owner_id: r.library_servers.owner_id, display_name: null }));
      for (const r of rows) {
        const list = availabilityByBook.get(r.book_id) ?? [];
        list.push({
          server_id: r.server_id,
          owner_id: r.owner_id,
          owner_display_name: r.display_name,
        });
        availabilityByBook.set(r.book_id, list);
      }
    }

    const next: NextCandidate[] = filtered.map((c, i) => {
      const catalogId = candidateToCatalogId.get(i) ?? null;
      return {
        title: c.title,
        authors: c.authors,
        isbn_13: c.isbn_13,
        open_library_id: c.open_library_id,
        google_books_id: c.google_books_id,
        cover_url: c.cover_url,
        position: c.position,
        published_year: c.published_year,
        catalog_book_id: catalogId,
        available_on: catalogId ? availabilityByBook.get(catalogId) ?? [] : [],
      };
    });

    sendSuccess(res, {
      source_book: {
        id: book.id,
        title: book.title,
        authors: book.authors,
        series_name: book.series_name,
        series_position: book.series_position,
      },
      series_name: book.series_name,
      next,
    });
  },
);
