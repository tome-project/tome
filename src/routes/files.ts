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
    .select('file_path, type, title, external_source, external_id, library_id')
    .eq('id', bookId)
    .single();

  if (error || !book) {
    sendError(res, 'Book not found', 404);
    return;
  }

  // For ABS-sourced books, proxy the file from Audiobookshelf
  if (book.external_source === 'audiobookshelf' && book.external_id && book.library_id) {
    const { data: library } = await supabaseAdmin
      .from('libraries')
      .select('abs_url, abs_token')
      .eq('id', book.library_id)
      .single();

    if (!library?.abs_url || !library?.abs_token) {
      sendError(res, 'ABS connection not configured for this library', 500);
      return;
    }

    try {
      // Use ABS API to get playable files for this item
      const absHeaders: Record<string, string> = {
        Authorization: `Bearer ${library.abs_token}`,
      };

      // Forward range header for audio streaming
      if (req.headers.range) {
        absHeaders['Range'] = req.headers.range;
      }

      // Fetch item details from ABS to find the actual file
      const itemResp = await fetch(`${library.abs_url}/api/items/${book.external_id}`, {
        headers: { Authorization: `Bearer ${library.abs_token}` },
      });
      if (!itemResp.ok) {
        sendError(res, 'Failed to fetch item from Audiobookshelf', 502);
        return;
      }
      const itemData = await itemResp.json() as any;

      // For audiobooks, find audio files
      if (book.type === 'audiobook') {
        const audioFiles = itemData.media?.audioFiles || [];
        if (audioFiles.length === 0) {
          sendError(res, 'No audio files found for this item', 404);
          return;
        }

        const audioFile = audioFiles[0];
        const fileIno = audioFile.ino;
        const absFileUrl = `${library.abs_url}/api/items/${book.external_id}/file/${fileIno}/download`;

        const proxyResp = await fetch(absFileUrl, { headers: absHeaders });
        if (!proxyResp.ok) {
          sendError(res, `ABS returned ${proxyResp.status}`, 502);
          return;
        }

        // Forward response headers
        const contentType = proxyResp.headers.get('content-type') || 'audio/mpeg';
        const contentLength = proxyResp.headers.get('content-length');
        const contentRange = proxyResp.headers.get('content-range');
        const acceptRanges = proxyResp.headers.get('accept-ranges');

        const responseHeaders: Record<string, string> = { 'Content-Type': contentType };
        if (contentLength) responseHeaders['Content-Length'] = contentLength;
        if (contentRange) responseHeaders['Content-Range'] = contentRange;
        if (acceptRanges) responseHeaders['Accept-Ranges'] = acceptRanges;

        res.writeHead(proxyResp.status, responseHeaders);
        const reader = proxyResp.body?.getReader();
        if (!reader) {
          sendError(res, 'Failed to read ABS stream', 502);
          return;
        }
        // Pipe the ReadableStream to the response
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { res.end(); return; }
            if (!res.write(value)) {
              await new Promise(resolve => res.once('drain', resolve));
            }
          }
        };
        pump().catch(() => res.end());
        return;
      }

      // For ebooks, find the ebook file and download via ino
      const ebookFile = itemData.media?.ebookFile;
      if (!ebookFile?.ino) {
        sendError(res, 'No ebook file found for this item', 404);
        return;
      }
      const ebookFileUrl = `${library.abs_url}/api/items/${book.external_id}/file/${ebookFile.ino}/download`;
      const proxyResp = await fetch(ebookFileUrl, { headers: absHeaders });
      if (!proxyResp.ok) {
        sendError(res, `ABS returned ${proxyResp.status}`, 502);
        return;
      }

      const contentType = proxyResp.headers.get('content-type') || 'application/epub+zip';
      const contentLength = proxyResp.headers.get('content-length');

      const responseHeaders: Record<string, string> = {
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="${encodeURIComponent(book.title)}.epub"`,
      };
      if (contentLength) responseHeaders['Content-Length'] = contentLength;

      res.writeHead(200, responseHeaders);
      const reader = proxyResp.body?.getReader();
      if (!reader) {
        sendError(res, 'Failed to read ABS stream', 502);
        return;
      }
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); return; }
          if (!res.write(value)) {
            await new Promise(resolve => res.once('drain', resolve));
          }
        }
      };
      pump().catch(() => res.end());
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'ABS proxy error';
      sendError(res, message, 502);
      return;
    }
  }

  // Local file serving
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
