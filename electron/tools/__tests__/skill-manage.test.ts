/**
 * Tests for skill-manage.ts path-safety validators (via __internal). The `skills`
 * tool lets the MODEL create/edit skill files on disk — a model-reachable
 * filesystem-write surface (and .sh helper files are written mode 0o755, i.e.
 * executable). These three guards keep a skill write inside its own directory:
 *   - validateSkillName: the skill name → directory segment (strict slug).
 *   - isValidSkillFilename: additional-file names (no traversal/separators).
 *   - isContained: the resolved-path backstop (child strictly under the skill dir).
 * A regression here would let the model plant a file — potentially an executable
 * — outside the skills tree.
 */
import { describe, it, expect, vi } from 'vitest';
import { join } from 'path';

// skill-manage.ts transitively imports electron via ../ipc/config.js.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/kai', getName: () => 'Kai' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { __internal } from '../skill-manage.js';

const { validateSkillName, isValidSkillFilename, isContained } = __internal;

describe('validateSkillName (skill name → dir segment)', () => {
  it('accepts lowercase slugs, rejects everything else', () => {
    for (const ok of ['deploy', 'deploy-status', 'my_skill', 'a1', 'x9-y_z']) {
      expect(validateSkillName(ok), ok).toBe(ok);
    }
    for (const bad of ['', undefined, '../evil', 'a/b', 'UPPER', 'has space', '.hidden', '-leading', 'a.b', 'x\0y']) {
      expect(validateSkillName(bad as string | undefined), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('isValidSkillFilename (additional-file names)', () => {
  it('accepts plain filenames', () => {
    for (const ok of ['run.sh', 'index.mjs', 'data.json', 'README.md', 'a.b.c']) {
      expect(isValidSkillFilename(ok), ok).toBe(true);
    }
  });

  it('rejects traversal, separators, empty, and dot', () => {
    for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', 'sub/dir/f', 'foo/../bar', '..\\win']) {
      expect(isValidSkillFilename(bad), bad).toBe(false);
    }
  });
});

describe('isContained (resolved-path backstop)', () => {
  const dir = join('/tmp', 'kai', 'skills', 'my-skill');

  it('is true for a direct child and a nested child', () => {
    expect(isContained(join(dir, 'run.sh'), dir)).toBe(true);
    expect(isContained(join(dir, 'sub', 'f.txt'), dir)).toBe(true);
  });

  it('is false for the dir itself, a sibling, an ancestor, and a traversal escape', () => {
    expect(isContained(dir, dir)).toBe(false); // not a strict child
    expect(isContained(join('/tmp', 'kai', 'skills', 'other', 'f'), dir)).toBe(false);
    expect(isContained(join('/tmp', 'kai', 'skills'), dir)).toBe(false);
    expect(isContained(join(dir, '..', '..', 'etc', 'passwd'), dir)).toBe(false); // resolves out
    expect(isContained('/etc/passwd', dir)).toBe(false);
  });

  it('is not fooled by a sibling dir sharing a name prefix', () => {
    // /tmp/kai/skills/my-skill vs /tmp/kai/skills/my-skill-evil — the + sep guard
    // must prevent the prefix match.
    expect(isContained(join('/tmp', 'kai', 'skills', 'my-skill-evil', 'f'), dir)).toBe(false);
  });
});
