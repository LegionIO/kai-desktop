import { highlight } from 'cli-highlight';

/**
 * Strip raw control characters (ESC, CSI, OSC, C0 except \n\t) from
 * model-controlled text BEFORE we add our own ANSI. Without this, a model could
 * emit escape sequences that move the cursor, recolor the terminal, spoof UI,
 * or inject its own OSC-8 links / clipboard writes. We add formatting ourselves
 * afterward, so the incoming text must be inert.
 */
export function stripControl(s: string): string {
  // Remove C0 controls except tab (0x09) and newline (0x0a), DEL (0x7f), AND
  // the C1 range (0x80-0x9f) — 8-bit CSI/OSC introducers live there and would
  // otherwise reach the terminal. Kills CSI/OSC/SGR injection at the source.
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

/** Protocols allowed in clickable links — never file:, javascript:, data:, etc. */
const SAFE_URL = /^https?:\/\//i;

/** Wrap text in an OSC-8 hyperlink escape so terminals that support it make it
 *  clickable. Only http(s) URLs become links; anything else renders as plain
 *  (already-stripped) text so a malicious URL can't inject escapes or point at
 *  a dangerous scheme. */
export function osc8Link(label: string, url: string): string {
  const safeLabel = stripControl(label);
  if (!SAFE_URL.test(url)) return safeLabel;
  const safeUrl = stripControl(url);
  const ESC = '\x1b';
  return `${ESC}]8;;${safeUrl}${ESC}\\${safeLabel}${ESC}]8;;${ESC}\\`;
}

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const ITALIC = '\x1b[3m';
const UNDERLINE = '\x1b[4m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';

/** Detect a fenced code block's language hint. */
function highlightCode(code: string, lang?: string): string {
  try {
    return highlight(code, { language: lang && lang.length > 0 ? lang : undefined, ignoreIllegals: true });
  } catch {
    return code;
  }
}

/**
 * Render a subset of Markdown to ANSI for the terminal. Handles fenced code
 * (with syntax highlighting), inline code, bold/italic, headings, bullet lists,
 * and [label](url) links (as OSC-8 clickable links). Intentionally small — the
 * goal is a pleasant assistant transcript, not a full CommonMark engine.
 */
export function renderMarkdown(md: string): string {
  const lines = stripControl(md).split('\n');
  const outLines: string[] = [];
  let inFence = false;
  let fenceLang = '';
  let fenceBuf: string[] = [];

  const flushFence = (): void => {
    const highlighted = highlightCode(fenceBuf.join('\n'), fenceLang);
    for (const l of highlighted.split('\n')) outLines.push(`  ${DIM}│${RESET} ${l}`);
    fenceBuf = [];
    fenceLang = '';
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^```(\w*)\s*$/);
    if (fenceMatch) {
      if (inFence) {
        flushFence();
        inFence = false;
      } else {
        inFence = true;
        fenceLang = fenceMatch[1] ?? '';
      }
      continue;
    }
    if (inFence) {
      fenceBuf.push(line);
      continue;
    }
    outLines.push(renderInline(line));
  }
  if (inFence) flushFence(); // unterminated fence — render what we have

  return outLines.join('\n');
}

function renderInline(line: string): string {
  // Headings
  const heading = line.match(/^(#{1,6})\s+(.*)$/);
  if (heading) return `${BOLD}${CYAN}${heading[2]}${RESET}`;

  // Bullets
  const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
  let text = line;
  let prefix = '';
  if (bullet) {
    prefix = `${bullet[1]}${CYAN}•${RESET} `;
    text = bullet[2];
  }

  // Links [label](url) → OSC-8. Label/url quantifiers are BOUNDED to defang a
  // quadratic-backtracking ReDoS: on model-controlled input, repeated unmatched
  // `[` made the unbounded `[^\]]+` rescan the suffix at every position (~2.7s
  // for 80k chars). No real markdown link has a 500-char label / 2000-char URL,
  // so anything longer simply renders unlinked.
  text = text.replace(
    /\[([^\]]{1,500})\]\(([^)]{1,2000})\)/g,
    (_m, label, url) => `${UNDERLINE}${osc8Link(label, url)}${RESET}`,
  );
  // Bare URLs → OSC-8
  text = text.replace(/(^|\s)(https?:\/\/[^\s]+)/g, (_m, sp, url) => `${sp}${UNDERLINE}${osc8Link(url, url)}${RESET}`);
  // Inline code
  text = text.replace(/`([^`]+)`/g, (_m, code) => `${CYAN}${code}${RESET}`);
  // Bold **x**
  text = text.replace(/\*\*([^*]+)\*\*/g, (_m, x) => `${BOLD}${x}${RESET}`);
  // Italic *x* or _x_
  text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_m, x) => `${ITALIC}${x}${RESET}`);
  text = text.replace(/(?<!_)_([^_]+)_(?!_)/g, (_m, x) => `${ITALIC}${x}${RESET}`);

  return prefix + text;
}
