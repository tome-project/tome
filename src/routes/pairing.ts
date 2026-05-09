import { Router, Request, Response } from 'express';
import {
  hubClient,
  hubConfigured,
  isHubMode,
  hubBaseUrl,
  initHubClient,
  resetHubClient,
} from '../services/hub';
import {
  saveIdentity,
  isPaired,
  loadIdentity,
} from '../services/server-identity';
import { scanState, runScanForOwner } from '../services/scan-on-startup';
import { startHeartbeat } from '../services/heartbeat';
import { mintLibraryServer, makeHubClient, PairResult } from '../services/pairing-core';

export const pairingRouter = Router();

interface PairBody {
  code?: string;
  name?: string;
  publicUrl?: string;
}

/// Detect a sensible self-URL for the library_servers row, defaulting to
/// the same hostname:port the request came in on. Operator can override
/// via PUBLIC_URL env var (e.g. for behind-tunnel deployments) or via the
/// `publicUrl` field in the pair POST body.
function detectSelfUrl(req: Request): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol;
  const host = (req.headers['x-forwarded-host'] as string) ?? req.get('host');
  return `${proto}://${host}`;
}

/// POST /pair  body: { code, name?, publicUrl? }
///
/// The library server's local pairing entrypoint. The setup wizard's HTML
/// form posts here, and the JSON CLI flow posts here too. Two paths:
///
///   * **Hub mode** (this server has SUPABASE_SERVICE_ROLE_KEY): mint
///     locally via pairing-core, write the library_servers row directly.
///     Used for the prod deployment which is both hub and library server.
///
///   * **Self-host mode**: forward to ${HUB_URL}/api/v1/hub/pair and
///     persist the returned scoped Supabase creds. The library server
///     never holds a service-role key.
pairingRouter.post('/pair', async (req: Request, res: Response) => {
  if (isPaired()) {
    res.status(200).json({
      success: true,
      data: { paired: true, identity: loadIdentity() },
    });
    return;
  }

  const body = (req.body ?? {}) as PairBody;
  const code = (body.code ?? '').trim();
  if (!/^[0-9]{6}$/.test(code)) {
    res.status(400).json({ success: false, error: 'code must be 6 digits' });
    return;
  }

  // Friendlier default than os.hostname() — inside a Docker container that
  // returns the random container ID like "d4cc14759b7" which makes for an
  // ugly library name. The user can rename via the My Libraries → detail
  // screen later.
  const name = (body.name ?? '').trim() || 'My Tome Library';
  const url = (body.publicUrl ?? '').trim() || detectSelfUrl(req);

  try {
    let result: PairResult;
    if (isHubMode()) {
      // We are the hub — mint locally.
      if (!hubConfigured()) {
        res.status(503).json({
          success: false,
          error:
            'Hub is not configured (missing SUPABASE_SERVICE_ROLE_KEY). ' +
            'Either set the env var to run as hub, or set HUB_URL to use a remote hub.',
        });
        return;
      }
      result = await mintLibraryServer({
        hub: hubClient(),
        supabaseUrl: process.env.SUPABASE_URL!,
        code,
        name,
        url,
        platform: process.platform,
        version: process.env.npm_package_version || '0.7.0',
      });
    } else {
      // Self-host mode: ask the hub.
      const hubUrl = hubBaseUrl();
      const r = await fetch(`${hubUrl}/api/v1/hub/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          name,
          public_url: url,
          platform: process.platform,
          version: process.env.npm_package_version || '0.7.0',
        }),
      });
      const j = (await r.json()) as { success?: boolean; data?: PairResult; error?: string };
      if (!r.ok || !j.success || !j.data) {
        res
          .status(r.status || 500)
          .json({ success: false, error: j.error ?? 'Pairing failed at hub' });
        return;
      }
      result = j.data;
    }

    // Persist identity (including supabase creds in self-host mode).
    saveIdentity({
      serverId: result.server_id,
      ownerId: result.owner_id,
      serverName: result.server_name,
      pairedAt: new Date().toISOString(),
      supabaseUrl: result.supabase_url,
      supabaseEmail: result.supabase_email,
      supabasePassword: result.supabase_password,
    });

    // Re-init the hub client so subsequent calls use the freshly-paired
    // service user (no-op in hub mode since the service-role client is
    // already alive).
    resetHubClient();
    try {
      await initHubClient();
    } catch (err) {
      console.error('[pair] post-pair initHubClient failed', err);
    }

    // Kick off the heartbeat + first scan in the background so the
    // owner's library populates without them having to find a "Scan
    // now" button.
    startHeartbeat();
    void runScanForOwner().catch((err) => {
      console.error('[post-pair-scan]', err);
    });

    res.status(201).json({
      success: true,
      data: { paired: true, server_id: result.server_id, server_name: result.server_name, url: result.url },
    });
  } catch (err) {
    console.error('[pair] failed', err);
    let detail = 'Pairing failed';
    if (err instanceof Error) detail = err.message;
    else if (err && typeof err === 'object') {
      try { detail = JSON.stringify(err); } catch { /* */ }
    }
    let status = 500;
    if (detail.includes('No pairing')) status = 404;
    else if (detail.includes('already used')) status = 409;
    else if (detail.includes('expired')) status = 410;
    res.status(status).json({ success: false, error: detail });
  }
});

/// GET /pair/status — used by the wizard to poll for completion AND by
/// the app's library detail screen for live status: paired identity,
/// scan progress, last summary, hosted book count.
pairingRouter.get('/pair/status', async (_req: Request, res: Response) => {
  const identity = loadIdentity();
  let bookCount: number | null = null;
  if (identity) {
    try {
      const { count } = await hubClient()
        .from('library_server_books')
        .select('id', { count: 'exact', head: true })
        .eq('server_id', identity.serverId);
      bookCount = count ?? 0;
    } catch {
      // best-effort
    }
  }
  // Strip Supabase creds — they're stored on disk so the server can
  // sign in, but they should never leave this process.
  const safeIdentity = identity
    ? {
        serverId: identity.serverId,
        ownerId: identity.ownerId,
        serverName: identity.serverName,
        pairedAt: identity.pairedAt,
      }
    : null;
  res.json({
    success: true,
    data: {
      hub_configured: hubConfigured(),
      paired: isPaired(),
      identity: safeIdentity,
      book_count: bookCount,
      scan: scanState(),
    },
  });
});
