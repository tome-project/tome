import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendError } from '../utils';

export const filesRouter = Router();

const libraryPath = process.env.LIBRARY_PATH || './library';

// GET /api/v1/files/:bookId — stream a book file from a source the user can access.
//
// Looks up a book_source for this book that either belongs to the caller or is
// owned by someone in their circle (RLS filters to those rows). Prefers local
// sources (upload, gutenberg) with file_path. Remote sources (audiobookshelf,
// calibre, opds) are wired up in the upcoming sources refactor (Phase 1).
filesRouter.get('/api/v1/files/:bookId', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const bookId = String(req.params.bookId);

  const { data: book, error: bookErr } = await supabaseAdmin
    .from('books')
    .select('id, title')
    .eq('id', bookId)
    .maybeSingle();
  if (bookErr || !book) {
    sendError(res, 'Book not found', 404);
    return;
  }

  // Prefer the caller's own source; fall back to any accessible source.
  const { data: sources, error: srcErr } = await supabaseAdmin
    .from('book_sources')
    .select('*')
    .eq('book_id', bookId)
    .in('kind', ['upload', 'gutenberg']);
  if (srcErr) {
    sendError(res, srcErr.message, 500);
    return;
  }

  const ownSource = (sources ?? []).find((s: { owner_id: string }) => s.owner_id === me);
  const source = ownSource ?? sources?.[0];
  if (!source || !source.file_path) {
    sendError(res, 'No local file available for this book', 404);
    return;
  }

  const filePath = path.resolve(libraryPath, source.file_path);
  const resolvedLibrary = path.resolve(libraryPath);
  if (!filePath.startsWith(resolvedLibrary)) {
    sendError(res, 'Invalid file path', 403);
    return;
  }
  if (!fs.existsSync(filePath)) {
    sendError(res, 'File not found on server', 404);
    return;
  }

  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.epub': 'application/epub+zip',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.m4b': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.pdf': 'application/pdf',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  const range = req.headers.range;
  if (range && source.media_type === 'audiobook') {
    const parts = range.replace(/bytes=/, '').split('-');
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
    'Content-Disposition': `inline; filename="${encodeURIComponent(book.title)}${ext}"`,
  });
  fs.createReadStream(filePath).pipe(res);
});
