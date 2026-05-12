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
      /// Cached IDs of collections on this library server that the caller
      /// has an active grant on. Populated by [requireLibraryAccess] for
      /// non-owner callers; stays undefined for the owner (who can read
      /// every collection). Downstream handlers narrow their lookups by
      /// this set so a friend with kids-only access can't fetch a book
      /// from the adult collection by ID.
      grantedCollectionIds?: Set<string>;
      /// Cached book IDs the caller has access to via an active
      /// club_book_access grant (i.e. they're a member of a book club
      /// whose pick is that book). Populated by [requireLibraryAccess]
      /// for non-owner callers alongside grantedCollectionIds. Downstream
      /// handlers should allow the request if EITHER set covers it —
      /// club access is per-book and intentionally narrower than a
      /// collection grant, so it can't be used to fetch other books in
      /// the same collection.
      grantedClubBookIds?: Set<string>;
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
/// this library server OR holds at least one active per-collection
/// grant. Use on file-streaming + scan endpoints. 403 on no access.
///
/// For non-owners, populates `req.grantedCollectionIds` with the
/// collection IDs the caller can read. Downstream handlers must use
/// this set when looking up books, otherwise a grantee with access to
/// only one collection could fetch a book from another collection on
/// the same server by guessing its ID.
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
    // Owner: no per-collection narrowing — they see everything on this server.
    next();
    return;
  }
  // Non-owner: pull two independent sources of access in parallel —
  //   1. Collection grants (the v0.6 library-share model: owner shared
  //      a whole collection like kids/ or adult/ with this user).
  //   2. Club book grants (this user is a member of a book club whose
  //      pick is on this server). Narrower; per-book, time-bounded.
  // Both run in one round trip via Promise.all. If neither returns any
  // rows, the user has no business reading this server's files.
  try {
    const [collectionsResult, clubGrantsResult] = await Promise.all([
      hubClient()
        .from('library_server_grants')
        .select('collection_id, library_collections!inner(server_id)')
        .eq('grantee_id', userId)
        .is('revoked_at', null)
        .eq('library_collections.server_id', identity.serverId),
      // Active club grants for this user. We don't filter by server here
      // because the join would be expensive and ambiguous in PostgREST;
      // instead we fetch all of the user's active club grants (typically
      // a handful) and let the file handler's library_server_books
      // lookup do the per-server narrowing — it already does that today
      // by querying with `server_id = identity.serverId`.
      hubClient()
        .from('club_book_access')
        .select('book_id, clubs!inner(end_date)')
        .eq('user_id', userId)
        .is('revoked_at', null),
    ]);
    if (collectionsResult.error) throw collectionsResult.error;
    if (clubGrantsResult.error) throw clubGrantsResult.error;

    const collectionRows = (collectionsResult.data ?? []) as Array<{
      collection_id: string;
    }>;
    // PostgREST returns embedded relations as arrays even when the
    // join is single-row (the type system can't always tell a !inner
    // FK is unique), so normalize both shapes here.
    const clubRows = (clubGrantsResult.data ?? []) as unknown as Array<{
      book_id: string;
      clubs: { end_date: string | null } | { end_date: string | null }[] | null;
    }>;

    // Filter out club grants whose parent club has already ended. We do
    // this in JS rather than SQL so we don't pay for a NOW()-vs-timestamp
    // predicate on PostgREST; the row set is tiny.
    const nowMs = Date.now();
    const activeClubBookIds = clubRows
      .filter((r) => {
        const club = Array.isArray(r.clubs) ? r.clubs[0] : r.clubs;
        const end = club?.end_date;
        return !end || Date.parse(end) > nowMs;
      })
      .map((r) => r.book_id);

    if (collectionRows.length === 0 && activeClubBookIds.length === 0) {
      res.status(403).json({ success: false, error: 'No access to this library' });
      return;
    }
    req.grantedCollectionIds = new Set(collectionRows.map((r) => r.collection_id));
    req.grantedClubBookIds = new Set(activeClubBookIds);
    next();
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Grant lookup failed',
    });
  }
}
