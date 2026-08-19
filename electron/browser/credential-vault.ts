import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  openSync,
  fstatSync,
  closeSync,
  constants as fsConstants,
} from 'node:fs';
import { join } from 'node:path';
import { clipboard, safeStorage, systemPreferences } from 'electron';
import type { BrowserCredentialSummary } from '../../shared/browser.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

type StoredCredential = BrowserCredentialSummary & { encryptedPassword: string };
type VaultFile = { version: 1; credentials: StoredCredential[] };

type EncryptionAdapter = Pick<typeof safeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'> &
  Partial<Pick<typeof safeStorage, 'getSelectedStorageBackend'>>;
type ClipboardAdapter = Pick<typeof clipboard, 'readText' | 'writeText' | 'clear'>;
type AtomicWriteAdapter = typeof atomicWriteFileSync;

// The OS clipboard is process-global even though Browser credential vaults are
// profile-scoped. Track the newest writer per clipboard adapter so an older
// vault's expiry timer or disposal cannot erase a newer copy of the same text.
const clipboardPasswordOwners = new WeakMap<ClipboardAdapter, symbol>();

export const MAX_BROWSER_CREDENTIALS = 1_000;
export const MAX_CREDENTIAL_VAULT_BYTES = 32 * 1024 * 1024;

function safeScopeKey(value: string): string {
  if (!/^(global|conversation-[a-f0-9]{24})$/.test(value)) throw new Error('Invalid browser profile key.');
  return value;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Read a credential-vault file's bytes via a SINGLE descriptor, closing the TOCTOU window (R183):
 * a plain lstat-then-read(path) can be defeated by swapping the path for a symlink/FIFO — or enlarging
 * the file — between the check and the open. Open O_NOFOLLOW (no link-follow) + O_NONBLOCK (a FIFO can't
 * hang openSync), then fstat the actual fd for type (regular file) and size before reading from that same
 * fd. Throws on ENOENT (mapped to 0 by callers), non-regular file, or over-cap size. Shared by every
 * vault reader so the sync and async paths cannot diverge.
 */
function readCredentialVaultBytes(filePath: string): Buffer {
  const fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new Error('Credential vault is not a regular file.');
    }
    if (!Number.isSafeInteger(st.size) || st.size < 0 || st.size > MAX_CREDENTIAL_VAULT_BYTES) {
      throw new Error('Credential vault exceeds its size limit.');
    }
    const contents = readFileSync(fd);
    if (contents.byteLength > MAX_CREDENTIAL_VAULT_BYTES) {
      throw new Error('Credential vault exceeds its size limit.');
    }
    return contents;
  } finally {
    closeSync(fd);
  }
}

/** Electron reports encryption as "available" on Linux even when it falls back
 * to the hard-coded basic_text backend. Saved Browser passwords must fail
 * closed unless Electron is backed by an OS credential store. */
export function securePasswordEncryptionAvailable(
  encryption: EncryptionAdapter,
  platform: NodeJS.Platform = process.platform,
): boolean {
  try {
    if (!encryption.isEncryptionAvailable()) return false;
    if (platform !== 'linux') return true;
    return (
      typeof encryption.getSelectedStorageBackend === 'function' &&
      encryption.getSelectedStorageBackend() !== 'basic_text'
    );
  } catch {
    return false;
  }
}

function isStoredCredential(value: unknown, scopeKey: string): value is StoredCredential {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<StoredCredential>;
  return (
    typeof item.id === 'string' &&
    item.scopeKey === scopeKey &&
    typeof item.origin === 'string' &&
    typeof item.username === 'string' &&
    typeof item.encryptedPassword === 'string' &&
    typeof item.createdAt === 'string' &&
    typeof item.updatedAt === 'string'
  );
}

function storedCredentialsFromJson(contents: string, scopeKey: string): StoredCredential[] {
  const parsed = JSON.parse(contents) as Partial<VaultFile>;
  if (
    parsed.version !== 1 ||
    !Array.isArray(parsed.credentials) ||
    parsed.credentials.length > MAX_BROWSER_CREDENTIALS
  ) {
    throw new Error('Unsupported credential vault format.');
  }
  if (!parsed.credentials.every((item) => isStoredCredential(item, scopeKey))) {
    throw new Error('Credential vault contains invalid records.');
  }
  return parsed.credentials;
}

/** Electron exposes native user-presence authentication on macOS through
 * Touch ID only. Check capability before advertising or invoking it so Macs
 * without available/enrolled Touch ID keep protected controls locked. */
export function nativeCredentialAuthenticationAvailable(): boolean {
  if (
    process.platform !== 'darwin' ||
    typeof systemPreferences.canPromptTouchID !== 'function' ||
    typeof systemPreferences.promptTouchID !== 'function'
  ) {
    return false;
  }
  try {
    return systemPreferences.canPromptTouchID();
  } catch {
    return false;
  }
}

async function nativeAuthenticate(reason: string): Promise<void> {
  if (!nativeCredentialAuthenticationAvailable()) {
    throw new Error('Touch ID authentication is unavailable on this Mac.');
  }
  await systemPreferences.promptTouchID(reason);
}

export class BrowserCredentialVault {
  private readonly filePath: string;
  private credentials: StoredCredential[];
  private loadFailure: Error | null = null;
  private copiedPassword: string | null = null;
  private clipboardOwnershipToken: symbol | null = null;
  private clipboardClearTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly scopeKey: string,
    appHome: string,
    private readonly encryption: EncryptionAdapter = safeStorage,
    private readonly authenticate: (reason: string) => Promise<void> = nativeAuthenticate,
    private readonly clipboardApi: ClipboardAdapter = clipboard,
    private readonly writeFile: AtomicWriteAdapter = atomicWriteFileSync,
  ) {
    safeScopeKey(scopeKey);
    const directory = join(appHome, 'browser', 'credentials');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.filePath = join(directory, `${scopeKey}.json`);
    this.credentials = this.load();
  }

  private load(): StoredCredential[] {
    try {
      // Read via a single descriptor (R180/R183): open O_NOFOLLOW + O_NONBLOCK, then fstat the fd for
      // type + size before reading — a symlink/FIFO/device is rejected without following or blocking,
      // and the check/read share one fd so the path can't be swapped or enlarged between them.
      return storedCredentialsFromJson(readCredentialVaultBytes(this.filePath).toString('utf8'), this.scopeKey);
    } catch (error) {
      if (isMissingFile(error)) return [];
      // Never turn an unreadable/corrupt vault into an apparently empty,
      // writable one. A later save would atomically replace potentially
      // recoverable encrypted credentials with the new subset.
      this.loadFailure = new Error(
        'The saved-password vault is unreadable or corrupted and was not modified. Clear Browser data or restore the vault before saving passwords.',
      );
      return [];
    }
  }

  private assertWritable(): void {
    if (this.loadFailure) throw this.loadFailure;
  }

  private ensureEncryption(): void {
    if (!securePasswordEncryptionAvailable(this.encryption)) {
      throw new Error('Secure OS password encryption is unavailable. The credential was not saved.');
    }
  }

  private saveFile(credentials: StoredCredential[]): void {
    if (credentials.length > MAX_BROWSER_CREDENTIALS) {
      throw new Error(`The browser password vault is limited to ${MAX_BROWSER_CREDENTIALS} credentials.`);
    }
    const payload: VaultFile = { version: 1, credentials };
    const serialized = JSON.stringify(payload, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_CREDENTIAL_VAULT_BYTES) {
      throw new Error('The browser password vault exceeds its storage limit.');
    }
    this.writeFile(this.filePath, serialized, { mode: 0o600 });
  }

  list(query = ''): BrowserCredentialSummary[] {
    const needle = query.trim().toLowerCase();
    return this.credentials
      .filter(
        (item) => !needle || item.origin.toLowerCase().includes(needle) || item.username.toLowerCase().includes(needle),
      )
      .map(({ encryptedPassword: _secret, ...summary }) => ({ ...summary }));
  }

  has(origin: string, username: string): boolean {
    return this.credentials.some((item) => item.origin === origin && item.username === username);
  }

  async upsertWithAuthentication(
    origin: string,
    username: string,
    password: string,
    checkpoint: () => void = () => undefined,
  ): Promise<BrowserCredentialSummary> {
    checkpoint();
    if (this.has(origin, username)) {
      await this.authenticate(`Replace a saved ${__BRAND_PRODUCT_NAME} browser password`);
    }
    checkpoint();
    return this.upsert(origin, username, password);
  }

  upsert(origin: string, username: string, password: string): BrowserCredentialSummary {
    this.assertWritable();
    this.ensureEncryption();
    if (!origin || !password) throw new Error('Origin and password are required.');
    const now = new Date().toISOString();
    const encryptedPassword = this.encryption.encryptString(password).toString('base64');
    const existingIndex = this.credentials.findIndex((item) => item.origin === origin && item.username === username);
    if (existingIndex >= 0) {
      const updated: StoredCredential = {
        ...this.credentials[existingIndex],
        encryptedPassword,
        updatedAt: now,
      };
      const next = this.credentials.map((item, index) => (index === existingIndex ? updated : item));
      this.saveFile(next);
      this.credentials = next;
      const { encryptedPassword: _secret, ...summary } = updated;
      return { ...summary };
    }
    if (this.credentials.length >= MAX_BROWSER_CREDENTIALS) {
      throw new Error(`The browser password vault is limited to ${MAX_BROWSER_CREDENTIALS} credentials.`);
    }
    const created: StoredCredential = {
      id: randomUUID(),
      scopeKey: this.scopeKey,
      origin,
      username,
      encryptedPassword,
      createdAt: now,
      updatedAt: now,
    };
    const next = [...this.credentials, created];
    this.saveFile(next);
    this.credentials = next;
    const { encryptedPassword: _secret, ...summary } = created;
    return { ...summary };
  }

  update(id: string, username: string, password: string): BrowserCredentialSummary {
    this.assertWritable();
    this.ensureEncryption();
    if (!password) throw new Error('Password is required.');
    const credential = this.credentials.find((item) => item.id === id);
    if (!credential) throw new Error('Credential not found.');
    if (
      this.credentials.some((item) => item.id !== id && item.origin === credential.origin && item.username === username)
    ) {
      throw new Error('A saved credential for this site and username already exists.');
    }
    const updated: StoredCredential = {
      ...credential,
      username,
      encryptedPassword: this.encryption.encryptString(password).toString('base64'),
      updatedAt: new Date().toISOString(),
    };
    const next = this.credentials.map((item) => (item.id === id ? updated : item));
    this.saveFile(next);
    this.credentials = next;
    const { encryptedPassword: _secret, ...summary } = updated;
    return { ...summary };
  }

  async updateWithAuthentication(
    id: string,
    username: string,
    password: string,
    checkpoint: () => void = () => undefined,
  ): Promise<BrowserCredentialSummary> {
    checkpoint();
    if (!this.credentials.some((item) => item.id === id)) throw new Error('Credential not found.');
    await this.authenticate(`Replace a saved ${__BRAND_PRODUCT_NAME} browser password`);
    checkpoint();
    return this.update(id, username, password);
  }

  async delete(id: string, checkpoint: () => void = () => undefined): Promise<void> {
    checkpoint();
    this.assertWritable();
    if (!this.credentials.some((item) => item.id === id)) throw new Error('Credential not found.');
    await this.authenticate(`Delete a saved ${__BRAND_PRODUCT_NAME} browser password`);
    checkpoint();
    this.assertWritable();
    if (!this.credentials.some((item) => item.id === id)) throw new Error('Credential not found.');
    const next = this.credentials.filter((item) => item.id !== id);
    this.saveFile(next);
    this.credentials = next;
  }

  decrypt(id: string): { origin: string; username: string; password: string } {
    this.ensureEncryption();
    const credential = this.credentials.find((item) => item.id === id);
    if (!credential) throw new Error('Credential not found.');
    const password = this.encryption.decryptString(Buffer.from(credential.encryptedPassword, 'base64'));
    return { origin: credential.origin, username: credential.username, password };
  }

  findForOrigin(origin: string, id?: string): BrowserCredentialSummary | null {
    const match = id
      ? this.credentials.find((item) => item.id === id && item.origin === origin)
      : (() => {
          const matches = this.credentials.filter((item) => item.origin === origin);
          if (matches.length > 1) {
            throw new Error('Multiple saved credentials match this site. Choose a specific account.');
          }
          return matches[0];
        })();
    if (!match) return null;
    const { encryptedPassword: _secret, ...summary } = match;
    return { ...summary };
  }

  async reveal(id: string, checkpoint: () => void = () => undefined): Promise<string> {
    checkpoint();
    await this.authenticate(`Reveal a saved ${__BRAND_PRODUCT_NAME} browser password`);
    checkpoint();
    return this.decrypt(id).password;
  }

  async copy(id: string, checkpoint: () => void = () => undefined): Promise<void> {
    checkpoint();
    await this.authenticate(`Copy a saved ${__BRAND_PRODUCT_NAME} browser password`);
    checkpoint();
    const value = this.decrypt(id).password;
    this.clearCopiedPassword();
    this.clipboardApi.writeText(value);
    const ownershipToken = Symbol('browser-password-clipboard-owner');
    this.copiedPassword = value;
    this.clipboardOwnershipToken = ownershipToken;
    clipboardPasswordOwners.set(this.clipboardApi, ownershipToken);
    this.clipboardClearTimer = setTimeout(() => this.clearCopiedPassword(), 30_000);
    this.clipboardClearTimer.unref?.();
  }

  private clearCopiedPassword(): void {
    if (this.clipboardClearTimer) {
      clearTimeout(this.clipboardClearTimer);
      this.clipboardClearTimer = null;
    }
    const copiedPassword = this.copiedPassword;
    const ownershipToken = this.clipboardOwnershipToken;
    this.copiedPassword = null;
    this.clipboardOwnershipToken = null;
    if (
      copiedPassword === null ||
      ownershipToken === null ||
      clipboardPasswordOwners.get(this.clipboardApi) !== ownershipToken
    ) {
      return;
    }
    clipboardPasswordOwners.delete(this.clipboardApi);
    try {
      if (this.clipboardApi.readText() === copiedPassword) this.clipboardApi.clear();
    } catch {
      // Clipboard access can fail while Electron is shutting down. Teardown is
      // best-effort, but the plaintext and its timer must still be forgotten.
    }
  }

  count(): number {
    if (this.loadFailure) throw this.loadFailure;
    return this.credentials.length;
  }

  clear(): void {
    this.clearCopiedPassword();
    try {
      rmSync(this.filePath, { force: true });
    } catch {
      this.saveFile([]);
    }
    this.credentials = [];
    // Explicit Browser-data clearing is the recovery path for a corrupt vault.
    // Only forget a load failure after the removal or empty replacement succeeds.
    this.loadFailure = null;
  }

  dispose(): void {
    this.clearCopiedPassword();
  }
}

/** Count stored credentials without retaining encrypted payloads in a live
 * vault. Used by the Browser Data screen while enumerating inactive profiles. */
export function readStoredCredentialCount(appHome: string, scopeKey: string): number {
  scopeKey = safeScopeKey(scopeKey);
  const filePath = join(appHome, 'browser', 'credentials', `${scopeKey}.json`);
  try {
    // Single-descriptor read (R180/R183): open+fstat+read share one fd — reject a symlink/FIFO/device
    // and enforce the size cap on the actual descriptor, with no lstat→read TOCTOU window.
    return storedCredentialsFromJson(readCredentialVaultBytes(filePath).toString('utf8'), scopeKey).length;
  } catch (error) {
    if (isMissingFile(error)) return 0;
    throw error;
  }
}

/** Asynchronously count an inactive vault without constructing a live vault
 * or blocking Electron's main thread on bounded file I/O. Invalid vaults fail
 * closed exactly like the synchronous compatibility helper above. */
export async function readStoredCredentialCountAsync(appHome: string, scopeKey: string): Promise<number> {
  scopeKey = safeScopeKey(scopeKey);
  const filePath = join(appHome, 'browser', 'credentials', `${scopeKey}.json`);
  try {
    // Single-descriptor read (R181/R183): the async lstat→readFile(path) had a TOCTOU window (swap to a
    // FIFO/symlink or enlarge the file between check and read → hang / oversized alloc). Bind validation
    // and read to ONE fd via the shared helper. The open is O_NONBLOCK + fstat-gated, so it neither
    // follows a link nor blocks main on a FIFO — safe to run on the main thread despite being sync I/O.
    return storedCredentialsFromJson(readCredentialVaultBytes(filePath).toString('utf8'), scopeKey).length;
  } catch (error) {
    if (isMissingFile(error)) return 0;
    throw error;
  }
}

export function listStoredCredentialScopeKeys(appHome: string): string[] {
  const directory = join(appHome, 'browser', 'credentials');
  try {
    return readdirSync(directory)
      .filter((name) => /^(global|conversation-[a-f0-9]{24})\.json$/.test(name))
      .map((name) => name.slice(0, -5));
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}
