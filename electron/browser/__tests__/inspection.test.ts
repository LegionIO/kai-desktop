import vm from 'node:vm';
// @ts-expect-error jsdom is installed for Vitest's DOM environment without its optional declaration package.
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { browserInspectionExpression } from '../inspection.js';
import { MAX_BROWSER_ROLE_CHARS, MAX_BROWSER_SELECTOR_CHARS } from '../input-validation.js';

describe('browser inspection expression', () => {
  it('reports accessible names and native roles consistently for form controls', () => {
    const dom = new JSDOM(
      `<!doctype html><body>
        <span id="email-name">Email address</span>
        <input id="email" aria-labelledby="email-name">
        <label>Phone number <input id="phone" type="tel"></label>
        <input id="submit" type="submit" value="Sign in">
        <input id="radio" type="radio" aria-label="Plan">
        <input id="range" type="range" aria-label="Volume">
        <input id="number" type="number" aria-label="Quantity">
        <input id="checkbox" type="checkbox" aria-label="Remember me">
        <select id="single" aria-label="Country"><option>US</option></select>
        <select id="multiple" multiple aria-label="Tags"><option>One</option></select>
        <button id="image-button"><img alt="Upload receipt"></button>
        <input id="image-input" type="image" alt="Continue with image">
        <input id="fallback" title="Account alias">
      </body>`,
      { runScripts: 'outside-only', url: 'https://example.com' },
    );
    try {
      const controls = [...dom.window.document.querySelectorAll<HTMLElement>('input,select,button')];
      controls.forEach((control, index) => {
        const left = index * 30;
        Object.defineProperty(control, 'getBoundingClientRect', {
          value: () => ({ left, top: 10, right: left + 20, bottom: 30, width: 20, height: 20 }),
        });
      });
      Object.defineProperty(dom.window.document, 'elementsFromPoint', {
        configurable: true,
        value: (x: number) => {
          const control = controls.find((candidate) => {
            const rect = candidate.getBoundingClientRect();
            return x >= rect.left && x <= rect.right;
          });
          return control ? [control, dom.window.document.body, dom.window.document.documentElement] : [];
        },
      });

      const result = dom.window.eval(browserInspectionExpression()) as {
        elements: Array<{ selector: string; role?: string; name: string }>;
      };
      const bySelector = new Map(result.elements.map((element) => [element.selector, element]));

      expect(bySelector.get('#email')).toMatchObject({ role: 'textbox', name: 'Email address' });
      expect(bySelector.get('#phone')).toMatchObject({ role: 'textbox', name: 'Phone number' });
      expect(bySelector.get('#submit')).toMatchObject({ role: 'button', name: 'Sign in' });
      expect(bySelector.get('#radio')).toMatchObject({ role: 'radio', name: 'Plan' });
      expect(bySelector.get('#range')).toMatchObject({ role: 'slider', name: 'Volume' });
      expect(bySelector.get('#number')).toMatchObject({ role: 'spinbutton', name: 'Quantity' });
      expect(bySelector.get('#checkbox')).toMatchObject({ role: 'checkbox', name: 'Remember me' });
      expect(bySelector.get('#single')).toMatchObject({ role: 'combobox', name: 'Country' });
      expect(bySelector.get('#multiple')).toMatchObject({ role: 'listbox', name: 'Tags' });
      expect(bySelector.get('#image-button')).toMatchObject({ role: 'button', name: 'Upload receipt' });
      expect(bySelector.get('#image-input')).toMatchObject({ role: 'button', name: 'Continue with image' });
      expect(bySelector.get('#fallback')).toMatchObject({ role: 'textbox', name: 'Account alias' });
    } finally {
      dom.window.close();
    }
  });

  it('bounds page-controlled selectors and roles before returning the inspection', () => {
    const body = {
      children: [] as unknown[],
      getAttribute: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 1_200, bottom: 800, width: 1_200, height: 800 }),
      hidden: false,
      nodeType: 1,
      parentElement: null,
      tagName: 'BODY',
    };
    const role = 'r'.repeat(MAX_BROWSER_ROLE_CHARS * 2);
    const button = {
      children: [] as unknown[],
      disabled: false,
      getAttribute: (name: string) => (name === 'role' ? role : null),
      getBoundingClientRect: () => ({ left: 10, top: 20, right: 110, bottom: 40, width: 100, height: 20 }),
      hidden: false,
      id: 's'.repeat(MAX_BROWSER_SELECTOR_CHARS * 2),
      innerText: 'Inspect me',
      nodeType: 1,
      parentElement: body,
      tagName: 'BUTTON',
      textContent: 'Inspect me',
    };
    body.children.push(button);
    const textNodes = new Map<unknown, Array<{ parentElement: unknown; textContent: string }>>([
      [body, [{ parentElement: button, textContent: 'Visible page text' }]],
      [button, [{ parentElement: button, textContent: 'Inspect me' }]],
    ]);
    const result = vm.runInNewContext(browserInspectionExpression(), {
      CSS: { escape: (value: string) => value },
      document: {
        body,
        createRange: () => {
          let selected: { parentElement: { getBoundingClientRect: () => unknown } } | null = null;
          return {
            selectNodeContents: (node: typeof selected) => {
              selected = node;
            },
            getClientRects: () => (selected ? [selected.parentElement.getBoundingClientRect()] : []),
            detach: () => undefined,
          };
        },
        createTreeWalker: (root: unknown) => {
          const nodes = textNodes.get(root) ?? [];
          let index = 0;
          return { nextNode: () => nodes[index++] ?? null };
        },
        elementsFromPoint: () => [button, body],
        querySelectorAll: () => [button],
      },
      getComputedStyle: () => ({ display: 'block', opacity: '1', visibility: 'visible' }),
      innerHeight: 800,
      innerWidth: 1_200,
      NodeFilter: { SHOW_TEXT: 4 },
      scrollX: 0,
      scrollY: 0,
    }) as {
      visibleText: string;
      elements: Array<{ selector?: string; role?: string }>;
      __kaiOcclusionPoints: Array<{ x: number; y: number }>;
    };

    expect(result.visibleText).toBe('Visible page text');
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]?.selector).toHaveLength(MAX_BROWSER_SELECTOR_CHARS);
    expect(result.elements[0]?.role).toHaveLength(MAX_BROWSER_ROLE_CHARS);
    expect(result.__kaiOcclusionPoints.length).toBeGreaterThan(0);
  });

  it('falls back from duplicate ids to selectors unique to each inspected element', () => {
    const makeElement = (tagName: string, parentElement: Record<string, unknown> | null, left = 0) => ({
      children: [] as Array<Record<string, unknown>>,
      disabled: false,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ left, top: 0, right: left + 20, bottom: 20, width: 20, height: 20 }),
      hidden: false,
      id: tagName === 'BUTTON' ? 'duplicate' : '',
      nodeType: 1,
      parentElement,
      tagName,
    });
    const body = makeElement('BODY', null);
    const first = makeElement('BUTTON', body, 0);
    const second = makeElement('BUTTON', body, 40);
    body.children.push(first, second);
    const all = [first, second];
    const querySelectorAll = (selector: string) => {
      if (selector === 'a,button,input:not([type="password"]),select,textarea,[role],[tabindex]') return all;
      if (selector === '#duplicate' || selector === 'button') return all;
      if (selector === 'body > button:nth-of-type(1)') return [first];
      if (selector === 'body > button:nth-of-type(2)') return [second];
      return [];
    };

    const result = vm.runInNewContext(browserInspectionExpression(), {
      CSS: { escape: (value: string) => value },
      document: {
        body,
        createTreeWalker: () => ({ nextNode: () => null }),
        elementsFromPoint: (x: number) => (x < 30 ? [first, body] : [second, body]),
        querySelectorAll,
      },
      getComputedStyle: () => ({ display: 'block', opacity: '1', visibility: 'visible' }),
      innerHeight: 600,
      innerWidth: 800,
      NodeFilter: { SHOW_TEXT: 4 },
      scrollX: 0,
      scrollY: 0,
    }) as { elements: Array<{ selector: string }> };

    expect(result.elements.map((element) => element.selector)).toEqual([
      'body > button:nth-of-type(1)',
      'body > button:nth-of-type(2)',
    ]);
  });

  it('excludes ancestor-hidden, transparent, and offscreen text and controls', () => {
    const body = {
      children: [] as unknown[],
      getAttribute: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }),
      hidden: false,
      nodeType: 1,
      parentElement: null,
      tagName: 'BODY',
    };
    const element = (
      tagName: string,
      parentElement: unknown,
      rect: { left: number; top: number; right: number; bottom: number; width: number; height: number },
      style: { display?: string; opacity?: string; visibility?: string } = {},
    ) => ({
      children: [] as unknown[],
      disabled: false,
      getAttribute: () => null,
      getBoundingClientRect: () => rect,
      hidden: false,
      id: '',
      nodeType: 1,
      parentElement,
      style,
      tagName,
    });
    const visible = element('BUTTON', body, { left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 });
    const hiddenAncestor = element(
      'DIV',
      body,
      { left: 10, top: 50, right: 110, bottom: 80, width: 100, height: 30 },
      { display: 'none' },
    );
    const hiddenChild = element('BUTTON', hiddenAncestor, {
      left: 10,
      top: 50,
      right: 110,
      bottom: 80,
      width: 100,
      height: 30,
    });
    const transparent = element(
      'BUTTON',
      body,
      { left: 10, top: 90, right: 110, bottom: 120, width: 100, height: 30 },
      { opacity: '0' },
    );
    const offscreen = element('BUTTON', body, { left: 900, top: 10, right: 1_000, bottom: 40, width: 100, height: 30 });
    body.children.push(visible, hiddenAncestor, transparent, offscreen);
    hiddenAncestor.children.push(hiddenChild);
    const allTextNodes = [
      { parentElement: visible, textContent: 'Visible control' },
      { parentElement: hiddenChild, textContent: 'HIDDEN_ANCESTOR_INJECTION' },
      { parentElement: transparent, textContent: 'TRANSPARENT_INJECTION' },
      { parentElement: offscreen, textContent: 'OFFSCREEN_INJECTION' },
    ];
    const result = vm.runInNewContext(browserInspectionExpression(), {
      CSS: { escape: (value: string) => value },
      document: {
        body,
        createRange: () => {
          let selected: { parentElement: { getBoundingClientRect: () => unknown } } | null = null;
          return {
            selectNodeContents: (node: typeof selected) => {
              selected = node;
            },
            getClientRects: () => (selected ? [selected.parentElement.getBoundingClientRect()] : []),
            detach: () => undefined,
          };
        },
        createTreeWalker: (root: unknown) => {
          const nodes = root === body ? allTextNodes : allTextNodes.filter((node) => node.parentElement === root);
          let index = 0;
          return { nextNode: () => nodes[index++] ?? null };
        },
        elementsFromPoint: (x: number, y: number) => {
          const candidate = [visible, hiddenChild, transparent, offscreen].find((node) => {
            const rect = node.getBoundingClientRect();
            return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
          });
          return candidate ? [candidate, candidate.parentElement, body] : [body];
        },
        querySelectorAll: () => [visible, hiddenChild, transparent, offscreen],
      },
      getComputedStyle: (node: { style?: Record<string, string> }) => ({
        display: node.style?.display ?? 'block',
        opacity: node.style?.opacity ?? '1',
        visibility: node.style?.visibility ?? 'visible',
      }),
      innerHeight: 600,
      innerWidth: 800,
      NodeFilter: { SHOW_TEXT: 4 },
      scrollX: 0,
      scrollY: 0,
    }) as { visibleText: string; elements: Array<{ text: string }> };

    expect(result.visibleText).toBe('Visible control');
    expect(result.elements).toEqual([expect.objectContaining({ text: 'Visible control' })]);
    expect(JSON.stringify(result)).not.toMatch(/HIDDEN_ANCESTOR|TRANSPARENT|OFFSCREEN/);
  });

  it('excludes controls and text concealed by overlays or clipping hit tests', () => {
    const body = {
      children: [] as unknown[],
      contains: (candidate: unknown) => candidate !== null,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }),
      hidden: false,
      nodeType: 1,
      parentElement: null,
      tagName: 'BODY',
    };
    const makeButton = (left: number, textContent: string) => ({
      children: [] as unknown[],
      contains: (candidate: unknown) => candidate === null,
      disabled: false,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ left, top: 20, right: left + 100, bottom: 50, width: 100, height: 30 }),
      hidden: false,
      id: '',
      nodeType: 1,
      parentElement: body,
      tagName: 'BUTTON',
      textContent,
    });
    const occluded = makeButton(10, 'OCCLUDED_INJECTION');
    const clipped = makeButton(200, 'CLIPPED_INJECTION');
    const overlay = {
      ...makeButton(10, ''),
      tagName: 'DIV',
    };
    body.children.push(occluded, clipped, overlay);
    const textNodes = [
      { parentElement: occluded, textContent: 'OCCLUDED_INJECTION' },
      { parentElement: clipped, textContent: 'CLIPPED_INJECTION' },
    ];
    const result = vm.runInNewContext(browserInspectionExpression(), {
      CSS: { escape: (value: string) => value },
      document: {
        body,
        createRange: () => {
          let selected: (typeof textNodes)[number] | null = null;
          return {
            selectNodeContents: (node: (typeof textNodes)[number]) => {
              selected = node;
            },
            getClientRects: () => (selected ? [selected.parentElement.getBoundingClientRect()] : []),
            detach: () => undefined,
          };
        },
        createTreeWalker: (root: unknown) => {
          const nodes = root === body ? textNodes : textNodes.filter((node) => node.parentElement === root);
          let index = 0;
          return { nextNode: () => nodes[index++] ?? null };
        },
        elementsFromPoint: (x: number) => (x < 150 ? [overlay, occluded, body] : [body]),
        querySelectorAll: () => [occluded, clipped],
      },
      getComputedStyle: () => ({ display: 'block', opacity: '1', visibility: 'visible' }),
      innerHeight: 600,
      innerWidth: 800,
      NodeFilter: { SHOW_TEXT: 4 },
      scrollX: 0,
      scrollY: 0,
    }) as { visibleText: string; elements: unknown[] };

    expect(result.visibleText).toBe('');
    expect(result.elements).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/OCCLUDED|CLIPPED/);
  });
});
