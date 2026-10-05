import { SERVER_VERSION } from '../version';
import { Router } from 'express';
import { hubClient, hubConfigured } from '../services/hub';
import { loadIdentity } from '../services/server-identity';
import { scanState } from '../services/scan-on-startup';
export const healthRouter = Router();
healthRouter.get('/health', (_req, res) => res.json({ success: true, data: { status: 'healthy', version: SERVER_VERSION } }));
healthRouter.get('/ready', async (_req, res) => {
  const identity = loadIdentity();
  let connected = false;
  try {
    if (identity && hubConfigured()) {
      const result = await hubClient().from('library_servers').select('id').eq('id', identity.serverId).abortSignal(AbortSignal.timeout(8000)).maybeSingle();
      connected = !result.error && !!result.data;
    }
  } catch { /* unavailable */ }
  res.status(connected ? 200 : 503).json({ success: connected, data: { paired: !!identity, hub_connected: connected, scan: scanState() } });
});
