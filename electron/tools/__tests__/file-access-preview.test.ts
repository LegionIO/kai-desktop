// @vitest-environment node
/**
 * previewPathEntry powers the File Access settings "matches N files · allowed"
 * badge. Verify it counts matches under a real temp tree, reports existence +
 * normalized form, honors the /* folder-only glob, and reflects allow/deny.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewPathEntry } from '../file-access.js';
import type { AppConfig } from '../../config/schema.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kai-fa-'));
  writeFileSync(join(root, 'a.txt'), 'a');
  writeFileSync(join(root, 'b.txt'), 'b');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'c.txt'), 'c');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const cfg = (allow: string[], deny: string[] = []): AppConfig =>
  ({ tools: { fileAccess: { enabled: true, allowPaths: allow, denyPaths: deny } } }) as unknown as AppConfig;

describe('previewPathEntry', () => {
  it('counts all files recursively for a plain directory path (subfolders included)', () => {
    const p = previewPathEntry(root, cfg([root]));
    expect(p.exists).toBe(true);
    expect(p.isDirectory).toBe(true);
    expect(p.matchCount).toBe(3); // a.txt, b.txt, sub/c.txt
    expect(p.allowed).toBe(true);
    expect(p.normalized).toBe(root);
  });

  it('counts only direct children for a /* glob (folder-only)', () => {
    const p = previewPathEntry(`${root}/*`, cfg([`${root}/*`]));
    expect(p.matchCount).toBe(2); // a.txt, b.txt — NOT sub/c.txt
  });

  it('reports a non-existent path as not-existing with 0 matches', () => {
    const p = previewPathEntry(join(root, 'nope'), cfg([root]));
    expect(p.exists).toBe(false);
    expect(p.matchCount).toBe(0);
  });

  it('reflects a deny rule', () => {
    const p = previewPathEntry(root, cfg(['*'], [root]));
    expect(p.denied).toBe(true);
    // Denied files are excluded from the match count.
    expect(p.matchCount).toBe(0);
  });

  it('handles the "*" wildcard entry', () => {
    const p = previewPathEntry('*', cfg(['*']));
    expect(p.normalized).toBe('*');
    expect(p.allowed).toBe(true);
  });

  it('is safe on empty/whitespace input', () => {
    expect(previewPathEntry('   ', cfg([root])).matchCount).toBe(0);
  });

  it('reports allowed for a /* glob by evaluating a real matched file (not the base dir)', () => {
    // allowPaths only contains the /* glob — the base dir itself is NOT an entry,
    // so allow must be judged on a matched child file.
    const p = previewPathEntry(`${root}/*`, cfg([`${root}/*`]));
    expect(p.matchCount).toBeGreaterThan(0);
    expect(p.allowed).toBe(true);
  });

  it('does not over-walk a sparse-glob deny entry (bounded, no hang)', () => {
    // A deny glob whose matches are excluded from the count previously left the
    // match-count cap at 0 while walking the whole tree. Bounded now; returns
    // promptly and reports denied via a matched path.
    const started = Date.now();
    const p = previewPathEntry(`${root}/**/*.txt`, cfg(['*'], [`${root}/**/*.txt`]));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(p.denied).toBe(true);
  });
});
