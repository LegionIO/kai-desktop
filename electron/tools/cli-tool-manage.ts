import { z } from 'zod';
import type { ToolDefinition, ToolExecutionContext } from './types.js';
import { readEffectiveConfig, writeDesktopConfig } from '../ipc/config.js';
import { binaryExists } from './cli-tools.js';
import { registerPendingApproval, broadcastStreamEventRaw } from '../ipc/tool-approval.js';

/**
 * Require an interactive user decision before REGISTERING or EDITING a CLI tool.
 * Registering a tool around ANY binary is a capability grant — a basename denylist
 * is porous (awk/find -exec/make/npx/git-aliases, symlinks/wrappers to bash, etc.
 * all reach arbitrary execution), so we gate every add/edit rather than trying to
 * enumerate dangerous binaries. Fails CLOSED (deny) when there's no live chat owner
 * to answer (e.g. an automation `tool` action) — mirrors automation-manage's
 * ensureApproved. list/enable/disable/delete are not gated.
 */
async function approveRegistration(
  actionLabel: string,
  binaries: string[],
  context: ToolExecutionContext | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const toolCallId = context?.toolCallId;
  if (!context || !toolCallId || !context.conversationId || !context.abortSignal) {
    return {
      ok: false,
      error: `Cannot ${actionLabel}: registering a CLI tool grants command-execution capability (${binaries.join(', ')}) and requires user approval, but this context has no live chat to prompt. A user can do this in Settings, or approve it in a live chat.`,
    };
  }
  broadcastStreamEventRaw({
    conversationId: context.conversationId,
    type: 'tool-approval-required',
    toolCallId,
    toolName: 'cli_tools',
    args: {
      approvalKind: 'register-cli-tool',
      action: actionLabel,
      binaries,
      reason: `This registers a CLI tool that can run ${binaries.map((b) => `\`${b}\``).join(', ')}. A CLI tool executes that binary with model-provided arguments — approve only if you trust this.`,
    },
  });
  const decision = await registerPendingApproval(toolCallId, context.abortSignal);
  if (decision === true) return { ok: true };
  return {
    ok: false,
    error:
      decision === 'dismiss'
        ? `Approval dismissed; did not ${actionLabel}.`
        : `Approval denied; did not ${actionLabel}.`,
  };
}

export function createCliToolManageTool(appHome: string): ToolDefinition {
  return {
    name: 'cli_tools',
    description: [
      'Manage CLI tools available to the assistant.',
      'Actions: "list" shows all configured CLI tools with binary availability.',
      '"add" registers a new CLI tool. "edit" updates an existing one.',
      '"delete" removes a tool. "enable"/"disable" toggles a tool.',
      'Changes take effect on the next response turn.',
    ].join(' '),
    inputSchema: z.object({
      action: z.enum(['list', 'add', 'edit', 'delete', 'enable', 'disable']).describe('The action to perform'),
      name: z.string().optional().describe('Tool name (required for add/edit/delete/enable/disable)'),
      binary: z.string().optional().describe('Primary binary name (for add/edit)'),
      extraBinaries: z.array(z.string()).optional().describe('Additional allowed binaries (for add/edit)'),
      description: z.string().optional().describe('Tool description for the AI (for add/edit)'),
      prefix: z.string().optional().describe('Example command prefix for AI hints (for add/edit)'),
      enabled: z.boolean().optional().describe('Whether the tool is enabled (for add/edit, defaults to true)'),
    }),
    execute: async (input, context) => {
      const { action, name, binary, extraBinaries, description, prefix, enabled } = input as {
        action: string;
        name?: string;
        binary?: string;
        extraBinaries?: string[];
        description?: string;
        prefix?: string;
        enabled?: boolean;
      };

      const config = readEffectiveConfig(appHome);
      const tools = config.cliTools ?? [];

      switch (action) {
        case 'list': {
          if (tools.length === 0) return { tools: [], message: 'No CLI tools configured.' };
          return {
            tools: tools.map((t) => ({
              name: t.name,
              binary: t.binary,
              extraBinaries: t.extraBinaries,
              enabled: t.enabled !== false,
              builtIn: t.builtIn === true,
              binaryAvailable: binaryExists(t.binary),
            })),
          };
        }

        case 'add': {
          if (!name) return { error: 'Tool name is required.' };
          if (!binary) return { error: 'Binary name is required.' };
          if (!description) return { error: 'Description is required.' };
          if (tools.some((t) => t.name === name))
            return { error: `Tool "${name}" already exists. Use "edit" to update it.` };

          {
            const approval = await approveRegistration(
              `add CLI tool "${name}"`,
              [binary, ...(extraBinaries ?? [])],
              context,
            );
            if (!approval.ok) return { error: approval.error };
          }

          const newTool = {
            name,
            binary,
            extraBinaries: extraBinaries?.length ? extraBinaries : undefined,
            description,
            prefix: prefix || undefined,
            enabled: enabled ?? true,
            builtIn: false,
          };

          config.cliTools = [...tools, newTool];
          writeDesktopConfig(appHome, config);
          return {
            success: true,
            added: { ...newTool, binaryAvailable: binaryExists(binary) },
            note: 'Tool will be available on your next turn if the binary exists.',
          };
        }

        case 'edit': {
          if (!name) return { error: 'Tool name is required.' };
          const idx = tools.findIndex((t) => t.name === name);
          if (idx === -1) return { error: `Tool "${name}" not found.` };

          const previous = { ...tools[idx] };
          const updated = { ...tools[idx] };
          if (binary !== undefined) updated.binary = binary;
          if (extraBinaries !== undefined) updated.extraBinaries = extraBinaries.length ? extraBinaries : undefined;
          if (description !== undefined) updated.description = description;
          if (prefix !== undefined) updated.prefix = prefix || undefined;
          if (enabled !== undefined) updated.enabled = enabled;

          // Gate an edit that changes the binary or extraBinaries (the execution
          // surface). A pure description/prefix/enabled edit is not a capability
          // change and doesn't re-prompt.
          const execChanged =
            (binary !== undefined && binary !== previous.binary) ||
            (extraBinaries !== undefined &&
              JSON.stringify(updated.extraBinaries ?? []) !== JSON.stringify(previous.extraBinaries ?? []));
          if (execChanged) {
            const approval = await approveRegistration(
              `edit CLI tool "${name}"`,
              [updated.binary, ...(updated.extraBinaries ?? [])],
              context,
            );
            if (!approval.ok) return { error: approval.error };
          }

          config.cliTools = [...tools];
          config.cliTools[idx] = updated;
          writeDesktopConfig(appHome, config);
          return { success: true, changed: { previous, new: updated }, note: 'Changes take effect on your next turn.' };
        }

        case 'delete': {
          if (!name) return { error: 'Tool name is required.' };
          const found = tools.find((t) => t.name === name);
          if (!found) return { error: `Tool "${name}" not found.` };

          config.cliTools = tools.filter((t) => t.name !== name);
          writeDesktopConfig(appHome, config);
          return { success: true, deleted: found, note: 'Tool removed. Changes take effect on your next turn.' };
        }

        case 'enable':
        case 'disable': {
          if (!name) return { error: 'Tool name is required.' };
          const i = tools.findIndex((t) => t.name === name);
          if (i === -1) return { error: `Tool "${name}" not found.` };

          const wasEnabled = tools[i].enabled !== false;
          const nowEnabled = action === 'enable';
          config.cliTools = [...tools];
          config.cliTools[i] = { ...tools[i], enabled: nowEnabled };
          writeDesktopConfig(appHome, config);
          return {
            success: true,
            changed: { tool: name, previous: { enabled: wasEnabled }, new: { enabled: nowEnabled } },
            note: 'Changes take effect on your next turn.',
          };
        }

        default:
          return { error: `Unknown action: ${action}` };
      }
    },
  };
}
