import { describe, it, expect } from 'vitest';
import { buildAgentChildEnv, scrubSecretEnv } from '../confinement.js';

// getResolvedProcessEnv overwrites PATH via login-shell resolution; that's
// orthogonal to the allowlist logic under test, so these assertions focus on
// which PARENT vars survive/are-stripped, not PATH's exact value.

describe('buildAgentChildEnv', () => {
  const secretsParent = (): NodeJS.ProcessEnv => ({
    PATH: '/usr/bin:/bin',
    HOME: '/home/dev',
    USER: 'dev',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    GIT_AUTHOR_NAME: 'Dev',
    // secrets that must NOT leak:
    AWS_ACCESS_KEY_ID: 'AKIA_LEAK',
    AWS_SECRET_ACCESS_KEY: 'secret_leak',
    GH_TOKEN: 'gho_leak',
    NPM_TOKEN: 'npm_leak',
    ANTHROPIC_API_KEY: 'sk-ant-parent',
    OPENAI_API_KEY: 'sk-openai-parent',
    GEMINI_API_KEY: 'gemini-parent',
    SOME_RANDOM_SECRET: 'nope',
  });

  it('strips all secrets, keeps process essentials + non-secret identity', () => {
    const env = buildAgentChildEnv({
      parentEnv: secretsParent(),
      modelProvider: 'anthropic',
      modelEnv: { ANTHROPIC_API_KEY: 'sk-ant-selected' },
    });
    // essentials + identity survive
    expect(env.HOME).toBe('/home/dev');
    expect(env.USER).toBe('dev');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.LC_ALL).toBe('en_US.UTF-8');
    expect(env.TERM).toBe('xterm-256color');
    expect(env.SSH_AUTH_SOCK).toBe('/tmp/ssh-agent.sock');
    expect(env.GIT_AUTHOR_NAME).toBe('Dev');
    expect(env.PATH).toBeTruthy();
    // secrets stripped
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.SOME_RANDOM_SECRET).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('injects only the selected provider key (modelEnv wins, last)', () => {
    const env = buildAgentChildEnv({
      parentEnv: secretsParent(),
      modelProvider: 'anthropic',
      modelEnv: { ANTHROPIC_API_KEY: 'sk-ant-selected' },
    });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-selected'); // selected, not the parent value
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('lets the ambient AWS_* chain through ONLY for bedrock without explicit keys', () => {
    const bedrockAmbient = buildAgentChildEnv({
      parentEnv: { ...secretsParent(), AWS_PROFILE: 'default', AWS_REGION: 'us-east-1' },
      modelProvider: 'amazon-bedrock',
      hasExplicitAwsKeys: false,
    });
    expect(bedrockAmbient.AWS_PROFILE).toBe('default');
    expect(bedrockAmbient.AWS_REGION).toBe('us-east-1');
    expect(bedrockAmbient.AWS_ACCESS_KEY_ID).toBe('AKIA_LEAK'); // ambient chain allowed
  });

  it('strips AWS_* for bedrock WITH explicit keys (no ambient chain needed)', () => {
    const env = buildAgentChildEnv({
      parentEnv: secretsParent(),
      modelProvider: 'amazon-bedrock',
      hasExplicitAwsKeys: true,
    });
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_PROFILE).toBeUndefined();
  });

  it('strips AWS_* for non-bedrock providers', () => {
    const env = buildAgentChildEnv({ parentEnv: { ...secretsParent(), AWS_PROFILE: 'x' }, modelProvider: 'openai' });
    expect(env.AWS_PROFILE).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
  });

  it('honors the user passthrough allowlist', () => {
    const env = buildAgentChildEnv({
      parentEnv: { ...secretsParent(), MY_CUSTOM_VAR: 'keep-me' },
      modelProvider: 'anthropic',
      passthrough: ['MY_CUSTOM_VAR'],
    });
    expect(env.MY_CUSTOM_VAR).toBe('keep-me');
    // still strips the non-passthrough secrets
    expect(env.GH_TOKEN).toBeUndefined();
  });

  it('never mutates process.env', () => {
    const before = { ...process.env };
    buildAgentChildEnv({
      parentEnv: secretsParent(),
      modelProvider: 'anthropic',
      modelEnv: { ANTHROPIC_API_KEY: 'x' },
    });
    expect(process.env).toEqual(before);
  });

  it('allows Windows process essentials', () => {
    const env = buildAgentChildEnv({
      parentEnv: {
        SystemRoot: 'C:\\Windows',
        USERPROFILE: 'C:\\Users\\dev',
        APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        GH_TOKEN: 'leak',
      },
      modelProvider: 'anthropic',
    });
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.USERPROFILE).toBe('C:\\Users\\dev');
    expect(env.APPDATA).toBe('C:\\Users\\dev\\AppData\\Roaming');
    expect(env.ComSpec).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(env.GH_TOKEN).toBeUndefined();
  });
});

import { resolveConfinedCwd } from '../confinement.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

describe('resolveConfinedCwd', () => {
  it('refuses an unset/empty cwd (no default to $HOME)', () => {
    expect(resolveConfinedCwd(undefined).refused).toBe(true);
    expect(resolveConfinedCwd('').refused).toBe(true);
    expect(resolveConfinedCwd('   ').refused).toBe(true);
  });

  it('refuses the home directory', () => {
    const r = resolveConfinedCwd(homedir());
    expect(r.refused).toBe(true);
    expect(r.cwd).toBeNull();
    expect(r.reason).toMatch(/home directory/i);
    expect(resolveConfinedCwd('~').refused).toBe(true);
  });

  it('refuses a filesystem root', () => {
    const r = resolveConfinedCwd('/');
    expect(r.refused).toBe(true);
    expect(r.reason).toMatch(/filesystem root/i);
  });

  it('refuses a directory that holds credential files (.aws / .ssh / …)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kai-cwd-cred-'));
    try {
      mkdirSync(join(dir, '.aws'));
      const r = resolveConfinedCwd(dir);
      expect(r.refused).toBe(true);
      expect(r.reason).toMatch(/\.aws/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('proceeds for a normal repo/workspace dir (canonicalized)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kai-cwd-ok-'));
    try {
      writeFileSync(join(dir, 'README.md'), '# ok');
      const r = resolveConfinedCwd(dir);
      expect(r.refused).toBe(false);
      expect(r.cwd).toBeTruthy();
      expect(r.cwd).toContain(dir.split('/').pop() as string);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports escaped=true when requested resolves outside a workspaceRoot', () => {
    const root = mkdtempSync(join(tmpdir(), 'kai-ws-'));
    const outside = mkdtempSync(join(tmpdir(), 'kai-outside-'));
    try {
      const inside = join(root, 'sub');
      mkdirSync(inside);
      expect(resolveConfinedCwd(inside, { workspaceRoot: root }).escaped).toBe(false);
      const r = resolveConfinedCwd(outside, { workspaceRoot: root });
      expect(r.escaped).toBe(true);
      expect(r.confined).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reports escaped=true when an in-tree path is a SYMLINK resolving OUTSIDE the workspaceRoot', () => {
    // The security-critical symlink property: a dir that LEXICALLY sits under the
    // workspace root but is a symlink to an out-of-tree location must be detected
    // as an escape (realpath canonicalizes before the containment check). A
    // regression dropping the realpathSync would pass the lexical prefix check
    // and silently confine to the symlink's out-of-tree target.
    const root = mkdtempSync(join(tmpdir(), 'kai-ws-'));
    const outside = mkdtempSync(join(tmpdir(), 'kai-outside-'));
    try {
      const link = join(root, 'escape-link'); // lexically under root…
      symlinkSync(outside, link); // …but points outside it
      const r = resolveConfinedCwd(link, { workspaceRoot: root });
      expect(r.escaped).toBe(true); // realpath saw through the symlink
      expect(r.confined).toBe(true);
      // And a genuine in-tree symlink (target under root) is NOT an escape.
      const innerReal = join(root, 'real-sub');
      mkdirSync(innerReal);
      const innerLink = join(root, 'inner-link');
      symlinkSync(innerReal, innerLink);
      expect(resolveConfinedCwd(innerLink, { workspaceRoot: root }).escaped).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('canonicalizes a symlinked workspaceRoot so an in-tree path is not a false escape (macOS /tmp→/private)', () => {
    // workspaceRoot may itself be under a symlinked ancestor (macOS tmpdir). The
    // requested path's realpath and the root's realpath must be compared on the
    // same canonical footing, or every in-tree path would falsely report escape.
    const root = mkdtempSync(join(tmpdir(), 'kai-ws-'));
    try {
      const inside = join(root, 'sub');
      mkdirSync(inside);
      // Pass the NON-canonical root; resolveConfinedCwd realpaths both sides.
      const r = resolveConfinedCwd(inside, { workspaceRoot: root });
      expect(r.escaped).toBe(false);
      // Sanity: the canonical root differs from the literal on macOS.
      void realpathSync(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('scrubSecretEnv (non-confined denylist)', () => {
  it('strips app secret-bearing keys but keeps non-secret env', () => {
    const env = scrubSecretEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/home/dev',
      LANG: 'en_US.UTF-8',
      GIT_AUTHOR_NAME: 'Dev',
      MY_APP_MODE: 'prod',
      ANTHROPIC_API_KEY: 'sk-ant-leak',
      OPENAI_API_KEY: 'sk-openai-leak',
      GEMINI_API_KEY: 'gemini-leak',
      AWS_ACCESS_KEY_ID: 'AKIA_leak',
      AWS_SECRET_ACCESS_KEY: 'secret_leak',
      AZURE_OPENAI_KEY: 'azure_leak',
      GH_TOKEN: 'gho_leak',
      NPM_TOKEN: 'npm_leak',
      DATABASE_URL: 'postgres://u:p@h/db',
      MY_SERVICE_TOKEN: 'tok_leak',
      SOME_PASSWORD: 'pw_leak',
      APP_BASE_URL: 'https://internal',
      SIGNING_PRIVATE_KEY: 'pk_leak',
    });
    // non-secret survives
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/home/dev');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.GIT_AUTHOR_NAME).toBe('Dev');
    expect(env.MY_APP_MODE).toBe('prod');
    // every secret pattern stripped
    for (const k of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AZURE_OPENAI_KEY',
      'GH_TOKEN',
      'NPM_TOKEN',
      'DATABASE_URL',
      'MY_SERVICE_TOKEN',
      'SOME_PASSWORD',
      'APP_BASE_URL',
      'SIGNING_PRIVATE_KEY',
    ]) {
      expect(env[k], `${k} should be stripped`).toBeUndefined();
    }
  });

  it('is case-insensitive on key patterns', () => {
    const env = scrubSecretEnv({ anthropic_api_key: 'x', My_Token: 'y', keep: 'z' });
    expect(env.anthropic_api_key).toBeUndefined();
    expect(env.My_Token).toBeUndefined();
    expect(env.keep).toBe('z');
  });

  it('drops undefined values and does not mutate the input', () => {
    const input: NodeJS.ProcessEnv = { A: '1', B: undefined, GH_TOKEN: 'leak' };
    const out = scrubSecretEnv(input);
    expect(out.A).toBe('1');
    expect('B' in out).toBe(false);
    expect(out.GH_TOKEN).toBeUndefined();
    // input untouched
    expect(input.GH_TOKEN).toBe('leak');
  });

  it('the one provider key overlaid AFTER the scrub survives (caller pattern)', () => {
    const scrubbed = scrubSecretEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'parent-leak' });
    const final = { ...scrubbed, ANTHROPIC_API_KEY: 'selected-key' };
    expect(final.ANTHROPIC_API_KEY).toBe('selected-key');
  });

  it('preserveAwsChain keeps AWS_* (ambient Bedrock auth) but still strips other secrets', () => {
    const env = scrubSecretEnv(
      {
        PATH: '/bin',
        AWS_ACCESS_KEY_ID: 'AKIA_keep',
        AWS_SECRET_ACCESS_KEY: 'secret_keep',
        AWS_SESSION_TOKEN: 'sess_keep',
        AWS_REGION: 'us-east-1',
        ANTHROPIC_API_KEY: 'still-strip',
        GH_TOKEN: 'still-strip',
      },
      { preserveAwsChain: true },
    );
    // AWS chain kept for ambient Bedrock auth
    expect(env.AWS_ACCESS_KEY_ID).toBe('AKIA_keep');
    expect(env.AWS_SECRET_ACCESS_KEY).toBe('secret_keep');
    expect(env.AWS_SESSION_TOKEN).toBe('sess_keep');
    expect(env.AWS_REGION).toBe('us-east-1');
    // non-AWS secrets still stripped
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe('/bin');
  });

  it('without preserveAwsChain, AWS_* is stripped (default)', () => {
    const env = scrubSecretEnv({ AWS_ACCESS_KEY_ID: 'strip', PATH: '/bin' });
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.PATH).toBe('/bin');
  });
});
