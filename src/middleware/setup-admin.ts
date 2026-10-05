import fs from 'fs';
import path from 'path';
import { randomBytes, timingSafeEqual } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { loadIdentity } from '../services/server-identity';
import { requireSupabaseAuth } from './supabase-auth';

export function adminKey(): string {
  if (process.env.TOME_ADMIN_TOKEN) return process.env.TOME_ADMIN_TOKEN;
  const file = path.join(process.env.LIBRARY_PATH || './library', '.tome-admin-key');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
  }
  return fs.readFileSync(file, 'utf8').trim();
}

export function requireSetupAdmin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get('origin');
  let sameOrigin = !origin;
  try { sameOrigin = !origin || new URL(origin).host === req.get('host'); } catch { sameOrigin = false; }
  if (!sameOrigin) {
    res.status(403).json({ success: false, error: 'Cross-origin administration is disabled' });
    return;
  }
  if (req.headers.authorization?.startsWith('Bearer ')) {
    requireSupabaseAuth(req, res, () => {
      if (req.supabaseUserId !== loadIdentity()?.ownerId) {
        res.status(403).json({ success: false, error: 'Only the library owner can administer this server' });
        return;
      }
      next();
    });
    return;
  }
  if (req.headers.authorization?.startsWith('Basic ')) {
    const decoded = Buffer.from(req.headers.authorization.slice(6), 'base64').toString('utf8');
    const supplied = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
    const expected = Buffer.from(adminKey());
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) { next(); return; }
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Tome administration", charset="UTF-8"');
  res.status(401).send('Use username admin and TOME_ADMIN_TOKEN (or the .tome-admin-key file in your library).');
}
