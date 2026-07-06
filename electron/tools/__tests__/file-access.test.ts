import { describe, expect, it, vi } from 'vitest';
import type * as os from 'node:os';
import type * as fs from 'node:fs';

vi.mock('node:os', async (orig) => ({
  ...(await orig<typeof os>()),
  homedir: () => '/home/test',
}));

const realpathMap = new Map<string, string>();
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof fs>();
  return {
    ...actual,
    realpathSync: Object.assign(
      (p: string) => {
        if (realpathMap.has(p)) return realpathMap.get(p)!;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      {
        native: (p: string) => {
          if (realpathMap.has(p)) return realpathMap.get(p)!;
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
      },
    ),
  };
});

import type { AppConfig } from '../../config/schema.js';
import { filterGrepOutput, isPathAllowed } from '../file-access.js';

function cfg(fileAccess: Partial<AppConfig['tools']['fileAccess']>): AppConfig {
  return {
    tools: {
      fileAccess: { enabled: true, allowPaths: [], denyPaths: [], ...fileAccess },
    },
  } as AppConfig;
}

describe('isPathAllowed', () => {
  it('denies everything when fileAccess is disabled', () => {
    const c = cfg({ enabled: false, allowPaths: ['~'] });
    expect(isPathAllowed('/home/test/foo.txt', c).allowed).toBe(false);
  });

  it('allows everything when allowPaths is empty', () => {
    const c = cfg({ allowPaths: [] });
    expect(isPathAllowed('/etc/passwd', c).allowed).toBe(true);
    expect(isPathAllowed('/home/test/foo.txt', c).allowed).toBe(true);
  });

  it('allows everything when allowPaths contains "*"', () => {
    const c = cfg({ allowPaths: ['~/only-this', '*'] });
    expect(isPathAllowed('/etc/passwd', c).allowed).toBe(true);
  });

  it('restricts to home with default allowPaths ["~"]', () => {
    const c = cfg({ allowPaths: ['~'] });
    expect(isPathAllowed('/home/test/foo.txt', c).allowed).toBe(true);
    expect(isPathAllowed('/home/test', c).allowed).toBe(true);
    const outside = isPathAllowed('/etc/passwd', c);
    expect(outside.allowed).toBe(false);
    expect(outside.reason).toContain('outside allowed roots');
  });

  it('deny rule beats allow rule (directory prefix)', () => {
    const c = cfg({ allowPaths: ['~'], denyPaths: ['~/.ssh'] });
    expect(isPathAllowed('/home/test/project/a.ts', c).allowed).toBe(true);
    const denied = isPathAllowed('/home/test/.ssh/id_rsa', c);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('~/.ssh');
  });

  it('exact-file deny does not match sibling with shared prefix', () => {
    const c = cfg({ allowPaths: ['~'], denyPaths: ['~/secret.txt'] });
    expect(isPathAllowed('/home/test/secret.txt', c).allowed).toBe(false);
    expect(isPathAllowed('/home/test/secret.txt.bak', c).allowed).toBe(true);
  });

  it('recognizes non-asterisk glob metacharacters (?, [], {})', () => {
    const c = cfg({ allowPaths: ['~'], denyPaths: ['~/secrets/file?.env', '~/keys/id_[dr]sa'] });
    expect(isPathAllowed('/home/test/secrets/file1.env', c).allowed).toBe(false);
    expect(isPathAllowed('/home/test/secrets/file10.env', c).allowed).toBe(true);
    expect(isPathAllowed('/home/test/keys/id_rsa', c).allowed).toBe(false);
    expect(isPathAllowed('/home/test/keys/id_ed25519', c).allowed).toBe(true);
  });

  it('glob deny matches dotfiles anywhere', () => {
    const c = cfg({ allowPaths: ['~'], denyPaths: ['**/.env'] });
    expect(isPathAllowed('/home/test/proj/.env', c).allowed).toBe(false);
    expect(isPathAllowed('/home/test/proj/.env.example', c).allowed).toBe(true);
  });

  it('glob allow with ~ prefix', () => {
    const c = cfg({ allowPaths: ['~/work/**'] });
    expect(isPathAllowed('/home/test/work/a/b.ts', c).allowed).toBe(true);
    expect(isPathAllowed('/home/test/personal/a.ts', c).allowed).toBe(false);
  });

  it('resolves relative allow entries against home', () => {
    const c = cfg({ allowPaths: ['projects'] });
    expect(isPathAllowed('/home/test/projects/app/main.ts', c).allowed).toBe(true);
    expect(isPathAllowed('/home/test/other/main.ts', c).allowed).toBe(false);
  });

  it('denies symlink that escapes an allowed root', () => {
    realpathMap.set('/home/test/link/passwd', '/etc/passwd');
    const c = cfg({ allowPaths: ['~'] });
    expect(isPathAllowed('/home/test/link/passwd', c).allowed).toBe(false);
    realpathMap.clear();
  });

  it('denies symlink whose real target is inside a denied root', () => {
    realpathMap.set('/home/test/alias/id_rsa', '/home/test/.ssh/id_rsa');
    const c = cfg({ allowPaths: ['~'], denyPaths: ['~/.ssh'] });
    expect(isPathAllowed('/home/test/alias/id_rsa', c).allowed).toBe(false);
    realpathMap.clear();
  });

  it('allows paths under a symlinked allow root (e.g. /tmp → /private/tmp)', () => {
    realpathMap.set('/tmp', '/private/tmp');
    realpathMap.set('/tmp/foo.txt', '/private/tmp/foo.txt');
    const c = cfg({ allowPaths: ['/tmp'] });
    expect(isPathAllowed('/tmp/foo.txt', c).allowed).toBe(true);
    realpathMap.clear();
  });

  it('allows paths under a symlinked glob allow root', () => {
    realpathMap.set('/tmp', '/private/tmp');
    realpathMap.set('/tmp/foo.txt', '/private/tmp/foo.txt');
    const c = cfg({ allowPaths: ['/tmp/**'] });
    expect(isPathAllowed('/tmp/foo.txt', c).allowed).toBe(true);
    expect(isPathAllowed('/private/tmp/foo.txt', c).allowed).toBe(true);
    realpathMap.clear();
  });

  it('anchors relative glob entries to home', () => {
    const c = cfg({ allowPaths: ['~'], denyPaths: ['secrets/**'] });
    expect(isPathAllowed('/home/test/secrets/key.txt', c).allowed).toBe(false);
    expect(isPathAllowed('/home/test/other/key.txt', c).allowed).toBe(true);
  });

  it('walks to nearest existing ancestor for not-yet-created write targets', () => {
    realpathMap.set('/home/test/link', '/etc');
    const c = cfg({ allowPaths: ['~'] });
    expect(isPathAllowed('/home/test/link/newfile.txt', c).allowed).toBe(false);
    expect(isPathAllowed('/home/test/link/new/deep/dir/file.txt', c).allowed).toBe(false);
    realpathMap.clear();
  });
});

describe('filterGrepOutput', () => {
  it('drops denied lines and recomputes summary without leaking counts', () => {
    const c = cfg({ allowPaths: ['~'], denyPaths: ['~/.ssh'] });
    const raw = [
      '3 matches across 3 files',
      '---',
      '/home/test/app/a.ts:10:1: const x = 1',
      '/home/test/.ssh/config:1:1: Host *',
      '/home/test/.ssh/config:2- User me',
      '--',
      '/home/test/app/b.ts:5:3: foo()',
    ].join('\n');
    const out = filterGrepOutput(raw, c);
    expect(out).toContain('/home/test/app/a.ts:10:1');
    expect(out).toContain('/home/test/app/b.ts:5:3');
    expect(out).not.toContain('.ssh');
    expect(out.split('\n')[0]).toBe('2 matches across 2 files');
    expect(out).not.toMatch(/hidden/);
  });

  it('reports zero matches when all hits are in denied paths (no oracle)', () => {
    const c = cfg({ allowPaths: ['~'], denyPaths: ['~/.ssh'] });
    const raw = ['1 match across 1 file', '---', '/home/test/.ssh/id_rsa:1:1: KEY'].join('\n');
    const out = filterGrepOutput(raw, c);
    expect(out.split('\n')[0]).toBe('0 matches across 0 files');
    expect(out).not.toContain('KEY');
  });

  it('drops orphan -- separators from fully-filtered context groups', () => {
    const c = cfg({ allowPaths: ['~'], denyPaths: ['~/.ssh'] });
    const raw = [
      '1 match across 1 file',
      '---',
      '/home/test/.ssh/config:1- ctx',
      '/home/test/.ssh/config:2:1: Host *',
      '/home/test/.ssh/config:3- ctx',
      '--',
    ].join('\n');
    const out = filterGrepOutput(raw, c);
    expect(out).toBe('0 matches across 0 files\n---');
  });

  it('preserves truncation markers only when nothing was filtered', () => {
    const c = cfg({ allowPaths: ['~'] });
    const raw = [
      '1000 matches across 42 files (truncated at 1000)',
      '---',
      '/home/test/a.ts:1:1: x',
      '[output truncated: showing last ~5000 of ~12000 tokens]',
    ].join('\n');
    const out = filterGrepOutput(raw, c);
    expect(out.split('\n')[0]).toBe('1 match across 1 file (truncated at 1000)');
    expect(out).toContain('[output truncated:');
  });

  it('drops truncation markers when any line was filtered (no oracle)', () => {
    const c = cfg({ allowPaths: ['~'], denyPaths: ['~/.ssh'] });
    const raw = [
      '1000 matches across 2 files (truncated at 1000)',
      '---',
      '/home/test/a.ts:1:1: x',
      '/home/test/.ssh/id_rsa:1:1: KEY',
      '[output truncated: showing last ~5000 of ~12000 tokens]',
    ].join('\n');
    const out = filterGrepOutput(raw, c);
    expect(out.split('\n')[0]).toBe('1 match across 1 file');
    expect(out).not.toContain('truncated');
    expect(out).not.toContain('KEY');
  });

  it('handles /-rooted glob patterns without double-slash', () => {
    const c = cfg({ allowPaths: ['~'], denyPaths: ['/**/*.pem'] });
    expect(isPathAllowed('/home/test/certs/key.pem', c).allowed).toBe(false);
    expect(isPathAllowed('/home/test/certs/key.txt', c).allowed).toBe(true);
  });

  it('passes through unchanged when no allow/deny restrictions apply', () => {
    const c = cfg({ allowPaths: [], denyPaths: [] });
    const raw = '1 match across 1 file\n---\n/etc/a.ts:1:1: hi';
    expect(filterGrepOutput(raw, c)).toBe(raw);
  });

  it('passes error strings through unchanged (no summary/--- header)', () => {
    const c = cfg({ allowPaths: ['~'], denyPaths: ['~/.ssh'] });
    const raw = 'Error: Invalid regex pattern: Unterminated group';
    expect(filterGrepOutput(raw, c)).toBe(raw);
  });

  it('drops truncation markers when no visible matches survive', () => {
    const c = cfg({ allowPaths: ['~'], denyPaths: ['~/.ssh'] });
    const raw = [
      '1000 matches across 1 file (truncated at 1000)',
      '---',
      '/home/test/.ssh/id_rsa:1:1: KEY',
      '[output truncated: showing last ~5000 of ~12000 tokens]',
    ].join('\n');
    expect(filterGrepOutput(raw, c)).toBe('0 matches across 0 files\n---');
  });
});
