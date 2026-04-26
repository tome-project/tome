# Tome

> **Plex for books.** A self-hosted ebook and audiobook platform with book club features.

Tome runs on your hardware, scans your existing library on disk, and serves it to a Flutter mobile app on iOS, Android, and the web. Invite friends and family with a one-tap code, read or listen across devices with synced progress, and run book clubs around a single book with chapter-by-chapter, spoiler-safe discussions.

Public domain books from Project Gutenberg are available out of the box — no setup, no DRM.

## Why Tome

The self-hosting world has good media servers (Plex, Jellyfin) and decent ebook tools (Calibre-Web, Kavita), but books are a second-class citizen everywhere. Audiobookshelf is the only player that takes audiobooks seriously, and it shows the path — but its mobile apps are community-built, ebooks are an afterthought, and there's no concept of *reading together*.

Tome is what happens when a single product owns the whole stack:

- **One install.** Native filesystem scanner — point Tome at your audiobook + ebook directories and it ingests them. No second media server to install and configure.
- **Mobile-first.** A polished Flutter client (iOS + Android, single codebase) instead of a community-built app on top of someone else's API.
- **Audiobooks and ebooks, both done well.** Native m4b/m4a/mp3 audiobook ingest with chapter support. EPUB reader. Same library, same client, same UX.
- **Book clubs as a first-class feature.** Time-boxed clubs around a single book, spoiler-safe discussion threads tied to chapters, sync reading progress across club members.
- **Invite-driven sharing.** Each user gets a permanent 8-character invite code. Hand it to your wife and one tap shares your entire library, in both directions, with their reading state staying private.

## Features

- ✅ Native filesystem scanner — audiobooks (`.m4b`, `.m4a`, single + multi-track `.mp3`), ebooks (`.epub`)
- ✅ Embedded chapter extraction (m4b atom parsing) and per-track manifest for mp3-folder audiobooks
- ✅ Cover art extraction (attached pic + folder.jpg/cover.jpg fallback)
- ✅ Metadata enrichment via OpenLibrary + Google Books (ISBN-first, title+author fallback)
- ✅ Range-request streaming for audiobooks (seek, scrub, lock-screen controls)
- ✅ Reading progress sync across devices
- ✅ Book clubs with chapter-bound discussions
- ✅ Invite codes + per-friend library sharing
- ✅ Project Gutenberg search + download
- ✅ Audiobookshelf compatibility (legacy ingest path; deprecating)
- 🚧 Native authentication (currently uses Supabase; self-hosted Postgres + local auth in progress)
- 🚧 Cross-server federated clubs (planned)

## Quick start

```bash
docker run -d \
  --name tome \
  -p 3000:3000 \
  -v /path/to/your/books:/scan:ro \
  -v tome-data:/library \
  -e SCAN_PATH=/scan \
  -e LIBRARY_PATH=/library \
  -e SUPABASE_URL=... \
  -e SUPABASE_ANON_KEY=... \
  -e SUPABASE_SERVICE_ROLE_KEY=... \
  -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  ghcr.io/tome-project/tome:latest
```

Then install the [Tome app](https://github.com/tome-project/tome-app) on your phone, sign up, and POST to `/api/v1/scanner/sync` (or use the in-app "Scan now" button) to ingest your library.

> **Note:** Tome currently requires a Supabase project for auth and metadata storage. Self-hosted Postgres + local auth is on the roadmap and tracks alongside the v1.0 release.

## Library layout

The scanner walks any structure under `SCAN_PATH` and identifies books by file extension. The Audiobookshelf convention works out of the box:

```
/books
  /audiobooks
    /Author Name
      /Book Title
        book.m4b               # or
        chapter-01.mp3         # multi-track: each mp3 = one chapter
        chapter-02.mp3
        cover.jpg              # optional fallback cover
  /ebooks
    /Author Name
      Book.epub
```

Existing Audiobookshelf users can point Tome at the same directory tree without reorganizing.

## Configuration

| Env var | Required | Default | Description |
|---|---|---|---|
| `SCAN_PATH` | recommended | `LIBRARY_PATH` | Read-only mount of your audiobook + ebook library |
| `LIBRARY_PATH` | recommended | `./library` | Writable directory for covers, uploads, Gutenberg downloads |
| `PORT` | no | `3000` | HTTP port |
| `SUPABASE_URL` | yes | — | Supabase project URL |
| `SUPABASE_ANON_KEY` | yes | — | Public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | — | Service role key (admin DB access) |
| `ENCRYPTION_KEY` | yes | — | 32-byte hex string for encrypting media-server tokens at rest |
| `CORS_ORIGIN` | no | `*` | Origin allowlist for cross-origin requests |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Flutter client (iOS / Android / Web)                       │
│                                                             │
│   audio_service + just_audio  ▲       │                     │
└───────────────────────────────┘       │                     │
                                        │ HTTPS               │
                                        ▼                     │
┌─────────────────────────────────────────────────────────────┐
│  Tome server (this repo)                                    │
│                                                             │
│   ┌─────────────┐    ┌──────────────┐    ┌──────────────┐  │
│   │  Scanner    │    │  Streaming   │    │  Club / chat │  │
│   │  ffprobe    │    │  Range       │    │  RLS-backed  │  │
│   │  epub2      │    │  /files/:id  │    │  realtime    │  │
│   └──────┬──────┘    └──────┬───────┘    └──────┬───────┘  │
│          │                  │                   │           │
│   ┌──────┴──────────────────┴───────────────────┴───────┐  │
│   │ Postgres (Supabase) + auth                          │  │
│   └─────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
        ▲                              ▲
        │ /scan (read-only)            │ /library (writable)
        │                              │
   /mnt/media/books                covers/, uploads/, gutenberg/
```

Books on disk → `book_sources` rows (`kind='filesystem'`, `tracks` JSONB for multi-track) → catalog books with metadata → user library + reading progress + clubs.

## Migrating from Audiobookshelf

If you already run Audiobookshelf:

1. **Don't rearrange your library.** Tome reads the same directory layout.
2. Point Tome's `SCAN_PATH` at the same directory ABS uses (e.g. `/mnt/media/books`).
3. Run the scanner — it'll ingest every book into Tome's catalog, preserving file paths.
4. Once you've validated coverage, you can stop your ABS container.

The legacy ABS-connector path (registering an ABS server and syncing through its API) still works for users who want to keep ABS running alongside Tome.

## How Tome compares

| | Tome | Audiobookshelf | Calibre-Web | Kavita |
|---|---|---|---|---|
| Audiobooks | ✅ | ✅ | ❌ | ❌ |
| Ebooks | ✅ | △ basic | ✅ | ✅ |
| First-party mobile | ✅ Flutter | △ community | ❌ | ❌ |
| Book clubs | ✅ | ❌ | ❌ | ❌ |
| Invite-based sharing | ✅ | ❌ | ❌ | ❌ |
| Project Gutenberg built-in | ✅ | ❌ | ❌ | ❌ |
| Self-host friendly | ✅ | ✅ | ✅ | ✅ |

## Status & roadmap

Tome is pre-1.0. The native scanner, streaming, clubs, and invite layer are stable. Active work:

- Self-hosted authentication (currently uses Supabase Auth)
- Local Postgres support (currently requires Supabase)
- Federated cross-server clubs
- Calibre integration as an alternate source kind
- Built-in OpenAPI spec + generated Dart client

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup and PR conventions.

## License

[AGPL-3.0](LICENSE). The mobile clients are released separately under their own license.
