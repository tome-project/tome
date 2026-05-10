/// External series-metadata lookup. Used by /api/v1/books/:id/next-in-series
/// to power the "Next up" section of the post-completion Finished sheet.
///
/// Strategy mirrors cover-lookup: tiered, fire-and-forget, network errors
/// are swallowed (this is a polish step, not correctness). Two public
/// functions:
///
///   detectSeries(title, authors, isbn) →
///     { name, position }   — what series is this book in, and at what
///                            number? position is null when we can find
///                            the series name but not the position.
///
///   findInSeries(seriesName, knownAuthors) →
///     SeriesBookCandidate[] — every book we can find in the series,
///                             sorted by position when known, else by
///                             published_year. Caller picks "next" by
///                             filtering position > current.
///
/// Coverage notes:
///   • Google Books has structured seriesInfo with bookDisplayNumber for
///     mainstream traditionally-published series (Sanderson, Rowling,
///     Riordan). It returns nothing useful for plenty of indie series
///     (Dungeon Crawler Carl, indie LitRPG, self-pub).
///   • Open Library has a `series` field on search docs that's strings
///     only — usable for the *name* but never the position.
///   • For indie series we degrade to "find every book by this author
///     whose title contains the series name" and let the caller pick.

const UA = 'Tome/0.8 (https://github.com/tome-project/tome; series-lookup)';

interface GoogleBooksVolumeInfo {
  title?: string;
  authors?: string[];
  publishedDate?: string;
  industryIdentifiers?: Array<{ type?: string; identifier?: string }>;
  imageLinks?: { thumbnail?: string; smallThumbnail?: string };
  seriesInfo?: {
    bookDisplayNumber?: string;
    volumeSeries?: Array<{ seriesId?: string; orderNumber?: number }>;
  };
}

interface GoogleBooksItem {
  id?: string;
  volumeInfo?: GoogleBooksVolumeInfo;
}

interface OpenLibrarySearchDoc {
  key?: string;                 // "/works/OL12345W"
  title?: string;
  author_name?: string[];
  series?: string[];
  first_publish_year?: number;
  cover_i?: number;
  isbn?: string[];
}

export interface DetectedSeries {
  name: string;
  position: number | null;
}

export interface SeriesBookCandidate {
  title: string;
  authors: string[];
  isbn_13: string | null;
  open_library_id: string | null;
  google_books_id: string | null;
  cover_url: string | null;
  position: number | null;
  published_year: number | null;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function parsePosition(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function cleanGoogleThumb(url: string): string {
  return url
    .replace(/&edge=curl/g, '')
    .replace(/zoom=\d+/, 'zoom=2')
    .replace(/^http:/, 'https:');
}

function isbn13From(volume: GoogleBooksVolumeInfo): string | null {
  const ids = volume.industryIdentifiers ?? [];
  const hit = ids.find((i) => i.type === 'ISBN_13' && i.identifier);
  return hit?.identifier ?? null;
}

function publishedYearFrom(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/\d{4}/);
  return m ? parseInt(m[0], 10) : null;
}

async function googleBooksLookup(query: string, maxResults = 20): Promise<GoogleBooksItem[]> {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=${maxResults}`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return [];
    const j = (await r.json()) as { items?: GoogleBooksItem[] };
    return j.items ?? [];
  } catch {
    return [];
  }
}

async function openLibrarySearch(query: string): Promise<OpenLibrarySearchDoc[]> {
  const url = `https://openlibrary.org/search.json?${query}&fields=key,title,author_name,series,first_publish_year,cover_i,isbn&limit=30`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return [];
    const j = (await r.json()) as { docs?: OpenLibrarySearchDoc[] };
    return j.docs ?? [];
  } catch {
    return [];
  }
}

/// Best-effort series detection for a single book.
/// Returns null when we can't find a series name in any source.
export async function detectSeries(
  title: string,
  authors: string[],
  isbn: string | null,
): Promise<DetectedSeries | null> {
  if (!title || title.length < 2) return null;
  const author = authors[0] ?? '';

  // Google's seriesInfo gives a structured position (bookDisplayNumber)
  // but only an opaque seriesId — no human-readable series name. Open
  // Library's search.json has the human name on its `series` field but
  // no position. Best result needs both, so we run them in parallel and
  // combine.
  let positionFromGoogle: number | null = null;
  if (isbn) {
    const cleaned = isbn.replace(/[-\s]/g, '');
    if (cleaned.length === 13 || cleaned.length === 10) {
      const items = await googleBooksLookup(`isbn:${cleaned}`, 1);
      positionFromGoogle = parsePosition(items[0]?.volumeInfo?.seriesInfo?.bookDisplayNumber);
    }
  }

  const olParams = new URLSearchParams({ title });
  if (author) olParams.set('author', author);
  const olDocs = await openLibrarySearch(olParams.toString());
  const olHit = olDocs.find(
    (d) => d.series && d.series.length > 0 && d.series[0].trim().length > 0,
  );
  if (olHit?.series && olHit.series[0]) {
    const name = olHit.series[0].trim();
    const position = positionFromGoogle ?? positionFromTitle(title, name);
    return { name, position };
  }

  // Last resort when OL has no series: try Google by title+author and
  // see if we can pull a series name out of the volume's own title
  // ("Carl's Doomsday Scenario (Dungeon Crawler Carl, Book 2)" — very
  // common in self-pub).
  const gbItems = await googleBooksLookup(
    [`intitle:"${title}"`, author ? `inauthor:"${author}"` : ''].filter(Boolean).join('+'),
    1,
  );
  const sInfo = gbItems[0]?.volumeInfo?.seriesInfo;
  const inferred = inferSeriesNameFromTitle(title) ?? inferSeriesNameFromTitle(gbItems[0]?.volumeInfo?.title ?? '');
  if (inferred) {
    const position =
      positionFromGoogle ??
      parsePosition(sInfo?.bookDisplayNumber) ??
      positionFromTitle(title, inferred);
    return { name: inferred, position };
  }

  return null;
}

/// Best-effort: titles like "Carl's Doomsday Scenario (Dungeon Crawler
/// Carl, Book 2)" or "Words of Radiance: Stormlight Archive Book 2"
/// embed both the series name and position. Returns the position when
/// the title contains "Book N" / "#N" / ", N" near the series name.
function positionFromTitle(title: string, seriesName: string): number | null {
  // "Book 2", "#2", ", Book 2"
  const bookN = title.match(/\b(?:book|vol(?:ume)?)\s*#?\s*(\d+(?:\.\d+)?)/i);
  if (bookN) return parseFloat(bookN[1]);
  // ", N)" at end of a paren group containing the series name
  const paren = title.match(/\(([^)]*?\d+(?:\.\d+)?[^)]*)\)/);
  if (paren && paren[1].toLowerCase().includes(seriesName.toLowerCase())) {
    const n = paren[1].match(/(\d+(?:\.\d+)?)/);
    if (n) return parseFloat(n[1]);
  }
  return null;
}

/// Pulls a series name out of a title like "Carl's Doomsday Scenario:
/// Dungeon Crawler Carl Book 2". Conservative — only fires when there's
/// a clear "<title>: <series> Book N" or "<title> (<series>, N)" shape.
function inferSeriesNameFromTitle(title: string): string | null {
  // "Carl's Doomsday Scenario (Dungeon Crawler Carl, Book 2)"
  const paren = title.match(/\(([^)]+?),\s*(?:book|#)\s*\d+(?:\.\d+)?\)/i);
  if (paren) return paren[1].trim();
  // "Words of Radiance: Stormlight Archive Book 2"
  const colon = title.match(/:\s*(.+?)\s+(?:book|vol(?:ume)?)\s*\d+/i);
  if (colon) return colon[1].trim();
  return null;
}

// ---------------------------------------------------------------------------
// Find books in a series
// ---------------------------------------------------------------------------

/// Return every book we can find in the named series, sorted by
/// position when known (else by published_year). Caller decides what to
/// do with the list (show "next 3", show all, etc.).
export async function findInSeries(
  seriesName: string,
  knownAuthors: string[],
): Promise<SeriesBookCandidate[]> {
  if (!seriesName || seriesName.length < 2) return [];

  const candidates: SeriesBookCandidate[] = [];
  const seenKeys = new Set<string>();

  const dedupeKey = (c: SeriesBookCandidate): string => {
    if (c.isbn_13) return `i:${c.isbn_13}`;
    if (c.open_library_id) return `o:${c.open_library_id}`;
    if (c.google_books_id) return `g:${c.google_books_id}`;
    return `t:${c.title.toLowerCase()}|${(c.authors[0] ?? '').toLowerCase()}`;
  };

  const author = knownAuthors[0] ?? '';

  // Source 1: Open Library search where series equals our name.
  // OL's q=series:"X" works inconsistently — using subject is more
  // reliable for popular series, but not all series are subjects.
  // Try both shapes.
  const olQueries = [
    `q=${encodeURIComponent(`series:"${seriesName}"`)}`,
    author
      ? `series=${encodeURIComponent(seriesName)}&author=${encodeURIComponent(author)}`
      : `series=${encodeURIComponent(seriesName)}`,
  ];
  for (const q of olQueries) {
    const docs = await openLibrarySearch(q);
    for (const d of docs) {
      if (!d.title) continue;
      // Filter: the series field must reference our series name (case-insensitive substring).
      const matchesSeries = (d.series ?? []).some(
        (s) => s.toLowerCase().includes(seriesName.toLowerCase()),
      );
      if (!matchesSeries) continue;
      const isbn13 = (d.isbn ?? []).find((i) => i.length === 13) ?? null;
      const candidate: SeriesBookCandidate = {
        title: d.title,
        authors: d.author_name ?? [],
        isbn_13: isbn13,
        open_library_id: d.key ?? null,
        google_books_id: null,
        cover_url: d.cover_i
          ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg?default=false`
          : null,
        position: positionFromTitle(d.title, seriesName),
        published_year: d.first_publish_year ?? null,
      };
      const k = dedupeKey(candidate);
      if (seenKeys.has(k)) continue;
      seenKeys.add(k);
      candidates.push(candidate);
    }
  }

  // Source 2: Google Books — query the series name, optionally pinned to
  // the author. Returns bookDisplayNumber for series Google has indexed.
  const gbQuery = [
    `intitle:"${seriesName}"`,
    author ? `inauthor:"${author}"` : '',
  ].filter(Boolean).join('+');
  const gbItems = await googleBooksLookup(gbQuery, 30);
  for (const item of gbItems) {
    const v = item.volumeInfo;
    if (!v?.title) continue;
    // Filter: same series — either seriesInfo present, or the title
    // references the series name (covers cases where seriesInfo is
    // missing but the volume is clearly part of the series).
    const hasSeriesInfo = !!v.seriesInfo;
    const titleRefsSeries = v.title.toLowerCase().includes(seriesName.toLowerCase());
    if (!hasSeriesInfo && !titleRefsSeries) continue;
    const candidate: SeriesBookCandidate = {
      title: v.title,
      authors: v.authors ?? [],
      isbn_13: isbn13From(v),
      open_library_id: null,
      google_books_id: item.id ?? null,
      cover_url: v.imageLinks?.thumbnail
        ? cleanGoogleThumb(v.imageLinks.thumbnail)
        : v.imageLinks?.smallThumbnail
          ? cleanGoogleThumb(v.imageLinks.smallThumbnail)
          : null,
      position:
        parsePosition(v.seriesInfo?.bookDisplayNumber) ??
        positionFromTitle(v.title, seriesName),
      published_year: publishedYearFrom(v.publishedDate),
    };
    const k = dedupeKey(candidate);
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    candidates.push(candidate);
  }

  // Sort: known positions ascend, unknowns sink to the bottom ordered
  // by year. This keeps "Book 1, Book 2, Book 3, ..." at the top and
  // pushes prequels/companions/anthologies (often unnumbered) below.
  candidates.sort((a, b) => {
    if (a.position !== null && b.position !== null) return a.position - b.position;
    if (a.position !== null) return -1;
    if (b.position !== null) return 1;
    return (a.published_year ?? 0) - (b.published_year ?? 0);
  });

  return candidates;
}
