/**
 * Test for resolveSkillsDir — the end-to-end fix for the reported bug: a config
 * with a literal `~/.kai/skills` on a home containing `@` (e.g.
 * `/Users/first_last@optum.com/`) silently loaded zero skills because `~` was
 * never expanded. resolveSkillsDir now expands it to the real absolute path.
 */
import { describe, it, expect, vi } from 'vitest';
import type * as OS from 'os';

const HOME = '/Users/bezawada_venkatavishnu@optum.com';
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof OS>('os');
  return { ...actual, homedir: () => HOME };
});

// mastra-instance is pulled in transitively; stub it so the loader imports clean.
vi.mock('../../agent/mastra-instance.js', () => ({ registerSkillWorkflow: () => {} }));

import { resolveSkillsDir } from '../skill-loader.js';
import type { AppConfig } from '../../config/schema.js';

const cfg = (directory?: string): Pick<AppConfig, 'skills'> =>
  ({ skills: directory !== undefined ? { directory, enabled: [] } : undefined }) as Pick<AppConfig, 'skills'>;

describe('resolveSkillsDir', () => {
  it('expands a literal ~/.kai/skills to the real home (the reported bug)', () => {
    expect(resolveSkillsDir(cfg('~/.kai/skills'), '/ignored')).toBe(`${HOME}/.kai/skills`);
  });

  it('keeps an absolute configured directory as-is', () => {
    expect(resolveSkillsDir(cfg('/opt/team/skills'), '/ignored')).toBe('/opt/team/skills');
  });

  it('falls back to <appHome>/skills when unconfigured', () => {
    expect(resolveSkillsDir(cfg(undefined), '/Users/x/.kai')).toBe('/Users/x/.kai/skills');
    expect(resolveSkillsDir(undefined, '/Users/x/.kai')).toBe('/Users/x/.kai/skills');
  });

  it('never returns a path that starts with a literal ~', () => {
    expect(resolveSkillsDir(cfg('~/.kai/skills'), '/ignored').startsWith('~')).toBe(false);
  });
});
