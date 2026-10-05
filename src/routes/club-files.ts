import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { requireSupabaseAuth as requireAuth } from '../middleware/supabase-auth';
import { hubClient } from '../services/hub';
import { streamFile, containedPath } from '../services/file-stream';
import { sendSuccess, sendError } from '../utils';

/// club-files — transient host-shared files for book clubs.
///
/// Morgan creates a club around a book she imported to her phone. To let her
/// friends listen/read without each tracking down their own copy, the host
/// uploads *one* file to the hub via POST below. Club members stream it via
/// GET; the bytes never leave the hub. Auto-purge after club.end_date + 30d
/// (see migration 015 and the purge job).
///
/// Storage: LIBRARY_PATH/club-shares/<club_id>/<book_id>.<ext>
///
/// Access control:
///   POST → only the club host (host_id on clubs)
///   GET  → any current club_members row for that club
/// Both layered on top of Supabase JWT auth (requireAuth → req.userId).

const libraryPath = process.env.LIBRARY_PATH || './library';
const clubSharesDir = path.join(libraryPath, 'club-shares');

if (!fs.existsSync(clubSharesDir)) fs.mkdirSync(clubSharesDir, { recursive: true });

const MAX_SIZE = 500 * 1024 * 1024; // 500MB — fits typical full-length audiobooks

const ALLOWED_EXT: Record<string, 'epub' | 'audiobook'> = {
  '.epub': 'epub',
  '.m4b': 'audiobook',
  '.m4a': 'audiobook',
  '.mp3': 'audiobook',
};

const MIME_TYPES: Record<string, string> = {
  '.epub': 'application/epub+zip',
  '.m4b': 'audio/mp4',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
};

const PURGE_GRACE_DAYS = 30;

interface ClubRow {
  id: string;
  host_id: string;
  book_id: string;
  end_date: string | null;
}

async function loadClubAsHost(clubId: string, userId: string): Promise<ClubRow | null> {
  const {data,error} = await hubClient().from('clubs').select('id,host_id,book_id,end_date').eq('id',clubId).eq('host_id',userId).maybeSingle();
  if(error) throw error;
  return data;
}

async function userIsClubMember(clubId: string, userId: string): Promise<boolean> {
  const {data,error} = await hubClient().from('club_members').select('user_id').eq('club_id',clubId).eq('user_id',userId).maybeSingle();
  if(error) throw error;
  return !!data;
}

// Multer wiring: we don't know book_id until req.body parses, but multer
// runs body parsing AFTER the storage destination/filename callbacks have
// already been called. So we stage under <clubSharesDir>/<clubId>/tmp-<random>,
// then move into place once we've validated club + book_id in the handler.
const storage = multer.diskStorage({
  destination: async (req, _file, cb) => {
    const clubId = String(req.params.clubId);
    if (!/^[0-9a-f-]{36}$/i.test(clubId)) {
      cb(new Error('Missing clubId'), '');
      return;
    }
    const dir = path.join(clubSharesDir, clubId);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      cb(null, dir);
    } catch (err) {
      cb(err as Error, '');
    }
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const stamp = Date.now().toString(36);
    cb(null, `tmp-${stamp}${ext}`);
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

const guarded = (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void handler(req,res).catch(next); };
export const clubFilesRouter = Router();

// POST /api/v1/clubs/:clubId/file
// Multipart: file=<binary>, book_id=<uuid>
// 201 → { file: { id, club_id, book_id, media_type, file_ext, file_size, ... } }
clubFilesRouter.post(
  '/api/v1/clubs/:clubId/file',
  requireAuth,
  runUpload,
  guarded(async (req: Request, res: Response) => {
    const me = req.supabaseUserId!;
    const clubId = String(req.params.clubId);
    const file = req.file;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const bookId = typeof body.book_id === 'string' ? body.book_id : null;

    const cleanup = async () => {
      if (file) await fs.promises.unlink(file.path).catch(() => {});
    };

    if (!file) {
      sendError(res, 'Missing "file" field', 400);
      return;
    }
    if (!bookId) {
      await cleanup();
      sendError(res, 'Missing "book_id" field', 400);
      return;
    }

    const ext = path.extname(file.originalname).toLowerCase();
    const mediaType = ALLOWED_EXT[ext];
    if (!mediaType) {
      await cleanup();
      sendError(res, 'Unsupported file type', 400);
      return;
    }

    const club = await loadClubAsHost(clubId, me);
    if (!club) {
      await cleanup();
      sendError(res, 'Not the club host', 403);
      return;
    }
    if (club.book_id !== bookId) {
      await cleanup();
      sendError(res, "book_id does not match this club's current pick", 400);
      return;
    }

    // Move the staged upload to its final name: <clubId>/<bookId><ext>.
    const finalPath = path.join(clubSharesDir, clubId, `${bookId}${ext}`);
    try {
      // If a previous upload exists for this club+book, replace it.
      if (fs.existsSync(finalPath)) await fs.promises.unlink(finalPath);
      await fs.promises.rename(file.path, finalPath);
    } catch (err) {
      await cleanup();
      sendError(res, `Failed to finalize upload: ${err instanceof Error ? err.message : err}`, 500);
      return;
    }

    const purgeAfter = club.end_date
      ? new Date(new Date(club.end_date).getTime() + PURGE_GRACE_DAYS * 86400_000).toISOString()
      : null;

    try {
      const {data: row,error} = await hubClient().from('club_files').upsert(
        {
          club_id: clubId,
          book_id: bookId,
          host_user_id: me,
          media_type: mediaType,
          file_ext: ext,
          file_size: file.size,
          purge_after: purgeAfter,
          purged_at: null,
        },
        { onConflict: 'club_id,book_id' },
      ).select().single();
      if(error) throw error;
      sendSuccess(res, { file: row }, 201);
    } catch (dbErr) {
      // DB write failed — drop the bytes so we don't orphan storage.
      await fs.promises.unlink(finalPath).catch(() => {});
      sendError(res, dbErr instanceof Error ? dbErr.message : 'club_files upsert failed', 500);
    }
  }),
);

// GET /api/v1/clubs/:clubId/file
// Range-aware stream. The caller must be a member of the club.
clubFilesRouter.get(
  '/api/v1/clubs/:clubId/file',
  requireAuth,
  guarded(async (req: Request, res: Response) => {
    const me = req.supabaseUserId!;
    const clubId = String(req.params.clubId);

    if (!(await userIsClubMember(clubId, me))) {
      sendError(res, 'Not a club member', 403);
      return;
    }

    const {data:row,error} = await hubClient().from('club_files').select('*').eq('club_id',clubId).maybeSingle();
    if(error) throw error;
    if (!row) {
      sendError(res, 'No file shared in this club yet', 404);
      return;
    }
    if (row.purged_at) {
      sendError(res, 'This share has expired', 410);
      return;
    }

    const filePath = path.join(clubSharesDir, clubId, `${row.book_id}${row.file_ext}`);
    if (!fs.existsSync(filePath)) {
      // DB and disk disagree — log + tell the client it's gone.
      sendError(res, 'File missing on disk', 404);
      return;
    }

    streamFile(req,res,filePath,MIME_TYPES[row.file_ext] || 'application/octet-stream');
  }),
);

// DELETE /api/v1/clubs/:clubId/file
// Host removes their share early (e.g. uploaded the wrong file, club ended
// early). Auto-purge handles the normal end-of-club case.
clubFilesRouter.delete(
  '/api/v1/clubs/:clubId/file',
  requireAuth,
  guarded(async (req: Request, res: Response) => {
    const me = req.supabaseUserId!;
    const clubId = String(req.params.clubId);
    const club = await loadClubAsHost(clubId, me);
    if (!club) {
      sendError(res, 'Not the club host', 403);
      return;
    }

    const {data:row,error} = await hubClient().from('club_files').select('book_id,file_ext').eq('club_id',clubId).maybeSingle();
    if(error) throw error;
    if (!row) {
      sendSuccess(res, { deleted: false }, 200);
      return;
    }

    const filePath = path.join(clubSharesDir, clubId, `${row.book_id}${row.file_ext}`);
    await fs.promises.unlink(filePath).catch(() => {});
    const {error:deleteError} = await hubClient().from('club_files').delete().eq('club_id',clubId);
    if(deleteError) throw deleteError;
    sendSuccess(res, { deleted: true }, 200);
  }),
);
