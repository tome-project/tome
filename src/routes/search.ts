import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const searchRouter = Router();

// GET /api/v1/search?q=query — global search across books, clubs, highlights
searchRouter.get('/api/v1/search', requireAuth, async (req: Request, res: Response) => {
  const query = req.query.q as string | undefined;

  if (!query || query.trim().length === 0) {
    sendError(res, 'Search query is required');
    return;
  }

  const searchTerm = `%${query.trim()}%`;

  try {
    // Search books (title, author) — up to 10 matches
    const { data: books, error: booksError } = await supabaseAdmin
      .from('books')
      .select('id, title, author, cover_url, type')
      .eq('added_by', req.userId!)
      .or(`title.ilike.${searchTerm},author.ilike.${searchTerm}`)
      .limit(10);

    if (booksError) {
      sendError(res, booksError.message, 500);
      return;
    }

    // Search clubs (name) — up to 5 matches
    // First get club IDs the user is a member of
    const { data: memberships, error: memberError } = await supabaseAdmin
      .from('club_members')
      .select('club_id')
      .eq('user_id', req.userId!);

    if (memberError) {
      sendError(res, memberError.message, 500);
      return;
    }

    let clubs: unknown[] = [];
    if (memberships && memberships.length > 0) {
      const clubIds = memberships.map((m) => m.club_id);

      const { data: clubResults, error: clubsError } = await supabaseAdmin
        .from('clubs')
        .select(`
          id, name,
          club_members (user_id)
        `)
        .in('id', clubIds)
        .ilike('name', searchTerm)
        .limit(5);

      if (clubsError) {
        sendError(res, clubsError.message, 500);
        return;
      }

      clubs = (clubResults || []).map((club: any) => ({
        id: club.id,
        name: club.name,
        member_count: club.club_members?.length || 0,
      }));
    }

    // Search highlights (text) — up to 5 matches
    const { data: highlights, error: highlightsError } = await supabaseAdmin
      .from('highlights')
      .select(`
        id, text, note, book_id,
        books:book_id (title)
      `)
      .eq('user_id', req.userId!)
      .ilike('text', searchTerm)
      .limit(5);

    if (highlightsError) {
      sendError(res, highlightsError.message, 500);
      return;
    }

    sendSuccess(res, {
      books: books || [],
      clubs,
      highlights: (highlights || []).map((h: any) => ({
        id: h.id,
        text: h.text,
        note: h.note,
        book_id: h.book_id,
        book_title: h.books?.title || null,
      })),
    });
  } catch (err: any) {
    sendError(res, err.message || 'Search failed', 500);
  }
});
