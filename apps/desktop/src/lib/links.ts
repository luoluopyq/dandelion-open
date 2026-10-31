import { parseKnowledgeCitation, type KnowledgeLocator } from "./knowledge-citations.js";

/** Wiki pages are single filenames, never arbitrary paths supplied by a model. */
export function relativeWikiPage(href: string): string | null {
  try {
    const page = decodeURIComponent(href.replace(/^\.\//, "").split(/[?#]/)[0]);
    if (!/\.md$/i.test(page) || page.includes("..") || /[\\/:\x00-\x1f\x7f]/.test(page)) return null;
    return page;
  } catch { return null; }
}

export interface LinkActions {
  knowledge: (locator: KnowledgeLocator) => void;
  page: (page: string) => void;
  external: (url: string) => Promise<void>;
  notice: (message: string) => void;
}

/** Runs after a reader's own handler, including for links inside teleported dialogs. */
export function handleAppLink(event: MouseEvent, actions: LinkActions): void {
  if (event.defaultPrevented || (event.type === "auxclick" && event.button !== 1)) return;
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!link) return;
  const href = (link.getAttribute("href") ?? "").trim();
  // Always cancel native navigation: the desktop window has no browser back button.
  event.preventDefault();
  const locator = parseKnowledgeCitation(href);
  if (locator) { actions.knowledge(locator); return; }
  if (/^#knowledge(?:-page)?\//.test(href)) { actions.notice("知识链接无效或已失效。"); return; }
  if (href.startsWith("#")) {
    try {
      const id = decodeURIComponent(href.slice(1));
      const root = link.closest(".md, .source-article, .reader-markdown, .wiki-article-body, .wiki-answer-text, .knowledge-prose");
      const target = Array.from(root?.querySelectorAll("[id]") ?? []).find(node => node.id === id);
      target?.scrollIntoView({ block: "start" });
    } catch { /* Malformed fragments must not navigate either. */ }
    return;
  }
  const page = relativeWikiPage(href);
  if (page) { actions.page(page); return; }
  try {
    const url = new URL(href);
    if (["https:", "http:", "mailto:"].includes(url.protocol)) {
      void actions.external(url.href).catch(error => actions.notice(`无法打开链接：${String(error)}`));
      return;
    }
  } catch { /* Relative paths cannot be opened as application routes. */ }
  actions.notice("无法打开此链接，请在知识库中查找对应内容。");
}
