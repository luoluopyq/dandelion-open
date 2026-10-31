/** Accept internal source identifiers and safe article basenames, never filesystem paths. */
export type KnowledgeLocator = { spaceId: string; chunkId: string } | { spaceId: string; page: string };
export type SourceLocator = KnowledgeLocator | { workspace: string; page: string };
export function parseKnowledgeCitation(href: string): KnowledgeLocator | null {
  const match = /^#knowledge\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/.exec(href);
  if (match) return { spaceId: match[1], chunkId: match[2] };
  const article = /^#knowledge-page\/([a-zA-Z0-9_-]+)\/([^/?#]+)$/.exec(href);
  if (!article) return null;
  try {
    const page = decodeURIComponent(article[2]);
    if (!page.endsWith('.md') || page.includes('..') || /[\\/:\x00-\x1f]/.test(page)) return null;
    return { spaceId: article[1], page };
  } catch { return null; }
}
