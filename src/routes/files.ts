import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendError } from '../utils';

export const filesRouter = Router();

const libraryPath = process.env.LIBRARY_PATH || './library';

// GET /api/v1/files/:bookId — stream a book file
filesRouter.get('/api/v1/files/:bookId', requireAuth, async (req: Request, res: Response) => {
  const { bookId } = req.params;

  const { data: book, error } = await supabaseAdmin
    .from('books')
    .select('file_path, type, title')
    .eq('id', bookId)
    .single();

  if (error || !book) {
    sendError(res, 'Book not found', 404);
    return;
  }

  // Resolve file path relative to the library root
  const filePath = path.resolve(libraryPath, book.file_path);

  // Prevent directory traversal — file must be within the library path
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

  // Support range requests for audio streaming
  const range = req.headers.range;
  if (range && book.type === 'audiobook') {
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
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="${encodeURIComponent(book.title)}${ext}"`,
    });

    fs.createReadStream(filePath).pipe(res);
  }
});
