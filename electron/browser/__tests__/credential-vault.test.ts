import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {},
  systemPreferences: {},
  clipboard: {},
}));

import {
  BROWSER_CREDENTIAL_AUTHENTICATION_TIMEOUT_MS,
  BrowserCredentialAuthenticationInterruptedError,
  BrowserCredentialVault,
  listStoredCredentialScopeKeys,
  MAX_BROWSER_CREDENTIALS,
  MAX_CREDENTIAL_VAULT_BYTES,
  nativeCredentialAuthenticationAvailable,
  readStoredCredentialCount,
  readStoredCredentialCountAsync,
  securePasswordEncryptionAvailable,
} from '../credential-vault.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(
  available = true,
  beforeCreate?: (appHome: string) => void,
  writeFile: typeof atomicWriteFileSync = atomicWriteFileSync,
) {
  const appHome = mkdtempSync(join(tmpdir(), 'kai-browser-vault-'));
  dirs.push(appHome);
  const encryption = {
    isEncryptionAvailable: () => available,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''),
  };
  let clipboardValue = '';
  const clipboard = {
    readText: () => clipboardValue,
    writeText: (value: string) => {
      clipboardValue = value;
    },
    clear: () => {
      clipboardValue = '';
    },
  };
  const authenticate = vi.fn(async (): Promise<void> => undefined);
  beforeCreate?.(appHome);
  const vault = new BrowserCredentialVault('global', appHome, encryption, authenticate, clipboard, writeFile);
  return { appHome, vault, encryption, authenticate, clipboard, clipboardValue: () => clipboardValue };
}

describe('BrowserCredentialVault', () => {
  it('does not advertise native credential authentication without Touch ID capability', () => {
    expect(nativeCredentialAuthenticationAvailable()).toBe(false);
  });

  it('fails closed when secure OS encryption is unavailable', () => {
    const { vault } = setup(false);
    expect(() => vault.upsert('https://example.com', 'user', 'secret')).toThrow(/unavailable/);
    expect(vault.list()).toEqual([]);
  });

  it('rejects Electron basic_text and unknown Linux encryption backends', () => {
    const encryption = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString(),
    };

    expect(
      securePasswordEncryptionAvailable({ ...encryption, getSelectedStorageBackend: () => 'basic_text' }, 'linux'),
    ).toBe(false);
    expect(securePasswordEncryptionAvailable(encryption, 'linux')).toBe(false);
    expect(
      securePasswordEncryptionAvailable({ ...encryption, getSelectedStorageBackend: () => 'gnome_libsecret' }, 'linux'),
    ).toBe(true);
    expect(securePasswordEncryptionAvailable(encryption, 'darwin')).toBe(true);
  });

  it('encrypts, updates, and lists metadata without plaintext', async () => {
    const { appHome, vault } = setup();
    const created = vault.upsert('https://example.com', 'user', 'secret');
    vault.upsert('https://example.com', 'user', 'new-secret');
    expect(vault.list()).toEqual([{ ...created, updatedAt: '2026-01-01T00:00:00.000Z' }]);
    expect(vault.decrypt(created.id).password).toBe('new-secret');
    expect(statSync(join(appHome, 'browser', 'credentials', 'global.json')).mode & 0o777).toBe(0o600);
    expect(listStoredCredentialScopeKeys(appHome)).toEqual(['global']);
    expect(readStoredCredentialCount(appHome, 'global')).toBe(1);
    await expect(readStoredCredentialCountAsync(appHome, 'global')).resolves.toBe(1);
  });

  it('fails closed while counting malformed inactive credential vaults', async () => {
    const { appHome } = setup(true, (home) => {
      const directory = join(home, 'browser', 'credentials');
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'global.json'),
        JSON.stringify({ version: 1, credentials: [{ scopeKey: 'global', encryptedPassword: 'ciphertext' }] }),
      );
    });

    expect(() => readStoredCredentialCount(appHome, 'global')).toThrow(/invalid records/i);
    await expect(readStoredCredentialCountAsync(appHome, 'global')).rejects.toThrow(/invalid records/i);
  });

  it('rejects an oversized vault before reading or replacing it', async () => {
    const { appHome, vault } = setup(true, (home) => {
      const directory = join(home, 'browser', 'credentials');
      mkdirSync(directory, { recursive: true });
      const filePath = join(directory, 'global.json');
      writeFileSync(filePath, '');
      truncateSync(filePath, MAX_CREDENTIAL_VAULT_BYTES + 1);
    });
    const filePath = join(appHome, 'browser', 'credentials', 'global.json');

    expect(vault.list()).toEqual([]);
    expect(() => vault.upsert('https://example.com', 'user', 'secret')).toThrow(/unreadable or corrupted/);
    expect(statSync(filePath).size).toBe(MAX_CREDENTIAL_VAULT_BYTES + 1);
    expect(() => readStoredCredentialCount(appHome, 'global')).toThrow(/size limit/i);
    await expect(readStoredCredentialCountAsync(appHome, 'global')).rejects.toThrow(/size limit/i);
  });

  it('rejects vaults and new writes beyond the credential-count limit', () => {
    const credentials = Array.from({ length: MAX_BROWSER_CREDENTIALS }, (_, index) => ({
      id: `credential-${index}`,
      scopeKey: 'global',
      origin: `https://${index}.example.com`,
      username: `user-${index}`,
      encryptedPassword: Buffer.from(`encrypted:secret-${index}`).toString('base64'),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    const { vault } = setup(true, (home) => {
      const directory = join(home, 'browser', 'credentials');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'global.json'), JSON.stringify({ version: 1, credentials }));
    });

    expect(vault.count()).toBe(MAX_BROWSER_CREDENTIALS);
    expect(() => vault.upsert('https://overflow.example.com', 'user', 'secret')).toThrow(/limited to/);
  });

  it('requires an account choice when multiple credentials match one origin', () => {
    const { vault } = setup();
    const alice = vault.upsert('https://example.com', 'alice', 'alice-secret');
    vault.upsert('https://example.com', 'bob', 'bob-secret');

    expect(() => vault.findForOrigin('https://example.com')).toThrow(/Multiple saved credentials/);
    expect(vault.findForOrigin('https://example.com', alice.id)).toMatchObject({ id: alice.id, username: 'alice' });
  });

  it('updates by id without overwriting another account on a username collision', () => {
    const { vault } = setup();
    const alice = vault.upsert('https://example.com', 'alice', 'alice-secret');
    const bob = vault.upsert('https://example.com', 'bob', 'bob-secret');

    expect(() => vault.update(alice.id, 'bob', 'replacement')).toThrow(/already exists/);
    expect(vault.decrypt(alice.id)).toMatchObject({ username: 'alice', password: 'alice-secret' });
    expect(vault.decrypt(bob.id)).toMatchObject({ username: 'bob', password: 'bob-secret' });

    expect(vault.update(alice.id, 'carol', 'carol-secret')).toMatchObject({ id: alice.id, username: 'carol' });
    expect(vault.decrypt(alice.id)).toMatchObject({ username: 'carol', password: 'carol-secret' });
  });

  it('requires authentication before renderer-requested credential replacements', async () => {
    const { vault, authenticate } = setup();
    const created = await vault.upsertWithAuthentication('https://example.com', 'alice', 'first-secret');
    expect(authenticate).not.toHaveBeenCalled();

    await vault.upsertWithAuthentication('https://example.com', 'alice', 'second-secret');
    expect(authenticate).toHaveBeenCalledTimes(1);

    await vault.updateWithAuthentication(created.id, 'alice', 'third-secret');
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(vault.decrypt(created.id).password).toBe('third-secret');
  });

  it('does not replace a credential when native authentication fails', async () => {
    const { vault, authenticate } = setup();
    const created = vault.upsert('https://example.com', 'alice', 'first-secret');
    authenticate.mockRejectedValue(new Error('authentication denied'));

    await expect(vault.upsertWithAuthentication('https://example.com', 'alice', 'replacement-secret')).rejects.toThrow(
      /authentication denied/,
    );
    await expect(vault.updateWithAuthentication(created.id, 'alice', 'replacement-secret')).rejects.toThrow(
      /authentication denied/,
    );
    expect(vault.decrypt(created.id).password).toBe('first-secret');
  });

  it('authenticates before deleting a credential and preserves it when authentication fails', async () => {
    const { vault, authenticate } = setup();
    const created = vault.upsert('https://example.com', 'alice', 'first-secret');
    authenticate.mockRejectedValueOnce(new Error('authentication denied'));

    await expect(vault.delete(created.id)).rejects.toThrow(/authentication denied/);
    expect(vault.has('https://example.com', 'alice')).toBe(true);

    await vault.delete(created.id);
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(vault.has('https://example.com', 'alice')).toBe(false);
  });

  it('preserves a corrupt vault and rejects mutations until the user clears it', async () => {
    const malformed = '{"version":1,"credentials":[';
    const { appHome, vault } = setup(true, (home) => {
      const directory = join(home, 'browser', 'credentials');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'global.json'), malformed);
    });
    const filePath = join(appHome, 'browser', 'credentials', 'global.json');

    expect(vault.list()).toEqual([]);
    expect(() => vault.upsert('https://example.com', 'user', 'new-secret')).toThrow(/unreadable or corrupted/);
    await expect(vault.delete('missing')).rejects.toThrow(/unreadable or corrupted/);
    expect(readFileSync(filePath, 'utf8')).toBe(malformed);

    vault.clear();
    expect(() => vault.upsert('https://example.com', 'user', 'new-secret')).not.toThrow();
  });

  it('does not retain failed credential mutations in memory or a later successful save', async () => {
    let failWrites = false;
    const writeFile: typeof atomicWriteFileSync = (...args) => {
      if (failWrites) throw new Error('credential disk is full');
      atomicWriteFileSync(...args);
    };
    const { appHome, vault, encryption, authenticate, clipboard } = setup(true, undefined, writeFile);
    const alice = vault.upsert('https://example.com', 'alice', 'alice-secret');
    const bob = vault.upsert('https://example.com', 'bob', 'bob-secret');

    failWrites = true;
    expect(() => vault.upsert('https://example.com', 'alice', 'bad-upsert')).toThrow(/disk is full/);
    expect(() => vault.update(bob.id, 'robert', 'bad-update')).toThrow(/disk is full/);
    await expect(vault.delete(alice.id)).rejects.toThrow(/disk is full/);
    expect(() => vault.upsert('https://example.com', 'carol', 'bad-create')).toThrow(/disk is full/);

    expect(vault.decrypt(alice.id)).toMatchObject({ username: 'alice', password: 'alice-secret' });
    expect(vault.decrypt(bob.id)).toMatchObject({ username: 'bob', password: 'bob-secret' });
    expect(vault.has('https://example.com', 'carol')).toBe(false);

    failWrites = false;
    vault.upsert('https://example.com', 'dave', 'dave-secret');
    const reloaded = new BrowserCredentialVault('global', appHome, encryption, authenticate, clipboard, writeFile);
    expect(reloaded.decrypt(alice.id)).toMatchObject({ username: 'alice', password: 'alice-secret' });
    expect(reloaded.decrypt(bob.id)).toMatchObject({ username: 'bob', password: 'bob-secret' });
    expect(reloaded.has('https://example.com', 'carol')).toBe(false);
    expect(reloaded.has('https://example.com', 'dave')).toBe(true);
  });

  it('requires authentication for reveal/copy and clears an unchanged clipboard', async () => {
    vi.useFakeTimers();
    const { vault, authenticate, clipboardValue } = setup();
    const onClipboardCleared = vi.fn();
    vault.setClipboardClearCallback(onClipboardCleared);
    const created = vault.upsert('https://example.com', 'user', 'secret');
    await expect(vault.reveal(created.id)).resolves.toBe('secret');
    await vault.copy(created.id);
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(clipboardValue()).toBe('secret');
    expect(vault.hasPendingClipboardClear()).toBe(true);
    expect(onClipboardCleared).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(clipboardValue()).toBe('');
    expect(vault.hasPendingClipboardClear()).toBe(false);
    expect(onClipboardCleared).toHaveBeenCalledOnce();
  });

  it('does not copy a password after renderer authority expires during authentication', async () => {
    const { vault, authenticate, clipboardValue } = setup();
    const created = vault.upsert('https://example.com', 'user', 'secret');
    let releaseAuthentication!: () => void;
    authenticate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseAuthentication = resolve;
        }),
    );
    let authorityCurrent = true;
    const checkpoint = () => {
      if (!authorityCurrent) throw new Error('renderer authority expired');
    };

    const copyPending = vault.copy(created.id, checkpoint);
    await vi.waitFor(() => expect(authenticate).toHaveBeenCalledOnce());
    authorityCurrent = false;
    releaseAuthentication();

    await expect(copyPending).rejects.toThrow(/authority expired/);
    expect(clipboardValue()).toBe('');
  });

  it('bounds native authentication and ignores a late successful replacement', async () => {
    vi.useFakeTimers();
    const { vault, authenticate } = setup();
    const created = vault.upsert('https://example.com', 'user', 'original-secret');
    let releaseAuthentication!: () => void;
    authenticate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseAuthentication = resolve;
        }),
    );

    const replacement = vault.updateWithAuthentication(created.id, 'user', 'replacement-secret');
    const rejected = expect(replacement).rejects.toBeInstanceOf(BrowserCredentialAuthenticationInterruptedError);
    await vi.advanceTimersByTimeAsync(BROWSER_CREDENTIAL_AUTHENTICATION_TIMEOUT_MS);
    await rejected;

    releaseAuthentication();
    await vi.advanceTimersByTimeAsync(0);
    expect(vault.decrypt(created.id).password).toBe('original-secret');
  });

  it('abandons native authentication when renderer authority is revoked', async () => {
    const { vault, authenticate } = setup();
    const created = vault.upsert('https://example.com', 'user', 'original-secret');
    let releaseAuthentication!: () => void;
    authenticate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseAuthentication = resolve;
        }),
    );
    const controller = new AbortController();

    const replacement = vault.updateWithAuthentication(
      created.id,
      'user',
      'replacement-secret',
      () => undefined,
      controller.signal,
    );
    controller.abort();
    await expect(replacement).rejects.toBeInstanceOf(BrowserCredentialAuthenticationInterruptedError);

    releaseAuthentication();
    await Promise.resolve();
    expect(vault.decrypt(created.id).password).toBe('original-secret');
  });

  it('clears an unchanged copied password immediately when the vault is cleared or disposed', async () => {
    vi.useFakeTimers();
    const cleared = setup();
    const clearedCredential = cleared.vault.upsert('https://example.com', 'user', 'clear-secret');
    await cleared.vault.copy(clearedCredential.id);
    expect(cleared.clipboardValue()).toBe('clear-secret');

    cleared.vault.clear();
    expect(cleared.clipboardValue()).toBe('');

    const disposed = setup();
    const disposedCredential = disposed.vault.upsert('https://example.com', 'user', 'dispose-secret');
    await disposed.vault.copy(disposedCredential.id);
    expect(disposed.clipboardValue()).toBe('dispose-secret');

    disposed.vault.dispose();
    expect(disposed.clipboardValue()).toBe('');
  });

  it('preserves user-replaced clipboard text when the vault is disposed', async () => {
    vi.useFakeTimers();
    const { vault, clipboard, clipboardValue } = setup();
    const created = vault.upsert('https://example.com', 'user', 'secret');
    await vault.copy(created.id);
    clipboard.writeText('user clipboard text');

    vault.dispose();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(clipboardValue()).toBe('user clipboard text');
  });

  it('restarts clipboard expiry when a different password is copied', async () => {
    vi.useFakeTimers();
    const { vault, clipboardValue } = setup();
    const first = vault.upsert('https://example.com', 'first', 'first-secret');
    const second = vault.upsert('https://example.com', 'second', 'second-secret');
    await vault.copy(first.id);
    await vi.advanceTimersByTimeAsync(10_000);
    await vault.copy(second.id);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(clipboardValue()).toBe('second-secret');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(clipboardValue()).toBe('');
  });

  it('does not let an older vault timer clear a newer same-value clipboard copy', async () => {
    vi.useFakeTimers();
    const first = setup();
    const secondHome = mkdtempSync(join(tmpdir(), 'kai-browser-vault-'));
    dirs.push(secondHome);
    const second = new BrowserCredentialVault(
      'global',
      secondHome,
      first.encryption,
      vi.fn(async (): Promise<void> => undefined),
      first.clipboard,
    );
    const firstCredential = first.vault.upsert('https://first.example.com', 'user', 'shared-secret');
    const secondCredential = second.upsert('https://second.example.com', 'user', 'shared-secret');

    await first.vault.copy(firstCredential.id);
    await vi.advanceTimersByTimeAsync(10_000);
    await second.copy(secondCredential.id);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(first.clipboardValue()).toBe('shared-secret');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(first.clipboardValue()).toBe('');
  });

  it('does not let an older vault disposal clear a newer same-value clipboard copy', async () => {
    vi.useFakeTimers();
    const first = setup();
    const secondHome = mkdtempSync(join(tmpdir(), 'kai-browser-vault-'));
    dirs.push(secondHome);
    const second = new BrowserCredentialVault(
      'global',
      secondHome,
      first.encryption,
      vi.fn(async (): Promise<void> => undefined),
      first.clipboard,
    );
    const firstCredential = first.vault.upsert('https://first.example.com', 'user', 'shared-secret');
    const secondCredential = second.upsert('https://second.example.com', 'user', 'shared-secret');

    await first.vault.copy(firstCredential.id);
    await second.copy(secondCredential.id);
    first.vault.dispose();

    expect(first.clipboardValue()).toBe('shared-secret');
    second.dispose();
    expect(first.clipboardValue()).toBe('');
  });
});
