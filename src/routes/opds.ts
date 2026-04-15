import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';
import { parseFeed } from '../services/opds';

export const opdsRouter = Router();

const libraryPath = process.env.LIBRARY_PATH || './library';

// GET /api/v1/opds/browse — fetch and parse an OPDS feed
opdsRouter.get('/api/v1/opds/browse', requireAuth, async (req: Request, res: Response) => {
  const { url } = req.query;

  if (!url || typeof url !== 'string') {
    sendError(res, 'Query parameter "url" is required');
    return;
  }

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/atom+xml, application/xml, text/xml',
        'User-Agent': 'Tome/1.0 (OPDS Reader)',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      sendError(res, `Failed to fetch OPDS feed: ${response.status} ${response.statusText}`, 502);
      return;
    }

    const xml = await response.text();
    const feed = parseFeed(xml);

    sendSuccess(res, feed);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch OPDS feed';
    sendError(res, message, 502);
  }
});

// POST /api/v1/opds/download — download a book from an OPDS acquisition link
opdsRouter.post('/api/v1/opds/download', requireAuth, async (req: Request, res: Response) => {
  const { url, title, author, cover_url, type, library_id } = req.body;

  if (!url || !title) {
    sendError(res, 'url and title are required');
    return;
  }

  try {
    // Ensure the uploads directory exists
    const uploadsDir = path.join(libraryPath, 'uploads');
    await fs.promises.mkdir(uploadsDir, { recursive: true });

    // Download the file
    const response = await fetch(url);
    if (!response.ok) {
      sendError(res, `Failed to download file: ${response.status} ${response.statusText}`, 502);
      return;
    }

    // Determine file extension from content-type or URL
    const contentType = response.headers.get('content-type') || '';
    let ext = '.epub';
    if (contentType.includes('pdf') || url.endsWith('.pdf')) {
      ext = '.pdf';
    } else if (contentType.includes('audio') || url.endsWith('.mp3')) {
      ext = '.mp3';
    } else if (url.endsWith('.m4b')) {
      ext = '.m4b';
    }

    // Determine book type
    const bookType = ext === '.mp3' || ext === '.m4b' ? 'audiobook' : 'epub';

    // Generate a safe filename
    const safeTitle = title.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 100);
    const timestamp = Date.now();
    const filename = `${safeTitle}-${timestamp}${ext}`;
    const filePath = path.join(uploadsDir, filename);

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(filePath, buffer);

    // Insert book record
    const bookData: Record<string, any> = {
      title,
      author: author || 'Unknown',
      type: type || bookType,
      file_path: `uploads/${filename}`,
      cover_url: cover_url || null,
      external_source: 'opds',
      added_by: req.userId,
    };

    if (library_id) {
      bookData.library_id = library_id;
    }

    const { data: book, error } = await supabaseAdmin
      .from('books')
      .insert(bookData)
      .select()
      .single();

    if (error) {
      sendError(res, error.message, 500);
      return;
    }

    sendSuccess(res, book, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to download and save book';
    sendError(res, message, 500);
  }
});
