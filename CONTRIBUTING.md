# Contributing to Tome

Thanks for your interest. Tome is in active development; the easiest contributions right now are bug reports, scanner-format improvements, and metadata-provider work.

## Development setup

```bash
git clone https://github.com/tome-project/tome.git
cd tome
npm install
cp .env.example .env  # fill in your Supabase project details
npm run dev
```

You'll need:

- Node.js 20+
- A Supabase project (the self-hosted-Postgres path is on the roadmap but not yet wired up)
- `ffmpeg` installed locally if you want to exercise the scanner against real audiobooks (`brew install ffmpeg` / `apt-get install ffmpeg`)

The dev server expects a writable directory for covers/uploads (`LIBRARY_PATH`, defaults to `./library`) and a separate read-only directory for the audiobook scan source (`SCAN_PATH`). For local dev they can be the same.

## Project layout

- `src/routes/` — Express route handlers, one file per resource. Mounted in `src/index.ts`.
- `src/services/` — domain logic. Notable: `scanner.ts` (filesystem walker + ffprobe + epub2), `catalog.ts` (OpenLibrary / Google Books enrichment), `audiobookshelf.ts` (legacy ABS connector).
- `src/middleware/` — auth and error handling.
- `src/types/` — shared TypeScript types. The Flutter client mirrors these in Dart by hand; if you change a public-facing type, update the corresponding model in `tome-app`.
- `supabase/migrations/` — Postgres migrations applied via the Supabase CLI or the dashboard.

## Conventions

- TypeScript: camelCase variables, PascalCase types/interfaces, kebab-case filenames.
- API responses: `{ success: boolean, data: any, error?: string }`.
- API routes: RESTful, versioned at `/api/v1/...`.
- Don't hand-roll auth — use the `requireAuth` middleware on routes that need it.
- Migrations are additive. Avoid destructive `DROP COLUMN` / data-mangling changes without explicit discussion.

## Reporting bugs

Open an issue on GitHub with:

- Tome version (commit SHA or release tag)
- Steps to reproduce
- A representative file path or filename pattern if it's a scanner issue (we can't ship audiobooks but `ffprobe -show_format <file>` output is gold)
- Any relevant `docker logs tome` output

## Pull requests

- Keep PRs focused. One feature or fix per PR.
- Add or update tests when behavior changes.
- Run `npm run lint` and `npx tsc --noEmit` locally before opening the PR.
- For scanner changes, include before/after on a representative sample. We have an internal test fixture set; we can verify before merge.

## License

By contributing you agree that your contributions are licensed under [AGPL-3.0](LICENSE) along with the rest of the project.
