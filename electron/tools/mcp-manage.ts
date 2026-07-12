import { z } from 'zod';
import type { ToolDefinition, ToolExecutionContext } from './types.js';
import type { AppConfig } from '../config/schema.js';
import { readEffectiveConfig, writeDesktopConfig } from '../ipc/config.js';
import { registerPendingApproval, broadcastStreamEventRaw } from '../ipc/tool-approval.js';

type McpServer = AppConfig['mcpServers'][number];

function readConfig(appHome: string): AppConfig {
  return readEffectiveConfig(appHome);
}

/** Mask secret-bearing fields (env values, args, URL userinfo/query/path/fragment)
 *  before returning a server to the model, so list/edit/delete don't leak
 *  credentials. args and URL path/query/fragment commonly carry tokens. */
function redactServer(s: McpServer): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: s.name,
    enabled: s.enabled !== false,
  };
  if (s.command) out.command = s.command;
  // args frequently carry secrets (`--token X`, `--header Authorization: ...`) —
  // report only the count rather than the values.
  if (s.args && s.args.length > 0) out.args = `[${s.args.length} arg(s) redacted]`;
  if (s.url) out.url = redactUrl(s.url);
  if (s.env && Object.keys(s.env).length > 0) {
    out.env = Object.fromEntries(Object.keys(s.env).map((k) => [k, '[redacted]']));
  }
  return out;
}

/** Reduce a URL to origin + path-shape, stripping userinfo, query, and fragment
 *  (all of which can carry tokens/webhook secrets). */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const hasSecrets = !!(u.username || u.password || u.search || u.hash || u.pathname.length > 1);
    return hasSecrets ? `${u.protocol}//${u.host}/[redacted-path]` : `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '[redacted-url]';
  }
}

/** Human-readable, secret-safe summary of a server's launch spec for the approval
 *  prompt. Discloses BOTH command and url when present (a server can have both),
 *  the arg COUNT (not values — args carry tokens), the redacted url, and env KEY
 *  names (not values). */
function describeServerForApproval(s: {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}): string {
  const parts: string[] = [];
  if (s.command) parts.push(`command: ${s.command}${s.args?.length ? ` (+${s.args.length} arg(s))` : ''}`);
  if (s.url) parts.push(`url: ${redactUrl(s.url)}`);
  if (s.env && Object.keys(s.env).length > 0) parts.push(`env: ${Object.keys(s.env).join(', ')}`);
  return parts.join('; ') || '(no launch spec)';
}

/**
 * Require an interactive user decision before adding/editing an MCP server.
 * Registering a server is a capability grant: a stdio `command` launches an
 * arbitrary local process, and a `url` server makes the app connect out to an
 * arbitrary (possibly internal/localhost) endpoint (SSRF) and pull in its tools.
 * Both warrant consent. Fails CLOSED when no live chat owner exists. Mirrors
 * automation-manage's ensureApproved. list/enable/disable/delete aren't gated.
 */
async function approveServerRegistration(
  actionLabel: string,
  detail: string,
  context: ToolExecutionContext | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const toolCallId = context?.toolCallId;
  if (!context || !toolCallId || !context.conversationId || !context.abortSignal) {
    return {
      ok: false,
      error: `Cannot ${actionLabel}: registering an MCP server grants a new capability (${detail}) and requires user approval, but this context has no live chat to prompt. A user can do this in Settings, or approve it in a live chat.`,
    };
  }
  broadcastStreamEventRaw({
    conversationId: context.conversationId,
    type: 'tool-approval-required',
    toolCallId,
    toolName: 'mcp_servers',
    args: {
      approvalKind: 'register-mcp-server',
      action: actionLabel,
      reason: `This registers an MCP server (${detail}). A command server launches a local process; a URL server connects out and imports its tools. Approve only if you trust it.`,
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

export function createMcpManageTool(appHome: string): ToolDefinition {
  return {
    name: 'mcp_servers',
    description: [
      'Manage MCP (Model Context Protocol) servers. Use this tool to give yourself new capabilities by connecting to MCP servers.',
      'Actions: "list" shows all configured servers. "add" registers a new server (URL or command-based). "edit" updates an existing server. "delete" removes one. "enable"/"disable" toggles a server.',
      'Changes take effect immediately — new tools from added/enabled servers will be available on your next response turn.',
    ].join(' '),
    inputSchema: z.object({
      action: z.enum(['list', 'add', 'edit', 'delete', 'enable', 'disable']).describe('The action to perform'),
      name: z.string().optional().describe('Server name (required for add/edit/delete/enable/disable)'),
      url: z.string().optional().describe('Server URL for HTTP/SSE transport (for add/edit)'),
      command: z.string().optional().describe('Command to spawn for stdio transport (for add/edit)'),
      args: z.array(z.string()).optional().describe('Arguments for the stdio command (for add/edit)'),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe('Environment variables for the server process (for add/edit)'),
      enabled: z.boolean().optional().describe('Whether the server is enabled (for add/edit, defaults to true)'),
    }),
    execute: async (input, context) => {
      const { action, name, url, command, args, env, enabled } = input as {
        action: string;
        name?: string;
        url?: string;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        enabled?: boolean;
      };

      const config = readConfig(appHome);
      const servers: McpServer[] = config.mcpServers ?? [];

      switch (action) {
        case 'list': {
          if (servers.length === 0) return { servers: [], message: 'No MCP servers configured.' };
          return { servers: servers.map((s) => redactServer(s)) };
        }

        case 'add': {
          if (!name) return { error: 'Server name is required.' };
          if (!url && !command) return { error: 'Either url or command is required.' };
          if (servers.some((s) => s.name === name))
            return { error: `Server "${name}" already exists. Use "edit" to update it.` };

          // Any new server is a capability grant (stdio command = local process;
          // url = outbound connection + tool import). Gate behind user approval.
          {
            const approval = await approveServerRegistration(
              `add MCP server "${name}"`,
              describeServerForApproval({ command, args, url, env }),
              context,
            );
            if (!approval.ok) return { error: approval.error };
          }

          const newServer: McpServer = { name, enabled: enabled ?? true };
          if (url) newServer.url = url;
          if (command) newServer.command = command;
          if (args?.length) newServer.args = args;
          if (env && Object.keys(env).length > 0) newServer.env = env;

          config.mcpServers = [...servers, newServer];
          writeDesktopConfig(appHome, config);
          return {
            success: true,
            added: redactServer(newServer),
            note: 'Tools from this server will be available on your next turn.',
          };
        }

        case 'edit': {
          if (!name) return { error: 'Server name is required.' };
          const idx = servers.findIndex((s) => s.name === name);
          if (idx === -1) return { error: `Server "${name}" not found.` };

          const previous = { ...servers[idx] };
          const updated = { ...servers[idx] };
          if (url !== undefined) updated.url = url;
          if (command !== undefined) updated.command = command;
          if (args !== undefined) updated.args = args;
          if (env !== undefined) updated.env = env;
          if (enabled !== undefined) updated.enabled = enabled;

          // Gate if the edit changes any part of the launch spec (command/args/
          // env/url) — all of these change what runs or where we connect. A
          // pure enable/disable via edit is not a spec change.
          const specChanged =
            (command !== undefined && command !== previous.command) ||
            (url !== undefined && url !== previous.url) ||
            (args !== undefined && JSON.stringify(args) !== JSON.stringify(previous.args ?? undefined)) ||
            (env !== undefined && JSON.stringify(env) !== JSON.stringify(previous.env ?? undefined));
          if (specChanged) {
            const approval = await approveServerRegistration(
              `edit MCP server "${name}"`,
              describeServerForApproval(updated),
              context,
            );
            if (!approval.ok) return { error: approval.error };
          }

          config.mcpServers = [...servers];
          config.mcpServers[idx] = updated;
          writeDesktopConfig(appHome, config);
          return {
            success: true,
            changed: { previous: redactServer(previous), new: redactServer(updated) },
            note: 'Changes take effect on your next turn.',
          };
        }

        case 'delete': {
          if (!name) return { error: 'Server name is required.' };
          const found = servers.some((s) => s.name === name);
          if (!found) return { error: `Server "${name}" not found.` };

          const deleted = servers.find((s) => s.name === name);
          config.mcpServers = servers.filter((s) => s.name !== name);
          writeDesktopConfig(appHome, config);
          return {
            success: true,
            deleted: deleted ? redactServer(deleted) : undefined,
            note: 'Server tools removed. Changes take effect on your next turn.',
          };
        }

        case 'enable':
        case 'disable': {
          if (!name) return { error: 'Server name is required.' };
          const i = servers.findIndex((s) => s.name === name);
          if (i === -1) return { error: `Server "${name}" not found.` };

          const wasEnabled = servers[i].enabled !== false;
          const nowEnabled = action === 'enable';
          config.mcpServers = [...servers];
          config.mcpServers[i] = { ...servers[i], enabled: nowEnabled };
          writeDesktopConfig(appHome, config);
          return {
            success: true,
            changed: { server: name, previous: { enabled: wasEnabled }, new: { enabled: nowEnabled } },
            note: 'Changes take effect on your next turn.',
          };
        }

        default:
          return { error: `Unknown action: ${action}` };
      }
    },
  };
}

/** Test-only exposure of the pure secret-redaction helpers. */
export const __internal = { redactServer, redactUrl, describeServerForApproval };
