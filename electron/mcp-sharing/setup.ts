import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { BridgeClientPreview, PluginHost } from '../../shared/plugin-bridge.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { hash, object, readBoundedFile } from '../plugin-bridge/files.js';
import type { SharingCredentials } from './credentials.js';

type Preview = BridgeClientPreview & {
  originalHash: string;
  clientId: string;
  launcher: { command: string; args: string[]; env: Record<string, string> };
};
export class McpClientSetup {
  private readonly previews = new Map<string, Preview>();
  constructor(
    private readonly credentials: SharingCredentials,
    private readonly homes: () => Record<PluginHost, string>,
    private readonly launcher: () => { command: string; args: string[] },
  ) {}
  preview(host: PluginHost): BridgeClientPreview {
    const homes = this.homes();
    const path =
      host === 'codex'
        ? join(homes.codex, 'config.toml')
        : homes.claude === join(homedir(), '.claude') && !process.env.CLAUDE_CONFIG_DIR
          ? join(homedir(), '.claude.json')
          : join(homes.claude, '.claude.json');
    const original = existsSync(path) ? readBoundedFile(path) : '';
    let config: Record<string, unknown>;
    try {
      config = original ? (host === 'codex' ? parseToml(original) : object(JSON.parse(original))) : {};
    } catch {
      throw new Error('Host configuration could not be parsed. Repair it before connecting Kai.');
    }
    const entry = object(host === 'codex' ? config.mcp_servers : config.mcpServers)['kai-mcp'];
    const clientId = randomUUID();
    const launch = this.launcher();
    const launcher = {
      ...launch,
      args: [...launch.args, 'mcp', 'serve', '--credential', clientId],
      env: { KAI_USER_DATA: this.credentials.appHome },
    };
    const configuration =
      host === 'codex'
        ? stringifyToml({ mcp_servers: { 'kai-mcp': launcher } })
        : JSON.stringify({ mcpServers: { 'kai-mcp': launcher } }, null, 2);
    const preview: Preview = {
      id: randomUUID(),
      host,
      path,
      configuration,
      conflict: entry !== undefined,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      originalHash: hash(original),
      clientId,
      launcher,
    };
    for (const [id, value] of this.previews) if (Date.parse(value.expiresAt) <= Date.now()) this.previews.delete(id);
    this.previews.set(preview.id, preview);
    if (this.previews.size > 100) this.previews.delete(this.previews.keys().next().value!);
    return this.public(preview);
  }
  apply(id: string, writeConfiguration: boolean): { configuration: string } {
    const preview = this.previews.get(id);
    if (!preview || Date.parse(preview.expiresAt) <= Date.now())
      throw new Error('Configuration preview expired. Preview the connection again.');
    const original = existsSync(preview.path) ? readBoundedFile(preview.path) : '';
    if (hash(original) !== preview.originalHash)
      throw new Error('Host configuration changed after the preview. Preview it again.');
    if (writeConfiguration && preview.conflict)
      throw new Error('A kai-mcp entry already exists. Review or rename it manually; Kai will not overwrite it.');
    this.previews.delete(id);
    const client = this.credentials.createClient(
      `${preview.host === 'claude' ? 'Claude' : 'Codex'} on this computer`,
      'local',
      null,
      preview.clientId,
    );
    try {
      const token = this.credentials.issue(client.id, 'local', Number.MAX_SAFE_INTEGER);
      const directory = join(this.credentials.appHome, 'mcp-sharing', 'clients');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      atomicWriteFileSync(join(directory, `${client.id}.token`), token, { mode: 0o600 });
      if (writeConfiguration) {
        let next: string;
        if (preview.host === 'codex') {
          next = `${original.trimEnd()}\n\n${preview.configuration}\n`;
          try {
            parseToml(next);
          } catch {
            throw new Error(
              'This TOML layout cannot be extended safely. Copy the connector configuration and merge it manually.',
            );
          }
        } else {
          const config = original ? object(JSON.parse(original)) : {};
          next =
            JSON.stringify(
              { ...config, mcpServers: { ...object(config.mcpServers), 'kai-mcp': preview.launcher } },
              null,
              2,
            ) + '\n';
        }
        mkdirSync(dirname(preview.path), { recursive: true, mode: 0o700 });
        // All operations since the compare are synchronous, so another Kai
        // approval cannot interleave and clobber the previewed revision.
        if (hash(existsSync(preview.path) ? readBoundedFile(preview.path) : '') !== preview.originalHash)
          throw new Error('Host configuration changed while preparing the connector. Preview it again.');
        atomicWriteFileSync(preview.path, next, { mode: 0o600 });
      }
    } catch (error) {
      this.credentials.revoke(client.id);
      throw error;
    }
    return { configuration: preview.configuration };
  }
  reviewedPreview(id: string): BridgeClientPreview {
    const preview = this.previews.get(id);
    if (!preview || Date.parse(preview.expiresAt) <= Date.now())
      throw new Error('Configuration preview expired. Preview the connection again.');
    return this.public(preview);
  }
  private public(preview: Preview): BridgeClientPreview {
    const { id, host, path, configuration, conflict, expiresAt } = preview;
    return { id, host, path, configuration, conflict, expiresAt };
  }
}
export function localCredentialPath(appHome: string, id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('A valid Kai MCP credential reference is required.');
  return resolve(appHome, 'mcp-sharing', 'clients', `${id}.token`);
}
