import { Router, Request, Response } from 'express';
import { requireSupabaseAuth, requireLibraryAccess } from '../middleware/supabase-auth';
import { hubClient } from '../services/hub';
import { loadIdentity } from '../services/server-identity';
import { audioRangeCapBytes } from '../services/file-stream';
import { SERVER_VERSION } from '../version';

export const playbackRouter = Router();

interface LibraryServerBook {
  id: string;
  server_id: string;
  collection_id: string;
  book_id: string;
  media_type: 'epub' | 'audiobook';
  tracks: Array<{ index: number }> | null;
}

/** Absolute origin the client used to reach this process (LAN or tunnel). */
export function requestOrigin(req: Request): string {
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'http')
    .split(',')[0]
    .trim();
  const host = String(req.get('x-forwarded-host') || req.get('host') || '')
    .split(',')[0]
    .trim();
  if (!host) return '';
  return `${proto}://${host}`.replace(/\/$/, '');
}

export function playbackModeForRequest(req: Request): 'direct' | 'tunneled' {
  const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  if (!publicUrl) return 'direct';
  try {
    const publicHost = new URL(publicUrl).host.toLowerCase();
    const requestHost = String(req.get('x-forwarded-host') || req.get('host') || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    return requestHost === publicHost ? 'tunneled' : 'direct';
  } catch {
    return 'direct';
  }
}

function callerMayAccessBook(req: Request, row: LibraryServerBook, bookId: string): boolean {
  const allowedCollections = req.grantedCollectionIds;
  const allowedClubBooks = req.grantedClubBookIds;
  const isOwner = allowedCollections === undefined && allowedClubBooks === undefined;
  if (isOwner) return true;
  return (allowedCollections?.has(row.collection_id) ?? false) || (allowedClubBooks?.has(bookId) ?? false);
}

/**
 * GET /api/v1/playback/probe
 * Unauthenticated reachability check. Clients probe the LAN `url` first;
 * matching `server_id` confirms they hit the right household library.
 */
playbackRouter.get('/api/v1/playback/probe', (_req: Request, res: Response) => {
  const identity = loadIdentity();
  res.json({
    success: true,
    data: {
      ok: true,
      version: SERVER_VERSION,
      server_id: identity?.serverId ?? null,
      max_range_bytes: audioRangeCapBytes(),
    },
  });
});

/**
 * POST /api/v1/playback/sessions
 * Body: { book_id, format?, track? }
 * Returns a PlaybackTicket for this host — stream_url points at GET /files
 * on the same origin the client used (direct LAN or tunneled public URL).
 * Bytes stay on the library server; Hub is not involved in media.
 */
playbackRouter.post(
  '/api/v1/playback/sessions',
  requireSupabaseAuth,
  requireLibraryAccess,
  async (req: Request, res: Response) => {
    const identity = loadIdentity();
    if (!identity) {
      res.status(503).json({ success: false, error: 'Library server not paired' });
      return;
    }

    const bookId = typeof req.body?.book_id === 'string' ? req.body.book_id.trim() : '';
    if (!bookId) {
      res.status(400).json({ success: false, error: 'book_id is required' });
      return;
    }
    const format = typeof req.body?.format === 'string' && req.body.format
      ? String(req.body.format)
      : 'audiobook';

    let row: LibraryServerBook | null;
    try {
      let lookup = hubClient()
        .from('library_server_books')
        .select('id,server_id,collection_id,book_id,media_type,tracks')
        .eq('server_id', identity.serverId)
        .eq('book_id', bookId)
        .eq('media_type', format)
        .limit(1);
      const { data, error } = await lookup.maybeSingle();
      if (error) throw error;
      row = (data as LibraryServerBook | null) ?? null;
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Lookup failed',
      });
      return;
    }
    if (!row) {
      res.status(404).json({ success: false, error: 'Book not on this server' });
      return;
    }
    if (!callerMayAccessBook(req, row, bookId)) {
      res.status(403).json({ success: false, error: 'No access to this book' });
      return;
    }

    let track: number | undefined;
    if (row.tracks && row.tracks.length > 0) {
      const raw = req.body?.track;
      const idx = raw === undefined || raw === null || raw === ''
        ? 0
        : Number(raw);
      if (!Number.isInteger(idx) || idx < 0 || idx >= row.tracks.length) {
        res.status(400).json({
          success: false,
          error: `Invalid track ${raw}; have ${row.tracks.length}`,
        });
        return;
      }
      track = idx;
    }

    const origin = requestOrigin(req);
    if (!origin) {
      res.status(500).json({ success: false, error: 'Could not determine request origin' });
      return;
    }
    const params = new URLSearchParams({ format });
    if (track !== undefined) params.set('track', String(track));
    const streamUrl = `${origin}/files/${encodeURIComponent(bookId)}?${params.toString()}`;
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const mode = playbackModeForRequest(req);

    res.json({
      success: true,
      data: {
        stream_url: streamUrl,
        mode,
        max_range_bytes: audioRangeCapBytes(),
        expires_at: expiresAt,
        book_id: bookId,
        format,
        track: track ?? null,
        server_id: identity.serverId,
      },
    });
  },
);
