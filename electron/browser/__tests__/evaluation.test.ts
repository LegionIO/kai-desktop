import vm from 'node:vm';
// @ts-expect-error jsdom is installed for Vitest's DOM environment without its optional declaration package.
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_PRIVATE_NETWORK_NEW_DOCUMENT_GUARD, boundedBrowserEvaluationExpression } from '../evaluation.js';

async function evaluate(expression: string): Promise<string> {
  return (await vm.runInNewContext(expression)) as string;
}

describe('bounded browser evaluation', () => {
  it('blocks native UI inside the exact isolated evaluation world', async () => {
    const dom = new JSDOM('<!doctype html><p>Browser</p>', { runScripts: 'outside-only', url: 'https://example.com/' });
    const print = vi.fn();
    Object.defineProperty(dom.window, 'print', { configurable: true, writable: true, value: print });

    await expect(dom.window.eval(boundedBrowserEvaluationExpression('window.print()'))).rejects.toThrow(
      /printing is blocked/i,
    );
    expect(print).not.toHaveBeenCalled();
    dom.window.close();
  });

  it('preserves script completion values while serializing inside the page', async () => {
    const serialized = await evaluate(
      boundedBrowserEvaluationExpression('const values = [1, 2, 3]; ({ ok: true, values })'),
    );
    expect(JSON.parse(serialized)).toEqual({ ok: true, values: [1, 2, 3] });
  });

  it('rejects oversized primitive and nested results before returning them to main', async () => {
    await expect(evaluate(boundedBrowserEvaluationExpression(`'x'.repeat(10_000)`, 128))).rejects.toThrow(
      /exceeds the 128-character limit/,
    );
    await expect(
      evaluate(boundedBrowserEvaluationExpression(`Array.from({ length: 1_000 }, (_, index) => index)`, 128)),
    ).rejects.toThrow(/exceeds the 128-character limit/);
  });

  it('bounds thrown values before CDP can transfer their exception details', async () => {
    const error = await evaluate(boundedBrowserEvaluationExpression(`throw new Error('x'.repeat(100_000))`, 128)).catch(
      (reason: unknown) => reason,
    );
    const message = (error as { message?: string }).message ?? '';
    expect(message).toMatch(/^Browser script failed:/);
    expect(message.length).toBeLessThan(4_200);
  });

  it('captures serializer intrinsics before the evaluated script can replace them', async () => {
    const serialized = await evaluate(
      boundedBrowserEvaluationExpression(
        `JSON.stringify = () => ({ length: 0, data: 'x'.repeat(1_000_000) }); ({ ok: true })`,
        128,
      ),
    );
    expect(JSON.parse(serialized)).toEqual({ ok: true });
  });

  it('blocks WebRTC constructors while AI private-network access is disabled', async () => {
    const expression = boundedBrowserEvaluationExpression(
      `new RTCPeerConnection({ iceServers: [{ urls: 'stun:192.168.1.1:3478' }] })`,
      128,
      false,
    );

    await expect(evaluate(expression)).rejects.toThrow(/WebRTC is blocked/);
  });

  it('provides a document-start guard for newly navigated frame globals', () => {
    const context = vm.createContext({
      Error,
      Object,
      globalThis: null as unknown,
      RTCPeerConnection: function NativePeerConnection() {},
    });
    context.globalThis = context;

    vm.runInContext(BROWSER_PRIVATE_NETWORK_NEW_DOCUMENT_GUARD, context);

    expect(() => vm.runInContext('new RTCPeerConnection()', context)).toThrow(/WebRTC is blocked/);
    expect(
      vm.runInContext("Object.getOwnPropertyDescriptor(globalThis, 'RTCPeerConnection').configurable", context),
    ).toBe(false);
  });

  it('blocks fresh frame globals while AI private-network access is disabled', async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'https://example.com',
      runScripts: 'outside-only',
    });
    try {
      const expression = boundedBrowserEvaluationExpression(
        `const frame = document.createElement('iframe');
         document.body.append(frame);
         new frame.contentWindow.RTCPeerConnection({ iceServers: [{ urls: 'turn:192.168.1.1:3478' }] });`,
        128,
        false,
      );

      await expect(dom.window.eval(expression)).rejects.toThrow(/Creating browser frames is blocked/);
      expect(dom.window.document.querySelector('iframe')).toBeNull();
    } finally {
      dom.window.close();
    }
  });

  it('blocks Document.prototype frame factories and insertion APIs', async () => {
    const run = async (script: string): Promise<void> => {
      const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://example.com',
        runScripts: 'outside-only',
      });
      try {
        await expect(dom.window.eval(boundedBrowserEvaluationExpression(script, 128, false))).rejects.toThrow(
          /Creating browser frames is blocked/,
        );
      } finally {
        dom.window.close();
      }
    };

    await run(`Document.prototype.createElement.call(document, 'iframe')`);
    await run(
      `const parsed = new DOMParser().parseFromString('<iframe></iframe>', 'text/html');
       Document.prototype.replaceChildren.call(document, parsed.querySelector('iframe'));`,
    );
  });

  it('fails closed when a pre-existing frame tree exceeds the quarantine budget', async () => {
    const dom = new JSDOM(`<!doctype html><body>${'<iframe></iframe>'.repeat(65)}</body>`, {
      url: 'https://example.com',
      runScripts: 'outside-only',
    });
    try {
      const expression = boundedBrowserEvaluationExpression('({ ok: true })', 128, false);
      await expect(dom.window.eval(expression)).rejects.toThrow(/too many frames/i);
    } finally {
      dom.window.close();
    }
  });
});
