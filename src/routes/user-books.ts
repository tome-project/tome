import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { selectOne, selectMany, upsertOne, deleteWhere, query } from '../services/db';
import { sendSuccess, sendError } from '../utils';

export const userBooksRouter = Router();

type Status = 'want' | 'reading' | 'finished' | 'dnf';
type Privacy = 'public' | 'circle' | 'private';

const STATUSES: Status[] = ['want', 'reading', 'finished', 'dnf'];
const PRIVACIES: Privacy[] = ['public', 'circle', 'private'];

function isStatus(v: unknown): v is Status {
  return typeof v === 'string' && (STATUSES as string[]).includes(v);
}
function isPrivacy(v: unknown): v is Privacy {
  return typeof v === 'string' && (PRIVACIES as string[]).includes(v);
}

// Hydrated row: user_book + the catalog book as a `book` JSON column.
const HYDRATED_SELECT = `
  ub.*,
  to_jsonb(b.*) AS book`;

userBooksRouter.get('/api/v1/user-books', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const targetUserId = typeof req.query.user_id === 'string' ? req.query.user_id : me;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  if (status && !isStatus(status)) {
    sendError(res, 'Invalid status filter');
    return;
  }

  // Visibility filter when querying another user's shelf
  let privacyFilter = '';
  if (targetUserId !== me) {
    const [a, b] = [me, targetUserId].sort();
    const friendship = await selectOne<{ status: string }>(
      'SELECT status FROM friendships WHERE user_a_id = $1 AND user_b_id = $2',
      [a, b]
    );
    privacyFilter = friendship?.status === 'accepted'
      ? "AND ub.privacy IN ('public', 'circle')"
      : "AND ub.privacy = 'public'";
  }

  const params: unknown[] = [targetUserId];
  let statusClause = '';
  if (status) {
    params.push(status);
    statusClause = `AND ub.status = $${params.length}`;
  }

  try {
    const data = await selectMany(
      `SELECT ${HYDRATED_SELECT}
         FROM user_books ub
         LEFT JOIN books b ON b.id = ub.book_id
        WHERE ub.user_id = $1 ${statusClause} ${privacyFilter}
        ORDER BY ub.updated_at DESC`,
      params
    );
    sendSuccess(res, { items: data });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});

userBooksRouter.get('/api/v1/user-books/:id', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const id = String(req.params.id);
  try {
    const data = await selectOne(
      `SELECT ${HYDRATED_SELECT}
         FROM user_books ub
         LEFT JOIN books b ON b.id = ub.book_id
        WHERE ub.id = $1 AND ub.user_id = $2`,
      [id, me]
    );
    if (!data) {
      sendError(res, 'Not found', 404);
      return;
    }
    sendSuccess(res, data);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});

userBooksRouter.post('/api/v1/user-books', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const body = req.body ?? {};

  if (!body.book_id || typeof body.book_id !== 'string') {
    sendError(res, 'book_id is required');
    return;
  }
  if (!isStatus(body.status)) {
    sendError(res, `status must be one of: ${STATUSES.join(', ')}`);
    return;
  }

  const insert: Record<string, unknown> = {
    user_id: me,
    book_id: body.book_id,
    status: body.status,
  };

  if (body.rating !== undefined) {
    const r = Number(body.rating);
    if (!Number.isInteger(r) || r < 1 || r > 5) {
      sendError(res, 'rating must be an integer 1–5');
      return;
    }
    insert.rating = r;
  }
  if (body.review !== undefined) insert.review = body.review === null ? null : String(body.review);
  if (body.favorite_quote !== undefined) insert.favorite_quote = body.favorite_quote === null ? null : String(body.favorite_quote);
  if (body.started_at !== undefined) insert.started_at = body.started_at;
  if (body.finished_at !== undefined) insert.finished_at = body.finished_at;
  if (body.privacy !== undefined) {
    if (!isPrivacy(body.privacy)) {
      sendError(res, `privacy must be one of: ${PRIVACIES.join(', ')}`);
      return;
    }
    insert.privacy = body.privacy;
  }
  if (body.review_privacy !== undefined) {
    if (body.review_privacy !== null && !isPrivacy(body.review_privacy)) {
      sendError(res, `review_privacy must be one of: ${PRIVACIES.join(', ')}`);
      return;
    }
    insert.review_privacy = body.review_privacy;
  }

  try {
    const catalog = await selectOne<{ id: string }>(
      'SELECT id FROM books WHERE id = $1',
      [body.book_id]
    );
    if (!catalog) {
      sendError(res, 'book_id not in catalog — import it first via /api/v1/catalog/import', 404);
      return;
    }

    await upsertOne('user_books', insert, { onConflict: 'user_id,book_id' });

    const data = await selectOne(
      `SELECT ${HYDRATED_SELECT}
         FROM user_books ub
         LEFT JOIN books b ON b.id = ub.book_id
        WHERE ub.user_id = $1 AND ub.book_id = $2`,
      [me, body.book_id]
    );
    sendSuccess(res, data, 201);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Insert failed', 500);
  }
});

userBooksRouter.patch('/api/v1/user-books/:id', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const id = String(req.params.id);
  const body = req.body ?? {};

  const fields: string[] = ['updated_at = now()'];
  const params: unknown[] = [];

  const todayDate = new Date().toISOString().slice(0, 10);
  if (body.status !== undefined) {
    if (!isStatus(body.status)) {
      sendError(res, `status must be one of: ${STATUSES.join(', ')}`);
      return;
    }
    fields.push(`status = $${params.length + 1}`); params.push(body.status);
    if (body.status === 'finished' && body.finished_at === undefined) {
      fields.push(`finished_at = $${params.length + 1}`); params.push(todayDate);
    }
    if (body.status === 'reading' && body.started_at === undefined) {
      fields.push(`started_at = $${params.length + 1}`); params.push(todayDate);
    }
  }
  if (body.rating !== undefined) {
    if (body.rating === null) {
      fields.push(`rating = NULL`);
    } else {
      const r = Number(body.rating);
      if (!Number.isInteger(r) || r < 1 || r > 5) {
        sendError(res, 'rating must be an integer 1–5 or null');
        return;
      }
      fields.push(`rating = $${params.length + 1}`); params.push(r);
    }
  }
  if (body.review !== undefined) {
    fields.push(`review = $${params.length + 1}`);
    params.push(body.review === null ? null : String(body.review));
  }
  if (body.favorite_quote !== undefined) {
    fields.push(`favorite_quote = $${params.length + 1}`);
    params.push(body.favorite_quote === null ? null : String(body.favorite_quote));
  }
  if (body.started_at !== undefined) { fields.push(`started_at = $${params.length + 1}`); params.push(body.started_at); }
  if (body.finished_at !== undefined) { fields.push(`finished_at = $${params.length + 1}`); params.push(body.finished_at); }
  if (body.privacy !== undefined) {
    if (!isPrivacy(body.privacy)) {
      sendError(res, `privacy must be one of: ${PRIVACIES.join(', ')}`);
      return;
    }
    fields.push(`privacy = $${params.length + 1}`); params.push(body.privacy);
  }
  if (body.review_privacy !== undefined) {
    if (body.review_privacy !== null && !isPrivacy(body.review_privacy)) {
      sendError(res, `review_privacy must be one of: ${PRIVACIES.join(', ')}`);
      return;
    }
    fields.push(`review_privacy = $${params.length + 1}`); params.push(body.review_privacy);
  }

  if (fields.length === 1) {
    sendError(res, 'No fields to update');
    return;
  }

  params.push(id, me);
  try {
    await query(
      `UPDATE user_books SET ${fields.join(', ')}
        WHERE id = $${params.length - 1} AND user_id = $${params.length}`,
      params
    );
    const data = await selectOne(
      `SELECT ${HYDRATED_SELECT}
         FROM user_books ub
         LEFT JOIN books b ON b.id = ub.book_id
        WHERE ub.id = $1 AND ub.user_id = $2`,
      [id, me]
    );
    if (!data) {
      sendError(res, 'Not found', 404);
      return;
    }
    sendSuccess(res, data);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Update failed', 500);
  }
});

userBooksRouter.delete('/api/v1/user-books/:id', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const id = String(req.params.id);
  try {
    const count = await deleteWhere('user_books', { id, user_id: me });
    if (count === 0) {
      sendError(res, 'Not found', 404);
      return;
    }
    sendSuccess(res, { id });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Delete failed', 500);
  }
});
