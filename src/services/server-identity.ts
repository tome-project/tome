import fs from 'fs';
import path from 'path';

/// Persistent identity for this library server: which Supabase user owns
/// it, and what library_servers row it's bound to. Written once during
/// pairing, read on every authenticated request thereafter to authorize
/// callers (owner or active grantee).
///
/// Stored at $LIBRARY_PATH/.tome-server.json so the same volume that holds
/// the books also holds the binding — wipe one, wipe both.
const libraryPath = process.env.LIBRARY_PATH || './library';
const identityFile = path.join(libraryPath, '.tome-server.json');

export interface ServerIdentity {
  serverId: string;        // library_servers.id (uuid)
  ownerId: string;         // auth.users.id of the binder
  serverName: string;      // user-chosen display name
  pairedAt: string;        // ISO timestamp
}

let _cached: ServerIdentity | null | undefined;

export function loadIdentity(): ServerIdentity | null {
  if (_cached !== undefined) return _cached;
  try {
    const raw = fs.readFileSync(identityFile, 'utf-8');
    _cached = JSON.parse(raw) as ServerIdentity;
  } catch {
    _cached = null;
  }
  return _cached;
}

export function saveIdentity(id: ServerIdentity): void {
  fs.mkdirSync(libraryPath, { recursive: true });
  fs.writeFileSync(identityFile, JSON.stringify(id, null, 2), 'utf-8');
  _cached = id;
}

export function isPaired(): boolean {
  return loadIdentity() !== null;
}
