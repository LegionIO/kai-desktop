import { highlight } from 'cli-highlight';

/** Wrap text in an OSC-8 hyperlink escape so terminals that support it make it clickable. */
export function osc8Link(label: string, url: string): string {
  const ESC = '\x1b';
  return `${ESC}]8;;${url}${ESC}\\${label}${ESC}]8;;${ESC}\\`;
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
  const lines = md.split('\n');
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

  // Links [label](url) → OSC-8
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => `${UNDERLINE}${osc8Link(label, url)}${RESET}`);
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
