import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';
import { requireAuth } from '../middleware/auth';
import { selectOne, upsertOne, query } from '../services/db';
import { extractEpubMetadata, ensureMinimalCatalogBook } from '../services';
import { sendSuccess, sendError } from '../utils';

const libraryPath = process.env.LIBRARY_PATH || './library';
const uploadsDir = path.join(libraryPath, 'uploads');
const coversDir = path.join(libraryPath, 'covers');

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });

const MAX_SIZE = 200 * 1024 * 1024; // 200MB — covers typical epubs and most audiobooks
const ALLOWED_EXT: Record<string, 'epub' | 'audiobook'> = {
  '.epub': 'epub',
  '.m4b': 'audiobook',
  '.m4a': 'audiobook',
  '.mp3': 'audiobook',
};

const storage = multer.diskStorage({
  destination: (req: Request, _file, cb) => {
    const me = req.userId;
    if (!me) {
      cb(new Error('Unauthorized'), '');
      return;
    }
    const ownerDir = path.join(uploadsDir, me);
    fs.promises
      .mkdir(ownerDir, { recursive: true })
      .then(() => cb(null, ownerDir))
      .catch((err) => cb(err as Error, ''));
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const unique = crypto.randomBytes(16).toString('hex');
    cb(null, `${unique}${ext}`);
  },
});

const uploader = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT[ext]) cb(null, true);
    else cb(new Error(`Unsupported file type "${ext}". Allowed: ${Object.keys(ALLOWED_EXT).join(', ')}`));
  },
});

// multer wrapper: surface size/format errors as 4xx rather than letting them
// reach the global error handler as 500s.
function runUpload(req: Request, res: Response, next: NextFunction) {
  uploader.single('file')(req, res, (err) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        sendError(res, `File too large (max ${Math.floor(MAX_SIZE / (1024 * 1024))}MB)`, 413);
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

function parseStatus(input: unknown): UserBookStatus {
  if (typeof input === 'string' && (VALID_STATUSES as readonly string[]).includes(input)) {
    return input as UserBookStatus;
  }
  return 'want';
}

function parseBool(input: unknown, defaultValue: boolean): boolean {
  if (typeof input === 'boolean') return input;
  if (typeof input === 'string') {
    if (input === 'false' || input === '0') return false;
    if (input === 'true' || input === '1') return true;
  }
  return defaultValue;
}

export const libraryUploadRouter = Router();

// POST /api/v1/library/upload
// Multipart form with a single `file` part (.epub / .m4b / .m4a / .mp3) plus
// optional text fields: title, author, status ('want'|'reading'|'finished'|
// 'dnf'), add_to_library ('true'|'false'). For epubs we extract embedded
// metadata and cover art; for audiobooks we fall back to the filename.
libraryUploadRouter.post('/api/v1/library/upload', requireAuth, runUpload, async (req: Request, res: Response) => {
  const me = req.userId!;
  const file = req.file;
  if (!file) {
    sendError(res, 'Missing file field "file"', 400);
    return;
  }

  const ext = path.extname(file.originalname).toLowerCase();
  const mediaType = ALLOWED_EXT[ext];
  if (!mediaType) {
    await fs.promises.unlink(file.path).catch(() => {});
    sendError(res, 'Unsupported file type', 400);
    return;
  }

  const relativePath = path.relative(libraryPath, file.path);
  const body = (req.body ?? {}) as Record<string, unknown>;

  try {
    let title: string | undefined;
    let author: string | undefined;
    let description: string | null = null;
    let publisher: string | null = null;
    let language: string | null = null;
    let coverBuffer: Buffer | null = null;

    if (mediaType === 'epub') {
      try {
        const meta = await extractEpubMetadata(file.path);
        if (meta.title && meta.title !== 'Unknown') title = meta.title;
        if (meta.author && meta.author !== 'Unknown') author = meta.author;
        description = meta.description;
        publisher = meta.publisher;
        language = meta.language;
        coverBuffer = meta.coverImage;
      } catch {
        // extraction is best-effort; fall back to filename / client overrides
      }
    }

    if (typeof body.title === 'string' && body.title.trim().length > 0) title = body.title.trim();
    if (typeof body.author === 'string' && body.author.trim().length > 0) author = body.author.trim();

    if (!title) title = path.basename(file.originalname, ext) || 'Untitled upload';

    const catalogBook = await ensureMinimalCatalogBook({
      title,
      authors: author ? [author] : [],
      description,
      publisher,
      language: language ?? 'en',
    });

    if (coverBuffer && !catalogBook.cover_url) {
      try {
        const coverPath = path.join(coversDir, `${catalogBook.id}.jpg`);
        await sharp(coverBuffer).resize({ width: 400, withoutEnlargement: true }).jpeg().toFile(coverPath);
        const coverUrl = `/api/v1/covers/${catalogBook.id}`;
        await query('UPDATE books SET cover_url = $1 WHERE id = $2', [coverUrl, catalogBook.id]);
        catalogBook.cover_url = coverUrl;
      } catch {
        // cover save is best-effort
      }
    }

    // If this user already has an upload source for this book, delete the
    // previous on-disk file so we don't leak storage.
    const existing = await selectOne<{ file_path: string | null }>(
      `SELECT file_path FROM book_sources
        WHERE book_id = $1 AND owner_id = $2 AND kind = 'upload'`,
      [catalogBook.id, me]
    );
    if (existing?.file_path && existing.file_path !== relativePath) {
      const oldPath = path.join(libraryPath, existing.file_path);
      await fs.promises.unlink(oldPath).catch(() => {});
    }

    let source: Record<string, unknown> | null = null;
    try {
      source = await upsertOne(
        'book_sources',
        {
          book_id: catalogBook.id,
          owner_id: me,
          kind: 'upload',
          media_type: mediaType,
          file_path: relativePath,
        },
        { onConflict: 'book_id,owner_id,kind' },
      );
    } catch (sourceErr) {
      await fs.promises.unlink(file.path).catch(() => {});
      sendError(res, sourceErr instanceof Error ? sourceErr.message : 'Source upsert failed', 500);
      return;
    }

    const status = parseStatus(body.status);
    const addToLibrary = parseBool(body.add_to_library, true);

    let userBook: Record<string, unknown> | null = null;
    if (addToLibrary) {
      try {
        userBook = await upsertOne(
          'user_books',
          { user_id: me, book_id: catalogBook.id, status },
          { onConflict: 'user_id,book_id' },
        );
      } catch {
        // best-effort; main upload still succeeded
      }
    }

    sendSuccess(res, { book: catalogBook, source, user_book: userBook }, 201);
  } catch (err) {
    await fs.promises.unlink(file.path).catch(() => {});
    const message = err instanceof Error ? err.message : 'Upload failed';
    sendError(res, message, 500);
  }
});
