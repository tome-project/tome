import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _supabase: SupabaseClient | null = null;
let _supabaseAdmin: SupabaseClient | null = null;

function getEnv() {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !anonKey || !serviceRoleKey) {
    throw new Error(
      'Missing Supabase environment variables. Set SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY.'
    );
  }

  return { url, anonKey, serviceRoleKey };
}

// Public client — respects RLS policies (lazy init)
export const supabase = new Proxy({} as SupabaseClient, {
  get(_, prop) {
    if (!_supabase) {
      const { url, anonKey } = getEnv();
      _supabase = createClient(url, anonKey);
    }
    return (_supabase as any)[prop];
  },
});

// Admin client — bypasses RLS (lazy init)
export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_, prop) {
    if (!_supabaseAdmin) {
      const { url, serviceRoleKey } = getEnv();
      _supabaseAdmin = createClient(url, serviceRoleKey);
    }
    return (_supabaseAdmin as any)[prop];
  },
});
