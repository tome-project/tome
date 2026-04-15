import path from 'path';
import fs from 'fs';

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

export interface ABSSyncResult {
  added: number;
  updated: number;
  skipped: number;
  errors: string[];
  books: Array<{ title: string; author: string; type: string }>;
}

export class AudiobookshelfService {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  private async request(endpoint: string): Promise<any> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`ABS API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  async getLibraries(): Promise<any[]> {
    const data = await this.request('/api/libraries');
    return data.libraries || [];
  }

  async getLibraryItems(libraryId: string, limit = 0): Promise<ABSLibraryItem[]> {
    // limit=0 returns all items
    const data = await this.request(`/api/libraries/${libraryId}/items?limit=${limit}&sort=media.metadata.title`);
    return data.results || [];
  }

  async getItemCover(itemId: string): Promise<Buffer | null> {
    try {
      const response = await fetch(`${this.baseUrl}/api/items/${itemId}/cover`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });

      if (!response.ok) return null;

      return Buffer.from(await response.arrayBuffer());
    } catch {
      return null;
    }
  }

  /**
   * Download cover from ABS and save locally.
   * Returns the relative path to the saved cover, or null.
   */
  async downloadCover(itemId: string, libraryPath: string): Promise<string | null> {
    const coverData = await this.getItemCover(itemId);
    if (!coverData) return null;

    const coversDir = path.join(libraryPath, 'covers');
    if (!fs.existsSync(coversDir)) {
      fs.mkdirSync(coversDir, { recursive: true });
    }

    const coverPath = path.join(coversDir, `${itemId}.jpg`);
    await fs.promises.writeFile(coverPath, coverData);
    return `covers/${itemId}.jpg`;
  }

  /**
   * Map an ABS library item to Tome book fields.
   */
  mapToBook(item: ABSLibraryItem, absLibraryId: string): {
    title: string;
    author: string;
    type: 'epub' | 'audiobook';
    file_path: string;
    description: string | null;
    publisher: string | null;
    series_name: string | null;
    genre: string | null;
    external_id: string;
    external_source: 'audiobookshelf';
  } {
    const meta = item.media.metadata;

    // Determine type based on ABS library content
    const isAudiobook = item.mediaType === 'book' && !item.media.ebookFormat;
    const type = item.media.ebookFormat ? 'epub' : 'audiobook';

    return {
      title: meta.title || 'Unknown Title',
      author: meta.authorName || 'Unknown',
      type,
      file_path: item.path,
      description: meta.description || null,
      publisher: meta.publisher || null,
      series_name: meta.seriesName || null,
      genre: meta.genres?.[0] || null,
      external_id: item.id,
      external_source: 'audiobookshelf' as const,
    };
  }
}
