import { Router } from 'express';

export const legalRouter = Router();

const layout = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Tome</title>
<style>
  :root {
    color-scheme: light dark;
    --fg: #1a1410;
    --muted: #6b5d52;
    --accent: #8a5a3b;
    --bg: #faf6f1;
    --rule: #e8ddd0;
  }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#f3ebe1; --muted:#a89c8e; --accent:#d49a6a; --bg:#1a1410; --rule:#2e251c; }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", sans-serif;
    line-height: 1.6;
  }
  main { max-width: 720px; margin: 0 auto; padding: 48px 24px 96px; }
  h1 {
    font-family: "Iowan Old Style", "Palatino", Georgia, serif;
    font-size: 36px; font-weight: 700; line-height: 1.2; margin: 0 0 8px;
  }
  h2 {
    font-family: "Iowan Old Style", "Palatino", Georgia, serif;
    font-size: 22px; font-weight: 700; margin: 36px 0 8px;
  }
  .meta { color: var(--muted); font-size: 14px; margin-bottom: 32px; }
  .meta a { color: var(--accent); text-decoration: none; }
  .meta a:hover { text-decoration: underline; }
  hr { border: 0; border-top: 1px solid var(--rule); margin: 24px 0; }
  ul { padding-left: 22px; }
  li { margin-bottom: 6px; }
  a { color: var(--accent); }
  code { background: var(--rule); padding: 1px 5px; border-radius: 4px; font-size: 0.92em; }
  .crumb {
    color: var(--muted); font-size: 13px; letter-spacing: 0.04em;
    text-transform: uppercase; margin-bottom: 24px;
  }
  .crumb a { color: var(--muted); text-decoration: none; }
  .crumb a:hover { color: var(--fg); }
</style>
</head>
<body>
<main>
<div class="crumb"><a href="/legal/privacy">Privacy</a> · <a href="/legal/terms">Terms</a></div>
${body}
</main>
</body>
</html>`;

const PRIVACY_BODY = `
<h1>Privacy Policy</h1>
<p class="meta">Last updated: May 4, 2026 · <a href="mailto:privacy@tome.arroyoautomation.com">privacy@tome.arroyoautomation.com</a></p>

<p>Tome (<em>“the app”</em>) is a self-hosted reading platform for ebooks and audiobooks with optional book-club features. This policy explains what data the app collects, why, and what you can do about it.</p>

<h2>Who we are</h2>
<p>Tome is operated by Chris Arroyo (<em>“we”</em>, <em>“us”</em>) for personal and small-group use. The mobile app is published under the bundle identifiers <code>app.tome.readtogether</code> (iOS) and <code>com.gettome.tome</code> (Android).</p>

<h2>What we collect</h2>
<ul>
  <li><strong>Account data:</strong> email address, display name, handle, and an avatar URL you provide. Stored in our hosted Supabase Postgres database.</li>
  <li><strong>Reading data:</strong> books on your shelves, reading progress (position, percentage, timestamps), reading sessions, highlights, notes, and audio bookmarks. Stored in Supabase, scoped to your account by row-level security.</li>
  <li><strong>Social data:</strong> friendships you accept, library shares you grant or receive, book club memberships, and discussion posts you author. Stored in Supabase.</li>
  <li><strong>Privacy preferences:</strong> the visibility settings you set for your library, activity, reviews, highlights, and notes.</li>
  <li><strong>Library files:</strong> ebooks and audiobooks you add to your library are stored on the library server you operate or that someone has shared with you. They are <em>never</em> uploaded to our infrastructure.</li>
  <li><strong>Cover art:</strong> when a book is added without local cover art, the library server you’re paired with may fetch a cover from public sources (Open Library, Google Books) and cache it on its own disk.</li>
  <li><strong>Diagnostic data:</strong> standard server logs (IP address, request path, timestamp) retained for up to 30 days for abuse prevention and debugging.</li>
</ul>

<h2>What we don’t collect</h2>
<ul>
  <li>We do not run third-party analytics or advertising SDKs.</li>
  <li>We do not collect device identifiers (IDFA, AAID) for tracking.</li>
  <li>We do not sell or rent your data.</li>
  <li>We do not transmit the contents of your books or your reading positions to any party other than our own database.</li>
</ul>

<h2>How your data moves</h2>
<p>The Tome client talks to two kinds of servers:</p>
<ul>
  <li><strong>Supabase</strong> (Postgres + Auth) for account, social, and reading-progress data. Hosted in the United States.</li>
  <li><strong>Library servers</strong> for streaming book files. Each library server is an independent self-hosted instance — your own homelab, or a friend’s — and is operated by the person who set it up. We do not control friends’ library servers.</li>
</ul>

<h2>Sharing</h2>
<p>By design, you control what other Tome users see about you through the Privacy settings inside the app (Library, Activity, Reviews, Highlights, Notes). Friendships, library shares, and book-club memberships are explicit actions you take. We do not share your data with advertisers, data brokers, or other apps.</p>

<h2>Your rights</h2>
<ul>
  <li><strong>Access &amp; correction:</strong> you can edit your profile, handle, avatar, and privacy settings inside the app at any time.</li>
  <li><strong>Deletion:</strong> from <em>Profile → Settings → Delete account</em> you can permanently delete your account and all of its associated data. Deletion is immediate and irreversible.</li>
  <li><strong>Export:</strong> email <a href="mailto:privacy@tome.arroyoautomation.com">privacy@tome.arroyoautomation.com</a> and we’ll send you a JSON export of your account data within 30 days.</li>
</ul>

<h2>Children</h2>
<p>Tome is not directed to children under 13 (or under 16 in the EU/UK). If you believe a child has created an account, contact us and we will delete it.</p>

<h2>Security</h2>
<p>Account passwords are managed by Supabase Auth and stored as bcrypt hashes. Authenticated requests use short-lived JWTs over TLS. Library files served by other users’ library servers are protected by per-collection access grants enforced server-side.</p>

<h2>Changes</h2>
<p>If we make material changes to this policy we’ll update the <em>Last updated</em> date at the top and, where appropriate, notify you in the app. Continuing to use Tome after a change means you accept the revised policy.</p>

<h2>Contact</h2>
<p>Questions? Email <a href="mailto:privacy@tome.arroyoautomation.com">privacy@tome.arroyoautomation.com</a>.</p>
`;

const TERMS_BODY = `
<h1>Terms of Service</h1>
<p class="meta">Last updated: May 4, 2026 · <a href="mailto:legal@tome.arroyoautomation.com">legal@tome.arroyoautomation.com</a></p>

<p>These Terms govern your use of the Tome mobile application and related services (<em>“Tome”</em>, <em>“the Service”</em>). By creating an account, signing in, or otherwise using the Service, you agree to these Terms. If you don’t agree, don’t use the Service.</p>

<h2>1. Eligibility</h2>
<p>You must be at least 13 years old (16 in the EU/UK) to use Tome. By creating an account, you represent that you meet this age requirement.</p>

<h2>2. Your account</h2>
<p>You’re responsible for keeping your password confidential and for all activity under your account. Notify us promptly if you suspect unauthorized access.</p>

<h2>3. Your content and your library</h2>
<p>Tome is a <strong>self-hosted reading platform</strong>. You provide the ebook and audiobook files you read. The Service does not host, sell, or distribute commercial books. You are solely responsible for ensuring you have the legal right to access, store, and stream every file in your library.</p>
<p>If you share your library with friends through Tome, you are responsible for the contents of that library and for the people you choose to share it with.</p>
<p>Public-domain titles obtained through the in-app Project Gutenberg integration are sourced directly from <a href="https://www.gutenberg.org">gutenberg.org</a> and remain governed by Project Gutenberg’s terms.</p>

<h2>4. Acceptable use</h2>
<p>You agree not to:</p>
<ul>
  <li>Upload or share content that infringes anyone’s copyright, trademark, or other rights.</li>
  <li>Use the Service to harass, threaten, defame, or impersonate another person.</li>
  <li>Post sexually explicit content involving minors, or any content that is otherwise illegal where you live.</li>
  <li>Attempt to access another user’s account, library, or library server without permission.</li>
  <li>Probe, scan, or test the vulnerability of the Service except as part of a coordinated security disclosure to <a href="mailto:security@tome.arroyoautomation.com">security@tome.arroyoautomation.com</a>.</li>
</ul>
<p>We may suspend or terminate accounts that violate these rules, with or without notice.</p>

<h2>5. User-generated content</h2>
<p>Book clubs, discussions, reviews, highlights, notes, and any other content you post are yours. By posting, you grant us a non-exclusive license to store, transmit, and display that content as needed to operate the Service.</p>
<p>We do not pre-screen user content. You can <strong>block</strong> any user from your <em>Profile</em> menu; blocked users will not appear in your friends search, activity feed, or club discussions. You can <strong>report</strong> a user or a discussion post from its context menu inside the app. We aim to review reports within 24 hours and will remove content or suspend accounts that violate these Terms. We have <strong>zero tolerance</strong> for objectionable content (illegal content, sexual content involving minors, doxxing, threats of violence) and abusive users.</p>

<h2>6. DMCA / copyright complaints</h2>
<p>If you believe content on Tome infringes your copyright, send a notice that includes the items required by 17 U.S.C. § 512(c)(3) to <a href="mailto:dmca@tome.arroyoautomation.com">dmca@tome.arroyoautomation.com</a>. We will respond as required by law.</p>

<h2>7. Library servers</h2>
<p>Library servers paired to your account may be operated by you or by another Tome user. We do not control library servers we did not deploy, and we make no warranty about the availability, content, or behavior of any library server. If a library server is misbehaving, you can revoke its pairing from your account at any time.</p>

<h2>8. Termination</h2>
<p>You can delete your account at any time from <em>Profile → Settings → Delete account</em>. We can suspend or terminate accounts for violations of these Terms or for any other reason that protects users or the Service.</p>

<h2>9. Disclaimers</h2>
<p>The Service is provided <em>as is</em>, without warranty of any kind, express or implied. We do not warrant that the Service will be uninterrupted, error-free, or that any content stored on the Service will be preserved.</p>

<h2>10. Limitation of liability</h2>
<p>To the maximum extent permitted by law, in no event will we be liable for indirect, incidental, special, consequential, or punitive damages, or for any loss of data or profits, arising from your use of the Service.</p>

<h2>11. Changes to these Terms</h2>
<p>We may update these Terms from time to time. If we make material changes we’ll update the <em>Last updated</em> date and, where appropriate, notify you in the app. Continuing to use Tome after a change means you accept the revised Terms.</p>

<h2>12. Contact</h2>
<p>Questions? Email <a href="mailto:legal@tome.arroyoautomation.com">legal@tome.arroyoautomation.com</a>.</p>
`;

const SUPPORT_BODY = `
<h1>Tome support</h1>
<p class="meta">Last updated: May 5, 2026</p>

<p>Tome is a self-hosted reading platform for ebooks and audiobooks with optional book-club features. Need help?</p>

<h2>Get in touch</h2>
<ul>
  <li><strong>General help &amp; bug reports:</strong> <a href="mailto:support@tome.arroyoautomation.com">support@tome.arroyoautomation.com</a></li>
  <li><strong>Privacy questions or data requests:</strong> <a href="mailto:privacy@tome.arroyoautomation.com">privacy@tome.arroyoautomation.com</a></li>
  <li><strong>DMCA / copyright complaints:</strong> <a href="mailto:dmca@tome.arroyoautomation.com">dmca@tome.arroyoautomation.com</a></li>
  <li><strong>Security disclosures:</strong> <a href="mailto:security@tome.arroyoautomation.com">security@tome.arroyoautomation.com</a></li>
</ul>
<p>We aim to reply within 1–2 business days.</p>

<h2>Common questions</h2>

<h2>How do I add books?</h2>
<p>Tome is self-hosted: you run a small server on a homelab box (Raspberry Pi, NAS, old Mac, anything always-on) and drop your <code>.epub</code> and <code>.m4b</code>/<code>.mp3</code> files into a folder. The server scans the folder, fetches cover art, and serves the files to your phone or tablet over your account. The mobile app does not download or distribute commercial books on your behalf.</p>

<h2>What about Project Gutenberg?</h2>
<p>Tome includes a built-in browser for <a href="https://www.gutenberg.org">Project Gutenberg</a>, the public-domain library. You can browse, search, and download free public-domain titles directly into your library from inside the app.</p>

<h2>How do I share my library with friends?</h2>
<p>From <em>Profile → My Libraries → (your library) → Share with friend</em>, pick which collections you want to share and choose a friend. They can read what you’ve shared from the same app, but cannot copy or download the files.</p>

<h2>How do I delete my account?</h2>
<p>Inside the app: <em>Profile → About &amp; legal → Delete account</em>. The deletion is immediate and irreversible — your profile, shelves, progress, highlights, clubs, libraries, and any sharing grants are removed.</p>

<h2>Is Tome free? Open source?</h2>
<p>The mobile app is free. The server is <a href="https://github.com/tome-project/tome">open source</a> under AGPL-3.0. There are no in-app purchases.</p>

<hr>
<p><a href="/legal/privacy">Privacy Policy</a> · <a href="/legal/terms">Terms of Service</a></p>
`;

legalRouter.get('/legal', (_req, res) => res.redirect(302, '/legal/privacy'));
legalRouter.get('/legal/privacy', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('html').send(layout('Privacy Policy', PRIVACY_BODY));
});
legalRouter.get('/legal/terms', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('html').send(layout('Terms of Service', TERMS_BODY));
});
legalRouter.get('/support', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('html').send(layout('Support', SUPPORT_BODY));
});
