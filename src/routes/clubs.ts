import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth';
import { selectOne, selectMany, insertOne, deleteWhere } from '../services/db';
import { sendSuccess, sendError } from '../utils';

export const clubsRouter = Router();

interface ClubRow {
  id: string;
  name: string;
  book_id: string;
  host_id: string;
  invite_code: string;
  start_date: string;
  end_date: string | null;
  created_at: string;
}

interface MemberRow {
  id: string;
  club_id: string;
  user_id: string;
  role: string;
  joined_at: string;
}

interface PublicProfileRow {
  user_id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
}

async function hydrateClubMembers(clubIds: string[]): Promise<Map<string, Array<{ user_id: string; joined_at: string }>>> {
  const map = new Map<string, Array<{ user_id: string; joined_at: string }>>();
  if (clubIds.length === 0) return map;
  const members = await selectMany<{ club_id: string; user_id: string; joined_at: string }>(
    'SELECT club_id, user_id, joined_at FROM club_members WHERE club_id = ANY($1)',
    [clubIds]
  );
  for (const m of members) {
    const existing = map.get(m.club_id) ?? [];
    existing.push({ user_id: m.user_id, joined_at: m.joined_at });
    map.set(m.club_id, existing);
  }
  return map;
}

clubsRouter.get('/api/v1/clubs', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  try {
    const memberships = await selectMany<{ club_id: string }>(
      'SELECT club_id FROM club_members WHERE user_id = $1',
      [me]
    );
    if (memberships.length === 0) {
      sendSuccess(res, []);
      return;
    }
    const clubIds = memberships.map((m) => m.club_id);
    const clubs = await selectMany<ClubRow>(
      'SELECT * FROM clubs WHERE id = ANY($1) ORDER BY created_at DESC',
      [clubIds]
    );
    const membersByClub = await hydrateClubMembers(clubIds);
    const data = clubs.map((c) => ({ ...c, club_members: membersByClub.get(c.id) ?? [] }));
    sendSuccess(res, data);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});

clubsRouter.post('/api/v1/clubs', requireAuth, async (req: Request, res: Response) => {
  const me = req.userId!;
  const { name, book_id, start_date, end_date } = req.body;
  if (!name || !book_id) {
    sendError(res, 'name and book_id are required');
    return;
  }
  const inviteCode = crypto.randomBytes(6).toString('hex');
  try {
    const club = await insertOne<ClubRow>('clubs', {
      name,
      book_id,
      host_id: me,
      invite_code: inviteCode,
      start_date: start_date || new Date().toISOString(),
      end_date: end_date || null,
    });
    await insertOne('club_members', { club_id: club.id, user_id: me });
    sendSuccess(res, club, 201);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Insert failed', 500);
  }
});

clubsRouter.get('/api/v1/clubs/invite/:inviteCode', async (req: Request, res: Response) => {
  const { inviteCode } = req.params;
  try {
    const club = await selectOne<ClubRow>('SELECT * FROM clubs WHERE invite_code = $1', [inviteCode]);
    if (!club) {
      sendError(res, 'Club not found', 404);
      return;
    }
    const membersByClub = await hydrateClubMembers([club.id]);
    sendSuccess(res, { ...club, club_members: membersByClub.get(club.id) ?? [] });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});

clubsRouter.get('/api/v1/clubs/:id', requireAuth, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const me = req.userId!;
  try {
    const club = await selectOne<ClubRow>('SELECT * FROM clubs WHERE id = $1', [id]);
    if (!club) {
      sendError(res, 'Club not found', 404);
      return;
    }
    const ownMembership = await selectOne(
      'SELECT id FROM club_members WHERE club_id = $1 AND user_id = $2',
      [id, me]
    );
    if (!ownMembership) {
      sendError(res, 'Not a member of this club', 403);
      return;
    }
    const memberRows = await selectMany<MemberRow>(
      'SELECT id, user_id, role, joined_at FROM club_members WHERE club_id = $1',
      [id]
    );
    const userIds = memberRows.map((m) => m.user_id);
    const profilesById = new Map<string, PublicProfileRow>();
    if (userIds.length > 0) {
      const profiles = await selectMany<PublicProfileRow>(
        'SELECT user_id, handle, display_name, avatar_url FROM user_profiles WHERE user_id = ANY($1)',
        [userIds]
      );
      for (const p of profiles) profilesById.set(p.user_id, p);
    }
    const members = memberRows.map((m) => ({
      id: m.id,
      user_id: m.user_id,
      role: m.role,
      joined_at: m.joined_at,
      profile: profilesById.get(m.user_id) ?? null,
    }));
    sendSuccess(res, { club, members });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Query failed', 500);
  }
});

clubsRouter.delete('/api/v1/clubs/:id', requireAuth, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const me = req.userId!;
  try {
    const club = await selectOne<{ host_id: string }>('SELECT host_id FROM clubs WHERE id = $1', [id]);
    if (!club) {
      sendError(res, 'Club not found', 404);
      return;
    }
    if (club.host_id !== me) {
      sendError(res, 'Only the host can delete this club', 403);
      return;
    }
    await deleteWhere('clubs', { id });
    sendSuccess(res, { id });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Delete failed', 500);
  }
});

clubsRouter.post('/api/v1/clubs/:id/leave', requireAuth, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const me = req.userId!;
  try {
    const club = await selectOne<{ host_id: string }>('SELECT host_id FROM clubs WHERE id = $1', [id]);
    if (!club) {
      sendError(res, 'Club not found', 404);
      return;
    }
    if (club.host_id === me) {
      sendError(res, "Hosts can't leave their own club — delete it instead", 400);
      return;
    }
    const count = await deleteWhere('club_members', { club_id: id, user_id: me });
    if (count === 0) {
      sendError(res, 'Not a member of this club', 404);
      return;
    }
    sendSuccess(res, { id });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Delete failed', 500);
  }
});

clubsRouter.post('/api/v1/clubs/:id/join', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  const me = req.userId!;
  try {
    const club = await selectOne<{ id: string }>('SELECT id FROM clubs WHERE id = $1', [id]);
    if (!club) {
      sendError(res, 'Club not found', 404);
      return;
    }
    const existing = await selectOne(
      'SELECT id FROM club_members WHERE club_id = $1 AND user_id = $2',
      [id, me]
    );
    if (existing) {
      sendError(res, 'Already a member of this club');
      return;
    }
    const data = await insertOne('club_members', { club_id: id, user_id: me });
    sendSuccess(res, data, 201);
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Insert failed', 500);
  }
});
