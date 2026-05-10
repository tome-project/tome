import { hubClient } from './hub';

/// When the scanner registers a new library_server_books row, flip any
/// matching pending book_requests on the same server to fulfilled. This
/// closes the Jellyseerr-style loop: a friend asks for "DCC Book 3", the
/// owner drops the file in LIBRARY_PATH, the next scan picks it up and
/// the request flips automatically (no manual "mark fulfilled" needed).
///
/// Match key is isbn_13 — the strongest external signal book_requests
/// carries that catalog rows also store. (Title/author fuzzy-match was
/// considered but too noisy: false positives would silently fulfill
/// requests with the wrong book.)
///
/// Caller is responsible for only invoking this on the *insert* branch;
/// re-running on every update is wasteful but not unsafe (the
/// status='pending' guard short-circuits).
export async function autoFulfillRequests(params: {
  serverId: string;
  catalogBookId: string;
  isbn13: string | null;
}): Promise<void> {
  if (!params.isbn13) return;
  try {
    await hubClient()
      .from('book_requests')
      .update({
        status: 'fulfilled',
        fulfilled_at: new Date().toISOString(),
        fulfilled_book_id: params.catalogBookId,
      })
      .eq('server_id', params.serverId)
      .eq('status', 'pending')
      .eq('isbn_13', params.isbn13);
  } catch (err) {
    // Best-effort: a failed fulfillment shouldn't break the scan.
    console.error('[auto-fulfill] failed:', err);
  }
}
