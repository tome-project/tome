import { EPub } from 'epub2';

export interface EpubMetadata {
  title: string;
  author: string;
  description: string | null;
  publisher: string | null;
  language: string | null;
  coverImage: Buffer | null;
}

export async function extractEpubMetadata(filePath: string): Promise<EpubMetadata> {
  return new Promise((resolve, reject) => {
    const epub = new EPub(filePath);

    epub.on('end', async () => {
      const meta = epub.metadata;

      let coverImage: Buffer | null = null;

      if (meta.cover) {
        try {
          coverImage = await new Promise<Buffer>((resImg, rejImg) => {
            epub.getImage(meta.cover, (err: Error, data?: Buffer) => {
              if (err || !data) {
                rejImg(err || new Error('No image data'));
              } else {
                resImg(data);
              }
            });
          });
        } catch {
          // Cover extraction failed — leave as null
          coverImage = null;
        }
      }

      resolve({
        title: meta.title || 'Unknown',
        author: meta.creator || 'Unknown',
        description: meta.description || null,
        publisher: meta.publisher || null,
        language: meta.language || null,
        coverImage,
      });
    });

    epub.on('error', (err: Error) => {
      reject(err);
    });

    epub.parse();
  });
}
