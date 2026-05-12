import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { requireSupabaseAuth, requireLibraryAccess } from '../middleware/supabase-auth';
import { hubClient } from '../services/hub';
import { loadIdentity } from '../services/server-identity';

export const filesRouter = Router();

const libraryPath = process.env.LIBRARY_PATH || './library';

interface Track {
  index: number;
  title?: string;
  file_path: string;
  duration?: number | null;
}

interface LibraryServerBook {
  id: string;
  server_id: string;
  collection_id: string;
  book_id: string;
  file_path: string;
  media_type: 'epub' | 'audiobook';
  file_size_bytes: number | null;
  tracks: Track[] | null;
}

const MIME_TYPES: Record<string, string> = {
  '.epub': 'application/epub+zip',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
};

function safeJoin(root: string, sub: string): string | null {
  const resolved = path.resolve(root, sub);
  const resolvedRoot = path.resolve(root);
  if (!resolved.startsWith(resolvedRoot)) return null;
  return resolved;
}

/// GET /files/:bookId
/// Streams a book file from this library server. Range-aware (so
/// audiobook seek + iOS' lockscreen scrubber work).
///
/// Auth: requireSupabaseAuth verifies the caller's Supabase JWT;
/// requireLibraryAccess checks they're the owner or hold an active grant.
/// Both run before this handler — if we're here, access is permitted.
///
/// Lookup: queries library_server_books (this server's books only) for
/// the requested book_id. Multi-track audiobooks pass `?track=N`.
filesRouter.get(
  '/files/:bookId',
  requireSupabaseAuth,
  requireLibraryAccess,
  async (req: Request, res: Response) => {
    const identity = loadIdentity();
    if (!identity) {
      res.status(503).json({ success: false, error: 'Library server not paired' });
      return;
    }
    const bookId = String(req.params.bookId);

    let row: LibraryServerBook | null;
    try {
      const { data, error } = await hubClient()
        .from('library_server_books')
        .select('*')
        .eq('server_id', identity.serverId)
        .eq('book_id', bookId)
        .maybeSingle();
      if (error) throw error;
      row = (data as LibraryServerBook | null) ?? null;
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Lookup failed',
      });
      return;
    }
    if (!row) {
      res.status(404).json({ success: false, error: 'Book not on this server' });
      return;
    }

    // Per-book access narrowing for non-owners. Owner has both grant
    // sets undefined (they see every collection on every book); a
    // non-owner passes if EITHER source covers the request:
    //   - the book's collection is in their granted collection set, OR
    //   - the bookId is in their active club-grant set (lent by a
    //     club host for the club's duration).
    // Club grants are intentionally per-book, so a member of a kids'-
    // book club can't ride the grant to read other books in the host's
    // adult collection.
    const allowedCollections = req.grantedCollectionIds;
    const allowedClubBooks = req.grantedClubBookIds;
    const isOwner = allowedCollections === undefined && allowedClubBooks === undefined;
    if (!isOwner) {
      const viaCollection = allowedCollections?.has(row.collection_id) ?? false;
      const viaClub = allowedClubBooks?.has(bookId) ?? false;
      if (!viaCollection && !viaClub) {
        res.status(403).json({ success: false, error: 'No access to this book' });
        return;
      }
    }

    // Multi-track audiobooks: row.file_path is the directory, row.tracks
    // names the per-chapter files. Pick the requested track (default 0).
    let subPath = row.file_path;
    if (row.tracks && row.tracks.length > 0) {
      const trackParam = req.query.track;
      const idx = trackParam ? parseInt(String(trackParam), 10) : 0;
      if (Number.isNaN(idx) || idx < 0 || idx >= row.tracks.length) {
        res.status(400).json({
          success: false,
          error: `Invalid track ${trackParam}; have ${row.tracks.length}`,
        });
        return;
      }
      subPath = path.join(row.file_path, row.tracks[idx].file_path);
    }

    const filePath = safeJoin(libraryPath, subPath);
    if (!filePath) {
      res.status(403).json({ success: false, error: 'Invalid file path' });
      return;
    }
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ success: false, error: 'File missing on disk' });
      return;
    }

    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const rangeHeader = req.headers.range;

    if (rangeHeader && row.media_type === 'audiobook') {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="${path.basename(filePath)}"`,
    });
    fs.createReadStream(filePath).pipe(res);
  },
);
