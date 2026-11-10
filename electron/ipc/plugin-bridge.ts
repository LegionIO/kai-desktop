import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import type { PluginBridgeSystem } from '../plugin-bridge/system.js';
import type { BridgeMutation } from '../../shared/plugin-bridge.js';
import { BRIDGE_APPROVAL_CANCELLED } from '../../shared/bridge-approval.js';

function approvalDetail(system: PluginBridgeSystem, change: BridgeMutation): string {
  if (change.action === 'approve')
    return (
      system.imports
        .inventory()
        .filter((p) => p.id === change.pluginId && (!change.packagePath || p.packagePath === change.packagePath))
        .map(
          (p) =>
            `${p.name} (${p.host}, ${p.version})\n${p.packagePath}\n` +
            p.components
              .filter((c) => change.revisions[c.id] === c.revision)
              .map((c) => `${c.kind}: ${c.name}\n${c.access.join('\n')}`)
              .join('\n\n'),
        )
        .join('\n\n') +
      `\n\n${Object.keys(change.revisions).length} components selected; all others from this source will be off.${change.allowOverlap ? '\nAllow explicitly selected duplicate sources.' : ''}\nExecutable components run as your local user. Detected access is not an OS sandbox.`
    );
  if (change.action === 'exports') {
    const inventory = system.sharing.inventory();
    if (!change.sources.length && !change.tools.length)
      return 'Stop sharing all tools. Connected clients will see an empty tool catalog and cannot call previously shared tools.\n\nClient credentials remain separately revocable. Integration credentials remain in Kai.';
    return (
      'Replace the shared export selection with:\n\n' +
      inventory
        .filter((s) => change.sources.includes(s.id))
        .map((s) => `${s.name}: all eligible tools, including future tools`)
        .join('\n') +
      '\n' +
      inventory
        .flatMap((s) => s.tools.filter((t) => change.tools.includes(t.id)).map((t) => `${s.name}: ${t.name}`))
        .join('\n') +
      '\n\nAll connected clients share this selection. Integration credentials remain in Kai.'
    );
  }
  if (change.action === 'homes')
    return `Discover user installations from:\nClaude: ${change.claude || 'default host home'}\nCodex: ${change.codex || 'default host home'}\n\nComponents will be revalidated against existing approvals.`;
  if (change.action === 'remote')
    return `${change.enabled ? 'Enable' : 'Disable'} remote MCP sharing at ${change.publicUrl || '(no URL configured)'}.\nRemote clients use this Kai installation and its signed-in accounts. Existing remote credentials are revoked when remote sharing is disabled or its URL changes.`;
  if (change.action === 'revoke-client')
    return `Revoke MCP client ${system.credentials.clients().find((client) => client.id === change.clientId)?.name ?? change.clientId} and cancel its calls.`;
  return change.action === 'imports'
    ? `${change.enabled ? 'Enable discovery and reactivate previously approved, revalidated components' : 'Disable all imported components and cancel their processes'} in Kai. Newly discovered components start off.`
    : `${change.enabled ? 'Enable the selected shared Kai tools' : 'Disable sharing and cancel connector calls'}. Local client credentials remain separately revocable; remote credentials are revoked on disable. Imports and exports have separate selections.`;
}

const mutationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('imports'), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('homes'), claude: z.string().max(2048), codex: z.string().max(2048) }).strict(),
  z
    .object({
      action: z.literal('approve'),
      pluginId: z.string(),
      packagePath: z.string().max(2048).optional(),
      revisions: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
      allowOverlap: z.boolean(),
    })
    .strict(),
  z.object({ action: z.literal('sharing'), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('remote'), enabled: z.boolean(), publicUrl: z.string().max(2048) }).strict(),
  z
    .object({
      action: z.literal('exports'),
      sources: z.array(z.string()).max(1000),
      tools: z.array(z.string()).max(5000),
    })
    .strict(),
  z.object({ action: z.literal('revoke-client'), clientId: z.string().uuid() }).strict(),
]);

export function registerPluginBridgeHandlers(
  ipc: IpcMain,
  system: PluginBridgeSystem,
  options: {
    isPrimary: (event: IpcMainInvokeEvent) => boolean;
    confirm: (title: string, detail: string) => Promise<boolean>;
  },
): void {
  const authorize = async (event: IpcMainInvokeEvent, title: string, detail: string) => {
    if ((event as IpcMainInvokeEvent & { __kaiHumanWeb?: boolean }).__kaiHumanWeb === true) return;
    if (!options.isPrimary(event)) throw new Error('Bridge approvals require the Kai settings UI.');
    // Native plugins can share the primary renderer. An isolated approval
    // window makes the human the authority for expanding bridge access.
    if (!(await options.confirm(title, detail))) throw new Error(BRIDGE_APPROVAL_CANCELLED);
  };
  ipc.handle('plugin-bridge:snapshot', () => system.snapshot());
  ipc.handle('plugin-bridge:discover', () => system.discover());
  ipc.handle('plugin-bridge:mutate', async (event, value: unknown) => {
    const change = mutationSchema.parse(value);
    await authorize(event, 'Approve plugin bridge changes', approvalDetail(system, change));
    return system.mutate(change);
  });
  ipc.handle('plugin-bridge:preview-client', (_event, host: unknown) =>
    system.setup.preview(z.enum(['claude', 'codex']).parse(host)),
  );
  ipc.handle('plugin-bridge:apply-client', async (event, id: unknown, write: unknown) => {
    if (!system.sharing.enabled()) throw new Error('Enable Share Kai before connecting a client.');
    const preview = system.setup.reviewedPreview(z.string().uuid().parse(id));
    const writeConfiguration = z.boolean().parse(write);
    await authorize(
      event,
      'Connect this client to Kai?',
      `${writeConfiguration ? `Add the connector to ${preview.path}` : 'Create a copyable connector configuration without editing the host'}:\n\n${preview.configuration}\n\nCreate a separately revocable MCP credential. No integration credentials are copied.`,
    );
    return system.setup.apply(preview.id, writeConfiguration);
  });
  ipc.handle('plugin-bridge:create-token', async (event, name: unknown, days: unknown) => {
    const validName = z.string().min(1).max(100).parse(name);
    const validDays = z.number().int().min(1).max(365).parse(days);
    await authorize(
      event,
      'Create a remote MCP token?',
      `Allow ${validName} to use the selected shared tools for ${validDays} days. The token will be shown once.`,
    );
    return system.credentials.createStatic(validName, validDays);
  });
}
