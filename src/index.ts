import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import {
  healthRouter,
  filesRouter,
  coversRouter,
  scannerRouter,
  // v0.6 federation routes
  pairingRouter,
  setupRouter,
} from './routes';
import { errorHandler } from './middleware';
import { loadIdentity } from './services/server-identity';
import { runScanForOwner } from './services/scan-on-startup';
import { startHeartbeat } from './services/heartbeat';
import { verifyIdentityOrUnpair } from './services/identity-check';

const app = express();
const port = process.env.PORT || 3000;

// Behind Cloudflare Tunnel / nginx in production, which sets
// X-Forwarded-For. Trust a single upstream hop so express-rate-limit can
// identify clients by real IP without the tunnel warning.
app.set('trust proxy', 1);

app.use(helmet({
  // Setup wizard serves a tiny HTML page with inline styles. Loosen CSP
  // for the wizard route only via per-route helmet calls if needed; the
  // global config stays strict.
  contentSecurityPolicy: process.env.NODE_ENV === 'production' ? undefined : false,
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, data: null, error: 'Too many requests, try again later' },
});
app.use(limiter);

// ---------------------------------------------------------------------------
// v0.6 Plex-of-books rewrite: this server is a *library server* only.
// All identity / social / catalog routes moved to direct Supabase queries
// from the Flutter client; the orphaned route files (auth, profiles,
// clubs, etc.) stay on disk for reference until the cleanup PR but are
// no longer registered.
// ---------------------------------------------------------------------------
app.use(healthRouter);
app.use(setupRouter);     // GET / and /setup → web wizard; POST /setup → claim
app.use(pairingRouter);   // POST /pair (CLI alternative to the wizard)
app.use(filesRouter);     // GET /files/:bookId → range-request file streaming
app.use(coversRouter);    // GET /covers/:bookId → cover image
app.use(scannerRouter);   // POST /scan → trigger a library scan (manual)

app.use(errorHandler);

app.listen(port, () => {
  console.log(`Tome library server running on port ${port}`);
  console.log(`Open http://localhost:${port}/setup to pair this server.`);

  // Boot sequence (background — never blocks request handling):
  //   1. Verify our persisted identity is still valid on the hub.
  //      If the row is gone (admin wiped, owner removed), unpair.
  //   2. If still paired, start the heartbeat ticker so the app shows
  //      this server as online.
  //   3. Kick off an auto-scan to catch any disk changes since last boot.
  void (async () => {
    if (!loadIdentity()) {
      console.log('Server is not paired yet — skipping background tasks.');
      return;
    }
    const stillPaired = await verifyIdentityOrUnpair();
    if (!stillPaired) {
      console.log('Identity check unpaired the server — visit /setup to re-pair.');
      return;
    }
    startHeartbeat();
    try {
      await runScanForOwner();
    } catch (err) {
      console.error('[startup-scan] failed', err);
    }
  })();
});

export default app;
