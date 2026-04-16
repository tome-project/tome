// Standard API response format
export interface ApiResponse<T = unknown> {
  success: boolean;
  data: T;
  error?: string;
}

// Core data models
export interface User {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  created_at: string;
}

export interface Library {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  invite_code: string | null;
  is_public: boolean;
  created_at: string;
}

export type LibraryMemberRole = 'owner' | 'member';

export interface LibraryMember {
  id: string;
  library_id: string;
  user_id: string;
  role: LibraryMemberRole;
  joined_at: string;
}

export type BookType = 'epub' | 'audiobook';

export type ExternalSource = 'audiobookshelf' | 'gutenberg' | 'upload' | 'scan' | 'calibre' | 'opds';

export interface Book {
  id: string;
  library_id: string | null;
  title: string;
  author: string;
  cover_url: string | null;
  file_path: string;
  type: BookType;
  genre: string | null;
  page_count: number | null;
  description: string | null;
  publisher: string | null;
  series_name: string | null;
  series_number: number | null;
  external_id: string | null;
  external_source: ExternalSource | null;
}

export type ReadingStatus = 'want_to_read' | 'reading' | 'finished' | 'dnf';

export interface Progress {
  id: string;
  user_id: string;
  book_id: string;
  position: string;
  percentage: number;
  updated_at: string;
  status: ReadingStatus;
  start_date: string | null;
  finish_date: string | null;
  rating: number | null;
  review: string | null;
  favorite_quote: string | null;
}

export type WishlistPriority = 'low' | 'medium' | 'high';

export interface Wishlist {
  id: string;
  user_id: string;
  title: string;
  author: string;
  cover_url: string | null;
  genre: string | null;
  priority: WishlistPriority;
  notes: string | null;
  added_at: string;
}

export interface Club {
  id: string;
  book_id: string;
  host_id: string;
  name: string;
  invite_code: string;
  start_date: string;
  end_date: string;
}

export interface ClubMember {
  id: string;
  club_id: string;
  user_id: string;
  joined_at: string;
}

export interface Discussion {
  id: string;
  club_id: string;
  user_id: string;
  chapter: number;
  content: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Phase 0 schema additions
// ---------------------------------------------------------------------------

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
