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
      // Present on the expanded /api/items/:id response; absent on the list endpoint.
      authors?: Array<{ id?: string; name: string }>;
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

  /// Fetch the expanded record for a single item. The list endpoint returns a
  /// minified shape with `authorName` only — the item endpoint also returns
  /// a structured `authors` array that's usable when authorName is empty.
  async getItemDetail(itemId: string): Promise<ABSLibraryItem | null> {
    try {
      return await this.request<ABSLibraryItem>(`/api/items/${itemId}?expanded=1`);
    } catch {
      return null;
    }
  }

  /// Download a cover image for an ABS item as a raw Buffer. Returns null
  /// on any non-200 response — callers should treat that as "no cover".
  async getItemCover(itemId: string): Promise<Buffer | null> {
    const response = await fetch(`${this.baseUrl}/api/items/${itemId}/cover`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
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
