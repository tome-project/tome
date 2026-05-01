import { createClient, SupabaseClient } from '@supabase/supabase-js';

/// Server-side Supabase client used for *service-role* writes — registering
/// this library server, recording scanned books, marking pairings consumed.
/// The service role key bypasses RLS and lives only in this server's env.
/// It is a powerful credential and should never be exposed to clients.
let _client: SupabaseClient | null = null;

export function hubClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Run the setup wizard at GET / or set the env vars and restart.',
    );
  }
  _client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _client;
}

/// Has the operator wired up the Supabase env vars yet? Used by the setup
/// wizard to decide whether to show a "missing env" screen vs the pair-code
/// screen.
export function hubConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}
