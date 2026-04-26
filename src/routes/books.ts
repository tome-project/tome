import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { selectOne, selectMany } from '../services/db';
import { decryptToken } from '../services/crypto';
import { AudiobookshelfService } from '../services/audiobookshelf';
import { sendSuccess, sendError } from '../utils';

export const booksRouter = Router();

// GET /api/v1/books/:id — hydrated book detail
booksRouter.get('/api/v1/books/:id', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const id = String(req.params.id);
  try {
    const book = await selectOne('SELECT * FROM books WHERE id = $1', [id]);
    if (!book) {
      sendError(res, 'Book not found', 404);
      return;
    }
    const [userBook, sources] = await Promise.all([
      selectOne(
        'SELECT * FROM user_books WHERE user_id = $1 AND book_id = $2',
        [me, id]
      ),
      selectMany('SELECT * FROM book_sources WHERE book_id = $1', [id]),
    ]);
    sendSuccess(res, { book, user_book: userBook ?? null, sources });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});

interface CommunityRow {
  user_id: string;
  status: string;
  rating: number | null;
  review: string | null;
  review_privacy: string | null;
  privacy: string;
  finished_at: string | null;
}

// GET /api/v1/books/:id/community — others' visible reviews/ratings
booksRouter.get('/api/v1/books/:id/community', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const id = String(req.params.id);
  try {
    const rows = await selectMany<CommunityRow>(
      `SELECT user_id, status, rating, review, review_privacy, privacy, finished_at
         FROM user_books
        WHERE book_id = $1 AND user_id <> $2`,
      [id, me]
    );
    if (rows.length === 0) {
      sendSuccess(res, { items: [] });
      return;
    }

    const friendships = await selectMany<{ user_a_id: string; user_b_id: string }>(
      `SELECT user_a_id, user_b_id FROM friendships
        WHERE status = 'accepted' AND (user_a_id = $1 OR user_b_id = $1)`,
      [me]
    );
    const inCircle = new Set<string>();
    for (const f of friendships) inCircle.add(f.user_a_id === me ? f.user_b_id : f.user_a_id);

    const visible = rows.filter((r) => {
      if (r.privacy === 'public') return true;
      if (r.privacy === 'circle') return inCircle.has(r.user_id);
      return false;
    });
    if (visible.length === 0) {
      sendSuccess(res, { items: [] });
      return;
    }

    const visibleIds = [...new Set(visible.map((r) => r.user_id))];
    const profiles = await selectMany<{
      user_id: string;
      handle: string;
      display_name: string;
      avatar_url: string | null;
    }>(
      `SELECT user_id, handle, display_name, avatar_url
         FROM user_profiles WHERE user_id = ANY($1)`,
      [visibleIds]
    );
    const profilesById = new Map(profiles.map((p) => [p.user_id, p]));

    const items = visible.map((r) => ({
      user_id: r.user_id,
      status: r.status,
      rating: r.rating,
      review: r.review,
      finished_at: r.finished_at,
      in_circle: inCircle.has(r.user_id),
      profile: profilesById.get(r.user_id) ?? null,
    }));
    sendSuccess(res, { items });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});

// GET /api/v1/books/:id/chapters — audiobook chapter list from ABS source
booksRouter.get('/api/v1/books/:id/chapters', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const bookId = String(req.params.id);

  try {
    const sources = await selectMany<{
      kind: string;
      owner_id: string;
      external_id: string | null;
      media_server_id: string | null;
    }>('SELECT * FROM book_sources WHERE book_id = $1', [bookId]);

    const abs = sources.filter((s) => s.kind === 'audiobookshelf');
    if (abs.length === 0) {
      sendSuccess(res, { chapters: [] });
      return;
    }
    const source = abs.find((s) => s.owner_id === me) ?? abs[0];
    if (!source.media_server_id || !source.external_id) {
      sendSuccess(res, { chapters: [] });
      return;
    }

    const server = await selectOne<{ url: string; token_encrypted: string }>(
      'SELECT url, token_encrypted FROM media_servers WHERE id = $1',
      [source.media_server_id]
    );
    if (!server) {
      sendSuccess(res, { chapters: [] });
      return;
    }

    let token: string;
    try {
      token = decryptToken(server.token_encrypted);
    } catch {
      sendSuccess(res, { chapters: [] });
      return;
    }

    const absSvc = new AudiobookshelfService(server.url, token);
    const item = await absSvc.getItemDetail(source.external_id);
    const raw = item?.media.chapters ?? [];
    const chapters = raw.map((c, i) => ({
      index: i,
      start_ms: Math.round(c.start * 1000),
      end_ms: Math.round(c.end * 1000),
      title: c.title,
    }));
    sendSuccess(res, { chapters });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});
