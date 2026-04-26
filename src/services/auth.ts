import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { selectOne, insertOne, upsertOne } from './db';

// ---------------------------------------------------------------------------
// Local auth: bcrypt password hashing + JWT issuance/validation against
// public.users. Replaces the previous Supabase Auth integration.
//
// Existing users keep their passwords: Supabase stored bcrypt hashes
// ($2a$10$...) in auth.users.encrypted_password. Migration 014 copied them
// verbatim into public.users.password_hash, and bcryptjs.compare() reads
// the same hash format.
// ---------------------------------------------------------------------------

export interface LocalUser {
  id: string;
  email: string;
  password_hash: string | null;
  display_name: string | null;
  email_confirmed: boolean;
  created_at: string;
  updated_at: string;
}

export interface LocalSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;        // seconds until expiry
  expires_at: number;        // unix seconds (matches Supabase shape)
  token_type: 'bearer';
}

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;            // 1 hour
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'JWT_SECRET env var must be set to a string of at least 32 characters'
    );
  }
  return secret;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string | null): Promise<boolean> {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

interface AccessTokenPayload {
  sub: string;
  email: string;
  type: 'access';
}

interface RefreshTokenPayload {
  sub: string;
  type: 'refresh';
  jti: string;
}

export function issueSession(user: LocalUser): LocalSession {
  const secret = getJwtSecret();
  const accessPayload: AccessTokenPayload = {
    sub: user.id,
    email: user.email,
    type: 'access',
  };
  const access_token = jwt.sign(accessPayload, secret, { expiresIn: ACCESS_TOKEN_TTL_SECONDS });
  const refreshPayload: RefreshTokenPayload = {
    sub: user.id,
    type: 'refresh',
    jti: randomUUID(),
  };
  const refresh_token = jwt.sign(refreshPayload, secret, { expiresIn: REFRESH_TOKEN_TTL_SECONDS });
  const expires_at = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;
  return {
    access_token,
    refresh_token,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    expires_at,
    token_type: 'bearer',
  };
}

/// Verify an access token and return its sub (user id). Throws on invalid
/// or expired tokens.
export function verifyAccessToken(token: string): { sub: string; email: string } {
  const decoded = jwt.verify(token, getJwtSecret()) as jwt.JwtPayload;
  if (decoded.type !== 'access' || typeof decoded.sub !== 'string') {
    throw new Error('Not an access token');
  }
  return { sub: decoded.sub, email: (decoded.email as string) ?? '' };
}

export function verifyRefreshToken(token: string): { sub: string } {
  const decoded = jwt.verify(token, getJwtSecret()) as jwt.JwtPayload;
  if (decoded.type !== 'refresh' || typeof decoded.sub !== 'string') {
    throw new Error('Not a refresh token');
  }
  return { sub: decoded.sub };
}

// ---------------------------------------------------------------------------
// User lookup helpers — talk to the database directly via the pg pool.
// ---------------------------------------------------------------------------

export async function findUserByEmail(email: string): Promise<LocalUser | null> {
  return selectOne<LocalUser>('SELECT * FROM users WHERE email = $1', [email]);
}

export async function findUserById(id: string): Promise<LocalUser | null> {
  return selectOne<LocalUser>('SELECT * FROM users WHERE id = $1', [id]);
}

export async function createUser(input: {
  email: string;
  password: string;
  display_name?: string;
}): Promise<LocalUser> {
  const password_hash = await hashPassword(input.password);
  const display_name = input.display_name ?? input.email.split('@')[0];
  return insertOne<LocalUser>('users', {
    id: randomUUID(),
    email: input.email,
    password_hash,
    display_name,
    email_confirmed: true,
  });
}

// 8-char invite code; mirrors the alphabet used by the SQL helper
// (avoids 0/o/1/l so codes can be read aloud without confusion).
const INVITE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function randomInviteCode(): string {
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += INVITE_ALPHABET[Math.floor(Math.random() * INVITE_ALPHABET.length)];
  }
  return code;
}

/// Mirror the dropped on_auth_user_created / handle_new_user trigger:
/// when a user is created, also create their public.user_profiles row with
/// a placeholder handle and a unique invite_code. Idempotent.
export async function ensureUserProfile(user: LocalUser): Promise<void> {
  const baseHandle = `user_${user.id.slice(0, 8)}`;
  let handle = baseHandle;
  let suffix = 0;

  // Retry-on-collision for the placeholder handle.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await selectOne<{ user_id: string }>(
      'SELECT user_id FROM user_profiles WHERE handle = $1',
      [handle]
    );
    if (!existing) break;
    suffix += 1;
    handle = `${baseHandle}_${suffix}`;
  }

  // Retry-on-collision for invite_code.
  let invite_code = randomInviteCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await selectOne<{ user_id: string }>(
      'SELECT user_id FROM user_profiles WHERE invite_code = $1',
      [invite_code]
    );
    if (!existing) break;
    invite_code = randomInviteCode();
  }

  await upsertOne(
    'user_profiles',
    {
      user_id: user.id,
      handle,
      display_name: user.display_name ?? user.email.split('@')[0],
      handle_claimed: false,
      invite_code,
    },
    { onConflict: 'user_id', ignoreDuplicates: true }
  );
}
