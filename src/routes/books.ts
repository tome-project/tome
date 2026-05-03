import { Router, Request, Response } from 'express';
import path from 'path';
import { spawn } from 'child_process';
import { requireSupabaseAuth } from '../middleware/supabase-auth';
import { selectMany } from '../services/db';
import { sendSuccess, sendError } from '../utils';

const libraryPath = process.env.LIBRARY_PATH || './library';
const scanPath = process.env.SCAN_PATH || libraryPath;

interface SourceTrack {
  index: number;
  title: string;
  file_path: string;
  duration: number | null;
}

interface FfprobeChaptersOutput {
  chapters?: Array<{
    id?: number;
    start_time?: string;
    end_time?: string;
    tags?: { title?: string };
  }>;
}

// Run ffprobe -show_chapters on a single file. Returns the parsed chapter
// list (one entry per embedded chapter atom in m4b/m4a) or [] when the file
// has none. We deliberately keep this stateless and per-request — ffprobe
// on a local m4b is ~50-200ms, and chapters endpoint is called once per
// player open. If contention becomes a thing, swap in an LRU keyed by
// (path, mtime).
function ffprobeChapters(filePath: string): Promise<FfprobeChaptersOutput> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-print_format', 'json',
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
        resolve(JSON.parse(stdout) as FfprobeChaptersOutput);
      } catch (err) {
        reject(err);
      }
    });
    child.on('error', reject);
  });
}

export const booksRouter = Router();

// Pre-v0.7 this file also exposed `/api/v1/books/:id` (book detail) and
// `/api/v1/books/:id/community` (other people's reviews) — both routed
// through the legacy local-auth JWT and the long-gone `book_sources`
// table. Both endpoints have moved to direct Supabase queries from the
// Flutter client (see lib/shared/providers/providers.dart →
// bookDetailProvider, bookCommunityProvider). Removing them here so the
// router doesn't advertise endpoints that 401 + 500 in production.

// GET /api/v1/books/:id/chapters — audiobook chapter list. Two source
// shapes feed the same response:
//   1. Filesystem multi-track (folder of mp3s, one per chapter): synthesize
//      from `tracks[]`, each track becomes one chapter with cumulative
//      absolute start/end times.
//   2. Filesystem single-file (m4b/m4a): run ffprobe -show_chapters at
//      request time. ~50-200ms on a local file; cheap enough to skip a
//      cache layer for v1.
//
// Pre-v0.7 this also queried a `media_servers` row to pull chapters from
// Audiobookshelf, but the bridge is gone — federation is `library_servers`
// + `library_server_grants` now, see migration 011.
booksRouter.get(
  '/api/v1/books/:id/chapters',
  requireSupabaseAuth,
  async (req: Request, res: Response) => {
    const me = req.supabaseUserId!;
    const bookId = String(req.params.id);

    try {
      // Pull every library_server_books row for this book that the caller
      // has access to: either they own the server, or they hold an active
      // grant. Done with one query so we don't fan out per-server, and keyed
      // through `library_servers` so we can prefer the caller's own copy.
      const sources = await selectMany<{
        owner_id: string;
        media_type: string;
        file_path: string | null;
        tracks: SourceTrack[] | null;
      }>(
        `SELECT ls.owner_id, lsb.media_type, lsb.file_path, lsb.tracks
           FROM library_server_books lsb
           JOIN library_servers ls ON ls.id = lsb.server_id
          WHERE lsb.book_id = $1
            AND (
              ls.owner_id = $2
              OR EXISTS (
                SELECT 1 FROM library_server_grants g
                WHERE g.server_id = ls.id
                  AND g.grantee_id = $2
                  AND g.revoked_at IS NULL
              )
            )`,
        [bookId, me]
      );

    if (sources.length === 0) {
      sendSuccess(res, { chapters: [] });
      return;
    }

    // Prefer the caller's own copy, then fall through to a granted one.
    const accessible = [
      ...sources.filter((s) => s.owner_id === me),
      ...sources.filter((s) => s.owner_id !== me),
    ];
    const fs = accessible.find((s) => s.media_type === 'audiobook');

    // ── Filesystem multi-track ──
    if (fs && fs.tracks && fs.tracks.length > 0) {
      let cursorMs = 0;
      const chapters = fs.tracks.map((t, i) => {
        const durMs = t.duration != null ? Math.round(t.duration * 1000) : 0;
        const start = cursorMs;
        const end = cursorMs + durMs;
        cursorMs = end;
        return {
          index: i,
          start_ms: start,
          end_ms: end,
          title: t.title || `Chapter ${i + 1}`,
        };
      });
      sendSuccess(res, { chapters });
      return;
    }

    // ── Filesystem single-file (ffprobe -show_chapters) ──
    if (fs && fs.file_path) {
      const root = path.resolve(scanPath);
      const filePath = path.resolve(root, fs.file_path);
      // Defense-in-depth: never let a malformed file_path escape the scan
      // root. The scanner stores relative paths so this should always hold.
      if (!filePath.startsWith(root)) {
        sendSuccess(res, { chapters: [] });
        return;
      }
      try {
        const probe = await ffprobeChapters(filePath);
        const raw = probe.chapters ?? [];
        const chapters = raw.map((c, i) => {
          const start = parseFloat(c.start_time ?? '0');
          const end = parseFloat(c.end_time ?? '0');
          return {
            index: i,
            start_ms: Number.isFinite(start) ? Math.round(start * 1000) : 0,
            end_ms: Number.isFinite(end) ? Math.round(end * 1000) : 0,
            title: c.tags?.title?.trim() || `Chapter ${i + 1}`,
          };
        });
        sendSuccess(res, { chapters });
        return;
      } catch {
        sendSuccess(res, { chapters: [] });
        return;
      }
    }

    sendSuccess(res, { chapters: [] });
    } catch (err) {
      sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
    }
  },
);
