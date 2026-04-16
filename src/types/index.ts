// Standard API response format
export interface ApiResponse<T = unknown> {
  success: boolean;
  data: T;
  error?: string;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  created_at: string;
}

export type Privacy = 'public' | 'circle' | 'private';

export interface UserProfile {
  user_id: string;
  handle: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
  handle_claimed: boolean;
  library_privacy: Privacy;
  activity_privacy: Privacy;
  review_privacy: Privacy;
  highlight_privacy: Privacy;
  note_privacy: Privacy;
  created_at: string;
  updated_at: string;
}

export interface PublicProfile {
  user_id: string;
  handle: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
}

// ---------------------------------------------------------------------------
// Friendships
// ---------------------------------------------------------------------------

export type FriendshipStatus = 'pending' | 'accepted' | 'blocked';

export interface Friendship {
  id: string;
  user_a_id: string;
  user_b_id: string;
  status: FriendshipStatus;
  requested_by: string;
  requested_at: string;
  accepted_at: string | null;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface Book {
  id: string;
  open_library_id: string | null;
  isbn_13: string | null;
  isbn_10: string | null;
  google_books_id: string | null;
  title: string;
  subtitle: string | null;
  authors: string[];
  cover_url: string | null;
  description: string | null;
  publisher: string | null;
  published_year: number | null;
  page_count: number | null;
  genres: string[];
  language: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// User ↔ book relationship + reading state
// ---------------------------------------------------------------------------

export type UserBookStatus = 'want' | 'reading' | 'finished' | 'dnf';

export interface UserBook {
  id: string;
  user_id: string;
  book_id: string;
  status: UserBookStatus;
  rating: number | null;
  review: string | null;
  review_privacy: Privacy | null;
  favorite_quote: string | null;
  started_at: string | null;
  finished_at: string | null;
  privacy: Privacy;
  created_at: string;
  updated_at: string;
}

export interface ReadingProgress {
  id: string;
  user_id: string;
  book_id: string;
  position: string;
  percentage: number;
  source_kind: string | null;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Book sources (file providers)
// ---------------------------------------------------------------------------

export type BookSourceKind = 'upload' | 'gutenberg' | 'audiobookshelf' | 'calibre' | 'opds';
export type MediaType = 'epub' | 'audiobook';

export interface BookSource {
  id: string;
  book_id: string;
  owner_id: string;
  kind: BookSourceKind;
  media_type: MediaType;
  file_path: string | null;
  external_id: string | null;
  external_url: string | null;
  media_server_id: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Media servers (Phase 1) — persistent connections with encrypted tokens
// ---------------------------------------------------------------------------

export type MediaServerKind = 'audiobookshelf' | 'calibre' | 'opds' | 'plex';

export interface MediaServer {
  id: string;
  owner_id: string;
  name: string;
  kind: MediaServerKind;
  url: string;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServerShare {
  id: string;
  media_server_id: string;
  grantee_id: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Clubs
// ---------------------------------------------------------------------------

export type ClubMemberRole = 'host' | 'moderator' | 'member';

export interface Club {
  id: string;
  book_id: string;
  host_id: string;
  name: string;
  invite_code: string;
  start_date: string;
  end_date: string | null;
  created_at: string;
}

export interface ClubMember {
  id: string;
  club_id: string;
  user_id: string;
  role: ClubMemberRole;
  joined_at: string;
}

export interface Discussion {
  id: string;
  club_id: string;
  user_id: string;
  chapter: number;
  content: string;
  parent_id: string | null;
  created_at: string;
}
