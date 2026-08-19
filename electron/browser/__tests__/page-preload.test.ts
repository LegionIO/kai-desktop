import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
// @ts-expect-error jsdom is installed for Vitest's DOM environment without its optional declaration package.
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_PRIVATE_NETWORK_NEW_DOCUMENT_GUARD } from '../evaluation.js';
import { BROWSER_PRIVATE_NETWORK_GUARD_ARGUMENT } from '../session.js';

const sourcePath = resolve(process.cwd(), 'electron/browser/page-preload.cjs');
const source = readFileSync(sourcePath, 'utf8');
const viteConfigSource = readFileSync(resolve(process.cwd(), 'electron.vite.config.ts'), 'utf8');
type TestWindow = Window & typeof globalThis;
type PreloadHarness = {
  armAutomationInput: (payload: Record<string, unknown>) => void;
  armElementPicker: (payload: Record<string, unknown>) => void;
  selectElementPickerPoint: (payload: Record<string, unknown>) => void;
  disarmElementPicker: (payload: Record<string, unknown>) => void;
  executeInMainWorld: ReturnType<typeof vi.fn>;
  sendSync: ReturnType<typeof vi.fn>;
};

async function runPreload(
  setup: (document: Document) => void,
  exercise?: (window: TestWindow, send: ReturnType<typeof vi.fn>, harness: PreloadHarness) => void | Promise<void>,
  argv: string[] = [],
): Promise<ReturnType<typeof vi.fn>> {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.com/login',
    runScripts: 'outside-only',
  });
  const send = vi.fn();
  const sendSync = vi.fn(() => true);
  const executeInMainWorld = vi.fn((script: { func: (...args: unknown[]) => unknown; args?: unknown[] }) =>
    script.func(...(script.args ?? [])),
  );
  const listeners = new Map<string, (event: unknown, payload: Record<string, unknown>) => void>();
  const context = dom.getInternalVMContext() as vm.Context & {
    process?: { argv: string[] };
    require?: (id: string) => unknown;
  };
  context.process = { argv };
  context.require = (id: string) => {
    if (id !== 'electron') throw new Error(`Unexpected preload require: ${id}`);
    return {
      contextBridge: { executeInMainWorld },
      ipcRenderer: {
        on: (channel: string, listener: (event: unknown, payload: Record<string, unknown>) => void) => {
          listeners.set(channel, listener);
        },
        send,
        sendSync,
      },
    };
  };
  setup(dom.window.document);
  vm.runInContext(source, context, { filename: sourcePath });
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  await exercise?.(dom.window as unknown as TestWindow, send, {
    armAutomationInput: (payload) => listeners.get('browser-page:arm-automation-input')?.({}, payload),
    armElementPicker: (payload) => listeners.get('browser-page:element-picker-arm')?.({}, payload),
    selectElementPickerPoint: (payload) => listeners.get('browser-page:element-picker-select-at')?.({}, payload),
    disarmElementPicker: (payload) => listeners.get('browser-page:element-picker-disarm')?.({}, payload),
    executeInMainWorld,
    sendSync,
  });
  dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide'));
  dom.window.close();
  return send;
}

describe('sandboxed browser page preload', () => {
  it('is registered as a watched preload-build dependency', () => {
    expect(viteConfigSource).toMatch(/buildStart\(\)\s*{\s*this\.addWatchFile\(sandboxedBrowserPreloadPath\);\s*}/);
    expect(viteConfigSource).toContain('source: readFileSync(sandboxedBrowserPreloadPath)');
  });

  it('is CommonJS and contains no ESM import declaration', () => {
    expect(source).toMatch(/require\(['"]electron['"]\)/);
    expect(source).not.toMatch(/^\s*import\s/m);
  });

  it('installs the closed-shadow sentinel in the page main world', async () => {
    await runPreload(
      () => undefined,
      (_window, _send, harness) => {
        expect(harness.executeInMainWorld).toHaveBeenCalledTimes(2);
        expect(harness.executeInMainWorld).toHaveBeenCalledWith(
          expect.objectContaining({ func: expect.any(Function), args: ['kai-browser-closed-shadow-created'] }),
        );
      },
    );
  });

  it('blocks constructors cached before the AI private-network guard activates', async () => {
    await runPreload(
      (document) => {
        class NativePeerConnection {
          closed = false;

          close(): void {
            this.closed = true;
          }
        }
        Object.defineProperty(document.defaultView, 'RTCPeerConnection', {
          configurable: true,
          writable: true,
          value: NativePeerConnection,
        });
      },
      (window) => {
        const guardedWindow = window as unknown as {
          RTCPeerConnection: new () => { closed: boolean };
          eval: (source: string) => unknown;
        };
        const CachedConstructor = guardedWindow.RTCPeerConnection;
        const CachedPrototypeConstructor = CachedConstructor.prototype.constructor as typeof CachedConstructor;
        const existingConnection = new CachedConstructor();
        expect(existingConnection.closed).toBe(false);

        guardedWindow.eval(BROWSER_PRIVATE_NETWORK_NEW_DOCUMENT_GUARD);

        expect(existingConnection.closed).toBe(true);
        expect(() => new CachedConstructor()).toThrow(/WebRTC is blocked/);
        expect(() => new CachedPrototypeConstructor()).toThrow(/WebRTC is blocked/);
        expect(() => new guardedWindow.RTCPeerConnection()).toThrow(/WebRTC is blocked/);
      },
    );
  });

  it('blocks WebRTC before the first page script in a restricted renderer', async () => {
    await runPreload(
      (document) => {
        class NativePeerConnection {}
        Object.defineProperty(document.defaultView, 'RTCPeerConnection', {
          configurable: true,
          writable: true,
          value: NativePeerConnection,
        });
      },
      (window) => {
        const guardedWindow = window as unknown as {
          RTCPeerConnection: new () => unknown;
        };
        expect(() => new guardedWindow.RTCPeerConnection()).toThrow(/WebRTC is blocked/);
      },
      [BROWSER_PRIVATE_NETWORK_GUARD_ARGUMENT],
    );
  });

  it('caps retained late-shadow-root candidates on hostile large pages', () => {
    expect(source).toMatch(/MAX_SHADOW_DISCOVERY_CANDIDATES\s*=\s*2_048/);
    expect(source).toMatch(/shadowCandidates\.size\s*>=\s*MAX_SHADOW_DISCOVERY_CANDIDATES/);
    expect(source).toMatch(/shadowCandidates\.keys\(\)\.next\(\)\.value/);
  });

  it('uses a bounded iterative DOM walk instead of an unbounded universal selector', async () => {
    expect(source).toMatch(/MAX_DOM_DISCOVERY_NODES\s*=\s*4_096/);
    expect(source).not.toContain("node.querySelectorAll('*')");
    let universalScan!: ReturnType<typeof vi.spyOn>;
    await runPreload(
      (document) => {
        for (let index = 0; index < 5_000; index += 1) document.body.append(document.createElement('span'));
        universalScan = vi.spyOn(document.documentElement, 'querySelectorAll');
      },
      () => {
        expect(universalScan).not.toHaveBeenCalled();
      },
    );
  });

  it('continues bounded discovery slices past the initial node budget', async () => {
    const send = await runPreload((document) => {
      for (let index = 0; index < 5_000; index += 1) document.body.append(document.createElement('span'));
      const password = document.createElement('input');
      password.type = 'password';
      password.value = 'must-be-detected-after-the-first-slice';
      document.body.append(password);
    });

    expect(send).toHaveBeenCalledWith('browser-page:sensitive', true);
  });

  it('captures a trusted picker click before page handlers and resolves the selector only after main confirms it', async () => {
    let clickListener!: (event: Record<string, unknown>) => void;
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const stopImmediatePropagation = vi.fn();
    await runPreload(
      (document) => {
        const button = document.createElement('button');
        button.id = 'pick-me';
        document.body.append(button);
        Object.defineProperty(document.defaultView, 'CSS', {
          configurable: true,
          value: { escape: (value: string) => value },
        });
        Object.defineProperty(document, 'elementFromPoint', {
          configurable: true,
          value: () => button,
        });
        const view = document.defaultView!;
        const addEventListener = view.addEventListener.bind(view);
        view.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
          if (type === 'click') clickListener = listener as unknown as typeof clickListener;
          addEventListener(type, listener, options);
        }) as typeof view.addEventListener;
      },
      (window, send, { armElementPicker, selectElementPickerPoint }) => {
        armElementPicker({ token: 'picker-token', timeoutMs: 5_000 });
        clickListener({
          type: 'click',
          isTrusted: true,
          clientX: 25,
          clientY: 35,
          target: window.document.querySelector('button'),
          preventDefault,
          stopPropagation,
          stopImmediatePropagation,
        });

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(stopPropagation).toHaveBeenCalledOnce();
        expect(stopImmediatePropagation).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledWith('browser-page:element-picker-click', {
          token: 'picker-token',
          x: 25,
          y: 35,
        });
        expect(send).not.toHaveBeenCalledWith('browser-page:element-picker-result', expect.anything());

        selectElementPickerPoint({ token: 'picker-token' });
        expect(send).toHaveBeenCalledWith('browser-page:element-picker-result', {
          token: 'picker-token',
          selector: '#pick-me',
        });
      },
    );
  });

  it('builds a bounded structural selector without escaping a hostile oversized id', async () => {
    let clickListener!: (event: Record<string, unknown>) => void;
    const escape = vi.fn((value: string) => value);
    await runPreload(
      (document) => {
        const button = document.createElement('button');
        button.id = 'x'.repeat(32 * 1_024);
        document.body.append(button);
        Object.defineProperty(document.defaultView, 'CSS', {
          configurable: true,
          value: { escape },
        });
        Object.defineProperty(document, 'elementFromPoint', {
          configurable: true,
          value: () => button,
        });
        const view = document.defaultView!;
        const addEventListener = view.addEventListener.bind(view);
        view.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
          if (type === 'click') clickListener = listener as unknown as typeof clickListener;
          addEventListener(type, listener, options);
        }) as typeof view.addEventListener;
      },
      (window, send, { armElementPicker, selectElementPickerPoint }) => {
        armElementPicker({ token: 'bounded-picker', timeoutMs: 5_000 });
        clickListener({
          type: 'click',
          isTrusted: true,
          clientX: 1,
          clientY: 2,
          target: window.document.querySelector('button'),
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
          stopImmediatePropagation: vi.fn(),
        });
        selectElementPickerPoint({ token: 'bounded-picker' });

        expect(escape).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith('browser-page:element-picker-result', {
          token: 'bounded-picker',
          selector: 'button',
        });
      },
    );
  });

  it('suppresses Escape and disarms a picker without exposing a selector', async () => {
    let keydownListener!: (event: Record<string, unknown>) => void;
    await runPreload(
      (document) => {
        const view = document.defaultView!;
        const addEventListener = view.addEventListener.bind(view);
        view.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
          if (type === 'keydown') keydownListener = listener as unknown as typeof keydownListener;
          addEventListener(type, listener, options);
        }) as typeof view.addEventListener;
      },
      (_window, send, { armElementPicker }) => {
        const preventDefault = vi.fn();
        const stopImmediatePropagation = vi.fn();
        armElementPicker({ token: 'cancel-picker', timeoutMs: 5_000 });
        keydownListener({
          type: 'keydown',
          key: 'Escape',
          isTrusted: true,
          preventDefault,
          stopPropagation: vi.fn(),
          stopImmediatePropagation,
        });

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(stopImmediatePropagation).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledWith('browser-page:element-picker-cancel', {
          token: 'cancel-picker',
          reason: 'cancelled',
        });
      },
    );
  });

  it('reports exact assistant input tokens synchronously while preserving concurrent user gestures', async () => {
    let pointerListener!: (event: Record<string, unknown>) => void;
    await runPreload(
      (document) => {
        const addEventListener = document.addEventListener.bind(document);
        document.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
          if (type === 'pointerdown') pointerListener = listener as unknown as typeof pointerListener;
          addEventListener(type, listener, options);
        }) as typeof document.addEventListener;
      },
      (window, _send, { armAutomationInput, sendSync }) => {
        armAutomationInput({
          token: 'assistant-token',
          kind: 'pointerdown',
          expiresAt: window.Date.now() + 1_000,
          x: 10,
          y: 20,
        });
        pointerListener({
          type: 'pointerdown',
          isTrusted: true,
          clientX: 50,
          clientY: 60,
          composedPath: () => [],
        });
        pointerListener({
          type: 'pointerdown',
          isTrusted: true,
          clientX: 10,
          clientY: 20,
          composedPath: () => [],
        });

        expect(sendSync).toHaveBeenNthCalledWith(1, 'browser-page:gesture', { kind: 'pointerdown' });
        expect(sendSync).toHaveBeenNthCalledWith(2, 'browser-page:gesture', {
          token: 'assistant-token',
          kind: 'pointerdown',
        });
      },
    );
  });

  it('matches assistant pointer input across child-frame coordinate spaces', async () => {
    let pointerListener!: (event: Record<string, unknown>) => void;
    await runPreload(
      (document) => {
        const addEventListener = document.addEventListener.bind(document);
        document.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
          if (type === 'pointerdown') pointerListener = listener as unknown as typeof pointerListener;
          addEventListener(type, listener, options);
        }) as typeof document.addEventListener;
      },
      (window, _send, { armAutomationInput, sendSync }) => {
        armAutomationInput({
          token: 'frame-token',
          kind: 'pointerdown',
          expiresAt: window.Date.now() + 1_000,
          x: 210,
          y: 320,
          screenX: 510,
          screenY: 620,
        });
        pointerListener({
          type: 'pointerdown',
          isTrusted: true,
          clientX: 10,
          clientY: 20,
          screenX: 510,
          screenY: 620,
          composedPath: () => [],
        });

        expect(sendSync).toHaveBeenCalledWith('browser-page:gesture', {
          token: 'frame-token',
          kind: 'pointerdown',
        });
      },
    );
  });

  it('re-reports a stale cross-frame automation token as trusted user input', async () => {
    let pointerListener!: (event: Record<string, unknown>) => void;
    await runPreload(
      (document) => {
        const addEventListener = document.addEventListener.bind(document);
        document.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
          if (type === 'pointerdown') pointerListener = listener as unknown as typeof pointerListener;
          addEventListener(type, listener, options);
        }) as typeof document.addEventListener;
      },
      (window, _send, { armAutomationInput, sendSync }) => {
        armAutomationInput({
          token: 'stale-frame-token',
          kind: 'pointerdown',
          expiresAt: window.Date.now() + 1_000,
          x: 10,
          y: 20,
        });
        sendSync.mockReturnValueOnce(false).mockReturnValueOnce(true);

        pointerListener({
          type: 'pointerdown',
          isTrusted: true,
          clientX: 10,
          clientY: 20,
          composedPath: () => [],
        });

        expect(sendSync).toHaveBeenNthCalledWith(1, 'browser-page:gesture', {
          token: 'stale-frame-token',
          kind: 'pointerdown',
        });
        expect(sendSync).toHaveBeenNthCalledWith(2, 'browser-page:gesture', {
          kind: 'pointerdown',
        });
      },
    );
  });

  it('reports a composed shadow-root gesture only once', async () => {
    let documentPointerListener!: (event: Record<string, unknown>) => void;
    let shadowPointerListener!: (event: Record<string, unknown>) => void;
    await runPreload(
      (document) => {
        const documentAddEventListener = document.addEventListener.bind(document);
        document.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
          if (type === 'pointerdown') documentPointerListener = listener as unknown as typeof documentPointerListener;
          documentAddEventListener(type, listener, options);
        }) as typeof document.addEventListener;
        const host = document.createElement('div');
        const root = host.attachShadow({ mode: 'open' });
        const shadowAddEventListener = root.addEventListener.bind(root);
        root.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
          if (type === 'pointerdown') shadowPointerListener = listener as unknown as typeof shadowPointerListener;
          shadowAddEventListener(type, listener, options);
        }) as typeof root.addEventListener;
        root.append(document.createElement('button'));
        document.body.append(host);
      },
      (window, _send, { armAutomationInput, sendSync }) => {
        armAutomationInput({
          token: 'shadow-token',
          kind: 'pointerdown',
          expiresAt: window.Date.now() + 1_000,
          x: 12,
          y: 24,
        });
        const event = {
          type: 'pointerdown',
          isTrusted: true,
          clientX: 12,
          clientY: 24,
          composedPath: () => [],
        };
        shadowPointerListener(event);
        documentPointerListener(event);

        expect(sendSync).toHaveBeenCalledTimes(1);
        expect(sendSync).toHaveBeenCalledWith('browser-page:gesture', {
          token: 'shadow-token',
          kind: 'pointerdown',
        });
      },
    );
  });

  it('matches assistant typing exactly and ignores unmatched derived input events', async () => {
    let inputListener!: (event: Record<string, unknown>) => void;
    await runPreload(
      (document) => {
        const addEventListener = document.addEventListener.bind(document);
        document.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
          if (type === 'input') inputListener = listener as unknown as typeof inputListener;
          addEventListener(type, listener, options);
        }) as typeof document.addEventListener;
      },
      (window, _send, { armAutomationInput, sendSync }) => {
        armAutomationInput({
          token: 'typing-token',
          kind: 'input',
          inputType: 'insertText',
          expiresAt: window.Date.now() + 1_000,
        });
        sendSync.mockReturnValueOnce(false).mockReturnValueOnce(true).mockReturnValueOnce(true);
        inputListener({ type: 'input', isTrusted: true, inputType: 'insertText', data: 'user text' });
        inputListener({ type: 'input', isTrusted: true, inputType: 'insertText', data: 'assistant text' });

        expect(sendSync).toHaveBeenNthCalledWith(1, 'browser-page:gesture', {
          token: 'typing-token',
          kind: 'input',
          data: 'user text',
        });
        expect(sendSync).toHaveBeenNthCalledWith(2, 'browser-page:gesture', {
          kind: 'input',
        });
        expect(sendSync).toHaveBeenNthCalledWith(3, 'browser-page:gesture', {
          token: 'typing-token',
          kind: 'input',
          data: 'assistant text',
        });
      },
    );
  });

  it('latches secrets in open shadow roots', async () => {
    const send = await runPreload((document) => {
      const host = document.createElement('div');
      const root = host.attachShadow({ mode: 'open' });
      const field = document.createElement('input');
      field.type = 'password';
      field.value = 'shadow-secret';
      root.append(field);
      document.body.append(host);
    });

    expect(send).toHaveBeenCalledWith('browser-page:sensitive', true);
  });

  it('latches secrets in closed shadow roots attached after preload startup', async () => {
    const send = await runPreload(
      () => undefined,
      async (window) => {
        const host = window.document.createElement('div');
        const root = host.attachShadow({ mode: 'closed' });
        const field = window.document.createElement('input');
        field.type = 'password';
        field.value = 'closed-shadow-secret';
        root.append(field);
        window.document.body.append(host);
        expect(host.shadowRoot).toBeNull();
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
      },
    );

    expect(send).toHaveBeenCalledWith('browser-page:sensitive', true);
  });

  it('latches a closed root created by a re-entrant page attachShadow delegate', async () => {
    const send = await runPreload(
      () => undefined,
      (window) => {
        const wrapped = window.Element.prototype.attachShadow;
        window.Element.prototype.attachShadow = function () {
          return wrapped.call(this, { mode: 'closed' });
        };
        const host = window.document.createElement('div');
        const root = host.attachShadow({ mode: 'open' });
        window.document.body.append(host);

        expect(root.mode).toBe('closed');
        expect(host.shadowRoot).toBeNull();
      },
    );

    expect(send).toHaveBeenCalledWith('browser-page:sensitive', true);
  });

  it('fails closed for closed-shadow forms without crossing credential plaintext through page events', async () => {
    const send = await runPreload(
      () => undefined,
      (window) => {
        const host = window.document.createElement('div');
        const root = host.attachShadow({ mode: 'closed' });
        const form = window.document.createElement('form');
        const password = window.document.createElement('input');
        password.type = 'password';
        password.value = 'closed-login-secret';
        form.append(password);
        root.append(form);
        window.document.body.append(host);
      },
    );

    expect(send).toHaveBeenCalledWith('browser-page:sensitive', true);
    expect(send).not.toHaveBeenCalledWith('browser-page:login-submitted', expect.anything());
    expect(source).not.toContain('new CustomEvent(signalEventName');
  });

  it("leaves child-document instrumentation to that frame's registered preload", async () => {
    const send = await runPreload((document) => {
      const frame = document.createElement('iframe');
      document.body.append(frame);
      const frameDocument = frame.contentDocument!;
      const field = frameDocument.createElement('input');
      field.type = 'password';
      field.value = 'frame-secret';
      frameDocument.body.append(field);
    });

    expect(send).not.toHaveBeenCalledWith('browser-page:sensitive', true);
  });

  it('keeps a discovered password field sensitive after a show-password type toggle', async () => {
    let field!: HTMLInputElement;
    const send = await runPreload((document) => {
      field = document.createElement('input');
      field.type = 'password';
      document.body.append(field);
      queueMicrotask(() => {
        field.value = 'visible-secret';
        field.type = 'text';
        field.dispatchEvent(new field.ownerDocument.defaultView!.Event('input', { bubbles: true }));
      });
    });

    expect(send).toHaveBeenCalledWith('browser-page:sensitive', true);
  });

  it('reinstalls password observers when a document is restored from BFCache', async () => {
    const send = await runPreload(
      () => undefined,
      async (window) => {
        const transition = (type: string) => {
          const event = new window.Event(type);
          Object.defineProperty(event, 'persisted', { value: true });
          return event;
        };
        window.dispatchEvent(transition('pagehide'));
        window.dispatchEvent(transition('pageshow'));
        const field = window.document.createElement('input');
        field.type = 'password';
        field.value = 'restored-secret';
        window.document.body.append(field);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
      },
    );

    expect(send).toHaveBeenCalledWith('browser-page:sensitive', true);
  });

  it('reasserts an existing sensitive latch after BFCache restoration', async () => {
    const send = await runPreload(
      (document) => {
        const field = document.createElement('input');
        field.type = 'password';
        field.value = 'latched-before-cache';
        document.body.append(field);
      },
      (window, ipcSend) => {
        ipcSend.mockClear();
        const transition = (type: string) => {
          const event = new window.Event(type);
          Object.defineProperty(event, 'persisted', { value: true });
          return event;
        };
        window.dispatchEvent(transition('pagehide'));
        window.dispatchEvent(transition('pageshow'));
      },
    );

    expect(send).toHaveBeenCalledWith('browser-page:sensitive', true);
  });

  it('discovers late shadow roots without periodically rescanning the full document tree', async () => {
    let host!: HTMLElement;
    const send = await runPreload(
      (document) => {
        host = document.createElement('div');
        document.body.append(host);
      },
      async (window, ipcSend) => {
        ipcSend.mockClear();
        const fullTreeScan = vi.spyOn(window.document.documentElement, 'querySelectorAll');
        const root = host.attachShadow({ mode: 'open' });
        const field = window.document.createElement('input');
        field.type = 'password';
        field.value = 'late-shadow-secret';
        root.append(field);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_650));
        expect(fullTreeScan).not.toHaveBeenCalled();
      },
    );

    expect(send).toHaveBeenCalledWith('browser-page:sensitive', true);
  });

  it('releases detached password fields from periodic sensitivity scans', async () => {
    let host!: HTMLElement;
    let field!: HTMLInputElement;
    await runPreload(
      (document) => {
        host = document.createElement('div');
        field = document.createElement('input');
        field.type = 'password';
        host.append(field);
        document.body.append(host);
      },
      async (_window, send) => {
        host.remove();
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_650));
        send.mockClear();
        field.value = 'detached-secret';
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 450));
        expect(send).not.toHaveBeenCalledWith('browser-page:sensitive', true);
      },
    );
  });

  it('disconnects observers for detached shadow components', async () => {
    let host!: HTMLElement;
    let root!: ShadowRoot;
    await runPreload(
      (document) => {
        host = document.createElement('div');
        root = host.attachShadow({ mode: 'open' });
        document.body.append(host);
      },
      async (window, send) => {
        host.remove();
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_650));
        send.mockClear();
        const field = window.document.createElement('input');
        field.type = 'password';
        field.value = 'detached-shadow-secret';
        root.append(field);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
        expect(send).not.toHaveBeenCalledWith('browser-page:sensitive', true);
      },
    );
  });

  it('saves the new password rather than the old password on change forms', async () => {
    let form!: HTMLFormElement;
    let submitListener!: (event: { isTrusted: boolean; target: HTMLFormElement }) => void;
    const send = await runPreload(
      (document) => {
        const addEventListener = document.addEventListener.bind(document);
        document.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
          if (type === 'submit') submitListener = listener as unknown as typeof submitListener;
          addEventListener(type, listener, options);
        }) as typeof document.addEventListener;
        form = document.createElement('form');
        for (const [autocomplete, value] of [
          ['current-password', 'old-secret'],
          ['new-password', 'new-secret'],
          ['new-password', 'new-secret'],
        ]) {
          const field = document.createElement('input');
          field.type = 'password';
          field.autocomplete = autocomplete as AutoFill;
          field.value = value;
          field.getBoundingClientRect = () => ({ width: 200, height: 30 }) as DOMRect;
          form.append(field);
        }
        document.body.append(form);
      },
      () => submitListener({ isTrusted: true, target: form }),
    );

    expect(send).toHaveBeenCalledWith(
      'browser-page:login-submitted',
      expect.objectContaining({ password: 'new-secret' }),
    );
  });

  it('detects a trusted button-driven login that does not dispatch a submit event', async () => {
    let button!: HTMLButtonElement;
    let clickListener!: (event: Record<string, unknown>) => void;
    const send = await runPreload(
      (document) => {
        const addEventListener = document.addEventListener.bind(document);
        document.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
          if (type === 'click') clickListener = listener as unknown as typeof clickListener;
          addEventListener(type, listener, options);
        }) as typeof document.addEventListener;
        const form = document.createElement('form');
        const username = document.createElement('input');
        username.type = 'email';
        username.value = 'alice@example.com';
        username.getBoundingClientRect = () => ({ width: 200, height: 30 }) as DOMRect;
        const password = document.createElement('input');
        password.type = 'password';
        password.value = 'fetch-login-secret';
        password.getBoundingClientRect = () => ({ width: 200, height: 30 }) as DOMRect;
        button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Sign in';
        form.append(username, password, button);
        document.body.append(form);
      },
      () =>
        clickListener({
          type: 'click',
          isTrusted: true,
          target: button,
          composedPath: () => [button, button.form, button.ownerDocument.body, button.ownerDocument],
        }),
    );

    expect(send).toHaveBeenCalledWith('browser-page:login-submitted', {
      origin: 'https://example.com',
      username: 'alice@example.com',
      password: 'fetch-login-secret',
    });
  });

  it('detects a standalone password login from a trusted Enter key', async () => {
    let password!: HTMLInputElement;
    let keydownListener!: (event: Record<string, unknown>) => void;
    const send = await runPreload(
      (document) => {
        const addEventListener = document.addEventListener.bind(document);
        document.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
          if (type === 'keydown' && !keydownListener) keydownListener = listener as unknown as typeof keydownListener;
          addEventListener(type, listener, options);
        }) as typeof document.addEventListener;
        const username = document.createElement('input');
        username.name = 'username';
        username.value = 'alice';
        username.getBoundingClientRect = () => ({ width: 200, height: 30 }) as DOMRect;
        password = document.createElement('input');
        password.type = 'password';
        password.value = 'standalone-secret';
        password.getBoundingClientRect = () => ({ width: 200, height: 30 }) as DOMRect;
        document.body.append(username, password);
      },
      () =>
        keydownListener({
          type: 'keydown',
          key: 'Enter',
          isTrusted: true,
          target: password,
          composedPath: () => [password, password.ownerDocument.body, password.ownerDocument],
        }),
    );

    expect(send).toHaveBeenCalledWith('browser-page:login-submitted', {
      origin: 'https://example.com',
      username: 'alice',
      password: 'standalone-secret',
    });
  });

  it('does not treat a password-reveal button as a login action', async () => {
    let button!: HTMLButtonElement;
    let clickListener!: (event: Record<string, unknown>) => void;
    const send = await runPreload(
      (document) => {
        const addEventListener = document.addEventListener.bind(document);
        document.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
          if (type === 'click') clickListener = listener as unknown as typeof clickListener;
          addEventListener(type, listener, options);
        }) as typeof document.addEventListener;
        const form = document.createElement('form');
        const password = document.createElement('input');
        password.type = 'password';
        password.value = 'not-submitted';
        password.getBoundingClientRect = () => ({ width: 200, height: 30 }) as DOMRect;
        button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Show password';
        form.append(password, button);
        document.body.append(form);
      },
      () =>
        clickListener({
          type: 'click',
          isTrusted: true,
          target: button,
          composedPath: () => [button, button.form, button.ownerDocument.body, button.ownerDocument],
        }),
    );

    expect(send.mock.calls.some(([channel]) => channel === 'browser-page:login-submitted')).toBe(false);
  });

  it('captures only one visible semantic username field on login submission', async () => {
    let form!: HTMLFormElement;
    let submitListener!: (event: { isTrusted: boolean; target: HTMLFormElement }) => void;
    const send = await runPreload(
      (document) => {
        const addEventListener = document.addEventListener.bind(document);
        document.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
          if (type === 'submit') submitListener = listener as unknown as typeof submitListener;
          addEventListener(type, listener, options);
        }) as typeof document.addEventListener;
        form = document.createElement('form');
        const hiddenTracking = document.createElement('input');
        hiddenTracking.type = 'text';
        hiddenTracking.name = 'user_tracking';
        hiddenTracking.value = 'tracking-identifier';
        hiddenTracking.style.display = 'none';
        form.append(hiddenTracking);
        const username = document.createElement('input');
        username.type = 'email';
        username.name = 'email';
        username.value = 'alice@example.com';
        username.getBoundingClientRect = () => ({ width: 200, height: 30 }) as DOMRect;
        form.append(username);
        const password = document.createElement('input');
        password.type = 'password';
        password.value = 'secret';
        password.getBoundingClientRect = () => ({ width: 200, height: 30 }) as DOMRect;
        form.append(password);
        document.body.append(form);
      },
      () => submitListener({ isTrusted: true, target: form }),
    );

    expect(send).toHaveBeenCalledWith(
      'browser-page:login-submitted',
      expect.objectContaining({ username: 'alice@example.com', password: 'secret' }),
    );
  });

  it('ignores an offscreen explicit username in favor of the visible submitted account', async () => {
    let form!: HTMLFormElement;
    let submitListener!: (event: { isTrusted: boolean; target: HTMLFormElement }) => void;
    const send = await runPreload(
      (document) => {
        const addEventListener = document.addEventListener.bind(document);
        document.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
          if (type === 'submit') submitListener = listener as unknown as typeof submitListener;
          addEventListener(type, listener, options);
        }) as typeof document.addEventListener;
        form = document.createElement('form');
        const offscreen = document.createElement('input');
        offscreen.type = 'text';
        offscreen.autocomplete = 'username';
        offscreen.value = 'attacker-account';
        offscreen.getBoundingClientRect = () =>
          ({ left: -300, right: -100, top: 0, bottom: 30, width: 200, height: 30 }) as DOMRect;
        const username = document.createElement('input');
        username.type = 'email';
        username.value = 'alice@example.com';
        username.getBoundingClientRect = () =>
          ({ left: 0, right: 200, top: 0, bottom: 30, width: 200, height: 30 }) as DOMRect;
        const password = document.createElement('input');
        password.type = 'password';
        password.value = 'secret';
        password.getBoundingClientRect = () =>
          ({ left: 0, right: 200, top: 40, bottom: 70, width: 200, height: 30 }) as DOMRect;
        form.append(offscreen, username, password);
        document.body.append(form);
        Object.defineProperty(document, 'elementFromPoint', {
          configurable: true,
          value: (_x: number, y: number) => (y < 35 ? username : password),
        });
      },
      () => submitListener({ isTrusted: true, target: form }),
    );

    expect(send).toHaveBeenCalledWith(
      'browser-page:login-submitted',
      expect.objectContaining({ username: 'alice@example.com', password: 'secret' }),
    );
  });

  it('omits an ambiguous visible username instead of persisting the first value', async () => {
    let form!: HTMLFormElement;
    let submitListener!: (event: { isTrusted: boolean; target: HTMLFormElement }) => void;
    const send = await runPreload(
      (document) => {
        const addEventListener = document.addEventListener.bind(document);
        document.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
          if (type === 'submit') submitListener = listener as unknown as typeof submitListener;
          addEventListener(type, listener, options);
        }) as typeof document.addEventListener;
        form = document.createElement('form');
        for (const [name, value] of [
          ['username', 'alice'],
          ['email', 'alice@example.com'],
        ]) {
          const field = document.createElement('input');
          field.type = name === 'email' ? 'email' : 'text';
          field.name = name;
          field.value = value;
          field.getBoundingClientRect = () => ({ width: 200, height: 30 }) as DOMRect;
          form.append(field);
        }
        const password = document.createElement('input');
        password.type = 'password';
        password.value = 'secret';
        password.getBoundingClientRect = () => ({ width: 200, height: 30 }) as DOMRect;
        form.append(password);
        document.body.append(form);
      },
      () => submitListener({ isTrusted: true, target: form }),
    );

    expect(send).toHaveBeenCalledWith(
      'browser-page:login-submitted',
      expect.objectContaining({ username: '', password: 'secret' }),
    );
  });

  it('recognizes camelCase new-password field names on change forms', async () => {
    let form!: HTMLFormElement;
    let submitListener!: (event: { isTrusted: boolean; target: HTMLFormElement }) => void;
    const send = await runPreload(
      (document) => {
        const addEventListener = document.addEventListener.bind(document);
        document.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
          if (type === 'submit') submitListener = listener as unknown as typeof submitListener;
          addEventListener(type, listener, options);
        }) as typeof document.addEventListener;
        form = document.createElement('form');
        const currentPassword = document.createElement('input');
        currentPassword.type = 'password';
        currentPassword.autocomplete = 'current-password';
        currentPassword.value = 'old-secret';
        currentPassword.getBoundingClientRect = () => ({ width: 200, height: 30 }) as DOMRect;
        form.append(currentPassword);
        const newPassword = document.createElement('input');
        newPassword.type = 'password';
        newPassword.name = 'newPassword';
        newPassword.value = 'new-secret';
        newPassword.getBoundingClientRect = () => ({ width: 200, height: 30 }) as DOMRect;
        form.append(newPassword);
        document.body.append(form);
      },
      () => submitListener({ isTrusted: true, target: form }),
    );

    expect(send).toHaveBeenCalledWith(
      'browser-page:login-submitted',
      expect.objectContaining({ password: 'new-secret' }),
    );
  });

  it('does not save an ambiguous multi-password form without semantic hints', async () => {
    let form!: HTMLFormElement;
    let submitListener!: (event: { isTrusted: boolean; target: HTMLFormElement }) => void;
    const send = await runPreload(
      (document) => {
        const addEventListener = document.addEventListener.bind(document);
        document.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
          if (type === 'submit') submitListener = listener as unknown as typeof submitListener;
          addEventListener(type, listener, options);
        }) as typeof document.addEventListener;
        form = document.createElement('form');
        for (const value of ['first-secret', 'second-secret']) {
          const field = document.createElement('input');
          field.type = 'password';
          field.value = value;
          field.getBoundingClientRect = () => ({ width: 200, height: 30 }) as DOMRect;
          form.append(field);
        }
        document.body.append(form);
      },
      () => submitListener({ isTrusted: true, target: form }),
    );

    expect(send.mock.calls.some(([channel]) => channel === 'browser-page:login-submitted')).toBe(false);
  });

  it('does not save mismatched new-password and confirmation values', async () => {
    let form!: HTMLFormElement;
    let submitListener!: (event: { isTrusted: boolean; target: HTMLFormElement }) => void;
    const send = await runPreload(
      (document) => {
        const addEventListener = document.addEventListener.bind(document);
        document.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
          if (type === 'submit') submitListener = listener as unknown as typeof submitListener;
          addEventListener(type, listener, options);
        }) as typeof document.addEventListener;
        form = document.createElement('form');
        for (const value of ['new-secret', 'different-secret']) {
          const field = document.createElement('input');
          field.type = 'password';
          field.autocomplete = 'new-password';
          field.value = value;
          field.getBoundingClientRect = () => ({ width: 200, height: 30 }) as DOMRect;
          form.append(field);
        }
        document.body.append(form);
      },
      () => submitListener({ isTrusted: true, target: form }),
    );

    expect(send.mock.calls.some(([channel]) => channel === 'browser-page:login-submitted')).toBe(false);
  });

  it('does not treat a lone confirm_password hint as authoritative when the generic password differs', async () => {
    let form!: HTMLFormElement;
    let submitListener!: (event: { isTrusted: boolean; target: HTMLFormElement }) => void;
    const send = await runPreload(
      (document) => {
        const addEventListener = document.addEventListener.bind(document);
        document.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
          if (type === 'submit') submitListener = listener as unknown as typeof submitListener;
          addEventListener(type, listener, options);
        }) as typeof document.addEventListener;
        form = document.createElement('form');
        for (const [name, value] of [
          ['password', 'intended-secret'],
          ['confirm_password', 'mistyped-secret'],
        ]) {
          const field = document.createElement('input');
          field.type = 'password';
          field.name = name;
          field.value = value;
          field.getBoundingClientRect = () => ({ width: 200, height: 30 }) as DOMRect;
          form.append(field);
        }
        document.body.append(form);
      },
      () => submitListener({ isTrusted: true, target: form }),
    );

    expect(send.mock.calls.some(([channel]) => channel === 'browser-page:login-submitted')).toBe(false);
  });

  it('ignores hidden and disabled password inputs on a trusted form submission', async () => {
    let form!: HTMLFormElement;
    let submitListener!: (event: { isTrusted: boolean; target: HTMLFormElement }) => void;
    const send = await runPreload(
      (document) => {
        const addEventListener = document.addEventListener.bind(document);
        document.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
          if (type === 'submit') submitListener = listener as unknown as typeof submitListener;
          addEventListener(type, listener, options);
        }) as typeof document.addEventListener;
        form = document.createElement('form');
        const hidden = document.createElement('input');
        hidden.type = 'password';
        hidden.value = 'attacker-controlled-hidden-secret';
        hidden.style.display = 'none';
        form.append(hidden);
        const disabled = document.createElement('input');
        disabled.type = 'password';
        disabled.value = 'disabled-secret';
        disabled.disabled = true;
        disabled.getBoundingClientRect = () => ({ width: 200, height: 30 }) as DOMRect;
        form.append(disabled);
        document.body.append(form);
      },
      () => submitListener({ isTrusted: true, target: form }),
    );

    expect(send.mock.calls.some(([channel]) => channel === 'browser-page:login-submitted')).toBe(false);
  });

  it('rejects a current-password field when another visible password is ambiguous', async () => {
    let form!: HTMLFormElement;
    let submitListener!: (event: { isTrusted: boolean; target: HTMLFormElement }) => void;
    const send = await runPreload(
      (document) => {
        const addEventListener = document.addEventListener.bind(document);
        document.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
          if (type === 'submit') submitListener = listener as unknown as typeof submitListener;
          addEventListener(type, listener, options);
        }) as typeof document.addEventListener;
        form = document.createElement('form');
        for (const [autocomplete, value] of [
          ['current-password', 'real-secret'],
          ['', 'ambiguous-visible-secret'],
        ]) {
          const field = document.createElement('input');
          field.type = 'password';
          field.autocomplete = autocomplete as AutoFill;
          field.value = value;
          field.getBoundingClientRect = () => ({ width: 200, height: 30 }) as DOMRect;
          form.append(field);
        }
        document.body.append(form);
      },
      () => submitListener({ isTrusted: true, target: form }),
    );

    expect(send.mock.calls.some(([channel]) => channel === 'browser-page:login-submitted')).toBe(false);
  });

  it('does not report script-synthesized login submissions', async () => {
    const send = await runPreload((document) => {
      const form = document.createElement('form');
      const field = document.createElement('input');
      field.type = 'password';
      field.value = 'synthetic-secret';
      form.append(field);
      document.body.append(form);
      queueMicrotask(() => form.dispatchEvent(new document.defaultView!.Event('submit', { bubbles: true })));
    });

    expect(send.mock.calls.some(([channel]) => channel === 'browser-page:login-submitted')).toBe(false);
  });
});
