import { hubClient } from './hub';

/**
 * When the scanner registers a new library_server_books row, flip any
 * matching pending book_requests on the same server to fulfilled. This
 * closes the Jellyseerr-style loop: a friend asks for a title, the owner
 * (or an agent) drops the file in LIBRARY_PATH, the next scan picks it up
 * and the request flips automatically.
 *
 * Match priority (first hit wins per request; we update all pending rows
 * that match *any* strong key):
 *   1. isbn_13
 *   2. open_library_id
 *   3. google_books_id
 *   4. normalized title + first author (fallback for free-text / no-ISBN
 *      rips — only when the catalog book has a usable title+author)
 *
 * Title match is intentionally conservative: exact case-insensitive title
 * AND the catalog's primary author appears in the request's authors list
 * (or vice versa). False positives would silently fulfill the wrong book.
 */
export async function autoFulfillRequests(params: {
  serverId: string;
  catalogBookId: string;
  isbn13: string | null;
  openLibraryId?: string | null;
  googleBooksId?: string | null;
  title?: string | null;
  authors?: string[] | null;
}): Promise<number> {
  const hub = hubClient();
  const now = new Date().toISOString();
  const patch = {
    status: 'fulfilled' as const,
    fulfilled_at: now,
    fulfilled_book_id: params.catalogBookId,
  };

  let fulfilled = 0;

  const apply = async (filter: {
    column: string;
    value: string;
  }): Promise<void> => {
    try {
      const { data, error } = await hub
        .from('book_requests')
        .update(patch)
        .eq('server_id', params.serverId)
        .eq('status', 'pending')
        .eq(filter.column, filter.value)
        .select('id');
      if (error) {
        console.error(`[auto-fulfill] ${filter.column} match failed:`, error);
        return;
      }
      fulfilled += (data ?? []).length;
    } catch (err) {
      console.error(`[auto-fulfill] ${filter.column} match threw:`, err);
    }
  };

  if (params.isbn13) {
    await apply({ column: 'isbn_13', value: params.isbn13 });
  }
  if (params.openLibraryId) {
    await apply({ column: 'open_library_id', value: params.openLibraryId });
  }
  if (params.googleBooksId) {
    await apply({ column: 'google_books_id', value: params.googleBooksId });
  }

  // Title + author fallback for free-text requests / rips without external IDs.
  const title = params.title?.trim();
  const primaryAuthor = params.authors?.find((a) => a.trim().length > 0)?.trim();
  if (title && primaryAuthor) {
    try {
      const { data: candidates, error } = await hub
        .from('book_requests')
        .select('id, title, authors')
        .eq('server_id', params.serverId)
        .eq('status', 'pending')
        .ilike('title', title);
      if (error) {
        console.error('[auto-fulfill] title lookup failed:', error);
      } else {
        const authorNorm = normalizePerson(primaryAuthor);
        const hits = (candidates ?? []).filter((row) => {
          const reqAuthors = (row.authors as string[] | null) ?? [];
          if (reqAuthors.length === 0) {
            // Free-text request with title only — accept exact title match.
            return true;
          }
          return reqAuthors.some((a) => authorsOverlap(normalizePerson(a), authorNorm));
        });
        if (hits.length > 0) {
          const ids = hits.map((h) => h.id as string);
          const { data, error: upErr } = await hub
            .from('book_requests')
            .update(patch)
            .in('id', ids)
            .eq('status', 'pending')
            .select('id');
          if (upErr) {
            console.error('[auto-fulfill] title fulfill failed:', upErr);
          } else {
            fulfilled += (data ?? []).length;
          }
        }
      }
    } catch (err) {
      console.error('[auto-fulfill] title match threw:', err);
    }
  }

  if (fulfilled > 0) {
    console.log(
      `[auto-fulfill] fulfilled ${fulfilled} request(s) for book ${params.catalogBookId}`,
    );
  }
  return fulfilled;
}

function normalizePerson(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Brandon Sanderson" overlaps "Sanderson, Brandon" / "B. Sanderson". */
function authorsOverlap(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const aParts = a.split(' ').filter((p) => p.length > 1);
  const bParts = b.split(' ').filter((p) => p.length > 1);
  if (aParts.length === 0 || bParts.length === 0) return false;
  // Last-name match is enough when both have a multi-part name.
  const aLast = aParts[aParts.length - 1];
  const bLast = bParts[bParts.length - 1];
  return aLast === bLast && aLast.length >= 3;
}

/**
 * Walk every *pending* request on this server and fulfill any that already
 * have a matching book in library_server_books.
 *
 * This is the missing half of auto-fulfill: the insert-path only runs when
 * a *new* file is scanned. If the file was already on disk (common — the
 * family requests a book the host already ripped), nothing ever flipped
 * the request. Call this:
 *   - at the end of every scan
 *   - on a short interval while the server is up
 *   - from POST /api/v1/requests/reconcile
 */
export async function reconcilePendingRequests(
  serverId: string,
): Promise<{ checked: number; fulfilled: number }> {
  const hub = hubClient();
  const { data: pending, error: pErr } = await hub
    .from('book_requests')
    .select(
      'id, title, authors, isbn_13, open_library_id, google_books_id',
    )
    .eq('server_id', serverId)
    .eq('status', 'pending');
  if (pErr) {
    console.error('[auto-fulfill] reconcile load pending failed:', pErr);
    return { checked: 0, fulfilled: 0 };
  }
  if (!pending?.length) return { checked: 0, fulfilled: 0 };

  // All books currently hosted on this server + catalog identity.
  const { data: hosted, error: hErr } = await hub
    .from('library_server_books')
    .select(
      'book_id, books:book_id(id, title, authors, isbn_13, open_library_id, google_books_id)',
    )
    .eq('server_id', serverId);
  if (hErr) {
    console.error('[auto-fulfill] reconcile load library failed:', hErr);
    return { checked: pending.length, fulfilled: 0 };
  }

  type Catalog = {
    id: string;
    title: string | null;
    authors: string[] | null;
    isbn_13: string | null;
    open_library_id: string | null;
    google_books_id: string | null;
  };
  const catalog: Catalog[] = [];
  for (const row of hosted ?? []) {
    const b = row.books as Catalog | Catalog[] | null;
    if (!b) continue;
    if (Array.isArray(b)) {
      if (b[0]) catalog.push(b[0]);
    } else {
      catalog.push(b);
    }
  }

  let fulfilled = 0;
  const now = new Date().toISOString();

  for (const req of pending) {
    const match = findMatch(
      {
        title: req.title as string,
        authors: (req.authors as string[] | null) ?? [],
        isbn13: (req.isbn_13 as string | null) ?? null,
        openLibraryId: (req.open_library_id as string | null) ?? null,
        googleBooksId: (req.google_books_id as string | null) ?? null,
      },
      catalog,
    );
    if (!match) continue;

    const { data, error } = await hub
      .from('book_requests')
      .update({
        status: 'fulfilled',
        fulfilled_at: now,
        fulfilled_book_id: match.id,
      })
      .eq('id', req.id)
      .eq('status', 'pending')
      .select('id');
    if (error) {
      console.error('[auto-fulfill] reconcile fulfill failed:', error);
      continue;
    }
    if (data?.length) {
      fulfilled += data.length;
      console.log(
        `[auto-fulfill] reconciled request "${req.title}" → book ${match.id}`,
      );
    }
  }

  if (fulfilled > 0) {
    console.log(
      `[auto-fulfill] reconcile: fulfilled ${fulfilled}/${pending.length} pending`,
    );
  }
  return { checked: pending.length, fulfilled };
}

function findMatch(
  req: {
    title: string;
    authors: string[];
    isbn13: string | null;
    openLibraryId: string | null;
    googleBooksId: string | null;
  },
  catalog: Array<{
    id: string;
    title: string | null;
    authors: string[] | null;
    isbn_13: string | null;
    open_library_id: string | null;
    google_books_id: string | null;
  }>,
): { id: string } | null {
  if (req.isbn13) {
    const hit = catalog.find((c) => c.isbn_13 === req.isbn13);
    if (hit) return hit;
  }
  if (req.openLibraryId) {
    const hit = catalog.find((c) => c.open_library_id === req.openLibraryId);
    if (hit) return hit;
  }
  if (req.googleBooksId) {
    const hit = catalog.find((c) => c.google_books_id === req.googleBooksId);
    if (hit) return hit;
  }

  const reqTitle = normalizeTitle(req.title);
  if (!reqTitle) return null;
  const reqAuthorNorms = req.authors.map(normalizePerson).filter(Boolean);

  for (const c of catalog) {
    if (!c.title) continue;
    const cTitle = normalizeTitle(c.title);
    // Exact title, or either title contains the other (series folder noise
    // like "DCC 06 - The Eye of the Bedlam Bride" vs clean request title).
    const titleHit =
      cTitle === reqTitle ||
      cTitle.includes(reqTitle) ||
      reqTitle.includes(cTitle);
    if (!titleHit) continue;
    if (reqAuthorNorms.length === 0) return c;
    const cAuthors = (c.authors ?? []).map(normalizePerson);
    const authorHit = reqAuthorNorms.some((ra) =>
      cAuthors.some((ca) => authorsOverlap(ra, ca)),
    );
    if (authorHit) return c;
  }
  return null;
}
