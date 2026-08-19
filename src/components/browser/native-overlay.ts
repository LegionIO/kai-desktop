function intersects(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function stackAt(document: Document, x: number, y: number): Element[] {
  if (typeof document.elementsFromPoint === 'function') return document.elementsFromPoint(x, y);
  const top = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
  return top ? [top] : [];
}

const OVERLAY_HINT_SELECTOR = [
  '[aria-modal="true"]',
  '[data-radix-popper-content-wrapper]',
  '[data-radix-portal]',
  '[popover]',
  'dialog',
  '[role="alert"]',
  '[role="alertdialog"]',
  '[role="dialog"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="tooltip"]',
  // Fast-path framework/inline hints. Computed discovery below is the
  // authority, so stylesheet-defined equivalents are covered too.
  '[class~="absolute"]',
  '[class~="fixed"]',
  '[class~="sticky"]',
  '[style*="position: absolute"]',
  '[style*="position:absolute"]',
  '[style*="position: fixed"]',
  '[style*="position:fixed"]',
  '[style*="position: sticky"]',
  '[style*="position:sticky"]',
].join(',');

const OVERLAY_IGNORE_SELECTOR = '[data-native-browser-overlay-ignore]';
const MAX_POINTER_TRANSPARENT_OVERLAY_DESCENDANTS = 256;
const MAX_RENDERER_OVERLAY_CANDIDATES = 512;
const MAX_RENDERER_OVERLAY_DISCOVERY_NODES = 20_000;

export type RendererOverlayCandidates = Set<Element>;

// A capped set cannot identify which omitted overlay intersects the native
// surface. Fail closed while overflowed: hiding the WebContentsView is safer
// than allowing it to paint over or intercept an untracked renderer dialog.
const overflowedOverlayCandidateSets = new WeakSet<RendererOverlayCandidates>();
const shadowRootsByCandidateSet = new WeakMap<RendererOverlayCandidates, Set<ShadowRoot>>();
const overlayCandidateContexts = new WeakMap<
  RendererOverlayCandidates,
  { root: ParentNode; surface: HTMLElement | null }
>();
// Element.shadowRoot intentionally hides closed roots. Capture every root at
// creation time so the Browser panel can still observe and hit-test overlays in
// closed custom elements, including roots created while the panel is unmounted.
const capturedShadowRootsByHost = new WeakMap<Element, ShadowRoot>();
type AttachShadowMethod = (this: Element, init: ShadowRootInit) => ShadowRoot;
type AttachShadowPatch = {
  original: AttachShadowMethod;
  delegate: AttachShadowMethod;
  wrapper: AttachShadowMethod;
  listeners: Set<(host: Element, root: ShadowRoot) => void>;
};
const attachShadowPatches = new WeakMap<object, AttachShadowPatch>();
const unpatchableAttachShadowPrototypes = new WeakSet<object>();

type DeclarativeShadowChangeListener = (root: ParentNode) => void;
type HtmlInjectionMethod = (this: unknown, markup: unknown, ...options: unknown[]) => unknown;
type HtmlInjectionMethodPatch = {
  original: HtmlInjectionMethod;
  delegate: HtmlInjectionMethod;
  wrapper: HtmlInjectionMethod;
};
type DeclarativeShadowPatch = {
  listeners: Set<DeclarativeShadowChangeListener>;
};
type OpaqueDeclarativeTreeState = {
  token: object;
  elements: Set<Element>;
};
const declarativeShadowPatches = new WeakMap<object, DeclarativeShadowPatch>();
const unpatchableDeclarativeShadowRealms = new WeakSet<object>();
const installedHtmlInjectionMethods = new WeakMap<object, Map<string, () => boolean>>();
const opaqueDeclarativeTreeByTarget = new WeakMap<object, OpaqueDeclarativeTreeState>();
const opaqueDeclarativeTokensByElement = new WeakMap<Element, Set<object>>();
const pseudoSelectorCache = new WeakMap<object, { revision: number; selectors: string[] | null }>();
let pseudoStyleRevision = 0;
const MAX_PSEUDO_STYLE_SELECTORS = 4_096;

type StylesheetChangeListener = () => void;
type StylesheetMethod = (this: unknown, ...args: unknown[]) => unknown;
type StylesheetMethodPatch = {
  original: StylesheetMethod;
  delegate: StylesheetMethod;
  wrapper: StylesheetMethod;
};
type StylesheetChangePatch = {
  listeners: Set<StylesheetChangeListener>;
  integrityChecks: Array<() => boolean>;
};
type StylesheetMethodTarget = {
  prototype: object;
  name: string;
  notifyWhen?: (receiver: unknown) => boolean;
  notifyAfterPromise?: boolean;
};
type StylesheetSetterTarget = {
  prototype: object;
  name: string;
  notifyWhen?: (receiver: unknown) => boolean;
  required?: boolean;
};
const stylesheetChangePatches = new WeakMap<object, StylesheetChangePatch>();
const unpatchableStylesheetRealms = new WeakSet<object>();

function rendererRealmPrototype(realm: Window, constructorName: string): object | null {
  const constructor = (realm as unknown as Record<string, { prototype?: object } | undefined>)[constructorName];
  return constructor?.prototype ?? null;
}

function rendererRealmConstructor(realm: Window, constructorName: string): object | null {
  const constructor = (realm as unknown as Record<string, object | undefined>)[constructorName];
  return constructor ?? null;
}

function notifyStylesheetChange(listeners: Set<StylesheetChangeListener>): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // CSSOM mutation APIs must preserve their native contract even when a
      // Browser panel is concurrently unmounting.
    }
  }
}

function stylesheetMethodTargets(realm: Window): StylesheetMethodTarget[] {
  const targets: StylesheetMethodTarget[] = [];
  const add = (
    constructorName: string,
    names: string[],
    options?: Pick<StylesheetMethodTarget, 'notifyWhen' | 'notifyAfterPromise'>,
  ) => {
    const prototype = rendererRealmPrototype(realm, constructorName);
    if (!prototype) return;
    for (const name of names) targets.push({ prototype, name, ...options });
  };
  add('CSSStyleSheet', ['insertRule', 'deleteRule', 'addRule', 'removeRule']);
  add('CSSStyleSheet', ['replace'], { notifyAfterPromise: true });
  add('CSSStyleSheet', ['replaceSync']);
  add('CSSGroupingRule', ['insertRule', 'deleteRule']);
  add('CSSKeyframesRule', ['appendRule', 'deleteRule']);
  add('MediaList', ['appendMedium', 'deleteMedium']);
  add('CSSStyleDeclaration', ['setProperty', 'removeProperty'], {
    // Inline declarations already produce an observed `style` attribute
    // mutation. Rule declarations do not, so signal only the invisible case.
    notifyWhen: (receiver) => !!(receiver as { parentRule?: unknown } | null)?.parentRule,
  });
  return targets;
}

function stylesheetSetterTargets(realm: Window): StylesheetSetterTarget[] {
  const targets: StylesheetSetterTarget[] = [];
  const add = (
    constructorName: string,
    names: string[],
    options?: Pick<StylesheetSetterTarget, 'notifyWhen' | 'required'>,
  ) => {
    const prototype = rendererRealmPrototype(realm, constructorName);
    if (!prototype) return;
    for (const name of names) targets.push({ prototype, name, ...options });
  };
  add('Document', ['adoptedStyleSheets']);
  add('ShadowRoot', ['adoptedStyleSheets']);
  add('CSSStyleSheet', ['disabled']);
  // jsdom and some older Chromium builds expose this legacy setter as
  // non-configurable. Rule-declaration setProperty/cssText and stylesheet rule
  // insertion remain covered there, so do not disable the entire Browser for
  // this redundant hook.
  add('CSSStyleRule', ['cssText'], { required: false });
  add('CSSStyleRule', ['selectorText']);
  add('CSSStyleDeclaration', ['cssText'], {
    notifyWhen: (receiver) => !!(receiver as { parentRule?: unknown } | null)?.parentRule,
  });
  const declarationPrototype = rendererRealmPrototype(realm, 'CSSStyleDeclaration');
  if (declarationPrototype) {
    for (const name of Object.getOwnPropertyNames(declarationPrototype)) {
      if (name === 'constructor' || name === 'cssText') continue;
      const descriptor = Object.getOwnPropertyDescriptor(declarationPrototype, name);
      if (typeof descriptor?.set !== 'function') continue;
      targets.push({
        prototype: declarationPrototype,
        name,
        // Direct assignments such as rule.style.position = 'fixed' bypass
        // setProperty() in Chromium's WebIDL bindings.
        notifyWhen: (receiver) => !!(receiver as { parentRule?: unknown } | null)?.parentRule,
        required: false,
      });
    }
  }
  add('CSSMediaRule', ['conditionText']);
  add('CSSSupportsRule', ['conditionText']);
  add('MediaList', ['mediaText']);
  return targets;
}

function installStylesheetMethodPatch(
  target: StylesheetMethodTarget,
  listeners: Set<StylesheetChangeListener>,
  integrityChecks: Array<() => boolean>,
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(target.prototype, target.name);
  if (!descriptor) return true;
  if (!descriptor.configurable || typeof descriptor.value !== 'function') return false;
  const original = descriptor.value as StylesheetMethod;
  const entry = { original, delegate: original } as StylesheetMethodPatch;
  let invokingDelegate = false;
  const wrapper: StylesheetMethod = function (...args) {
    if (invokingDelegate) return Reflect.apply(original, this, args);
    let result: unknown;
    invokingDelegate = true;
    try {
      result = Reflect.apply(entry.delegate, this, args);
    } finally {
      invokingDelegate = false;
    }
    if (target.notifyWhen?.(this) !== false) {
      notifyStylesheetChange(listeners);
      if (target.notifyAfterPromise && result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(result).then(
          () => notifyStylesheetChange(listeners),
          () => undefined,
        );
      }
    }
    return result;
  };
  entry.wrapper = wrapper;
  const accessorGet = () => wrapper;
  const accessorSet = (next: StylesheetMethod) => {
    if (next === wrapper) entry.delegate = original;
    else if (typeof next === 'function') entry.delegate = next;
  };
  Object.defineProperty(target.prototype, target.name, {
    // Assignment-based polyfills still flow through the delegate setter. Do
    // not permit defineProperty/delete to remove the safety hook after a native
    // view is mounted: CSSOM changes can otherwise evade every DOM observer.
    configurable: false,
    enumerable: descriptor.enumerable ?? false,
    get: accessorGet,
    set: accessorSet,
  });
  integrityChecks.push(() => {
    try {
      const current = Object.getOwnPropertyDescriptor(target.prototype, target.name);
      return current?.get === accessorGet && current?.set === accessorSet;
    } catch {
      return false;
    }
  });
  return true;
}

function installStylesheetSetterPatch(
  target: StylesheetSetterTarget,
  listeners: Set<StylesheetChangeListener>,
  integrityChecks: Array<() => boolean>,
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(target.prototype, target.name);
  if (!descriptor) return true;
  if (!descriptor.configurable || typeof descriptor.set !== 'function') return false;
  const getter = descriptor.get;
  const setter = descriptor.set;
  const accessorGet = getter
    ? function (this: unknown) {
        return Reflect.apply(getter, this, []);
      }
    : undefined;
  const accessorSet = function (this: unknown, value: unknown) {
    Reflect.apply(setter, this, [value]);
    if (target.notifyWhen?.(this) !== false) notifyStylesheetChange(listeners);
  };
  Object.defineProperty(target.prototype, target.name, {
    configurable: false,
    enumerable: descriptor.enumerable ?? false,
    get: accessorGet,
    set: accessorSet,
  });
  integrityChecks.push(() => {
    try {
      const current = Object.getOwnPropertyDescriptor(target.prototype, target.name);
      return current?.get === accessorGet && current?.set === accessorSet;
    } catch {
      return false;
    }
  });
  return true;
}

function ensureStylesheetChangePatch(ownerDocument: Document): StylesheetChangePatch | null {
  const realm = ownerDocument.defaultView;
  if (!realm) return null;
  const existing = stylesheetChangePatches.get(realm);
  if (existing) {
    if (existing.integrityChecks.every((check) => check())) return existing;
    unpatchableStylesheetRealms.add(realm);
    return null;
  }
  if (unpatchableStylesheetRealms.has(realm)) return null;

  const listeners = new Set<StylesheetChangeListener>();
  const integrityChecks: Array<() => boolean> = [];
  try {
    for (const target of stylesheetMethodTargets(realm)) {
      if (!installStylesheetMethodPatch(target, listeners, integrityChecks)) {
        throw new Error('Unpatchable stylesheet method.');
      }
    }
    for (const target of stylesheetSetterTargets(realm)) {
      if (!installStylesheetSetterPatch(target, listeners, integrityChecks) && target.required !== false) {
        throw new Error('Unpatchable stylesheet setter.');
      }
    }
  } catch {
    // Some wrappers may already be permanent. Without complete coverage the
    // caller must fail closed; retaining the partial hooks remains harmless.
    unpatchableStylesheetRealms.add(realm);
    return null;
  }
  const patch = { listeners, integrityChecks };
  stylesheetChangePatches.set(realm, patch);
  return patch;
}

function markupMentionsDeclarativeShadow(markup: unknown): boolean {
  try {
    return /shadowrootmode/i.test(String(markup));
  } catch {
    return true;
  }
}

function markupMayCreateOpaqueDeclarativeShadow(root: ParentNode, markup: unknown): boolean {
  try {
    const source = String(markup);
    if (!/shadowrootmode/i.test(source)) return false;
    const rootNode = root as Node;
    const ownerDocument = rootNode.nodeType === 9 ? (root as Document) : rootNode.ownerDocument;
    if (!ownerDocument) return true;
    // Parse into an ordinary template: innerHTML intentionally preserves DSD
    // templates instead of instantiating them, giving us the browser's exact
    // attribute decoding without creating another inaccessible root.
    const container = ownerDocument.createElement('template');
    container.innerHTML = source;
    const pending: ParentNode[] = [container.content];
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const template of current.querySelectorAll('template')) {
        const mode = template.getAttribute('shadowrootmode');
        if (mode !== null && mode.trim().toLowerCase() !== 'open') return true;
        pending.push(template.content);
      }
    }
    return false;
  } catch {
    return true;
  }
}

function htmlMutationRoot(receiver: unknown, result: unknown): ParentNode | null {
  for (const candidate of [receiver, result]) {
    if (!candidate || typeof candidate !== 'object') continue;
    const node = candidate as Node & ParentNode;
    if (node.nodeType === 1 || node.nodeType === 9 || node.nodeType === 11) return node;
  }
  return null;
}

function clearOpaqueDeclarativeTree(state: OpaqueDeclarativeTreeState): void {
  for (const element of state.elements) {
    const tokens = opaqueDeclarativeTokensByElement.get(element);
    if (!tokens) continue;
    tokens.delete(state.token);
    if (tokens.size === 0) opaqueDeclarativeTokensByElement.delete(element);
  }
  state.elements.clear();
}

function updateOpaqueDeclarativeTree(root: ParentNode, opaque: boolean): boolean {
  const key = root as object;
  let state = opaqueDeclarativeTreeByTarget.get(key);
  const wasOpaque = !!state && state.elements.size > 0;
  if (!state) {
    state = { token: {}, elements: new Set() };
    opaqueDeclarativeTreeByTarget.set(key, state);
  } else {
    clearOpaqueDeclarativeTree(state);
  }
  if (!opaque) return wasOpaque;

  const mark = (element: Element | null | undefined) => {
    if (!element || state!.elements.has(element)) return;
    state!.elements.add(element);
    const tokens = opaqueDeclarativeTokensByElement.get(element) ?? new Set<object>();
    tokens.add(state!.token);
    opaqueDeclarativeTokensByElement.set(element, tokens);
  };
  const rootNode = root as Node & { host?: Element; documentElement?: Element | null };
  if (rootNode.nodeType === 1) mark(rootNode as unknown as Element);
  if (rootNode.nodeType === 9) mark(rootNode.documentElement);
  if (rootNode.nodeType === 11) mark(rootNode.host);
  for (const element of root.querySelectorAll('*')) mark(element);
  return true;
}

function hasOpaqueDeclarativeShadow(element: Element): boolean {
  return (opaqueDeclarativeTokensByElement.get(element)?.size ?? 0) > 0;
}

function installHtmlInjectionMethodPatch(
  target: object,
  name: string,
  listeners: Set<DeclarativeShadowChangeListener>,
): boolean {
  const existingIntegrityCheck = installedHtmlInjectionMethods.get(target)?.get(name);
  if (existingIntegrityCheck) return existingIntegrityCheck();
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  if (!descriptor) return true;
  if (!descriptor.configurable || typeof descriptor.value !== 'function') return false;
  const original = descriptor.value as HtmlInjectionMethod;
  const entry = { original, delegate: original } as HtmlInjectionMethodPatch;
  let invokingDelegate = false;
  const wrapper: HtmlInjectionMethod = function (markup, ...options) {
    if (invokingDelegate) return Reflect.apply(original, this, [markup, ...options]);
    let result: unknown;
    invokingDelegate = true;
    try {
      result = Reflect.apply(entry.delegate, this, [markup, ...options]);
    } finally {
      invokingDelegate = false;
    }
    const root = htmlMutationRoot(this, result);
    const opaque = root ? markupMayCreateOpaqueDeclarativeShadow(root, markup) : false;
    if (root && (updateOpaqueDeclarativeTree(root, opaque) || markupMentionsDeclarativeShadow(markup))) {
      for (const listener of [...listeners]) {
        try {
          listener(root);
        } catch {
          // Preserve the native parser contract while a Browser panel unmounts.
        }
      }
    }
    return result;
  };
  entry.wrapper = wrapper;
  const accessorGet = () => wrapper;
  const accessorSet = (next: HtmlInjectionMethod) => {
    if (next === wrapper) entry.delegate = original;
    else if (typeof next === 'function') entry.delegate = next;
  };
  Object.defineProperty(target, name, {
    // Keep parser instrumentation installed for the renderer lifetime. A
    // replacement could create an opaque declarative root without a mutation
    // visible to the Browser panel.
    configurable: false,
    enumerable: descriptor.enumerable ?? false,
    get: accessorGet,
    set: accessorSet,
  });
  const installed = installedHtmlInjectionMethods.get(target) ?? new Map<string, () => boolean>();
  installed.set(name, () => {
    try {
      const current = Object.getOwnPropertyDescriptor(target, name);
      return current?.get === accessorGet && current?.set === accessorSet;
    } catch {
      return false;
    }
  });
  installedHtmlInjectionMethods.set(target, installed);
  return true;
}

function installDeclarativeShadowTargets(realm: Window, listeners: Set<DeclarativeShadowChangeListener>): boolean {
  const targets = [
    { object: rendererRealmPrototype(realm, 'Element'), names: ['setHTML', 'setHTMLUnsafe'] },
    { object: rendererRealmPrototype(realm, 'ShadowRoot'), names: ['setHTML', 'setHTMLUnsafe'] },
    { object: rendererRealmConstructor(realm, 'Document'), names: ['parseHTML', 'parseHTMLUnsafe'] },
  ];
  for (const target of targets) {
    if (!target.object) continue;
    for (const name of target.names) {
      if (!installHtmlInjectionMethodPatch(target.object, name, listeners)) return false;
    }
  }
  return true;
}

function ensureDeclarativeShadowPatch(ownerDocument: Document): DeclarativeShadowPatch | null {
  const realm = ownerDocument.defaultView;
  if (!realm) return null;
  const existing = declarativeShadowPatches.get(realm);
  if (existing) {
    if (installDeclarativeShadowTargets(realm, existing.listeners)) return existing;
    unpatchableDeclarativeShadowRealms.add(realm);
    return null;
  }
  if (unpatchableDeclarativeShadowRealms.has(realm)) return null;

  const listeners = new Set<DeclarativeShadowChangeListener>();
  try {
    if (!installDeclarativeShadowTargets(realm, listeners)) throw new Error('Unpatchable HTML injection method.');
  } catch {
    unpatchableDeclarativeShadowRealms.add(realm);
    return null;
  }
  const patch = { listeners };
  declarativeShadowPatches.set(realm, patch);
  return patch;
}

function shadowRootForHost(host: Element): ShadowRoot | null {
  return host.shadowRoot ?? capturedShadowRootsByHost.get(host) ?? null;
}

function captureShadowRoot(host: Element, root: ShadowRoot): void {
  capturedShadowRootsByHost.set(host, root);
}

function ensureAttachShadowPatch(prototype: { attachShadow: AttachShadowMethod }): AttachShadowPatch | null {
  const existing = attachShadowPatches.get(prototype);
  if (existing) {
    try {
      if (prototype.attachShadow === existing.wrapper) return existing;
    } catch {
      // Fall through to the fail-closed path below.
    }
    unpatchableAttachShadowPrototypes.add(prototype);
    return null;
  }
  if (unpatchableAttachShadowPrototypes.has(prototype)) return null;

  const original = prototype.attachShadow;
  const listeners = new Set<(host: Element, root: ShadowRoot) => void>();
  const entry = { original, delegate: original, listeners } as AttachShadowPatch;
  let invokingDelegate = false;
  const wrapper: AttachShadowMethod = function (init) {
    // A later polyfill commonly captures the current wrapper, assigns its own
    // method, and delegates to the captured value. Route that re-entrant call
    // to the native implementation so the polyfill cannot recurse forever.
    if (invokingDelegate) return original.call(this, init);
    let root: ShadowRoot;
    invokingDelegate = true;
    try {
      root = entry.delegate.call(this, init);
    } finally {
      invokingDelegate = false;
    }
    captureShadowRoot(this, root);
    for (const listener of [...listeners]) {
      try {
        listener(this, root);
      } catch {
        // Preserve the native attachShadow contract. The listener registers
        // the host as a conservative candidate before observing the root.
      }
    }
    return root;
  };
  entry.wrapper = wrapper;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'attachShadow');
    // Assignment-based polyfills update the delegate while every call still
    // passes through the overlay hook. Refuse defineProperty/delete replacement
    // so a closed root cannot become unknowable while a native view is mounted.
    Object.defineProperty(prototype, 'attachShadow', {
      configurable: false,
      enumerable: descriptor?.enumerable ?? false,
      get: () => wrapper,
      set: (next: AttachShadowMethod) => {
        if (next === wrapper) entry.delegate = original;
        else if (typeof next === 'function') entry.delegate = next;
      },
    });
  } catch {
    unpatchableAttachShadowPrototypes.add(prototype);
    return null;
  }
  attachShadowPatches.set(prototype, entry);
  return entry;
}

/** Install during renderer module initialization, before React or plugin code
 * can create an inaccessible closed root. The subscription below adds panel-
 * specific observers later without losing roots created in between. */
export function installRendererShadowRootCapture(ownerDocument: Document): boolean {
  const prototype = ownerDocument.defaultView?.Element.prototype as { attachShadow: AttachShadowMethod } | undefined;
  return (
    !!prototype &&
    typeof prototype.attachShadow === 'function' &&
    ensureAttachShadowPatch(prototype) !== null &&
    ensureDeclarativeShadowPatch(ownerDocument) !== null
  );
}

/** Install before plugin renderers run so CSSOM methods cached later still pass
 * through the Browser native-view safety signal. */
export function installRendererStylesheetChangeCapture(ownerDocument: Document): boolean {
  return ensureStylesheetChangePatch(ownerDocument) !== null;
}

export function shouldInstallNativeBrowserRendererGuards(bridge: unknown): boolean {
  if (!bridge || typeof bridge !== 'object') return false;
  const candidate = bridge as { __isWebBridge?: unknown; browser?: unknown };
  return candidate.__isWebBridge !== true && !!candidate.browser && typeof candidate.browser === 'object';
}

if (
  typeof document !== 'undefined' &&
  typeof window !== 'undefined' &&
  shouldInstallNativeBrowserRendererGuards((window as unknown as { app?: unknown }).app)
) {
  installRendererShadowRootCapture(document);
  installRendererStylesheetChangeCapture(document);
}

function shadowIncludingContains(container: Node, candidate: Node): boolean {
  let current: Node | null = candidate;
  while (current) {
    if (current === container) return true;
    if (current.parentNode) {
      current = current.parentNode;
      continue;
    }
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}

function shadowIncludingClosest(element: Element, selector: string): Element | null {
  let current: Element | null = element;
  while (current) {
    const match = current.closest(selector);
    if (match) return match;
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

function documentHitTarget(element: Element): Element {
  let current = element;
  while (true) {
    const root = current.getRootNode();
    if (!(root instanceof ShadowRoot)) return current;
    current = root.host;
  }
}

function pushChildren(stack: Element[], root: ParentNode): void {
  for (let index = root.children.length - 1; index >= 0; index--) {
    const child = root.children[index];
    if (child) stack.push(child);
  }
}

function shadowIncludingDescendants(
  root: ParentNode,
  limit: number,
  onShadowRoot?: (root: ShadowRoot) => void,
): { elements: Element[]; truncated: boolean } {
  const stack: Element[] = [];
  pushChildren(stack, root);
  const rootShadow = root instanceof Element ? shadowRootForHost(root) : null;
  if (rootShadow) {
    onShadowRoot?.(rootShadow);
    pushChildren(stack, rootShadow);
  }
  const elements: Element[] = [];
  while (stack.length > 0 && elements.length < limit) {
    const element = stack.pop();
    if (!element) continue;
    elements.push(element);
    pushChildren(stack, element);
    const shadowRoot = shadowRootForHost(element);
    if (shadowRoot) {
      onShadowRoot?.(shadowRoot);
      pushChildren(stack, shadowRoot);
    }
  }
  return { elements, truncated: stack.length > 0 };
}

function isHiddenOverlayStyle(style: CSSStyleDeclaration | undefined): boolean {
  // Fully transparent elements can still own pointer input, especially during
  // opacity transitions. The native WebContentsView paints above React, so it
  // must remain detached whenever such an overlay would intercept the page.
  return !!style && (style.display === 'none' || style.visibility === 'hidden');
}

function activeComputedProperty(style: CSSStyleDeclaration, name: string, inactive: string[]): boolean {
  const value = style.getPropertyValue(name).trim().toLowerCase();
  return value.length > 0 && !inactive.includes(value);
}

function hasSparseOverlayPaint(style: CSSStyleDeclaration): boolean {
  return (
    activeComputedProperty(style, 'clip-path', ['none']) ||
    activeComputedProperty(style, 'mask-image', ['none']) ||
    activeComputedProperty(style, '-webkit-mask-image', ['none'])
  );
}

function styleCreatesOverlayContext(style: CSSStyleDeclaration): boolean {
  if (style.position === 'absolute' || style.position === 'fixed' || style.position === 'sticky') return true;
  if (style.zIndex !== '' && style.zIndex !== 'auto') return true;
  if (style.opacity !== '' && Number.parseFloat(style.opacity) !== 1) return true;
  if (style.isolation === 'isolate' || (style.mixBlendMode !== '' && style.mixBlendMode !== 'normal')) return true;
  if (activeComputedProperty(style, 'transform', ['none'])) return true;
  if (activeComputedProperty(style, 'translate', ['none'])) return true;
  if (activeComputedProperty(style, 'rotate', ['none'])) return true;
  if (activeComputedProperty(style, 'scale', ['none'])) return true;
  if (activeComputedProperty(style, 'filter', ['none'])) return true;
  if (activeComputedProperty(style, 'backdrop-filter', ['none'])) return true;
  if (activeComputedProperty(style, 'perspective', ['none'])) return true;
  if (hasSparseOverlayPaint(style)) return true;
  if (activeComputedProperty(style, 'will-change', ['auto'])) return true;
  return /(?:^|\s)(?:layout|paint|strict|content)(?:\s|$)/.test(style.contain);
}

function collectPseudoSelectorsFromRules(rules: CSSRuleList, selectors: string[]): boolean {
  for (const rule of rules) {
    const candidate = rule as CSSRule & { selectorText?: string; cssRules?: CSSRuleList };
    if (typeof candidate.selectorText === 'string' && /::(?:before|after)\b/i.test(candidate.selectorText)) {
      const selector = candidate.selectorText.replace(/::(?:before|after)\b/gi, '');
      if (selector.trim()) selectors.push(selector);
      if (selectors.length > MAX_PSEUDO_STYLE_SELECTORS) return false;
    }
    if (candidate.cssRules && !collectPseudoSelectorsFromRules(candidate.cssRules, selectors)) return false;
  }
  return true;
}

function pseudoSelectorsForRoot(root: Node): string[] | null {
  const cached = pseudoSelectorCache.get(root);
  if (cached?.revision === pseudoStyleRevision) return cached.selectors;
  const selectors: string[] = [];
  const sheets = new Set<CSSStyleSheet>();
  if (root.nodeType === 9) {
    const document = root as Document;
    for (const sheet of document.styleSheets) sheets.add(sheet);
    for (const sheet of document.adoptedStyleSheets ?? []) sheets.add(sheet);
  } else if (root.nodeType === 11) {
    const shadow = root as ShadowRoot;
    for (const sheet of shadow.adoptedStyleSheets ?? []) sheets.add(sheet);
    for (const element of shadow.querySelectorAll('style, link[rel~="stylesheet"]')) {
      const sheet = (element as HTMLStyleElement | HTMLLinkElement).sheet;
      if (sheet) sheets.add(sheet);
    }
  }
  let complete = true;
  try {
    for (const sheet of sheets) {
      if (!collectPseudoSelectorsFromRules(sheet.cssRules, selectors)) {
        complete = false;
        break;
      }
    }
  } catch {
    // An unreadable stylesheet may define a pseudo overlay. Fall back to
    // computed pseudo inspection instead of assuming the selector set complete.
    complete = false;
  }
  const result = complete ? selectors : null;
  pseudoSelectorCache.set(root, { revision: pseudoStyleRevision, selectors: result });
  return result;
}

function elementMayHavePseudoStyle(element: Element): boolean {
  const selectors = pseudoSelectorsForRoot(element.getRootNode());
  if (selectors === null) return true;
  return selectors.some((selector) => {
    try {
      return element.matches(selector);
    } catch {
      return true;
    }
  });
}

function overlayPseudoStyles(document: Document, element: Element): CSSStyleDeclaration[] {
  const realm = document.defaultView;
  if (!realm || typeof realm.CSS?.supports !== 'function' || !elementMayHavePseudoStyle(element)) return [];
  const styles: CSSStyleDeclaration[] = [];
  for (const pseudo of ['::before', '::after']) {
    try {
      const style = realm.getComputedStyle(element, pseudo);
      const content = style.content.trim().toLowerCase();
      if (!content || content === 'none' || content === 'normal' || isHiddenOverlayStyle(style)) continue;
      if (styleCreatesOverlayContext(style)) styles.push(style);
    } catch {
      // If the runtime advertises pseudo-style support but inspection fails,
      // fail closed for the matching host.
      const fallback = realm.getComputedStyle(element);
      styles.push(fallback);
    }
  }
  return styles;
}

/** Discover stacking/overlay behavior from the browser's computed result, not
 * from framework class names or inline-style text. This includes stylesheet-
 * defined fixed/sticky UI, transformed content, and positioned flex/grid items
 * whose z-index lets them paint over the native Browser viewport. */
function isComputedOverlayCandidate(element: Element, style: CSSStyleDeclaration | undefined): boolean {
  if (element.matches(OVERLAY_HINT_SELECTOR)) return true;
  if (!style || isHiddenOverlayStyle(style)) return false;
  return styleCreatesOverlayContext(style) || overlayPseudoStyles(element.ownerDocument, element).length > 0;
}

/** A pointer-transparent portal host can contain several separated interactive
 * cards. Its aggregate bounding box includes gaps that elementsFromPoint()
 * deliberately sees through, so sample the actual pointer-owning descendants
 * instead. Bound traversal so an adversarial/plugin DOM cannot turn each resize
 * or mutation into an unbounded layout pass. */
function overlayHitTargets(document: Document, candidate: Element): { targets: Element[]; truncated: boolean } {
  const candidateStyle = document.defaultView?.getComputedStyle(candidate);
  if (candidateStyle?.pointerEvents !== 'none') return { targets: [candidate], truncated: false };
  const targets: Element[] = [];
  const descendants = shadowIncludingDescendants(candidate, MAX_POINTER_TRANSPARENT_OVERLAY_DESCENDANTS);
  for (const descendant of descendants.elements) {
    const style = document.defaultView?.getComputedStyle(descendant);
    if (isHiddenOverlayStyle(style) || style?.pointerEvents === 'none') continue;
    targets.push(descendant);
  }
  return {
    targets,
    truncated: descendants.truncated,
  };
}

function containsTrackedOverlayCandidate(node: Element, candidates: RendererOverlayCandidates): boolean {
  for (const candidate of candidates) {
    if (candidate === node || shadowIncludingContains(node, candidate)) return true;
  }
  return false;
}

function addOverlayCandidate(candidates: RendererOverlayCandidates, candidate: Element): void {
  if (candidates.has(candidate)) return;
  if (candidates.size >= MAX_RENDERER_OVERLAY_CANDIDATES) {
    overflowedOverlayCandidateSets.add(candidates);
    return;
  }
  candidates.add(candidate);
}

function pseudoContainingBlockRect(document: Document, candidate: Element, position: string): DOMRect | null {
  if (position === 'fixed') {
    const width = document.documentElement.clientWidth || document.defaultView?.innerWidth || 0;
    const height = document.documentElement.clientHeight || document.defaultView?.innerHeight || 0;
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    };
  }
  if (position !== 'absolute' && position !== 'sticky') return null;
  for (let current: Element | null = candidate; current; current = current.parentElement) {
    const style = document.defaultView?.getComputedStyle(current);
    if (
      style &&
      (style.position !== 'static' ||
        activeComputedProperty(style, 'transform', ['none']) ||
        activeComputedProperty(style, 'filter', ['none']) ||
        activeComputedProperty(style, 'perspective', ['none']))
    ) {
      return current.getBoundingClientRect();
    }
  }
  return document.documentElement.getBoundingClientRect();
}

function pseudoOverlayMayIntersectSurface(document: Document, candidate: Element, surfaceRect: DOMRect): boolean {
  const styles = overlayPseudoStyles(document, candidate);
  if (styles.length === 0) return false;
  const originRect = candidate.getBoundingClientRect();
  if (originRect.width > 0 && originRect.height > 0 && intersects(surfaceRect, originRect)) return true;
  return styles.some((style) => {
    const containingBlock = pseudoContainingBlockRect(document, candidate, style.position);
    return (
      !!containingBlock &&
      containingBlock.width > 0 &&
      containingBlock.height > 0 &&
      intersects(surfaceRect, containingBlock)
    );
  });
}

function candidatePaintsAboveSurface(
  document: Document,
  surface: HTMLElement,
  surfaceRect: DOMRect,
  candidate: Element,
): boolean {
  if (!candidate.isConnected || shadowIncludingClosest(candidate, OVERLAY_IGNORE_SELECTOR)) return false;
  if (candidate === surface || shadowIncludingContains(surface, candidate)) return false;
  // Do inspect ancestors of the native surface. A ::before/::after scrim is
  // retargeted by elementsFromPoint() to its originating host; when that host
  // contains the Browser surface, the host appears ahead of the surface only
  // while its pseudo-element actually paints above it. The hit-order check
  // below distinguishes that case from an ordinary containing ancestor.
  const style = document.defaultView?.getComputedStyle(candidate);
  if (isHiddenOverlayStyle(style)) return false;
  const candidateRect = candidate.getBoundingClientRect();
  // A clip path or mask can expose an arbitrary sliver that evades any finite
  // sample set. Once its box intersects the native surface, fail closed rather
  // than letting Chromium paint over a potentially interactive Kai control.
  if (
    style &&
    hasSparseOverlayPaint(style) &&
    candidateRect.width > 0 &&
    candidateRect.height > 0 &&
    intersects(surfaceRect, candidateRect)
  ) {
    return true;
  }
  // Pseudo-elements are retargeted to their originating host by hit testing and
  // expose no DOMRect of their own. If an overlay-style pseudo can occupy the
  // host or its positioned containing block, conservatively detach rather than
  // sampling the host's unrelated rectangle and missing a small/fixed scrim.
  if (pseudoOverlayMayIntersectSurface(document, candidate, surfaceRect)) return true;
  const hitTargets = overlayHitTargets(document, candidate);
  // A pointer-transparent portal with more descendants than the inspection
  // budget may contain an interactive child after the cutoff. Conservatively
  // hide the native view instead of allowing that child to be occluded.
  if (hitTargets.truncated) return true;
  for (const target of hitTargets.targets) {
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || !intersects(surfaceRect, rect)) continue;

    const left = Math.max(surfaceRect.left, rect.left);
    const right = Math.min(surfaceRect.right, rect.right);
    const top = Math.max(surfaceRect.top, rect.top);
    const bottom = Math.min(surfaceRect.bottom, rect.bottom);
    const points = [
      [(left + right) / 2, (top + bottom) / 2],
      [left + Math.min(1, (right - left) / 2), top + Math.min(1, (bottom - top) / 2)],
      [right - Math.min(1, (right - left) / 2), bottom - Math.min(1, (bottom - top) / 2)],
    ];
    const hitTarget = documentHitTarget(target);
    for (const [x, y] of points) {
      const stack = stackAt(document, x, y);
      const surfaceIndex = stack.findIndex((element) => element === surface || surface.contains(element));
      const targetIndex = stack.findIndex(
        (element) =>
          element === target || target.contains(element) || element === hitTarget || hitTarget.contains(element),
      );
      if (targetIndex >= 0 && (surfaceIndex < 0 || targetIndex < surfaceIndex)) return true;
    }
  }
  return false;
}

function considerOverlayCandidate(candidates: RendererOverlayCandidates, element: Element): void {
  if (shadowIncludingClosest(element, OVERLAY_IGNORE_SELECTOR)) return;
  const document = element.ownerDocument;
  const style = document.defaultView?.getComputedStyle(element);
  if (isComputedOverlayCandidate(element, style)) {
    addOverlayCandidate(candidates, element);
    return;
  }
  const surface = overlayCandidateContexts.get(candidates)?.surface;
  if (!surface || style?.pointerEvents === 'none') return;
  const surfaceRect = surface.getBoundingClientRect();
  if (surfaceRect.width <= 0 || surfaceRect.height <= 0) return;
  // Geometry/hit testing catches overlap created without a stacking-context
  // hint, such as grid/flex overlap or a negative-margin sibling.
  if (candidatePaintsAboveSurface(document, surface, surfaceRect, element)) addOverlayCandidate(candidates, element);
}

function addOverlayCandidates(candidates: RendererOverlayCandidates, node: Node): void {
  if (!(node instanceof Element) && !(node instanceof DocumentFragment)) return;
  const roots = shadowRootsByCandidateSet.get(candidates) ?? new Set<ShadowRoot>();
  shadowRootsByCandidateSet.set(candidates, roots);
  if (node instanceof ShadowRoot) roots.add(node);
  if (node instanceof Element) considerOverlayCandidate(candidates, node);
  const descendants = shadowIncludingDescendants(node, MAX_RENDERER_OVERLAY_DISCOVERY_NODES, (root) => {
    roots.add(root);
    // Document-level hit testing retargets closed-shadow descendants to the
    // host, so retain it even when the host itself has no overlay style.
    addOverlayCandidate(candidates, root.host);
  });
  if (
    (node instanceof Element && hasOpaqueDeclarativeShadow(node)) ||
    (node instanceof ShadowRoot && hasOpaqueDeclarativeShadow(node.host)) ||
    descendants.elements.some(hasOpaqueDeclarativeShadow)
  ) {
    // A closed declarative root has no JavaScript object we can observe or
    // traverse. Keep the native view detached while its marked light-DOM
    // container remains in the renderer tree.
    overflowedOverlayCandidateSets.add(candidates);
    return;
  }
  for (const element of descendants.elements) {
    considerOverlayCandidate(candidates, element);
    if (overflowedOverlayCandidateSets.has(candidates)) return;
  }
  if (descendants.truncated) overflowedOverlayCandidateSets.add(candidates);
}

function removeOverlayCandidates(candidates: RendererOverlayCandidates, node: Node): void {
  if (!(node instanceof Element)) return;
  for (const candidate of [...candidates]) {
    if (candidate === node || shadowIncludingContains(node, candidate)) candidates.delete(candidate);
  }
  const roots = shadowRootsByCandidateSet.get(candidates);
  if (!roots) return;
  for (const root of [...roots]) {
    if (root.host === node || shadowIncludingContains(node, root.host)) roots.delete(root);
  }
}

function rebuildOverlayCandidates(candidates: RendererOverlayCandidates, root: ParentNode): void {
  pseudoStyleRevision++;
  candidates.clear();
  overflowedOverlayCandidateSets.delete(candidates);
  shadowRootsByCandidateSet.set(candidates, new Set());
  if (root instanceof Node) addOverlayCandidates(candidates, root);
}

export function refreshRendererOverlayCandidates(candidates: RendererOverlayCandidates): void {
  const context = overlayCandidateContexts.get(candidates);
  if (!context) {
    overflowedOverlayCandidateSets.add(candidates);
    return;
  }
  rebuildOverlayCandidates(candidates, context.root);
}

function mutationCanReduceOverlayCandidates(record: MutationRecord, candidates: RendererOverlayCandidates): boolean {
  if (record.type === 'attributes') {
    return record.target instanceof Element;
  }
  return (
    record.type === 'childList' &&
    [...record.removedNodes].some(
      (node) =>
        containsOverlayCandidate(node) ||
        (node instanceof Element && containsTrackedOverlayCandidate(node, candidates)),
    )
  );
}

/** Build the bounded set used by scroll/resize checks. Mutation observers keep
 * this set current, avoiding style and layout reads for every element in Kai. */
export function collectRendererOverlayCandidates(
  root: ParentNode,
  surface: HTMLElement | null = null,
): RendererOverlayCandidates {
  const candidates: RendererOverlayCandidates = new Set();
  overlayCandidateContexts.set(candidates, { root, surface });
  shadowRootsByCandidateSet.set(candidates, new Set());
  rebuildOverlayCandidates(candidates, root);
  const ownerDocument = root instanceof Document ? root : root.ownerDocument;
  if (ownerDocument && !installRendererShadowRootCapture(ownerDocument)) {
    // A hardened/replaced prototype means closed roots cannot be discovered.
    // Keep the native view detached instead of painting through unknown UI.
    overflowedOverlayCandidateSets.add(candidates);
  }
  return candidates;
}

/** Open shadow roots discovered during the same bounded traversal. The panel
 * observes these roots with the same MutationObserver as document.body. */
export function rendererOverlayObservationRoots(candidates: RendererOverlayCandidates): ShadowRoot[] {
  return [...(shadowRootsByCandidateSet.get(candidates) ?? [])];
}

/** MutationObserver cannot see attachShadow() itself. Subscribe while the
 * Browser panel is mounted so a root attached to an already-connected host is
 * registered synchronously, before caller code can append an overlay to it. */
export function subscribeRendererShadowRoots(
  candidates: RendererOverlayCandidates,
  observedRoot: ParentNode,
  onRoot: (root: ShadowRoot) => void,
): () => void {
  const ownerDocument = observedRoot instanceof Document ? observedRoot : observedRoot.ownerDocument;
  const prototype = ownerDocument?.defaultView?.Element.prototype as { attachShadow: AttachShadowMethod } | undefined;
  if (!prototype || typeof prototype.attachShadow !== 'function') return () => undefined;

  const patch = ensureAttachShadowPatch(prototype);
  if (!patch) {
    // If another renderer hardens Element.prototype before startup, fail
    // closed instead of leaving a native view above undiscoverable roots.
    overflowedOverlayCandidateSets.add(candidates);
    return () => undefined;
  }

  const listener = (host: Element, root: ShadowRoot) => {
    if (host.ownerDocument !== ownerDocument) return;
    if (!(observedRoot instanceof Node) || !shadowIncludingContains(observedRoot, host)) return;
    const roots = shadowRootsByCandidateSet.get(candidates) ?? new Set<ShadowRoot>();
    shadowRootsByCandidateSet.set(candidates, roots);
    if (roots.has(root)) return;
    roots.add(root);
    // Document hit testing retargets shadow descendants to the host. Register
    // it immediately, including for a closed root whose contents are otherwise
    // inaccessible after attachShadow() returns.
    addOverlayCandidate(candidates, host);
    addOverlayCandidates(candidates, root);
    onRoot(root);
  };
  patch.listeners.add(listener);

  return () => {
    patch.listeners.delete(listener);
    // The accessor remains a transparent delegate so closed roots created
    // between panel mounts can still be recovered. If later instrumentation
    // replaces it, the next mount detects that loss and fails closed.
  };
}

/** HTML parser APIs can create declarative closed roots without invoking the
 * attachShadow hook. Rebuild synchronously after an instrumented parser call so
 * a newly created opaque subtree detaches the native view before the next paint. */
export function subscribeRendererDeclarativeShadowChanges(
  candidates: RendererOverlayCandidates,
  ownerDocument: Document,
  onChange: DeclarativeShadowChangeListener,
): () => void {
  const patch = ensureDeclarativeShadowPatch(ownerDocument);
  if (!patch) {
    overflowedOverlayCandidateSets.add(candidates);
    onChange(ownerDocument);
    return () => undefined;
  }
  patch.listeners.add(onChange);
  return () => patch.listeners.delete(onChange);
}

/** CSSOM mutations and adopted stylesheet swaps do not produce DOM mutation
 * records. Subscribe while the Browser panel is mounted so an existing Kai
 * element that becomes an overlay cannot remain below the native child view. */
export function subscribeRendererStylesheetChanges(
  candidates: RendererOverlayCandidates,
  ownerDocument: Document,
  onChange: StylesheetChangeListener,
): () => void {
  const patch = ensureStylesheetChangePatch(ownerDocument);
  if (!patch) {
    // Missing even one native mutation hook makes the candidate set incomplete.
    // Keep the WebContentsView detached rather than allowing it to cover UI.
    overflowedOverlayCandidateSets.add(candidates);
    return () => undefined;
  }
  patch.listeners.add(onChange);
  return () => patch.listeners.delete(onChange);
}

export function updateRendererOverlayCandidates(
  candidates: RendererOverlayCandidates,
  records: MutationRecord[],
): boolean {
  // Decide while removed geometry-only candidates are still present. Once the
  // set is updated, an unstyled grid/negative-margin overlap has no remaining
  // computed hint that would tell the panel to remount the native view.
  const mayHaveChanged = browserOverlayMayHaveChanged(records, candidates);
  if (records.some(stylesheetMayHaveChanged)) {
    refreshRendererOverlayCandidates(candidates);
    return mayHaveChanged;
  }
  if (
    overflowedOverlayCandidateSets.has(candidates) &&
    records.some((record) => mutationCanReduceOverlayCandidates(record, candidates))
  ) {
    const document = records.find((record) => record.target.ownerDocument)?.target.ownerDocument;
    if (document?.body) rebuildOverlayCandidates(candidates, document.body);
    return mayHaveChanged;
  }
  for (const record of records) {
    if (record.type === 'attributes' && record.target instanceof Element) {
      // A class/custom-property change can restyle descendants (or, via :has,
      // an otherwise unrelated overlay), so recompute from the bounded root.
      refreshRendererOverlayCandidates(candidates);
      return mayHaveChanged;
    }
    if (record.type !== 'childList') continue;
    for (const node of record.removedNodes) removeOverlayCandidates(candidates, node);
    for (const node of record.addedNodes) addOverlayCandidates(candidates, node);
  }
  return mayHaveChanged;
}

/** CSS motion events are tracked when the animated element is an overlay or
 * contains one. Ancestor visibility/layout transitions can reveal a nested
 * dialog just as surely as motion on the dialog itself. */
export function isRendererOverlayMotionTarget(
  target: EventTarget | null,
  candidates: RendererOverlayCandidates,
): boolean {
  if (!(target instanceof Element)) return false;
  if (containsTrackedOverlayCandidate(target, candidates)) return true;
  const style = target.ownerDocument.defaultView?.getComputedStyle(target);
  if (!isComputedOverlayCandidate(target, style)) return false;
  considerOverlayCandidate(candidates, target);
  return true;
}

function containsOverlayCandidate(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  if (hasOpaqueDeclarativeShadow(node)) return true;
  if (isComputedOverlayCandidate(node, node.ownerDocument.defaultView?.getComputedStyle(node))) return true;
  const descendants = shadowIncludingDescendants(node, MAX_RENDERER_OVERLAY_DISCOVERY_NODES);
  return (
    descendants.truncated ||
    descendants.elements.some(hasOpaqueDeclarativeShadow) ||
    descendants.elements.some((element) =>
      isComputedOverlayCandidate(element, element.ownerDocument.defaultView?.getComputedStyle(element)),
    )
  );
}

function stylesheetNode(node: Node): boolean {
  if (node instanceof HTMLStyleElement) return true;
  if (node instanceof HTMLLinkElement && node.relList.contains('stylesheet')) return true;
  return node instanceof Element && node.querySelector('style, link[rel~="stylesheet"]') !== null;
}

function stylesheetMayHaveChanged(record: MutationRecord): boolean {
  if (record.type === 'characterData') return record.target.parentElement instanceof HTMLStyleElement;
  if (record.type === 'attributes') {
    return (
      record.target instanceof HTMLStyleElement ||
      (record.target instanceof HTMLLinkElement && record.target.relList.contains('stylesheet'))
    );
  }
  if (record.target instanceof HTMLStyleElement) return true;
  return [...record.addedNodes, ...record.removedNodes].some(stylesheetNode);
}

/** Browser page views are native children that always paint above React. Only
 * mutations that can add, remove, show, hide, or resize a renderer overlay need
 * to re-run the comparatively expensive geometry/hit-test pass. */
export function browserOverlayMayHaveChanged(
  records: MutationRecord[],
  candidates: RendererOverlayCandidates,
): boolean {
  return records.some((record) => {
    if (stylesheetMayHaveChanged(record) || record.type === 'attributes') return true;
    const target = record.target instanceof Element ? record.target : record.target.parentElement;
    if (
      (target && isComputedOverlayCandidate(target, target.ownerDocument.defaultView?.getComputedStyle(target))) ||
      (target && containsTrackedOverlayCandidate(target, candidates))
    )
      return true;
    if (record.type !== 'childList') return false;
    return [...record.addedNodes, ...record.removedNodes].some(
      (node) =>
        containsOverlayCandidate(node) ||
        (node instanceof Element && containsTrackedOverlayCandidate(node, candidates)),
    );
  });
}

/**
 * WebContentsView always paints above renderer DOM. Find any visible external
 * renderer element whose actual intersection paints above the native viewport,
 * rather than sampling only the viewport center (which misses partial dialogs,
 * toasts, and warning banners).
 */
export function hasIntersectingRendererOverlay(
  surface: HTMLElement,
  candidates = collectRendererOverlayCandidates(surface.ownerDocument.body, surface),
): boolean {
  const document = surface.ownerDocument;
  const surfaceRect = surface.getBoundingClientRect();
  if (surfaceRect.width <= 0 || surfaceRect.height <= 0) return false;
  if (overflowedOverlayCandidateSets.has(candidates)) return true;

  for (const candidate of candidates) {
    if (candidatePaintsAboveSurface(document, surface, surfaceRect, candidate)) return true;
  }
  return false;
}
