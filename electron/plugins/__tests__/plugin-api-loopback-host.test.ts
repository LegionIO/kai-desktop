/**
 * Tests for the loopback-host guard on a plugin's api.http.listen bind address.
 * A plugin holding the `http:listen` permission may run a LOCAL server, but must
 * not bind to a routable/wildcard interface and expose its unauthenticated
 * handler to the LAN — unless it also declares the dangerous
 * `http:listen:network` permission. isLoopbackHost / isListenHostAllowed are
 * the pure gates enforcing that.
 */
import { describe, it, expect, vi } from 'vitest';
import { __internal } from '../plugin-api.js';
import { assertPluginBrowserConfigWriteAllowed } from '../browser-config-permission.js';
import {
  beginPluginBrowserPartitionClear,
  completePluginBrowserPartitionClear,
  waitForPluginBrowserPartitionOperations,
} from '../browser-window/lifecycle.js';

const {
  isLoopbackHost,
  isListenHostAllowed,
  assertPluginPartitionAllowed,
  configureSessionCookiePromotion,
  trackPartitionedPluginAuthWindow,
  replaceInferenceProviderFailClosed,
} = __internal;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('plugin inference-provider replacement', () => {
  it('makes the previous provider unavailable before Browser revocation can throw', () => {
    const previous = { name: 'previous' } as never;
    const next = { name: 'next' } as never;
    const instance = { inferenceProvider: previous };
    const revoke = () => {
      expect(instance.inferenceProvider).toBeNull();
      throw new Error('revocation failed');
    };

    expect(() => replaceInferenceProviderFailClosed(instance, next, revoke)).toThrow('revocation failed');
    expect(instance.inferenceProvider).toBeNull();
  });

  it('installs the replacement only after revocation succeeds', () => {
    const previous = { name: 'previous' } as never;
    const next = { name: 'next' } as never;
    const instance = { inferenceProvider: previous };
    const revoke = (provider: unknown) => {
      expect(provider).toBe(previous);
      expect(instance.inferenceProvider).toBeNull();
    };

    replaceInferenceProviderFailClosed(instance, next, revoke);
    expect(instance.inferenceProvider).toBe(next);
  });
});

describe('plugin partition isolation', () => {
  it('reserves in-app Browser profiles from plugin browser and session APIs', () => {
    expect(() => assertPluginPartitionAllowed('persist:kai-browser-global')).toThrow(/reserved in-app Browser/);
    expect(() => assertPluginPartitionAllowed('persist:kai-browser-conversation-aaaaaaaaaaaaaaaaaaaaaaaa')).toThrow(
      /reserved in-app Browser/,
    );
    expect(() => assertPluginPartitionAllowed('PERSIST:KAI-BROWSER-GLOBAL')).toThrow(/reserved in-app Browser/);
    expect(() => assertPluginPartitionAllowed('persist:kai-plugin-browser')).not.toThrow();
    expect(() => assertPluginPartitionAllowed(undefined)).not.toThrow();
  });

  it('registers partition-backed auth windows with Browser Data clearing', () => {
    const listeners = new Map<string, () => void>();
    let destroyed = false;
    const window = {
      isDestroyed: () => destroyed,
      destroy: () => {
        destroyed = true;
        listeners.get('closed')?.();
      },
      once: (event: string, listener: () => void) => listeners.set(event, listener),
    };

    trackPartitionedPluginAuthWindow(window as never, 'persist:plugin-auth');
    const release = beginPluginBrowserPartitionClear(['plugin-auth']);
    try {
      expect(destroyed).toBe(true);
    } finally {
      release();
    }
  });

  it('keeps Browser Data clearing behind pending session-cookie promotion work', async () => {
    const partitionName = 'plugin-auth-promotion';
    const electronPartition = `persist:${partitionName}`;
    const callbackStarted = deferred<void>();
    const callbackResult = deferred<{ promote: boolean }>();
    const cookieSetStarted = deferred<void>();
    const cookieSetFinished = deferred<void>();
    let cookieChanged: ((...args: unknown[]) => void) | undefined;
    const setCookie = vi.fn(() => {
      cookieSetStarted.resolve();
      return cookieSetFinished.promise;
    });
    const fakeSession = {
      cookies: {
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
          expect(event).toBe('changed');
          cookieChanged = listener;
        }),
        set: setCookie,
      },
    };

    configureSessionCookiePromotion(fakeSession as never, electronPartition, (async () => {
      callbackStarted.resolve();
      return callbackResult.promise;
    }) as never);
    expect(cookieChanged).toBeTypeOf('function');

    cookieChanged?.(
      {},
      {
        domain: 'example.com',
        name: 'session',
        path: '/',
        secure: true,
        value: 'opaque-test-value',
      },
      'explicit',
      false,
    );
    await callbackStarted.promise;

    const releaseClear = beginPluginBrowserPartitionClear([partitionName]);
    try {
      let clearDrained = false;
      const drain = waitForPluginBrowserPartitionOperations([partitionName]).then(() => {
        clearDrained = true;
      });
      await Promise.resolve();
      expect(clearDrained).toBe(false);

      callbackResult.resolve({ promote: true });
      await cookieSetStarted.promise;
      await Promise.resolve();
      expect(clearDrained).toBe(false);

      cookieSetFinished.resolve();
      await drain;
      expect(clearDrained).toBe(true);
      expect(setCookie).toHaveBeenCalledTimes(1);
    } finally {
      try {
        completePluginBrowserPartitionClear(partitionName);
      } finally {
        releaseClear();
      }
    }
  });
});

describe('plugin Browser config authority', () => {
  it('requires the authenticated-session permission for Browser policy writes', () => {
    expect(() => assertPluginBrowserConfigWriteAllowed('browser', ['config:write'])).toThrow(
      /browser:authenticated-session/,
    );
    expect(() => assertPluginBrowserConfigWriteAllowed('browser.aiAllowPrivateNetwork', ['config:write'])).toThrow(
      /browser:authenticated-session/,
    );
    expect(() => assertPluginBrowserConfigWriteAllowed('.browser.aiAllowPrivateNetwork', ['config:write'])).toThrow(
      /browser:authenticated-session/,
    );
    expect(() => assertPluginBrowserConfigWriteAllowed('..browser..passwordAccess', ['config:write'])).toThrow(
      /browser:authenticated-session/,
    );
    expect(() =>
      assertPluginBrowserConfigWriteAllowed('browser.passwordAccess', [
        'config:write',
        'browser:authenticated-session',
      ]),
    ).not.toThrow();
    expect(() => assertPluginBrowserConfigWriteAllowed('ui.theme', ['config:write'])).not.toThrow();
  });
});

describe('isLoopbackHost — plugin http.listen bind guard', () => {
  it('accepts the canonical loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
  });

  it('accepts any 127.0.0.0/8 address', () => {
    expect(isLoopbackHost('127.0.0.2')).toBe(true);
    expect(isLoopbackHost('127.255.255.254')).toBe(true);
  });

  it('accepts bracketed / zoned IPv6 loopback', () => {
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('::1%lo0')).toBe(true);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(isLoopbackHost('  LOCALHOST ')).toBe(true);
    expect(isLoopbackHost('LocalHost')).toBe(true);
  });

  it('rejects wildcard binds', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
    expect(isLoopbackHost('[::]')).toBe(false);
  });

  it('rejects LAN / routable addresses', () => {
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
    expect(isLoopbackHost('169.254.169.254')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
  });

  it('rejects addresses that merely start with 127 but are not 127.0.0.0/8', () => {
    expect(isLoopbackHost('1270.0.0.1')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false);
  });
});

describe('isListenHostAllowed — permission-gated escape hatch', () => {
  it('always allows loopback hosts, with or without the network permission', () => {
    expect(isListenHostAllowed('127.0.0.1', [])).toBe(true);
    expect(isListenHostAllowed('localhost', ['http:listen'])).toBe(true);
    expect(isListenHostAllowed('127.0.0.1', ['http:listen', 'http:listen:network'])).toBe(true);
  });

  it('rejects a wildcard/LAN bind when the plugin lacks http:listen:network', () => {
    expect(isListenHostAllowed('0.0.0.0', ['http:listen'])).toBe(false);
    expect(isListenHostAllowed('192.168.1.10', [])).toBe(false);
  });

  it('allows a wildcard/LAN bind only when the plugin declares http:listen:network', () => {
    expect(isListenHostAllowed('0.0.0.0', ['http:listen', 'http:listen:network'])).toBe(true);
    expect(isListenHostAllowed('192.168.1.10', ['http:listen:network'])).toBe(true);
    expect(isListenHostAllowed('::', ['http:listen:network'])).toBe(true);
  });
});
