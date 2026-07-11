import { describe, it, expect } from 'vitest';
import { parseEnvAllowlist, looksLikeSecretEnvName } from '../RuntimeSettings';

describe('parseEnvAllowlist', () => {
  it('splits on commas and trims whitespace', () => {
    expect(parseEnvAllowlist('GIT_SSH_COMMAND, HTTPS_PROXY')).toEqual(['GIT_SSH_COMMAND', 'HTTPS_PROXY']);
  });

  it('splits on arbitrary whitespace and newlines', () => {
    expect(parseEnvAllowlist('A  B\nC\tD')).toEqual(['A', 'B', 'C', 'D']);
  });

  it('dedupes repeated names preserving first-seen order', () => {
    expect(parseEnvAllowlist('A, B, A, C, B')).toEqual(['A', 'B', 'C']);
  });

  it('drops empty tokens from trailing/leading separators', () => {
    expect(parseEnvAllowlist(' , A ,, B , ')).toEqual(['A', 'B']);
  });

  it('returns an empty list for an empty or whitespace-only string', () => {
    expect(parseEnvAllowlist('')).toEqual([]);
    expect(parseEnvAllowlist('   \n  ')).toEqual([]);
  });
});

describe('looksLikeSecretEnvName', () => {
  it('flags common credential-bearing names', () => {
    for (const name of [
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'MY_API_KEY',
      'DB_PASSWORD',
      'SESSION_SECRET',
      'PRIVATE_KEY',
      'SOME_CREDENTIAL',
      'AUTH_TOKEN',
    ]) {
      expect(looksLikeSecretEnvName(name), name).toBe(true);
    }
  });

  it('does not flag benign passthrough names', () => {
    for (const name of ['GIT_SSH_COMMAND', 'HTTPS_PROXY', 'NO_PROXY', 'LANG', 'TERM', 'PATH', 'HOME', 'TMPDIR']) {
      expect(looksLikeSecretEnvName(name), name).toBe(false);
    }
  });

  it('is case-insensitive', () => {
    expect(looksLikeSecretEnvName('my_secret')).toBe(true);
    expect(looksLikeSecretEnvName('gh_token')).toBe(true);
  });
});
