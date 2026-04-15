import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

const libraryPath = process.env.LIBRARY_PATH || './library';
const uploadsDir = path.join(libraryPath, 'uploads');

// Ensure uploads directory exists
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer storage
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uuid = crypto.randomUUID();
    cb(null, `${uuid}${ext}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const allowedExts = ['.epub', '.mp3', '.m4a', '.m4b'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} not allowed. Accepted: ${allowedExts.join(', ')}`));
    }
  },
  limits: {
    fileSize: 500 * 1024 * 1024, // 500 MB
  },
});

export const libraryRouter = Router();

// GET /api/v1/library — list books across all accessible libraries
libraryRouter.get('/api/v1/library', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { q, type, page, library_id } = req.query;
  const limit = 50;
  const offset = page ? (Number(page) - 1) * limit : 0;

  let query = supabaseAdmin
    .from('books')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (library_id && typeof library_id === 'string') {
    // Filter to a specific library
    query = query.eq('library_id', library_id);
  } else {
    // Get all accessible library IDs for this user
    const { data: ownedLibs } = await supabaseAdmin
      .from('libraries')
      .select('id')
      .eq('owner_id', userId);

    const { data: memberLibs } = await supabaseAdmin
      .from('library_members')
      .select('library_id')
      .eq('user_id', userId)
      .eq('role', 'member');

    const accessibleIds = [
      ...(ownedLibs || []).map((l: { id: string }) => l.id),
      ...(memberLibs || []).map((m: { library_id: string }) => m.library_id),
    ];

    // Show books in accessible libraries OR legacy books with no library
    if (accessibleIds.length > 0) {
      query = query.or(`library_id.in.(${accessibleIds.join(',')}),library_id.is.null`);
    }
    // If no libraries exist yet, just show all books (backwards compat)
  }

  // Text search across title and author
  if (q && typeof q === 'string') {
    query = query.or(`title.ilike.%${q}%,author.ilike.%${q}%`);
  }

  // Filter by book type
  if (type && typeof type === 'string') {
    query = query.eq('type', type);
  }

  const { data, error, count } = await query;

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, { books: data, total: count });
});

// POST /api/v1/library/books — add a book to a library
libraryRouter.post('/api/v1/library/books', requireAuth, async (req: Request, res: Response) => {
  const { title, author, cover_url, file_path, type, library_id } = req.body;

  if (!title || !author || !file_path || !type) {
    sendError(res, 'title, author, file_path, and type are required');
    return;
  }

  if (!['epub', 'audiobook'].includes(type)) {
    sendError(res, 'type must be "epub" or "audiobook"');
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('books')
    .insert({
      title,
      author,
      cover_url: cover_url || null,
      file_path,
      type,
      library_id: library_id || null,
      added_by: req.userId,
    })
    .select()
    .single();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data, 201);
});

// POST /api/v1/library/upload — upload an epub/audiobook file
libraryRouter.post(
  '/api/v1/library/upload',
  requireAuth,
  upload.single('file'),
  async (req: Request, res: Response) => {
    if (!req.file) {
      sendError(res, 'No file uploaded');
      return;
    }

    const { title, author, type, cover_url } = req.body;

    const ext = path.extname(req.file.originalname).toLowerCase();
    const bookType = type || (ext === '.epub' ? 'epub' : 'audiobook');
    const bookTitle = title || path.basename(req.file.originalname, ext).replace(/[-_]/g, ' ');
    const relativePath = `uploads/${req.file.filename}`;

    const { data, error } = await supabaseAdmin
      .from('books')
      .insert({
        title: bookTitle,
        author: author || 'Unknown',
        cover_url: cover_url || null,
        file_path: relativePath,
        type: bookType,
        added_by: req.userId,
      })
      .select()
      .single();

    if (error) {
      fs.unlink(req.file.path, () => {});
      sendError(res, error.message, 500);
      return;
    }

    sendSuccess(res, data, 201);
  }
);

// POST /api/v1/library/seed — seed library with classic Gutenberg books
libraryRouter.post('/api/v1/library/seed', requireAuth, async (req: Request, res: Response) => {
  const SEED_BOOKS = [
    { id: 1342, title: 'Pride and Prejudice' },
    { id: 84, title: 'Frankenstein' },
    { id: 64317, title: 'The Great Gatsby' },
    { id: 11, title: "Alice's Adventures in Wonderland" },
    { id: 345, title: 'Dracula' },
  ];

  const GUTENBERG_API = 'https://gutendex.com';

  try {
    // Check which books already exist in the library (by gutenberg file path pattern)
    const { data: existingBooks, error: fetchError } = await supabaseAdmin
      .from('books')
      .select('file_path');

    if (fetchError) {
      sendError(res, fetchError.message, 500);
      return;
    }

    const existingPaths = new Set(
      (existingBooks || []).map((b: { file_path: string }) => b.file_path)
    );

    // Ensure the gutenberg download directory exists
    const gutenbergDir = path.join(libraryPath, 'gutenberg');
    if (!fs.existsSync(gutenbergDir)) {
      fs.mkdirSync(gutenbergDir, { recursive: true });
    }

    const added: string[] = [];
    const errors: string[] = [];

    for (const seed of SEED_BOOKS) {
      const filename = `gutenberg-${seed.id}.epub`;
      const relativePath = `gutenberg/${filename}`;

      // Skip if already in library
      if (existingPaths.has(relativePath)) {
        continue;
      }

      try {
        // Fetch book metadata from Gutendex API
        const metaResponse = await fetch(`${GUTENBERG_API}/books/${seed.id}`);
        if (!metaResponse.ok) {
          errors.push(`Failed to fetch metadata for ${seed.title}`);
          continue;
        }

        const meta = await metaResponse.json() as any;
        const epubUrl = meta.formats?.['application/epub+zip'];
        const coverUrl = meta.formats?.['image/jpeg'] || null;
        const author = meta.authors?.[0]?.name || 'Unknown';
        const title = meta.title || seed.title;

        if (!epubUrl) {
          errors.push(`No epub URL found for ${seed.title}`);
          continue;
        }

        // Download the epub file
        const filePath = path.join(gutenbergDir, filename);
        const epubResponse = await fetch(epubUrl);
        if (!epubResponse.ok) {
          errors.push(`Failed to download epub for ${seed.title}`);
          continue;
        }

        const buffer = Buffer.from(await epubResponse.arrayBuffer());
        await fs.promises.writeFile(filePath, buffer);

        // Insert book record into the database
        const { error: insertError } = await supabaseAdmin
          .from('books')
          .insert({
            title,
            author,
            cover_url: coverUrl,
            file_path: relativePath,
            type: 'epub',
            added_by: req.userId,
          });

        if (insertError) {
          errors.push(`Failed to save ${seed.title}: ${insertError.message}`);
          continue;
        }

        added.push(title);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Unknown error';
        errors.push(`Failed to process ${seed.title}: ${message}`);
      }
    }

    sendSuccess(res, { added: added.length, titles: added, errors });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to seed library';
    sendError(res, message, 500);
  }
});

// POST /api/v1/library/scan — scan the library directory for new books
libraryRouter.post('/api/v1/library/scan', requireAuth, async (_req: Request, res: Response) => {
  const bookExtensions = new Set(['.epub', '.mp3', '.m4a', '.m4b']);
  const audioExtensions = new Set(['.mp3', '.m4a', '.m4b']);

  // Recursively find all book files
  function scanDir(dir: string): string[] {
    const results: string[] = [];
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...scanDir(fullPath));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (bookExtensions.has(ext)) {
          results.push(fullPath);
        }
      }
    }

    return results;
  }

  // Title case helper
  function toTitleCase(str: string): string {
    return str
      .replace(/[-_]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  try {
    const allFiles = scanDir(libraryPath);

    // Get existing file paths from the database
    const { data: existingBooks, error: fetchError } = await supabaseAdmin
      .from('books')
      .select('file_path');

    if (fetchError) {
      sendError(res, fetchError.message, 500);
      return;
    }

    const existingPaths = new Set((existingBooks || []).map((b: { file_path: string }) => b.file_path));

    // Convert to relative paths for portability
    const resolvedLibrary = path.resolve(libraryPath);
    const relativeFiles = allFiles.map(f => path.relative(resolvedLibrary, f));

    // Filter to only new files
    const newFiles = relativeFiles.filter((f) => !existingPaths.has(f));

    if (newFiles.length === 0) {
      sendSuccess(res, { added: 0 });
      return;
    }

    // Build insert records
    const newBooks = newFiles.map((relPath) => {
      const ext = path.extname(relPath).toLowerCase();
      const basename = path.basename(relPath, ext);
      const title = toTitleCase(basename);
      const type = audioExtensions.has(ext) ? 'audiobook' : 'epub';

      return {
        title,
        author: 'Unknown',
        file_path: relPath,
        type,
        cover_url: null,
      };
    });

    const { error: insertError } = await supabaseAdmin
      .from('books')
      .insert(newBooks);

    if (insertError) {
      sendError(res, insertError.message, 500);
      return;
    }

    sendSuccess(res, { added: newBooks.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to scan library';
    sendError(res, message, 500);
  }
});
