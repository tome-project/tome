import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { selectOne, selectMany, query } from '../services/db';
import { sendSuccess, sendError } from '../utils';
import type { Privacy, PublicProfile, UserProfile } from '../types';

export const profilesRouter = Router();

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

const RESERVED_HANDLES = new Set([
  'admin', 'administrator', 'support', 'help', 'tome', 'gettome',
  'about', 'api', 'auth', 'login', 'register', 'signup', 'signin',
  'settings', 'profile', 'profiles', 'user', 'users', 'me',
  'club', 'clubs', 'library', 'libraries', 'book', 'books', 'shelf',
  'system', 'root', 'null', 'undefined', 'staff', 'moderator',
]);

const PRIVACY_VALUES: Privacy[] = ['public', 'circle', 'private'];

function isPrivacy(value: unknown): value is Privacy {
  return typeof value === 'string' && (PRIVACY_VALUES as string[]).includes(value);
}

// GET /api/v1/profiles/me — own full profile
profilesRouter.get('/api/v1/profiles/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const data = await selectOne<UserProfile>(
      'SELECT * FROM user_profiles WHERE user_id = $1',
      [req.userId!]
    );
    if (!data) {
      sendError(res, 'Profile not found', 404);
      return;
    }
    sendSuccess(res, data);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});

// PATCH /api/v1/profiles/me — update handle, display name, bio, avatar, privacy defaults
profilesRouter.patch('/api/v1/profiles/me', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const body = req.body ?? {};
  const fields: string[] = ['updated_at = now()'];
  const params: unknown[] = [];

  if (body.handle !== undefined) {
    const normalized = String(body.handle).toLowerCase().trim();
    if (!HANDLE_RE.test(normalized)) {
      sendError(res, 'Handle must be 3-20 characters: lowercase letters, digits, underscores');
      return;
    }
    if (RESERVED_HANDLES.has(normalized)) {
      sendError(res, 'That handle is reserved', 409);
      return;
    }
    const taken = await selectOne<{ user_id: string }>(
      'SELECT user_id FROM user_profiles WHERE handle = $1 AND user_id <> $2',
      [normalized, me]
    );
    if (taken) {
      sendError(res, 'Handle already taken', 409);
      return;
    }
    fields.push(`handle = $${params.length + 1}`); params.push(normalized);
    fields.push(`handle_claimed = true`);
  }

  if (body.display_name !== undefined) {
    const name = String(body.display_name).trim();
    if (name.length < 1 || name.length > 60) {
      sendError(res, 'Display name must be 1-60 characters');
      return;
    }
    fields.push(`display_name = $${params.length + 1}`); params.push(name);
  }

  if (body.bio !== undefined) {
    const bio = body.bio === null ? null : String(body.bio).trim();
    if (bio !== null && bio.length > 300) {
      sendError(res, 'Bio must be 300 characters or fewer');
      return;
    }
    fields.push(`bio = $${params.length + 1}`); params.push(bio);
  }

  if (body.avatar_url !== undefined) {
    fields.push(`avatar_url = $${params.length + 1}`);
    params.push(body.avatar_url === null ? null : String(body.avatar_url));
  }

  for (const key of ['library_privacy', 'activity_privacy', 'review_privacy', 'highlight_privacy', 'note_privacy']) {
    if (body[key] !== undefined) {
      if (!isPrivacy(body[key])) {
        sendError(res, `${key} must be one of: public, circle, private`);
        return;
      }
      fields.push(`${key} = $${params.length + 1}`); params.push(body[key]);
    }
  }

  if (fields.length === 1) {
    sendError(res, 'No fields to update');
    return;
  }

  params.push(me);
  try {
    const data = await selectOne<UserProfile>(
      `UPDATE user_profiles SET ${fields.join(', ')} WHERE user_id = $${params.length} RETURNING *`,
      params
    );
    sendSuccess(res, data);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Update failed', 500);
  }
});

// GET /api/v1/profiles/search?q=... — fuzzy search by handle or display_name
profilesRouter.get('/api/v1/profiles/search', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 2) {
    sendSuccess(res, { results: [] });
    return;
  }
  const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  try {
    const data = await selectMany(
      `SELECT user_id, handle, display_name, avatar_url
         FROM user_profiles
        WHERE (handle ILIKE $1 OR display_name ILIKE $1)
          AND user_id <> $2
        LIMIT 20`,
      [like, me]
    );
    sendSuccess(res, { results: data });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Search failed', 500);
  }
});

// GET /api/v1/profiles/check-handle?h=foo — availability check
profilesRouter.get('/api/v1/profiles/check-handle', requireAuth, async (req: Request, res: Response) => {
  const h = typeof req.query.h === 'string' ? req.query.h.toLowerCase().trim() : '';
  if (!HANDLE_RE.test(h)) {
    sendSuccess(res, { available: false, reason: 'invalid_format' });
    return;
  }
  if (RESERVED_HANDLES.has(h)) {
    sendSuccess(res, { available: false, reason: 'reserved' });
    return;
  }
  try {
    const taken = await selectOne<{ user_id: string }>(
      'SELECT user_id FROM user_profiles WHERE handle = $1 AND user_id <> $2',
      [h, req.userId!]
    );
    sendSuccess(res, taken ? { available: false, reason: 'taken' } : { available: true });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});

// GET /api/v1/profiles/:handle — public profile by @handle
profilesRouter.get('/api/v1/profiles/:handle', requireAuth, async (req: Request, res: Response) => {
  const handle = String(req.params.handle).toLowerCase();
  if (!HANDLE_RE.test(handle)) {
    sendError(res, 'Invalid handle', 400);
    return;
  }
  try {
    const data = await selectOne<PublicProfile>(
      `SELECT user_id, handle, display_name, bio, avatar_url
         FROM user_profiles WHERE handle = $1`,
      [handle]
    );
    if (!data) {
      sendError(res, 'Profile not found', 404);
      return;
    }
    sendSuccess(res, data);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});

// silence unused import in case future helpers need it
void query;
