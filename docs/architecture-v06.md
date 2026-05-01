# Tome Architecture (v0.6+ Plex-of-books rewrite)

> Identity is centralized. Files are federated. Just like Plex.

## The shape

```
┌─────────────────────────────────────────────────────────┐
│  SUPABASE  (the hub — `tome.arroyoautomation.com`)      │
│  ─────────────────────────────────────────────────────  │
│  • Auth (Supabase Auth: email/password, magic, OAuth)   │
│  • user_profiles, friendships, clubs, discussions       │
│  • books (universal catalog)                            │
│  • user_books (per-user shelf), reading_progress,       │
│    reading_sessions, reading_goals, highlights,         │
│    audio_bookmarks                                      │
│  • library_servers, library_server_pairings,            │
│    library_server_grants, library_server_books          │
│  • RLS = the only security perimeter                    │
└──────────────────▲──────────────────────────────────────┘
                   │ supabase_flutter (auth + queries +
                   │   realtime subscriptions)
                   │
       ┌───────────┴─────────────┐         ┌──────────────────────────────┐
       │                         │         │                              │
       │   Flutter app           │ HTTP    │  Library server (optional)   │
       │   (iOS / Android / web) │ range   │  ────────────────────────    │
       │   ────────────          │ requests│  • Scans a directory         │
       │   • Reader (epub)       ├────────►│  • Registers self with       │
       │   • Player (audiobook)  │         │    Supabase (paired flow)    │
       │   • Library (unified)   │ Bearer  │  • Verifies Supabase JWTs    │
       │   • Social / clubs      │ <jwt>   │    via JWKS                  │
       │   • Device-local store  │         │  • Streams files (range)     │
       │     (sideloaded books)  │         │  • Setup wizard (web + CLI)  │
       └─────────────────────────┘         └──────────────────────────────┘
```

## Rules

1. **The app talks to Supabase directly** — no Node middleman for auth/social/catalog. Use `supabase_flutter`. Every read/write is a Supabase query subject to RLS.

2. **Library servers are optional and federated.** Most users have zero. Power users have one. Friends-of-power-users have N (the friend's + their own).

3. **Files never enter Supabase.** Bytes live on the library server's disk (or on the user's device, for sideloaded books). Supabase only stores *metadata about which files exist where*.

4. **Identity is forever.** Switching libraries doesn't change who you are.

5. **The cold installer experience is first-class.** Sign up → Supabase account → tracker shelf works → Gutenberg works → sideload-from-device works. Library server is an "advanced — connect a server" toggle in settings.

## The four data sources for the unified Library tab

| Source | Where it lives | Visible because |
|---|---|---|
| **Device** | App documents dir on the phone (LocalBookStore + `user_books.source='device'`) | User sideloaded it |
| **Own library server** | A `library_server` row owned by the user, plus `library_server_books` rows for what's on disk | User registered the server |
| **Shared library server** | `library_server_grants.grantee_id = me`, plus the joined `library_server_books` rows | Owner shared with the user |
| **Gutenberg** | `books.source = 'gutenberg'` (downloaded into app docs on first read) | Free public domain, available to everyone |

Tap a book → app figures out which source has it, opens the right reader/player with the right URI:

- Device → `Uri.file(...)`
- Own server → `https://my-server/files/<bookId>?token=<short-lived-jwt>`
- Shared server → same as own, server validates the grant before streaming
- Gutenberg → either streamed from the hub's Gutenberg cache or downloaded into device on first open (TBD)

## Pairing a library server

Plex-style 6-digit code, app-initiated:

1. User: Settings → Connect a Library Server → "Generate code"
2. App writes `library_server_pairings` row: `code = <6 random digits>`, `claimer_user_id = auth.uid()`, `expires_at = now() + 5min`
3. App displays code: "On your library server's setup page, enter `837492`"
4. User opens `http://library-server:3000/setup` (or runs `tome-server pair --code 837492`)
5. Server (using `SUPABASE_SERVICE_ROLE_KEY` from its env) looks up the pairing by code, reads `claimer_user_id`
6. Server INSERTs into `library_servers` with `owner_id = claimer_user_id`, `url = <self URL>`
7. Server marks pairing `consumed_at = now(), consumed_by_server_id = <new id>`
8. App polls (or subscribes via realtime) for the pairing's `consumed_at` to flip → success screen → unified library now includes the new server

## Trust model

- **Library server ↔ Supabase:** server holds `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in env. It's a trusted machine on the user's network. Service role bypasses RLS for the server's own writes (registering itself, recording books it scanned). Service role key can be rotated by the user via Supabase dashboard if compromised.

- **App ↔ library server:** app sends Supabase JWT in the `Authorization: Bearer ...` header. Server verifies via Supabase's JWKS endpoint. Server then checks: is this user the owner OR an active grantee? If yes → stream. If no → 403.

- **App ↔ Supabase:** standard Supabase Auth + RLS. JWT renewed automatically by `supabase_flutter`.

## What's gone from v0.6

- Custom Node bcrypt + JWT (replaced by Supabase Auth)
- `/api/v1/auth/*` routes (Supabase handles)
- `/api/v1/profiles/*`, `/friendships/*`, `/clubs/*`, `/discussions/*`, `/stats/*`, `/activity/*`, `/goals/*`, `/highlights/*`, `/audio-bookmarks/*`, `/user-books/*`, `/reading-sessions/*`, `/invites/*`, `/server-shares/*` routes (direct Supabase queries from the app)
- `media_servers` / `server_shares` tables (replaced by `library_servers` + `library_server_grants`)
- The "switch backend URL" picker (wrong shape — that was treating the entire backend as swappable; it's not)

## What stays

- File streaming endpoint (`GET /files/:bookId` with range requests) — the library server's main job
- Scanner (recursive walk + epub/audiobook metadata extraction)
- (Optional) Audiobookshelf bridge — for users who already have an ABS instance
- The Flutter audio handler (Player UI + lock-screen / Now Playing integration)
- The Flutter epub viewer

## Migration path from v0.5 → v0.6

> No real users yet — wipe is acceptable.

1. Wipe Supabase project (drop public schema, drop public auth users)
2. Apply `001_initial_schema.sql`
3. Update `tome-project/tome` (server) to library-server-only mode
4. Redeploy `tome.arroyoautomation.com` to docker-vm — but this becomes Chris's *personal library server*, not a "hub." The hub IS Supabase.
5. Ship new TestFlight (using `supabase_flutter`, talking to Supabase directly)
6. Validate: register, claim handle, friend invite, club, sideload, library server pair, share with friend
