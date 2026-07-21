import type { ZodType } from 'zod';
import type {
  AllowedBinary,
  PluginAPI,
  PluginAgentGenerateOptions,
  PluginAgentStreamEvent,
  PluginInferenceProvider,
  PluginManifest,
} from '../types.js';
import type { ToolDefinition } from '../../tools/types.js';
import type { UtilityTransport } from './utility-transport.js';
import { zodSchemaToJsonSchema } from './wire.js';
import { isAmbiguousPluginCallError } from './utility-transport.js';

function applyNestedWrite(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0 || parts.some((part) => ['__proto__', 'constructor', 'prototype'].includes(part))) return;
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const next = current[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(value);
  } catch {
    return { ...value };
  }
}

export type UtilityConfigMirror = {
  config: Record<string, unknown>;
  pluginData: Record<string, unknown>;
};

export function createUtilityConfigMirror(
  config: Record<string, unknown> = {},
  pluginData: Record<string, unknown> = {},
): UtilityConfigMirror {
  return { config: cloneRecord(config), pluginData: cloneRecord(pluginData) };
}

function toolForWire(tool: ToolDefinition): Record<string, unknown> {
  let inputSchema: unknown = tool.inputSchema;
  const originalExecute = tool.execute;
  let execute = originalExecute;
  if (
    inputSchema &&
    typeof inputSchema === 'object' &&
    typeof (inputSchema as { safeParse?: unknown }).safeParse === 'function'
  ) {
    const pluginSchema = inputSchema as ZodType;
    try {
      inputSchema = zodSchemaToJsonSchema(pluginSchema);
    } catch (error) {
      throw new Error(`Could not serialize input schema for plugin tool "${tool.name}"`, { cause: error });
    }
    // JSON Schema carries the model-facing shape across the process boundary,
    // but it cannot represent every Zod refinement/default/transform. Re-run
    // the original schema in the utility process before the plugin body so its
    // existing runtime validation semantics are not weakened by transport.
    execute = async (input, context) => {
      const parsed = await pluginSchema.safeParseAsync(input);
      if (!parsed.success) throw parsed.error;
      return originalExecute(parsed.data, context);
    };
  }
  return {
    ...tool,
    inputSchema,
    execute,
  };
}

function fetchUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  throw new TypeError('Plugin fetch input must be a string, URL, or Request');
}

export function createUtilityPluginAPI(options: {
  manifest: PluginManifest;
  pluginDir: string;
  apiVersion: string;
  capabilities: string[];
  transport: UtilityTransport;
  configMirror?: UtilityConfigMirror;
  fetchImpl?: typeof globalThis.fetch;
}): PluginAPI {
  const { manifest, pluginDir, apiVersion, capabilities, transport } = options;
  const configMirror = options.configMirror ?? createUtilityConfigMirror();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let state: Record<string, unknown> = {};

  const checkPermission = (permission: PluginManifest['permissions'][number]): void => {
    if (!manifest.permissions.includes(permission)) {
      throw new Error(
        `Plugin "${manifest.name}" requires permission "${permission}" for this action. Declared: ${manifest.permissions.join(', ') || 'none'}`,
      );
    }
  };

  const checkAnyPermission = (permissions: PluginManifest['permissions'][number][]): void => {
    if (!permissions.some((permission) => manifest.permissions.includes(permission))) {
      throw new Error(`Plugin "${manifest.name}" requires one of [${permissions.join(', ')}] for this action.`);
    }
  };

  const sync = <T>(method: string, args: unknown[] = []): T => transport.syncCall(method, args) as T;
  const asyncCall = <T>(method: string, args: unknown[] = []): Promise<T> =>
    transport.asyncCall(method, args) as Promise<T>;

  const api: PluginAPI = {
    pluginName: manifest.name,
    pluginDir,

    host: {
      apiVersion: () => apiVersion,
      capabilities: () => [...capabilities],
      hasCapability: (capability) => capabilities.includes(capability),
    },

    config: {
      get: () => {
        checkPermission('config:read');
        return cloneRecord(configMirror.config) as ReturnType<PluginAPI['config']['get']>;
      },
      set: (path, value) => {
        checkPermission('config:write');
        const next = cloneRecord(configMirror.config);
        applyNestedWrite(next, path, value);
        configMirror.config = next;
        transport.orderedCall('config.set', [path, value]);
      },
      getPluginData: () => {
        checkPermission('config:read');
        return cloneRecord(configMirror.pluginData);
      },
      setPluginData: (path, value) => {
        checkPermission('config:write');
        const next = cloneRecord(configMirror.pluginData);
        applyNestedWrite(next, path, value);
        configMirror.pluginData = next;
        transport.orderedCall('config.setPluginData', [path, value]);
      },
      onChanged: (callback) => {
        checkPermission('config:read');
        return transport.registerDisposable('config.onChanged', [callback]);
      },
    },

    state: {
      get: () => cloneRecord(state),
      replace: (next) => {
        checkPermission('state:publish');
        state = cloneRecord(next);
        transport.orderedCall('state.replace', [state]);
      },
      set: (path, value) => {
        checkPermission('state:publish');
        const next = cloneRecord(state);
        applyNestedWrite(next, path, value);
        state = next;
        transport.orderedCall('state.set', [path, value]);
      },
      emitEvent: (eventName, data) => {
        checkAnyPermission(['state:publish', 'events:publish']);
        transport.orderedCall('state.emitEvent', [eventName, data]);
      },
    },

    events: {
      declare: (declaration) => {
        checkPermission('events:publish');
        transport.orderedCall('events.declare', [declaration]);
      },
      emit: (event, payload) => {
        checkAnyPermission(['events:publish', 'state:publish']);
        transport.orderedCall('events.emit', [event, payload]);
      },
      on: (key, handler) => {
        checkPermission('events:subscribe');
        return transport.registerDisposable('events.on', [key, handler]);
      },
    },

    tools: {
      register: (tools) => {
        checkPermission('tools:register');
        transport.orderedCall('tools.register', [tools.map(toolForWire)]);
      },
      unregister: (toolNames) => {
        checkPermission('tools:register');
        transport.orderedCall('tools.unregister', [toolNames]);
      },
    },

    messages: {
      registerPreSendHook: (hook) => {
        checkPermission('messages:hook');
        transport.orderedCall('messages.registerPreSendHook', [hook]);
      },
      registerPostReceiveHook: (hook) => {
        checkPermission('messages:hook');
        transport.orderedCall('messages.registerPostReceiveHook', [hook]);
      },
    },

    lifecycle: {
      registerPreUpdateHook: (hook) => {
        checkPermission('lifecycle:hook');
        transport.orderedCall('lifecycle.registerPreUpdateHook', [hook]);
      },
      registerPostUpdateHook: (hook) => {
        checkPermission('lifecycle:hook');
        transport.orderedCall('lifecycle.registerPostUpdateHook', [hook]);
      },
    },

    hooks: {
      register: (event, handler, registrationOptions) => {
        checkPermission('agent:hook');
        return transport.registerDisposable('hooks.register', [event, handler, registrationOptions]);
      },
    },

    ui: {
      showBanner: (descriptor) => {
        checkPermission('ui:banner');
        transport.orderedCall('ui.showBanner', [descriptor]);
      },
      hideBanner: (id) => {
        checkPermission('ui:banner');
        transport.orderedCall('ui.hideBanner', [id]);
      },
      showModal: (descriptor) => {
        checkPermission('ui:modal');
        transport.orderedCall('ui.showModal', [descriptor]);
      },
      hideModal: (id) => {
        checkPermission('ui:modal');
        transport.orderedCall('ui.hideModal', [id]);
      },
      updateModal: (id, updates) => {
        checkPermission('ui:modal');
        transport.orderedCall('ui.updateModal', [id, updates]);
      },
      registerSettingsView: (descriptor) => {
        checkPermission('ui:settings');
        transport.orderedCall('ui.registerSettingsView', [descriptor]);
      },
      registerPanelView: (descriptor) => {
        checkPermission('ui:panel');
        transport.orderedCall('ui.registerPanelView', [descriptor]);
      },
      registerNavigationItem: (descriptor) => {
        checkPermission('ui:navigation');
        transport.orderedCall('ui.registerNavigationItem', [descriptor]);
      },
      registerCommand: (descriptor) => {
        checkPermission('ui:navigation');
        transport.orderedCall('ui.registerCommand', [descriptor]);
      },
      showConversationDecoration: (descriptor) => {
        checkPermission('ui:navigation');
        transport.orderedCall('ui.showConversationDecoration', [descriptor]);
      },
      hideConversationDecoration: (id) => {
        checkPermission('ui:navigation');
        transport.orderedCall('ui.hideConversationDecoration', [id]);
      },
      showThreadDecoration: (descriptor) => {
        checkPermission('ui:navigation');
        transport.orderedCall('ui.showThreadDecoration', [descriptor]);
      },
      hideThreadDecoration: (id) => {
        checkPermission('ui:navigation');
        transport.orderedCall('ui.hideThreadDecoration', [id]);
      },
    },

    notifications: {
      show: (descriptor) => {
        checkPermission('notifications:send');
        transport.orderedCall('notifications.show', [descriptor]);
      },
      dismiss: (id) => {
        checkPermission('notifications:send');
        transport.orderedCall('notifications.dismiss', [id]);
      },
    },

    navigation: {
      open: (target) => {
        checkPermission('navigation:open');
        transport.orderedCall('navigation.open', [target]);
      },
    },

    conversations: {
      list: () => {
        checkPermission('conversations:read');
        return sync('conversations.list');
      },
      get: (conversationId) => {
        checkPermission('conversations:read');
        return sync('conversations.get', [conversationId]);
      },
      upsert: (conversation) => {
        checkPermission('conversations:write');
        transport.orderedCall('conversations.upsert', [conversation]);
      },
      setActive: (conversationId) => {
        checkPermission('conversations:write');
        transport.orderedCall('conversations.setActive', [conversationId]);
      },
      getActiveId: () => {
        checkPermission('conversations:read');
        return sync('conversations.getActiveId');
      },
      appendMessage: (conversationId, message) => {
        checkPermission('conversations:write');
        return sync('conversations.appendMessage', [conversationId, message]);
      },
      markUnread: (conversationId, unread) => {
        checkPermission('conversations:write');
        transport.orderedCall('conversations.markUnread', [conversationId, unread]);
      },
    },

    log: {
      info: (...args) => console.info(...args),
      warn: (...args) => console.warn(...args),
      error: (...args) => console.error(...args),
    },

    shell: {
      openExternal: (url) => {
        checkPermission('navigation:open');
        return asyncCall('shell.openExternal', [url]);
      },
    },

    auth: {
      openAuthWindow: (authOptions) => {
        checkPermission('auth:window');
        return asyncCall('auth.openAuthWindow', [authOptions]);
      },
    },

    safeStorage: {
      isEncryptionAvailable: () => {
        checkPermission('safe-storage');
        return sync('safeStorage.isEncryptionAvailable');
      },
      encryptString: (plaintext) => {
        checkPermission('safe-storage');
        return sync('safeStorage.encryptString', [plaintext]);
      },
      decryptString: (base64Cipher) => {
        checkPermission('safe-storage');
        return sync('safeStorage.decryptString', [base64Cipher]);
      },
    },

    browser: {
      open: (browserOptions) => {
        checkPermission('browser:window');
        transport.orderedCall('browser.open', [browserOptions]);
      },
    },

    session: {
      clearCookies: (partition, filter) => {
        checkPermission('auth:window');
        return asyncCall('session.clearCookies', [partition, filter]);
      },
    },

    http: {
      listen: (port, handler, listenOptions) => {
        checkPermission('http:listen');
        return asyncCall('http.listen', [port, handler, listenOptions]);
      },
      close: () => asyncCall('http.close'),
    },

    agent: {
      generate: (generateOptions: PluginAgentGenerateOptions) => {
        checkPermission('agent:generate');
        return asyncCall('agent.generate', [generateOptions]);
      },
      stream: async function* (generateOptions: PluginAgentGenerateOptions): AsyncGenerator<PluginAgentStreamEvent> {
        checkPermission('agent:generate');
        for await (const event of transport.streamCall('agent.stream', [generateOptions])) {
          yield event as PluginAgentStreamEvent;
        }
      },
      registerInferenceProvider: (provider: PluginInferenceProvider) => {
        checkPermission('agent:inference-provider');
        if (!provider || typeof provider.isAvailable !== 'function' || typeof provider.stream !== 'function') {
          throw new Error('Invalid inference provider: must have name, isAvailable(), and stream().');
        }
        const isAvailableId = transport.registerFunction(provider.isAvailable.bind(provider));
        const streamId = transport.registerFunction(
          provider.stream.bind(provider) as unknown as (...args: unknown[]) => unknown,
        );
        // Evaluate availability BEFORE the handoff. If isAvailable() makes a
        // plugin call that fails/times out, the host never received these ids —
        // free the orphans and rethrow (any prior provider stays intact).
        let available: boolean;
        try {
          available = Boolean(provider.isAvailable());
        } catch (error) {
          transport.releaseFunction(isAvailableId);
          transport.releaseFunction(streamId);
          throw error;
        }
        try {
          sync('agent.registerInferenceProvider', [{ name: provider.name, available, isAvailableId, streamId }]);
        } catch (error) {
          // On any AMBIGUOUS failure (timeout, or a worker-level broker error
          // like a disconnect/oversized-response) the host MAY have accepted the
          // registration and built a provider around these ids — freeing them
          // could break a delayed stream()/isAvailable() call. So DON'T: the host
          // owns their lifetime and GC-releases them when its provider object is
          // collected (a truly-orphaned pair is reclaimed by the drain-barrier
          // reconcile). Only on a CONFIRMED rejection did the host never take
          // them → free them here. These ids bypass per-request bookkeeping (they
          // travel as raw strings), so this is their only utility-side guard.
          if (!isAmbiguousPluginCallError(error)) {
            transport.releaseFunction(isAvailableId);
            transport.releaseFunction(streamId);
          }
          throw error;
        }
        // Success: the host now owns these callbacks and is SOLELY responsible
        // for releasing them (via `release-callback`) once its provider object —
        // including any in-flight agent turn that captured it — is GC'd. The
        // utility deliberately does NOT release inference-provider ids on
        // re-register/unregister: only the host knows when no in-flight user
        // remains, so utility-side release would race a delayed stream() call.
      },
      unregisterInferenceProvider: () => {
        checkPermission('agent:inference-provider');
        // Do NOT release the callback ids here — the host's provider object may
        // still be captured by an in-flight agent turn. The host releases them
        // via `release-callback` when that object is collected.
        transport.orderedCall('agent.unregisterInferenceProvider');
      },
      registerCliTool: (tool) => {
        checkPermission('agent:register-cli-tool');
        transport.orderedCall('agent.registerCliTool', [tool]);
      },
    },

    onAction: (targetId, handler) => {
      transport.orderedCall('onAction', [targetId, handler]);
    },

    fetch: (async (...args: Parameters<typeof globalThis.fetch>) => {
      checkPermission('network:fetch');
      const url = fetchUrl(args[0]);
      let protocol: string;
      try {
        protocol = new URL(url).protocol;
      } catch {
        throw new TypeError(`Plugin "${manifest.name}" fetch: invalid URL: ${url}`);
      }
      if (protocol !== 'http:' && protocol !== 'https:') {
        throw new TypeError(`Plugin "${manifest.name}" fetch is restricted to http(s); refusing "${protocol}" URL.`);
      }
      // Forward the same canonical URL that was validated. A Request is safe to
      // retain because its URL is immutable and its remaining semantics (body,
      // headers, signal) must be preserved by the selected runtime adapter.
      const input = args[0] instanceof Request ? args[0] : url;
      return fetchImpl(input, args[1]);
    }) as typeof globalThis.fetch,

    exec: {
      run: (request) => {
        checkPermission('exec:whitelisted');
        return asyncCall('exec.run', [request]);
      },
      which: (binary: AllowedBinary) => {
        checkPermission('exec:whitelisted');
        return asyncCall('exec.which', [binary]);
      },
    },

    detect: {
      claudeCode: () => {
        checkPermission('tools:detect');
        return asyncCall('detect.claudeCode');
      },
      codex: () => {
        checkPermission('tools:detect');
        return asyncCall('detect.codex');
      },
      python: () => {
        checkPermission('tools:detect');
        return asyncCall('detect.python');
      },
      node: () => {
        checkPermission('tools:detect');
        return asyncCall('detect.node');
      },
      git: () => {
        checkPermission('tools:detect');
        return asyncCall('detect.git');
      },
      pip: () => {
        checkPermission('tools:detect');
        return asyncCall('detect.pip');
      },
      binary: (name) => {
        checkPermission('tools:detect');
        return asyncCall('detect.binary', [name]);
      },
      claudePlugin: (pluginName) => {
        checkPermission('tools:detect');
        return asyncCall('detect.claudePlugin', [pluginName]);
      },
      codexSkill: (skillId) => {
        checkPermission('tools:detect');
        return asyncCall('detect.codexSkill', [skillId]);
      },
      all: () => {
        checkPermission('tools:detect');
        return asyncCall('detect.all');
      },
    },

    env: {
      home: () => {
        checkPermission('system:env');
        return sync('env.home');
      },
      platform: () => {
        checkPermission('system:env');
        return sync('env.platform');
      },
      get: (name) => {
        checkPermission('system:env');
        return sync('env.get', [name]);
      },
      paths: () => {
        checkPermission('system:env');
        return sync('env.paths');
      },
    },
  };

  return api;
}
