import { Router, Request, Response } from 'express';
import { hubClient, hubConfigured } from '../services/hub';

/**
 * Public landing for library invites: GET /join/:token
 * Opens in Safari when someone taps the share link before installing.
 * Deep-links into the app via tome://join/{token} + App Store / Play links.
 */
export const joinRouter = Router();

const APP_STORE =
  'https://apps.apple.com/us/app/tome-read-together/id6762325275';
const PLAY_STORE =
  'https://play.google.com/store/apps/details?id=com.gettome.tome';

joinRouter.get('/join/:token', async (req: Request, res: Response) => {
  const token = String(req.params.token || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  if (!token || !hubConfigured()) {
    res.status(404).type('html').send(renderPage({
      title: 'Invite not found',
      lede: 'This library invite link is missing or the server is not configured.',
      token: null,
    }));
    return;
  }

  let hostName = 'Someone';
  let collectionLabel = 'their library';
  try {
    const hub = hubClient();
    const { data, error } = await hub.rpc('preview_library_invite', {
      p_token: token,
    });
    if (error || !data) {
      res.status(404).type('html').send(renderPage({
        title: 'Invite expired',
        lede: 'Ask your host for a fresh Share my library link.',
        token: null,
      }));
      return;
    }
    const preview = data as {
      owner?: { display_name?: string; handle?: string };
      collections?: Array<{ name: string }>;
    };
    hostName =
      preview.owner?.display_name?.trim() ||
      (preview.owner?.handle ? `@${preview.owner.handle}` : 'Someone');
    const cols = preview.collections ?? [];
    if (cols.length === 1) collectionLabel = cols[0].name;
    else if (cols.length > 1) collectionLabel = `${cols.length} collections`;
  } catch {
    res.status(404).type('html').send(renderPage({
      title: 'Invite not found',
      lede: 'Could not load this invite. Try again later.',
      token: null,
    }));
    return;
  }

  res.type('html').send(renderPage({
    title: `${hostName} shared their library`,
    lede: `Browse and listen to ${collectionLabel} for free in Tome — like a private Audible for your household.`,
    token,
    hostName,
  }));
});

function renderPage(opts: {
  title: string;
  lede: string;
  token: string | null;
  hostName?: string;
}): string {
  const deep = opts.token ? `tome://join/${opts.token}` : null;
  const openBtn = deep
    ? `<a class="primary" href="${deep}">Open in Tome</a>
       <p class="hint">Don’t have the app yet?</p>
       <div class="row">
         <a class="secondary" href="${APP_STORE}">App Store</a>
         <a class="secondary" href="${PLAY_STORE}">Google Play</a>
       </div>
       <p class="code">Or paste code <code>${opts.token}</code> in Tome → Join a library</p>`
    : `<div class="row">
         <a class="secondary" href="${APP_STORE}">App Store</a>
         <a class="secondary" href="${PLAY_STORE}">Google Play</a>
       </div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(opts.title)} — Tome</title>
  <meta name="description" content="${escapeHtml(opts.lede)}" />
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: Georgia, "Times New Roman", serif;
      max-width: 440px; margin: 8vh auto 4vh; padding: 0 24px;
      background: #122040; color: #f5f1e8; line-height: 1.45;
    }
    .brand { font-size: 0.85rem; letter-spacing: 0.28em; text-transform: uppercase;
      color: #c4b8a0; margin-bottom: 18px; font-family: system-ui, sans-serif; }
    h1 { font-size: 1.85rem; font-weight: 700; margin: 0 0 12px; }
    p.lede { color: #d8d0c0; margin: 0 0 28px; font-family: system-ui, sans-serif; font-size: 1rem; }
    a.primary {
      display: block; text-align: center; background: #e8a87c; color: #122040;
      text-decoration: none; font-family: system-ui, sans-serif; font-weight: 700;
      padding: 14px 18px; border-radius: 12px; margin-bottom: 18px;
    }
    a.secondary {
      flex: 1; text-align: center; border: 1px solid #3a4a6a; color: #f5f1e8;
      text-decoration: none; font-family: system-ui, sans-serif; font-weight: 600;
      padding: 12px; border-radius: 10px; font-size: 0.9rem;
    }
    .row { display: flex; gap: 10px; margin-bottom: 18px; }
    .hint, .code { font-family: system-ui, sans-serif; color: #a8a090; font-size: 0.85rem; text-align: center; }
    code { background: rgba(255,255,255,0.08); padding: 2px 8px; border-radius: 6px; letter-spacing: 0.08em; }
  </style>
</head>
<body>
  <div class="brand">Tome</div>
  <h1>${escapeHtml(opts.title)}</h1>
  <p class="lede">${escapeHtml(opts.lede)}</p>
  ${openBtn}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
