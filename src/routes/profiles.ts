import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';
import type { Privacy, PublicProfile, UserProfile } from '../types';

export const profilesRouter = Router();

// Handles matching the DB constraint: ^[a-z0-9_]{3,20}$
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

// Reserved handles that can't be claimed by users.
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
  const { data, error } = await supabaseAdmin
    .from('user_profiles')
    .select('*')
    .eq('user_id', req.userId!)
    .maybeSingle();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }
  if (!data) {
    // Should not happen — the handle_new_user trigger always creates a row.
    sendError(res, 'Profile not found', 404);
    return;
  }
  sendSuccess(res, data as UserProfile);
});

// PATCH /api/v1/profiles/me — update handle, display name, bio, avatar, privacy defaults
profilesRouter.patch('/api/v1/profiles/me', requireAuth, async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

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

    // Uniqueness (scoped to other users)
    const { data: taken, error: checkErr } = await supabaseAdmin
      .from('user_profiles')
      .select('user_id')
      .eq('handle', normalized)
      .neq('user_id', req.userId!)
      .maybeSingle();
    if (checkErr) {
      sendError(res, checkErr.message, 500);
      return;
    }
    if (taken) {
      sendError(res, 'Handle already taken', 409);
      return;
    }

    updates.handle = normalized;
    updates.handle_claimed = true;
  }

  if (body.display_name !== undefined) {
    const name = String(body.display_name).trim();
    if (name.length < 1 || name.length > 60) {
      sendError(res, 'Display name must be 1-60 characters');
      return;
    }
    updates.display_name = name;
  }

  if (body.bio !== undefined) {
    const bio = body.bio === null ? null : String(body.bio).trim();
    if (bio !== null && bio.length > 300) {
      sendError(res, 'Bio must be 300 characters or fewer');
      return;
    }
    updates.bio = bio;
  }

  if (body.avatar_url !== undefined) {
    updates.avatar_url = body.avatar_url === null ? null : String(body.avatar_url);
  }

  for (const key of ['library_privacy', 'activity_privacy', 'review_privacy', 'highlight_privacy', 'note_privacy']) {
    if (body[key] !== undefined) {
      if (!isPrivacy(body[key])) {
        sendError(res, `${key} must be one of: public, circle, private`);
        return;
      }
      updates[key] = body[key];
    }
  }

  if (Object.keys(updates).length === 1) {
    // Only updated_at touched; nothing actually provided
    sendError(res, 'No fields to update');
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('user_profiles')
    .update(updates)
    .eq('user_id', req.userId!)
    .select()
    .single();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }
  sendSuccess(res, data as UserProfile);
});

// GET /api/v1/profiles/search?q=... — fuzzy search by handle or display name.
// Limits to 20 results and always excludes the caller.
profilesRouter.get('/api/v1/profiles/search', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 2) {
    sendSuccess(res, { results: [] });
    return;
  }

  // Postgres ILIKE is fine at this scale; pg_trgm index on user_profiles
  // would be a future optimization.
  const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const { data, error } = await supabaseAdmin
    .from('user_profiles')
    .select('user_id, handle, display_name, avatar_url')
    .or(`handle.ilike.${like},display_name.ilike.${like}`)
    .neq('user_id', me)
    .limit(20);
  if (error) {
    sendError(res, error.message, 500);
    return;
  }
  sendSuccess(res, { results: data ?? [] });
});

// GET /api/v1/profiles/check-handle?h=foo — availability check (for onboarding / renaming)
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
  const { data, error } = await supabaseAdmin
    .from('user_profiles')
    .select('user_id')
    .eq('handle', h)
    .neq('user_id', req.userId!)
    .maybeSingle();
  if (error) {
    sendError(res, error.message, 500);
    return;
  }
  if (data) {
    sendSuccess(res, { available: false, reason: 'taken' });
    return;
  }
  sendSuccess(res, { available: true });
});

// GET /api/v1/profiles/:handle — public profile view by @handle
profilesRouter.get('/api/v1/profiles/:handle', requireAuth, async (req: Request, res: Response) => {
  const handle = String(req.params.handle).toLowerCase();
  if (!HANDLE_RE.test(handle)) {
    sendError(res, 'Invalid handle', 400);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('user_profiles')
    .select('user_id, handle, display_name, bio, avatar_url')
    .eq('handle', handle)
    .maybeSingle();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }
  if (!data) {
    sendError(res, 'Profile not found', 404);
    return;
  }
  sendSuccess(res, data as PublicProfile);
});
