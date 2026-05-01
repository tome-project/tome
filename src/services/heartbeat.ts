import os from 'os';
import { hubClient } from './hub';
import { loadIdentity } from './server-identity';

/// Periodically pokes library_servers.last_seen_at + version + platform
/// so the app can show a fresh "online" indicator. Runs in the
/// background; failures are logged but never crash the server.
///
/// Cadence is conservative — every 60s is enough granularity for an
/// online dot without hammering the hub.
const INTERVAL_MS = 60_000;

let _timer: NodeJS.Timeout | null = null;

export function startHeartbeat(): void {
  if (_timer) return;
  // Fire immediately so a freshly-paired server lights up online without
  // waiting a full minute.
  void _tick();
  _timer = setInterval(() => void _tick(), INTERVAL_MS);
}

export function stopHeartbeat(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

async function _tick(): Promise<void> {
  const identity = loadIdentity();
  if (!identity) return;
  try {
    await hubClient()
      .from('library_servers')
      .update({
        last_seen_at: new Date().toISOString(),
        platform: process.platform,
        version: process.env.npm_package_version || '0.6.0',
      })
      .eq('id', identity.serverId);
  } catch (err) {
    // ignore: heartbeat failures are non-fatal — the hub is unreachable
    // (transient network blip, brief Supabase maintenance, etc.) and the
    // next tick will catch up.
    console.error('[heartbeat]', err instanceof Error ? err.message : err);
  }
  // Quiet log so an operator can confirm heartbeats are firing.
  if (process.env.HEARTBEAT_VERBOSE === '1') {
    console.log(`[heartbeat] ${os.hostname()} → ${identity.serverId}`);
  }
}
