import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bridgeFixture, writeBridgeFile } from '../../../test-utils/plugin-bridge.js';
import { fixtureEncryption } from '../../../test-utils/mcp-oauth.js';
import { SharingCredentials } from '../credentials.js';

describe('MCP credential persistence and revocation', () => {
  let f: ReturnType<typeof bridgeFixture>;
  beforeEach(() => {
    f = bridgeFixture();
    f.enableSharing(true);
  });
  afterEach(() => f.cleanup());
  const unavailable = () => ({ ...fixtureEncryption(), isEncryptionAvailable: () => false });
  it('persists encrypted metadata and token hashes, never bearer values', () => {
    const { token, client } = f.credentials.createStatic('my tablet');
    const disk = readFileSync(join(f.appHome, 'mcp-sharing/credentials.enc'), 'utf8');
    expect(disk).not.toContain(token);
    expect(disk).not.toContain('my tablet');
    const restored = new SharingCredentials(f.appHome, fixtureEncryption(), f.store, () => f.config);
    expect(restored.verify(token, 'remote')?.clientId).toBe(client.id);
    expect(Date.parse(client.expiresAt!) - Date.now()).toBe(30 * 86_400_000);
    expect(restored.verify(token, 'local')).toBeNull();
  });
  it('uses session-only credentials when the keychain is unavailable', () => {
    const credentials = new SharingCredentials(f.appHome, unavailable(), f.store, () => f.config);
    const { token } = credentials.createStatic('session client');
    expect(credentials.storage).toBe('session');
    expect(credentials.verify(token, 'remote')).not.toBeNull();
    expect(
      new SharingCredentials(f.appHome, unavailable(), f.store, () => f.config).verify(token, 'remote'),
    ).toBeNull();
  });
  it('cannot resurrect a revoked encrypted credential after storage becomes unavailable', () => {
    let available = true;
    const encryption = fixtureEncryption();
    const credentials = new SharingCredentials(
      f.appHome,
      {
        ...encryption,
        encryptString: (value) => {
          if (!available) throw new Error('locked');
          return encryption.encryptString(value);
        },
      },
      f.store,
      () => f.config,
    );
    const { token, client } = credentials.createStatic('revoke me');
    available = false;
    credentials.revoke(client.id);
    const restored = new SharingCredentials(f.appHome, fixtureEncryption(), f.store, () => f.config);
    expect(restored.verify(token, 'remote')).toBeNull();
    expect(restored.clients()).toEqual([]);
  });
  it('keeps local clients independent while revoking all remote credentials', () => {
    const local = f.localClient();
    const remote = f.credentials.createStatic('remote');
    f.credentials.revokeRemote();
    expect(f.credentials.verify(local.token, 'local')?.clientId).toBe(local.client.id);
    expect(f.credentials.verify(remote.token, 'remote')).toBeNull();
  });
  it('invalidates access when password, resource, or enabled state changes', () => {
    const remote = f.credentials.createStatic('remote');
    f.config.webServer.auth.password = 'rotated-fixture-password';
    expect(f.credentials.verify(remote.token, 'remote')).toBeNull();
    const current = f.credentials.createStatic('current');
    f.config.mcpExport.remote.publicUrl = 'https://other-kai.test/mcp';
    expect(f.credentials.verify(current.token, 'remote')).toBeNull();
    const next = f.credentials.createStatic('next');
    f.config.mcpExport.remote.enabled = false;
    expect(f.credentials.verify(next.token, 'remote')).toBeNull();
  });
  it('contains corrupt credential storage failures within the bridge', () => {
    writeBridgeFile(join(f.appHome, 'mcp-sharing/generation'), 'invalid generation');
    writeBridgeFile(join(f.appHome, 'mcp-sharing/credentials.enc'), 'invalid ciphertext');
    const credentials = new SharingCredentials(f.appHome, fixtureEncryption(), f.store, () => f.config);
    expect(credentials.clients()).toEqual([]);
    expect(credentials.verify('kai_mcp_invalid', 'remote')).toBeNull();
    expect(f.store.recent().some((entry) => entry.kind === 'error')).toBe(true);
  });
});
