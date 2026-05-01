import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { hubClient } from '../services/hub';
import { loadIdentity } from '../services/server-identity';

declare global {
  namespace Express {
    interface Request {
      /// auth.users.id of the caller, populated by [requireSupabaseAuth].
      supabaseUserId?: string;
    }
  }
}

/// Lazy-initialized JWKS client pointed at this hub's pubkey endpoint.
let _jwks: jwksClient.JwksClient | null = null;
function jwksFor(supabaseUrl: string): jwksClient.JwksClient {
  if (_jwks) return _jwks;
  _jwks = jwksClient({
    jwksUri: `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
    cache: true,
    cacheMaxAge: 10 * 60 * 1000,
    rateLimit: true,
  });
  return _jwks;
}

function getKey(supabaseUrl: string) {
  return (header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) => {
    if (!header.kid) {
      callback(new Error('JWT missing kid header'));
      return;
    }
    jwksFor(supabaseUrl).getSigningKey(header.kid, (err, key) => {
      if (err) {
        callback(err);
        return;
      }
      callback(null, key?.getPublicKey());
    });
  };
}

/// Verify the incoming Authorization: Bearer <Supabase JWT>. On success,
/// attaches `req.supabaseUserId`. On failure, 401.
export function requireSupabaseAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Missing Authorization header' });
    return;
  }
  const token = auth.slice('Bearer '.length);
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    res.status(500).json({ success: false, error: 'Library server not paired (no SUPABASE_URL)' });
    return;
  }
  jwt.verify(
    token,
    getKey(supabaseUrl),
    { algorithms: ['RS256', 'ES256'] },
    (err, decoded) => {
      if (err || !decoded || typeof decoded === 'string') {
        res.status(401).json({ success: false, error: 'Invalid token' });
        return;
      }
      const sub = (decoded as jwt.JwtPayload).sub;
      if (typeof sub !== 'string') {
        res.status(401).json({ success: false, error: 'Token missing sub claim' });
        return;
      }
      req.supabaseUserId = sub;
      next();
    },
  );
}

/// On top of `requireSupabaseAuth`, ensure the caller is the owner of
/// this library server OR holds an active grant. Use on file-streaming
/// + scan endpoints. 403 on no access.
export async function requireLibraryAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = req.supabaseUserId;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }
  const identity = loadIdentity();
  if (!identity) {
    res.status(503).json({ success: false, error: 'Library server not paired yet' });
    return;
  }
  if (userId === identity.ownerId) {
    next();
    return;
  }
  // Otherwise, require an active grant.
  try {
    const { data, error } = await hubClient()
      .from('library_server_grants')
      .select('id')
      .eq('server_id', identity.serverId)
      .eq('grantee_id', userId)
      .is('revoked_at', null)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(403).json({ success: false, error: 'No access to this library' });
      return;
    }
    next();
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Grant lookup failed',
    });
  }
}
