import { app, shell, BrowserWindow, safeStorage, session, net } from 'electron';
import { getBrandUserAgent } from '../utils/user-agent.js';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http';
import { URL } from 'url';
import { z } from 'zod';
import { generateForPlugin, streamForPlugin } from '../agent/plugin-generate.js';
import { getRegisteredTools } from '../ipc/agent.js';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import type {
  PluginAPI,
  PluginInstance,
  PluginBannerDescriptor,
  PluginModalDescriptor,
  PluginBrowserWindowOptions,
  PluginSettingsSectionDescriptor,
  PluginPanelDescriptor,
  PluginCommandDescriptor,
  PluginConversationDecorationDescriptor,
  PluginThreadDecorationDescriptor,
  PluginNotificationDescriptor,
  PluginAuthWindowOptions,
  PluginAuthResult,
  PluginConversationAppendMessage,
  PluginConversationRecord,
  PluginHttpRequest,
  PluginHttpResponse,
  PreSendHook,
  PostReceiveHook,
  PreUpdateHook,
  PostUpdateHook,
  PluginNavigationTarget,
  MessageContent,
  PluginInferenceProvider,
  PluginCliToolContribution,
  AllowedBinary,
  ExecRequest,
  CookiePromotionConfig,
  SessionCookieInfo,
  AutomationEvent,
} from './types.js';
import { executeCommand, detectTool, findBinary, SAFE_ENV_VARS } from './sandboxed-exec.js';
import { isExternallyOpenableUrl } from '../utils/safe-external-url.js';
import { writeAuditEntry } from './audit-log.js';
import { resolvePluginConfigView, type PluginSafeConfig } from './safe-config.js';
import type { AppConfig } from '../config/schema.js';
import type { ToolDefinition, ToolExecutionContext } from '../tools/types.js';
import { buildScopedToolName, getScopedToolPrefix, MAX_TOOL_NAME_LENGTH } from '../tools/naming.js';
import { convertJsonSchemaToZod } from '../tools/skill-loader.js';
import { broadcastUpsert, broadcastActive } from '../ipc/conversations.js';
import {
  readConversation,
  readAllConversations,
  writeConversation,
  getActiveConversationId,
  setActiveConversationId,
} from '../ipc/conversation-store.js';
import { getHostPluginApiVersion, getHostCapabilities } from './plugin-compat.js';
import { openPluginBrowserWindow } from './browser-window/index.js';
import { hookDispatcher, HOOK_EVENTS } from '../agent/hooks/dispatcher.js';

/** Max buffered body for a plugin HTTP server request (1 MB). */
const PLUGIN_HTTP_MAX_BODY_BYTES = 1_048_576;
/** Max time a plugin HTTP request/headers may take before the socket is closed. */
const PLUGIN_HTTP_REQUEST_TIMEOUT_MS = 30_000;

/**
 * True only for loopback bind hosts. A plugin's http.listen must not bind to a
 * routable/wildcard address (0.0.0.0, ::, a LAN IP) — that would expose its
 * unauthenticated, plugin-controlled handler to the local network. IPv6 forms
 * are normalized by stripping brackets and any zone id.
 */
function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  const stripped = h.replace(/^\[/, '').replace(/\]$/, '').split('%', 1)[0];
  if (stripped === '::1') return true;
  // Any 127.0.0.0/8 address is loopback.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(stripped);
}

// ─── Session Cookie Promotion ────────────────────────────────────────────────
// Electron drops session cookies (those without an Expires/Max-Age) when the
// last BrowserWindow using that partition's session closes.  For auth windows
// that open briefly and close, this means SSO cookies vanish immediately.
//
// This system allows plugins to opt in to promoting session cookies to
// persistent ones with configurable domain filtering and TTLs.
// By default NO promotion happens — plugins must explicitly opt in.

const DEFAULT_TTL_DAYS = 7;

interface SessionPromotionState {
  config: CookiePromotionConfig | undefined;
}

const sessionPromotionState = new WeakMap<Electron.Session, SessionPromotionState>();

/**
 * Matches a cookie domain against a glob-style pattern.
 *
 * Supports:
 * - "*" — matches everything
 * - "example.com" — exact match (also matches ".example.com")
 * - "*.example.com" — suffix wildcard (sub.example.com, deep.sub.example.com)
 * - "prefix.*" — prefix wildcard (prefix.anything.com)
 */
function domainMatchesPattern(cookieDomain: string, pattern: string): boolean {
  if (pattern === '*') return true;

  // Normalize: strip leading dot from cookie domain for comparison
  const normalized = cookieDomain.replace(/^\./, '').toLowerCase();
  const lowerPattern = pattern.toLowerCase();

  // Suffix wildcard: "*.example.com"
  if (lowerPattern.startsWith('*.')) {
    const suffix = lowerPattern.slice(2); // "example.com"
    return normalized === suffix || normalized.endsWith('.' + suffix);
  }

  // Prefix wildcard: "prefix.*"
  if (lowerPattern.endsWith('.*')) {
    const prefix = lowerPattern.slice(0, -2); // "prefix"
    return normalized.startsWith(prefix + '.') || normalized === prefix;
  }

  // Exact match
  return normalized === lowerPattern;
}

/**
 * Resolves whether a cookie should be promoted and with what TTL.
 * Returns TTL in seconds, or false if the cookie should not be promoted.
 */
function resolveCookiePromotion(config: CookiePromotionConfig | undefined, cookie: Electron.Cookie): number | false {
  // No config or explicitly false = no promotion
  if (!config) return false;

  // Callback mode: let the plugin decide per-cookie
  if (typeof config === 'function') {
    const info: SessionCookieInfo = {
      domain: cookie.domain ?? '',
      name: cookie.name,
      path: cookie.path ?? '/',
      secure: cookie.secure ?? false,
      httpOnly: cookie.httpOnly ?? false,
    };
    const result = config(info);
    if (!result || !result.promote) return false;
    const ttlDays = result.ttlDays ?? DEFAULT_TTL_DAYS;
    return ttlDays * 24 * 60 * 60;
  }

  // Domain pattern mode: check if cookie domain matches any pattern
  const cookieDomain = cookie.domain ?? '';
  const matches = config.domains.some((pattern) => domainMatchesPattern(cookieDomain, pattern));
  if (!matches) return false;

  const ttlDays = config.ttlDays ?? DEFAULT_TTL_DAYS;
  return ttlDays * 24 * 60 * 60;
}

/**
 * Configures session cookie promotion for a partition's session.
 * Installs the cookie listener once; subsequent calls update the config.
 */
function configureSessionCookiePromotion(ses: Electron.Session, config?: CookiePromotionConfig): void {
  const existing = sessionPromotionState.get(ses);

  if (existing) {
    // Update config — last caller wins
    if (config !== undefined) {
      existing.config = config;
    }
    return;
  }

  // First time: install the listener and store state
  const state: SessionPromotionState = { config };
  sessionPromotionState.set(ses, state);

  ses.cookies.on('changed', (_event, cookie, _cause, removed) => {
    // Only promote cookies that were just set (not removed) and lack an expiry
    if (removed || cookie.expirationDate) return;

    const currentState = sessionPromotionState.get(ses);
    if (!currentState) return;

    const ttlSeconds = resolveCookiePromotion(currentState.config, cookie);
    if (ttlSeconds === false) return;

    const expirationDate = Math.floor(Date.now() / 1000) + ttlSeconds;
    ses.cookies
      .set({
        url: `http${cookie.secure ? 's' : ''}://${cookie.domain?.replace(/^\./, '') ?? 'unknown'}${cookie.path ?? '/'}`,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate,
      })
      .catch(() => {
        /* best-effort — ignore failures */
      });
  });
}

type PluginAPICallbacks = {
  appHome: string;
  /** True while this API's activation generation is still the current, live one. */
  isLive?: () => boolean;
  getConfig: () => AppConfig;
  setConfig: (path: string, value: unknown) => void;
  getPluginConfig: () => Record<string, unknown>;
  setPluginConfig: (path: string, value: unknown) => void;
  getPluginState: () => Record<string, unknown>;
  replacePluginState: (next: Record<string, unknown>) => void;
  setPluginState: (path: string, value: unknown) => void;
  emitPluginEvent: (eventName: string, data?: unknown) => void;
  subscribeBus: (key: string, handler: (event: AutomationEvent) => void) => () => void;
  onEventsDeclared: () => void;
  showNotification: (descriptor: Omit<PluginNotificationDescriptor, 'pluginName' | 'visible'>) => void;
  dismissNotification: (id: string) => void;
  openNavigationTarget: (target: PluginNavigationTarget) => void;
  onUIStateChanged: () => void;
  onToolsChanged: () => void;
  onCliToolsChanged?: () => void;
  registerActionHandler: (targetId: string, handler: (action: string, data?: unknown) => void | Promise<void>) => void;
};

function isZodSchema(schema: unknown): schema is z.ZodTypeAny {
  return Boolean(
    schema && typeof schema === 'object' && typeof (schema as { safeParse?: unknown }).safeParse === 'function',
  );
}

const HOOK_EVENT_SET: ReadonlySet<string> = new Set(HOOK_EVENTS as readonly string[]);

/** A rule subscribes to hook events: source hook/* AND event `*` or a hook event. */
function ruleSubscribesToHooks(rule: Record<string, unknown>): boolean {
  const trigger = rule.trigger as { source?: unknown; event?: unknown } | undefined;
  if (!trigger) return false;
  const { source, event } = trigger;
  if (source !== 'hook' && source !== '*') return false;
  return event === '*' || (typeof event === 'string' && HOOK_EVENT_SET.has(event));
}

/**
 * Collect a signature for every "hook-capable" entry in an automations config
 * subtree: automation rules that run a hook command OR subscribe to hook events
 * (source `hook`/`*` with a hook or `*` event), plus standalone runHookCommand
 * actions. Each signature is the JSON of the entry, so ADDING or MODIFYING a
 * hook-capable rule changes the signature set — the plugin config-write gate
 * blocks a non-agent:hook plugin from introducing any new signature (not just
 * from increasing the count, which a same-count edit would bypass).
 */
function hookDangerSignatures(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 8 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const v of value) hookDangerSignatures(v, depth + 1, out);
    return out;
  }
  const obj = value as Record<string, unknown>;
  if (obj.type === 'runHookCommand') out.push('cmd:' + safeJson(obj));
  if (obj.trigger && ruleSubscribesToHooks(obj)) out.push('rule:' + safeJson(obj));
  for (const v of Object.values(obj)) hookDangerSignatures(v, depth + 1, out);
  return out;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Apply a dotted-path write to a nested object in place (numeric segments index
 * into arrays). Used to compute the resulting config for validation before a
 * plugin's config write is persisted.
 */
function applyNestedWrite(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  // Reject prototype-pollution segments — this runs on untrusted plugin paths
  // during validation, before the real config setter's own guard.
  if (parts.some((p) => p === '__proto__' || p === 'constructor' || p === 'prototype')) {
    return;
  }
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = cur[key];
    if (next === null || typeof next !== 'object') {
      cur[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

function normalizePluginTool(tool: ToolDefinition): ToolDefinition {
  const rawSchema = tool.inputSchema as unknown;
  const inputSchema = isZodSchema(rawSchema)
    ? rawSchema
    : rawSchema && typeof rawSchema === 'object'
      ? convertJsonSchemaToZod(rawSchema as Record<string, unknown>)
      : z.object({}).passthrough();

  return {
    ...tool,
    inputSchema,
  };
}

function resolvePluginToolOriginalName(pluginName: string, tool: ToolDefinition): string {
  if (tool.source === 'plugin' && tool.sourceId === pluginName && tool.originalName) {
    return tool.originalName;
  }

  const legacyPrefix = `plugin:${pluginName}:`;
  if (tool.name.startsWith(legacyPrefix)) {
    return tool.name.slice(legacyPrefix.length);
  }

  const safePrefix = getScopedToolPrefix('plugin', pluginName);
  if (tool.name.startsWith(safePrefix)) {
    return tool.name.slice(safePrefix.length);
  }

  return tool.originalName ?? tool.name;
}

function normalizePluginObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

type StoredConversationMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: MessageContent[] | string;
  parentId: string | null;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

function normalizeConversationRole(role: PluginConversationAppendMessage['role']): StoredConversationMessage['role'] {
  return role;
}

function getConversationBranch(tree: StoredConversationMessage[], headId: string | null): StoredConversationMessage[] {
  if (!headId) return [];

  const byId = new Map(tree.map((message) => [message.id, message] as const));
  const branch: StoredConversationMessage[] = [];
  let currentId: string | null = headId;

  while (currentId) {
    const current = byId.get(currentId);
    if (!current) break;
    branch.push(current);
    currentId = current.parentId;
  }

  return branch.reverse();
}

function ensureConversationTree(conversation: PluginConversationRecord): {
  tree: StoredConversationMessage[];
  headId: string | null;
} {
  const rawTree = Array.isArray(conversation.messageTree)
    ? (conversation.messageTree as StoredConversationMessage[])
    : null;

  if (rawTree && rawTree.length > 0) {
    return {
      tree: rawTree,
      headId: conversation.headId ?? rawTree[rawTree.length - 1]?.id ?? null,
    };
  }

  let parentId: string | null = null;
  const tree = (Array.isArray(conversation.messages) ? conversation.messages : []).map((message, index) => {
    const typed = normalizePluginObject(message) as StoredConversationMessage;
    const id =
      typeof typed.id === 'string' && typed.id
        ? typed.id
        : `plugin-msg-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`;
    const normalized: StoredConversationMessage = {
      id,
      role: normalizeConversationRole(
        typed.role === 'user' || typed.role === 'assistant' || typed.role === 'system' || typed.role === 'tool'
          ? typed.role
          : 'assistant',
      ),
      content: (typed.content as MessageContent[] | string | undefined) ?? '',
      parentId,
      createdAt: typeof typed.createdAt === 'string' ? typed.createdAt : new Date().toISOString(),
      metadata: typed.metadata && typeof typed.metadata === 'object' ? typed.metadata : undefined,
    };
    parentId = normalized.id;
    return normalized;
  });

  return {
    tree,
    headId: tree[tree.length - 1]?.id ?? null,
  };
}

function normalizeConversationRecord(conversation: PluginConversationRecord): PluginConversationRecord {
  const { tree, headId } = ensureConversationTree(conversation);
  const branch = getConversationBranch(tree, headId);

  return {
    ...conversation,
    messages: branch,
    messageTree: tree,
    headId,
    messageCount: branch.length,
    userMessageCount: branch.filter((message) => message.role === 'user').length,
  };
}

function listPermission(instance: PluginInstance): string {
  return instance.manifest.permissions.join(', ') || 'none';
}

export function createPluginAPI(instance: PluginInstance, callbacks: PluginAPICallbacks): PluginAPI {
  const { manifest } = instance;
  let httpServer: Server | null = null;

  // Reject calls from a stale activation generation — e.g. a timer/promise that
  // survived a disable (and possible re-enable) and would otherwise act for an
  // instance that's no longer the current, live one. 'loading' is allowed so
  // activate()/deactivate()-time calls on the current generation still work.
  const requireLive = (): void => {
    if (callbacks.isLive && !callbacks.isLive()) {
      throw new Error(`Plugin "${manifest.name}" is no longer active`);
    }
  };

  // Permission-only check (no liveness). Used directly by teardown/cleanup paths
  // that must run even after the plugin is no longer live (e.g. http.close()
  // invoked by cleanupPluginAPI during unload of an errored/disabled plugin).
  const checkPermission = (permission: string): void => {
    if (!manifest.permissions.includes(permission as (typeof manifest.permissions)[number])) {
      throw new Error(
        `Plugin "${manifest.name}" requires permission "${permission}" for this action. Declared: ${listPermission(instance)}`,
      );
    }
  };

  // Every privileged action funnels through requirePermission, so the liveness
  // check lives here too — a disabled/superseded generation can do nothing
  // privileged, regardless of which API method its stale code calls.
  const requirePermission = (permission: string): void => {
    checkPermission(permission);
    requireLive();
  };

  const requireAnyPermission = (permissions: string[]): void => {
    const has = permissions.some((p) => manifest.permissions.includes(p as (typeof manifest.permissions)[number]));
    if (!has) {
      throw new Error(
        `Plugin "${manifest.name}" requires one of [${permissions.join(', ')}] for this action. Declared: ${listPermission(instance)}`,
      );
    }
    requireLive();
  };

  const registerOrReplace = <T extends { id: string }>(items: T[], descriptor: T): void => {
    const index = items.findIndex((item) => item.id === descriptor.id);
    if (index >= 0) {
      items[index] = descriptor;
    } else {
      items.push(descriptor);
    }
    callbacks.onUIStateChanged();
  };

  const api: PluginAPI = {
    pluginName: manifest.name,
    pluginDir: instance.dir,

    host: {
      apiVersion: () => getHostPluginApiVersion(),
      capabilities: () => getHostCapabilities(),
      hasCapability: (cap: string) => getHostCapabilities().includes(cap),
    },

    config: {
      get: (): AppConfig | PluginSafeConfig => {
        requirePermission('config:read');
        // Default to the redacted view. Only plugins that declared
        // 'config:read-secrets' (gated through the install-time consent
        // modal — see PluginManager.DANGEROUS_PERMISSIONS) receive the
        // full AppConfig including provider API keys, AWS secrets, MCP
        // server env vars, web server password, TLS private key paths,
        // and Azure subscription keys.
        return resolvePluginConfigView(callbacks.getConfig(), manifest.permissions);
      },

      set: (path: string, value: unknown) => {
        requirePermission('config:write');
        const hasAgentHook = manifest.permissions.includes('agent:hook' as (typeof manifest.permissions)[number]);
        if (!hasAgentHook) {
          // Hook enforcement is gated by the dangerous `agent:hook` permission.
          // A low-perm `config:write` plugin must not be able to add, modify,
          // OR NEUTER hook coverage — otherwise it could bypass a user's DLP
          // hooks. Block:
          //   (1) any `hooks.*` write (e.g. hooks.enabled=false, timeout)
          //   (2) `automations.enabled` writes when hook-capable rules exist
          //   (3) any automations write that CHANGES the hook-capable rule set
          //       (add / modify / remove — a removed signature disables a hook)
          if (path === 'hooks' || path.startsWith('hooks.')) {
            throw new Error('Writing hook settings ("hooks.*") requires the "agent:hook" permission.');
          }
          if (path === 'automations' || path.startsWith('automations.')) {
            const currentAutomations = (callbacks.getConfig() as { automations?: unknown }).automations;
            const clone =
              currentAutomations && typeof currentAutomations === 'object'
                ? (JSON.parse(JSON.stringify(currentAutomations)) as Record<string, unknown>)
                : {};
            const before = hookDangerSignatures(currentAutomations);
            const container: Record<string, unknown> = { automations: clone };
            applyNestedWrite(container, path, value);
            const after = hookDangerSignatures(container.automations);
            const beforeSet = new Set(before);
            const afterSet = new Set(after);
            const changed =
              before.length !== after.length ||
              after.some((s) => !beforeSet.has(s)) ||
              before.some((s) => !afterSet.has(s));
            // Disabling the whole automations engine also neuters hook coverage.
            const disablingWithHooks = (path === 'automations.enabled' || path === 'automations') && before.length > 0;
            // `approvalMode` decides whether the agent's `automations` tool prompts
            // the user (or silently allows) before creating dangerous hook/shell
            // rules. Loosening it (e.g. to "auto-allow") is itself a hook-enforcement
            // change, so gate any modification to it behind agent:hook.
            const readApprovalMode = (a: unknown): unknown =>
              a && typeof a === 'object' ? (a as { approvalMode?: unknown }).approvalMode : undefined;
            const approvalModeChanged =
              readApprovalMode(currentAutomations) !== readApprovalMode(container.automations);
            if (changed || disablingWithHooks || approvalModeChanged) {
              throw new Error(
                'Adding, modifying, or removing hook commands / hook-triggered automations, changing the automations approval mode, or disabling automations while hook rules exist requires the "agent:hook" permission.',
              );
            }
          }
        }
        callbacks.setConfig(path, value);
      },

      getPluginData: () => {
        requirePermission('config:read');
        return callbacks.getPluginConfig();
      },

      setPluginData: (path: string, value: unknown) => {
        requirePermission('config:write');
        callbacks.setPluginConfig(path, value);
      },

      onChanged: (callback: (config: AppConfig | PluginSafeConfig) => void) => {
        requirePermission('config:read');
        instance.configChangeListeners.push(callback);
        return () => {
          const idx = instance.configChangeListeners.indexOf(callback);
          if (idx >= 0) instance.configChangeListeners.splice(idx, 1);
        };
      },
    },

    state: {
      get: () => callbacks.getPluginState(),
      replace: (next: Record<string, unknown>) => {
        requirePermission('state:publish');
        callbacks.replacePluginState(normalizePluginObject(next));
      },
      set: (path: string, value: unknown) => {
        requirePermission('state:publish');
        callbacks.setPluginState(path, value);
      },
      emitEvent: (eventName: string, data?: unknown) => {
        requireAnyPermission(['state:publish', 'events:publish']);
        callbacks.emitPluginEvent(eventName, data);
      },
    },

    events: {
      declare: (decl) => {
        requirePermission('events:publish');
        if (decl.events) {
          const seen = new Set(instance.declaredEvents.map((e) => e.event));
          for (const ev of decl.events) if (!seen.has(ev.event)) instance.declaredEvents.push(ev);
        }
        if (decl.actions) {
          const seen = new Set(instance.declaredActions.map((a) => a.targetId));
          for (const ac of decl.actions) if (!seen.has(ac.targetId)) instance.declaredActions.push(ac);
        }
        callbacks.onEventsDeclared();
      },
      emit: (event: string, payload?: unknown) => {
        requireAnyPermission(['events:publish', 'state:publish']);
        callbacks.emitPluginEvent(event, payload);
      },
      on: (key: string, handler: (event: AutomationEvent) => void) => {
        requirePermission('events:subscribe');
        // hook:* events carry raw prompts / tool args / tool results — exactly
        // what the dangerous `agent:hook` permission gates. Subscribing to that
        // source directly requires it. A wildcard `'*'` subscription is allowed
        // without agent:hook but has hook:* events filtered OUT, so a low-perm
        // plugin can't observe the agent loop by subscribing to everything.
        const hasAgentHook = manifest.permissions.includes('agent:hook' as (typeof manifest.permissions)[number]);
        if ((key === 'hook' || key.startsWith('hook:')) && !hasAgentHook) {
          requirePermission('agent:hook'); // throws with a clear message
        }
        const guarded: (event: AutomationEvent) => void = hasAgentHook
          ? handler
          : (event) => {
              if (event.source === 'hook') return; // filtered for non-agent:hook plugins
              handler(event);
            };
        const off = callbacks.subscribeBus(key, guarded);
        instance.eventUnsubscribers.push(off);
        return () => {
          off();
          const idx = instance.eventUnsubscribers.indexOf(off);
          if (idx >= 0) instance.eventUnsubscribers.splice(idx, 1);
        };
      },
    },

    tools: {
      register: (tools: ToolDefinition[]) => {
        requirePermission('tools:register');
        const seenNames = new Set<string>();
        const prefixed = tools
          .map((tool) => normalizePluginTool(tool))
          .map((tool) => {
            const originalName = resolvePluginToolOriginalName(manifest.name, tool);
            let scopedName = buildScopedToolName('plugin', manifest.name, originalName);

            // buildScopedToolName already truncates to MAX_TOOL_NAME_LENGTH, but
            // truncation can cause collisions.  Append a counter to resolve.
            if (seenNames.has(scopedName)) {
              let counter = 2;
              while (seenNames.has(`${scopedName.slice(0, MAX_TOOL_NAME_LENGTH - 2)}_${counter}`)) counter++;
              scopedName = `${scopedName.slice(0, MAX_TOOL_NAME_LENGTH - 2)}_${counter}`;
              console.warn(
                `[plugin:${manifest.name}] Tool name collision after truncation, resolved: ${originalName} → ${scopedName}`,
              );
            }
            seenNames.add(scopedName);

            const originalExecute = tool.execute;
            const guardedExecute = async (input: unknown, context: ToolExecutionContext) => {
              // Liveness is checked at invoke time, not registration time: a chat
              // stream may have captured this tool before the plugin was disabled.
              // Refuse to run a disabled/superseded plugin's tool even if the model
              // still calls it mid-run.
              if (callbacks.isLive && !callbacks.isLive()) {
                throw new Error(`Plugin "${manifest.name}" is no longer active`);
              }
              return originalExecute(input, context);
            };

            return {
              ...tool,
              execute: guardedExecute,
              name: scopedName,
              source: 'plugin' as const,
              sourceId: manifest.name,
              originalName,
              aliases: Array.from(
                new Set([...(tool.aliases ?? []), tool.name, `plugin:${manifest.name}:${originalName}`]),
              ),
            };
          });
        const newNames = new Set(prefixed.map((tool) => tool.name));
        instance.registeredTools = instance.registeredTools.filter((tool) => !newNames.has(tool.name));
        instance.registeredTools.push(...prefixed);
        callbacks.onToolsChanged();
      },

      unregister: (toolNames: string[]) => {
        requirePermission('tools:register');
        const fullNames = new Set(
          toolNames.flatMap((name) => {
            const originalName = name.startsWith(`plugin:${manifest.name}:`)
              ? name.slice(`plugin:${manifest.name}:`.length)
              : name;

            return [
              name,
              `plugin:${manifest.name}:${originalName}`,
              buildScopedToolName('plugin', manifest.name, originalName),
            ];
          }),
        );
        instance.registeredTools = instance.registeredTools.filter(
          (tool) => !fullNames.has(tool.name) && !tool.aliases?.some((alias) => fullNames.has(alias)),
        );
        callbacks.onToolsChanged();
      },
    },

    messages: {
      registerPreSendHook: (hook: PreSendHook) => {
        requirePermission('messages:hook');
        instance.preSendHooks.push(hook);
      },

      registerPostReceiveHook: (hook: PostReceiveHook) => {
        requirePermission('messages:hook');
        instance.postReceiveHooks.push(hook);
      },
    },

    lifecycle: {
      registerPreUpdateHook: (hook: PreUpdateHook) => {
        requirePermission('lifecycle:hook');
        instance.preUpdateHooks.push(hook);
      },

      registerPostUpdateHook: (hook: PostUpdateHook) => {
        requirePermission('lifecycle:hook');
        instance.postUpdateHooks.push(hook);
      },
    },

    hooks: {
      register: (event, handler, opts) => {
        requirePermission('agent:hook');
        // Wrap so a stale activation generation (disabled/reloaded plugin) can
        // never run, even if the dispatcher still holds the registration.
        const guarded = (payload: unknown) => {
          if (callbacks.isLive && !callbacks.isLive()) return undefined;
          return handler(payload);
        };
        const off = hookDispatcher.register(event, guarded, {
          mode: opts?.mode ?? 'observe',
          matcher: opts?.matcher,
          source: 'plugin',
          pluginId: manifest.name,
        });
        instance.agentHookUnsubscribers.push(off);
        return () => {
          off();
          const idx = instance.agentHookUnsubscribers.indexOf(off);
          if (idx >= 0) instance.agentHookUnsubscribers.splice(idx, 1);
        };
      },
    },

    ui: {
      showBanner: (descriptor: Omit<PluginBannerDescriptor, 'pluginName'>) => {
        requirePermission('ui:banner');
        registerOrReplace(instance.uiBanners, { ...descriptor, pluginName: manifest.name });
      },

      hideBanner: (id: string) => {
        requirePermission('ui:banner');
        const idx = instance.uiBanners.findIndex((banner) => banner.id === id);
        if (idx >= 0) {
          instance.uiBanners[idx] = { ...instance.uiBanners[idx], visible: false };
          callbacks.onUIStateChanged();
        }
      },

      showModal: (descriptor: Omit<PluginModalDescriptor, 'pluginName'>) => {
        requirePermission('ui:modal');
        registerOrReplace(instance.uiModals, { ...descriptor, pluginName: manifest.name });
      },

      hideModal: (id: string) => {
        requirePermission('ui:modal');
        const idx = instance.uiModals.findIndex((modal) => modal.id === id);
        if (idx >= 0) {
          instance.uiModals[idx] = { ...instance.uiModals[idx], visible: false };
          callbacks.onUIStateChanged();
        }
      },

      updateModal: (id: string, updates: Partial<Omit<PluginModalDescriptor, 'id' | 'pluginName'>>) => {
        requirePermission('ui:modal');
        const idx = instance.uiModals.findIndex((modal) => modal.id === id);
        if (idx >= 0) {
          instance.uiModals[idx] = { ...instance.uiModals[idx], ...updates };
          callbacks.onUIStateChanged();
        }
      },

      registerSettingsView: (descriptor: Omit<PluginSettingsSectionDescriptor, 'pluginName' | 'component'>) => {
        requirePermission('ui:settings');
        registerOrReplace(instance.uiSettingsSections, {
          ...descriptor,
          component: 'SettingsView',
          pluginName: manifest.name,
        });
      },

      registerPanelView: (descriptor: Omit<PluginPanelDescriptor, 'pluginName' | 'component'>) => {
        requirePermission('ui:panel');
        registerOrReplace(instance.uiPanels, { ...descriptor, component: 'PanelView', pluginName: manifest.name });
      },

      registerNavigationItem: (descriptor) => {
        requirePermission('ui:navigation');
        registerOrReplace(instance.uiNavigationItems, {
          ...descriptor,
          pluginName: manifest.name,
          label: manifest.displayName,
          ...(manifest.icon ? { icon: manifest.icon } : {}),
        });
      },

      registerCommand: (descriptor: Omit<PluginCommandDescriptor, 'pluginName'>) => {
        requirePermission('ui:navigation');
        registerOrReplace(instance.uiCommands, { ...descriptor, pluginName: manifest.name });
      },

      showConversationDecoration: (descriptor: Omit<PluginConversationDecorationDescriptor, 'pluginName'>) => {
        requirePermission('ui:navigation');
        registerOrReplace(instance.conversationDecorations, { ...descriptor, pluginName: manifest.name });
      },

      hideConversationDecoration: (id: string) => {
        requirePermission('ui:navigation');
        const idx = instance.conversationDecorations.findIndex((decoration) => decoration.id === id);
        if (idx >= 0) {
          instance.conversationDecorations[idx] = { ...instance.conversationDecorations[idx], visible: false };
          callbacks.onUIStateChanged();
        }
      },

      showThreadDecoration: (descriptor: Omit<PluginThreadDecorationDescriptor, 'pluginName'>) => {
        requirePermission('ui:navigation');
        registerOrReplace(instance.threadDecorations, { ...descriptor, pluginName: manifest.name });
      },

      hideThreadDecoration: (id: string) => {
        requirePermission('ui:navigation');
        const idx = instance.threadDecorations.findIndex((decoration) => decoration.id === id);
        if (idx >= 0) {
          instance.threadDecorations[idx] = { ...instance.threadDecorations[idx], visible: false };
          callbacks.onUIStateChanged();
        }
      },
    },

    notifications: {
      show: (descriptor) => {
        requirePermission('notifications:send');
        callbacks.showNotification(descriptor);
      },
      dismiss: (id: string) => {
        requirePermission('notifications:send');
        callbacks.dismissNotification(id);
      },
    },

    navigation: {
      open: (target) => {
        requirePermission('navigation:open');
        callbacks.openNavigationTarget(target);
      },
    },

    conversations: {
      list: () => {
        requirePermission('conversations:read');
        return [];
      },
      get: (_conversationId: string) => null,
      upsert: (_conversation: PluginConversationRecord) => {},
      setActive: (_conversationId: string) => {},
      getActiveId: () => null,
      appendMessage: (_conversationId: string, _message: PluginConversationAppendMessage) => null,
      markUnread: (_conversationId: string, _unread: boolean) => {},
    },

    log: {
      info: (...args: unknown[]) => console.info(`[Plugin:${manifest.name}]`, ...args),
      warn: (...args: unknown[]) => console.warn(`[Plugin:${manifest.name}]`, ...args),
      error: (...args: unknown[]) => console.error(`[Plugin:${manifest.name}]`, ...args),
    },

    shell: {
      openExternal: (url: string) => {
        requirePermission('navigation:open');
        // navigation:open means "open a web link" — never let a plugin launch
        // file://, ms-settings:, or an arbitrary custom OS protocol handler.
        // Same http/https/mailto allowlist the main window uses (openExternalSafely).
        if (!isExternallyOpenableUrl(url)) {
          throw new Error(`Plugin "${manifest.name}" cannot open a non-http(s)/mailto URL: ${url}`);
        }
        return shell.openExternal(url);
      },
    },

    auth: {
      openAuthWindow: (options: PluginAuthWindowOptions): Promise<PluginAuthResult> => {
        requirePermission('auth:window');
        const {
          url,
          callbackMatch,
          title = 'Sign In',
          width = 620,
          height = 720,
          timeoutMs = 300_000,
          showOnCreate = true,
          showAfterMs,
          successMessage,
          extractParams,
          interceptUrls,
          interceptHeader,
          partition,
          onReady,
          customUserAgent,
        } = options;

        return new Promise((resolve) => {
          let settled = false;
          let wasShown = showOnCreate;
          let revealTimer: NodeJS.Timeout | null = null;

          const ses = partition ? session.fromPartition(partition) : undefined;
          if (ses) configureSessionCookiePromotion(ses, options.cookiePromotion);

          const authWin = new BrowserWindow({
            width,
            height,
            show: showOnCreate,
            title,
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              ...(ses ? { session: ses } : {}),
            },
          });
          if (customUserAgent !== false) {
            authWin.webContents.setUserAgent(
              typeof customUserAgent === 'string' ? customUserAgent : getBrandUserAgent(),
            );
          }

          const clearRevealTimer = () => {
            if (revealTimer) {
              clearTimeout(revealTimer);
              revealTimer = null;
            }
          };

          const INTERACTIVE_AUTH_TIMEOUT_MS = 300_000;

          const revealWindow = () => {
            if (settled || authWin.isDestroyed() || authWin.isVisible()) return;
            wasShown = true;
            authWin.show();
            authWin.focus();
            // The caller's timeoutMs was a budget for silent/hidden auth. Once the
            // user is looking at a login form, give them the full interactive
            // budget instead of cutting them off mid-keystroke.
            if (timeoutMs < INTERACTIVE_AUTH_TIMEOUT_MS) {
              clearTimeout(timeout);
              timeout = setTimeout(() => {
                settle({ success: false, error: 'Authentication timed out' });
              }, INTERACTIVE_AUTH_TIMEOUT_MS);
            }
          };

          const settle = (result: PluginAuthResult, closeWindow = true) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            clearRevealTimer();
            if (closeWindow) {
              setTimeout(() => {
                try {
                  if (!authWin.isDestroyed()) authWin.close();
                } catch {
                  /* ignore */
                }
              }, 500);
            }
            resolve(result);
          };

          if (!showOnCreate && typeof showAfterMs === 'number' && showAfterMs >= 0) {
            revealTimer = setTimeout(revealWindow, showAfterMs);
          }

          let timeout = setTimeout(() => {
            settle({ success: false, error: 'Authentication timed out' });
          }, timeoutMs);

          // Mode 1: Header interception (for APIs that don't use redirects)
          if (interceptUrls && interceptUrls.length > 0 && interceptHeader) {
            const targetSession = ses ?? authWin.webContents.session;
            const urlPatterns = interceptUrls;
            targetSession.webRequest.onBeforeSendHeaders({ urls: urlPatterns }, (details, callback) => {
              const headerValue =
                details.requestHeaders[interceptHeader] ??
                details.requestHeaders[interceptHeader.toLowerCase()] ??
                details.requestHeaders[interceptHeader.charAt(0).toUpperCase() + interceptHeader.slice(1)];
              if (headerValue && !settled) {
                settle({ success: true, params: { [interceptHeader]: headerValue } }, true);
              }
              callback({ requestHeaders: details.requestHeaders });
            });
          }

          // Mode 2: Redirect matching (original behavior)
          if (callbackMatch) {
            const handleRedirect = (_event: Electron.Event, redirectUrl: string) => {
              if (settled || !redirectUrl.includes(callbackMatch)) return;

              try {
                const parsed = new URL(redirectUrl);
                const params: Record<string, string> = {};
                parsed.searchParams.forEach((value, key) => {
                  if (!extractParams || extractParams.includes(key)) {
                    params[key] = value;
                  }
                });

                clearRevealTimer();
                settled = true;
                clearTimeout(timeout);

                if (!wasShown) {
                  try {
                    authWin.close();
                  } catch {
                    /* ignore */
                  }
                  resolve({ success: true, params });
                  return;
                }

                const successHtml =
                  successMessage ||
                  `
                  <html>
                  <body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #1a1a2e; color: #e0e0e0;">
                    <div style="text-align: center;">
                      <h2 style="color: #4ade80;">&#10003; Authentication Successful</h2>
                      <p>You can close this window and return to the application.</p>
                    </div>
                  </body>
                  </html>
                `;
                authWin.loadURL(`data:text/html,${encodeURIComponent(successHtml)}`);
                setTimeout(() => {
                  try {
                    authWin.close();
                  } catch {
                    /* ignore */
                  }
                }, 2000);

                resolve({ success: true, params });
              } catch (err) {
                settle({ success: false, error: err instanceof Error ? err.message : String(err) });
              }
            };

            authWin.webContents.on('will-redirect', handleRedirect);
            authWin.webContents.on('will-navigate', handleRedirect);
          }

          // Provide helpers to the caller for auto-login / webContents interaction
          if (onReady) {
            const helpers = {
              executeJavaScript: (code: string) => authWin.webContents.executeJavaScript(code),
              getURL: () => authWin.webContents.getURL(),
              onDidNavigate: (cb: (url: string) => void) => {
                authWin.webContents.on('did-navigate', (_event: Electron.Event, navUrl: string) => cb(navUrl));
                authWin.webContents.on('will-redirect', (_event: Electron.Event, navUrl: string) => cb(navUrl));
                authWin.webContents.on('will-navigate', (_event: Electron.Event, navUrl: string) => cb(navUrl));
              },
              show: () => revealWindow(),
              hide: () => {
                if (!authWin.isDestroyed()) authWin.hide();
              },
              close: () => settle({ success: false, error: 'Closed by plugin' }),
            };
            onReady(helpers);
          }

          authWin.loadURL(url).catch((err) => {
            settle({ success: false, error: `Failed to load auth URL: ${err.message}` });
          });

          authWin.once('close', () => {
            if (!settled) {
              settle({ success: false, error: 'Auth window closed by user' }, false);
            }
          });
        });
      },
    },

    safeStorage: {
      isEncryptionAvailable: () => {
        requirePermission('safe-storage');
        // Avoid calling safeStorage.isEncryptionAvailable() eagerly — on
        // macOS (especially MDM-managed machines) even the availability check
        // can trigger a Keychain access prompt at startup.  Encryption is
        // always available on macOS and Windows once the app is ready, so we
        // only need to probe on other platforms.
        if (process.platform === 'darwin' || process.platform === 'win32') {
          return app.isReady();
        }
        return safeStorage.isEncryptionAvailable();
      },
      encryptString: (plaintext: string) => {
        requirePermission('safe-storage');
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('OS encryption is not available');
        }
        return safeStorage.encryptString(plaintext).toString('base64');
      },
      decryptString: (base64Cipher: string) => {
        requirePermission('safe-storage');
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('OS encryption is not available');
        }
        return safeStorage.decryptString(Buffer.from(base64Cipher, 'base64'));
      },
    },

    browser: {
      open: (options: PluginBrowserWindowOptions) => {
        requirePermission('browser:window');
        if (options.partition) {
          configureSessionCookiePromotion(session.fromPartition(options.partition), options.cookiePromotion);
        }
        openPluginBrowserWindow(options);
      },
    },

    session: {
      clearCookies: async (partition: string, filter?: { domain?: string }): Promise<number> => {
        requirePermission('auth:window');
        const ses = session.fromPartition(partition);
        const allCookies = await ses.cookies.get({});

        let targetCookies = allCookies;
        if (filter?.domain) {
          const domains = Array.isArray(filter.domain) ? filter.domain : [filter.domain];
          targetCookies = allCookies.filter((cookie) => {
            const d = cookie.domain?.toLowerCase() ?? '';
            return domains.some((pattern) => d.includes(pattern.toLowerCase()));
          });
        }

        for (const cookie of targetCookies) {
          const protocol = cookie.secure ? 'https' : 'http';
          const domain = cookie.domain?.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
          const cookieUrl = `${protocol}://${domain}${cookie.path}`;
          await ses.cookies.remove(cookieUrl, cookie.name);
        }

        return targetCookies.length;
      },
    },

    http: {
      listen: (port, handler, options) => {
        requirePermission('http:listen');
        return new Promise<void>((resolve, reject) => {
          if (httpServer) {
            reject(new Error('HTTP server already running for this plugin'));
            return;
          }

          httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            try {
              const parsedUrl = new URL(req.url ?? '/', `http://localhost:${port}`);
              const query: Record<string, string> = {};
              parsedUrl.searchParams.forEach((value, key) => {
                query[key] = value;
              });

              const headers: Record<string, string> = {};
              for (const [key, value] of Object.entries(req.headers)) {
                if (typeof value === 'string') headers[key] = value;
              }

              let body = '';
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                body = await new Promise<string>((resolveBody, rejectBody) => {
                  const chunks: Buffer[] = [];
                  let received = 0;
                  req.on('data', (chunk: Buffer) => {
                    received += chunk.length;
                    // Cap the buffered body so a large/slow request can't be
                    // used as a memory-exhaustion DoS against the host process.
                    if (received > PLUGIN_HTTP_MAX_BODY_BYTES) {
                      req.destroy();
                      rejectBody(new Error('Request body too large'));
                      return;
                    }
                    chunks.push(chunk);
                  });
                  req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf-8')));
                  req.on('error', (e) => rejectBody(e));
                });
              }

              const pluginReq: PluginHttpRequest = {
                method: req.method ?? 'GET',
                url: parsedUrl.pathname,
                headers,
                query,
                body: body || undefined,
              };

              const pluginRes: PluginHttpResponse = await handler(pluginReq);

              res.writeHead(pluginRes.status ?? 200, {
                'Content-Type': 'text/html',
                ...pluginRes.headers,
              });
              res.end(pluginRes.body ?? '');
            } catch (err) {
              console.error(`[Plugin:${manifest.name}] HTTP handler error:`, err);
              res.writeHead(500);
              res.end('Internal plugin error');
            }
          });

          const requestedHost = options?.host ?? '127.0.0.1';
          // http:listen is a LOCAL-server grant, not a network-exposure grant.
          // A plugin passing host '0.0.0.0'/'::'/a LAN address would bind the
          // (unauthenticated, plugin-controlled) handler to every interface and
          // expose it to the LAN. Restrict binds to loopback so the permission
          // means what it says; reject anything else rather than silently
          // downgrading, so a plugin author sees the misconfiguration.
          if (!isLoopbackHost(requestedHost)) {
            reject(
              new Error(
                `Plugin "${manifest.name}" http.listen host must be loopback (127.0.0.1/::1/localhost); refusing "${requestedHost}".`,
              ),
            );
            return;
          }
          const host = requestedHost;
          // Bound how long a client can hold a request/socket open, so a slow-
          // loris style connection can't tie up the plugin's server.
          httpServer.requestTimeout = PLUGIN_HTTP_REQUEST_TIMEOUT_MS;
          httpServer.headersTimeout = PLUGIN_HTTP_REQUEST_TIMEOUT_MS;
          httpServer.listen(port, host, () => {
            console.info(`[Plugin:${manifest.name}] HTTP server listening on ${host}:${port}`);
            resolve();
          });

          httpServer.on('error', reject);
        });
      },

      close: () => {
        // Permission-only (no liveness): cleanup must succeed during unload of an
        // errored/disabled plugin, when the instance is no longer live.
        checkPermission('http:listen');
        return new Promise<void>((resolve) => {
          if (!httpServer) {
            resolve();
            return;
          }
          httpServer.close(() => {
            httpServer = null;
            resolve();
          });
        });
      },
    },

    agent: {
      generate: async (options) => {
        requirePermission('agent:generate');
        const config = callbacks.getConfig();
        const allTools = options.tools ? getRegisteredTools() : [];
        return generateForPlugin({
          messages: options.messages,
          config,
          appHome: callbacks.appHome,
          modelKey: options.modelKey,
          profileKey: options.profileKey,
          reasoningEffort: options.reasoningEffort,
          fallbackEnabled: options.fallbackEnabled,
          systemPrompt: options.systemPrompt,
          tools: allTools,
          abortSignal: options.abortSignal,
        });
      },

      stream: async function* (options) {
        requirePermission('agent:generate');
        const config = callbacks.getConfig();
        const allTools = options.tools ? getRegisteredTools() : [];
        yield* streamForPlugin({
          messages: options.messages,
          config,
          appHome: callbacks.appHome,
          modelKey: options.modelKey,
          profileKey: options.profileKey,
          reasoningEffort: options.reasoningEffort,
          fallbackEnabled: options.fallbackEnabled,
          systemPrompt: options.systemPrompt,
          tools: allTools,
          abortSignal: options.abortSignal,
        });
      },

      registerInferenceProvider: (provider: PluginInferenceProvider) => {
        requirePermission('agent:inference-provider');
        if (!provider || typeof provider.stream !== 'function' || typeof provider.isAvailable !== 'function') {
          throw new Error('Invalid inference provider: must have name, isAvailable(), and stream().');
        }
        instance.inferenceProvider = provider;
        console.info(`[PluginAPI:${manifest.name}] Registered inference provider: ${provider.name}`);
      },

      unregisterInferenceProvider: () => {
        requirePermission('agent:inference-provider');
        if (instance.inferenceProvider) {
          console.info(
            `[PluginAPI:${manifest.name}] Unregistered inference provider: ${instance.inferenceProvider.name}`,
          );
          instance.inferenceProvider = null;
        }
      },

      registerCliTool: (tool: PluginCliToolContribution) => {
        requirePermission('agent:register-cli-tool');
        if (!tool?.name || !tool?.binary || !tool?.description) {
          throw new Error('Invalid CLI tool contribution: must have name, binary, and description.');
        }
        const existing = instance.contributedCliTools.findIndex((t) => t.name === tool.name);
        if (existing >= 0) {
          instance.contributedCliTools[existing] = tool;
        } else {
          instance.contributedCliTools.push(tool);
        }
        console.info(`[PluginAPI:${manifest.name}] Registered CLI tool: ${tool.name} (binary: ${tool.binary})`);
        callbacks.onCliToolsChanged?.();
      },
    },

    onAction: (targetId: string, handler: (action: string, data?: unknown) => void | Promise<void>) => {
      callbacks.registerActionHandler(targetId, handler);
    },

    fetch: (async (...args: Parameters<typeof globalThis.fetch>) => {
      requirePermission('network:fetch');
      const [input, init] = args;
      // network:fetch is a NETWORK grant — it must not double as a local-file
      // read. Electron's net.fetch honors file:// (and other non-http schemes),
      // so a plugin could otherwise `fetch('file:///etc/passwd')`. Resolve the
      // request URL to a canonical string, validate its scheme, and forward that
      // SAME validated string to net.fetch (never the original object) so what we
      // check is exactly what gets fetched — no validate-one/use-another gap.
      // async so all rejections propagate as a rejected Promise (fetch contract),
      // and TypeError matches what fetch throws for a bad/unsupported request.
      let urlString: string;
      let forwardInput: string | Request;
      if (typeof input === 'string') {
        urlString = input;
        forwardInput = input;
      } else if (input instanceof URL) {
        urlString = input.toString();
        forwardInput = urlString;
      } else if (input instanceof Request) {
        // A Request's URL is fixed at construction, so validating input.url and
        // forwarding the same Request can't diverge (unlike String()-coercing an
        // arbitrary object, which could validate one URL and fetch another).
        urlString = input.url;
        forwardInput = input;
      } else {
        throw new TypeError(`Plugin "${manifest.name}" fetch: unsupported input; pass a string, URL, or Request.`);
      }
      let scheme: string;
      try {
        scheme = new URL(urlString).protocol;
      } catch {
        throw new TypeError(`Plugin "${manifest.name}" fetch: invalid URL: ${urlString}`);
      }
      if (scheme !== 'http:' && scheme !== 'https:') {
        throw new TypeError(`Plugin "${manifest.name}" fetch is restricted to http(s); refusing "${scheme}" URL.`);
      }
      return net.fetch(
        forwardInput as Parameters<typeof net.fetch>[0],
        init as Parameters<typeof net.fetch>[1],
      ) as ReturnType<typeof globalThis.fetch>;
    }) as typeof globalThis.fetch,

    // ─── Whitelisted Command Execution ──────────────────────────────────

    exec: {
      run: async (request: ExecRequest) => {
        requirePermission('exec:whitelisted');
        const execScope = manifest.execScope;
        if (!execScope) {
          return {
            exitCode: -1,
            stdout: '',
            stderr: 'No execScope declared in plugin.json',
            command: request.binary,
            durationMs: 0,
            truncated: false,
          };
        }
        return executeCommand(request, execScope, manifest.name, writeAuditEntry);
      },

      which: async (binary: AllowedBinary) => {
        requirePermission('exec:whitelisted');
        return findBinary(binary);
      },
    },

    // ─── Tool Detection ─────────────────────────────────────────────────

    detect: {
      claudeCode: () => {
        requirePermission('tools:detect');
        return detectTool('claude');
      },
      codex: () => {
        requirePermission('tools:detect');
        return detectTool('codex');
      },
      python: () => {
        requirePermission('tools:detect');
        return detectTool('python3');
      },
      node: () => {
        requirePermission('tools:detect');
        return detectTool('node');
      },
      git: () => {
        requirePermission('tools:detect');
        return detectTool('git');
      },
      pip: () => {
        requirePermission('tools:detect');
        return detectTool('pip3');
      },
      binary: (name: AllowedBinary) => {
        requirePermission('tools:detect');
        return detectTool(name);
      },

      claudePlugin: async (pluginName: string) => {
        requirePermission('tools:detect');
        const installedPath = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
        try {
          if (!existsSync(installedPath)) return { installed: false };
          const data = JSON.parse(await readFile(installedPath, 'utf-8'));
          const plugins = data.plugins ?? data;
          const found = Array.isArray(plugins)
            ? plugins.find((p: { name?: string }) => p.name === pluginName)
            : plugins[pluginName];
          return found ? { installed: true, version: found.version, path: found.path } : { installed: false };
        } catch {
          return { installed: false };
        }
      },

      codexSkill: async (skillId: string) => {
        requirePermission('tools:detect');
        const skillPath = join(homedir(), '.codex', 'skills', skillId, 'SKILL.md');
        return { installed: existsSync(skillPath), path: existsSync(skillPath) ? skillPath : undefined };
      },

      all: async () => {
        requirePermission('tools:detect');
        const [claude, codex, python, node, git, pip] = await Promise.all([
          detectTool('claude'),
          detectTool('codex'),
          detectTool('python3'),
          detectTool('node'),
          detectTool('git'),
          detectTool('pip3'),
        ]);
        return { claude, codex, python, node, git, pip };
      },
    },

    // ─── Safe Environment Access ────────────────────────────────────────

    env: {
      home: () => {
        requirePermission('system:env');
        return homedir();
      },
      platform: () => {
        requirePermission('system:env');
        return process.platform;
      },
      get: (name: string) => {
        requirePermission('system:env');
        if (!SAFE_ENV_VARS.has(name)) return undefined;
        return process.env[name];
      },
      paths: () => {
        requirePermission('system:env');
        return (process.env.PATH ?? '').split(':');
      },
    },
  };

  api.conversations.list = () => {
    requirePermission('conversations:read');
    return readAllConversations(callbacks.appHome) as PluginConversationRecord[];
  };

  api.conversations.get = (conversationId: string) => {
    requirePermission('conversations:read');
    return (readConversation(callbacks.appHome, conversationId) as PluginConversationRecord | undefined) ?? null;
  };

  api.conversations.upsert = (conversation: PluginConversationRecord) => {
    requirePermission('conversations:write');
    const normalizedConversation = normalizeConversationRecord(conversation);
    writeConversation(callbacks.appHome, normalizedConversation as never);
    broadcastUpsert(callbacks.appHome, normalizedConversation as never);
  };

  api.conversations.getActiveId = () => {
    requirePermission('conversations:read');
    return getActiveConversationId(callbacks.appHome);
  };

  api.conversations.setActive = (conversationId: string) => {
    requirePermission('conversations:write');
    setActiveConversationId(callbacks.appHome, conversationId);
    broadcastActive(callbacks.appHome);
    callbacks.openNavigationTarget({ type: 'conversation', conversationId });
  };

  api.conversations.appendMessage = (conversationId: string, message: PluginConversationAppendMessage) => {
    requirePermission('conversations:write');
    const conversation = api.conversations.get(conversationId);
    if (!conversation) return null;

    const next = normalizePluginObject(conversation) as PluginConversationRecord;
    const { tree, headId } = ensureConversationTree(next);
    const messageId = `plugin-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const normalizedContent =
      typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    const createdAt = message.createdAt ?? new Date().toISOString();
    const normalizedRole = normalizeConversationRole(message.role);

    const storedMessage: StoredConversationMessage = {
      id: messageId,
      role: normalizedRole,
      content: normalizedContent,
      parentId: message.parentId ?? headId,
      createdAt,
      metadata: message.metadata ? { ...message.metadata } : undefined,
    };

    const nextTree = [...tree, storedMessage];
    const nextHeadId = storedMessage.id;
    const nextBranch = getConversationBranch(nextTree, nextHeadId);

    next.messages = nextBranch;
    next.messageTree = nextTree;
    next.headId = nextHeadId;
    next.updatedAt = createdAt;
    next.lastMessageAt = createdAt;
    next.lastAssistantUpdateAt = normalizedRole === 'user' ? next.lastAssistantUpdateAt : createdAt;
    next.messageCount = nextBranch.length;
    next.userMessageCount = nextBranch.filter((entry) => entry.role === 'user').length;
    next.hasUnread = normalizedRole === 'user' ? next.hasUnread : true;
    api.conversations.upsert(next);
    return next;
  };

  api.conversations.markUnread = (conversationId: string, unread: boolean) => {
    requirePermission('conversations:write');
    const conversation = api.conversations.get(conversationId);
    if (!conversation) return;
    api.conversations.upsert({
      ...conversation,
      hasUnread: unread,
      updatedAt: new Date().toISOString(),
    });
  };

  return api;
}

/** Cleanup HTTP server when plugin is deactivated */
export async function cleanupPluginAPI(api: PluginAPI): Promise<void> {
  try {
    await api.http.close();
  } catch {
    // Ignore cleanup errors
  }
}

/** Test-only exposure of pure helpers. */
export const __internal = { isLoopbackHost };
