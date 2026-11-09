import { afterEach, expect, it, vi } from 'vitest';
import { parseMcpCommand, runMcpCommand, startMcpLogin } from '../mcp-auth.js';
import type { LocalBridgeClient } from '../client.js';
import { mcpStatusFixture } from '../../../test-utils/mcp-ui.js';
afterEach(() => vi.restoreAllMocks());
const clientWith = (invoke: ReturnType<typeof vi.fn>) => ({ invoke }) as unknown as LocalBridgeClient;
it('recognizes standalone commands without changing ordinary chat arguments', () => {
  expect(parseMcpCommand(['--kai-cli', 'mcp', 'login', 'fixture', '--no-browser'])).toEqual([
    'login',
    'fixture',
    '--no-browser',
  ]);
  expect(parseMcpCommand(['--prompt', 'mcp'])).toBeUndefined();
});
it('supports explicit no-browser login without sending callbacks in commands', async () => {
  const invoke = vi.fn(async () => ({ loginId: 'attempt', authorizationUrl: 'https://auth.test', expiresAt: 300_000 }));
  await startMcpLogin(clientWith(invoke), 'fixture', true);
  expect(invoke).toHaveBeenCalledExactlyOnceWith('mcp:login', 'fixture');
});
it('prints actual auth status and strips terminal controls', async () => {
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  await runMcpCommand(clientWith(vi.fn(async () => [{ ...mcpStatusFixture, name: '\x1b[31mfixture' }])), ['list']);
  expect(output.mock.calls.map(([value]) => value).join('')).toContain('fixture: disconnected; required');
  expect(output.mock.calls.map(([value]) => value).join('')).not.toContain('\x1b');
});
it('reports local logout separately from server revocation', async () => {
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const invoke = vi.fn(async () => ({ localCleared: true, revocation: 'failed' }));
  await runMcpCommand(clientWith(invoke), ['logout', 'fixture']);
  expect(invoke).toHaveBeenCalledExactlyOnceWith('mcp:logout', 'fixture');
  expect(output).toHaveBeenCalledWith('Signed out locally. Server revocation: failed.\n');
});
it('resets registration without opening a browser or starting another login', async () => {
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const invoke = vi.fn(async () => undefined);
  await runMcpCommand(clientWith(invoke), ['reset-registration', 'fixture']);
  expect(invoke).toHaveBeenCalledExactlyOnceWith('mcp:reset-registration', 'fixture');
  expect(output).toHaveBeenCalledWith(
    'Local OAuth registration cleared. Run kai mcp login <name> to register again.\n',
  );
});
