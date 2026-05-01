import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';

export const coversRouter = Router();

const libraryPath = process.env.LIBRARY_PATH || './library';
const coversDir = path.join(libraryPath, 'covers');
if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });

/// GET /covers/:bookId — serve a cover image from disk. Not auth-gated:
/// cover images are inherently public (and the URL is stamped onto the
/// catalog `books.cover_url`, which any signed-in user can read via RLS).
/// 404s if the file doesn't exist on this library server (e.g. the book
/// is on a different server, or the scanner didn't extract a cover).
coversRouter.get('/covers/:bookId', (req: Request, res: Response) => {
  const bookId = String(req.params.bookId);
  const coverPath = path.join(coversDir, `${bookId}.jpg`);
  if (!fs.existsSync(coverPath)) {
    res.status(404).json({ success: false, error: 'Cover not found' });
    return;
  }
  res.type('image/jpeg').sendFile(path.resolve(coverPath));
});
