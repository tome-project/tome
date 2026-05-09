import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { loadIdentity } from './server-identity';

/// Supabase client used for all writes from this library server.
///
/// Two operating modes:
///
///   1. **Hub mode** — the prod server / anyone running `IS_HUB=true`.
///      Holds SUPABASE_SERVICE_ROLE_KEY. Writes bypass RLS. This is the
///      original (and only) mode pre-migration-007.
///
///   2. **Self-host mode** — anyone running their own Tome server. No
///      service-role key. After pairing, the hub minted a per-server
///      auth.users row; the email/password live in .tome-server.json.
///      The client signs into Supabase as that user; RLS policies in
///      migration 007 scope its writes to its own rows.
///
/// `hubClient()` is sync to keep call sites simple. Boot must call
/// `initHubClient()` first (see index.ts) — sign-in happens there.

// Defaults match the production Supabase project. Both URL and anon key
// are public (they ship in the Flutter client). Self-hosters don't need
// to override these unless they're testing against a different Supabase.
const DEFAULT_SUPABASE_URL = 'https://zflawbkznckwlutlcgjh.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY =
  'sb_publishable_k-NU9SmkTArQZqY1R6Fe0g_4Ef4kSY_';

let _client: SupabaseClient | null = null;
let _initPromise: Promise<void> | null = null;

export function hubClient(): SupabaseClient {
  if (!_client) {
    throw new Error(
      'hubClient() called before initHubClient() — boot did not initialize the Supabase session yet.',
    );
  }
  return _client;
}

/// Initialize the Supabase client. Safe to call multiple times — the
/// second call is a no-op. Throws if the server is misconfigured (no
/// service role and not paired yet).
export async function initHubClient(): Promise<void> {
  if (_client) return;
  if (_initPromise) return _initPromise;
  _initPromise = _doInit();
  return _initPromise;
}

async function _doInit(): Promise<void> {
  const url = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Hub mode: service role bypasses RLS. The hub uses this to mint
  // service users for new library servers (we cannot mint users via
  // RLS — admin API only).
  if (serviceRoleKey) {
    _client = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    return;
  }

  // Self-host mode: sign in as our scoped service user.
  const identity = loadIdentity();
  if (!identity?.supabaseEmail || !identity?.supabasePassword) {
    throw new Error(
      'Server is not paired yet — no Supabase service-user creds on disk. ' +
        'Open /setup in a browser and paste a 6-digit code from the Tome app.',
    );
  }
  const anonKey = process.env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY;
  const supabaseUrl = identity.supabaseUrl || url;
  _client = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: true, persistSession: false },
  });
  const { error } = await _client.auth.signInWithPassword({
    email: identity.supabaseEmail,
    password: identity.supabasePassword,
  });
  if (error) {
    _client = null;
    _initPromise = null;
    throw new Error(
      `Failed to sign into Supabase as library server: ${error.message}. ` +
        'You may need to re-pair this server (POST /setup/reset, then a fresh code).',
    );
  }
}

/// True iff the server has *some* path to write to Supabase — either
/// service-role env (hub mode) or stored creds (self-host paired).
export function hubConfigured(): boolean {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return true;
  const id = loadIdentity();
  return !!(id?.supabaseEmail && id?.supabasePassword);
}

/// True iff this server is operating as the hub (mints service users
/// for other library servers). Today: anything with a service-role key
/// is the hub; explicit IS_HUB=true also works.
export function isHubMode(): boolean {
  return (
    process.env.IS_HUB === 'true' || !!process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

/// The hub URL self-host servers POST their pair requests to. Defaults
/// to prod; can be overridden for testing against a different Tome hub.
export function hubBaseUrl(): string {
  return (
    process.env.HUB_URL?.replace(/\/$/, '') || 'https://tome.arroyoautomation.com'
  );
}

/// Reset the cached client — used after re-signing-in from a fresh pair.
export function resetHubClient(): void {
  _client = null;
  _initPromise = null;
}
