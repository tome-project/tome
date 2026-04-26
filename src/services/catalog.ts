import { selectOne, insertOne, upsertOne } from './db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CatalogBook {
  id: string;
  open_library_id: string | null;
  isbn_13: string | null;
  isbn_10: string | null;
  google_books_id: string | null;
  title: string;
  subtitle: string | null;
  authors: string[];
  cover_url: string | null;
  description: string | null;
  publisher: string | null;
  published_year: number | null;
  page_count: number | null;
  genres: string[];
  language: string;
  created_at: string;
}

export interface CatalogSearchResult {
  ol_id: string;
  title: string;
  authors: string[];
  cover_url: string | null;
  first_publish_year: number | null;
  isbn: string | null;
}

export interface ImportInput {
  ol_id?: string;
  isbn?: string;
}

// ---------------------------------------------------------------------------
// OpenLibrary
// ---------------------------------------------------------------------------

const OL_BASE = 'https://openlibrary.org';
const OL_COVERS = 'https://covers.openlibrary.org/b/id';

interface OLSearchDoc {
  key?: string;                 // e.g. '/works/OL12345W'
  title?: string;
  author_name?: string[];
  cover_i?: number;
  first_publish_year?: number;
  isbn?: string[];
  language?: string[];
}

interface OLWork {
  key?: string;
  title?: string;
  subtitle?: string;
  description?: string | { type?: string; value?: string };
  subjects?: string[];
  covers?: number[];
  first_publish_date?: string;
}

interface OLEdition {
  key?: string;
  title?: string;
  subtitle?: string;
  isbn_13?: string[];
  isbn_10?: string[];
  publishers?: string[];
  publish_date?: string;
  number_of_pages?: number;
  covers?: number[];
  works?: Array<{ key?: string }>;
  languages?: Array<{ key?: string }>;
}

function olCoverUrl(coverId: number | null | undefined): string | null {
  if (!coverId) return null;
  return `${OL_COVERS}/${coverId}-L.jpg`;
}

function olWorkKey(key: string | undefined): string | null {
  // '/works/OL12345W' → 'OL12345W'
  if (!key) return null;
  const match = key.match(/OL\d+W$/);
  return match ? match[0] : null;
}

export async function searchOpenLibrary(q: string, limit = 20): Promise<CatalogSearchResult[]> {
  const url = new URL('/search.json', OL_BASE);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('fields', 'key,title,author_name,cover_i,first_publish_year,isbn,language');

  const res = await fetch(url.toString(), { headers: { 'User-Agent': 'Tome/0.2 (hello@gettome.app)' } });
  if (!res.ok) throw new Error(`OpenLibrary search failed: ${res.status}`);

  const body = await res.json() as { docs?: OLSearchDoc[] };
  const docs = body.docs ?? [];

  return docs
    .map((d) => {
      const olId = olWorkKey(d.key);
      if (!olId || !d.title) return null;
      return {
        ol_id: olId,
        title: d.title,
        authors: d.author_name ?? [],
        cover_url: olCoverUrl(d.cover_i),
        first_publish_year: d.first_publish_year ?? null,
        isbn: d.isbn?.[0] ?? null,
      } satisfies CatalogSearchResult;
    })
    .filter((x): x is CatalogSearchResult => x !== null);
}

async function fetchOLWork(olId: string): Promise<OLWork | null> {
  const url = `${OL_BASE}/works/${olId}.json`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Tome/0.2 (hello@gettome.app)' } });
  if (!res.ok) return null;
  return await res.json() as OLWork;
}

async function fetchOLEditionsForWork(olId: string): Promise<OLEdition[]> {
  const url = `${OL_BASE}/works/${olId}/editions.json?limit=5`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Tome/0.2 (hello@gettome.app)' } });
  if (!res.ok) return [];
  const body = await res.json() as { entries?: OLEdition[] };
  return body.entries ?? [];
}

async function fetchOLByIsbn(isbn: string): Promise<OLEdition | null> {
  const url = `${OL_BASE}/isbn/${isbn}.json`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Tome/0.2 (hello@gettome.app)' } });
  if (!res.ok) return null;
  return await res.json() as OLEdition;
}

// ---------------------------------------------------------------------------
// Google Books enrichment
// ---------------------------------------------------------------------------

interface GBVolumeInfo {
  title?: string;
  subtitle?: string;
  authors?: string[];
  publisher?: string;
  publishedDate?: string;
  description?: string;
  pageCount?: number;
  categories?: string[];
  language?: string;
  imageLinks?: { thumbnail?: string; small?: string; medium?: string; large?: string };
  industryIdentifiers?: Array<{ type: string; identifier: string }>;
}

interface GBVolume {
  id?: string;
  volumeInfo?: GBVolumeInfo;
}

async function fetchGoogleBooksByIsbn(isbn: string): Promise<GBVolume | null> {
  const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&maxResults=1`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const body = await res.json() as { items?: GBVolume[] };
  return body.items?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Import (the main use case)
// ---------------------------------------------------------------------------

function flattenDescription(desc: OLWork['description']): string | null {
  if (!desc) return null;
  if (typeof desc === 'string') return desc;
  return desc.value ?? null;
}

function parseYear(dateStr: string | undefined): number | null {
  if (!dateStr) return null;
  const match = dateStr.match(/\d{4}/);
  return match ? parseInt(match[0], 10) : null;
}

function firstLanguage(edition: OLEdition | null): string {
  const key = edition?.languages?.[0]?.key; // e.g. '/languages/eng'
  if (!key) return 'en';
  const code = key.split('/').pop() ?? 'eng';
  // crude iso-639-3 → iso-639-1
  const map: Record<string, string> = { eng: 'en', spa: 'es', fre: 'fr', ger: 'de', ita: 'it', por: 'pt', jpn: 'ja', chi: 'zh', rus: 'ru' };
  return map[code] ?? code.slice(0, 2);
}

export async function importBook(input: ImportInput): Promise<CatalogBook> {
  let olId: string | null = null;
  let isbn13: string | null = null;
  let isbn10: string | null = null;
  let edition: OLEdition | null = null;

  if (input.ol_id) {
    olId = input.ol_id;
  } else if (input.isbn) {
    const isbn = input.isbn.replace(/[-\s]/g, '');
    edition = await fetchOLByIsbn(isbn);
    if (!edition) throw new Error(`No OpenLibrary edition found for ISBN ${isbn}`);
    olId = olWorkKey(edition.works?.[0]?.key);
    if (isbn.length === 13) isbn13 = isbn;
    else if (isbn.length === 10) isbn10 = isbn;
  } else {
    throw new Error('Provide either ol_id or isbn');
  }

  if (!olId) throw new Error('Unable to resolve work id');

  // Dedup: already in catalog by OL id?
  {
    const existing = await selectOne<CatalogBook>(
      'SELECT * FROM books WHERE open_library_id = $1',
      [olId]
    );
    if (existing) return existing;
  }

  const work = await fetchOLWork(olId);
  if (!work) throw new Error(`OpenLibrary work ${olId} not found`);

  // Pick a representative edition for publisher/page count/language
  if (!edition) {
    const editions = await fetchOLEditionsForWork(olId);
    edition = editions.find((e) => (e.isbn_13?.length ?? 0) > 0) ?? editions[0] ?? null;
  }

  if (!isbn13 && edition?.isbn_13?.length) isbn13 = edition.isbn_13[0];
  if (!isbn10 && edition?.isbn_10?.length) isbn10 = edition.isbn_10[0];

  // Enrichment: Google Books by ISBN fills cover / description / page count gaps
  let gbVolume: GBVolume | null = null;
  if (isbn13 || isbn10) {
    gbVolume = await fetchGoogleBooksByIsbn(isbn13 ?? isbn10!);
  }
  const gbInfo = gbVolume?.volumeInfo;

  const coverId = work.covers?.[0] ?? edition?.covers?.[0] ?? null;
  const cover_url =
    olCoverUrl(coverId) ??
    gbInfo?.imageLinks?.large ??
    gbInfo?.imageLinks?.medium ??
    gbInfo?.imageLinks?.small ??
    gbInfo?.imageLinks?.thumbnail ??
    null;

  const published_year =
    parseYear(edition?.publish_date) ??
    parseYear(work.first_publish_date) ??
    parseYear(gbInfo?.publishedDate) ??
    null;

  // Pull author names. OL work has author refs; call each /authors/OL.json.
  const authorRefs = ((work as unknown as { authors?: Array<{ author?: { key?: string } }> }).authors ?? [])
    .map((a) => a.author?.key)
    .filter((k): k is string => typeof k === 'string');
  const authors: string[] = [];
  for (const ref of authorRefs.slice(0, 5)) {
    try {
      const res = await fetch(`${OL_BASE}${ref}.json`, { headers: { 'User-Agent': 'Tome/0.2 (hello@gettome.app)' } });
      if (res.ok) {
        const a = await res.json() as { name?: string };
        if (a.name) authors.push(a.name);
      }
    } catch {
      // best-effort; skip on error
    }
  }
  if (authors.length === 0 && gbInfo?.authors?.length) {
    authors.push(...gbInfo.authors);
  }

  const record = {
    open_library_id: olId,
    isbn_13: isbn13,
    isbn_10: isbn10,
    google_books_id: gbVolume?.id ?? null,
    title: work.title ?? edition?.title ?? gbInfo?.title ?? 'Untitled',
    subtitle: work.subtitle ?? edition?.subtitle ?? gbInfo?.subtitle ?? null,
    authors,
    cover_url,
    description: flattenDescription(work.description) ?? gbInfo?.description ?? null,
    publisher: edition?.publishers?.[0] ?? gbInfo?.publisher ?? null,
    published_year,
    page_count: edition?.number_of_pages ?? gbInfo?.pageCount ?? null,
    genres: (work.subjects ?? gbInfo?.categories ?? []).slice(0, 10),
    language: firstLanguage(edition) ?? gbInfo?.language ?? 'en',
  };

  const inserted = await upsertOne<CatalogBook>('books', record, {
    onConflict: 'open_library_id',
  });
  if (!inserted) throw new Error('Failed to insert catalog book');
  return inserted;
}

// ---------------------------------------------------------------------------
// Lookup a catalog book by id (for the book detail endpoint later)
// ---------------------------------------------------------------------------

export async function getCatalogBook(id: string): Promise<CatalogBook | null> {
  return selectOne<CatalogBook>('SELECT * FROM books WHERE id = $1', [id]);
}

// ---------------------------------------------------------------------------
// Minimal catalog entry for sources whose metadata doesn't resolve to OL
// (typical of Audiobookshelf items without ISBNs, Gutenberg items, uploads)
// ---------------------------------------------------------------------------

export interface MinimalBookInput {
  title: string;
  authors?: string[];
  subtitle?: string | null;
  description?: string | null;
  publisher?: string | null;
  published_year?: number | null;
  page_count?: number | null;
  genres?: string[];
  language?: string;
  isbn?: string | null;
  cover_url?: string | null;
}

/**
 * Ensure a catalog row exists for a set of minimal metadata.
 * Strategy:
 *   1. If an ISBN is present, try importBook({ isbn }) first — it may resolve
 *      a full OpenLibrary record and enrich with Google Books.
 *   2. Otherwise, attempt to match an existing row by (title, first author)
 *      to avoid duplicates when two sources describe the same book.
 *   3. Failing that, insert a new minimal row.
 */
export async function ensureMinimalCatalogBook(input: MinimalBookInput): Promise<CatalogBook> {
  if (input.isbn) {
    try {
      return await importBook({ isbn: input.isbn });
    } catch {
      // fall through to minimal insert
    }
  }

  const authors = (input.authors ?? []).filter((a) => a && a.trim().length > 0);
  const primaryAuthor = authors[0] ?? null;

  if (primaryAuthor) {
    const existing = await selectOne<CatalogBook>(
      'SELECT * FROM books WHERE title = $1 AND authors @> $2::text[]',
      [input.title, [primaryAuthor]]
    );
    if (existing) return existing;
  }

  const normalizedIsbn = input.isbn?.replace(/[-\s]/g, '');
  const record = {
    open_library_id: null,
    isbn_13: normalizedIsbn && normalizedIsbn.length === 13 ? normalizedIsbn : null,
    isbn_10: normalizedIsbn && normalizedIsbn.length === 10 ? normalizedIsbn : null,
    google_books_id: null,
    title: input.title,
    subtitle: input.subtitle ?? null,
    authors,
    cover_url: input.cover_url ?? null,
    description: input.description ?? null,
    publisher: input.publisher ?? null,
    published_year: input.published_year ?? null,
    page_count: input.page_count ?? null,
    genres: (input.genres ?? []).slice(0, 10),
    language: input.language ?? 'en',
  };

  return insertOne<CatalogBook>('books', record);
}
