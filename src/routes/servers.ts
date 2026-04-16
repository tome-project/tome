import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { encryptToken, decryptToken } from '../services/crypto';
import { AudiobookshelfService } from '../services/audiobookshelf';
import { sendSuccess, sendError } from '../utils';

export const serversRouter = Router();

type ServerKind = 'audiobookshelf' | 'calibre' | 'opds' | 'plex';
const SUPPORTED_KINDS: ServerKind[] = ['audiobookshelf', 'calibre', 'opds', 'plex'];

// Shape returned to clients — never includes the token.
function shapeServer(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    url: row.url,
    last_sync_at: row.last_sync_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// GET /api/v1/servers — list the caller's media servers
serversRouter.get('/api/v1/servers', requireAuth, async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('media_servers')
    .select('id, name, kind, url, last_sync_at, created_at, updated_at')
    .eq('owner_id', req.userId!)
    .order('created_at', { ascending: false });
  if (error) {
    sendError(res, error.message, 500);
    return;
  }
  sendSuccess(res, { servers: data ?? [] });
});

// POST /api/v1/servers — register a new media server
// Body: { name, kind, url, token }
serversRouter.post('/api/v1/servers', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const { name, kind, url, token } = req.body ?? {};

  if (!name || typeof name !== 'string') {
    sendError(res, 'name is required');
    return;
  }
  if (!SUPPORTED_KINDS.includes(kind)) {
    sendError(res, `kind must be one of: ${SUPPORTED_KINDS.join(', ')}`);
    return;
  }
  if (!url || typeof url !== 'string') {
    sendError(res, 'url is required');
    return;
  }
  if (!token || typeof token !== 'string') {
    sendError(res, 'token is required');
    return;
  }

  // Validate the connection before storing — fail early on bad creds.
  if (kind === 'audiobookshelf') {
    try {
      const abs = new AudiobookshelfService(url, token);
      await abs.getLibraries();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection test failed';
      sendError(res, `Could not reach Audiobookshelf: ${message}`, 502);
      return;
    }
  }

  let token_encrypted: string;
  try {
    token_encrypted = encryptToken(token);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token encryption failed';
    sendError(res, message, 500);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('media_servers')
    .insert({
      owner_id: me,
      name,
      kind,
      url,
      token_encrypted,
    })
    .select()
    .single();
  if (error) {
    sendError(res, error.message, 500);
    return;
  }
  sendSuccess(res, shapeServer(data), 201);
});

// PATCH /api/v1/servers/:id — update name / url / token
serversRouter.patch('/api/v1/servers/:id', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const id = String(req.params.id);
  const { name, url, token } = req.body ?? {};

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (name !== undefined) updates.name = String(name);
  if (url !== undefined) updates.url = String(url);
  if (token !== undefined) {
    try {
      updates.token_encrypted = encryptToken(String(token));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Token encryption failed';
      sendError(res, message, 500);
      return;
    }
  }
  if (Object.keys(updates).length === 1) {
    sendError(res, 'No fields to update');
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('media_servers')
    .update(updates)
    .eq('id', id)
    .eq('owner_id', me)
    .select()
    .maybeSingle();
  if (error) {
    sendError(res, error.message, 500);
    return;
  }
  if (!data) {
    sendError(res, 'Server not found', 404);
    return;
  }
  sendSuccess(res, shapeServer(data));
});

// POST /api/v1/servers/:id/test — re-test the stored connection
serversRouter.post('/api/v1/servers/:id/test', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const id = String(req.params.id);

  const { data: row, error } = await supabaseAdmin
    .from('media_servers')
    .select('*')
    .eq('id', id)
    .eq('owner_id', me)
    .maybeSingle();
  if (error) {
    sendError(res, error.message, 500);
    return;
  }
  if (!row) {
    sendError(res, 'Server not found', 404);
    return;
  }

  let token: string;
  try {
    token = decryptToken(row.token_encrypted as string);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token decryption failed';
    sendError(res, message, 500);
    return;
  }

  if (row.kind === 'audiobookshelf') {
    try {
      const abs = new AudiobookshelfService(row.url as string, token);
      const libraries = await abs.getLibraries();
      sendSuccess(res, {
        connected: true,
        libraries: libraries.map((lib) => ({
          id: lib.id,
          name: lib.name,
          mediaType: lib.mediaType,
        })),
      });
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      sendError(res, message, 502);
      return;
    }
  }

  sendError(res, `Connection test for ${row.kind} not implemented yet`, 501);
});

// DELETE /api/v1/servers/:id — remove server (cascades to sources + shares)
serversRouter.delete('/api/v1/servers/:id', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const id = String(req.params.id);

  const { error, count } = await supabaseAdmin
    .from('media_servers')
    .delete({ count: 'exact' })
    .eq('id', id)
    .eq('owner_id', me);
  if (error) {
    sendError(res, error.message, 500);
    return;
  }
  if (!count) {
    sendError(res, 'Server not found', 404);
    return;
  }
  sendSuccess(res, { id });
});
