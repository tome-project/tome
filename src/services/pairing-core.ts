import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';

/// Result of a successful pair: enough creds for the calling library
/// server to sign into Supabase as its own scoped service user from now on.
export interface PairResult {
  server_id: string;
  server_name: string;
  url: string;
  owner_id: string;
  supabase_url: string;
  supabase_email: string;
  supabase_password: string;
}

/// Generates the email Supabase auth uses for a library server's service
/// account. Synthetic, never seen by humans, never receives mail.
function serviceEmailFor(serverId: string): string {
  return `library-${serverId}@servers.tome.app`;
}

/// 24 random bytes → ~32 base64url chars. Stored in plaintext on the
/// library server's local disk; never transmitted again after pair.
function generateServicePassword(): string {
  return randomBytes(24).toString('base64url');
}

/// Mint a per-server Supabase service user, create the library_servers
/// row bound to that user, and consume the pairing code.
///
/// Runs on the **hub** side (must hold SUPABASE_SERVICE_ROLE_KEY). Called
/// either by the local /pair route when the server is itself the hub, or
/// by the new POST /api/v1/hub/pair when a remote library server is
/// claiming a code.
export async function mintLibraryServer(args: {
  hub: SupabaseClient;
  supabaseUrl: string;
  code: string;
  name: string;
  url: string;
  platform?: string;
  version?: string;
}): Promise<PairResult> {
  const { hub, supabaseUrl, code, name, url, platform, version } = args;

  // 1. Validate pairing code.
  const { data: pairing, error: lookupErr } = await hub
    .from('library_server_pairings')
    .select('*')
    .eq('code', code)
    .maybeSingle();
  if (lookupErr) throw lookupErr;
  if (!pairing) throw new Error('No pairing for that code');
  if (pairing.consumed_at) throw new Error('Code already used');
  if (new Date(pairing.expires_at) < new Date()) {
    throw new Error('Code expired — generate a new one in the app');
  }

  // 2. Create the per-server auth user. Password isn't user-facing — it
  //    lives on the library server's disk only. We enable email_confirm
  //    so the user is immediately usable (no confirmation email sent;
  //    the address is synthetic anyway).
  const password = generateServicePassword();
  // Use a placeholder email first because Supabase requires a unique
  // email up front; we patch it to library-<server_id>@servers.tome.app
  // after we know the row's id (chicken-and-egg: we want the email to
  // include the library_servers.id, but we need the auth.users.id to
  // create the row). Simplest: use an email scoped by the auth user's
  // own id — no library_servers.id needed in the address.
  const bootstrapEmail = `library-bootstrap-${randomBytes(8).toString('hex')}@servers.tome.app`;
  const { data: authData, error: authErr } = await hub.auth.admin.createUser({
    email: bootstrapEmail,
    password,
    email_confirm: true,
    user_metadata: { kind: 'library_server' },
  });
  if (authErr || !authData.user) {
    throw authErr ?? new Error('Failed to create library server service user');
  }
  const serviceUserId = authData.user.id;

  try {
    // 3. Re-email the auth user to the canonical address now that we
    //    have its uuid. Keeps user_metadata.kind = library_server.
    const finalEmail = serviceEmailFor(serviceUserId);
    await hub.auth.admin.updateUserById(serviceUserId, { email: finalEmail });

    // 4. Insert the library_servers row.
    const { data: server, error: insertErr } = await hub
      .from('library_servers')
      .insert({
        owner_id: pairing.claimer_user_id,
        service_user_id: serviceUserId,
        name,
        url,
        platform,
        version,
      })
      .select()
      .single();
    if (insertErr) throw insertErr;

    // 5. Mark pairing consumed.
    await hub
      .from('library_server_pairings')
      .update({
        consumed_at: new Date().toISOString(),
        consumed_by_server_id: server.id,
      })
      .eq('code', code);

    return {
      server_id: server.id,
      server_name: server.name,
      url: server.url,
      owner_id: server.owner_id,
      supabase_url: supabaseUrl,
      supabase_email: finalEmail,
      supabase_password: password,
    };
  } catch (err) {
    // Compensate: drop the auth.users row so a retry can succeed.
    try {
      await hub.auth.admin.deleteUser(serviceUserId);
    } catch (cleanupErr) {
      console.error('[mintLibraryServer] failed to clean up auth user', cleanupErr);
    }
    throw err;
  }
}

/// Make a hub-only Supabase client from explicit URL + service-role key.
/// Used by the hub /pair endpoint.
export function makeHubClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
