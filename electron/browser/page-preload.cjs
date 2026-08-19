'use strict';

// Sandboxed Electron preloads execute as CommonJS even when the application is
// ESM. Keep this file dependency-free and expose nothing to the remote page.
const { contextBridge, ipcRenderer } = require('electron');

const MAX_USERNAME_LENGTH = 1_024;
const MAX_PASSWORD_LENGTH = 16_384;
const MAX_PENDING_AUTOMATION_INPUTS = 32;
const MAX_SHADOW_DISCOVERY_CANDIDATES = 2_048;
const MAX_DOM_DISCOVERY_NODES = 4_096;
const MAX_PENDING_DOM_DISCOVERY_JOBS = 4_096;
const MAX_ELEMENT_PICKER_SELECTOR_CHARS = 8 * 1_024;
const MAX_ELEMENT_PICKER_TOKEN_CHARS = 128;
const MAX_ELEMENT_PICKER_TIMEOUT_MS = 60_000;
const AUTOMATION_COORDINATE_TOLERANCE = 3;
const SHADOW_DISCOVERY_WINDOW_MS = 10_000;
const PRIVATE_NETWORK_GUARD_ACTIVATOR = '__kaiBrowserActivatePrivateNetworkGuard_v1__';
const PRIVATE_NETWORK_GUARD_ARGUMENT = '--kai-browser-private-network-guard';
const knownPasswordFields = new Set();
const listenedRoots = new WeakSet();
const reportedGestureEvents = new WeakSet();
const reportedLoginEvents = new WeakSet();
const shadowCandidates = new Map();
const observers = new Map();
let sensitiveLatched = false;
let lastActivityAt = 0;
let sensitivePoll = null;
let discoveryPoll = null;
let discoveryDrainTimer = null;
let sensorsRunning = false;
let discoveryDrainRunning = false;
let pendingDiscoveryJobs = [];
let pendingDiscoveryRoots = new WeakSet();
const pendingAutomationInputs = [];
let elementPicker = null;

/** Install before page script runs. The membrane delegates to Chromium's native
 * WebRTC constructors during ordinary user browsing, but every reference the
 * page can cache (including prototype.constructor) shares an irreversible
 * closure latch. AI evaluation activates that latch through a CDP document
 * guard, closing existing peer connections and preventing cached constructors
 * from escaping the private-network policy. */
function installMainWorldWebRtcMembrane(activatorName, initiallyBlocked) {
  const root = globalThis;
  const SafeError = Error;
  const SafeProxy = Proxy;
  const NativeSet = Set;
  const safeApply = Reflect.apply;
  const safeConstruct = Reflect.construct;
  const safeDefineProperty = Object.defineProperty;
  const safeGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const safeSetAdd = NativeSet.prototype.add;
  const safeSetClear = NativeSet.prototype.clear;
  const safeSetForEach = NativeSet.prototype.forEach;
  const livePeerConnections = new NativeSet();
  // Restricted renderers receive this flag in their hardened WebPreferences.
  // Reading it in the sandboxed preload activates the membrane before the
  // first remote-page script can cache or invoke a native WebRTC constructor.
  let blocked = initiallyBlocked === true;

  const blockedError = () => new SafeError('WebRTC is blocked while AI private-network access is disabled.');
  const assertAllowed = () => {
    if (blocked) throw blockedError();
  };
  const trackPeerConnection = (instance, close) => {
    if (instance && typeof close === 'function') {
      safeApply(safeSetAdd, livePeerConnections, [{ instance, close }]);
    }
    return instance;
  };

  const constructors = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCIceTransport', 'RTCDataChannel'];
  for (const name of constructors) {
    const original = root[name];
    if (typeof original !== 'function') continue;
    const originalClose =
      name === 'RTCPeerConnection' || name === 'webkitRTCPeerConnection' ? original.prototype?.close : undefined;
    let membrane;
    try {
      membrane = new SafeProxy(original, {
        apply(target, thisArg, args) {
          assertAllowed();
          return trackPeerConnection(safeApply(target, thisArg, args), originalClose);
        },
        construct(target, args, newTarget) {
          assertAllowed();
          return trackPeerConnection(
            safeConstruct(target, args, newTarget === membrane ? target : newTarget),
            originalClose,
          );
        },
      });
      const prototype = original.prototype;
      if (prototype && typeof prototype === 'object') {
        const constructorDescriptor = safeGetOwnPropertyDescriptor(prototype, 'constructor');
        safeDefineProperty(prototype, 'constructor', {
          configurable: constructorDescriptor?.configurable ?? true,
          enumerable: constructorDescriptor?.enumerable ?? false,
          writable: constructorDescriptor?.writable ?? true,
          value: membrane,
        });
      }
      const globalDescriptor = safeGetOwnPropertyDescriptor(root, name);
      safeDefineProperty(root, name, {
        configurable: false,
        enumerable: globalDescriptor?.enumerable ?? false,
        writable: false,
        value: membrane,
      });
    } catch {
      return false;
    }
  }

  const activate = () => {
    blocked = true;
    safeApply(safeSetForEach, livePeerConnections, [
      ({ instance, close }) => {
        try {
          safeApply(close, instance, []);
        } catch {}
      },
    ]);
    safeApply(safeSetClear, livePeerConnections, []);
    return true;
  };
  try {
    if (safeGetOwnPropertyDescriptor(root, activatorName)) return false;
    safeDefineProperty(root, activatorName, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: activate,
    });
    return true;
  } catch {
    return false;
  }
}

function installWebRtcMembrane() {
  try {
    return (
      contextBridge.executeInMainWorld({
        func: installMainWorldWebRtcMembrane,
        args: [PRIVATE_NETWORK_GUARD_ACTIVATOR, process.argv.includes(PRIVATE_NETWORK_GUARD_ARGUMENT)],
      }) === true
    );
  } catch {
    return false;
  }
}

function boundedElementPickerText(value, limit) {
  try {
    return String(value ?? '').slice(0, limit);
  } catch {
    return '';
  }
}

function selectorForPickedElement(element) {
  if (!isElement(element)) return '';
  const rawId = typeof element.id === 'string' ? element.id : '';
  if (rawId && rawId.length < MAX_ELEMENT_PICKER_SELECTOR_CHARS) {
    try {
      const escaped = `#${CSS.escape(rawId)}`;
      if (
        escaped.length <= MAX_ELEMENT_PICKER_SELECTOR_CHARS &&
        document.querySelectorAll(escaped).length === 1 &&
        document.querySelector(escaped) === element
      ) {
        return escaped;
      }
    } catch {}
  }

  const parts = [];
  let node = element;
  while (isElement(node)) {
    let part = boundedElementPickerText(node.tagName, 128).toLowerCase();
    if (!part) return '';
    const parent = node.parentElement;
    if (parent) {
      let sameTagCount = 0;
      let sameTagIndex = 0;
      for (const sibling of parent.children) {
        if (sibling.tagName !== node.tagName) continue;
        sameTagCount += 1;
        if (sibling === node) sameTagIndex = sameTagCount;
      }
      if (sameTagCount > 1) part += `:nth-of-type(${sameTagIndex})`;
    }
    parts.unshift(part);
    const candidate = parts.join(' > ');
    if (candidate.length > MAX_ELEMENT_PICKER_SELECTOR_CHARS) return '';
    try {
      if (document.querySelectorAll(candidate).length === 1 && document.querySelector(candidate) === element) {
        return candidate;
      }
    } catch {}
    node = parent;
  }
  return '';
}

function removeElementPickerOverlay(state) {
  try {
    state?.overlay?.remove();
  } catch {}
  if (state) state.overlay = null;
}

function disarmElementPicker(token) {
  const state = elementPicker;
  if (!state || (token !== undefined && state.token !== token)) return false;
  elementPicker = null;
  clearTimeout(state.timer);
  removeElementPickerOverlay(state);
  return true;
}

function reportElementPickerCancellation(state, reason) {
  if (!state || !disarmElementPicker(state.token)) return;
  ipcRenderer.send('browser-page:element-picker-cancel', {
    token: state.token,
    reason,
  });
}

function armElementPicker(_event, payload) {
  if (
    !payload ||
    typeof payload.token !== 'string' ||
    payload.token.length === 0 ||
    payload.token.length > MAX_ELEMENT_PICKER_TOKEN_CHARS ||
    !Number.isFinite(payload.timeoutMs) ||
    payload.timeoutMs < 1 ||
    payload.timeoutMs > MAX_ELEMENT_PICKER_TIMEOUT_MS
  ) {
    return;
  }
  disarmElementPicker();
  const state = {
    token: payload.token,
    awaitingSelection: false,
    x: null,
    y: null,
    overlay: null,
    timer: null,
  };
  state.timer = setTimeout(
    () => reportElementPickerCancellation(state, 'timeout'),
    Math.max(1, Math.floor(payload.timeoutMs)),
  );
  elementPicker = state;
}

function updateElementPickerOverlay(state, event) {
  if (!state || state.awaitingSelection) return;
  const target = event.target;
  if (!isElement(target)) return;
  try {
    const rect = target.getBoundingClientRect();
    if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return;
    let overlay = state.overlay;
    if (!overlay || !overlay.isConnected) {
      overlay = document.createElement('div');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.style.cssText =
        'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #8b5cf6;background:rgba(139,92,246,.12);display:none';
      document.documentElement?.append(overlay);
      state.overlay = overlay;
    }
    Object.assign(overlay.style, {
      display: 'block',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${Math.max(0, rect.width)}px`,
      height: `${Math.max(0, rect.height)}px`,
    });
  } catch {}
}

function handleElementPickerEvent(event) {
  const state = elementPicker;
  if (!state || event?.isTrusted !== true) return;
  const isEscape = event.type === 'keydown' && event.key === 'Escape';
  const isPointerOrMouse =
    typeof event.type === 'string' &&
    (event.type.startsWith('pointer') ||
      event.type.startsWith('mouse') ||
      ['click', 'dblclick', 'auxclick', 'contextmenu'].includes(event.type));
  if (!isEscape && !isPointerOrMouse) return;

  try {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  } catch {}

  if (isEscape) {
    reportElementPickerCancellation(state, 'cancelled');
    return;
  }
  if (event.type === 'pointermove' || event.type === 'mousemove') {
    updateElementPickerOverlay(state, event);
    return;
  }
  if (event.type !== 'click' || state.awaitingSelection) return;
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
    reportElementPickerCancellation(state, 'invalid-point');
    return;
  }
  state.awaitingSelection = true;
  state.x = event.clientX;
  state.y = event.clientY;
  removeElementPickerOverlay(state);
  ipcRenderer.send('browser-page:element-picker-click', {
    token: state.token,
    x: state.x,
    y: state.y,
  });
}

function selectElementPickerPoint(_event, payload) {
  const state = elementPicker;
  if (
    !state ||
    !state.awaitingSelection ||
    !payload ||
    payload.token !== state.token ||
    !Number.isFinite(state.x) ||
    !Number.isFinite(state.y)
  ) {
    return;
  }
  const { token, x, y } = state;
  disarmElementPicker(token);
  let selector = '';
  try {
    selector = selectorForPickedElement(document.elementFromPoint(x, y));
  } catch {}
  ipcRenderer.send('browser-page:element-picker-result', {
    token,
    ...(selector ? { selector } : { error: 'not-unique' }),
  });
}

function disarmElementPickerFromMain(_event, payload) {
  if (!payload || typeof payload.token !== 'string') return;
  disarmElementPicker(payload.token);
}

// These listeners are installed while the isolated preload realm is created,
// before remote page handlers. Keeping them permanently registered (but inert
// until armed) ensures a selected trusted click can be stopped before site
// JavaScript observes it or performs a navigation/window.open side effect.
for (const eventName of [
  'pointerdown',
  'pointerup',
  'pointermove',
  'pointercancel',
  'mousedown',
  'mouseup',
  'mousemove',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'keydown',
]) {
  window.addEventListener(eventName, handleElementPickerEvent, { capture: true, passive: false });
}
ipcRenderer.on('browser-page:element-picker-arm', armElementPicker);
ipcRenderer.on('browser-page:element-picker-select-at', selectElementPickerPoint);
ipcRenderer.on('browser-page:element-picker-disarm', disarmElementPickerFromMain);

function pruneAutomationInputs() {
  const current = Date.now();
  for (let index = pendingAutomationInputs.length - 1; index >= 0; index--) {
    if (pendingAutomationInputs[index].expiresAt < current) pendingAutomationInputs.splice(index, 1);
  }
}

function armAutomationInput(_event, payload) {
  pruneAutomationInputs();
  if (
    !payload ||
    typeof payload.token !== 'string' ||
    payload.token.length > 128 ||
    !['pointerdown', 'keydown', 'wheel', 'input'].includes(payload.kind) ||
    !Number.isFinite(payload.expiresAt) ||
    payload.expiresAt < Date.now() ||
    payload.expiresAt > Date.now() + 5_000
  ) {
    return;
  }
  pendingAutomationInputs.push({
    token: payload.token,
    kind: payload.kind,
    expiresAt: payload.expiresAt,
    x: Number.isFinite(payload.x) ? payload.x : undefined,
    y: Number.isFinite(payload.y) ? payload.y : undefined,
    screenX: Number.isFinite(payload.screenX) ? payload.screenX : undefined,
    screenY: Number.isFinite(payload.screenY) ? payload.screenY : undefined,
    key: typeof payload.key === 'string' ? payload.key.toLowerCase() : undefined,
    inputType: typeof payload.inputType === 'string' ? payload.inputType : undefined,
  });
  if (pendingAutomationInputs.length > MAX_PENDING_AUTOMATION_INPUTS) pendingAutomationInputs.shift();
}

function matchesAutomationInput(expected, event) {
  if (expected.kind !== event.type) return false;
  if (expected.key && String(event.key || '').toLowerCase() !== expected.key) return false;
  if (expected.inputType && String(event.inputType || '') !== expected.inputType) return false;
  const expectedX = expected.screenX ?? expected.x;
  const expectedY = expected.screenY ?? expected.y;
  const actualX = expected.screenX === undefined ? event.clientX : event.screenX;
  const actualY = expected.screenY === undefined ? event.clientY : event.screenY;
  if (
    expectedX !== undefined &&
    (!Number.isFinite(actualX) || Math.abs(actualX - expectedX) > AUTOMATION_COORDINATE_TOLERANCE)
  ) {
    return false;
  }
  if (
    expectedY !== undefined &&
    (!Number.isFinite(actualY) || Math.abs(actualY - expectedY) > AUTOMATION_COORDINATE_TOLERANCE)
  ) {
    return false;
  }
  return true;
}

function reportGesture(event) {
  if (!event || typeof event !== 'object' || event.isTrusted === false || reportedGestureEvents.has(event)) return;
  // Composed events are observed by both the shadow-root and document capture
  // listeners. Attribute each trusted event exactly once so the second listener
  // cannot consume it as unrelated user activity after the AI token is removed.
  reportedGestureEvents.add(event);
  pruneAutomationInputs();
  const index = pendingAutomationInputs.findIndex((expected) => matchesAutomationInput(expected, event));
  const matched = index >= 0 ? pendingAutomationInputs.splice(index, 1)[0] : null;
  // Pointer/key automation can synchronously produce a trusted checkbox/radio
  // `input` event after its one-shot token was consumed. Ignore unmatched input
  // here so it cannot overwrite the initiating assistant provenance. Genuine
  // user edits already have a trusted pointerdown/keydown gesture; exact
  // assistant insertText events carry their own input token.
  if (!matched && event.type === 'input') return;
  const gesturePayload = {
    ...(matched ? { token: matched.token } : {}),
    kind: event.type,
    // Main retains the expected typed value and compares this one-shot event
    // payload synchronously. The automation arm itself contains no plaintext,
    // so unrelated cross-origin frame preloads never receive the secret.
    ...(matched && event.type === 'input' && typeof event.data === 'string' ? { data: event.data } : {}),
  };
  let accepted = false;
  try {
    // Synchronous delivery establishes provenance before the page's own event
    // handler can call window.open and reach main's popup handler.
    accepted = ipcRenderer.sendSync('browser-page:gesture', gesturePayload) === true;
  } catch {}
  if (matched && !accepted) {
    // The token is broadcast to every frame because Chromium does not expose
    // the eventual input target at arm time. Main can reject a shape-matched
    // event whose typed data differs; retain this frame's copy so the later
    // real target event can still prove itself, and report the rejected event
    // without a token so it remains user-owned.
    if (matched.expiresAt >= Date.now()) {
      pendingAutomationInputs.push(matched);
      if (pendingAutomationInputs.length > MAX_PENDING_AUTOMATION_INPUTS) pendingAutomationInputs.shift();
    }
    try {
      ipcRenderer.sendSync('browser-page:gesture', { kind: event.type });
    } catch {}
  }
}

ipcRenderer.on('browser-page:arm-automation-input', armAutomationInput);

function latchSensitive() {
  if (sensitiveLatched) return;
  sensitiveLatched = true;
  // Main keeps sensitivity latched until a committed navigation. Once the
  // signal is sent, retaining individual fields serves no purpose and would
  // keep detached SPA components alive.
  knownPasswordFields.clear();
  if (discoveryDrainTimer !== null) clearTimeout(discoveryDrainTimer);
  discoveryDrainTimer = null;
  pendingDiscoveryJobs = [];
  pendingDiscoveryRoots = new WeakSet();
  ipcRenderer.send('browser-page:sensitive', true);
}

function checkKnownPasswords() {
  if (sensitiveLatched) {
    knownPasswordFields.clear();
    return;
  }
  for (const field of knownPasswordFields) {
    if (!field.isConnected) {
      knownPasswordFields.delete(field);
      continue;
    }
    if (typeof field.value === 'string' && field.value.length > 0) {
      latchSensitive();
      return;
    }
  }
}

function isElement(node, name) {
  return !!node && node.nodeType === 1 && (!name || String(node.localName).toLowerCase() === name);
}

function rememberInput(input) {
  if (!isElement(input, 'input')) return;
  if (input.type === 'password' || knownPasswordFields.has(input)) {
    knownPasswordFields.add(input);
    if (input.value) latchSensitive();
  }
}

function reportActivity(event) {
  if (event && event.isTrusted === false) return;
  const current = Date.now();
  if (current - lastActivityAt < 1_000) return;
  lastActivityAt = current;
  ipcRenderer.send('browser-page:activity');
}

function isVisibleLoginField(field) {
  if (!field || !field.isConnected || field.disabled || field.hidden || field.inert) return false;
  if (field.getAttribute('aria-hidden') === 'true') return false;
  const rect = field.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  const viewportWidth = Math.max(
    Number(globalThis.innerWidth) || 0,
    Number(document.documentElement?.clientWidth) || 0,
  );
  const viewportHeight = Math.max(
    Number(globalThis.innerHeight) || 0,
    Number(document.documentElement?.clientHeight) || 0,
  );
  const left = Number.isFinite(rect.left) ? rect.left : 0;
  const top = Number.isFinite(rect.top) ? rect.top : 0;
  const right = Number.isFinite(rect.right) ? rect.right : left + rect.width;
  const bottom = Number.isFinite(rect.bottom) ? rect.bottom : top + rect.height;
  if (
    viewportWidth <= 0 ||
    viewportHeight <= 0 ||
    right <= 0 ||
    bottom <= 0 ||
    left >= viewportWidth ||
    top >= viewportHeight
  ) {
    return false;
  }
  for (
    let current = field;
    current && current.nodeType === 1;
    current = current.parentElement || current.getRootNode?.()?.host || null
  ) {
    const style = globalThis.getComputedStyle(current);
    const opacity = Number(style.opacity || 1);
    if (
      current.hidden ||
      current.inert ||
      current.getAttribute('aria-hidden') === 'true' ||
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.contentVisibility === 'hidden' ||
      !Number.isFinite(opacity) ||
      opacity <= 0
    ) {
      return false;
    }
  }
  // Credential capture should reflect the form the user can actually see, not
  // an offscreen or covered semantic field selected by attacker-controlled
  // autocomplete/name hints. Chromium always provides hit testing; the
  // fallback only keeps non-browser preload harnesses deterministic.
  if (typeof document.elementFromPoint !== 'function') return true;
  const fieldRoot = field.getRootNode?.();
  const rootElementFromPoint =
    fieldRoot && fieldRoot !== document && typeof fieldRoot.elementFromPoint === 'function'
      ? fieldRoot.elementFromPoint.bind(fieldRoot)
      : null;
  let outerShadowHost = null;
  for (let current = field; current; ) {
    const root = current.getRootNode?.();
    if (!root || root === document || !root.host) break;
    outerShadowHost = root.host;
    current = root.host;
  }
  const clippedLeft = Math.max(0, left);
  const clippedTop = Math.max(0, top);
  const clippedRight = Math.min(viewportWidth, right);
  const clippedBottom = Math.min(viewportHeight, bottom);
  const insetX = Math.min(2, (clippedRight - clippedLeft) / 2);
  const insetY = Math.min(2, (clippedBottom - clippedTop) / 2);
  return [
    [(clippedLeft + clippedRight) / 2, (clippedTop + clippedBottom) / 2],
    [clippedLeft + insetX, clippedTop + insetY],
    [clippedRight - insetX, clippedBottom - insetY],
  ].some(([x, y]) => {
    const documentHit = document.elementFromPoint(x, y);
    const documentVisible =
      documentHit === field || field.contains(documentHit) || (outerShadowHost && documentHit === outerShadowHost);
    if (!documentVisible) return false;
    if (!rootElementFromPoint) return true;
    const rootHit = rootElementFromPoint(x, y);
    return rootHit === field || field.contains(rootHit);
  });
}

function usernameFromForm(form) {
  const populated = Array.from(form.querySelectorAll('input')).filter((field) => {
    const type = String(field.type || 'text').toLowerCase();
    return (
      ['text', 'email'].includes(type) &&
      isVisibleLoginField(field) &&
      typeof field.value === 'string' &&
      field.value.trim().length > 0
    );
  });
  const autocomplete = (field) =>
    String(field.autocomplete || '')
      .toLowerCase()
      .split(/\s+/);
  const identity = (field) =>
    `${field.name || ''} ${field.id || ''}`.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const explicit = populated.filter((field) => autocomplete(field).includes('username'));
  const semantic = populated.filter(
    (field) =>
      String(field.type || '').toLowerCase() === 'email' ||
      /(?:^|[_\s-])(?:user|username|email|login)(?:$|[_\s-])/.test(identity(field)),
  );
  const selected =
    explicit.length === 1
      ? explicit[0]
      : explicit.length > 1
        ? null
        : semantic.length === 1
          ? semantic[0]
          : semantic.length > 1
            ? null
            : populated.length === 1
              ? populated[0]
              : null;
  return (selected?.value.trim() ?? '').slice(0, MAX_USERNAME_LENGTH);
}

function passwordFromForm(form) {
  const populated = [];
  for (const input of form.querySelectorAll('input')) {
    const isPasswordField = input.type === 'password' || knownPasswordFields.has(input);
    rememberInput(input);
    if (isPasswordField && isVisibleLoginField(input) && typeof input.value === 'string' && input.value.length > 0) {
      populated.push(input);
    }
  }
  if (populated.length === 0) return '';

  const autocomplete = (input) =>
    String(input.autocomplete || '')
      .toLowerCase()
      .split(/\s+/);
  const identity = (input) =>
    `${input.name || ''} ${input.id || ''}`.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const newFields = populated.filter(
    (input) =>
      autocomplete(input).includes('new-password') ||
      /(?:^|[_\s-])(new|confirm|repeat)(?:$|[_\s-])/.test(identity(input)),
  );
  const confirmationFields = new Set(
    populated.filter((input) => /(?:^|[_\s-])(confirm|repeat)(?:$|[_\s-])/.test(identity(input))),
  );
  if (newFields.length > 0) {
    // Password-change and signup forms commonly contain current/new/confirm.
    // Prefer a repeated new value (the new+confirmation pair), otherwise the
    // explicitly marked new-password field. Never overwrite the vault with the
    // first field, which is usually the old password.
    const repeated = newFields.find((candidate, index) =>
      newFields.some((other, otherIndex) => otherIndex !== index && other.value === candidate.value),
    );
    if (repeated) return repeated.value;
    if (newFields.length !== 1) return '';
    const selected = newFields[0];
    if (confirmationFields.has(selected)) {
      // A lone confirmation hint is not authoritative. Generic password plus
      // confirm_password is a common signup form; only save when a non-current
      // partner visibly agrees, never replace a vault entry with a typo.
      const matchingPartner = populated.some(
        (other) =>
          other !== selected && !autocomplete(other).includes('current-password') && other.value === selected.value,
      );
      return matchingPartner ? selected.value : '';
    }
    return selected.value;
  }

  const currentFields = populated.filter((input) => autocomplete(input).includes('current-password'));
  if (currentFields.length === 1) {
    // A second unclassified visible password is ambiguous even when one field
    // claims current-password. Only an explicitly classified new-password
    // branch above may coexist with the current value.
    if (populated.some((input) => input !== currentFields[0])) return '';
    return currentFields[0].value;
  }
  if (populated.length === 1) return populated[0].value;

  // Without semantic hints, accept only an agreeing password/confirmation pair.
  // Distinct multiple values are ambiguous and must not produce a save prompt.
  const repeated = populated.find((candidate, index) =>
    populated.some((other, otherIndex) => otherIndex !== index && other.value === candidate.value),
  );
  return repeated?.value ?? '';
}

function loginActionLabel(element) {
  try {
    return [
      element.getAttribute?.('aria-label') || '',
      element.textContent || '',
      element.value || '',
      element.name || '',
      element.id || '',
    ]
      .join(' ')
      .slice(0, 512)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase();
  } catch {
    return '';
  }
}

function loginContainerForGesture(root, event) {
  if (!event || event.isTrusted !== true || reportedLoginEvents.has(event)) return null;
  let path = [];
  try {
    path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  } catch {}
  if (path.length === 0 && event.target) path = [event.target];

  if (event.type === 'keydown') {
    if (
      event.key !== 'Enter' ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return null;
    }
    const input = path.find((node) => isElement(node, 'input'));
    if (!input) return null;
    const type = String(input.type || 'text').toLowerCase();
    if (!['text', 'email', 'password', 'tel'].includes(type) && !knownPasswordFields.has(input)) return null;
    return input.form || input.closest?.('form') || root;
  }

  if (event.type !== 'click') return null;
  const action = path.find(
    (node) =>
      isElement(node, 'button') ||
      (isElement(node, 'input') && ['submit', 'image', 'button'].includes(String(node.type || '').toLowerCase())) ||
      (isElement(node) && String(node.getAttribute?.('role') || '').toLowerCase() === 'button'),
  );
  if (!action || action.disabled || action.inert || action.getAttribute?.('aria-disabled') === 'true') return null;
  const form = action.form || action.closest?.('form') || null;
  const type = String(action.type || '').toLowerCase();
  const nativeSubmit =
    !!form &&
    ((isElement(action, 'button') && (!type || type === 'submit')) ||
      (isElement(action, 'input') && ['submit', 'image'].includes(type)));
  const namedLoginAction =
    /(?:^|\b)(?:sign\s*in|log\s*in|login|continue|next|submit|save|update|change\s+password|register|create\s+account)(?:\b|$)/.test(
      loginActionLabel(action),
    );
  if (!nativeSubmit && !namedLoginAction) return null;
  return form || root;
}

function reportLoginCandidate(container) {
  if (!container || typeof container.querySelectorAll !== 'function') return false;
  const password = passwordFromForm(container);
  if (!password || password.length > MAX_PASSWORD_LENGTH) return false;
  const ownerDocument = container.nodeType === 9 ? container : container.ownerDocument;
  let origin = 'null';
  try {
    origin = ownerDocument.location.origin;
  } catch {}
  ipcRenderer.send('browser-page:login-submitted', {
    origin,
    username: usernameFromForm(container),
    password,
  });
  latchSensitive();
  return true;
}

function installRootListeners(root) {
  root.addEventListener(
    'input',
    (event) => {
      reportGesture(event);
      discoverEventPath(event);
      checkKnownPasswords();
    },
    true,
  );
  root.addEventListener(
    'submit',
    (event) => {
      if (event.isTrusted !== true) return;
      const form = event.target;
      if (!isElement(form, 'form')) return;
      if (reportLoginCandidate(form)) reportedLoginEvents.add(event);
    },
    true,
  );
  for (const eventName of ['click', 'keydown']) {
    root.addEventListener(
      eventName,
      (event) => {
        // Enter is itself the activation main validates; clicks retain their
        // preceding pointerdown/touchstart/keydown provenance.
        if (eventName === 'keydown') reportGesture(event);
        const container = loginContainerForGesture(root, event);
        if (container && reportLoginCandidate(container)) reportedLoginEvents.add(event);
      },
      true,
    );
  }
  for (const eventName of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    root.addEventListener(
      eventName,
      (event) => {
        reportGesture(event);
        discoverEventPath(event);
        reportActivity(event);
      },
      { capture: true, passive: true },
    );
  }
}

function createDiscoveryBudget() {
  return { remaining: MAX_DOM_DISCOVERY_NODES };
}

function discoverElement(element) {
  rememberInput(element);
  const shadowRoot = element.shadowRoot;
  if (shadowRoot) discoverRoot(shadowRoot, element);
  else {
    // Large or mutation-heavy hostile pages must not make the periodic late-
    // shadow-root probe retain and rescan every element for ten seconds. Keep a
    // bounded recency window; user interaction also rediscovers hosts through
    // composed event paths if an older candidate later gains a shadow root.
    shadowCandidates.delete(element);
    if (shadowCandidates.size >= MAX_SHADOW_DISCOVERY_CANDIDATES) {
      const oldest = shadowCandidates.keys().next().value;
      if (oldest) shadowCandidates.delete(oldest);
    }
    shadowCandidates.set(element, Date.now() + SHADOW_DISCOVERY_WINDOW_MS);
  }
}

function discoverEventPath(event) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
  const budget = createDiscoveryBudget();
  for (const node of path) {
    if (!isElement(node)) continue;
    if (budget.remaining <= 0) {
      // An adversarially deep composed path cannot be silently truncated: a
      // populated password field past the cap would otherwise remain readable
      // to screenshots/inspection. Fail closed for this document.
      latchSensitive();
      break;
    }
    budget.remaining -= 1;
    discoverElement(node);
  }
}

function scheduleDiscoveryDrain() {
  if (!sensorsRunning || sensitiveLatched || discoveryDrainRunning || discoveryDrainTimer !== null) return;
  discoveryDrainTimer = setTimeout(drainDiscoveryQueueSlice, 0);
}

function enqueueDiscoveryRoot(root) {
  if (!root || sensitiveLatched || pendingDiscoveryRoots.has(root)) return;
  if (pendingDiscoveryJobs.length >= MAX_PENDING_DOM_DISCOVERY_JOBS) {
    // Retaining an unbounded number of hostile mutation subtrees is unsafe, but
    // dropping one is a credential leak. Conservatively latch the page instead.
    latchSensitive();
    return;
  }
  const ownerDocument = root.nodeType === 9 ? root : root.ownerDocument;
  if (!ownerDocument || typeof ownerDocument.createTreeWalker !== 'function') {
    latchSensitive();
    return;
  }
  pendingDiscoveryRoots.add(root);
  pendingDiscoveryJobs.push({
    root,
    walker: ownerDocument.createTreeWalker(root, 1),
    includeCurrent: isElement(root),
  });
  scheduleDiscoveryDrain();
}

function drainDiscoveryQueueSlice() {
  if (discoveryDrainTimer !== null) {
    clearTimeout(discoveryDrainTimer);
    discoveryDrainTimer = null;
  }
  if (!sensorsRunning || sensitiveLatched || discoveryDrainRunning) return;
  discoveryDrainRunning = true;
  try {
    const budget = createDiscoveryBudget();
    while (pendingDiscoveryJobs.length > 0 && budget.remaining > 0 && !sensitiveLatched) {
      const job = pendingDiscoveryJobs[0];
      let element = null;
      if (job.includeCurrent) {
        job.includeCurrent = false;
        element = job.walker.currentNode;
      } else {
        element = job.walker.nextNode();
      }
      if (!element) {
        pendingDiscoveryJobs.shift();
        pendingDiscoveryRoots.delete(job.root);
        continue;
      }
      budget.remaining -= 1;
      discoverElement(element);
    }
  } catch {
    // A hostile live DOM can invalidate traversal primitives while a slice is
    // running. Never treat an incomplete scan as proof that the page is safe.
    latchSensitive();
  } finally {
    discoveryDrainRunning = false;
  }
  checkKnownPasswords();
  if (pendingDiscoveryJobs.length > 0 && !sensitiveLatched) scheduleDiscoveryDrain();
}

function discoverRoot(root, owner = root.host || null) {
  if (observers.has(root)) return;
  if (!listenedRoots.has(root)) {
    listenedRoots.add(root);
    installRootListeners(root);
  }
  enqueueDiscoveryRoot(root);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') rememberInput(record.target);
      for (const node of record.addedNodes) {
        if (isElement(node)) enqueueDiscoveryRoot(node);
        if (sensitiveLatched) break;
      }
      if (sensitiveLatched) break;
    }
    drainDiscoveryQueueSlice();
    checkKnownPasswords();
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['type', 'value'],
  });
  observers.set(root, { observer, owner });
}

function pruneDetachedResources() {
  if (sensitiveLatched) knownPasswordFields.clear();
  else {
    for (const field of knownPasswordFields) {
      if (!field.isConnected) knownPasswordFields.delete(field);
    }
  }
  for (const [root, entry] of observers) {
    if (!entry.owner || entry.owner.isConnected) continue;
    entry.observer.disconnect();
    observers.delete(root);
  }
}

function discoverNewShadowRoots() {
  // A shadow root can be attached after its already-connected host without a
  // light-DOM mutation. Poll only the incremental, time-bounded set of recently
  // discovered hosts; an idle page converges to no polling work instead of
  // repeatedly walking/querying every document and shadow tree.
  const current = Date.now();
  const budget = createDiscoveryBudget();
  pruneDetachedResources();
  for (const [element, expiresAt] of shadowCandidates) {
    if (!element.isConnected || expiresAt <= current) {
      shadowCandidates.delete(element);
      continue;
    }
    const shadowRoot = element.shadowRoot;
    if (shadowRoot) {
      if (budget.remaining <= 0) continue;
      budget.remaining -= 1;
      shadowCandidates.delete(element);
      discoverRoot(shadowRoot, element);
    }
  }
  drainDiscoveryQueueSlice();
  checkKnownPasswords();
}

function discoverAll() {
  discoverRoot(document, null);
  // Scan one bounded slice synchronously so fields already present at
  // DOMContentLoaded are protected before yielding back to page code. Remaining
  // nodes continue in zero-delay bounded slices instead of being abandoned.
  drainDiscoveryQueueSlice();
  discoverNewShadowRoots();
}

/** Install the closed-shadow sentinel in the page's main JavaScript world.
 * Context isolation gives the preload a different Element.prototype, so an
 * isolated-world patch cannot observe roots created by page code. The signal
 * carries no DOM or credential data; any closed root conservatively latches
 * the document as sensitive because its contents cannot be inspected safely. */
function installMainWorldAttachShadowHook(signalEventName) {
  const prototype = globalThis.Element?.prototype;
  const NativeEvent = globalThis.Event;
  const dispatchEvent = globalThis.EventTarget?.prototype?.dispatchEvent;
  if (
    !prototype ||
    typeof prototype.attachShadow !== 'function' ||
    typeof NativeEvent !== 'function' ||
    typeof dispatchEvent !== 'function'
  ) {
    return false;
  }
  const original = prototype.attachShadow;
  const defineProperty = Object.defineProperty;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'attachShadow');
  let delegate = original;
  let invokingDelegate = false;
  const signalClosedRoot = () => {
    try {
      dispatchEvent.call(globalThis, new NativeEvent(signalEventName));
    } catch {}
  };
  const wrapper = function (init) {
    if (invokingDelegate) {
      const root = original.call(this, init);
      // A page-supplied delegate can re-enter attachShadow with different
      // options. The outer call may request an open root while the nested call
      // actually creates a closed one, so the re-entrant fast path must signal
      // based on the options passed to the native implementation too.
      if (init?.mode === 'closed') signalClosedRoot();
      return root;
    }
    let root;
    invokingDelegate = true;
    try {
      root = delegate.call(this, init);
    } finally {
      invokingDelegate = false;
    }
    if (init?.mode === 'closed') {
      signalClosedRoot();
    }
    return root;
  };

  try {
    defineProperty(prototype, 'attachShadow', {
      configurable: false,
      enumerable: descriptor?.enumerable ?? false,
      get: () => wrapper,
      set: (next) => {
        if (next === wrapper) delegate = original;
        else if (typeof next === 'function') delegate = next;
      },
    });
    return true;
  } catch {
    return false;
  }
}

function installClosedShadowSentinel() {
  const signalEventName = 'kai-browser-closed-shadow-created';
  window.addEventListener(signalEventName, latchSensitive, { capture: true });
  try {
    const installed = contextBridge.executeInMainWorld({
      func: installMainWorldAttachShadowHook,
      args: [signalEventName],
    });
    if (installed !== true) latchSensitive();
  } catch {
    latchSensitive();
  }
}

function startSensors() {
  if (sensorsRunning) return;
  sensorsRunning = true;
  discoverAll();
  sensitivePoll = setInterval(checkKnownPasswords, 400);
  discoveryPoll = setInterval(discoverNewShadowRoots, 1_500);
}

function stopSensors() {
  if (!sensorsRunning) return;
  sensorsRunning = false;
  if (sensitivePoll !== null) clearInterval(sensitivePoll);
  if (discoveryPoll !== null) clearInterval(discoveryPoll);
  if (discoveryDrainTimer !== null) clearTimeout(discoveryDrainTimer);
  sensitivePoll = null;
  discoveryPoll = null;
  discoveryDrainTimer = null;
  discoveryDrainRunning = false;
  pendingDiscoveryJobs = [];
  pendingDiscoveryRoots = new WeakSet();
  for (const { observer } of observers.values()) observer.disconnect();
  observers.clear();
  shadowCandidates.clear();
  // A persisted page can return from BFCache. Its listeners survive, but its
  // MutationObservers do not; discoverRoot attaches fresh observers on
  // pageshow without duplicating input/activity listeners.
}

installWebRtcMembrane();
installClosedShadowSentinel();

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', startSensors, { once: true });
} else {
  queueMicrotask(startSensors);
}

window.addEventListener(
  'pagehide',
  () => {
    const picker = elementPicker;
    if (picker) reportElementPickerCancellation(picker, 'navigation');
    stopSensors();
    // Main clears sensitivity only on committed top-level navigation.
  },
  { capture: true },
);

window.addEventListener(
  'pageshow',
  (event) => {
    if (!event.persisted) return;
    startSensors();
    // Main declassifies on committed top-level navigation. A BFCache restore
    // reuses this same document and its latched fields, so re-assert the latch
    // even though latchSensitive intentionally sends only once per document.
    if (sensitiveLatched) ipcRenderer.send('browser-page:sensitive', true);
  },
  { capture: true },
);
