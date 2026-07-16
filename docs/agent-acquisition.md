# Agent acquisition loop (family library)

How a CLI agent (Grok / Claude / etc.) with access to the Tome **library
server host** should fill requests from family members.

## The product loop

```
Wife/kids in Tome app          You + agent on the server
─────────────────────          ─────────────────────────
Search / type a title
→ Request from Chris's library
→ sees "Pending"               GET /api/v1/requests/pending
                               → try search_hints until found
                               → drop file under LIBRARY_PATH
                               → POST /scan  (or wait for boot scan)
→ status flips to Fulfilled
→ open / play
```

If the agent cannot find a title: **decline with a note**. Silent failure
is what makes family stop using the app.

## Auth

These endpoints require a Supabase JWT for the **library owner** or the
server's **service user** (the identity the paired library server uses).

On the host, easiest paths:

1. **Reuse the paired service session** the library server already has
   (preferred when the agent can call through the local process or read
   the same env the Docker container uses).
2. **Owner JWT** from a one-shot `supabase.auth.signInWithPassword` in a
   script, then:

```bash
# List the work queue (oldest first)
curl -sS -H "Authorization: Bearer $TOME_JWT" \
  http://localhost:3000/api/v1/requests/pending | jq .

# After files land
curl -sS -X POST -H "Authorization: Bearer $TOME_JWT" \
  http://localhost:3000/scan

# Cannot find it
curl -sS -X POST -H "Authorization: Bearer $TOME_JWT" \
  -H "Content-Type: application/json" \
  -d '{"note":"No legal source found; try Libby or Audible"}' \
  http://localhost:3000/api/v1/requests/123e4567-e89b-12d3-a456-426614174000/decline
```

`GET /api/v1/requests/pending` returns, per request:

| Field | Use |
|-------|-----|
| `title`, `authors`, `isbn_13`, `open_library_id` | Identity |
| `search_hints[]` | Try these queries in order |
| `suggested_path` | Where to drop under `LIBRARY_PATH` |
| `requester_display_name` / `note` | Who asked + free-text notes |
| `series_name` / `series_position` | Series context |

Also returns a top-level `instructions` array — follow it.

## Drop layout

Prefer:

```
$LIBRARY_PATH/
  adult/                         # or kids/ — collection = top-level folder
    Author Name/
      Book Title/
        book.m4b                 # or chapter-*.mp3 / book.epub
```

Collections (`adult/`, `kids/`, …) control **who can see the book** via
grants. Put kids' titles under `kids/` so only accounts with that
collection grant see them.

## Auto-fulfill matching

After scan inserts a new `library_server_books` row, pending requests on
that server flip to `fulfilled` when any of these match:

1. `isbn_13`
2. `open_library_id`
3. `google_books_id`
4. Case-insensitive **title** + overlapping **author** (or title-only if
   the request had no authors)

So: preserve good metadata on the file (ID3 / folder name) and prefer
drops that align with the request title/author.

Manual override (if auto-fulfill misses):

```bash
curl -sS -X POST -H "Authorization: Bearer $TOME_JWT" \
  http://localhost:3000/api/v1/requests/$ID/fulfill
```

## Agent playbook (copy into the agent prompt)

```
You are filling the Tome family library request queue.

1. GET /api/v1/requests/pending on the library server (localhost:3000).
2. For each request oldest-first:
   a. Try every search_hint.
   b. If found via a source the household is allowed to use, place the
      file under LIBRARY_PATH at suggested_path (respect kids/ vs adult/).
   c. If not found, decline with a short note — do not invent a fill.
3. When any files were added, POST /scan and confirm auto-fulfill counts
   in the scan log / re-list pending.
4. Report back: fulfilled titles, declined titles + reasons, still pending.
```

## App-side UX (what family sees)

- **Request a book** (`/request-book`) — catalog search or free text →
  picks a library → pending
- **Requests** (`/requests`) — My requests (pending / ready / declined)
  and, for the owner, From family
- **Today** — "Ready to listen" when a request fulfills; owner queue card
  for pending from others

## Legal / household policy

Tome is DMCA safe-harbor oriented: the host is responsible for what lands
in `LIBRARY_PATH`. The agent should only place content the household is
allowed to have. Prefer purchased files, library loans the family owns,
or public domain — not "whatever a search scrapes."
