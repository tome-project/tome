import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const activityRouter = Router();

// GET /api/v1/activity — activity feed across all clubs the user belongs to
activityRouter.get('/api/v1/activity', requireAuth, async (req: Request, res: Response) => {
  // 1. Get all club IDs the user belongs to
  const { data: memberships, error: memberError } = await supabaseAdmin
    .from('club_members')
    .select('club_id')
    .eq('user_id', req.userId!);

  if (memberError) {
    sendError(res, memberError.message, 500);
    return;
  }

  if (!memberships || memberships.length === 0) {
    sendSuccess(res, []);
    return;
  }

  const clubIds = memberships.map((m) => m.club_id);

  // 2. Get all member user_ids across those clubs
  const { data: allMembers, error: allMembersError } = await supabaseAdmin
    .from('club_members')
    .select('user_id, club_id, joined_at')
    .in('club_id', clubIds);

  if (allMembersError) {
    sendError(res, allMembersError.message, 500);
    return;
  }

  const memberUserIds = [...new Set(allMembers!.map((m) => m.user_id))];

  // 3. Get club names for display
  const { data: clubs } = await supabaseAdmin
    .from('clubs')
    .select('id, name, book_id')
    .in('id', clubIds);

  const clubMap = new Map<string, { name: string; book_id: string }>();
  for (const club of clubs || []) {
    clubMap.set(club.id, { name: club.name, book_id: club.book_id });
  }

  // 4. Get book IDs from clubs for progress filtering
  const clubBookIds = [...new Set((clubs || []).map((c) => c.book_id).filter(Boolean))];

  // 5. Query progress updates — filtered to club books and club members
  let progressItems: Array<Record<string, unknown>> = [];
  if (clubBookIds.length > 0) {
    const { data: progressData } = await supabaseAdmin
      .from('progress')
      .select('user_id, book_id, status, percentage, updated_at')
      .in('user_id', memberUserIds)
      .in('book_id', clubBookIds)
      .order('updated_at', { ascending: false })
      .limit(50);

    if (progressData) {
      // Get book details for progress items
      const bookIds = [...new Set(progressData.map((p) => p.book_id))];
      const { data: books } = await supabaseAdmin
        .from('books')
        .select('id, title, cover_url')
        .in('id', bookIds);

      const bookMap = new Map<string, { title: string; cover_url: string | null }>();
      for (const book of books || []) {
        bookMap.set(book.id, { title: book.title, cover_url: book.cover_url });
      }

      progressItems = progressData.map((p) => {
        const book = bookMap.get(p.book_id);
        return {
          type: 'progress',
          user_id: p.user_id,
          timestamp: p.updated_at,
          data: {
            book_title: book?.title || 'Unknown Book',
            book_cover_url: book?.cover_url || null,
            status: p.status || (p.percentage >= 100 ? 'finished' : p.percentage > 0 ? 'reading' : 'want_to_read'),
            percentage: p.percentage,
          },
        };
      });
    }
  }

  // 6. Query discussion posts
  const { data: discussionData } = await supabaseAdmin
    .from('discussions')
    .select('user_id, club_id, chapter, content, created_at')
    .in('club_id', clubIds)
    .order('created_at', { ascending: false })
    .limit(50);

  const discussionItems = (discussionData || []).map((d) => {
    const club = clubMap.get(d.club_id);
    return {
      type: 'discussion',
      user_id: d.user_id,
      timestamp: d.created_at,
      data: {
        club_name: club?.name || 'Unknown Club',
        chapter: d.chapter,
        preview: d.content ? d.content.substring(0, 100) : '',
      },
    };
  });

  // 7. Query club joins
  const joinItems = (allMembers || []).map((m) => {
    const club = clubMap.get(m.club_id);
    return {
      type: 'club_join',
      user_id: m.user_id,
      timestamp: m.joined_at,
      data: {
        club_name: club?.name || 'Unknown Club',
      },
    };
  });

  // 8. Union, sort by timestamp desc, limit 50
  const allItems = [...progressItems, ...discussionItems, ...joinItems];
  allItems.sort((a, b) => {
    const timeA = new Date(a.timestamp as string).getTime();
    const timeB = new Date(b.timestamp as string).getTime();
    return timeB - timeA;
  });

  sendSuccess(res, allItems.slice(0, 50));
});
