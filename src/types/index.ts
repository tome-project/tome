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
  is_public: boolean;
}

export type BookType = 'epub' | 'audiobook';

export interface Book {
  id: string;
  library_id: string;
  title: string;
  author: string;
  cover_url: string | null;
  file_path: string;
  type: BookType;
}

export interface Progress {
  id: string;
  user_id: string;
  book_id: string;
  position: string;
  percentage: number;
  updated_at: string;
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
