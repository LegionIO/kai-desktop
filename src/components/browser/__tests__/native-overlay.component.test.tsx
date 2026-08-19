import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserOverlayMayHaveChanged,
  collectRendererOverlayCandidates,
  hasIntersectingRendererOverlay,
  installRendererShadowRootCapture,
  isRendererOverlayMotionTarget,
  refreshRendererOverlayCandidates,
  rendererOverlayObservationRoots,
  shouldInstallNativeBrowserRendererGuards,
  subscribeRendererDeclarativeShadowChanges,
  subscribeRendererShadowRoots,
  subscribeRendererStylesheetChanges,
  updateRendererOverlayCandidates,
} from '../native-overlay';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
}

afterEach(() => {
  document.body.replaceChildren();
  document.head.querySelectorAll('[data-native-overlay-test-style]').forEach((element) => element.remove());
  vi.restoreAllMocks();
});

describe('native browser overlay detection', () => {
  it('installs startup guards only in a native Browser-capable renderer', () => {
    expect(shouldInstallNativeBrowserRendererGuards(undefined)).toBe(false);
    expect(shouldInstallNativeBrowserRendererGuards({ browser: {}, __isWebBridge: true })).toBe(false);
    expect(shouldInstallNativeBrowserRendererGuards({ browser: {} })).toBe(true);
  });

  it('detects an overlay that intersects only a corner of the native viewport', () => {
    const surface = document.createElement('div');
    const overlay = document.createElement('div');
    overlay.className = 'fixed';
    document.body.append(surface, overlay);
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 300));
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(rect(320, 0, 80, 40));
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn((x: number, y: number) => (x >= 320 && y <= 40 ? [overlay, surface] : [surface])),
    });

    expect(hasIntersectingRendererOverlay(surface)).toBe(true);
  });

  it('tracks an SVG overlay that paints above the native viewport', () => {
    const surface = document.createElement('div');
    const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlay.style.position = 'fixed';
    document.body.append(surface, overlay);
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 300));
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(rect(320, 0, 80, 40));
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn(() => [overlay, surface]),
    });

    const candidates = collectRendererOverlayCandidates(document.body, surface);
    expect(candidates.has(overlay)).toBe(true);
    expect(hasIntersectingRendererOverlay(surface, candidates)).toBe(true);
  });

  it('treats a transparent pointer-owning transition overlay as occluding the native view', () => {
    const surface = document.createElement('div');
    const overlay = document.createElement('div');
    overlay.className = 'fixed';
    overlay.style.opacity = '0';
    overlay.style.pointerEvents = 'auto';
    document.body.append(surface, overlay);
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 300));
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 300));
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn(() => [overlay, surface]),
    });

    expect(hasIntersectingRendererOverlay(surface)).toBe(true);
  });

  it('fails closed for an intersecting clipped overlay whose visible sliver evades sampled points', () => {
    const surface = document.createElement('div');
    const overlay = document.createElement('div');
    overlay.style.clipPath = 'polygon(40% 0, 60% 0, 60% 10%, 40% 10%)';
    document.body.append(surface, overlay);
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 300));
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 300));
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn((x: number, y: number) => (x >= 160 && x <= 240 && y <= 30 ? [overlay, surface] : [surface])),
    });

    expect(hasIntersectingRendererOverlay(surface)).toBe(true);
  });

  it('detects an ancestor pseudo-element scrim retargeted to its containing host', () => {
    const style = document.createElement('style');
    style.setAttribute('data-native-overlay-test-style', '');
    style.textContent = '.pseudo-scrim-host::after { content: ""; position: fixed; inset: 0; }';
    document.head.append(style);
    const host = document.createElement('div');
    host.className = 'pseudo-scrim-host';
    const surface = document.createElement('div');
    host.append(surface);
    document.body.append(host);
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 300));
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 300));
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      // Chromium reports a pseudo-element as its originating host. Its place
      // ahead of the child surface is the observable evidence that it paints
      // over the native-view bounds.
      value: vi.fn(() => [host, surface]),
    });

    const candidates = collectRendererOverlayCandidates(document.body, surface);
    expect(candidates.has(host)).toBe(true);
    expect(hasIntersectingRendererOverlay(surface, candidates)).toBe(true);
  });

  it('fails closed for a fixed pseudo-element whose originating host has no box', () => {
    const style = document.createElement('style');
    style.setAttribute('data-native-overlay-test-style', '');
    style.textContent = '.pseudo-portal::before { content: ""; position: fixed; inset: 0; }';
    document.head.append(style);
    const surface = document.createElement('div');
    const host = document.createElement('div');
    host.className = 'pseudo-portal';
    document.body.append(surface, host);
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 300));
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 0, 0));
    const pseudoStyle = document.createElement('span').style;
    pseudoStyle.content = '""';
    pseudoStyle.display = 'block';
    pseudoStyle.visibility = 'visible';
    pseudoStyle.position = 'fixed';
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) =>
      element === host && pseudo ? pseudoStyle : nativeGetComputedStyle(element),
    );
    const cssDescriptor = Object.getOwnPropertyDescriptor(window, 'CSS');
    Object.defineProperty(window, 'CSS', { configurable: true, value: { supports: () => true } });

    try {
      expect(hasIntersectingRendererOverlay(surface, collectRendererOverlayCandidates(document.body))).toBe(true);
    } finally {
      if (cssDescriptor) Object.defineProperty(window, 'CSS', cssDescriptor);
      else Reflect.deleteProperty(window, 'CSS');
    }
  });

  it('does not treat an ordinary containing ancestor as an overlay', () => {
    const host = document.createElement('div');
    const surface = document.createElement('div');
    host.append(surface);
    document.body.append(host);
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 300));
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 300));
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn(() => [surface, host]),
    });

    const candidates = collectRendererOverlayCandidates(document.body, surface);
    expect(candidates.has(host)).toBe(false);
    expect(hasIntersectingRendererOverlay(surface, candidates)).toBe(false);
  });

  it.each([
    ['fixed positioning', '.stylesheet-overlay { position: fixed; }'],
    ['sticky positioning', '.stylesheet-overlay { position: sticky; }'],
    ['a transform', '.stylesheet-overlay { transform: translateX(1px); }'],
    ['a flex-item z-index', '.overlay-layout { display: flex; } .stylesheet-overlay { z-index: 20; }'],
  ])('discovers an overlay defined only by stylesheet %s', (_label, rules) => {
    const style = document.createElement('style');
    style.setAttribute('data-native-overlay-test-style', '');
    style.textContent = rules;
    document.head.append(style);
    const surface = document.createElement('div');
    const layout = document.createElement('div');
    layout.className = 'overlay-layout';
    const overlay = document.createElement('div');
    overlay.className = 'stylesheet-overlay';
    layout.append(overlay);
    document.body.append(surface, layout);
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 300));
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(rect(320, 0, 80, 40));
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn(() => [overlay, surface]),
    });

    const candidates = collectRendererOverlayCandidates(document.body, surface);
    expect(candidates.has(overlay)).toBe(true);
    expect(hasIntersectingRendererOverlay(surface, candidates)).toBe(true);
  });

  it('rebuilds computed candidates when stylesheet text alone reveals an existing overlay', async () => {
    const style = document.createElement('style');
    style.setAttribute('data-native-overlay-test-style', '');
    style.textContent = '.stylesheet-overlay { display: none; position: fixed; }';
    document.head.append(style);
    const surface = document.createElement('div');
    const overlay = document.createElement('div');
    overlay.className = 'stylesheet-overlay';
    document.body.append(surface, overlay);
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 300));
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(rect(320, 0, 80, 40));
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn(() => [overlay, surface]),
    });
    const candidates = collectRendererOverlayCandidates(document.body, surface);
    expect(candidates.has(overlay)).toBe(false);
    const batches: MutationRecord[][] = [];
    const observer = new MutationObserver((records) => batches.push(records));
    observer.observe(style, { childList: true, subtree: true, characterData: true });

    style.textContent = '.stylesheet-overlay { display: block; position: fixed; }';
    await Promise.resolve();
    const records = batches.shift() ?? [];
    updateRendererOverlayCandidates(candidates, records);

    expect(browserOverlayMayHaveChanged(records, candidates)).toBe(true);
    expect(candidates.has(overlay)).toBe(true);
    expect(hasIntersectingRendererOverlay(surface, candidates)).toBe(true);
    observer.disconnect();
  });

  it('signals CSSOM rule mutations that have no DOM mutation record', () => {
    const style = document.createElement('style');
    style.setAttribute('data-native-overlay-test-style', '');
    document.head.append(style);
    const candidates = collectRendererOverlayCandidates(document.body);
    const onChange = vi.fn();
    const unsubscribe = subscribeRendererStylesheetChanges(candidates, document, onChange);
    expect(Object.getOwnPropertyDescriptor(window.CSSStyleSheet.prototype, 'insertRule')?.configurable).toBe(false);
    expect(() =>
      Object.defineProperty(window.CSSStyleSheet.prototype, 'insertRule', {
        configurable: true,
        value: vi.fn(),
      }),
    ).toThrow(TypeError);

    expect(style.sheet).not.toBeNull();
    style.sheet!.insertRule('.cssom-overlay { position: fixed; }', 0);
    expect(onChange).toHaveBeenCalledOnce();

    unsubscribe();
    style.sheet!.deleteRule(0);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('detects separated cards inside a pointer-transparent overlay host', () => {
    const surface = document.createElement('div');
    const host = document.createElement('div');
    const upperCard = document.createElement('div');
    const lowerCard = document.createElement('div');
    host.className = 'fixed';
    host.style.pointerEvents = 'none';
    upperCard.style.pointerEvents = 'auto';
    lowerCard.style.pointerEvents = 'auto';
    host.append(upperCard, lowerCard);
    document.body.append(surface, host);
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 500, 300));
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect(300, 0, 200, 300));
    vi.spyOn(upperCard, 'getBoundingClientRect').mockReturnValue(rect(330, 20, 140, 50));
    vi.spyOn(lowerCard, 'getBoundingClientRect').mockReturnValue(rect(330, 230, 140, 50));
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn((x: number, y: number) => {
        if (x >= 330 && x <= 470 && y >= 20 && y <= 70) return [upperCard, surface];
        if (x >= 330 && x <= 470 && y >= 230 && y <= 280) return [lowerCard, surface];
        return [surface];
      }),
    });

    expect(hasIntersectingRendererOverlay(surface)).toBe(true);
  });

  it('detects an overlay inside an open shadow root through its document-level host', () => {
    const surface = document.createElement('div');
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.className = 'fixed';
    root.append(dialog);
    document.body.append(surface, host);
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 300));
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect(280, 0, 120, 80));
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(rect(280, 0, 120, 80));
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn(() => [host, surface]),
    });

    const candidates = collectRendererOverlayCandidates(document.body);
    expect(candidates.has(dialog)).toBe(true);
    expect(rendererOverlayObservationRoots(candidates)).toContain(root);
    expect(hasIntersectingRendererOverlay(surface, candidates)).toBe(true);
  });

  it('discovers a closed shadow root created before its detached host is connected', () => {
    const surface = document.createElement('div');
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'closed' });
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    root.append(dialog);
    document.body.append(surface, host);

    const candidates = collectRendererOverlayCandidates(document.body);

    expect(host.shadowRoot).toBeNull();
    expect(rendererOverlayObservationRoots(candidates)).toContain(root);
    expect(candidates).toEqual(new Set([host, dialog]));
  });

  it('hit-tests interactive closed-root children inside a pointer-transparent host', () => {
    const surface = document.createElement('div');
    const host = document.createElement('div');
    host.className = 'fixed';
    host.style.pointerEvents = 'none';
    const root = host.attachShadow({ mode: 'closed' });
    const button = document.createElement('button');
    button.style.pointerEvents = 'auto';
    root.append(button);
    document.body.append(surface, host);
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 300));
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect(280, 0, 120, 80));
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(rect(280, 0, 120, 80));
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn(() => [host, surface]),
    });

    expect(hasIntersectingRendererOverlay(surface, collectRendererOverlayCandidates(document.body))).toBe(true);
  });

  it('tracks overlays added later inside an observed open shadow root', async () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    document.body.append(host);
    const candidates = collectRendererOverlayCandidates(document.body);
    const batches: MutationRecord[][] = [];
    const observer = new MutationObserver((records) => batches.push(records));
    for (const observedRoot of rendererOverlayObservationRoots(candidates)) {
      observer.observe(observedRoot, { childList: true, subtree: true });
    }

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    root.append(dialog);
    await Promise.resolve();
    updateRendererOverlayCandidates(candidates, batches.shift() ?? []);

    expect(candidates.has(dialog)).toBe(true);
    observer.disconnect();
  });

  it('registers a shadow root attached after its host is already connected', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const candidates = collectRendererOverlayCandidates(document.body);
    const batches: MutationRecord[][] = [];
    const observer = new MutationObserver((records) => batches.push(records));
    const onRoot = vi.fn((root: ShadowRoot) => observer.observe(root, { childList: true, subtree: true }));
    const unsubscribe = subscribeRendererShadowRoots(candidates, document.body, onRoot);
    try {
      const root = host.attachShadow({ mode: 'open' });
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      root.append(dialog);
      await Promise.resolve();
      updateRendererOverlayCandidates(candidates, batches.shift() ?? []);

      expect(onRoot).toHaveBeenCalledWith(root);
      expect(rendererOverlayObservationRoots(candidates)).toContain(root);
      expect(candidates.has(host)).toBe(true);
      expect(candidates.has(dialog)).toBe(true);
    } finally {
      unsubscribe();
      observer.disconnect();
    }
  });

  it('keeps discovering roots after later code replaces attachShadow', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const candidates = collectRendererOverlayCandidates(document.body);
    const onRoot = vi.fn();
    const unsubscribe = subscribeRendererShadowRoots(candidates, document.body, onRoot);
    const capturedHook = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      return capturedHook.call(this, init);
    };
    try {
      const root = host.attachShadow({ mode: 'open' });
      expect(onRoot).toHaveBeenCalledWith(root);
      expect(rendererOverlayObservationRoots(candidates)).toContain(root);
      expect(candidates.has(host)).toBe(true);
    } finally {
      Element.prototype.attachShadow = capturedHook;
      unsubscribe();
    }
  });

  it('forgets shadow roots when their hosts are removed', async () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    root.append(dialog);
    document.body.append(host);
    const candidates = collectRendererOverlayCandidates(document.body);
    const batches: MutationRecord[][] = [];
    const observer = new MutationObserver((records) => batches.push(records));
    observer.observe(document.body, { childList: true, subtree: true });

    expect(rendererOverlayObservationRoots(candidates)).toContain(root);
    host.remove();
    await Promise.resolve();
    const records = batches.shift() ?? [];
    updateRendererOverlayCandidates(candidates, records);

    expect(rendererOverlayObservationRoots(candidates)).not.toContain(root);
    expect(candidates.has(dialog)).toBe(false);
    expect(browserOverlayMayHaveChanged(records, candidates)).toBe(true);
    observer.disconnect();
  });

  it('fails closed when an interactive child follows the pointer-transparent traversal budget', () => {
    const surface = document.createElement('div');
    const host = document.createElement('div');
    host.className = 'fixed';
    host.style.pointerEvents = 'none';
    for (let index = 0; index < 256; index++) {
      const decoy = document.createElement('span');
      decoy.style.pointerEvents = 'none';
      host.append(decoy);
    }
    const lateCard = document.createElement('button');
    lateCard.style.pointerEvents = 'auto';
    host.append(lateCard);
    document.body.append(surface, host);
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 500, 300));
    vi.spyOn(lateCard, 'getBoundingClientRect').mockReturnValue(rect(330, 20, 140, 50));

    expect(hasIntersectingRendererOverlay(surface)).toBe(true);
  });

  it('ignores intersecting layout content that paints behind the native viewport', () => {
    const surface = document.createElement('div');
    const behind = document.createElement('div');
    behind.className = 'absolute';
    document.body.append(behind, surface);
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 300));
    vi.spyOn(behind, 'getBoundingClientRect').mockReturnValue(rect(300, 0, 100, 40));
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn(() => [surface, behind]),
    });

    expect(hasIntersectingRendererOverlay(surface)).toBe(false);
  });

  it('ignores ordinary streaming mutations but reacts to overlay additions and removals', async () => {
    const content = document.createElement('main');
    document.body.append(content);
    const batches: MutationRecord[][] = [];
    const observer = new MutationObserver((records) => batches.push(records));
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['class'],
    });

    content.append(document.createElement('span'));
    await Promise.resolve();
    expect(browserOverlayMayHaveChanged(batches.shift() ?? [], collectRendererOverlayCandidates(document.body))).toBe(
      false,
    );

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.className = 'fixed';
    document.body.append(dialog);
    await Promise.resolve();
    expect(browserOverlayMayHaveChanged(batches.shift() ?? [], collectRendererOverlayCandidates(document.body))).toBe(
      true,
    );

    dialog.remove();
    await Promise.resolve();
    expect(browserOverlayMayHaveChanged(batches.shift() ?? [], collectRendererOverlayCandidates(document.body))).toBe(
      true,
    );
    observer.disconnect();
  });

  it('tracks geometry motion for overlay elements but not nested spinners', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const spinner = document.createElement('span');
    dialog.append(spinner);
    document.body.append(dialog);

    const candidates = collectRendererOverlayCandidates(document.body);
    expect(isRendererOverlayMotionTarget(dialog, candidates)).toBe(true);
    expect(isRendererOverlayMotionTarget(spinner, candidates)).toBe(false);
  });

  it('reacts when an ordinary ancestor reveals or animates a tracked overlay', async () => {
    const wrapper = document.createElement('section');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    wrapper.append(dialog);
    document.body.append(wrapper);
    const candidates = collectRendererOverlayCandidates(document.body);
    const batches: MutationRecord[][] = [];
    const observer = new MutationObserver((records) => batches.push(records));
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['hidden'],
    });

    wrapper.hidden = true;
    await Promise.resolve();

    const records = batches.shift() ?? [];
    updateRendererOverlayCandidates(candidates, records);
    expect(browserOverlayMayHaveChanged(records, candidates)).toBe(true);
    expect(isRendererOverlayMotionTarget(wrapper, candidates)).toBe(true);
    observer.disconnect();
  });

  it('keeps the candidate set current as overlays are added and removed', async () => {
    const content = document.createElement('main');
    const ordinary = document.createElement('p');
    content.append(ordinary);
    document.body.append(content);
    const candidates = collectRendererOverlayCandidates(document.body);
    const batches: MutationRecord[][] = [];
    const observer = new MutationObserver((records) => batches.push(records));
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

    expect(candidates.size).toBe(0);
    const dialog = document.createElement('div');
    dialog.className = 'fixed';
    document.body.append(dialog);
    await Promise.resolve();
    updateRendererOverlayCandidates(candidates, batches.shift() ?? []);
    expect(candidates).toEqual(new Set([dialog]));

    dialog.remove();
    await Promise.resolve();
    updateRendererOverlayCandidates(candidates, batches.shift() ?? []);
    expect(candidates.size).toBe(0);
    observer.disconnect();
  });

  it('reports removal of an unstyled overlay tracked only through geometry', async () => {
    const surface = document.createElement('div');
    const overlap = document.createElement('div');
    document.body.append(surface, overlap);
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 300));
    vi.spyOn(overlap, 'getBoundingClientRect').mockReturnValue(rect(320, 0, 80, 40));
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn(() => [overlap, surface]),
    });
    const candidates = collectRendererOverlayCandidates(document.body, surface);
    expect(candidates.has(overlap)).toBe(true);
    const batches: MutationRecord[][] = [];
    const observer = new MutationObserver((records) => batches.push(records));
    observer.observe(document.body, { childList: true });

    overlap.remove();
    await Promise.resolve();
    const changed = updateRendererOverlayCandidates(candidates, batches.shift() ?? []);

    expect(changed).toBe(true);
    expect(candidates.has(overlap)).toBe(false);
    observer.disconnect();
  });

  it('caps tracked overlay candidates and fails closed instead of doing unbounded geometry work', () => {
    const surface = document.createElement('div');
    document.body.append(surface);
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 300));
    const candidateRects: Array<ReturnType<typeof vi.spyOn>> = [];
    for (let index = 0; index < 513; index++) {
      const overlay = document.createElement('div');
      overlay.className = 'absolute';
      document.body.append(overlay);
      candidateRects.push(vi.spyOn(overlay, 'getBoundingClientRect'));
    }

    const candidates = collectRendererOverlayCandidates(document.body);
    expect(candidates.size).toBe(512);
    expect(hasIntersectingRendererOverlay(surface, candidates)).toBe(true);
    expect(candidateRects.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  it('keeps a large ordinary DOM mounted and still discovers a late shadow overlay', () => {
    const surface = document.createElement('div');
    const ordinaryTree = document.createElement('main');
    for (let index = 0; index < 4_097; index++) ordinaryTree.append(document.createElement('span'));
    document.body.append(surface, ordinaryTree);
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 300));
    expect(hasIntersectingRendererOverlay(surface, collectRendererOverlayCandidates(document.body))).toBe(false);

    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'closed' });
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    root.append(dialog);
    ordinaryTree.append(host);
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect(320, 0, 80, 40));
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(rect(320, 0, 80, 40));
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn(() => [host, surface]),
    });

    const candidates = collectRendererOverlayCandidates(document.body);
    expect(candidates).toEqual(new Set([host, dialog]));
    expect(hasIntersectingRendererOverlay(surface, candidates)).toBe(true);
  });

  it('does not perform layout work for ordinary page elements on each check', () => {
    const surface = document.createElement('div');
    const ordinary = document.createElement('main');
    const overlay = document.createElement('div');
    overlay.className = 'fixed';
    document.body.append(ordinary, surface, overlay);
    const ordinaryRect = vi.spyOn(ordinary, 'getBoundingClientRect');
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 300));
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(rect(320, 0, 80, 40));
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn(() => [overlay, surface]),
    });

    expect(hasIntersectingRendererOverlay(surface, collectRendererOverlayCandidates(document.body))).toBe(true);
    expect(ordinaryRect).not.toHaveBeenCalled();
  });

  it('ignores sidebar chrome explicitly excluded from native-view occlusion', () => {
    const surface = document.createElement('div');
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'absolute';
    resizeHandle.setAttribute('data-native-browser-overlay-ignore', '');
    document.body.append(resizeHandle, surface);
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 300));
    vi.spyOn(resizeHandle, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 4, 300));
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn(() => [resizeHandle, surface]),
    });

    expect(hasIntersectingRendererOverlay(surface, collectRendererOverlayCandidates(document.body))).toBe(false);
  });

  it('fails closed when an HTML parser API creates an opaque declarative shadow tree', () => {
    const prototype = Element.prototype as Element['constructor']['prototype'] & {
      setHTMLUnsafe?: (markup: string) => void;
    };
    Object.defineProperty(prototype, 'setHTMLUnsafe', {
      configurable: true,
      writable: true,
      value: function (this: Element) {
        this.replaceChildren(document.createElement('span'));
      },
    });
    expect(installRendererShadowRootCapture(document)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(window.Element.prototype, 'attachShadow')?.configurable).toBe(false);
    expect(() =>
      Object.defineProperty(window.Element.prototype, 'attachShadow', {
        configurable: true,
        value: vi.fn(),
      }),
    ).toThrow(TypeError);
    const surface = document.createElement('div');
    const host = document.createElement('section') as Element & { setHTMLUnsafe: (markup: string) => void };
    document.body.append(surface, host);
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 300));
    const candidates = collectRendererOverlayCandidates(document.body, surface);
    const onChange = vi.fn(() => refreshRendererOverlayCandidates(candidates));
    const unsubscribe = subscribeRendererDeclarativeShadowChanges(candidates, document, onChange);
    expect(hasIntersectingRendererOverlay(surface, candidates)).toBe(false);

    host.setHTMLUnsafe('<template shadowrootmode="closed"><div role="dialog"></div></template>');
    expect(onChange).toHaveBeenCalledOnce();
    expect(hasIntersectingRendererOverlay(surface, candidates)).toBe(true);

    host.setHTMLUnsafe('<span>ordinary content</span>');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(hasIntersectingRendererOverlay(surface, candidates)).toBe(false);
    unsubscribe();
  });
});
