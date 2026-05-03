import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { extractEpubMetadata } from './epub-metadata';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScannedBookMetadata {
  title: string;
  authors: string[];
  subtitle: string | null;
  description: string | null;
  publisher: string | null;
  publishedYear: number | null;
  isbn: string | null;
  language: string | null;
  duration: number | null;        // seconds, audiobook only
  numChapters: number | null;
}

export interface AudiobookTrack {
  index: number;
  title: string;
  file_path: string;              // relative to the source's own (directory) file_path
  duration: number | null;
}

export interface ScannedBook {
  relativePath: string;           // relative to the configured library root; a directory for multi-track
  absolutePath: string;
  mediaType: 'audiobook' | 'epub';
  fileSize: number;               // single-file: file size; multi-track: sum of track sizes
  mtime: Date;
  metadata: ScannedBookMetadata;
  coverImage: Buffer | null;
  tracks: AudiobookTrack[] | null; // null for single-file audiobooks and ebooks
  // Top-level subdirectory of the library root that contains this book
  // (e.g. "kids", "audiobooks/fantasy" → "audiobooks"). Empty string for
  // files at the library root. Used by the caller to map books to
  // library_collections rows — one collection per top-level subdir.
  collectionRel: string;
}

export interface ScanResult {
  rootPath: string;
  books: ScannedBook[];
  errors: Array<{ path: string; error: string }>;
  skipped: Array<{ path: string; reason: string }>;
  // Distinct top-level subdirectories observed during the scan that contain
  // at least one book file. The caller uses this to ensure a
  // library_collections row exists for each. The empty string '' is
  // included if any books live at the library root.
  collectionRels: string[];
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

// Single-file audiobook formats. Multi-track formats (mp3-folder audiobooks
// with one mp3 per chapter) are detected during the walk and reported via the
// scan result's `skipped` list — supporting them as one logical book requires
// a chapter-manifest layer that's deferred to a later phase.
const AUDIOBOOK_EXTS = new Set(['.m4b', '.m4a', '.mp3']);
const EBOOK_EXTS = new Set(['.epub']);

type DiscoveryYield =
  | { kind: 'book'; path: string }
  | { kind: 'audiobook-multi'; dirPath: string; trackPaths: string[] }
  | { kind: 'skip'; path: string; reason: string };

// Natural sort: "10.mp3" comes after "9.mp3", not after "1.mp3".
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

async function* walkBookFiles(root: string): AsyncGenerator<DiscoveryYield> {
  const entries = await fsp.readdir(root, { withFileTypes: true });

  const files = entries.filter((e) => e.isFile() && !e.name.startsWith('.'));
  const mp3s = files.filter((f) => path.extname(f.name).toLowerCase() === '.mp3');
  const m4bs = files.filter((f) => {
    const ext = path.extname(f.name).toLowerCase();
    return ext === '.m4b' || ext === '.m4a';
  });
  const epubs = files.filter((f) => path.extname(f.name).toLowerCase() === '.epub');

  // m4b/m4a: each file is its own audiobook (typical for series)
  for (const f of m4bs) {
    yield { kind: 'book', path: path.join(root, f.name) };
  }

  // mp3: single = single-file audiobook; multiple = multi-track audiobook
  if (mp3s.length === 1 && m4bs.length === 0) {
    yield { kind: 'book', path: path.join(root, mp3s[0].name) };
  } else if (mp3s.length > 1 && m4bs.length === 0) {
    const trackPaths = mp3s
      .map((f) => path.join(root, f.name))
      .sort(naturalCompare);
    yield { kind: 'audiobook-multi', dirPath: root, trackPaths };
  } else if (mp3s.length > 0 && m4bs.length > 0) {
    yield {
      kind: 'skip',
      path: root,
      reason: `${mp3s.length} mp3 file(s) ignored — m4b is canonical for this folder`,
    };
  }

  // ebooks: each emits individually
  for (const f of epubs) {
    yield { kind: 'book', path: path.join(root, f.name) };
  }

  // Recurse
  const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  for (const sub of subdirs) {
    yield* walkBookFiles(path.join(root, sub.name));
  }
}

// ---------------------------------------------------------------------------
// ffprobe / ffmpeg wrappers
// ---------------------------------------------------------------------------

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
}

interface FfprobeOutput {
  format?: {
    duration?: string;
    tags?: Record<string, string>;
  };
  streams?: FfprobeStream[];
  chapters?: Array<{ id: number; start_time: string; end_time: string; tags?: { title?: string } }>;
}

function runFfprobe(filePath: string): Promise<FfprobeOutput> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '-show_chapters',
      filePath,
    ];
    const child = spawn('ffprobe', args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as FfprobeOutput);
      } catch (err) {
        reject(err);
      }
    });
    child.on('error', reject);
  });
}

// Extract the first attached cover/picture stream as a Buffer.
// Best-effort: if extraction fails for any reason, return null.
function extractAudiobookCover(filePath: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-i', filePath, '-an', '-vcodec', 'copy', '-f', 'image2pipe', 'pipe:1'];
    const child = spawn('ffmpeg', args);
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('close', (code) => {
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        resolve(null);
      }
    });
    child.on('error', () => resolve(null));
  });
}

// ---------------------------------------------------------------------------
// Audiobook (m4b / m4a) parsing
// ---------------------------------------------------------------------------

function splitAuthors(raw: string | undefined): string[] {
  if (!raw) return [];

  // Multi-author separators: ;, /, or " AND ". When present, treat as a
  // delimited list and split.
  if (/[;\/]| AND /i.test(raw)) {
    return raw
      .split(/[;\/]| AND /i)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  // Single comma with two short halves is the EPUB sort-key convention
  // ("Brown, Pierce" → one author "Pierce Brown"). Recombine.
  const commaParts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (commaParts.length === 2) {
    const isShortName = (s: string) => s.split(/\s+/).length <= 3;
    if (isShortName(commaParts[0]) && isShortName(commaParts[1])) {
      return [`${commaParts[1]} ${commaParts[0]}`];
    }
  }

  // Fallback: comma-separated multi-author list
  return commaParts.length > 0 ? commaParts : [raw.trim()];
}

function parseYear(raw: string | undefined): number | null {
  if (!raw) return null;
  const match = raw.match(/\d{4}/);
  return match ? parseInt(match[0], 10) : null;
}

function audiobookMetadataFromTags(probe: FfprobeOutput): ScannedBookMetadata {
  const rawTags = probe.format?.tags ?? {};
  // ffprobe lowercases m4b atom tags but to be safe we normalize ourselves.
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawTags)) {
    tags[k.toLowerCase()] = v;
  }
  const get = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = tags[k.toLowerCase()];
      if (v && v.trim().length > 0) return v;
    }
    return undefined;
  };

  const title = get('title') ?? 'Unknown Title';
  const album = get('album');
  const author = get('artist', 'album_artist', 'composer');
  const description = get('comment', 'description', 'synopsis');
  const publisher = get('publisher', 'label');
  const language = get('language');
  const isbn = get('isbn');

  const duration = probe.format?.duration ? parseFloat(probe.format.duration) : null;
  const numChapters = probe.chapters?.length ?? null;

  // Audiobook m4b files commonly tag the series/book name in `album`. When
  // `title` is missing or generic, `album` is usually the better book title.
  const finalTitle = title === 'Unknown Title' && album ? album : title;

  return {
    title: finalTitle,
    authors: splitAuthors(author),
    subtitle: null,
    description: description ?? null,
    publisher: publisher ?? null,
    publishedYear: parseYear(get('date', 'year')),
    isbn: isbn ?? null,
    language: language ?? null,
    duration,
    numChapters,
  };
}

async function scanAudiobook(absolutePath: string): Promise<{ metadata: ScannedBookMetadata; coverImage: Buffer | null }> {
  const probe = await runFfprobe(absolutePath);
  const metadata = audiobookMetadataFromTags(probe);
  const hasVideoStream = probe.streams?.some((s) => s.codec_type === 'video') ?? false;
  const coverImage = hasVideoStream ? await extractAudiobookCover(absolutePath) : null;
  return { metadata, coverImage };
}

// ---------------------------------------------------------------------------
// Multi-track audiobook (folder of mp3s — Stormlight, Project Hail Mary, etc.)
// ---------------------------------------------------------------------------

const COVER_FILENAMES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'folder.jpeg', 'folder.png'];

// Look for a cover image alongside the mp3 tracks (cover.jpg / folder.jpg).
async function findFolderCover(dirPath: string): Promise<Buffer | null> {
  for (const name of COVER_FILENAMES) {
    const candidate = path.join(dirPath, name);
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile()) return await fsp.readFile(candidate);
    } catch {
      // missing — try next
    }
  }
  return null;
}

// Pull a track-level title. ID3 'title' is what we want; fall back to the
// filename minus extension (still informative even if generic), then to a
// numbered fallback so the manifest is never empty-titled.
function trackTitleFromProbe(probe: FfprobeOutput, fallbackBase: string, trackIndex: number): string {
  const tags = probe.format?.tags ?? {};
  const lowered: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) lowered[k.toLowerCase()] = v;
  const id3Title = lowered['title'];
  if (id3Title && id3Title.trim().length > 0) return id3Title.trim();
  if (fallbackBase && fallbackBase.trim().length > 0) return fallbackBase;
  return `Chapter ${trackIndex + 1}`;
}

async function scanAudiobookMulti(
  dirPath: string,
  trackPaths: string[]
): Promise<{ metadata: ScannedBookMetadata; coverImage: Buffer | null; tracks: AudiobookTrack[]; totalSize: number }> {
  // Book-level metadata comes from track 0. For multi-track, the track's
  // own `title` is the chapter name (e.g. "Chapter 1"), so the *book* title
  // lives in the `album` tag — invert audiobookMetadataFromTags's preference.
  const firstProbe = await runFfprobe(trackPaths[0]);
  const metadata = audiobookMetadataFromTags(firstProbe);
  const albumTag = firstProbe.format?.tags
    ? Object.entries(firstProbe.format.tags).find(([k]) => k.toLowerCase() === 'album')?.[1]
    : undefined;
  if (albumTag && albumTag.trim().length > 0) {
    metadata.title = albumTag.trim();
  } else {
    // No album tag — fall back to the directory name, which is usually the
    // book title in real libraries (e.g. "Stormlight 03 - Oathbringer").
    metadata.title = path.basename(dirPath);
  }

  // Cover: prefer attached pic on track 0; fall back to folder cover.jpg/folder.jpg.
  const firstHasVideo = firstProbe.streams?.some((s) => s.codec_type === 'video') ?? false;
  let coverImage = firstHasVideo ? await extractAudiobookCover(trackPaths[0]) : null;
  if (!coverImage) coverImage = await findFolderCover(dirPath);

  const tracks: AudiobookTrack[] = [];
  let totalSize = 0;
  let totalDuration = 0;
  for (let i = 0; i < trackPaths.length; i++) {
    const trackPath = trackPaths[i];
    const stat = await fsp.stat(trackPath);
    totalSize += stat.size;

    // Track 0 is already probed; reuse to save a spawn.
    const probe = i === 0 ? firstProbe : await runFfprobe(trackPath);
    const fallbackBase = path.basename(trackPath, path.extname(trackPath));
    const title = trackTitleFromProbe(probe, fallbackBase, i);
    const duration = probe.format?.duration ? parseFloat(probe.format.duration) : null;
    if (duration !== null && Number.isFinite(duration)) totalDuration += duration;

    tracks.push({
      index: i,
      title,
      file_path: path.relative(dirPath, trackPath),
      duration,
    });
  }

  // Override the metadata duration with the aggregate (track 0 alone is wrong).
  metadata.duration = totalDuration > 0 ? totalDuration : null;
  metadata.numChapters = tracks.length;

  return { metadata, coverImage, tracks, totalSize };
}

// ---------------------------------------------------------------------------
// EPUB parsing (delegates to the existing epub-metadata service)
// ---------------------------------------------------------------------------

async function scanEpub(absolutePath: string): Promise<{ metadata: ScannedBookMetadata; coverImage: Buffer | null }> {
  const meta = await extractEpubMetadata(absolutePath);
  const authors =
    meta.author && meta.author !== 'Unknown'
      ? splitAuthors(meta.author)
      : [];
  return {
    metadata: {
      title: meta.title,
      authors,
      subtitle: null,
      description: meta.description,
      publisher: meta.publisher,
      publishedYear: null,
      isbn: null,
      language: meta.language,
      duration: null,
      numChapters: null,
    },
    coverImage: meta.coverImage,
  };
}

// ---------------------------------------------------------------------------
// Top-level scan
// ---------------------------------------------------------------------------

/**
 * Walk `rootPath` recursively and parse every supported book file (.m4b/.m4a
 * audiobooks, .epub ebooks). Errors on individual files are collected into the
 * result rather than raising — one corrupt file should not abort the scan.
 */
export async function scanLibrary(rootPath: string): Promise<ScanResult> {
  const root = path.resolve(rootPath);
  if (!fs.existsSync(root)) {
    throw new Error(`Library root does not exist: ${root}`);
  }
  const stat = await fsp.stat(root);
  if (!stat.isDirectory()) {
    throw new Error(`Library root is not a directory: ${root}`);
  }

  const books: ScannedBook[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  // Compute the top-level subdir of `root` that contains `relPath` (the
  // path of a book or audiobook directory, relative to root). Returns ''
  // when the book lives at the root (no enclosing subdir).
  const collectionRelOf = (relPath: string): string => {
    const norm = relPath.replace(/\\/g, '/');
    const slash = norm.indexOf('/');
    return slash === -1 ? '' : norm.slice(0, slash);
  };

  for await (const item of walkBookFiles(root)) {
    if (item.kind === 'skip') {
      skipped.push({ path: path.relative(root, item.path), reason: item.reason });
      continue;
    }

    if (item.kind === 'audiobook-multi') {
      try {
        const dirStat = await fsp.stat(item.dirPath);
        const { metadata, coverImage, tracks, totalSize } = await scanAudiobookMulti(
          item.dirPath,
          item.trackPaths
        );
        const relativePath = path.relative(root, item.dirPath);
        books.push({
          relativePath,
          absolutePath: item.dirPath,
          mediaType: 'audiobook',
          fileSize: totalSize,
          mtime: dirStat.mtime,
          metadata,
          coverImage,
          tracks,
          collectionRel: collectionRelOf(relativePath),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        errors.push({ path: item.dirPath, error: message });
      }
      continue;
    }

    // Single file (m4b / m4a / mp3 / epub)
    const filePath = item.path;
    try {
      const fileStat = await fsp.stat(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mediaType: 'audiobook' | 'epub' = AUDIOBOOK_EXTS.has(ext) ? 'audiobook' : 'epub';

      const { metadata, coverImage } =
        mediaType === 'audiobook'
          ? await scanAudiobook(filePath)
          : await scanEpub(filePath);

      const relativePath = path.relative(root, filePath);
      books.push({
        relativePath,
        absolutePath: filePath,
        mediaType,
        fileSize: fileStat.size,
        mtime: fileStat.mtime,
        metadata,
        coverImage,
        tracks: null,
        collectionRel: collectionRelOf(relativePath),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      errors.push({ path: filePath, error: message });
    }
  }

  const collectionRels = Array.from(
    new Set(books.map((b) => b.collectionRel)),
  ).sort();

  return { rootPath: root, books, errors, skipped, collectionRels };
}
