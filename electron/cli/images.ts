import { readFileSync, statSync } from 'fs';
import { isAbsolute, resolve, extname } from 'path';

/** Cap on an image attachment read from disk (raw bytes, pre-base64). */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MiB

const IMAGE_EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

export type CliImageAttachment = { image: string; mimeType?: string };

/** True when a path's extension is a recognized image type. */
export function isImagePath(p: string): boolean {
  return extname(p).toLowerCase() in IMAGE_EXT_MIME;
}

export type ImageMentionResult = {
  attachments: CliImageAttachment[];
  /** The prompt with @image tokens removed (their file bodies aren't inlined as text). */
  text: string;
  notes: string[];
};

// `@` + a path token that ends in an image extension (bare or quoted). Preceded
// by start/whitespace so `a@b` emails aren't matched. The image-extension
// requirement is what distinguishes these from @file text mentions.
const IMAGE_MENTION_RE = /(^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s"']+))/g;

/**
 * Extract `@image.png`-style mentions, load each as a base64 data URL image
 * attachment (agent:submit now accepts image parts), and strip the matched
 * token from the prompt text. Only tokens whose path has a known image
 * extension are treated as images — other @tokens are left in place for the
 * text @file handler. Missing / oversized / non-image files are skipped with a
 * note. Paths resolve against `cwd`.
 */
export function extractImageMentions(prompt: string, cwd: string): ImageMentionResult {
  const attachments: CliImageAttachment[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  const strip: Array<{ start: number; end: number }> = [];

  let m: RegExpExecArray | null;
  IMAGE_MENTION_RE.lastIndex = 0;
  while ((m = IMAGE_MENTION_RE.exec(prompt)) !== null) {
    const raw = m[2] ?? m[3] ?? m[4];
    if (!raw || !isImagePath(raw)) continue; // not an image mention — leave for @file
    const tokenStart = m.index + m[1].length; // skip the leading space in the match
    strip.push({ start: tokenStart, end: m.index + m[0].length });

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
      notes.push(`@${raw}: not a file`);
      continue;
    }
    if (st.size > MAX_IMAGE_BYTES) {
      notes.push(`@${raw}: too large (${Math.round(st.size / 1024 / 1024)} MiB, skipped)`);
      continue;
    }
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch {
      notes.push(`@${raw}: unreadable (skipped)`);
      continue;
    }
    const mime = IMAGE_EXT_MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream';
    attachments.push({ image: `data:${mime};base64,${buf.toString('base64')}`, mimeType: mime });
    notes.push(`@${raw}: attached image (${Math.round(st.size / 1024) || 1} KiB)`);
  }

  if (strip.length === 0) return { attachments, text: prompt, notes };

  // Remove the matched image tokens from the prompt text (last→first so indices
  // stay valid), then collapse any doubled spaces the removal left behind.
  let text = prompt;
  for (const s of strip.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, s.start) + text.slice(s.end);
  }
  text = text.replace(/[ \t]{2,}/g, ' ').trim();
  return { attachments, text, notes };
}
