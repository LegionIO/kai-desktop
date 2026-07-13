/**
 * Tests for buildSandboxedEnv — the environment scrubber for plugin-spawned
 * child processes. The Electron main process env holds app secrets (provider
 * keys, PATs, AWS creds); a plugin exec must NOT inherit them. Only the
 * SAFE_ENV_VARS allowlist passes through, plus the plugin's own explicit env.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { __internal } from '../sandboxed-exec.js';

const { buildSandboxedEnv } = __internal;

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
});

describe('buildSandboxedEnv — secret scrubbing for plugin child processes', () => {
  it('passes through allowlisted vars and drops everything else', () => {
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/home/u';
    process.env.ANTHROPIC_API_KEY = 'sk-secret';
    process.env.PGHEC_PAT = 'ghp-secret';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';

    const env = buildSandboxedEnv();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PGHEC_PAT).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('does NOT inherit the full process.env even when no plugin env is given', () => {
    process.env.SOME_SECRET = 'nope';
    const env = buildSandboxedEnv(undefined);
    expect(env.SOME_SECRET).toBeUndefined();
    expect(
      Object.keys(env).every((k) =>
        ['PATH', 'HOME', 'SHELL', 'USER', 'LANG', 'TERM', 'TMPDIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME'].includes(k),
      ),
    ).toBe(true);
  });

  it('layers the plugin explicit env on top of the allowlisted base', () => {
    process.env.PATH = '/usr/bin';
    const env = buildSandboxedEnv({ MY_PLUGIN_VAR: 'x', PATH: '/custom/bin' });
    expect(env.MY_PLUGIN_VAR).toBe('x');
    // plugin override wins over the inherited allowlisted value
    expect(env.PATH).toBe('/custom/bin');
  });

  it('omits an allowlisted var that is absent from the current env', () => {
    delete process.env.TMPDIR;
    const env = buildSandboxedEnv();
    expect('TMPDIR' in env).toBe(false);
  });
});
