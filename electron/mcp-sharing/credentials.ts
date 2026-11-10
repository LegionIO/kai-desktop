import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  OAuthClientInformationFullSchema,
  type OAuthClientInformationFull,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';
import type { AppConfig } from '../config/schema.js';
import type { McpEncryption } from '../mcp/credential-store.js';
import type { McpSharingClient } from '../../shared/plugin-bridge.js';
import type { BridgeStateStore } from '../plugin-bridge/state.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { hash, readBoundedFile } from '../plugin-bridge/files.js';
import type { McpPrincipal } from './service.js';

type Credential = {
  clientId: string;
  kind: 'local' | 'static' | 'access' | 'refresh';
  expiresAt: number;
  resource?: string;
  epoch?: string;
};
type Ledger = {
  version: 1;
  generation: string;
  clients: Record<string, McpSharingClient>;
  registrations: Record<string, OAuthClientInformationFull>;
  credentials: Record<string, Credential>;
};
const ledgerSchema = z.object({
  version: z.literal(1),
  generation: z.string().uuid(),
  clients: z.record(
    z.string(),
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      kind: z.enum(['local', 'static', 'oauth']),
      createdAt: z.string(),
      expiresAt: z.string().nullable(),
    }),
  ),
  registrations: z.record(z.string(), OAuthClientInformationFullSchema),
  credentials: z.record(
    z.string(),
    z.object({
      clientId: z.string().uuid(),
      kind: z.enum(['local', 'static', 'access', 'refresh']),
      expiresAt: z.number().finite(),
      resource: z.string().optional(),
      epoch: z.string().optional(),
    }),
  ),
});
export function remoteProblems(config: AppConfig): string[] {
  const problems: string[] = [];
  if (!config.webServer.enabled) problems.push('Enable the Web UI server.');
  if (config.webServer.auth.mode !== 'password' || !config.webServer.auth.password)
    problems.push('Configure Web UI password sign-in.');
  if (!config.webServer.tls.enabled) problems.push('Enable HTTPS on the Web UI server.');
  try {
    const url = new URL(config.mcpExport.remote.publicUrl);
    if (url.protocol !== 'https:' || url.pathname !== '/mcp' || url.search || url.hash || url.username || url.password)
      throw new Error();
  } catch {
    problems.push('Set the canonical public HTTPS URL ending in /mcp.');
  }
  return problems;
}

/** Only encrypted client metadata and token hashes are persisted. A generation
 * tombstone prevents an old vault from resurrecting revoked credentials if the
 * OS keychain becomes unavailable during a revocation. */
export class SharingCredentials {
  storage: 'encrypted' | 'session' = 'session';
  private ledger: Ledger;
  private readonly path: string;
  private readonly generationPath: string;
  onRevoked: () => void = () => {};
  constructor(
    readonly appHome: string,
    private readonly encryption: McpEncryption,
    private readonly store: BridgeStateStore,
    private readonly getConfig: () => AppConfig,
  ) {
    const directory = join(appHome, 'mcp-sharing');
    this.path = join(directory, 'credentials.enc');
    this.generationPath = join(directory, 'generation');
    let generation: string = randomUUID();
    try {
      if (existsSync(this.generationPath))
        generation = z.string().uuid().parse(readBoundedFile(this.generationPath, 1024).trim());
    } catch {
      this.store.record(
        'error',
        'MCP credential revocation storage could not be read. Previous clients are unavailable.',
      );
    }
    this.ledger = { version: 1, generation, clients: {}, registrations: {}, credentials: {} };
    try {
      if (
        encryption.isEncryptionAvailable() &&
        (process.platform !== 'linux' || ![undefined, 'basic_text'].includes(encryption.getSelectedStorageBackend?.()))
      )
        this.storage = 'encrypted';
      if (this.storage === 'encrypted' && existsSync(this.path)) {
        const encoded = readBoundedFile(this.path, 4 * 1024 * 1024);
        const loaded: Ledger = ledgerSchema.parse(JSON.parse(encryption.decryptString(Buffer.from(encoded, 'base64'))));
        if (loaded.generation === generation) this.ledger = loaded;
      }
    } catch {
      this.storage = 'session';
    }
  }
  private save(): void {
    if (this.storage !== 'encrypted') return;
    try {
      mkdirSync(join(this.path, '..'), { recursive: true, mode: 0o700 });
      atomicWriteFileSync(this.generationPath, this.ledger.generation, { mode: 0o600 });
      atomicWriteFileSync(this.path, this.encryption.encryptString(JSON.stringify(this.ledger)).toString('base64'), {
        mode: 0o600,
      });
    } catch {
      this.storage = 'session';
    }
  }
  private invalidateDurably(): void {
    const generation = randomUUID();
    mkdirSync(join(this.path, '..'), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(this.generationPath, generation, { mode: 0o600 });
    this.ledger.generation = generation;
  }
  epoch(): string {
    const config = this.getConfig();
    return hash([
      config.webServer.auth.mode,
      config.webServer.auth.username,
      config.webServer.auth.password,
      config.mcpExport.remote.publicUrl,
    ]);
  }
  remoteReady(): boolean {
    return (
      this.store.get().sharingEnabled &&
      this.getConfig().mcpExport.enabled &&
      this.store.get().remoteEnabled &&
      this.getConfig().mcpExport.remote.enabled &&
      remoteProblems(this.getConfig()).length === 0
    );
  }
  publicUrl(): string {
    return this.getConfig().mcpExport.remote.publicUrl;
  }
  clients(): McpSharingClient[] {
    return structuredClone(Object.values(this.ledger.clients));
  }
  createClient(
    name: string,
    kind: McpSharingClient['kind'],
    expiresAt: number | null,
    id: string = randomUUID(),
  ): McpSharingClient {
    if (!name.trim() || name.length > 100) throw new Error('Use a client name of 1–100 characters.');
    if (!this.ledger.clients[id] && Object.keys(this.ledger.clients).length >= 200)
      throw new Error('Revoke an existing MCP client before adding another.');
    const client: McpSharingClient = {
      id,
      name,
      kind,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    };
    this.ledger.clients[id] = client;
    this.save();
    return structuredClone(client);
  }
  issue(clientId: string, kind: Credential['kind'], expiresAt: number, resource?: string): string {
    if (!this.ledger.clients[clientId]) throw new Error('Unknown MCP client.');
    this.prune();
    if (Object.keys(this.ledger.credentials).length >= 4000) throw new Error('MCP credential limit reached.');
    const token = `kai_mcp_${randomBytes(32).toString('base64url')}`;
    this.ledger.credentials[hash(token)] = {
      clientId,
      kind,
      expiresAt,
      resource,
      ...(kind === 'local' ? {} : { epoch: this.epoch() }),
    };
    this.save();
    return token;
  }
  createStatic(name: string, days = 30): { token: string; client: McpSharingClient } {
    if (!this.remoteReady()) throw new Error('Enable remote sharing and configure HTTPS and Web UI sign-in first.');
    if (!Number.isInteger(days) || days < 1 || days > 365)
      throw new Error('Token expiry must be between 1 and 365 days.');
    const expiresAt = Date.now() + days * 86_400_000;
    const client = this.createClient(name, 'static', expiresAt);
    return { client, token: this.issue(client.id, 'static', expiresAt, this.publicUrl()) };
  }
  verify(token: string, kind: McpPrincipal['kind']): McpPrincipal | null {
    if (token.length > 256) return null;
    const credentialHash = hash(token);
    const credential = this.ledger.credentials[credentialHash];
    if (!credential || !this.ledger.clients[credential.clientId] || credential.expiresAt <= Date.now()) return null;
    if (kind === 'local' ? credential.kind !== 'local' : !['static', 'access'].includes(credential.kind)) return null;
    const principal = { clientId: credential.clientId, credentialHash, kind, expiresAt: credential.expiresAt };
    return this.active(principal) ? principal : null;
  }
  active(principal: McpPrincipal): boolean {
    const credential = this.ledger.credentials[principal.credentialHash];
    return (
      !!credential &&
      credential.clientId === principal.clientId &&
      !!this.ledger.clients[principal.clientId] &&
      credential.expiresAt > Date.now() &&
      (credential.kind === 'local'
        ? principal.kind === 'local'
        : principal.kind === 'remote' &&
          ['access', 'static'].includes(credential.kind) &&
          this.remoteReady() &&
          credential.epoch === this.epoch() &&
          credential.resource === this.publicUrl())
    );
  }
  consumeRefresh(token: string, clientId: string, resource: string): void {
    const key = hash(token);
    const credential = this.ledger.credentials[key];
    if (
      !credential ||
      credential.kind !== 'refresh' ||
      credential.clientId !== clientId ||
      credential.resource !== resource ||
      credential.epoch !== this.epoch() ||
      credential.expiresAt <= Date.now() ||
      !this.remoteReady()
    )
      throw new Error('Invalid or expired refresh token.');
    this.invalidateDurably();
    delete this.ledger.credentials[key];
    this.save();
  }
  revoke(clientId: string): void {
    this.invalidateDurably();
    delete this.ledger.clients[clientId];
    delete this.ledger.registrations[clientId];
    for (const [key, credential] of Object.entries(this.ledger.credentials))
      if (credential.clientId === clientId) delete this.ledger.credentials[key];
    this.save();
    if (/^[a-f0-9-]{36}$/.test(clientId)) {
      try {
        rmSync(join(this.appHome, 'mcp-sharing', 'clients', `${clientId}.token`), { force: true });
      } catch {
        /* Revoked in ledger even if stale reference removal fails. */
      }
    }
    this.onRevoked();
  }
  revokeToken(clientId: string, token: string): void {
    if (this.ledger.credentials[hash(token)]?.clientId === clientId) this.revoke(clientId);
  }
  revokeRemote(): void {
    this.invalidateDurably();
    for (const [id, client] of Object.entries(this.ledger.clients))
      if (client.kind !== 'local') delete this.ledger.clients[id];
    this.ledger.registrations = {};
    for (const [key, credential] of Object.entries(this.ledger.credentials))
      if (credential.kind !== 'local') delete this.ledger.credentials[key];
    this.save();
    this.onRevoked();
  }
  getRegistration(id: string): OAuthClientInformationFull | undefined {
    const client = this.ledger.registrations[id];
    return client ? structuredClone(client) : undefined;
  }
  register(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): OAuthClientInformationFull {
    if (!this.remoteReady()) throw new Error('Remote sharing is disabled.');
    if (Object.keys(this.ledger.registrations).length >= 200) throw new Error('OAuth registration limit reached.');
    const id = randomUUID();
    const full = { ...client, client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000) };
    this.ledger.registrations[id] = full;
    this.save();
    return structuredClone(full);
  }
  private prune(): void {
    for (const [key, credential] of Object.entries(this.ledger.credentials))
      if (credential.expiresAt <= Date.now()) delete this.ledger.credentials[key];
  }
}
