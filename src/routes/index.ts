// v0.6 library-server-only exports. The hub-side routes (auth, profiles,
// friendships, clubs, etc.) are no longer registered — see ../index.ts.
// Their source files remain on disk under this directory until the
// follow-up cleanup PR removes them; treat them as deprecated.
export { healthRouter } from './health';
export { filesRouter } from './files';
export { coversRouter } from './covers';
export { scannerRouter } from './scanner';

// v0.6 federation routes (new)
export { pairingRouter } from './pairing';
export { setupRouter } from './setup';

// Gutenberg moved off the library server in v0.6. The Flutter app talks
// directly to gutendex.com for catalog browse + downloads the epub from
// gutenberg.org to the device, registering it via the standard
// device-import flow (no library server dependency, so cold installers
// without a library server still get free public-domain books).
