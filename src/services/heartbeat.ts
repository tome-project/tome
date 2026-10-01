import os from 'os';
import { hubClient, resetHubClient, initHubClient } from './hub';
import { loadIdentity } from './server-identity';
import { startBackgroundJob } from './background-job';

/// Periodically pokes library_servers.last_seen_at + version + platform
/// so the app can show a fresh "online" indicator. Runs in the
/// background; failures are logged but never crash the server.
///
/// Cadence is conservative — every 60s is enough granularity for an
/// online dot without hammering the hub.
const INTERVAL_MS = 60_000;

let _stop: (() => void) | null = null;
let _consecutiveFailures = 0;

export function startHeartbeat(): void {
  if (_stop) return;
  // Fire immediately so a freshly-paired server lights up online without
  // waiting a full minute.
  _stop = startBackgroundJob({ name: 'heartbeat', run: _tick, intervalMs: INTERVAL_MS, immediate: true });
}

export function stopHeartbeat(): void {
  if (_stop) {
    _stop();
    _stop = null;
  }
}

async function _tick(signal: AbortSignal): Promise<void> {
  const identity = loadIdentity();
  if (!identity) return;
  try {
    // Failed re-login leaves no client; the next backed-off tick must retry.
    await initHubClient(signal);
    signal.throwIfAborted();
    const { error } = await hubClient()
      .from('library_servers')
      .update({
        last_seen_at: new Date().toISOString(),
        platform: process.platform,
        version: process.env.npm_package_version || '0.7.0',
      })
      .eq('id', identity.serverId)
      .abortSignal(signal);

    if (error) {
      // supabase-js returns { error } on RLS denial / JWT expiry rather
      // than throwing. If the message smells like an auth issue, force
      // a re-sign-in once and retry. This recovers self-hosters whose
      // session expired while their box was sleeping.
      const msg = error.message || '';
      const looksLikeAuth =
        /jwt|expired|401|invalid api key|invalid token|insufficient/i.test(msg);
      if (looksLikeAuth) {
        console.warn('[heartbeat] auth error — re-signing in:', msg);
        resetHubClient();
        await initHubClient(signal);
        signal.throwIfAborted();
        // Retry once; if it still fails, fall through to error logging below.
        const retry = await hubClient()
          .from('library_servers')
          .update({ last_seen_at: new Date().toISOString() })
          .eq('id', identity.serverId)
          .abortSignal(signal);
        if (retry.error) throw new Error(retry.error.message);
      } else {
        throw new Error(msg);
      }
    }
    _consecutiveFailures = 0;
  } catch (err) {
    _consecutiveFailures += 1;
    const msg = err instanceof Error ? err.message : String(err);
    // First few failures: quiet (transient blip). After that, escalate
    // so the operator can see something is wrong without being silently
    // offline forever.
    if (_consecutiveFailures <= 2) {
      console.error('[heartbeat]', msg);
    } else {
      const looksTransient =
        /aborted|timeout|gateway|fetch failed|network|econnreset|enotfound|undici/i.test(msg);
      console.error(
        `[heartbeat] still failing after ${_consecutiveFailures} ticks: ${msg}.` +
          (looksTransient
            ? ' Hub/API is unreachable; pairing is unchanged.'
            : ' If this persists, your pairing may have been revoked — visit /setup to re-pair.'),
      );
    }
    throw err;
  }
  if (process.env.HEARTBEAT_VERBOSE === '1') {
    console.log(`[heartbeat] ${os.hostname()} → ${identity.serverId}`);
  }
}
