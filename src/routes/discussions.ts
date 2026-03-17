import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const discussionsRouter = Router();

// GET /api/v1/clubs/:clubId/discussions — get discussions for a club
discussionsRouter.get(
  '/api/v1/clubs/:clubId/discussions',
  requireAuth,
  async (req: Request, res: Response) => {
    const { clubId } = req.params;
    const chapter = req.query.chapter ? Number(req.query.chapter) : undefined;

    // Verify user is a member of this club
    const { data: membership } = await supabaseAdmin
      .from('club_members')
      .select('id')
      .eq('club_id', clubId)
      .eq('user_id', req.userId!)
      .single();

    if (!membership) {
      sendError(res, 'You must be a member of this club', 403);
      return;
    }

    let query = supabaseAdmin
      .from('discussions')
      .select('*')
      .eq('club_id', clubId)
      .order('created_at', { ascending: true });

    if (chapter !== undefined) {
      query = query.eq('chapter', chapter);
    }

    // Spoiler protection: only show discussions for chapters the user has reached
    // Get user's progress on the club's book
    const { data: club } = await supabaseAdmin
      .from('clubs')
      .select('book_id')
      .eq('id', clubId)
      .single();

    if (club) {
      const { data: progress } = await supabaseAdmin
        .from('progress')
        .select('position')
        .eq('user_id', req.userId!)
        .eq('book_id', club.book_id)
        .single();

      // If user has progress, filter discussions to chapters they've reached
      // Position format: chapter number or page-based position
      if (progress && chapter === undefined) {
        const currentChapter = parseInt(progress.position, 10);
        if (!isNaN(currentChapter)) {
          query = query.lte('chapter', currentChapter);
        }
      }
    }

    const { data, error } = await query;

    if (error) {
      sendError(res, error.message, 500);
      return;
    }

    sendSuccess(res, data);
  }
);

// POST /api/v1/clubs/:clubId/discussions — post a discussion message
discussionsRouter.post(
  '/api/v1/clubs/:clubId/discussions',
  requireAuth,
  async (req: Request, res: Response) => {
    const { clubId } = req.params;
    const { chapter, content } = req.body;

    if (chapter === undefined || !content) {
      sendError(res, 'chapter and content are required');
      return;
    }

    // Verify membership
    const { data: membership } = await supabaseAdmin
      .from('club_members')
      .select('id')
      .eq('club_id', clubId)
      .eq('user_id', req.userId!)
      .single();

    if (!membership) {
      sendError(res, 'You must be a member of this club', 403);
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('discussions')
      .insert({
        club_id: clubId,
        user_id: req.userId,
        chapter: Number(chapter),
        content,
      })
      .select()
      .single();

    if (error) {
      sendError(res, error.message, 500);
      return;
    }

    sendSuccess(res, data, 201);
  }
);
