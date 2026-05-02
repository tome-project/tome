import fs from 'fs';
import path from 'path';
import { Router, Request, Response } from 'express';
import { hubClient, hubConfigured } from '../services/hub';
import { isPaired, loadIdentity } from '../services/server-identity';
import { scanState, runScanForOwner } from '../services/scan-on-startup';

export const setupRouter = Router();

/// Tiny vanilla-HTML setup wizard at `/` and `/setup`. Three states:
///   1. Hub not configured (env missing) → instructions to set env + restart.
///   2. Paired → status page (server name, owner, paired-at).
///   3. Otherwise → pair-code form. POSTs to /pair.
function renderShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — Tome library server</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      max-width: 520px; margin: 6vh auto 4vh; padding: 0 24px; line-height: 1.5;
      color: #1a1a1d; background: #faf7f1;
    }
    @media (prefers-color-scheme: dark) {
      body { color: #f4f1ea; background: #1a1a1d; }
      .card { background: #232326; border-color: #34343a; }
      input { background: #1a1a1d; color: #f4f1ea; border-color: #444; }
      label { color: #f4f1ea; }
      p.lede, .footnote { color: #c8c8cc; }
    }
    h1 { font-size: 1.6rem; font-weight: 700; margin-bottom: 4px; letter-spacing: -0.01em; color: #1a1a1d; }
    h1 .brand { color: #c64a23; }
    p.lede { color: #3a3a3f; margin-top: 0; }
    .card { border: 1px solid #d8d4cb; border-radius: 14px; padding: 22px 22px 18px;
      background: #fff; margin-top: 24px; color: #1a1a1d; }
    label { display: block; font-weight: 600; font-size: 0.9rem; margin-bottom: 6px; color: #1a1a1d; }
    input[type="text"] {
      width: 100%; padding: 10px 12px; font-size: 1rem; border: 1px solid #d4cfc6;
      border-radius: 8px; box-sizing: border-box;
    }
    input[type="text"].code {
      font-size: 1.6rem; letter-spacing: 0.5em; text-align: center; font-variant-numeric: tabular-nums;
    }
    button {
      background: #c64a23; color: #fff; border: 0; border-radius: 8px;
      padding: 12px 18px; font-size: 1rem; font-weight: 600; cursor: pointer;
      width: 100%; margin-top: 14px;
    }
    button:hover { background: #b04020; }
    .row + .row { margin-top: 14px; }
    .footnote { color: #6b6b70; font-size: 0.85rem; margin-top: 18px; }
    .ok { color: #058a40; font-weight: 600; }
    code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.9em;
      background: rgba(120,120,120,0.12); padding: 2px 6px; border-radius: 4px; }
    pre { background: #f0ece4; padding: 14px; border-radius: 8px; overflow-x: auto; }
    @media (prefers-color-scheme: dark) { pre { background: #2a2a2e; } }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    button.danger, .card.danger button { background: #b32626; }
    button.danger:hover, .card.danger button:hover { background: #931d1d; }
    .card.danger { border-color: rgba(179, 38, 38, 0.35); }
    .rowline { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; margin: 0 0 8px; }
    .dim { color: #8b8b90; font-weight: 400; }
    .pulse { animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
    summary { cursor: pointer; padding: 4px 0; }
    details[open] summary { margin-bottom: 8px; }
  </style>
</head>
<body>
  <h1><span class="brand">Tome</span> library server</h1>
  ${body}
</body>
</html>`;
}

function envMissingPage(): string {
  return renderShell('Setup needed', `
  <p class="lede">This server isn't connected to a Tome hub yet. Set two
    environment variables and restart:</p>
  <div class="card">
    <pre>SUPABASE_URL=https://&lt;your-project&gt;.supabase.co
SUPABASE_SERVICE_ROLE_KEY=&lt;your service role key&gt;
LIBRARY_PATH=/path/to/your/books</pre>
    <p class="footnote">In docker-compose, add these to the <code>environment:</code> block.
      The service role key is at Supabase project → Settings → API. It's
      powerful — keep it on this server only.</p>
  </div>`);
}

function pairFormPage(): string {
  return renderShell('Pair this server', `
  <p class="lede">Generate a 6-digit code in the Tome app under
    <code>Settings → Connect a library server</code>, then paste it here
    to bind this server to your account.</p>
  <form class="card" method="POST" action="/setup" autocomplete="off">
    <div class="row">
      <label for="name">Library name</label>
      <input type="text" id="name" name="name" placeholder="e.g. Basement NAS" />
    </div>
    <div class="row">
      <label for="code">6-digit code from the app</label>
      <input type="text" id="code" name="code" class="code" maxlength="6" inputmode="numeric"
             pattern="[0-9]{6}" required autofocus />
    </div>
    <button type="submit">Pair this server</button>
    <p class="footnote">Codes expire 5 minutes after they're generated.</p>
  </form>
  <p class="footnote">Prefer the CLI? <code>curl -X POST http://localhost:3000/pair -d 'code=123456&amp;name=Basement+NAS'</code></p>`);
}

async function pairedPage(): Promise<string> {
  const id = loadIdentity()!;
  let bookCount: number | string = '—';
  try {
    const { count } = await hubClient()
      .from('library_server_books')
      .select('id', { count: 'exact', head: true })
      .eq('server_id', id.serverId);
    bookCount = count ?? 0;
  } catch {
    // best-effort
  }
  const scan = scanState();
  const scanLine = scan.inProgress
    ? `<span class="pulse">Scanning your library now…</span>`
    : (scan.lastSummary
        ? `Last scan ${new Date(scan.completedAt!).toLocaleString()} — `
          + `<strong>${scan.lastSummary.found}</strong> found, `
          + `<strong>${scan.lastSummary.added}</strong> added, `
          + `<strong>${scan.lastSummary.updated}</strong> updated, `
          + `<strong>${scan.lastSummary.pruned}</strong> removed`
        : 'Not scanned yet.');
  const libPath = process.env.LIBRARY_PATH || './library';

  return renderShell('Paired ✓', `
  <p class="lede"><span class="ok">Paired.</span> This server is online and
    connected to your Tome account.</p>
  <div class="card">
    <p class="rowline"><strong>${escapeHtml(id.serverName)}</strong>
       <span class="dim">·</span> <span class="dim">${bookCount} book${bookCount === 1 ? '' : 's'}</span></p>
    <p class="footnote">${scanLine}</p>
  </div>
  <form class="card" method="POST" action="/setup/scan">
    <p><strong>Scan now</strong></p>
    <p class="footnote">Walks <code>${escapeHtml(libPath)}</code> for new
      or removed books and reconciles your library on the hub. Safe to
      run anytime; idempotent.</p>
    <button type="submit" ${scan.inProgress ? 'disabled' : ''}>
      ${scan.inProgress ? 'Scan in progress…' : 'Scan library now'}
    </button>
  </form>
  <details class="card">
    <summary><strong>Server details</strong></summary>
    <p class="footnote"><strong>Owner user_id:</strong> <code>${id.ownerId}</code></p>
    <p class="footnote"><strong>Server id:</strong> <code>${id.serverId}</code></p>
    <p class="footnote"><strong>Paired at:</strong> ${new Date(id.pairedAt).toLocaleString()}</p>
  </details>
  <form class="card danger" method="POST" action="/setup/reset"
        onsubmit="return confirm('Unpair this server? You\\'ll need a new code from the app to re-pair.');">
    <p><strong>Re-pair this server</strong></p>
    <p class="footnote">Disconnects from the current account so you can pair
      it to a different one. Books on disk stay; the catalog rows in the
      hub get orphaned (cleaned up on next scan from a new owner).</p>
    <button type="submit" class="danger">Reset pairing</button>
  </form>`);
}

function errorPage(message: string): string {
  return renderShell('Pairing failed', `
  <p class="lede">Couldn't pair this server.</p>
  <div class="card"><p>${escapeHtml(message)}</p></div>
  <p class="footnote"><a href="/setup">← Try again</a></p>`);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]!);
}

setupRouter.get(['/', '/setup'], async (_req: Request, res: Response) => {
  res.type('html');
  if (!hubConfigured()) {
    res.send(envMissingPage());
    return;
  }
  if (isPaired()) {
    res.send(await pairedPage());
    return;
  }
  res.send(pairFormPage());
});

/// POST /setup/scan — kicks off a manual scan from the wizard. Returns
/// to /setup so the user can see live status updates.
setupRouter.post('/setup/scan', async (_req: Request, res: Response) => {
  res.type('html');
  if (!isPaired()) {
    res.redirect(303, '/setup');
    return;
  }
  // Fire-and-forget; the wizard polls /setup for state.
  void runScanForOwner().catch((err) => console.error('[wizard-scan]', err));
  res.redirect(303, '/setup');
});

/// POST /setup/reset — unpair this server. Deletes .tome-server.json
/// so the next /setup hit shows the pair-code form. The library_servers
/// row in the hub stays; the owner can clean it up from the app's My
/// Libraries screen.
setupRouter.post('/setup/reset', async (_req: Request, res: Response) => {
  res.type('html');
  const libraryPath = process.env.LIBRARY_PATH || './library';
  try {
    fs.unlinkSync(path.join(libraryPath, '.tome-server.json'));
  } catch {
    // already gone
  }
  // Identity cache is module-level; we'd need to restart for it to
  // re-read. Tell the operator.
  res.send(renderShell('Pairing reset', `
  <p class="lede">Pairing reset. <strong>Restart the server</strong>
    (e.g. <code>docker compose restart server</code>) for the change
    to take effect, then refresh this page to pair to a new account.</p>
  <p class="footnote">Pre-existing books on disk stay; the heartbeat
    + auto-scan stop firing for the old account.</p>`));
});

/// Web wizard form submit. Delegates to the same logic as the JSON /pair
/// endpoint — just renders HTML instead of returning JSON.
setupRouter.post('/setup', async (req: Request, res: Response) => {
  res.type('html');
  const code = (req.body?.code ?? '').toString().trim();
  const name = (req.body?.name ?? '').toString().trim();
  if (!/^[0-9]{6}$/.test(code)) {
    res.status(400).send(errorPage('Code must be 6 digits.'));
    return;
  }

  // Forward to the JSON pairing route by re-using its logic. Since both
  // are mounted on the same app, hit it via internal fetch — or simpler,
  // just call the helper directly. For now, post to ourselves.
  try {
    const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol;
    const host = (req.headers['x-forwarded-host'] as string) ?? req.get('host');
    const r = await fetch(`${proto}://${host}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name }),
    });
    const j = await r.json();
    if (!r.ok || !(j as { success?: boolean }).success) {
      res.status(r.status).send(errorPage(
        (j as { error?: string }).error ?? 'Pairing failed',
      ));
      return;
    }
    res.send(await pairedPage());
  } catch (err) {
    res.status(500).send(errorPage(err instanceof Error ? err.message : 'Pairing failed'));
  }
});
