import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { selectOne, selectMany, insertOne, query, deleteWhere } from '../services/db';
import { encryptToken, decryptToken } from '../services/crypto';
import { AudiobookshelfService } from '../services/audiobookshelf';
import { sendSuccess, sendError } from '../utils';

export const serversRouter = Router();

type ServerKind = 'audiobookshelf' | 'calibre' | 'opds' | 'plex';
const SUPPORTED_KINDS: ServerKind[] = ['audiobookshelf', 'calibre', 'opds', 'plex'];

interface ServerRow {
  id: string;
  owner_id: string;
  name: string;
  kind: string;
  url: string;
  token_encrypted: string;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

function shapeServer(row: ServerRow | Record<string, unknown>) {
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
  try {
    const data = await selectMany<ServerRow>(
      `SELECT id, name, kind, url, last_sync_at, created_at, updated_at
         FROM media_servers
        WHERE owner_id = $1
        ORDER BY created_at DESC`,
      [req.userId!]
    );
    sendSuccess(res, { servers: data });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});

// POST /api/v1/servers — register a new media server
serversRouter.post('/api/v1/servers', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const { name, kind, url, token } = req.body ?? {};

  if (!name || typeof name !== 'string') { sendError(res, 'name is required'); return; }
  if (!SUPPORTED_KINDS.includes(kind)) {
    sendError(res, `kind must be one of: ${SUPPORTED_KINDS.join(', ')}`);
    return;
  }
  if (!url || typeof url !== 'string') { sendError(res, 'url is required'); return; }
  if (!token || typeof token !== 'string') { sendError(res, 'token is required'); return; }

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

  try {
    const data = await insertOne<ServerRow>('media_servers', {
      owner_id: me,
      name,
      kind,
      url,
      token_encrypted,
    });
    sendSuccess(res, shapeServer(data), 201);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Insert failed', 500);
  }
});

// PATCH /api/v1/servers/:id — update name / url / token
serversRouter.patch('/api/v1/servers/:id', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const id = String(req.params.id);
  const { name, url, token } = req.body ?? {};

  const fields: string[] = ['updated_at = now()'];
  const params: unknown[] = [];
  if (name !== undefined) { fields.push(`name = $${params.length + 1}`); params.push(String(name)); }
  if (url !== undefined) { fields.push(`url = $${params.length + 1}`); params.push(String(url)); }
  if (token !== undefined) {
    try {
      fields.push(`token_encrypted = $${params.length + 1}`);
      params.push(encryptToken(String(token)));
    } catch (err) {
      sendError(res, err instanceof Error ? err.message : 'Token encryption failed', 500);
      return;
    }
  }
  if (fields.length === 1) {
    sendError(res, 'No fields to update');
    return;
  }
  params.push(id, me);
  const idIdx = params.length - 1;
  const meIdx = params.length;

  try {
    const data = await selectOne<ServerRow>(
      `UPDATE media_servers SET ${fields.join(', ')}
        WHERE id = $${idIdx} AND owner_id = $${meIdx}
       RETURNING *`,
      params
    );
    if (!data) {
      sendError(res, 'Server not found', 404);
      return;
    }
    sendSuccess(res, shapeServer(data));
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Update failed', 500);
  }
});

// POST /api/v1/servers/:id/test — re-test the stored connection
serversRouter.post('/api/v1/servers/:id/test', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const id = String(req.params.id);
  try {
    const row = await selectOne<ServerRow>(
      'SELECT * FROM media_servers WHERE id = $1 AND owner_id = $2',
      [id, me]
    );
    if (!row) { sendError(res, 'Server not found', 404); return; }

    let token: string;
    try {
      token = decryptToken(row.token_encrypted);
    } catch (err) {
      sendError(res, err instanceof Error ? err.message : 'Token decryption failed', 500);
      return;
    }

    if (row.kind === 'audiobookshelf') {
      try {
        const abs = new AudiobookshelfService(row.url, token);
        const libraries = await abs.getLibraries();
        sendSuccess(res, {
          connected: true,
          libraries: libraries.map((lib) => ({
            id: lib.id,
            name: lib.name,
            mediaType: lib.mediaType,
          })),
        });
      } catch (err) {
        sendError(res, err instanceof Error ? err.message : 'Connection failed', 502);
      }
      return;
    }
    sendError(res, `Connection test for ${row.kind} not implemented yet`, 501);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});

// DELETE /api/v1/servers/:id — remove server (cascades to sources + shares)
serversRouter.delete('/api/v1/servers/:id', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const id = String(req.params.id);
  try {
    const count = await deleteWhere('media_servers', { id, owner_id: me });
    if (count === 0) {
      sendError(res, 'Server not found', 404);
      return;
    }
    sendSuccess(res, { id });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Delete failed', 500);
  }
});
// (use 'query' helper if needed for any complex multi-statement op)
void query;
