// @ts-expect-error jsdom is installed for Vitest's DOM environment without its optional declaration package.
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { browserAutofillProbeScript, browserAutofillScript } from '../credential-dom.js';

function installInputGeometry(document: Document): void {
  const inputs = [...document.querySelectorAll('input')];
  for (const [index, input] of inputs.entries()) {
    Object.defineProperty(input, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: index * 32,
        top: index * 32,
        left: 0,
        right: 120,
        bottom: index * 32 + 24,
        width: 120,
        height: 24,
      }),
    });
  }
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: (x: number, y: number) =>
      inputs.find((input) => {
        const rect = input.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      }) ?? document.body,
  });
}

function runAutofill(
  html: string,
  expectedOrigin = 'https://example.com',
  configure?: (document: Document) => void,
): Document {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: 'https://example.com/login',
    runScripts: 'outside-only',
  });
  installInputGeometry(dom.window.document);
  configure?.(dom.window.document);
  dom.window.eval(browserAutofillScript('saved-user', 'saved-password', expectedOrigin));
  return dom.window.document;
}

describe('browser saved-password DOM targeting', () => {
  it('fills the explicit current-password field but not new-password fields', () => {
    const document = runAutofill(`
      <form>
        <input autocomplete="username">
        <input type="password" autocomplete="current-password" id="current">
        <input type="password" autocomplete="new-password" id="new">
      </form>
    `);
    expect((document.querySelector('#current') as HTMLInputElement).value).toBe('saved-password');
    expect((document.querySelector('#new') as HTMLInputElement).value).toBe('');
    expect((document.querySelector('[autocomplete=username]') as HTMLInputElement).value).toBe('saved-user');
  });

  it('rejects signup/reset forms that contain only new-password fields', () => {
    expect(() =>
      runAutofill(
        '<form><input type="password" autocomplete="new-password"><input type="password" name="confirm-password"></form>',
      ),
    ).toThrow(/unambiguous visible login field/);
  });

  it('rejects multiple generic password fields instead of guessing', () => {
    expect(() => runAutofill('<form><input type="password" id="one"><input type="password" id="two"></form>')).toThrow(
      /unambiguous visible login field/,
    );
  });

  it('fills the unique semantic username field instead of an earlier generic promo field', () => {
    const document = runAutofill(`
      <form>
        <input type="text" id="promo">
        <input type="email" id="login-email">
        <input type="password" autocomplete="current-password">
      </form>
    `);
    expect((document.querySelector('#promo') as HTMLInputElement).value).toBe('');
    expect((document.querySelector('#login-email') as HTMLInputElement).value).toBe('saved-user');
  });

  it('rejects ambiguous generic username fields rather than leaking the saved username', () => {
    expect(() =>
      runAutofill(`
        <form>
          <input type="text" id="promo">
          <input type="text" id="account-field">
          <input type="password" autocomplete="current-password">
        </form>
      `),
    ).toThrow(/unambiguous visible username field/);
  });

  it('rejects a generic field when the same form contains a signup confirmation field', () => {
    expect(() =>
      runAutofill('<form><input type="password" name="password"><input type="password" name="confirmPassword"></form>'),
    ).toThrow(/unambiguous visible login field/);
  });

  it('pins credential injection to the origin validated by main', () => {
    expect(() => runAutofill('<input type="password">', 'https://redirected.example')).toThrow(
      /page changed before saved-password autofill/,
    );
  });

  it('rejects password fields outside the visible viewport', () => {
    expect(() =>
      runAutofill('<input type="password" id="offscreen">', 'https://example.com', (document) => {
        const field = document.querySelector('#offscreen')!;
        Object.defineProperty(field, 'getBoundingClientRect', {
          configurable: true,
          value: () => ({
            x: -300,
            y: 0,
            top: 0,
            left: -300,
            right: -180,
            bottom: 24,
            width: 120,
            height: 24,
          }),
        });
      }),
    ).toThrow(/unambiguous visible login field/);
  });

  it('rejects password fields hidden by a transparent ancestor', () => {
    expect(() => runAutofill('<section style="opacity: 0"><input type="password"></section>')).toThrow(
      /unambiguous visible login field/,
    );
  });

  it('rejects password fields covered by another element', () => {
    expect(() =>
      runAutofill('<input type="password">', 'https://example.com', (document) => {
        Object.defineProperty(document, 'elementFromPoint', {
          configurable: true,
          value: () => document.body,
        });
      }),
    ).toThrow(/unambiguous visible login field/);
  });

  it('probes a login target without embedding or filling credentials', () => {
    const dom = new JSDOM(
      '<!doctype html><html><body><form><input autocomplete="username"><input type="password"></form></body></html>',
      { url: 'https://example.com/login', runScripts: 'outside-only' },
    );
    installInputGeometry(dom.window.document);

    expect(dom.window.eval(browserAutofillProbeScript('https://example.com'))).toBe(true);
    expect((dom.window.document.querySelector('[autocomplete=username]') as HTMLInputElement).value).toBe('');
    expect((dom.window.document.querySelector('[type=password]') as HTMLInputElement).value).toBe('');
  });

  it('returns false without surfacing plaintext from a hostile input setter', () => {
    const dom = new JSDOM(
      '<!doctype html><html><body><form><input autocomplete="username"><input type="password"></form></body></html>',
      { url: 'https://example.com/login', runScripts: 'outside-only' },
    );
    try {
      installInputGeometry(dom.window.document);
      const prototype = dom.window.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      if (!descriptor?.set) throw new Error('JSDOM input setter is unavailable.');
      Object.defineProperty(prototype, 'value', {
        ...descriptor,
        set(this: HTMLInputElement, value: string) {
          if (this.type === 'password') throw new Error(`hostile:${value}`);
          descriptor.set!.call(this, value);
        },
      });

      expect(
        dom.window.eval(browserAutofillScript('saved-user', 'never-expose-this-password', 'https://example.com')),
      ).toBe(false);
    } finally {
      dom.window.close();
    }
  });
});
