import fs from 'fs';
import path from 'path';
import { hubClient } from './hub';
import { loadIdentity } from './server-identity';

const libraryPath = process.env.LIBRARY_PATH || './library';
const identityFile = path.join(libraryPath, '.tome-server.json');

/// On boot, verify our persisted identity is still valid: the
/// library_servers row we think we own actually exists in Supabase. If
/// the owner deleted us from the app (or via an admin wipe), wipe our
/// local identity file too — otherwise we'd keep heartbeating + serving
/// requests that the hub no longer authorizes.
///
/// Returns true if still valid, false if we just unpaired ourselves.
export async function verifyIdentityOrUnpair(): Promise<boolean> {
  const identity = loadIdentity();
  if (!identity) return false;
  try {
    const { data, error } = await hubClient()
      .from('library_servers')
      .select('id, owner_id')
      .eq('id', identity.serverId)
      .maybeSingle();
    if (error) {
      // Network/Supabase down — be conservative and leave identity
      // intact. Heartbeat will retry; we can re-check on next boot.
      console.error('[identity-check] could not verify (kept paired):', error.message);
      return true;
    }
    if (!data) {
      console.warn(
        `[identity-check] library_servers row ${identity.serverId} no longer exists — unpairing.`,
      );
      try {
        fs.unlinkSync(identityFile);
      } catch {
        /* */
      }
      return false;
    }
    if (data.owner_id !== identity.ownerId) {
      console.warn(
        `[identity-check] owner changed (${identity.ownerId} → ${data.owner_id}) — unpairing.`,
      );
      try {
        fs.unlinkSync(identityFile);
      } catch {
        /* */
      }
      return false;
    }
    return true;
  } catch (err) {
    // Same conservative stance as the error branch above.
    console.error(
      '[identity-check] threw (kept paired):',
      err instanceof Error ? err.message : err,
    );
    return true;
  }
}
