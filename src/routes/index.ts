// v0.6 library-server-only exports. The hub-side routes (auth, profiles,
// friendships, clubs, etc.) are no longer registered — see ../index.ts.
// Their source files remain on disk under this directory until the
// follow-up cleanup PR removes them; treat them as deprecated.
export { healthRouter } from './health';
export { filesRouter } from './files';
export { coversRouter } from './covers';
export { scannerRouter } from './scanner';
export { gutenbergRouter } from './gutenberg';

// v0.6 federation routes (new)
export { pairingRouter } from './pairing';
export { setupRouter } from './setup';
