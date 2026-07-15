import { describe, it, expect } from 'vitest';
import { parseHeadlessArgs, helpText } from '../headless-run.js';

// Full default shape so a regression in any field is caught.
const base = {
  print: false,
  prompt: undefined,
  json: false,
  help: false,
  modelKey: undefined,
  profileKey: undefined,
  reasoningEffort: undefined,
  fallbackEnabled: false,
  runtimeOverride: undefined,
  list: undefined,
} as const;

describe('parseHeadlessArgs', () => {
  it('returns interactive defaults for no flags', () => {
    expect(parseHeadlessArgs([])).toEqual(base);
  });

  it('-p with a following prompt value', () => {
    expect(parseHeadlessArgs(['-p', 'hello world'])).toEqual({ ...base, print: true, prompt: 'hello world' });
  });

  it('--print with a value', () => {
    expect(parseHeadlessArgs(['--print', 'hi'])).toEqual({ ...base, print: true, prompt: 'hi' });
  });

  it('-p with no value (reads stdin later) still forces print mode', () => {
    expect(parseHeadlessArgs(['-p'])).toEqual({ ...base, print: true });
  });

  it('does not consume a following flag as the prompt', () => {
    expect(parseHeadlessArgs(['-p', '--json'])).toEqual({ ...base, print: true, json: true });
  });

  it('--prompt=inline form', () => {
    expect(parseHeadlessArgs(['--prompt=inline value'])).toEqual({ ...base, print: true, prompt: 'inline value' });
  });

  it('ignores unknown tokens like the launcher flag --kai-cli', () => {
    expect(parseHeadlessArgs(['--kai-cli', '-p', 'go', '--json'])).toEqual({
      ...base,
      print: true,
      prompt: 'go',
      json: true,
    });
  });

  it('--json alone (piped stdin) does not force print', () => {
    expect(parseHeadlessArgs(['--json'])).toEqual({ ...base, json: true });
  });

  it('-h / --help sets help', () => {
    expect(parseHeadlessArgs(['-h']).help).toBe(true);
    expect(parseHeadlessArgs(['--help']).help).toBe(true);
  });

  it('--model <key> and --model=<key>', () => {
    expect(parseHeadlessArgs(['-p', 'x', '--model', 'gpt-5']).modelKey).toBe('gpt-5');
    expect(parseHeadlessArgs(['-p', 'x', '--model=claude-opus']).modelKey).toBe('claude-opus');
  });

  it('does not swallow the next flag as a --model value', () => {
    const r = parseHeadlessArgs(['-p', 'x', '--model', '--json']);
    expect(r.modelKey).toBeUndefined();
    expect(r.json).toBe(true);
  });

  it('--profile and --reasoning (validated) and --fallback', () => {
    const r = parseHeadlessArgs(['-p', 'x', '--profile', 'work', '--reasoning', 'high', '--fallback']);
    expect(r.profileKey).toBe('work');
    expect(r.reasoningEffort).toBe('high');
    expect(r.fallbackEnabled).toBe(true);
  });

  it('rejects an invalid --reasoning value', () => {
    expect(parseHeadlessArgs(['-p', 'x', '--reasoning', 'turbo']).reasoningEffort).toBeUndefined();
  });

  it('--runtime <id> and --runtime=<id>', () => {
    expect(parseHeadlessArgs(['-p', 'x', '--runtime', 'codex-sdk']).runtimeOverride).toBe('codex-sdk');
    expect(parseHeadlessArgs(['-p', 'x', '--runtime=pi']).runtimeOverride).toBe('pi');
  });

  it('--list-* discovery flags set the list mode', () => {
    expect(parseHeadlessArgs(['--list-models']).list).toBe('models');
    expect(parseHeadlessArgs(['--list-profiles']).list).toBe('profiles');
    expect(parseHeadlessArgs(['--list-runtimes']).list).toBe('runtimes');
  });
});

describe('helpText', () => {
  it('documents the headless flags + usage', () => {
    const h = helpText();
    for (const token of [
      'USAGE',
      '-p, --print',
      '--json',
      '--model',
      '--profile',
      '--reasoning',
      '--fallback',
      '-h, --help',
    ]) {
      expect(h, token).toContain(token);
    }
  });
});
