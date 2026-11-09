import { mkdirSync, openSync, fstatSync, readSync, closeSync, constants, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export type McpCredentials = {
  clientSecret?: string;
  client?: OAuthClientInformationMixed;
  clientRegistration?: 'dynamic' | 'metadata' | 'configured';
  discovery?: OAuthServerInfo;
  tokens?: OAuthTokens;
  issuedAt?: number;
  expiresAt?: number;
  redirectUri?: string;
};
export interface McpEncryption {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

/** Tokens never enter config.json. The backend is the sole reader/writer. */
export class McpCredentialStore {
  private records: Record<string, McpCredentials> = {};
  storage: 'encrypted' | 'session' = 'session';
  private readonly path: string;

  constructor(
    appHome: string,
    private encryption: McpEncryption,
    platform = process.platform,
  ) {
    this.path = join(appHome, 'mcp', 'credentials.enc');
    try {
      this.storage =
        encryption.isEncryptionAvailable() &&
        (platform !== 'linux' ||
          (encryption.getSelectedStorageBackend?.() !== undefined &&
            encryption.getSelectedStorageBackend() !== 'basic_text'))
          ? 'encrypted'
          : 'session';
    } catch {
      /* Keychain unavailable: session only. */
    }
    if (this.storage === 'session') return;
    let fd: number | undefined;
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('Invalid MCP credential store');
      const buffer = Buffer.alloc(4 * 1024 * 1024 + 1);
      let size = 0,
        count = 0;
      while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null)) > 0)
        size += count;
      if (size === buffer.length) throw new Error('Invalid MCP credential store');
      const parsed = JSON.parse(encryption.decryptString(buffer.subarray(0, size)));
      if (
        parsed.version !== 1 ||
        !parsed.records ||
        typeof parsed.records !== 'object' ||
        Array.isArray(parsed.records)
      ) {
        throw new Error('Invalid MCP credential store');
      }
      this.records = Object.fromEntries(
        Object.entries(parsed.records as Record<string, McpCredentials>).filter(
          ([key]) => !existsSync(this.markerPath(key)),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Preserve an unreadable vault, rather than overwriting credentials after a keychain outage.
        this.storage = 'session';
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  get(key: string): McpCredentials {
    return structuredClone(this.records[key] ?? {});
  }
  set(key: string, value: McpCredentials): void {
    const next = { ...this.records, [key]: structuredClone(value) };
    if (this.persist(next)) {
      try {
        rmSync(this.markerPath(key), { force: true });
      } catch {
        /* A retained marker safely requires sign-in next restart. */
      }
    }
    this.records = next;
  }
  private markerPath(key: string): string {
    return join(dirname(this.path), 'invalidated', createHash('sha256').update(key).digest('hex'));
  }
  invalidate(key: string): void {
    // A public hash-only marker prevents old encrypted credentials from returning
    // after sign-out/config changes while the keychain cannot rewrite the vault.
    const marker = this.markerPath(key);
    try {
      mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
      atomicWriteFileSync(marker, '', { mode: 0o600 });
    } catch {
      throw new Error('Could not persist MCP sign-out. Check application-home write permissions and try again.');
    }
    delete this.records[key];
  }
  prune(keys: Set<string>): void {
    const next = Object.fromEntries(Object.entries(this.records).filter(([key]) => keys.has(key)));
    if (Object.keys(next).length === Object.keys(this.records).length) return;
    for (const key of Object.keys(this.records)) if (!keys.has(key)) this.invalidate(key);
    this.persist(next);
    this.records = next;
  }
  private persist(records: Record<string, McpCredentials>): boolean {
    if (this.storage === 'session') return false;
    try {
      const encrypted = this.encryption.encryptString(JSON.stringify({ version: 1, records }));
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      atomicWriteFileSync(this.path, encrypted, { mode: 0o600 });
      return true;
    } catch {
      // Preserve the previous vault if storage becomes unavailable mid-session.
      this.storage = 'session';
      return false;
    }
  }
}
