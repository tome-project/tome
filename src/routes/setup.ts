import { Router, Request, Response } from 'express';
import { hubConfigured } from '../services/hub';
import { isPaired, loadIdentity } from '../services/server-identity';

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
      color: #1c1c1e; background: #faf7f1;
    }
    @media (prefers-color-scheme: dark) {
      body { color: #f4f1ea; background: #1a1a1d; }
      .card { background: #232326; border-color: #34343a; }
      input { background: #1a1a1d; color: #f4f1ea; border-color: #444; }
      .footnote { color: #999; }
    }
    h1 { font-size: 1.6rem; font-weight: 700; margin-bottom: 4px; letter-spacing: -0.01em; }
    h1 .brand { color: #c64a23; }
    p.lede { color: #6b6b70; margin-top: 0; }
    .card { border: 1px solid #e5e2db; border-radius: 14px; padding: 22px 22px 18px;
      background: #fff; margin-top: 24px; }
    label { display: block; font-weight: 600; font-size: 0.9rem; margin-bottom: 6px; }
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

function pairedPage(): string {
  const id = loadIdentity()!;
  return renderShell('Paired ✓', `
  <p class="lede"><span class="ok">Paired.</span> This server is connected
    to a Tome hub account.</p>
  <div class="card">
    <p><strong>Library name:</strong> ${escapeHtml(id.serverName)}</p>
    <p><strong>Owner:</strong> <code>${id.ownerId}</code></p>
    <p><strong>Paired at:</strong> ${new Date(id.pairedAt).toLocaleString()}</p>
    <p><strong>Server ID:</strong> <code>${id.serverId}</code></p>
  </div>
  <p class="footnote">To re-pair (e.g. you switched Tome accounts), delete
    <code>$LIBRARY_PATH/.tome-server.json</code> and restart this server.</p>`);
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

setupRouter.get(['/', '/setup'], (_req: Request, res: Response) => {
  res.type('html');
  if (!hubConfigured()) {
    res.send(envMissingPage());
    return;
  }
  if (isPaired()) {
    res.send(pairedPage());
    return;
  }
  res.send(pairFormPage());
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
    res.send(pairedPage());
  } catch (err) {
    res.status(500).send(errorPage(err instanceof Error ? err.message : 'Pairing failed'));
  }
});
