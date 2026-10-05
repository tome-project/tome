import { Router } from 'express';
import { requireSupabaseAuth } from '../middleware/supabase-auth';
import { loadIdentity } from '../services/server-identity';
import { runScanForOwner, scanState } from '../services/scan-on-startup';
export const scannerRouter = Router();
scannerRouter.post('/scan', requireSupabaseAuth, (req, res) => {
  const id = loadIdentity();
  if (!id) { res.status(503).json({ success: false, error: 'Library server not paired' }); return; }
  if (req.supabaseUserId !== id.ownerId) { res.status(403).json({ success: false, error: 'Only the owner can scan' }); return; }
  if (req.body?.subdir) { res.status(400).json({ success: false, error: 'Scan the complete library to preserve collection boundaries' }); return; }
  void runScanForOwner().catch(error => console.error('[manual-scan]', error));
  res.status(202).json({ success: true, data: { scan: scanState(), ...scanState().lastSummary } });
});
