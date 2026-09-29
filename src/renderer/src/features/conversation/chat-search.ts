const RESULTS_HIGHLIGHT = "openbot-chat-search-results";
const CURRENT_HIGHLIGHT = "openbot-chat-search-current";

export interface ChatSearchMatch {
  range: Range;
  message: HTMLElement;
}

interface TextSegment {
  node: Text;
  start: number;
  end: number;
}

function highlightRegistry(): HighlightRegistry | undefined {
  return globalThis.CSS?.highlights;
}

export function clearChatSearchHighlights(): void {
  const registry = highlightRegistry();
  registry?.delete(RESULTS_HIGHLIGHT);
  registry?.delete(CURRENT_HIGHLIGHT);
}

export function renderChatSearchHighlights(matches: ChatSearchMatch[], currentIndex: number): void {
  const registry = highlightRegistry();
  if (!registry) return;
  registry.delete(RESULTS_HIGHLIGHT);
  registry.delete(CURRENT_HIGHLIGHT);
  if (matches.length === 0) return;

  const results = new Highlight(...matches.map((match) => match.range));
  results.priority = 1;
  registry.set(RESULTS_HIGHLIGHT, results);

  const current = matches[currentIndex];
  if (!current) return;
  const active = new Highlight(current.range);
  active.priority = 2;
  registry.set(CURRENT_HIGHLIGHT, active);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Whether a text node starts a new rendered line. The searchable text is one string, so a block
 * boundary that carries no character would join the last word of one line to the first word of the
 * next. Reading it as a space keeps a phrase findable across the wrap, and keeps a query that
 * spans the boundary from matching two unrelated words.
 */
function startsNewLine(node: Text): boolean {
  const previous = node.previousSibling;
  if (previous instanceof Element && previous.tagName === "BR") return true;
  const parent = node.parentElement;
  return parent !== null && node === parent.firstChild && parent.previousElementSibling !== null;
}

/**
 * The query as a pattern whose spaces match any run of whitespace. A line break in a message is
 * whitespace too, so a phrase the user typed on one line still finds a message that wraps it, the
 * same way global search already treats both. The `d` flag keeps the exact offsets of a match, so
 * the highlight still lands on the right characters.
 */
function searchPattern(query: string): RegExp | null {
  const terms = query
    .trim()
    .split(/\s+/u)
    .filter((term) => term.length > 0)
    .map((term) => escapeRegExp(term.toLocaleLowerCase()));
  if (terms.length === 0) return null;
  return new RegExp(terms.join("\\s+"), "dgu");
}

export function findChatSearchMatches(root: HTMLElement, query: string): ChatSearchMatch[] {
  const pattern = searchPattern(query);
  if (!pattern) return [];

  const matches: ChatSearchMatch[] = [];
  for (const message of root.querySelectorAll<HTMLElement>("[data-chat-search-message]")) {
    const segments: TextSegment[] = [];
    let text = "";
    const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!(node instanceof Text) || !node.data) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest('[aria-hidden="true"], .sr-only, .message-actions')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node = walker.nextNode();
    while (node) {
      if (!(node instanceof Text)) {
        node = walker.nextNode();
        continue;
      }
      const textNode = node;
      // The gap belongs to no segment, so a highlight that spans it still maps to both sides.
      if (segments.length > 0 && startsNewLine(textNode)) text += " ";
      const start = text.length;
      text += textNode.data;
      segments.push({ node: textNode, start, end: text.length });
      node = walker.nextNode();
    }

    for (const found of text.toLocaleLowerCase().matchAll(pattern)) {
      const [matchStart, matchEnd] = found.indices?.[0] ?? [];
      if (matchStart === undefined || matchEnd === undefined) continue;
      const startSegment = segments.find((segment) => matchStart >= segment.start && matchStart < segment.end);
      const endSegment = segments.find((segment) => matchEnd > segment.start && matchEnd <= segment.end);
      if (startSegment && endSegment) {
        const range = document.createRange();
        range.setStart(startSegment.node, matchStart - startSegment.start);
        range.setEnd(endSegment.node, matchEnd - endSegment.start);
        matches.push({ range, message });
      }
    }
  }
  return matches;
}
