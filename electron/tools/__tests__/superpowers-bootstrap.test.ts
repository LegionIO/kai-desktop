/**
 * Tests for the pure/fs-only internals of superpowers-bootstrap.ts. The exported
 * bootstrapSuperpowers/updateSuperpowers wrap git clone/pull (network-gated, out
 * of scope). These cover the SKILL.md frontmatter parsing and the skill.json
 * generation — where the safety-relevant property is the don't-clobber guard: a
 * user-customized skill.json must never be overwritten.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseSkillMdFrontmatter, getSkillMdBody, generateSkillJson } from '../superpowers-bootstrap.js';

describe('parseSkillMdFrontmatter', () => {
  it('parses key: value pairs from the --- fenced frontmatter', () => {
    const md = '---\nname: My Skill\ndescription: Does a thing\n---\nbody text';
    expect(parseSkillMdFrontmatter(md)).toEqual({ name: 'My Skill', description: 'Does a thing' });
  });

  it('strips surrounding single and double quotes from values', () => {
    const md = `---\nname: "Quoted Name"\ndescription: 'single quoted'\n---\nx`;
    expect(parseSkillMdFrontmatter(md)).toEqual({ name: 'Quoted Name', description: 'single quoted' });
  });

  it('handles CRLF line endings', () => {
    const md = '---\r\nname: CRLF Skill\r\n---\r\nbody';
    expect(parseSkillMdFrontmatter(md).name).toBe('CRLF Skill');
  });

  it('skips lines without a colon and returns {} when there is no frontmatter', () => {
    const md = '---\nname: ok\nnot a pair line\n---\nx';
    expect(parseSkillMdFrontmatter(md)).toEqual({ name: 'ok' });
    expect(parseSkillMdFrontmatter('no frontmatter here')).toEqual({});
  });
});

describe('getSkillMdBody', () => {
  it('returns the trimmed content after the frontmatter fence', () => {
    const md = '---\nname: x\n---\n\n  the body  \n';
    expect(getSkillMdBody(md)).toBe('the body');
  });

  it('returns the whole trimmed content when there is no frontmatter', () => {
    expect(getSkillMdBody('  just body  ')).toBe('just body');
  });
});

describe('generateSkillJson', () => {
  let root: string;
  let src: string;
  let out: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kai-superpowers-'));
    src = join(root, 'src');
    out = join(root, 'out');
    mkdirSync(src, { recursive: true });
    mkdirSync(out, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('generates skill.json from SKILL.md frontmatter + body', () => {
    writeFileSync(join(src, 'SKILL.md'), '---\nname: Cool Skill\ndescription: A cool one\n---\nDo the cool thing.');
    const wrote = generateSkillJson(src, out, 'superpowers-cool');
    expect(wrote).toBe(true);
    const manifest = JSON.parse(readFileSync(join(out, 'skill.json'), 'utf-8'));
    expect(manifest).toMatchObject({
      name: 'Cool Skill',
      description: 'A cool one',
      version: '1.0.0',
      execution: { type: 'prompt', promptTemplate: 'Do the cool thing.' },
    });
  });

  it('falls back to the skillName and a default description when frontmatter is absent', () => {
    writeFileSync(join(src, 'SKILL.md'), 'just a body, no frontmatter');
    generateSkillJson(src, out, 'superpowers-plain');
    const manifest = JSON.parse(readFileSync(join(out, 'skill.json'), 'utf-8'));
    expect(manifest.name).toBe('superpowers-plain');
    expect(manifest.description).toBe('Superpowers skill: superpowers-plain');
    expect(manifest.execution.promptTemplate).toBe('just a body, no frontmatter');
  });

  it('does NOT overwrite an existing skill.json (user customization is preserved)', () => {
    writeFileSync(join(src, 'SKILL.md'), '---\nname: New\n---\nbody');
    const custom = '{"name":"user-edited","custom":true}';
    writeFileSync(join(out, 'skill.json'), custom);
    const wrote = generateSkillJson(src, out, 'superpowers-x');
    expect(wrote).toBe(false);
    expect(readFileSync(join(out, 'skill.json'), 'utf-8')).toBe(custom); // untouched
  });

  it('returns false and writes nothing when SKILL.md is absent', () => {
    const wrote = generateSkillJson(src, out, 'superpowers-missing');
    expect(wrote).toBe(false);
    expect(existsSync(join(out, 'skill.json'))).toBe(false);
  });

  it('rejects a SKILL.md that is a SYMLINK (untrusted repo must not read outside itself)', () => {
    // A hostile checkout could symlink SKILL.md → a secret file; lstat must reject it.
    const secret = join(root, 'secret.txt');
    writeFileSync(secret, 'super secret contents');
    symlinkSync(secret, join(src, 'SKILL.md'));
    const wrote = generateSkillJson(src, out, 'superpowers-evil');
    expect(wrote).toBe(false);
    expect(existsSync(join(out, 'skill.json'))).toBe(false);
  });

  it('rejects an oversized SKILL.md (> 256 KiB) without reading it into a skill', () => {
    writeFileSync(join(src, 'SKILL.md'), 'x'.repeat(256 * 1024 + 1));
    const wrote = generateSkillJson(src, out, 'superpowers-huge');
    expect(wrote).toBe(false);
    expect(existsSync(join(out, 'skill.json'))).toBe(false);
  });
});
