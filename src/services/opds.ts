import { XMLParser } from 'fast-xml-parser';

export interface OPDSEntry {
  id: string;
  title: string;
  author: string | null;
  summary: string | null;
  coverUrl: string | null;
  acquisitionUrl: string | null;
  acquisitionType: string | null;
  navigationUrl: string | null;
}

export interface OPDSLink {
  rel: string;
  href: string;
  type?: string;
}

export interface OPDSFeed {
  title: string;
  entries: OPDSEntry[];
  links: OPDSLink[];
}

/**
 * Parse an OPDS Atom XML feed into a structured JSON object.
 */
export function parseFeed(xml: string): OPDSFeed {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => name === 'entry' || name === 'link' || name === 'author',
  });

  const parsed = parser.parse(xml);
  const feed = parsed.feed || parsed['feed'] || {};

  const title = feed.title || '';

  // Parse top-level links
  const rawLinks: any[] = Array.isArray(feed.link) ? feed.link : feed.link ? [feed.link] : [];
  const links: OPDSLink[] = rawLinks.map((l: any) => ({
    rel: l['@_rel'] || '',
    href: l['@_href'] || '',
    type: l['@_type'] || undefined,
  }));

  // Parse entries
  const rawEntries: any[] = Array.isArray(feed.entry) ? feed.entry : feed.entry ? [feed.entry] : [];

  const entries: OPDSEntry[] = rawEntries.map((entry: any) => {
    const entryLinks: any[] = Array.isArray(entry.link) ? entry.link : entry.link ? [entry.link] : [];

    let coverUrl: string | null = null;
    let acquisitionUrl: string | null = null;
    let acquisitionType: string | null = null;
    let navigationUrl: string | null = null;

    for (const link of entryLinks) {
      const rel = (link['@_rel'] || '').toLowerCase();
      const type = (link['@_type'] || '').toLowerCase();
      const href = link['@_href'] || '';

      if (rel.includes('image') || rel.includes('thumbnail')) {
        coverUrl = href;
      } else if (rel.includes('acquisition')) {
        acquisitionUrl = href;
        acquisitionType = link['@_type'] || null;
      } else if (rel === 'subsection' || type.includes('navigation') || type.includes('atom+xml')) {
        navigationUrl = href;
      }
    }

    // Extract author name
    let author: string | null = null;
    if (entry.author) {
      const authors = Array.isArray(entry.author) ? entry.author : [entry.author];
      author = authors.map((a: any) => a.name || '').filter(Boolean).join(', ') || null;
    }

    return {
      id: entry.id || '',
      title: typeof entry.title === 'string' ? entry.title : entry.title?.['#text'] || '',
      author,
      summary: entry.summary || entry.content || null,
      coverUrl,
      acquisitionUrl,
      acquisitionType,
      navigationUrl,
    };
  });

  return { title, entries, links };
}
