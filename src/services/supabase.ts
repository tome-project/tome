import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
  throw new Error('Missing Supabase environment variables');
}

// Public client — respects RLS policies
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Admin client — bypasses RLS, use only on the server for privileged operations
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
