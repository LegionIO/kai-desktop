/**
 * Pure conversation content-search helpers.
 *
 * Powers `conversations:search` (title + message-body match) for both the GUI
 * sidebar search box and the CLI. Kept side-effect-free (no I/O) so the match /
 * snippet logic is unit-tested; the IPC handler does the file reads and feeds
 * records in here.
 */

/** A single search hit for a conversation. */
export interface ConversationSearchHit {
  /** Where the term matched. Title matches rank above content matches. */
  matchedIn: 'title' | 'content';
  /** A short excerpt around the first match (for display in the list/picker). */
  snippet: string;
}

/** Max chars of context on each side of a content match in the snippet. */
const SNIPPET_RADIUS = 40;
/** Cap how much message text we scan per conversation (perf guard on huge chats). */
const MAX_SCAN_CHARS = 200_000;

/** Flatten a message's `content` (array of {type,text,...} parts, or a raw
 *  string) into searchable plain text. Only text-bearing parts contribute. */
export function messageTextForSearch(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: string; text?: string };
    if (typeof p.text === 'string' && p.text) out.push(p.text);
  }
  return out.join(' ');
}

/** Build a `…context[term]context…` snippet around the first match in `text`. */
function makeSnippet(text: string, lowerText: string, lowerTerm: string): string {
  const idx = lowerText.indexOf(lowerTerm);
  if (idx < 0) return text.slice(0, SNIPPET_RADIUS * 2).trim();
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + lowerTerm.length + SNIPPET_RADIUS);
  const core = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${core}${end < text.length ? '…' : ''}`;
}

/**
 * Does `conversation` (its title/fallbackTitle + message bodies) match `term`?
 * Returns a hit (with a snippet) or null. Case-insensitive. `term` should be
 * pre-trimmed and non-empty; an empty term returns null (no filter).
 *
 * Title matches take priority (and their snippet is the title). Otherwise the
 * first message whose text contains the term yields a content snippet.
 */
export function matchConversation(
  conversation: {
    title?: string | null;
    fallbackTitle?: string | null;
    messages?: unknown[];
  },
  term: string,
): ConversationSearchHit | null {
  const lowerTerm = term.trim().toLowerCase();
  if (!lowerTerm) return null;

  const title = conversation.title ?? conversation.fallbackTitle ?? '';
  if (title.toLowerCase().includes(lowerTerm)) {
    return { matchedIn: 'title', snippet: title };
  }

  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  let scanned = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const text = messageTextForSearch((msg as { content?: unknown }).content);
    if (!text) continue;
    const lowerText = text.toLowerCase();
    if (lowerText.includes(lowerTerm)) {
      return { matchedIn: 'content', snippet: makeSnippet(text, lowerText, lowerTerm) };
    }
    scanned += text.length;
    if (scanned > MAX_SCAN_CHARS) break; // perf guard: stop scanning a huge chat
  }

  return null;
}
