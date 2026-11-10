import { createPluginAPI } from '../electron/plugins/plugin-api.js';
import type { PluginInstance } from '../electron/plugins/types.js';

/** A real native registration API, with no network, accounts or desktop windows. */
export function nativeToolRegistrationFixture(name = 'kai-plugin-msgraph') {
  let live = true;
  const instance: PluginInstance = {
    manifest: {
      name,
      displayName: 'Fixture Microsoft Graph',
      version: '1.0.0',
      description: 'Local fixture',
      permissions: ['tools:register'],
    },
    dir: '/fixture/plugins/msgraph',
    fileHash: 'fixture',
    state: 'active',
    module: null,
    registeredTools: [],
    preSendHooks: [],
    postReceiveHooks: [],
    preUpdateHooks: [],
    postUpdateHooks: [],
    uiBanners: [],
    uiModals: [],
    uiSettingsSections: [],
    uiPanels: [],
    uiNavigationItems: [],
    uiCommands: [],
    conversationDecorations: [],
    threadDecorations: [],
    publishedState: {},
    notifications: [],
    configChangeListeners: [],
    rendererBuild: null,
    inferenceProvider: null,
    contributedCliTools: [],
    declaredEvents: [],
    declaredActions: [],
    eventUnsubscribers: [],
    agentHookUnsubscribers: [],
  };
  // tools.register uses only the activation guard and tools-changed callback.
  const api = createPluginAPI(instance, {
    isLive: () => live,
    onToolsChanged: () => {},
  } as Parameters<typeof createPluginAPI>[1]);
  return {
    api,
    instance,
    disable: () => {
      live = false;
    },
  };
}
