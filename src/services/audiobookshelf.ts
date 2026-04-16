export interface ABSLibraryItem {
  id: string;
  ino: string;
  libraryId: string;
  mediaType: 'book' | 'podcast';
  media: {
    metadata: {
      title: string;
      subtitle?: string;
      authorName?: string;
      narratorName?: string;
      seriesName?: string;
      genres?: string[];
      publishedYear?: string;
      publisher?: string;
      description?: string;
      isbn?: string;
      language?: string;
    };
    coverPath?: string;
    duration?: number;
    numChapters?: number;
    ebookFormat?: string;
  };
  path: string;
  relPath: string;
  addedAt: number;
  updatedAt: number;
}

export interface ABSLibrary {
  id: string;
  name: string;
  mediaType?: string;
  folders?: Array<{ fullPath?: string }>;
}

export class AudiobookshelfService {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  private async request<T>(endpoint: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) {
      throw new Error(`ABS API error: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  }

  async getLibraries(): Promise<ABSLibrary[]> {
    const data = await this.request<{ libraries?: ABSLibrary[] }>('/api/libraries');
    return data.libraries ?? [];
  }

  async getLibraryItems(libraryId: string, limit = 0): Promise<ABSLibraryItem[]> {
    const data = await this.request<{ results?: ABSLibraryItem[] }>(
      `/api/libraries/${libraryId}/items?limit=${limit}&sort=media.metadata.title`
    );
    return data.results ?? [];
  }
}

// Decide which media type a Tome source should be, given an ABS item.
export function absMediaType(item: ABSLibraryItem): 'epub' | 'audiobook' {
  return item.media.ebookFormat ? 'epub' : 'audiobook';
}

// Extract parseable year from ABS's stringy publishedYear.
export function absPublishedYear(raw: string | undefined): number | null {
  if (!raw) return null;
  const match = raw.match(/\d{4}/);
  return match ? parseInt(match[0], 10) : null;
}
