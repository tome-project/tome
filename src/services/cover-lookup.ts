/// External cover lookup. Used by the scanner as a last-resort fallback
/// when a book has no embedded artwork (mp3 rips with no ID3 picture, no
/// folder cover.jpg) and no EPUB cover.
///
/// Strategy:
///   1. Open Library by ISBN (exact match) — fastest.
///   2. Open Library search by title + first author.
///   3. Google Books by title + author.
///
/// Each tier returns a JPEG buffer or null. The scanner caches the
/// result via the existing `library/covers/<book_id>.jpg` path + the
/// `books.cover_url` stamp, so we only hit the network on first scan
/// for cover-less books.

const OL_USER_AGENT = 'Tome/0.7 (https://github.com/tome-project/tome; cover-lookup)';

interface OpenLibrarySearchDoc {
  cover_i?: number;
  title?: string;
  author_name?: string[];
}

async function searchOpenLibrary(
  title: string,
  author: string,
): Promise<number | null> {
  const params = new URLSearchParams({
    title,
    limit: '1',
    fields: 'cover_i,title,author_name',
  });
  if (author) params.set('author', author);
  const url = `https://openlibrary.org/search.json?${params.toString()}`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': OL_USER_AGENT } });
    if (!r.ok) return null;
    const j = (await r.json()) as { docs?: OpenLibrarySearchDoc[] };
    return j.docs?.[0]?.cover_i ?? null;
  } catch {
    return null;
  }
}

/// Open Library returns 1×1 placeholder PNGs (~800 bytes) when there's
/// no real cover and `default=false` isn't honored on every endpoint.
/// Reject anything suspiciously small.
const MIN_COVER_BYTES = 4_000;

async function fetchUrl(url: string): Promise<Buffer | null> {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': OL_USER_AGENT } });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length >= MIN_COVER_BYTES ? buf : null;
  } catch {
    return null;
  }
}

async function fetchOpenLibraryByIsbn(isbn: string): Promise<Buffer | null> {
  return fetchUrl(
    `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(isbn)}-L.jpg?default=false`,
  );
}

async function fetchOpenLibraryById(coverId: number): Promise<Buffer | null> {
  return fetchUrl(
    `https://covers.openlibrary.org/b/id/${coverId}-L.jpg?default=false`,
  );
}

interface GoogleBooksItem {
  volumeInfo?: {
    imageLinks?: { thumbnail?: string; smallThumbnail?: string };
  };
}

async function fetchGoogleBooksCover(
  title: string,
  author: string,
): Promise<Buffer | null> {
  const q = [`intitle:"${title}"`];
  if (author) q.push(`inauthor:"${author}"`);
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q.join('+'))}&maxResults=1`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': OL_USER_AGENT } });
    if (!r.ok) return null;
    const j = (await r.json()) as { items?: GoogleBooksItem[] };
    const links = j.items?.[0]?.volumeInfo?.imageLinks;
    const thumb = links?.thumbnail ?? links?.smallThumbnail;
    if (!thumb) return null;
    // Google Books returns small (~128px) thumbnails by default. zoom=2
    // bumps it to ~256px, edge=curl is a UI page-curl effect we don't
    // want. Stripping both yields a cleaner, larger image. Force https
    // because Google sometimes hands out http URLs.
    const clean = thumb
      .replace(/&edge=curl/g, '')
      .replace(/zoom=\d+/, 'zoom=2')
      .replace(/^http:/, 'https:');
    return fetchUrl(clean);
  } catch {
    return null;
  }
}

/// Try every available source in order. Returns null when no source
/// produces a usable image. Network errors are swallowed — cover
/// lookup is a polish step, not a correctness one.
export async function lookupExternalCover(
  title: string,
  authors: string[],
  isbn: string | null,
): Promise<Buffer | null> {
  if (!title || title.length < 2) return null;
  const author = authors[0] ?? '';

  if (isbn) {
    const cleaned = isbn.replace(/[-\s]/g, '');
    if (cleaned.length === 10 || cleaned.length === 13) {
      const direct = await fetchOpenLibraryByIsbn(cleaned);
      if (direct) return direct;
    }
  }

  const coverId = await searchOpenLibrary(title, author);
  if (coverId) {
    const buf = await fetchOpenLibraryById(coverId);
    if (buf) return buf;
  }

  return fetchGoogleBooksCover(title, author);
}
