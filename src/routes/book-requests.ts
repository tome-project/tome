import { Router, Request, Response } from 'express';
import { requireSupabaseAuth } from '../middleware/supabase-auth';
import { hubClient, hubConfigured } from '../services/hub';
import { loadIdentity } from '../services/server-identity';
import { reconcilePendingRequests } from '../services/auto-fulfill';
import { sendSuccess, sendError } from '../utils';

/**
 * Agent- and owner-facing request queue for *this* library server.
 *
 * The Flutter app talks to Supabase directly for create/list/fulfill.
 * These routes exist so a CLI agent on the host (or any tool with a
 * Supabase user JWT for the owner/service user) can:
 *
 *   GET  /api/v1/requests/pending  → work queue with search hints
 *   POST /api/v1/requests/:id/decline
 *   POST /api/v1/requests/:id/fulfill  (manual; scan auto-fulfills too)
 *
 * Auth: Bearer Supabase JWT. Caller must be the server owner OR this
 * server's service_user_id. Unpaired servers return 503.
 */
export const bookRequestsRouter = Router();

async function assertServerActor(userId: string): Promise<
  | { ok: true; serverId: string }
  | { ok: false; status: number; error: string }
> {
  if (!hubConfigured()) {
    return { ok: false, status: 503, error: 'Library server is not paired' };
  }
  const identity = loadIdentity();
  if (!identity) {
    return { ok: false, status: 503, error: 'Library server has no identity' };
  }
  // Fast path: owner JWT from the app / agent.
  if (userId === identity.ownerId) {
    return { ok: true, serverId: identity.serverId };
  }
  // Service-user JWT: library_servers.service_user_id (migration 007).
  try {
    const hub = hubClient();
    const { data } = await hub
      .from('library_servers')
      .select('owner_id, service_user_id')
      .eq('id', identity.serverId)
      .maybeSingle();
    if (
      data &&
      (data.owner_id === userId || data.service_user_id === userId)
    ) {
      return { ok: true, serverId: identity.serverId };
    }
  } catch (err) {
    console.error('[book-requests] actor check failed:', err);
  }
  return {
    ok: false,
    status: 403,
    error: 'Only the library owner or service user can manage this queue',
  };
}

function searchHints(row: {
  title: string;
  authors: string[] | null;
  series_name: string | null;
  isbn_13: string | null;
}): string[] {
  const authors = row.authors ?? [];
  const primary = authors[0] ?? '';
  const hints = new Set<string>();
  hints.add(row.title);
  if (primary) {
    hints.add(`${row.title} ${primary}`);
    hints.add(`${primary} ${row.title}`);
  }
  hints.add(`${row.title} audiobook`);
  hints.add(`${row.title} unabridged`);
  if (row.series_name) {
    hints.add(row.series_name);
    if (primary) hints.add(`${row.series_name} ${primary}`);
  }
  if (row.isbn_13) hints.add(row.isbn_13);
  return [...hints];
}

bookRequestsRouter.get(
  '/api/v1/requests/pending',
  requireSupabaseAuth,
  async (req: Request, res: Response) => {
    const gate = await assertServerActor(req.supabaseUserId!);
    if (!gate.ok) {
      sendError(res, gate.error, gate.status);
      return;
    }

    try {
      // Opportunistic match against books already on disk before we report
      // the queue. This is what makes "request a book we already have"
      // feel automatic without waiting for a full scan.
      try {
        await reconcilePendingRequests(gate.serverId);
      } catch (err) {
        console.error('[book-requests] reconcile-on-list failed:', err);
      }

      const hub = hubClient();
      const { data, error } = await hub
        .from('book_requests')
        .select(
          'id, title, authors, isbn_13, open_library_id, google_books_id, cover_url, series_name, series_position, reason, note, requester_id, created_at, source_book_id',
        )
        .eq('server_id', gate.serverId)
        .eq('status', 'pending')
        .order('created_at', { ascending: true });

      if (error) {
        sendError(res, error.message, 500);
        return;
      }

      const rows = data ?? [];
      const requesterIds = [
        ...new Set(rows.map((r) => r.requester_id as string)),
      ];
      const profileById = new Map<string, { handle: string; display_name: string }>();
      if (requesterIds.length > 0) {
        const { data: profiles } = await hub
          .from('user_profiles')
          .select('user_id, handle, display_name')
          .in('user_id', requesterIds);
        for (const p of profiles ?? []) {
          profileById.set(p.user_id as string, {
            handle: p.handle as string,
            display_name: p.display_name as string,
          });
        }
      }

      const requests = rows.map((r) => {
        const profile = profileById.get(r.requester_id as string);
        return {
          id: r.id,
          title: r.title,
          authors: r.authors ?? [],
          isbn_13: r.isbn_13,
          open_library_id: r.open_library_id,
          google_books_id: r.google_books_id,
          cover_url: r.cover_url,
          series_name: r.series_name,
          series_position: r.series_position,
          reason: r.reason,
          note: r.note,
          requester_id: r.requester_id,
          requester_handle: profile?.handle ?? null,
          requester_display_name: profile?.display_name ?? null,
          created_at: r.created_at,
          source_book_id: r.source_book_id,
          search_hints: searchHints({
            title: r.title as string,
            authors: (r.authors as string[] | null) ?? null,
            series_name: (r.series_name as string | null) ?? null,
            isbn_13: (r.isbn_13 as string | null) ?? null,
          }),
          // Suggested relative drop path under LIBRARY_PATH for agents.
          suggested_path: suggestedDropPath(
            r.title as string,
            ((r.authors as string[] | null) ?? [])[0] ?? null,
          ),
        };
      });

      sendSuccess(res, {
        server_id: gate.serverId,
        count: requests.length,
        requests,
        instructions: [
          '1. Pick a pending request (oldest first).',
          '2. Try each search_hint until you find a legal source the household owns or may acquire.',
          '3. Drop the audiobook/ebook under LIBRARY_PATH (prefer Author/Title/ layout).',
          '4. POST /scan (or wait for boot scan) — matching requests auto-fulfill by ISBN / OL id / title+author.',
          '5. If you cannot find it, POST /api/v1/requests/:id/decline with an optional note.',
        ],
      });
    } catch (err) {
      sendError(
        res,
        err instanceof Error ? err.message : 'Failed to list requests',
        500,
      );
    }
  },
);

/// Match every pending request against books already on this library
/// server. Safe to call often — no-ops when the queue is empty.
bookRequestsRouter.post(
  '/api/v1/requests/reconcile',
  requireSupabaseAuth,
  async (req: Request, res: Response) => {
    const gate = await assertServerActor(req.supabaseUserId!);
    if (!gate.ok) {
      sendError(res, gate.error, gate.status);
      return;
    }
    try {
      const result = await reconcilePendingRequests(gate.serverId);
      sendSuccess(res, result);
    } catch (err) {
      sendError(
        res,
        err instanceof Error ? err.message : 'Reconcile failed',
        500,
      );
    }
  },
);

bookRequestsRouter.post(
  '/api/v1/requests/:id/fulfill',
  requireSupabaseAuth,
  async (req: Request, res: Response) => {
    const gate = await assertServerActor(req.supabaseUserId!);
    if (!gate.ok) {
      sendError(res, gate.error, gate.status);
      return;
    }
    const id = String(req.params.id);
    const fulfilledBookId =
      typeof req.body?.fulfilled_book_id === 'string'
        ? req.body.fulfilled_book_id
        : null;

    try {
      const hub = hubClient();
      const { data, error } = await hub
        .from('book_requests')
        .update({
          status: 'fulfilled',
          fulfilled_at: new Date().toISOString(),
          ...(fulfilledBookId ? { fulfilled_book_id: fulfilledBookId } : {}),
        })
        .eq('id', id)
        .eq('server_id', gate.serverId)
        .eq('status', 'pending')
        .select('id')
        .maybeSingle();

      if (error) {
        sendError(res, error.message, 500);
        return;
      }
      if (!data) {
        sendError(res, 'Pending request not found', 404);
        return;
      }
      sendSuccess(res, { id: data.id, status: 'fulfilled' });
    } catch (err) {
      sendError(
        res,
        err instanceof Error ? err.message : 'Failed to fulfill',
        500,
      );
    }
  },
);

bookRequestsRouter.post(
  '/api/v1/requests/:id/decline',
  requireSupabaseAuth,
  async (req: Request, res: Response) => {
    const gate = await assertServerActor(req.supabaseUserId!);
    if (!gate.ok) {
      sendError(res, gate.error, gate.status);
      return;
    }
    const id = String(req.params.id);
    const note =
      typeof req.body?.note === 'string' && req.body.note.trim()
        ? req.body.note.trim().slice(0, 500)
        : null;

    try {
      const hub = hubClient();
      // Append decline reason into note if provided (schema has no decline_reason).
      const { data: existing } = await hub
        .from('book_requests')
        .select('id, note')
        .eq('id', id)
        .eq('server_id', gate.serverId)
        .eq('status', 'pending')
        .maybeSingle();

      if (!existing) {
        sendError(res, 'Pending request not found', 404);
        return;
      }

      const mergedNote = note
        ? [existing.note, `[declined] ${note}`].filter(Boolean).join('\n')
        : existing.note;

      const { error } = await hub
        .from('book_requests')
        .update({
          status: 'declined',
          declined_at: new Date().toISOString(),
          note: mergedNote,
        })
        .eq('id', id);

      if (error) {
        sendError(res, error.message, 500);
        return;
      }
      sendSuccess(res, { id, status: 'declined' });
    } catch (err) {
      sendError(
        res,
        err instanceof Error ? err.message : 'Failed to decline',
        500,
      );
    }
  },
);

/** Sanitize a folder segment for LIBRARY_PATH drops. */
function suggestedDropPath(title: string, author: string | null): string {
  const safe = (s: string) =>
    s
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'Unknown';
  const a = safe(author || 'Unknown Author');
  const t = safe(title);
  return `${a}/${t}/`;
}
