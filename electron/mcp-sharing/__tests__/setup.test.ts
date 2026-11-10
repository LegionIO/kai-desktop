import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { bridgeFixture, writeBridgeFile } from '../../../test-utils/plugin-bridge.js';
import { McpClientSetup, localCredentialPath } from '../setup.js';
import * as atomic from '../../utils/atomic-write.js';

describe('explicit Claude and Codex connector setup', () => {
  let f: ReturnType<typeof bridgeFixture>, setup: McpClientSetup;
  beforeEach(() => {
    f = bridgeFixture();
    f.enableSharing();
    setup = new McpClientSetup(
      f.credentials,
      () => f.homes,
      () => ({ command: '/Applications/Kai App/bin/kai', args: [] }),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    f.cleanup();
  });
  it('previews without writing or granting, then preserves Codex values and comments', () => {
    const file = join(f.homes.codex, 'config.toml');
    const original = '# keep this comment\nmodel="fixture-model"\n[mcp_servers.existing]\ncommand="keep-me"\n';
    writeBridgeFile(file, original);
    const preview = setup.preview('codex');
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(f.credentials.clients()).toEqual([]);
    expect(preview.conflict).toBe(false);
    expect(preview.configuration).not.toContain('kai_mcp_');
    setup.apply(preview.id, true);
    const written = readFileSync(file, 'utf8');
    expect(written.startsWith(original.trimEnd())).toBe(true);
    expect(parse(written)).toMatchObject({
      model: 'fixture-model',
      mcp_servers: {
        existing: { command: 'keep-me' },
        'kai-mcp': { command: '/Applications/Kai App/bin/kai', env: { KAI_USER_DATA: f.appHome } },
      },
    });
    const client = f.credentials.clients()[0];
    const tokenPath = localCredentialPath(f.appHome, client.id);
    expect(f.credentials.verify(readFileSync(tokenPath, 'utf8'), 'local')?.clientId).toBe(client.id);
    f.credentials.revoke(client.id);
    expect(existsSync(tokenPath)).toBe(false);
    expect(() => setup.apply(preview.id, true)).toThrow('expired');
  });
  it('preserves unrelated Claude settings and other MCP servers', () => {
    const file = join(f.homes.claude, '.claude.json');
    writeBridgeFile(file, {
      theme: 'dark',
      projects: { '/work': { trusted: true } },
      mcpServers: { existing: { command: 'existing' } },
    });
    const preview = setup.preview('claude');
    setup.apply(preview.id, true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      theme: 'dark',
      projects: { '/work': { trusted: true } },
      mcpServers: {
        existing: { command: 'existing' },
        'kai-mcp': { args: ['mcp', 'serve', '--credential', f.credentials.clients()[0].id] },
      },
    });
  });
  it('never overwrites a conflicting entry and supports copy-only setup', () => {
    const file = join(f.homes.codex, 'config.toml'),
      original = '[mcp_servers."kai-mcp"]\ncommand="other-installation"\n';
    writeBridgeFile(file, original);
    const preview = setup.preview('codex');
    expect(preview.conflict).toBe(true);
    expect(() => setup.apply(preview.id, true)).toThrow('will not overwrite');
    expect(f.credentials.clients()).toEqual([]);
    expect(setup.apply(preview.id, false).configuration).toBe(preview.configuration);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(f.credentials.clients()).toHaveLength(1);
  });
  it('rejects stale and expired previews without creating credentials', () => {
    const preview = setup.preview('codex');
    writeBridgeFile(preview.path, 'model="changed"\n');
    expect(() => setup.apply(preview.id, true)).toThrow('changed after');
    const current = setup.preview('codex');
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 601_000);
    expect(() => setup.apply(current.id, false)).toThrow('expired');
    expect(f.credentials.clients()).toEqual([]);
  });
  it('revokes a partially created client when writing the preview fails', () => {
    const preview = setup.preview('claude');
    const write = atomic.atomicWriteFileSync;
    vi.spyOn(atomic, 'atomicWriteFileSync').mockImplementation((path, ...args) => {
      if (path === preview.path) throw new Error('Fixture write failure');
      return write(path, ...args);
    });
    expect(() => setup.apply(preview.id, true)).toThrow('Fixture write failure');
    expect(f.credentials.clients()).toEqual([]);
    expect(existsSync(preview.path)).toBe(false);
  });
  it('does not expose secret values from malformed host configuration errors', () => {
    writeBridgeFile(join(f.homes.codex, 'config.toml'), 'token = fixture-private-value\n');
    expect(() => setup.preview('codex')).toThrow('Host configuration could not be parsed');
  });
});
