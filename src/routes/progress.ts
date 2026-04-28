import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { selectOne, selectMany, upsertOne, query } from '../services/db';
import { sendSuccess, sendError } from '../utils';

export const progressRouter = Router();

// POST /api/v1/progress — save position/percentage for a book.
// Body: { book_id, position, percentage, source_kind? }
//
// Status / rating / review live on /api/v1/user-books. This route is just
// streaming position updates from the reader. When percentage hits 100,
// auto-mark the corresponding user_book as 'finished' if one exists; on
// first progress > 0, transition 'want' → 'reading'. Both are best-effort.
progressRouter.post('/api/v1/progress', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const { book_id, position, percentage, source_kind, chapter } = req.body ?? {};

  if (!book_id || position === undefined || percentage === undefined) {
    sendError(res, 'book_id, position, and percentage are required');
    return;
  }
  const pct = Number(percentage);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    sendError(res, 'percentage must be between 0 and 100');
    return;
  }

  const upsertRecord: Record<string, unknown> = {
    user_id: me,
    book_id,
    position: String(position),
    percentage: pct,
    updated_at: new Date().toISOString(),
  };
  if (source_kind !== undefined) {
    upsertRecord.source_kind = source_kind === null ? null : String(source_kind);
  }
  if (chapter !== undefined) {
    if (chapter === null) {
      upsertRecord.chapter = null;
    } else {
      const ch = Number(chapter);
      if (Number.isFinite(ch) && ch >= 1) upsertRecord.chapter = Math.floor(ch);
    }
  }

  try {
    const data = await upsertOne('reading_progress', upsertRecord, {
      onConflict: 'user_id,book_id',
    });

    // Bridge to user_books — ignore errors so a miss never breaks the
    // primary progress write.
    const today = new Date().toISOString().slice(0, 10);
    if (pct > 0 && pct < 100) {
      await query(
        `UPDATE user_books
            SET status = 'reading', started_at = $1, updated_at = now()
          WHERE user_id = $2 AND book_id = $3 AND status = 'want'`,
        [today, me, book_id]
      );
    }
    if (pct >= 100) {
      await query(
        `UPDATE user_books
            SET status = 'finished', finished_at = $1, updated_at = now()
          WHERE user_id = $2 AND book_id = $3 AND status <> 'finished'`,
        [today, me, book_id]
      );
    }

    sendSuccess(res, data);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});

// GET /api/v1/progress/:bookId/friends — visible friends' progress on this
// book, used to paint pace markers on the player's whole-book hairline.
//
// Visibility rules: only accepted friendships, only friends whose
// `activity_privacy` isn't 'private', and only their reading_progress rows
// for the requested book. We deliberately don't read user_books status here
// — friends who started and stopped (status='dnf') still belong on the
// timeline so the user can see "we both bailed at the same chapter".
progressRouter.get(
  '/api/v1/progress/:bookId/friends',
  requireAuth,
  async (req: Request, res: Response) => {
    const me = req.userId!;
    const bookId = String(req.params.bookId);
    try {
      const friendships = await selectMany<{ user_a_id: string; user_b_id: string }>(
        `SELECT user_a_id, user_b_id FROM friendships
          WHERE status = 'accepted' AND (user_a_id = $1 OR user_b_id = $1)`,
        [me]
      );
      const friendIds = friendships.map((f) =>
        f.user_a_id === me ? f.user_b_id : f.user_a_id
      );
      if (friendIds.length === 0) {
        sendSuccess(res, { items: [] });
        return;
      }

      const profiles = await selectMany<{
        user_id: string;
        handle: string;
        display_name: string;
        avatar_url: string | null;
        activity_privacy: string;
      }>(
        `SELECT user_id, handle, display_name, avatar_url, activity_privacy
           FROM user_profiles WHERE user_id = ANY($1)`,
        [friendIds]
      );
      const profilesById = new Map<string, (typeof profiles)[number]>();
      const visibleIds: string[] = [];
      for (const p of profiles) {
        if (p.activity_privacy !== 'private') {
          profilesById.set(p.user_id, p);
          visibleIds.push(p.user_id);
        }
      }
      if (visibleIds.length === 0) {
        sendSuccess(res, { items: [] });
        return;
      }

      const progress = await selectMany<{
        user_id: string;
        percentage: string | number;
        position: string;
        chapter: number | null;
        updated_at: string;
      }>(
        `SELECT user_id, percentage, position, chapter, updated_at
           FROM reading_progress
          WHERE book_id = $1 AND user_id = ANY($2) AND percentage > 0
          ORDER BY percentage ASC`,
        [bookId, visibleIds]
      );

      const items = progress.map((p) => {
        const prof = profilesById.get(p.user_id);
        return {
          user_id: p.user_id,
          percentage: typeof p.percentage === 'string' ? Number(p.percentage) : p.percentage,
          position: p.position,
          chapter: p.chapter,
          updated_at: p.updated_at,
          profile: prof
            ? {
                handle: prof.handle,
                display_name: prof.display_name,
                avatar_url: prof.avatar_url,
              }
            : null,
        };
      });

      sendSuccess(res, { items });
    } catch (err) {
      sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
    }
  }
);

// GET /api/v1/progress/:bookId — current reading position
progressRouter.get('/api/v1/progress/:bookId', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const bookId = String(req.params.bookId);
  try {
    const data = await selectOne(
      'SELECT * FROM reading_progress WHERE user_id = $1 AND book_id = $2',
      [me, bookId]
    );
    sendSuccess(res, data ?? { book_id: bookId, position: '0', percentage: 0 });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});
