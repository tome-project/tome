import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { decryptToken } from '../services/crypto';
import { sendError } from '../utils';

export const filesRouter = Router();

const libraryPath = process.env.LIBRARY_PATH || './library';

interface SourceRow {
  id: string;
  owner_id: string;
  kind: string;
  media_type: string;
  file_path: string | null;
  external_id: string | null;
  external_url: string | null;
  media_server_id: string | null;
  created_at: string;
}

// Pick the best source the caller can access for this book.
// RLS already restricts SELECTs on book_sources to:
//   - the caller's own rows, or
//   - rows on a media_server that has shared with the caller.
// We additionally prefer: own-first, then any accessible row.
async function pickSource(bookId: string, userId: string): Promise<SourceRow | null> {
  const { data, error } = await supabaseAdmin
    .from('book_sources')
    .select('*')
    .eq('book_id', bookId);
  if (error || !data || data.length === 0) return null;
  const rows = data as SourceRow[];
  const own = rows.find((s) => s.owner_id === userId);
  return own ?? rows[0];
}

async function streamAbsFile(
  source: SourceRow,
  res: Response,
  rangeHeader: string | undefined
): Promise<void> {
  if (!source.media_server_id || !source.external_id) {
    sendError(res, 'ABS source is missing server or item id', 500);
    return;
  }

  const { data: server, error } = await supabaseAdmin
    .from('media_servers')
    .select('url, token_encrypted')
    .eq('id', source.media_server_id)
    .maybeSingle();
  if (error) {
    sendError(res, error.message, 500);
    return;
  }
  if (!server) {
    sendError(res, 'Originating server no longer exists', 404);
    return;
  }

  let token: string;
  try {
    token = decryptToken(server.token_encrypted as string);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token decryption failed';
    sendError(res, message, 500);
    return;
  }

  const baseUrl = (server.url as string).replace(/\/$/, '');
  const absHeaders: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (rangeHeader) absHeaders['Range'] = rangeHeader;

  // Ask ABS for the item, then find the file ino to download.
  const itemResp = await fetch(`${baseUrl}/api/items/${source.external_id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!itemResp.ok) {
    sendError(res, `Failed to fetch item from Audiobookshelf (${itemResp.status})`, 502);
    return;
  }
  const itemData = (await itemResp.json()) as {
    media?: {
      audioFiles?: Array<{ ino?: string }>;
      ebookFile?: { ino?: string };
    };
  };

  let fileIno: string | undefined;
  if (source.media_type === 'audiobook') {
    fileIno = itemData.media?.audioFiles?.[0]?.ino;
  } else {
    fileIno = itemData.media?.ebookFile?.ino;
  }
  if (!fileIno) {
    sendError(res, `No ${source.media_type} file available on the ABS item`, 404);
    return;
  }

  const proxyResp = await fetch(`${baseUrl}/api/items/${source.external_id}/file/${fileIno}/download`, {
    headers: absHeaders,
  });
  if (!proxyResp.ok) {
    sendError(res, `ABS returned ${proxyResp.status}`, 502);
    return;
  }

  const fallbackType = source.media_type === 'audiobook' ? 'audio/mpeg' : 'application/epub+zip';
  const contentType = proxyResp.headers.get('content-type') || fallbackType;
  const contentLength = proxyResp.headers.get('content-length');
  const contentRange = proxyResp.headers.get('content-range');
  const acceptRanges = proxyResp.headers.get('accept-ranges');

  const outHeaders: Record<string, string> = { 'Content-Type': contentType };
  if (contentLength) outHeaders['Content-Length'] = contentLength;
  if (contentRange) outHeaders['Content-Range'] = contentRange;
  if (acceptRanges) outHeaders['Accept-Ranges'] = acceptRanges;

  res.writeHead(proxyResp.status, outHeaders);

  const reader = proxyResp.body?.getReader();
  if (!reader) {
    res.end();
    return;
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
  } finally {
    res.end();
  }
}

function streamLocalFile(source: SourceRow, bookTitle: string, res: Response, rangeHeader: string | undefined) {
  if (!source.file_path) {
    sendError(res, 'Local source has no file_path', 500);
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

  if (rangeHeader && source.media_type === 'audiobook') {
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
    'Content-Disposition': `inline; filename="${encodeURIComponent(bookTitle)}${ext}"`,
  });
  fs.createReadStream(filePath).pipe(res);
}

// GET /api/v1/files/:bookId — stream a book file via whichever source the
// caller can access. Local (upload/gutenberg) reads from disk; ABS proxies
// through the stored media_server credential.
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

  const source = await pickSource(bookId, me);
  if (!source) {
    sendError(res, 'No accessible source for this book', 404);
    return;
  }

  if (source.kind === 'audiobookshelf') {
    await streamAbsFile(source, res, req.headers.range);
    return;
  }

  if (source.kind === 'upload' || source.kind === 'gutenberg') {
    streamLocalFile(source, book.title as string, res, req.headers.range);
    return;
  }

  sendError(res, `Streaming ${source.kind} sources is not supported yet`, 501);
});
