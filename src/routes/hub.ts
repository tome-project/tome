import { Router, Request, Response } from 'express';
import { mintLibraryServer, makeHubClient } from '../services/pairing-core';

/// Hub-mode routes — only mounted when IS_HUB=true. These are the
/// endpoints that remote library servers (other people running their
/// own Tome server) call into to bootstrap themselves.
///
/// The library server hits POST /api/v1/hub/pair with a 6-digit code +
/// its public URL. The hub mints a per-server Supabase auth user, binds
/// it to a fresh library_servers row, and returns the credentials. From
/// then on the remote server signs into Supabase as that user; RLS
/// policies on library_server_books / library_collections / library_servers
/// keep its writes scoped to its own rows.
export const hubRouter = Router();

interface HubPairBody {
  code?: string;
  name?: string;
  public_url?: string;
  platform?: string;
  version?: string;
}

hubRouter.post('/api/v1/hub/pair', async (req: Request, res: Response) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    res.status(503).json({
      success: false,
      error: 'Hub is misconfigured (missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY).',
    });
    return;
  }

  const body = (req.body ?? {}) as HubPairBody;
  const code = (body.code ?? '').trim();
  if (!/^[0-9]{6}$/.test(code)) {
    res.status(400).json({ success: false, error: 'code must be 6 digits' });
    return;
  }

  const name = (body.name ?? '').trim() || 'My Tome Library';
  const url = (body.public_url ?? '').trim();
  if (!url) {
    res.status(400).json({
      success: false,
      error: 'public_url is required — the URL the app will hit to reach your server',
    });
    return;
  }

  try {
    const hub = makeHubClient(supabaseUrl, serviceRoleKey);
    const result = await mintLibraryServer({
      hub,
      supabaseUrl,
      code,
      name,
      url,
      platform: body.platform,
      version: body.version,
    });
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    console.error('[hub /pair] failed', err);
    let detail = 'Pairing failed';
    if (err instanceof Error) detail = err.message;
    let status = 500;
    if (detail.includes('No pairing')) status = 404;
    else if (detail.includes('already used')) status = 409;
    else if (detail.includes('expired')) status = 410;
    res.status(status).json({ success: false, error: detail });
  }
});

/// Health/handshake — lets a self-hosted server confirm its hub URL is
/// reachable + IS_HUB=true before it tries to pair.
hubRouter.get('/api/v1/hub/health', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      hub: true,
      supabase_configured: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    },
  });
});
