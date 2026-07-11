import { describe, it, expect } from 'vitest';
import { parseHeadlessArgs } from '../headless-run.js';

describe('parseHeadlessArgs', () => {
  it('returns interactive defaults for no flags', () => {
    expect(parseHeadlessArgs([])).toEqual({ print: false, prompt: undefined, json: false });
  });

  it('-p with a following prompt value', () => {
    expect(parseHeadlessArgs(['-p', 'hello world'])).toEqual({ print: true, prompt: 'hello world', json: false });
  });

  it('--print with a value', () => {
    expect(parseHeadlessArgs(['--print', 'hi'])).toEqual({ print: true, prompt: 'hi', json: false });
  });

  it('-p with no value (reads stdin later) still forces print mode', () => {
    expect(parseHeadlessArgs(['-p'])).toEqual({ print: true, prompt: undefined, json: false });
  });

  it('does not consume a following flag as the prompt', () => {
    expect(parseHeadlessArgs(['-p', '--json'])).toEqual({ print: true, prompt: undefined, json: true });
  });

  it('--prompt=inline form', () => {
    expect(parseHeadlessArgs(['--prompt=inline value'])).toEqual({
      print: true,
      prompt: 'inline value',
      json: false,
    });
  });

  it('ignores unknown tokens like the launcher flag --kai-cli', () => {
    expect(parseHeadlessArgs(['--kai-cli', '-p', 'go', '--json'])).toEqual({
      print: true,
      prompt: 'go',
      json: true,
    });
  });

  it('--json alone (piped stdin) does not force print', () => {
    expect(parseHeadlessArgs(['--json'])).toEqual({ print: false, prompt: undefined, json: true });
  });
});
