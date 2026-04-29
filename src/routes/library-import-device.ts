import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { requireAuth } from '../middleware/auth';
import { upsertOne, query } from '../services/db';
import { ensureMinimalCatalogBook } from '../services';
import { sendSuccess, sendError } from '../utils';

const libraryPath = process.env.LIBRARY_PATH || './library';
const coversDir = path.join(libraryPath, 'covers');

if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });

const COVER_MAX_SIZE = 8 * 1024 * 1024; // 8MB cover ceiling

const coverUploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: COVER_MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Cover must be an image'));
  },
});

function runCoverUpload(req: Request, res: Response, next: NextFunction) {
  coverUploader.single('cover')(req, res, (err) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        sendError(res, `Cover too large (max ${Math.floor(COVER_MAX_SIZE / (1024 * 1024))}MB)`, 413);
        return;
      }
      sendError(res, err.message, 400);
      return;
    }
    sendError(res, err instanceof Error ? err.message : 'Upload failed', 400);
  });
}

const VALID_STATUSES = ['want', 'reading', 'finished', 'dnf'] as const;
type UserBookStatus = (typeof VALID_STATUSES)[number];
const VALID_MEDIA = ['epub', 'audiobook'] as const;
type MediaType = (typeof VALID_MEDIA)[number];

function parseStatus(input: unknown): UserBookStatus {
  if (typeof input === 'string' && (VALID_STATUSES as readonly string[]).includes(input)) {
    return input as UserBookStatus;
  }
  return 'want';
}

function parseMedia(input: unknown): MediaType | null {
  if (typeof input === 'string' && (VALID_MEDIA as readonly string[]).includes(input)) {
    return input as MediaType;
  }
  return null;
}

export const libraryImportDeviceRouter = Router();

// POST /api/v1/library/import-device
// Register a book that lives on the user's device. The file itself is NEVER
// uploaded — the client keeps the local URI in its own LocalBookStore. This
// endpoint creates a catalog row + a book_sources row (kind='device') + a
// user_books row so the user's shelf, friends' views, and clubs all know
// the book exists.
//
// Multipart form:
//   title         (required)
//   author        (optional)
//   media_type    (required: 'epub' | 'audiobook')
//   status        (optional: 'want' | 'reading' | 'finished' | 'dnf'; default 'want')
//   isbn          (optional)
//   description   (optional)
//   publisher     (optional)
//   language      (optional, default 'en')
//   cover         (optional image file; resized to 400px wide jpeg)
libraryImportDeviceRouter.post(
  '/api/v1/library/import-device',
  requireAuth,
  runCoverUpload,
  async (req: Request, res: Response) => {
    const me = req.userId!;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      sendError(res, 'title is required', 400);
      return;
    }
    const mediaType = parseMedia(body.media_type);
    if (!mediaType) {
      sendError(res, "media_type must be 'epub' or 'audiobook'", 400);
      return;
    }

    const author = typeof body.author === 'string' && body.author.trim().length > 0
      ? body.author.trim()
      : undefined;
    const isbn = typeof body.isbn === 'string' && body.isbn.trim().length > 0
      ? body.isbn.trim()
      : undefined;
    const description = typeof body.description === 'string' ? body.description : null;
    const publisher = typeof body.publisher === 'string' ? body.publisher : null;
    const language = typeof body.language === 'string' && body.language.length > 0
      ? body.language
      : 'en';

    try {
      const catalogBook = await ensureMinimalCatalogBook({
        title,
        authors: author ? [author] : [],
        description,
        publisher,
        language,
        isbn: isbn ?? null,
      });

      // Save cover (if provided and the catalog row doesn't already have one)
      const coverFile = req.file;
      if (coverFile && !catalogBook.cover_url) {
        try {
          const coverPath = path.join(coversDir, `${catalogBook.id}.jpg`);
          await sharp(coverFile.buffer)
            .resize({ width: 400, withoutEnlargement: true })
            .jpeg()
            .toFile(coverPath);
          const coverUrl = `/api/v1/covers/${catalogBook.id}`;
          await query('UPDATE books SET cover_url = $1 WHERE id = $2', [coverUrl, catalogBook.id]);
          catalogBook.cover_url = coverUrl;
        } catch {
          // best-effort
        }
      }

      const source = await upsertOne(
        'book_sources',
        {
          book_id: catalogBook.id,
          owner_id: me,
          kind: 'device',
          media_type: mediaType,
          file_path: null,
        },
        { onConflict: 'book_id,owner_id,kind' },
      );

      const status = parseStatus(body.status);
      const userBook = await upsertOne(
        'user_books',
        { user_id: me, book_id: catalogBook.id, status },
        { onConflict: 'user_id,book_id' },
      );

      sendSuccess(res, { book: catalogBook, source, user_book: userBook }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Device import failed';
      sendError(res, message, 500);
    }
  },
);
