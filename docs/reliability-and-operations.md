# Reliability and operations

Tome's mobile app is a player and reader for a library that stays on the host's computer. The library server owns files, scanning, covers, and authorized range streaming. Supabase owns identity, the shared catalog, shelves, progress, social features, and access grants. A normal library server pairs with the hub and receives a scoped machine account; it does not need a database URL or service-role key.

## Deploying 0.8

Back up the library identity, compose configuration, and database before applying `supabase/migrations/020_reliable_reading_and_access.sql`. Keep `.tome-server.json` private: it contains the machine's password. Apply migrations 020–023 before releasing mobile 0.18. It permits separate audiobook and EPUB files for a catalog title, preserves legacy progress, adds independent format positions with timestamp conflict resolution, hardens ownership and club access, and claims pairing codes atomically.

Build the image from a reviewed revision and pin that image in compose. Test a canary against the existing library mount before switching the public service. Keep the previous image tagged for rollback. Do not overwrite an operator's checkout: create a separate release directory.

`GET /health` reports process liveness. `GET /ready` reports whether this paired server can reach the hub; it returns 503 during a hub outage. Monitor both. A healthy process alone does not prove books can load. Background initialization, heartbeat, and reconciliation use bounded jobs with backoff and retry after failures.

## Administration

`POST /setup/scan` and `POST /setup/reset` require the library owner's Supabase bearer or HTTP Basic authentication using `TOME_ADMIN_TOKEN`. Without an explicit token, the server creates a private `.tome-admin-key` in the library when Basic authentication is first attempted. Pairing/status responses never include machine credentials. Keep the setup interface behind HTTPS or on the local network.

## Scanning

Manual and startup scans use the same coordinator. `POST /scan` starts an owner-only asynchronous scan and returns 202; poll `/pair/status` for completion and the summary. A file's size and modification time, and every multi-track child, identify unchanged metadata in `.tome-scan-cache-v1.json`.

Scanning does not rewrite original audiobooks by default. `TOME_OPTIMIZE_ORIGINALS=1` explicitly enables fast-start rewriting. Subprocess deadlines prevent malformed media from hanging the scan. Covers and temporary club shares are excluded. A scan with parse or database errors preserves old registrations; removal happens only for physically missing paths after a clean scan. Hosting a title does not automatically add it to the owner's personal reading shelf.

A request is fulfilled only when the requested format exists and its requester can access the collection. Acquisition is a separate operator action; reconciliation only matches files already hosted.

## Validation

Run `npm ci`, `npm run lint`, `npm test`, and `npm audit --omit=dev`. Tests cover retry/backoff, interrupted initialization, range requests, and path/symlink containment. Validate migration changes in a rollback transaction and exercise RLS with ordinary users and a scoped machine, not only a service-role client.

## Diagnosing an empty app

Check cloud Auth and REST latency, `/ready`, identity validity, collection grants, token refresh, and whether the mobile device has a local copy. Compare cached rendering with a first install. The mobile client displays cached profile and shelf data during refresh, opens downloaded files before querying the hub, and bounds stalled cloud requests. Offline progress remains queued until a successful upload.

During a Supabase incident, check project-level database/Auth/REST health separately from the global status page. Investigate database logs and pool checkout failures before changing app authentication. Preserve users' sessions during transient failures.

## Book request notifications

Readers opt in using Profile → Book request alerts. Configure a Firebase project with Android and iOS app registrations, and upload an APNs key for iOS. Native Firebase configuration files contain public app identifiers, not server credentials.

The hub requires `GOOGLE_APPLICATION_CREDENTIALS` pointing to a read-only mounted service-account JSON with Firebase Cloud Messaging permission. Keep that JSON outside the image and source control. Migration 021 stores account-scoped device tokens and a private notification outbox. The availability trigger queues a message only after an accessible requested format exists. The hub retries temporary delivery failures, removes expired device tokens, and uses collapse identifiers. Normal library machines do not deliver notifications or read device tokens. Migration 022 keeps progress from older installed clients interoperable. Migration 023 acknowledges deliveries per device so transient failures do not resend successful alerts, and stale notifications expire after one day.
