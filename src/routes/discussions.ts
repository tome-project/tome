import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { selectOne, selectMany, insertOne } from '../services/db';
import { sendSuccess, sendError } from '../utils';

export const discussionsRouter = Router();

// GET /api/v1/clubs/:clubId/discussions
discussionsRouter.get(
  '/api/v1/clubs/:clubId/discussions',
  requireAuth,
  async (req: Request, res: Response) => {
    const { clubId } = req.params;
    const me = req.userId!;
    const chapter = req.query.chapter ? Number(req.query.chapter) : undefined;
    try {
      const membership = await selectOne(
        'SELECT id FROM club_members WHERE club_id = $1 AND user_id = $2',
        [clubId, me]
      );
      if (!membership) {
        sendError(res, 'You must be a member of this club', 403);
        return;
      }

      // Spoiler protection: when no explicit chapter filter, cap at the
      // user's current chapter on the club's book. Default to 1 so a member
      // who hasn't started (no progress row, or progress without a chapter)
      // still sees chapter 1, never later.
      let chapterCap: number | null = null;
      if (chapter === undefined) {
        chapterCap = 1;
        const club = await selectOne<{ book_id: string }>(
          'SELECT book_id FROM clubs WHERE id = $1',
          [clubId]
        );
        if (club) {
          const progress = await selectOne<{ chapter: number | null }>(
            'SELECT chapter FROM reading_progress WHERE user_id = $1 AND book_id = $2',
            [me, club.book_id]
          );
          if (progress?.chapter && progress.chapter > chapterCap) {
            chapterCap = progress.chapter;
          }
        }
      }

      const params: unknown[] = [clubId];
      let chapterClause = '';
      if (chapter !== undefined) {
        params.push(chapter);
        chapterClause = `AND chapter = $${params.length}`;
      } else if (chapterCap !== null) {
        params.push(chapterCap);
        chapterClause = `AND chapter <= $${params.length}`;
      }

      const data = await selectMany(
        `SELECT * FROM discussions
          WHERE club_id = $1 ${chapterClause}
          ORDER BY created_at ASC`,
        params
      );
      sendSuccess(res, data);
    } catch (err) {
      sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
    }
  }
);

discussionsRouter.post(
  '/api/v1/clubs/:clubId/discussions',
  requireAuth,
  async (req: Request, res: Response) => {
    const { clubId } = req.params;
    const me = req.userId!;
    const { chapter, content } = req.body;
    if (chapter === undefined || !content) {
      sendError(res, 'chapter and content are required');
      return;
    }
    try {
      const membership = await selectOne(
        'SELECT id FROM club_members WHERE club_id = $1 AND user_id = $2',
        [clubId, me]
      );
      if (!membership) {
        sendError(res, 'You must be a member of this club', 403);
        return;
      }
      const data = await insertOne('discussions', {
        club_id: clubId,
        user_id: me,
        chapter: Number(chapter),
        content,
      });
      sendSuccess(res, data, 201);
    } catch (err) {
      sendError(res, err instanceof Error ? err.message : 'Insert failed', 500);
    }
  }
);
