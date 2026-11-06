import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureEncryption, oauthTokens } from '../../../test-utils/mcp-oauth.js';
import { McpCredentialStore } from '../credential-store.js';
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kai-vault-test-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const vault = () => join(home, 'mcp', 'credentials.enc');
it('persists encrypted, private records across a backend restart', () => {
  const store = new McpCredentialStore(home, fixtureEncryption());
  store.set('identity', { tokens: oauthTokens, clientSecret: 'private-secret' });
  expect(readFileSync(vault()).includes(Buffer.from(oauthTokens.access_token))).toBe(false);
  expect(readFileSync(vault()).includes(Buffer.from('private-secret'))).toBe(false);
  expect(statSync(vault()).mode & 0o777).toBe(0o600);
  expect(statSync(join(home, 'mcp')).mode & 0o777).toBe(0o700);
  expect(new McpCredentialStore(home, fixtureEncryption()).get('identity')).toEqual({
    tokens: oauthTokens,
    clientSecret: 'private-secret',
  });
  const copy = store.get('identity');
  copy.tokens!.access_token = 'mutated';
  expect(store.get('identity').tokens?.access_token).toBe(oauthTokens.access_token);
});
it.each(['unavailable', 'basic_text', 'throws'])('uses memory only when secure storage is %s', (mode) => {
  const encryption = fixtureEncryption();
  if (mode === 'unavailable') encryption.isEncryptionAvailable = () => false;
  if (mode === 'basic_text') encryption.getSelectedStorageBackend = () => 'basic_text';
  if (mode === 'throws')
    encryption.isEncryptionAvailable = () => {
      throw new Error('locked');
    };
  const store = new McpCredentialStore(home, encryption, 'linux');
  store.set('identity', { tokens: oauthTokens });
  expect(store.storage).toBe('session');
  expect(existsSync(vault())).toBe(false);
  expect(store.get('identity').tokens).toEqual(oauthTokens);
});
it('preserves an unreadable vault while allowing session-only login', () => {
  mkdirSync(join(home, 'mcp'));
  writeFileSync(vault(), 'unreadable');
  const store = new McpCredentialStore(home, fixtureEncryption());
  expect(store.storage).toBe('session');
  store.set('identity', { tokens: oauthTokens });
  expect(readFileSync(vault(), 'utf8')).toBe('unreadable');
});
it('refuses a vault symlink without overwriting its target', () => {
  mkdirSync(join(home, 'mcp'));
  const target = join(home, 'target');
  writeFileSync(target, 'keep');
  symlinkSync(target, vault());
  const store = new McpCredentialStore(home, fixtureEncryption());
  store.set('identity', { tokens: oauthTokens });
  expect(store.storage).toBe('session');
  expect(readFileSync(target, 'utf8')).toBe('keep');
});
it('prunes invalidated identities without touching other accounts', () => {
  const store = new McpCredentialStore(home, fixtureEncryption());
  store.set('one', { tokens: oauthTokens });
  store.set('two', { clientSecret: 'keep' });
  store.prune(new Set(['two']));
  expect(new McpCredentialStore(home, fixtureEncryption()).get('one')).toEqual({});
  expect(store.get('two')).toEqual({ clientSecret: 'keep' });
});
it('handles a keychain outage after startup without losing session credentials', () => {
  const encryption = fixtureEncryption();
  const store = new McpCredentialStore(home, encryption);
  store.set('identity', { tokens: oauthTokens });
  const prior = readFileSync(vault());
  encryption.encryptString = () => {
    throw new Error('locked');
  };
  store.set('identity', { clientSecret: 'session' });
  expect(store.storage).toBe('session');
  expect(readFileSync(vault())).toEqual(prior);
  expect(store.get('identity')).toEqual({ clientSecret: 'session' });
});

it('prevents old credentials returning after sign-out during a keychain outage', () => {
  const encryption = fixtureEncryption();
  const store = new McpCredentialStore(home, encryption);
  store.set('identity', { tokens: oauthTokens });
  const prior = readFileSync(vault());
  encryption.encryptString = () => {
    throw new Error('locked');
  };
  store.invalidate('identity');
  store.set('identity', {});
  expect(readFileSync(vault())).toEqual(prior);
  expect(new McpCredentialStore(home, fixtureEncryption()).get('identity')).toEqual({});
  const recovered = new McpCredentialStore(home, fixtureEncryption());
  recovered.set('identity', { tokens: oauthTokens });
  expect(new McpCredentialStore(home, fixtureEncryption()).get('identity').tokens).toEqual(oauthTokens);
});
