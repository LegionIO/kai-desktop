import { describe, it, expect } from 'vitest';
import { buildAgentChildEnv } from '../confinement.js';

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
