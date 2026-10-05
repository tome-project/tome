import { createClient } from '@supabase/supabase-js';
import { Request } from 'express';
import { loadIdentity } from './server-identity';

/** Read federation metadata with the caller's RLS, even on a scoped self-host. */
export function callerClient(req: Request) {
  return createClient(process.env.SUPABASE_URL || loadIdentity()?.supabaseUrl || 'https://zflawbkznckwlutlcgjh.supabase.co',
    process.env.SUPABASE_ANON_KEY || 'sb_publishable_k-NU9SmkTArQZqY1R6Fe0g_4Ef4kSY_', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: req.headers.authorization! },
        fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([AbortSignal.timeout(8000), ...(init?.signal ? [init.signal] : [])]) }) },
    });
}
