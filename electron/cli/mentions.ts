import { readFileSync, statSync } from 'fs';
import { isAbsolute, resolve } from 'path';

/** Per-file inline cap — a huge @file shouldn't blow up the prompt/context. */
export const MAX_MENTION_BYTES = 256 * 1024; // 256 KiB
/** Cap the number of @file expansions per message. */
export const MAX_MENTIONS = 10;

export type MentionResult = {
  /** The prompt with an appended "Referenced files" section (or unchanged if none). */
  text: string;
  /** Human-readable notes about what happened (attached / skipped-too-big / not-found). */
  notes: string[];
};

// A mention is `@` followed by a path token. Accepts quoted paths with spaces
// (`@"a b.txt"`) and bare tokens up to the next whitespace. Must be preceded by
// start-of-string or whitespace so emails (`a@b`) aren't treated as mentions.
const MENTION_RE = /(^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s"']+))/g;

/**
 * Expand `@path` mentions in a CLI prompt by INLINING the referenced files'
 * contents as text (agent:submit is text-only, so this is how a CLI carries
 * file context). Paths resolve against `cwd`. Each file is size-capped and read
 * as UTF-8; missing / too-large / unreadable / directory targets are skipped
 * with a note rather than failing the whole message. The original `@token`
 * stays in the prompt text (so the model sees what the user referenced); the
 * file bodies are appended under a "Referenced files" section.
 *
 * Note: this does NOT restrict paths to cwd — a CLI user can legitimately
 * reference any file they can read on their own machine (like `cat`). The caps
 * bound resource use, not reachability.
 */
export function expandFileMentions(prompt: string, cwd: string): MentionResult {
  const notes: string[] = [];
  const seen = new Set<string>();
  const attachments: Array<{ display: string; body: string }> = [];

  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(prompt)) !== null) {
    if (attachments.length + notes.length >= MAX_MENTIONS * 2) break; // hard stop on pathological input
    const raw = m[2] ?? m[3] ?? m[4];
    if (!raw) continue;
    if (attachments.length >= MAX_MENTIONS) {
      notes.push(`(reached ${MAX_MENTIONS}-file limit; ignoring further @mentions)`);
      break;
    }
    const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
    if (seen.has(abs)) continue;
    seen.add(abs);

    let st;
    try {
      st = statSync(abs);
    } catch {
      notes.push(`@${raw}: not found`);
      continue;
    }
    if (!st.isFile()) {
      // Skip directories AND special files (fifos, /dev/zero, sockets…): a
      // char-device reports st.size 0 (passing the size cap) but readFileSync
      // would then read forever → OOM. Only regular files are inlined.
      notes.push(`@${raw}: not a regular file (skipped)`);
      continue;
    }
    if (st.size > MAX_MENTION_BYTES) {
      notes.push(`@${raw}: too large (${Math.round(st.size / 1024)} KiB > ${MAX_MENTION_BYTES / 1024} KiB, skipped)`);
      continue;
    }
    let body: string;
    try {
      body = readFileSync(abs, 'utf-8');
    } catch {
      notes.push(`@${raw}: unreadable (skipped)`);
      continue;
    }
    attachments.push({ display: raw, body });
    notes.push(`@${raw}: attached (${Math.round(st.size / 1024) || 1} KiB)`);
  }

  if (attachments.length === 0) return { text: prompt, notes };

  const section = attachments.map((a) => `### ${a.display}\n\`\`\`\n${a.body}\n\`\`\``).join('\n\n');
  const text = `${prompt}\n\n---\nReferenced files:\n\n${section}`;
  return { text, notes };
}
