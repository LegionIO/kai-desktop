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
  it('finds matches under a directory path (approximate/shallow probe, not exact)', async () => {
    const p = await previewPathEntry(root, cfg([root]));
    expect(p.exists).toBe(true);
    expect(p.isDirectory).toBe(true);
    // Shallow probe: an indicator that it matches SOMETHING, not an exact total.
    expect(p.matchCount).toBeGreaterThan(0);
    // A directory implies deeper content beyond the shallow scan → marked capped.
    expect(p.capped).toBe(true);
    expect(p.allowed).toBe(true);
    expect(p.normalized).toBe(root);
  });

  it('a /* glob still matches direct-child files', async () => {
    const p = await previewPathEntry(`${root}/*`, cfg([`${root}/*`]));
    expect(p.matchCount).toBeGreaterThan(0); // a.txt / b.txt
  });

  it('reports a non-existent path as not-existing with 0 matches', async () => {
    const p = await previewPathEntry(join(root, 'nope'), cfg([root]));
    expect(p.exists).toBe(false);
    expect(p.matchCount).toBe(0);
  });

  it('reflects a deny rule', async () => {
    const p = await previewPathEntry(root, cfg(['*'], [root]));
    expect(p.denied).toBe(true);
    // Denied files are excluded from the match count.
    expect(p.matchCount).toBe(0);
  });

  it('handles the "*" wildcard entry — allowed when it is the allow rule', async () => {
    const p = await previewPathEntry('*', cfg(['*']));
    expect(p.normalized).toBe('*');
    expect(p.allowed).toBe(true);
  });

  it('the "*" wildcard reflects a deny rule (not hardcoded allowed)', async () => {
    const p = await previewPathEntry('*', cfg(['*'], ['*']));
    expect(p.denied).toBe(true);
    expect(p.allowed).toBe(false);
  });

  it('is safe on empty/whitespace input', async () => {
    expect((await previewPathEntry('   ', cfg([root]))).matchCount).toBe(0);
  });

  it('reports allowed for a /* glob by evaluating a real matched file (not the base dir)', async () => {
    // allowPaths only contains the /* glob — the base dir itself is NOT an entry,
    // so allow must be judged on a matched child file.
    const p = await previewPathEntry(`${root}/*`, cfg([`${root}/*`]));
    expect(p.matchCount).toBeGreaterThan(0);
    expect(p.allowed).toBe(true);
  });

  it('does not fan out into synchronous per-child scans (bounded, returns promptly)', async () => {
    const started = Date.now();
    const p = await previewPathEntry(`${root}/**/*.txt`, cfg(['*'], [`${root}/**/*.txt`]));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(p.denied).toBe(true);
  });

  it('the "*" rule is flagged matchesAll (badge shows "all files", not a count)', async () => {
    const p = await previewPathEntry('*', cfg(['*']));
    expect(p.matchesAll).toBe(true);
  });
});
