import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';
import type { BrowserBookmark } from '../../shared/browser.js';

export type ImportedBrowserBookmark = Pick<BrowserBookmark, 'title' | 'url' | 'folder'>;

export const MAX_IMPORTED_BOOKMARKS = 10_000;
export const MAX_IMPORTED_BOOKMARK_FOLDER_DEPTH = 32;
export const MAX_IMPORTED_BOOKMARK_FOLDER_CHARS = 2_048;
export const MAX_BOOKMARK_IMPORT_BYTES = 10 * 1024 * 1024;

const BOOKMARK_READ_CHUNK_BYTES = 64 * 1024;
export const BOOKMARK_IMPORT_OPEN_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/** Read from one already-open file description and stop after one byte beyond
 * the budget. A selected path can be replaced or grown after the native dialog
 * returns, so a separate stat(path) followed by readFile(path) is not a bound. */
export function readBoundedBookmarksHtmlFileSync(filePath: string, maxBytes = MAX_BOOKMARK_IMPORT_BYTES): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Bookmark import size limit is invalid.');
  // Open nonblocking before checking the descriptor type. A path selected in
  // the native dialog can be replaced with a FIFO before this call; a blocking
  // read-only open would freeze Electron's main process waiting for a writer.
  // O_NOFOLLOW also keeps the type check bound to the selected path itself.
  const descriptor = openSync(filePath, BOOKMARK_IMPORT_OPEN_FLAGS);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error('Bookmark import must be a regular file.');
    if (metadata.size > maxBytes) throw new Error('Bookmark import exceeds the 10 MB limit.');

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const capacity = Math.min(BOOKMARK_READ_CHUNK_BYTES, maxBytes + 1 - total);
      if (capacity < 1) break;
      const chunk = Buffer.allocUnsafe(capacity);
      const bytesRead = readSync(descriptor, chunk, 0, capacity, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) throw new Error('Bookmark import exceeds the 10 MB limit.');
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

function stripHtmlTags(value: string): string {
  let output = '';
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf('<', cursor);
    if (start < 0) return output + value.slice(cursor);
    output += value.slice(cursor, start);
    const end = value.indexOf('>', start + 1);
    if (end < 0) return output + value.slice(start);
    cursor = end + 1;
  }
  return output;
}

function decodeHtml(value: string): string {
  return stripHtmlTags(value)
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (match, code: string) => {
      const hexadecimal = /^x/i.test(code);
      const point = Number.parseInt(hexadecimal ? code.slice(1) : code, hexadecimal ? 16 : 10);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .trim();
}

function isTagNameCharacter(value: string): boolean {
  return /[a-z0-9]/i.test(value);
}

function parsedTagName(source: string): { closing: boolean; name: string } | null {
  let cursor = 0;
  while (/\s/.test(source[cursor] ?? '')) cursor++;
  const closing = source[cursor] === '/';
  if (closing) {
    cursor++;
    while (/\s/.test(source[cursor] ?? '')) cursor++;
  }
  const start = cursor;
  while (isTagNameCharacter(source[cursor] ?? '')) cursor++;
  if (cursor === start) return null;
  return { closing, name: source.slice(start, cursor).toLowerCase() };
}

function quotedAttribute(source: string, wantedName: string): string | null {
  let cursor = 0;
  while (cursor < source.length && !/\s/.test(source[cursor])) cursor++;
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? '')) cursor++;
    const nameStart = cursor;
    while (cursor < source.length && !/[\s=/>]/.test(source[cursor])) cursor++;
    if (cursor === nameStart) {
      cursor++;
      continue;
    }
    const name = source.slice(nameStart, cursor).toLowerCase();
    while (/\s/.test(source[cursor] ?? '')) cursor++;
    if (source[cursor] !== '=') continue;
    cursor++;
    while (/\s/.test(source[cursor] ?? '')) cursor++;
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") {
      while (cursor < source.length && !/\s/.test(source[cursor])) cursor++;
      continue;
    }
    const valueStart = ++cursor;
    const valueEnd = source.indexOf(quote, valueStart);
    if (valueEnd < 0) return null;
    if (name === wantedName) return source.slice(valueStart, valueEnd);
    cursor = valueEnd + 1;
  }
  return null;
}

function closingElement(
  html: string,
  lowerHtml: string,
  name: 'a' | 'h3',
  from: number,
): { start: number; end: number } | null {
  const marker = `</${name}`;
  let start = lowerHtml.indexOf(marker, from);
  while (start >= 0) {
    const boundary = lowerHtml[start + marker.length];
    if (boundary === '>' || /\s/.test(boundary ?? '')) {
      const end = html.indexOf('>', start + marker.length);
      return end < 0 ? null : { start, end: end + 1 };
    }
    start = lowerHtml.indexOf(marker, start + marker.length);
  }
  return null;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function parseBookmarksHtml(html: string): ImportedBrowserBookmark[] {
  // Scan once with indexOf rather than matching whole elements with a lazy,
  // backtracking regex. A malformed file containing thousands of unclosed
  // anchors must remain O(n) on Electron's main process.
  const lowerHtml = html.toLowerCase();
  const folders: Array<string | null> = [];
  const bookmarks: ImportedBrowserBookmark[] = [];
  let pendingFolder: string | null = null;
  let skippedFolderDepth = 0;
  let cursor = 0;

  while (cursor < html.length) {
    const tagStart = html.indexOf('<', cursor);
    if (tagStart < 0) break;
    const tagEnd = html.indexOf('>', tagStart + 1);
    if (tagEnd < 0) break;
    const tagSource = html.slice(tagStart + 1, tagEnd);
    const tag = parsedTagName(tagSource);
    cursor = tagEnd + 1;
    if (!tag) continue;

    if (!tag.closing && (tag.name === 'h3' || tag.name === 'a')) {
      const closing = closingElement(html, lowerHtml, tag.name, cursor);
      // No later element can be trusted to start outside this malformed open
      // element. Stop rather than repeatedly rescanning the remaining suffix.
      if (!closing) break;
      const content = html.slice(cursor, closing.start);
      cursor = closing.end;
      if (tag.name === 'h3') {
        pendingFolder = decodeHtml(content).slice(0, MAX_IMPORTED_BOOKMARK_FOLDER_CHARS);
        continue;
      }
      if (bookmarks.length >= MAX_IMPORTED_BOOKMARKS) {
        throw new Error(`Bookmark import is limited to ${MAX_IMPORTED_BOOKMARKS.toLocaleString()} entries.`);
      }
      const href = decodeHtml(quotedAttribute(tagSource, 'href') ?? '');
      if (!/^https?:/i.test(href)) continue;
      const title = decodeHtml(content) || href;
      bookmarks.push({
        title,
        url: href,
        folder: folders
          .filter((folder): folder is string => !!folder)
          .join('/')
          .slice(0, MAX_IMPORTED_BOOKMARK_FOLDER_CHARS),
      });
    } else if (!tag.closing && tag.name === 'dl') {
      if (folders.length < MAX_IMPORTED_BOOKMARK_FOLDER_DEPTH && skippedFolderDepth === 0) {
        folders.push(pendingFolder || null);
      } else {
        skippedFolderDepth++;
      }
      pendingFolder = null;
    } else if (tag.closing && tag.name === 'dl') {
      if (skippedFolderDepth > 0) skippedFolderDepth--;
      else folders.pop();
    }
  }
  return bookmarks;
}

type BookmarkFolder = {
  bookmarks: BrowserBookmark[];
  children: Map<string, BookmarkFolder>;
};

function renderFolder(folder: BookmarkFolder, depth: number): string[] {
  const indent = '    '.repeat(depth);
  const lines = folder.bookmarks.map(
    (bookmark) => `${indent}<DT><A HREF="${escapeHtml(bookmark.url)}">${escapeHtml(bookmark.title)}</A>`,
  );
  for (const [name, child] of folder.children) {
    lines.push(`${indent}<DT><H3>${escapeHtml(name)}</H3>`);
    lines.push(`${indent}<DL><p>`);
    lines.push(...renderFolder(child, depth + 1));
    lines.push(`${indent}</DL><p>`);
  }
  return lines;
}

export function renderBookmarksHtml(bookmarks: BrowserBookmark[]): string {
  const root: BookmarkFolder = { bookmarks: [], children: new Map() };
  for (const bookmark of bookmarks) {
    let folder = root;
    for (const segment of bookmark.folder
      .split('/')
      .map((value) => value.trim())
      .filter(Boolean)) {
      let child = folder.children.get(segment);
      if (!child) {
        child = { bookmarks: [], children: new Map() };
        folder.children.set(segment, child);
      }
      folder = child;
    }
    folder.bookmarks.push(bookmark);
  }
  const body = renderFolder(root, 1).join('\n');
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${body}\n</DL><p>\n`;
}
