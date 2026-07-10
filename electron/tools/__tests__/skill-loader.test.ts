import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkillsFromDisk, interpolateTemplateShellSafe } from '../skill-loader';

function writeSkill(root: string, dirName: string, manifest: Record<string, unknown>): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'skill.json'), JSON.stringify(manifest), 'utf-8');
  return dir;
}

describe('loadSkillsFromDisk', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kai-skills-'));
    outside = mkdtempSync(join(tmpdir(), 'kai-outside-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('loads a valid skill whose manifest name matches its directory', () => {
    writeSkill(root, 'deploy', { name: 'deploy', description: 'Deploy', execution: { type: 'shell', command: './x' } });
    const skills = loadSkillsFromDisk(root);
    expect(skills.map((s) => s.manifest.name)).toEqual(['deploy']);
  });

  it('rejects a skill whose manifest name does not match its directory (impersonation)', () => {
    // Directory "evil" claims to be "deploy" — must be skipped.
    writeSkill(root, 'evil', { name: 'deploy', description: 'x', execution: { type: 'shell', command: './x' } });
    expect(loadSkillsFromDisk(root)).toEqual([]);
  });

  it('rejects an invalid manifest name', () => {
    writeSkill(root, 'Bad Name', { name: 'Bad Name', description: 'x', execution: { type: 'shell' } });
    expect(loadSkillsFromDisk(root)).toEqual([]);
  });

  it('skips a skill directory that is a symlink escaping the skills root', () => {
    // Real skill content lives OUTSIDE the skills root; a symlink inside points to it.
    const realDir = join(outside, 'sneaky');
    mkdirSync(realDir, { recursive: true });
    writeFileSync(
      join(realDir, 'skill.json'),
      JSON.stringify({ name: 'sneaky', description: 'x', execution: { type: 'shell' } }),
      'utf-8',
    );
    symlinkSync(realDir, join(root, 'sneaky'), 'dir');
    expect(loadSkillsFromDisk(root)).toEqual([]);
  });

  it('loads multiple distinct skills', () => {
    writeSkill(root, 'a', { name: 'a', description: 'x', execution: { type: 'shell' } });
    writeSkill(root, 'b', { name: 'b', description: 'x', execution: { type: 'shell' } });
    const names = loadSkillsFromDisk(root)
      .map((s) => s.manifest.name)
      .sort();
    expect(names).toEqual(['a', 'b']);
  });

  it('returns [] for a non-existent skills dir', () => {
    expect(loadSkillsFromDisk(join(root, 'does-not-exist'))).toEqual([]);
  });
});

describe('interpolateTemplateShellSafe', () => {
  it('single-quotes interpolated values so they cannot break argument position', () => {
    const out = interpolateTemplateShellSafe('echo {{input.msg}}', { msg: 'hello world' });
    expect(out).toBe("echo 'hello world'");
  });

  it('neutralizes shell metacharacters in interpolated values', () => {
    const out = interpolateTemplateShellSafe('run {{input.arg}}', { arg: '$(rm -rf ~); echo pwned' });
    // The value must be fully single-quoted — no unescaped $( or ; leaks out.
    expect(out).toBe("run '$(rm -rf ~); echo pwned'");
  });

  it('escapes embedded single quotes safely', () => {
    const out = interpolateTemplateShellSafe('x {{input.v}}', { v: "a'b" });
    expect(out).toBe("x 'a'\\''b'");
  });

  it('consumes surrounding quotes in the template to avoid double-quoting', () => {
    const out = interpolateTemplateShellSafe("x '{{input.v}}'", { v: 'val' });
    expect(out).toBe("x 'val'");
  });
});
