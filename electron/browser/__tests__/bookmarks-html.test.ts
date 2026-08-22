import { constants as fsConstants, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BOOKMARK_IMPORT_OPEN_FLAGS,
  MAX_IMPORTED_BOOKMARKS,
  MAX_IMPORTED_BOOKMARK_FOLDER_CHARS,
  MAX_IMPORTED_BOOKMARK_FOLDER_DEPTH,
  parseBookmarksHtml,
  readBoundedBookmarksHtmlFileSync,
  renderBookmarksHtml,
} from '../bookmarks-html.js';
import type { BrowserBookmark } from '../../../shared/browser.js';

describe('bookmark HTML import/export', () => {
  it('opens imports without blocking on special files', () => {
    if (fsConstants.O_NONBLOCK !== undefined) {
      expect(BOOKMARK_IMPORT_OPEN_FLAGS & fsConstants.O_NONBLOCK).toBe(fsConstants.O_NONBLOCK);
    }
    if (fsConstants.O_NOFOLLOW !== undefined) {
      expect(BOOKMARK_IMPORT_OPEN_FLAGS & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW);
    }
  });

  it('preserves nested folders and ignores non-web URLs', () => {
    const imported = parseBookmarksHtml(`
      <DL><p>
        <DT><H3>Work &amp; Docs</H3>
        <DL><p>
          <DT><A HREF="https://example.com?a=1&amp;b=2">Example</A>
          <DT><H3>Nested</H3>
          <DL><p><DT><A HREF="https://openai.com">OpenAI</A></DL><p>
          <DT><A HREF="javascript:alert(1)">Unsafe</A>
        </DL><p>
      </DL><p>
    `);
    expect(imported).toEqual([
      { title: 'Example', url: 'https://example.com?a=1&b=2', folder: 'Work & Docs' },
      { title: 'OpenAI', url: 'https://openai.com', folder: 'Work & Docs/Nested' },
    ]);
  });

  it('round-trips folders and escapes titles and URLs', () => {
    const bookmarks: BrowserBookmark[] = [
      {
        id: 'bookmark-1',
        scopeKey: 'global',
        title: 'A < B',
        url: 'https://example.com/?a=1&b=2',
        folder: 'Work/Docs',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const html = renderBookmarksHtml(bookmarks);
    expect(html).toContain('<H3>Work</H3>');
    expect(html).toContain('<H3>Docs</H3>');
    expect(html).toContain('A &lt; B');
    expect(parseBookmarksHtml(html)).toEqual([
      { title: 'A < B', url: 'https://example.com/?a=1&b=2', folder: 'Work/Docs' },
    ]);
  });

  it('bounds bookmark count and deeply nested folder expansion', () => {
    const deep = Array.from(
      { length: MAX_IMPORTED_BOOKMARK_FOLDER_DEPTH + 20 },
      (_, index) => `<H3>folder-${index}</H3><DL>`,
    ).join('');
    const closing = '</DL>'.repeat(MAX_IMPORTED_BOOKMARK_FOLDER_DEPTH + 20);
    const [imported] = parseBookmarksHtml(`${deep}<A HREF="https://example.com">Example</A>${closing}`);
    expect(imported.folder.split('/')).toHaveLength(MAX_IMPORTED_BOOKMARK_FOLDER_DEPTH);
    expect(imported.folder.length).toBeLessThanOrEqual(MAX_IMPORTED_BOOKMARK_FOLDER_CHARS);

    const tooMany = Array.from(
      { length: MAX_IMPORTED_BOOKMARKS + 1 },
      (_, index) => `<A HREF="https://example.com/${index}">${index}</A>`,
    ).join('');
    expect(() => parseBookmarksHtml(tooMany)).toThrow(/limited to 10,000 entries/);
  });

  it('parses repeated unclosed anchors without catastrophic backtracking', () => {
    const malformed = '<A HREF="https://example.com">'.repeat(2_000);
    expect(parseBookmarksHtml(malformed)).toEqual([]);
  });

  it('reads and enforces the byte limit through one open file description', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kai-bookmark-import-'));
    const filePath = join(directory, 'bookmarks.html');
    try {
      writeFileSync(filePath, '12345');
      expect(readBoundedBookmarksHtmlFileSync(filePath, 5)).toBe('12345');
      expect(() => readBoundedBookmarksHtmlFileSync(filePath, 4)).toThrow(/exceeds the 10 MB limit/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
