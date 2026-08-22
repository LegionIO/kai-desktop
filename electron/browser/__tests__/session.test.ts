import vm from 'node:vm';
// @ts-expect-error jsdom is installed for browser-preload tests without its optional declaration package.
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
  BROWSER_NATIVE_UI_GUARD_ARGUMENT,
  BROWSER_NATIVE_UI_GUARD_TOKEN_ARGUMENT_PREFIX,
  BROWSER_PRIVATE_NETWORK_GUARD_ARGUMENT,
  aiRequestPolicyUrl,
  assertAiNavigationAllowed,
  browserPartition,
  browserFocusTargetScript,
  browserScopeKey,
  browserWebPreferences,
  configureBrowserSession,
  configureBrowserWebContents,
  getChromeUserAgent,
  hardenRemoteWebPreferences,
  isInAppBrowserPartition,
  isInAppBrowserPartitionName,
  isPrivateNetworkUrl,
  normalizeOmniboxInput,
  registerBrowserFramePreload,
  resolveBrowserDataScopeKeys,
  scaleBrowserBoundsForZoom,
  scaleBrowserPointForZoom,
  shouldApplyAiRequestPolicy,
  validateBrowserBounds,
  validatePluginPartitionClearNames,
} from '../session.js';

describe('browser session helpers', () => {
  it('uses one stable global profile and hashed conversation profiles', () => {
    expect(browserScopeKey('global')).toBe('global');
    const first = browserScopeKey('conversation', 'chat-secret-id');
    expect(first).toMatch(/^conversation-[a-f0-9]{24}$/);
    expect(first).toBe(browserScopeKey('conversation', 'chat-secret-id'));
    expect(first).not.toContain('chat-secret-id');
    expect(browserPartition('global')).toBe('persist:kai-browser-global');
    expect(isInAppBrowserPartitionName('kai-browser-global')).toBe(true);
    expect(isInAppBrowserPartitionName('kai-browser-conversation-aaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
    expect(isInAppBrowserPartitionName('plugin-browser-global')).toBe(false);
    expect(isInAppBrowserPartitionName('kai-browser-../global')).toBe(false);
    expect(isInAppBrowserPartition('persist:kai-browser-global')).toBe(true);
    expect(isInAppBrowserPartition('PERSIST:KAI-BROWSER-GLOBAL')).toBe(true);
    expect(isInAppBrowserPartitionName('KAI-BROWSER-CONVERSATION-AAAAAAAAAAAAAAAAAAAAAAAA')).toBe(true);
    expect(isInAppBrowserPartition('kai-browser-global')).toBe(true);
    expect(isInAppBrowserPartition('persist:kai-plugin-browser')).toBe(false);
  });

  it('builds a Chrome UA without Electron or Kai tokens', () => {
    const ua = getChromeUserAgent('140.0.1.2');
    expect(ua).toContain('Chrome/140.0.1.2');
    expect(ua).toContain('Safari/537.36');
    expect(ua).not.toMatch(/Electron|Kai/i);
  });

  it('forces WebRTC off direct UDP while AI private-network access is disabled', () => {
    const setUserAgent = vi.fn();
    const setWebRTCIPHandlingPolicy = vi.fn();
    const sessionTarget = { setUserAgent } as never;
    const contentsTarget = { setWebRTCIPHandlingPolicy } as never;

    configureBrowserSession(sessionTarget);
    configureBrowserWebContents(contentsTarget, false);
    expect(setWebRTCIPHandlingPolicy).toHaveBeenLastCalledWith('disable_non_proxied_udp');

    configureBrowserWebContents(contentsTarget, true);
    expect(setWebRTCIPHandlingPolicy).toHaveBeenLastCalledWith('default');
    expect(setUserAgent).toHaveBeenCalledOnce();
  });

  it('keeps subframe Node integration disabled and registers an isolated frame sensor once', () => {
    const guardToken = '11111111-1111-4111-8111-111111111111';
    const preferences = browserWebPreferences('persist:kai-browser-global');
    expect(preferences).toMatchObject({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      backgroundThrottling: true,
      disableHtmlFullscreenWindowResize: true,
      additionalArguments: [],
    });
    expect(browserWebPreferences('persist:kai-browser-global', undefined, true).additionalArguments).toEqual([
      BROWSER_PRIVATE_NETWORK_GUARD_ARGUMENT,
    ]);
    expect(
      browserWebPreferences('persist:kai-browser-global', undefined, false, true, guardToken).additionalArguments,
    ).toEqual([BROWSER_NATIVE_UI_GUARD_ARGUMENT, `${BROWSER_NATIVE_UI_GUARD_TOKEN_ARGUMENT_PREFIX}${guardToken}`]);
    expect(
      browserWebPreferences('persist:kai-browser-global', undefined, true, true, guardToken).additionalArguments,
    ).toEqual([
      BROWSER_PRIVATE_NETWORK_GUARD_ARGUMENT,
      BROWSER_NATIVE_UI_GUARD_ARGUMENT,
      `${BROWSER_NATIVE_UI_GUARD_TOKEN_ARGUMENT_PREFIX}${guardToken}`,
    ]);
    expect(() =>
      browserWebPreferences('persist:kai-browser-global', undefined, false, false, 'page-controlled-token'),
    ).toThrow(/guard token/i);
    const scripts: Array<{ id: string; type: 'frame' | 'service-worker'; filePath: string }> = [];
    const target = {
      getPreloadScripts: () => scripts,
      registerPreloadScript: (script: { id?: string; type: 'frame' | 'service-worker'; filePath: string }) => {
        scripts.push({ id: script.id!, type: script.type, filePath: script.filePath });
        return script.id!;
      },
    } as never;

    registerBrowserFramePreload(target, '/tmp/browser-page.cjs');
    registerBrowserFramePreload(target, '/tmp/browser-page.cjs');

    expect(scripts).toEqual([{ id: 'kai-browser-frame-sensor', type: 'frame', filePath: '/tmp/browser-page.cjs' }]);
  });

  it('hardens inherited popup preferences against nested webviews and Node access', () => {
    const preferences: Record<string, unknown> = {
      preload: '/tmp/remote.cjs',
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      contextIsolation: false,
      sandbox: false,
      webviewTag: true,
      webSecurity: false,
    };

    hardenRemoteWebPreferences(preferences);

    expect(preferences).toMatchObject({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      disableHtmlFullscreenWindowResize: true,
    });
    expect(preferences).not.toHaveProperty('preload');
  });

  it('normalizes URLs, hosts, and search queries', () => {
    expect(normalizeOmniboxInput('example.com/docs', 'duckduckgo')).toBe('https://example.com/docs');
    expect(normalizeOmniboxInput('example.com?source=kai', 'duckduckgo')).toBe('https://example.com?source=kai');
    expect(normalizeOmniboxInput('example.com#section', 'duckduckgo')).toBe('https://example.com#section');
    expect(normalizeOmniboxInput('localhost:3000', 'google')).toBe('http://localhost:3000');
    expect(normalizeOmniboxInput('localhost:3000?debug=1', 'google')).toBe('http://localhost:3000?debug=1');
    expect(normalizeOmniboxInput('127.0.0.1#status', 'google')).toBe('http://127.0.0.1#status');
    expect(normalizeOmniboxInput('hello browser', 'google')).toBe('https://www.google.com/search?q=hello%20browser');
  });

  it('identifies private network destinations', () => {
    expect(isPrivateNetworkUrl('http://127.0.0.1')).toBe(true);
    expect(isPrivateNetworkUrl('http://localhost.:3000')).toBe(true);
    expect(isPrivateNetworkUrl('https://api.localhost')).toBe(true);
    expect(isPrivateNetworkUrl('https://api.localhost.')).toBe(true);
    expect(isPrivateNetworkUrl('http://service.local.')).toBe(true);
    expect(isPrivateNetworkUrl('https://192.168.4.2')).toBe(true);
    expect(isPrivateNetworkUrl('https://172.20.1.1')).toBe(true);
    expect(isPrivateNetworkUrl('https://100.64.0.1')).toBe(true);
    expect(isPrivateNetworkUrl('https://192.0.0.42')).toBe(true);
    expect(isPrivateNetworkUrl('https://192.0.2.42')).toBe(true);
    expect(isPrivateNetworkUrl('https://192.0.34.42')).toBe(false);
    expect(isPrivateNetworkUrl('http://[::ffff:127.0.0.1]')).toBe(true);
    expect(isPrivateNetworkUrl('http://[64:ff9b:1::7f00:1]')).toBe(true);
    expect(isPrivateNetworkUrl('http://[64:ff9b::c000:201]')).toBe(true);
    expect(isPrivateNetworkUrl('http://[fec0::1]')).toBe(true);
    expect(isPrivateNetworkUrl('http://[100::1]')).toBe(true);
    expect(isPrivateNetworkUrl('http://[2001:2::1]')).toBe(true);
    expect(isPrivateNetworkUrl('http://[2001:db8::1]')).toBe(true);
    expect(isPrivateNetworkUrl('http://[2002:c000:0201::1]')).toBe(true);
    expect(isPrivateNetworkUrl('http://[3fff::1]')).toBe(true);
    expect(isPrivateNetworkUrl('http://[5f00::1]')).toBe(true);
    expect(isPrivateNetworkUrl('http://[2001:4860:4860::8888]')).toBe(false);
    expect(isPrivateNetworkUrl('http://[2606:4700:4700::1111]')).toBe(false);
    expect(isPrivateNetworkUrl('https://example.com')).toBe(false);
  });

  it('blocks direct private targets while allowing authenticated split-DNS hostnames', async () => {
    const publicResolver = async () => ({ addresses: ['93.184.216.34'], errorCode: 0 });
    await expect(assertAiNavigationAllowed('http://localhost:3000', false, publicResolver)).rejects.toThrow(
      /private-network/,
    );
    await expect(
      assertAiNavigationAllowed('https://secure.uhc.com', false, async () => ({
        addresses: ['10.0.0.8'],
        errorCode: 0,
      })),
    ).resolves.toBeUndefined();
    await expect(
      assertAiNavigationAllowed('https://link-local.example', false, async () => ({
        addresses: ['fe80::1%en0'],
        errorCode: 0,
      })),
    ).resolves.toBeUndefined();
    await expect(assertAiNavigationAllowed('https://example.com', false, publicResolver)).resolves.toBeUndefined();
    await expect(assertAiNavigationAllowed('file:///tmp/secret', true, publicResolver)).rejects.toThrow(/HTTP\(S\)/);
  });

  it('requires authenticated TLS for hostname requests when private-network access is disabled', async () => {
    const resolver = vi.fn(async () => ({ addresses: ['93.184.216.34'], errorCode: 0 }));
    await expect(assertAiNavigationAllowed('http://example.com/path', false, resolver)).rejects.toThrow(
      /hostname-based HTTP pages/,
    );
    expect(resolver).not.toHaveBeenCalled();
    await expect(assertAiNavigationAllowed('http://93.184.216.34/path', false, resolver)).resolves.toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('fails closed when DNS resolution errors or returns no verified endpoints', async () => {
    await expect(
      assertAiNavigationAllowed('https://example.com', false, async () => ({ addresses: [], errorCode: -105 })),
    ).rejects.toThrow(/DNS resolution/);
    await expect(
      assertAiNavigationAllowed('https://example.com', false, async () => ({ addresses: [], errorCode: 0 })),
    ).rejects.toThrow(/DNS resolution/);
  });

  it('maps WebSocket handshakes through the HTTP private-network policy', () => {
    expect(aiRequestPolicyUrl('ws://127.0.0.1:8080/socket')).toBe('http://127.0.0.1:8080/socket');
    expect(aiRequestPolicyUrl('wss://example.com/socket?token=x')).toBe('https://example.com/socket?token=x');
    expect(aiRequestPolicyUrl('https://example.com/page')).toBe('https://example.com/page');
  });

  it('uses recorded profile provenance for unattributed worker traffic', () => {
    expect(shouldApplyAiRequestPolicy(true)).toBe(true);
    expect(shouldApplyAiRequestPolicy(false)).toBe(false);
    expect(shouldApplyAiRequestPolicy(undefined, true)).toBe(true);
    expect(shouldApplyAiRequestPolicy(undefined, false)).toBe(false);
  });

  it('resolves explicit and current clear-data profile targets safely', () => {
    expect(resolveBrowserDataScopeKeys({ scopeKeys: ['conversation-aaaaaaaaaaaaaaaaaaaaaaaa'] }, 'global')).toEqual([
      'conversation-aaaaaaaaaaaaaaaaaaaaaaaa',
    ]);
    expect(resolveBrowserDataScopeKeys({ conversationId: 'chat-1' }, 'global')).toEqual(['global']);
    expect(() => resolveBrowserDataScopeKeys({ scopeKeys: ['../unsafe'] })).toThrow(/Invalid browser profile/);
  });

  it('rejects reserved in-app Browser profiles from plugin partition clearing', () => {
    expect(validatePluginPartitionClearNames(['plugin-auth'])).toEqual(['plugin-auth']);
    expect(validatePluginPartitionClearNames(['plugin auth', 'plugin-认证'])).toEqual(['plugin auth', 'plugin-认证']);
    expect(() => validatePluginPartitionClearNames(['kai-browser-global'])).toThrow(/In-app Browser profiles/);
    expect(() => validatePluginPartitionClearNames(['KAI-BROWSER-GLOBAL'])).toThrow(/In-app Browser profiles/);
    expect(() => validatePluginPartitionClearNames(['persist:kai-browser-global'])).toThrow(/In-app Browser profiles/);
    expect(() => validatePluginPartitionClearNames(['../unsafe'])).toThrow(/Invalid plugin browser partition/);
  });

  it('validates and rounds sidebar bounds', () => {
    expect(scaleBrowserBoundsForZoom({ x: 20, y: 40, width: 500, height: 300 }, 1.25)).toEqual({
      x: 25,
      y: 50,
      width: 625,
      height: 375,
    });
    expect(scaleBrowserBoundsForZoom(null, 2)).toBeNull();
    expect(() => scaleBrowserBoundsForZoom({ x: 0, y: 0, width: 1, height: 1 }, 0)).toThrow(/zoom factor/);
    expect(scaleBrowserPointForZoom({ x: 120, y: 75 }, 1.5)).toEqual({ x: 180, y: 112.5 });
    expect(() => scaleBrowserPointForZoom({ x: 1, y: 1 }, Number.NaN)).toThrow(/zoom factor/);
    expect(
      validateBrowserBounds({ x: 20.3, y: 40.8, width: 500.2, height: 400.1 }, { width: 1200, height: 900 }),
    ).toEqual({
      x: 20,
      y: 41,
      width: 500,
      height: 400,
    });
    expect(() =>
      validateBrowserBounds({ x: 900, y: 0, width: 500, height: 200 }, { width: 1200, height: 900 }),
    ).toThrow(/fit inside/);
    expect(() => validateBrowserBounds({ x: 20, y: 40, width: 0, height: 200 }, { width: 1200, height: 900 })).toThrow(
      /positive width and height/,
    );
    expect(() =>
      validateBrowserBounds({ x: 20, y: 40, width: 200, height: 0.4 }, { width: 1200, height: 900 }),
    ).toThrow(/positive width and height/);
  });

  it('focuses a page target without dispatching an activating click', () => {
    const dom = new JSDOM('<button id="target"><span id="child">Focus me</span></button>', {
      runScripts: 'outside-only',
    });
    const button = dom.window.document.querySelector<HTMLButtonElement>('#target')!;
    const child = dom.window.document.querySelector<HTMLElement>('#child')!;
    let clicks = 0;
    button.addEventListener('click', () => clicks++);
    Object.defineProperty(dom.window.document, 'elementFromPoint', {
      configurable: true,
      value: () => child,
    });

    expect(vm.runInContext(browserFocusTargetScript({ x: 20, y: 30 }), dom.getInternalVMContext())).toBe(true);
    expect(dom.window.document.activeElement).toBe(button);
    expect(clicks).toBe(0);
    dom.window.close();
  });
});
