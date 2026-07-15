import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractImageMentions,
  isImagePath,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_MENTIONS,
  MAX_IMAGE_TOTAL_BYTES,
} from '../images.js';

describe('isImagePath', () => {
  it('recognizes image extensions (case-insensitive)', () => {
    expect(isImagePath('a.png')).toBe(true);
    expect(isImagePath('a.JPG')).toBe(true);
    expect(isImagePath('a.webp')).toBe(true);
    expect(isImagePath('a.txt')).toBe(false);
    expect(isImagePath('a')).toBe(false);
  });
});

describe('extractImageMentions', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-img-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('no image mentions → prompt unchanged, no attachments', () => {
    const r = extractImageMentions('hello there', dir);
    expect(r.attachments).toEqual([]);
    expect(r.text).toBe('hello there');
  });

  it('inlines an image as a base64 data-URL attachment and strips the token', () => {
    writeFileSync(join(dir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = extractImageMentions('look @pic.png closely', dir);
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0].image.startsWith('data:image/png;base64,')).toBe(true);
    expect(r.attachments[0].mimeType).toBe('image/png');
    expect(r.text).toBe('look closely'); // token stripped, spaces collapsed
  });

  it('leaves a non-image @token for the text @file handler', () => {
    writeFileSync(join(dir, 'notes.txt'), 'hi');
    const r = extractImageMentions('read @notes.txt', dir);
    expect(r.attachments).toEqual([]);
    expect(r.text).toBe('read @notes.txt');
  });

  it('notes a missing image', () => {
    const r = extractImageMentions('@gone.png', dir);
    expect(r.attachments).toEqual([]);
    expect(r.notes.some((n) => n.includes('not found'))).toBe(true);
  });

  it('skips an over-large image', () => {
    writeFileSync(join(dir, 'huge.png'), Buffer.alloc(MAX_IMAGE_BYTES + 1));
    const r = extractImageMentions('@huge.png', dir);
    expect(r.attachments).toEqual([]);
    expect(r.notes.some((n) => n.includes('too large'))).toBe(true);
  });

  it('does not treat an email as an image mention', () => {
    const r = extractImageMentions('mail me@x.png-ish', dir);
    // `me@x.png-ish` — the `@` is preceded by `e`, so no match at all.
    expect(r.attachments).toEqual([]);
    expect(r.text).toBe('mail me@x.png-ish');
  });

  it('dedupes repeated image mentions', () => {
    writeFileSync(join(dir, 'a.png'), Buffer.from([1, 2, 3]));
    const r = extractImageMentions('@a.png and @a.png', dir);
    expect(r.attachments).toHaveLength(1);
  });

  it('caps the number of image attachments', () => {
    const names = [];
    for (let i = 0; i < MAX_IMAGE_MENTIONS + 3; i++) {
      writeFileSync(join(dir, `i${i}.png`), Buffer.from([i]));
      names.push(`@i${i}.png`);
    }
    const r = extractImageMentions(names.join(' '), dir);
    expect(r.attachments.length).toBe(MAX_IMAGE_MENTIONS);
    expect(r.notes.some((n) => n.includes('image limit'))).toBe(true);
  });

  it('enforces the aggregate byte budget on actual bytes across mentions', () => {
    // Two files each ~60% of the total budget: the first attaches, the second
    // pushes past MAX_IMAGE_TOTAL_BYTES and is skipped with a budget note.
    const each = Math.floor(MAX_IMAGE_TOTAL_BYTES * 0.6);
    writeFileSync(join(dir, 'a.png'), Buffer.alloc(each, 1));
    writeFileSync(join(dir, 'b.png'), Buffer.alloc(each, 2));
    const r = extractImageMentions('@a.png @b.png', dir);
    expect(r.attachments).toHaveLength(1);
    expect(r.notes.some((n) => /total image budget/i.test(n))).toBe(true);
  });
});
