import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { expandFileMentions, MAX_MENTION_BYTES } from '../mentions.js';

describe('expandFileMentions', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mentions-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the prompt unchanged when there are no mentions', () => {
    const r = expandFileMentions('just a plain prompt', dir);
    expect(r.text).toBe('just a plain prompt');
    expect(r.notes).toEqual([]);
  });

  it('inlines a referenced file body under a Referenced files section', () => {
    writeFileSync(join(dir, 'a.txt'), 'hello file');
    const r = expandFileMentions('look at @a.txt please', dir);
    expect(r.text).toContain('look at @a.txt please');
    expect(r.text).toContain('Referenced files:');
    expect(r.text).toContain('### a.txt');
    expect(r.text).toContain('hello file');
    expect(r.notes.some((n) => n.includes('a.txt: attached'))).toBe(true);
  });

  it('notes a missing file and leaves prompt text intact', () => {
    const r = expandFileMentions('read @nope.txt', dir);
    expect(r.text).toBe('read @nope.txt');
    expect(r.notes).toContain('@nope.txt: not found');
  });

  it('skips a directory target', () => {
    mkdirSync(join(dir, 'sub'));
    const r = expandFileMentions('@sub', dir);
    expect(r.notes.some((n) => n.includes('not a regular file'))).toBe(true);
    expect(r.text).toBe('@sub');
  });

  it('skips an over-large file', () => {
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(MAX_MENTION_BYTES + 1));
    const r = expandFileMentions('@big.txt', dir);
    expect(r.notes.some((n) => n.includes('too large'))).toBe(true);
    expect(r.text).toBe('@big.txt');
  });

  it('does not treat an email address as a mention', () => {
    const r = expandFileMentions('mail me at me@example.com', dir);
    expect(r.text).toBe('mail me at me@example.com');
    expect(r.notes).toEqual([]);
  });

  it('handles a quoted path with spaces', () => {
    writeFileSync(join(dir, 'a b.txt'), 'spaced');
    const r = expandFileMentions('open @"a b.txt"', dir);
    expect(r.text).toContain('spaced');
    expect(r.notes.some((n) => n.includes('a b.txt: attached'))).toBe(true);
  });

  it('deduplicates repeated mentions of the same file', () => {
    writeFileSync(join(dir, 'a.txt'), 'once');
    const r = expandFileMentions('@a.txt and again @a.txt', dir);
    const attachCount = (r.text.match(/### a\.txt/g) ?? []).length;
    expect(attachCount).toBe(1);
  });
});
