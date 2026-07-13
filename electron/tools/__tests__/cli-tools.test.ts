/**
 * Tests for parseAndValidateCliCommand — the security boundary of the model-facing
 * CLI tools (git/gh/etc.). A CLI tool runs a model-supplied `command` string; this
 * function tokenizes it into an argv (later run with shell:false) and enforces two
 * invariants:
 *   1. NO shell control operators (;, &&, ||, |, >, <, &, $(…), <(…), …) — so the
 *      allowed binary can't be chained into a second command;
 *   2. argv[0] must be one of the binaries allowed for that tool.
 * A regression here would let the model chain an arbitrary command onto a
 * whitelisted binary.
 */
import { describe, it, expect, vi } from 'vitest';

// cli-tools.ts imports electron-touching modules at load; stub the ones that reach
// electron/native so importing the pure validator stays cheap.
vi.mock('../process-runner.js', () => ({ runCommandWithStreaming: vi.fn(), resolveProcessStreamingConfig: vi.fn() }));
vi.mock('../execution.js', () => ({ runToolExecution: vi.fn() }));
vi.mock('../shell.js', () => ({
  isCommandAllowed: vi.fn(() => ({ allowed: true })),
  scrubShellEnv: vi.fn((e: unknown) => e),
}));
vi.mock('../diff-tracker.js', () => ({ beginShellSnapshot: vi.fn() }));
vi.mock('../../utils/shell-env.js', () => ({ binaryExistsInResolvedPath: vi.fn(() => true) }));

import { parseAndValidateCliCommand } from '../cli-tools.js';

const GIT = ['git'];

describe('parseAndValidateCliCommand — accepts safe commands', () => {
  it('tokenizes a plain command into argv', () => {
    expect(parseAndValidateCliCommand('git log --oneline -5', GIT)).toEqual({
      argv: ['git', 'log', '--oneline', '-5'],
    });
  });

  it('passes an unquoted glob through as a literal pattern (binary handles it)', () => {
    expect(parseAndValidateCliCommand('git add *.ts', GIT)).toEqual({ argv: ['git', 'add', '*.ts'] });
  });

  it('preserves quoted arguments containing shell-ish characters as one token', () => {
    expect(parseAndValidateCliCommand('git commit -m "fix: a; b && c"', GIT)).toEqual({
      argv: ['git', 'commit', '-m', 'fix: a; b && c'],
    });
  });

  it('ignores a trailing # comment', () => {
    expect(parseAndValidateCliCommand('git status # anything here', GIT)).toEqual({ argv: ['git', 'status'] });
  });

  it('honors extraBinaries in the allowlist', () => {
    expect(parseAndValidateCliCommand('gh pr list', ['git', 'gh'])).toEqual({ argv: ['gh', 'pr', 'list'] });
  });
});

describe('parseAndValidateCliCommand — rejects shell control operators (chaining)', () => {
  it.each([
    ['semicolon', 'git log; rm -rf ~'],
    ['and-and', 'git log && rm -rf ~'],
    ['or-or', 'git log || rm -rf ~'],
    ['pipe', 'git log | sh'],
    ['redirect-out', 'git log > /etc/passwd'],
    ['redirect-in', 'git log < /etc/passwd'],
    ['background', 'git log &'],
    ['command-subst', 'git log $(rm -rf ~)'],
    ['process-subst', 'git diff <(cat /etc/passwd)'],
  ])('rejects %s', (_label, command) => {
    const r = parseAndValidateCliCommand(command, GIT);
    expect(r.error, command).toMatch(/control operators/i);
    expect(r.argv).toBeUndefined();
  });
});

describe('parseAndValidateCliCommand — enforces the binary allowlist', () => {
  it('rejects a command whose first token is not an allowed binary', () => {
    const r = parseAndValidateCliCommand('rm -rf ~', GIT);
    expect(r.error).toMatch(/must start with one of: git/i);
  });

  it('rejects an empty command', () => {
    expect(parseAndValidateCliCommand('', GIT).error).toMatch(/must start with one of/i);
    expect(parseAndValidateCliCommand('   ', GIT).error).toMatch(/must start with one of/i);
  });

  it('rejects a disallowed binary even when the syntax is otherwise clean', () => {
    expect(parseAndValidateCliCommand('curl https://evil.example', GIT).error).toMatch(/must start with one of/i);
  });
});
