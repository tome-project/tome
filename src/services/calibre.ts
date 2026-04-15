import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';

export interface CalibreBook {
  calibreId: number;
  title: string;
  author: string;
  bookPath: string;
  filePath: string | null;
  coverPath: string | null;
  format: string | null;
}

/**
 * Reads a Calibre library's metadata.db and returns all importable books.
 */
export function getCalibreBooks(calibrePath: string): CalibreBook[] {
  const dbPath = path.join(calibrePath, 'metadata.db');
  if (!fs.existsSync(dbPath)) {
    throw new Error(`metadata.db not found at ${dbPath}`);
  }

  const db = new Database(dbPath, { readonly: true });

  try {
    const rows = db.prepare(
      'SELECT b.id, b.title, b.author_sort, b.path FROM books b'
    ).all() as Array<{ id: number; title: string; author_sort: string; path: string }>;

    const books: CalibreBook[] = [];

    for (const row of rows) {
      const fullBookDir = path.join(calibrePath, row.path);

      // Scan the book directory for supported file formats and cover
      let filePath: string | null = null;
      let coverPath: string | null = null;
      let format: string | null = null;

      if (fs.existsSync(fullBookDir)) {
        const files = fs.readdirSync(fullBookDir);

        // Priority order for book files
        const formatPriority = ['.epub', '.pdf', '.m4b', '.mp3'];
        for (const ext of formatPriority) {
          const match = files.find((f) => f.toLowerCase().endsWith(ext));
          if (match) {
            filePath = path.join(fullBookDir, match);
            format = ext.replace('.', '');
            break;
          }
        }

        // Check for cover
        const coverFile = files.find(
          (f) => f.toLowerCase() === 'cover.jpg' || f.toLowerCase() === 'cover.jpeg'
        );
        if (coverFile) {
          coverPath = path.join(fullBookDir, coverFile);
        }
      }

      books.push({
        calibreId: row.id,
        title: row.title,
        author: row.author_sort,
        bookPath: row.path,
        filePath,
        coverPath,
        format,
      });
    }

    return books;
  } finally {
    db.close();
  }
}
