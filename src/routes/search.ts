import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { selectMany } from '../services/db';
import { sendSuccess, sendError } from '../utils';

export const searchRouter = Router();

// GET /api/v1/search?q=query — global search across the caller's library +
// clubs they belong to + their highlights. Joined queries return ranked-by-
// recency rows; the existing client tolerates missing fields.
searchRouter.get('/api/v1/search', requireAuth, async (req: Request, res: Response) => {
  const q = req.query.q as string | undefined;
  if (!q || q.trim().length === 0) {
    sendError(res, 'Search query is required');
    return;
  }
  const term = `%${q.trim()}%`;
  const me = req.userId!;

  try {
    // Books in the caller's library matching title or any author.
    const books = await selectMany<{ id: string; title: string; cover_url: string | null }>(
      `SELECT b.id, b.title, b.cover_url
         FROM user_books ub
         JOIN books b ON b.id = ub.book_id
        WHERE ub.user_id = $1
          AND (b.title ILIKE $2 OR EXISTS (
            SELECT 1 FROM unnest(b.authors) a WHERE a ILIKE $2
          ))
        ORDER BY ub.updated_at DESC
        LIMIT 10`,
      [me, term]
    );

    // Clubs the user is a member of, name matches.
    const clubs = await selectMany<{ id: string; name: string; member_count: number }>(
      `SELECT c.id, c.name,
              (SELECT count(*)::int FROM club_members cm WHERE cm.club_id = c.id) AS member_count
         FROM clubs c
         JOIN club_members m ON m.club_id = c.id
        WHERE m.user_id = $1 AND c.name ILIKE $2
        LIMIT 5`,
      [me, term]
    );

    // Highlights of the caller's, joined with book title.
    const highlights = await selectMany<{
      id: string;
      text: string;
      note: string | null;
      book_id: string;
      book_title: string | null;
    }>(
      `SELECT h.id, h.text, h.note, h.book_id, b.title AS book_title
         FROM highlights h
         LEFT JOIN books b ON b.id = h.book_id
        WHERE h.user_id = $1 AND h.text ILIKE $2
        ORDER BY h.created_at DESC
        LIMIT 5`,
      [me, term]
    );

    sendSuccess(res, { books, clubs, highlights });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Search failed', 500);
  }
});
