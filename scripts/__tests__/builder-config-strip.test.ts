/**
 * Tests for the electron-builder config generator's pure helpers
 * (scripts/builder-config-strip.ts). The stripTopLevelBlock regex is the
 * ADR-0005 / #82 Windows-target strip: Windows (`win`/`nsis`) now builds BY
 * DEFAULT (experimental-on posture); the generator strips both blocks only when
 * KAI_DISABLE_WIN_BUILD is set (e.g. a mac-only release). This helper is that
 * strip. A regression that strips the wrong block, leaks the win block, or
 * truncates an adjacent block would break the mac/linux config on a disabled
 * build — release-breaking.
 */
import { describe, it, expect } from 'vitest';
import { stripTopLevelBlock, toYamlSingleQuotedPath } from '../builder-config-strip.js';

const SAMPLE = `mac:
  category: dev
  extraResources:
    - from: bin/kai
      to: bin/kai
win:
  icon: build/icon.ico
  extraResources:
    - from: bin/kai.cmd
      to: bin/kai.cmd

  target:
    - target: nsis
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
linux:
  category: Development
  maintainer: x
`;

describe('stripTopLevelBlock', () => {
  it('removes the named top-level block including its indented content', () => {
    const out = stripTopLevelBlock(SAMPLE, 'win');
    expect(out).not.toContain('icon: build/icon.ico');
    expect(out).not.toContain('bin/kai.cmd');
    // Adjacent blocks survive.
    expect(out).toContain('mac:');
    expect(out).toContain('nsis:');
    expect(out).toContain('linux:');
  });

  it('consumes an interior blank line so it does not truncate the block early', () => {
    // The win block has a blank line before `target:` — everything up to `nsis:`
    // must go, including that `target:` sub-block.
    const out = stripTopLevelBlock(SAMPLE, 'win');
    expect(out).not.toContain('target: nsis');
    expect(out).toContain('nsis:'); // the SEPARATE top-level nsis block is untouched by stripping 'win'
  });

  it('stops at the next column-0 key (does not eat the following block)', () => {
    const out = stripTopLevelBlock(SAMPLE, 'nsis');
    expect(out).not.toContain('allowToChangeInstallationDirectory');
    expect(out).toContain('linux:'); // block after nsis preserved
    expect(out).toContain('maintainer: x');
  });

  it('strips BOTH win and nsis leaving only mac + linux (KAI_DISABLE_WIN_BUILD opt-out)', () => {
    let out = stripTopLevelBlock(SAMPLE, 'win');
    out = stripTopLevelBlock(out, 'nsis');
    expect(out).not.toContain('win:');
    expect(out).not.toContain('nsis:');
    expect(out).not.toContain('kai.cmd');
    expect(out).not.toContain('allowToChangeInstallationDirectory');
    expect(out).toContain('mac:');
    expect(out).toContain('linux:');
    expect(out).toContain('bin/kai\n'); // mac's POSIX launcher line intact
  });

  it('is a no-op when the key is absent', () => {
    expect(stripTopLevelBlock(SAMPLE, 'windows')).toBe(SAMPLE); // 'windows' != 'win' key line
  });

  it('does not strip a key that only appears indented (must be column 0)', () => {
    const yaml = 'top:\n  win: nested-value\n  other: x\nbottom:\n  y: 1\n';
    // 'win' appears only as an indented mapping key, never at column 0 → untouched.
    expect(stripTopLevelBlock(yaml, 'win')).toBe(yaml);
  });
});

describe('toYamlSingleQuotedPath', () => {
  it('wraps a plain path in single quotes', () => {
    expect(toYamlSingleQuotedPath('/opt/kai/bin')).toBe("'/opt/kai/bin'");
  });

  it('doubles embedded single quotes (YAML escaping)', () => {
    expect(toYamlSingleQuotedPath("/opt/it's/bin")).toBe("'/opt/it''s/bin'");
  });

  it('handles a path with spaces and special chars literally', () => {
    expect(toYamlSingleQuotedPath('/My Apps/kai $x')).toBe("'/My Apps/kai $x'");
  });
});
