export const MAX_BROWSER_EVALUATION_RESULT_CHARS = 200_000;
export const BROWSER_PRIVATE_NETWORK_GUARD_ACTIVATOR = '__kaiBrowserActivatePrivateNetworkGuard_v1__';
export const BROWSER_NATIVE_UI_GUARD_STATE = '__kaiBrowserNativeUiGuardInstalled_v1__';
export const BROWSER_NATIVE_UI_GUARD_ACTIVATOR = '__kaiBrowserActivateNativeUiGuard_v1__';
export const BROWSER_NATIVE_UI_FALLBACK_STATE = '__kaiBrowserNativeUiFallback_v1__';

/** Toggle the document-start native-UI membrane. Remote page code can see the
 * function but cannot change it without the random per-renderer token retained
 * by main and the sandboxed preload. */
export function browserNativeUiGuardActivationProbe(token: string, blocked = true): string {
  return `(() => {
    try {
      const activate = globalThis[${JSON.stringify(BROWSER_NATIVE_UI_GUARD_ACTIVATOR)}];
      const activated = typeof activate === 'function' && activate(${JSON.stringify(token)}, ${blocked}) === true;
      const fallback = globalThis[${JSON.stringify(BROWSER_NATIVE_UI_FALLBACK_STATE)}] === true;
      return ${blocked}
        ? (activated || fallback)
        : (activated && !fallback && globalThis[${JSON.stringify(BROWSER_NATIVE_UI_GUARD_STATE)}] === false);
    } catch {
      return false;
    }
  })()`;
}

/** Run before every future document while a renderer is assistant-controlled.
 * The preload membrane closes the cached-native-function escape for normal
 * frames. The direct replacement is a fail-closed fallback if a frame's preload
 * cannot install its membrane before this CDP document-start script runs. */
export const BROWSER_NATIVE_UI_NEW_DOCUMENT_GUARD = `(() => {
  const SafeError = Error;
  const SafeNumber = Number;
  const SafeString = String;
  const NativeSet = Set;
  const safeApply = Reflect.apply;
  const safeDefineProperty = Object.defineProperty;
  const safeGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const safeGetPrototypeOf = Object.getPrototypeOf;
  const safeSetHas = NativeSet.prototype.has;
  try {
    if (globalThis[${JSON.stringify(BROWSER_NATIVE_UI_GUARD_STATE)}] === true) return;
  } catch {}
  try {
    safeDefineProperty(globalThis, ${JSON.stringify(BROWSER_NATIVE_UI_FALLBACK_STATE)}, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: true,
    });
  } catch {}
  const blockMethod = (holder, name, message) => {
    try {
      const original = holder?.[name];
      if (typeof original !== 'function') return;
      const descriptor = safeGetOwnPropertyDescriptor(holder, name);
      safeDefineProperty(holder, name, {
        configurable: false,
        enumerable: descriptor?.enumerable ?? false,
        writable: false,
        value: function () { throw new SafeError(message); },
      });
    } catch {}
  };
  blockMethod(globalThis, 'print', 'Printing is blocked during assistant browser control.');
  for (const name of ['alert', 'confirm', 'prompt']) {
    blockMethod(globalThis, name, 'JavaScript dialogs are blocked during assistant browser control.');
  }
  for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
    blockMethod(globalThis, name, 'File System Access pickers are blocked during assistant browser control.');
  }
  blockMethod(globalThis.PaymentRequest?.prototype, 'show', 'Payment UI is blocked during assistant browser control.');
  blockMethod(
    globalThis.RemotePlayback?.prototype,
    'prompt',
    'Remote playback UI is blocked during assistant browser control.',
  );
  blockMethod(
    globalThis.PresentationRequest?.prototype,
    'start',
    'Presentation UI is blocked during assistant browser control.',
  );
  const nativeNavigator = globalThis.navigator;
  const nativeNavigatorPrototype = nativeNavigator
    ? safeGetPrototypeOf(nativeNavigator)
    : globalThis.Navigator?.prototype;
  blockMethod(
    typeof nativeNavigatorPrototype?.share === 'function' ? nativeNavigatorPrototype : nativeNavigator,
    'share',
    'Web Share is blocked during assistant browser control.',
  );
  blockMethod(
    globalThis.EyeDropper?.prototype,
    'open',
    'EyeDropper is blocked during assistant browser control.',
  );
  for (const name of [
    'requestFullscreen',
    'webkitRequestFullscreen',
    'webkitRequestFullScreen',
    'mozRequestFullScreen',
    'msRequestFullscreen',
  ]) {
    blockMethod(globalThis.Element?.prototype, name, 'Fullscreen is blocked during assistant browser control.');
  }
  blockMethod(globalThis.HTMLInputElement?.prototype, 'showPicker', 'Native pickers are blocked during assistant browser control.');
  blockMethod(globalThis.HTMLSelectElement?.prototype, 'showPicker', 'Native pickers are blocked during assistant browser control.');
  blockMethod(globalThis.HTMLVideoElement?.prototype, 'requestPictureInPicture', 'Picture-in-Picture is blocked during assistant browser control.');
  blockMethod(globalThis.HTMLVideoElement?.prototype, 'webkitSetPresentationMode', 'Native video presentation is blocked during assistant browser control.');
  const nativeCredentials = globalThis.navigator?.credentials;
  const nativeCredentialsPrototype = nativeCredentials ? safeGetPrototypeOf(nativeCredentials) : globalThis.CredentialsContainer?.prototype;
  const nativeCredentialsHolder =
    typeof nativeCredentialsPrototype?.get === 'function' || typeof nativeCredentialsPrototype?.create === 'function'
      ? nativeCredentialsPrototype
      : nativeCredentials;
  blockMethod(nativeCredentialsHolder, 'get', 'Passkey and security-key prompts are blocked during assistant browser control.');
  blockMethod(nativeCredentialsHolder, 'create', 'Passkey and security-key prompts are blocked during assistant browser control.');
  const documentPictureInPicture = globalThis.documentPictureInPicture;
  const documentPictureInPicturePrototype = documentPictureInPicture
    ? safeGetPrototypeOf(documentPictureInPicture)
    : globalThis.DocumentPictureInPicture?.prototype;
  blockMethod(
    typeof documentPictureInPicturePrototype?.requestWindow === 'function'
      ? documentPictureInPicturePrototype
      : documentPictureInPicture,
    'requestWindow',
    'Document Picture-in-Picture is blocked during assistant browser control.',
  );
  try {
    const NativeInput = globalThis.HTMLInputElement;
    const NativeSelect = globalThis.HTMLSelectElement;
    const NativeVideo = globalThis.HTMLVideoElement;
    const disablePictureInPictureDescriptor = safeGetOwnPropertyDescriptor(
      NativeVideo?.prototype,
      'disablePictureInPicture',
    );
    const nativeDisablePictureInPictureSetter = disablePictureInPictureDescriptor?.set;
    const safeSetAttribute = globalThis.Element?.prototype?.setAttribute;
    const safeDocumentQuerySelectorAll = globalThis.Document?.prototype?.querySelectorAll;
    const safeElementQuerySelectorAll = globalThis.Element?.prototype?.querySelectorAll;
    const safeNodeListItem = globalThis.NodeList?.prototype?.item;
    const NativeMutationObserver = globalThis.MutationObserver;
    const safeMutationObserve = NativeMutationObserver?.prototype?.observe;
    const pickerInputTypes = new NativeSet(['color', 'date', 'datetime-local', 'file', 'month', 'time', 'week']);
    const pickerKeys = new NativeSet([' ', 'arrowdown', 'enter', 'f4']);
    const safeComposedPath = globalThis.Event?.prototype?.composedPath;
    const safePreventDefault = globalThis.Event?.prototype?.preventDefault;
    const safeAddEventListener = globalThis.EventTarget?.prototype?.addEventListener;
    const isVideoTarget = (target) => {
      try {
        return SafeString(target?.localName || target?.tagName || '').toLowerCase() === 'video';
      } catch { return false; }
    };
    const forceVideoPictureInPictureDisabled = (target) => {
      if (!isVideoTarget(target)) return;
      try {
        if (typeof nativeDisablePictureInPictureSetter === 'function') {
          safeApply(nativeDisablePictureInPictureSetter, target, [true]);
        } else if (typeof safeSetAttribute === 'function') {
          safeApply(safeSetAttribute, target, ['disablepictureinpicture', '']);
        }
      } catch {}
    };
    const forceVideosInRoot = (candidate) => {
      if (!candidate) return;
      forceVideoPictureInPictureDisabled(candidate);
      let videos;
      try {
        const query = candidate === globalThis.document ? safeDocumentQuerySelectorAll : safeElementQuerySelectorAll;
        if (typeof query !== 'function') return;
        videos = safeApply(query, candidate, ['video']);
      } catch { return; }
      const rawCount = SafeNumber(videos?.length) || 0;
      const count = rawCount > 4096 ? 4096 : rawCount;
      for (let index = 0; index < count; index += 1) {
        let video;
        try {
          video = typeof safeNodeListItem === 'function'
            ? safeApply(safeNodeListItem, videos, [index])
            : videos?.[index];
        } catch { continue; }
        forceVideoPictureInPictureDisabled(video);
      }
    };
    if (disablePictureInPictureDescriptor) {
      safeDefineProperty(NativeVideo.prototype, 'disablePictureInPicture', {
        configurable: false,
        enumerable: disablePictureInPictureDescriptor.enumerable ?? false,
        get() { return true; },
        set() {
          if (typeof nativeDisablePictureInPictureSetter === 'function') {
            safeApply(nativeDisablePictureInPictureSetter, this, [true]);
          }
        },
      });
    }
    const isPickerTarget = (target) => {
      try {
        const localName = SafeString(target?.localName || target?.tagName || '').toLowerCase();
        if (localName === 'select') return true;
        return localName === 'input' &&
          safeApply(safeSetHas, pickerInputTypes, [SafeString(target.type || '').toLowerCase()]);
      } catch { return false; }
    };
    const blockPickerDefault = (event) => {
      if (!event) return;
      if (event.type === 'keydown' &&
          !safeApply(safeSetHas, pickerKeys, [SafeString(event.key || '').toLowerCase()])) return;
      let path = [];
      try {
        path = typeof safeComposedPath === 'function' ? safeApply(safeComposedPath, event, []) : [event.target];
      } catch { path = [event.target]; }
      for (let index = 0; index < path.length; index += 1) {
        forceVideoPictureInPictureDisabled(path[index]);
        if (!isPickerTarget(path[index])) continue;
        safeApply(safePreventDefault, event, []);
        return;
      }
    };
    // This document-start fallback must observe the event at Window before a
    // page capture handler can stop propagation on the way to Document.
    const pickerEventTarget = globalThis;
    for (const type of ['pointerdown', 'mousedown', 'touchstart', 'click', 'keydown']) {
      safeApply(safeAddEventListener, pickerEventTarget, [type, blockPickerDefault, { capture: true, passive: false }]);
    }
    if (typeof NativeMutationObserver === 'function' && typeof safeMutationObserve === 'function' && globalThis.document) {
      const observer = new NativeMutationObserver((records) => {
        for (const record of records) {
          const addedNodes = record?.addedNodes;
          const rawCount = SafeNumber(addedNodes?.length) || 0;
          const count = rawCount > 4096 ? 4096 : rawCount;
          for (let index = 0; index < count; index += 1) {
            let added;
            try {
              added = typeof safeNodeListItem === 'function'
                ? safeApply(safeNodeListItem, addedNodes, [index])
                : addedNodes?.[index];
            } catch { continue; }
            forceVideosInRoot(added);
          }
        }
      });
      safeApply(safeMutationObserve, observer, [globalThis.document, { childList: true, subtree: true }]);
    }
    forceVideosInRoot(globalThis.document);
  } catch {}
})()`;

/** Activate the preload trampoline before future document script. If Chromium
 * orders this CDP hook ahead of the frame preload, the existing direct guard is
 * retained as a fail-closed fallback and its marker forces renderer reclamation
 * instead of pretending that document can later be unguarded in place. */
export function browserNativeUiNewDocumentGuard(token: string): string {
  return `(() => {
    try {
      const activate = globalThis[${JSON.stringify(BROWSER_NATIVE_UI_GUARD_ACTIVATOR)}];
      if (typeof activate === 'function' && activate(${JSON.stringify(token)}, true) === true) return;
    } catch {}
    ${BROWSER_NATIVE_UI_NEW_DOCUMENT_GUARD}
  })()`;
}

/** Verify the document-start preload membrane in the page's main world and
 * activate its irreversible latch. A plain CDP constructor replacement is not
 * enough for an already-loaded page: page code may have cached the native
 * constructor before assistant control began. */
export const BROWSER_PRIVATE_NETWORK_GUARD_ACTIVATION_PROBE = `(() => {
  try {
    const activate = globalThis[${JSON.stringify(BROWSER_PRIVATE_NETWORK_GUARD_ACTIVATOR)}];
    return typeof activate === 'function' && activate() === true;
  } catch {
    return false;
  }
})()`;

/** Installed through CDP before arbitrary page evaluation. Unlike a frame load
 * listener, this runs in every newly created document before its inline scripts,
 * closing the srcdoc/navigation window where a fresh global could recover native
 * WebRTC constructors. The registration lives with the quarantined renderer and
 * is removed only when that WebContents is destroyed. */
export const BROWSER_PRIVATE_NETWORK_NEW_DOCUMENT_GUARD = `(() => {
  const SafeError = Error;
  const safeDefineProperty = Object.defineProperty;
  const blockedWebRtc = function () {
    throw new SafeError('WebRTC is blocked while AI private-network access is disabled.');
  };
  // The sandboxed frame preload installs this irreversible membrane before any
  // page script can cache a native constructor. Activating it also closes peer
  // connections the page created before AI evaluation began. New documents may
  // not have run the preload yet, so the direct replacements below remain the
  // document-start fallback.
  try {
    const activate = globalThis[${JSON.stringify(BROWSER_PRIVATE_NETWORK_GUARD_ACTIVATOR)}];
    if (typeof activate === 'function') activate();
  } catch {}
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCIceTransport', 'RTCDataChannel']) {
    try {
      safeDefineProperty(globalThis, name, {
        configurable: false,
        enumerable: false,
        writable: false,
        value: blockedWebRtc,
      });
    } catch {}
  }
})()`;

/** Evaluate the caller's script in the page's global scope, but serialize and
 * enforce the result budget inside the isolated renderer. CDP therefore only
 * transfers a bounded JSON string to Electron's main process. */
export function boundedBrowserEvaluationExpression(
  script: string,
  maxChars = MAX_BROWSER_EVALUATION_RESULT_CHARS,
  allowPrivateNetwork = true,
): string {
  if (!Number.isInteger(maxChars) || maxChars <= 0) throw new Error('Browser evaluation limit must be positive.');
  return `(async () => {
    const safeStringify = JSON.stringify;
    const safeString = String;
    const safeSlice = String.prototype.slice;
    const safeApply = Reflect.apply;
    const safeDefineProperty = Object.defineProperty;
    const safeGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    const safeGetPrototypeOf = Object.getPrototypeOf;
    const SafeError = Error;
    const SafeRangeError = RangeError;
    // The caller script runs in a fresh CDP isolated world. Main-world preload
    // membranes do not cover this execution context, so install the native-UI
    // guard again here before evaluating even one caller-controlled byte. The
    // isolated world has pristine intrinsics; any existing API that cannot be
    // replaced is a hard failure rather than a best-effort gap.
    const blockNativeUiMethod = (holder, name, message) => {
      if (!holder) return;
      const original = holder[name];
      if (typeof original !== 'function') return;
      const descriptor = safeGetOwnPropertyDescriptor(holder, name);
      const blocked = function () { throw new SafeError(message); };
      try {
        safeDefineProperty(holder, name, {
          configurable: false,
          enumerable: descriptor?.enumerable ?? false,
          writable: false,
          value: blocked,
        });
      } catch {
        throw new SafeError('Browser script evaluation could not guard native UI safely.');
      }
      const installed = safeGetOwnPropertyDescriptor(holder, name);
      if (installed?.value !== blocked) {
        throw new SafeError('Browser script evaluation could not verify its native-UI guard.');
      }
    };
    blockNativeUiMethod(globalThis, 'print', 'Printing is blocked during assistant browser control.');
    for (const name of ['alert', 'confirm', 'prompt']) {
      blockNativeUiMethod(globalThis, name, 'JavaScript dialogs are blocked during assistant browser control.');
    }
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
      blockNativeUiMethod(globalThis, name, 'File System Access pickers are blocked during assistant browser control.');
    }
    blockNativeUiMethod(globalThis.PaymentRequest?.prototype, 'show', 'Payment UI is blocked during assistant browser control.');
    blockNativeUiMethod(globalThis.RemotePlayback?.prototype, 'prompt', 'Remote playback UI is blocked during assistant browser control.');
    blockNativeUiMethod(globalThis.PresentationRequest?.prototype, 'start', 'Presentation UI is blocked during assistant browser control.');
    const nativeNavigator = globalThis.navigator;
    const nativeNavigatorPrototype = nativeNavigator
      ? safeGetPrototypeOf(nativeNavigator)
      : globalThis.Navigator?.prototype;
    blockNativeUiMethod(
      typeof nativeNavigatorPrototype?.share === 'function' ? nativeNavigatorPrototype : nativeNavigator,
      'share',
      'Web Share is blocked during assistant browser control.',
    );
    blockNativeUiMethod(globalThis.EyeDropper?.prototype, 'open', 'EyeDropper is blocked during assistant browser control.');
    for (const name of [
      'requestFullscreen',
      'webkitRequestFullscreen',
      'webkitRequestFullScreen',
      'mozRequestFullScreen',
      'msRequestFullscreen',
    ]) {
      blockNativeUiMethod(globalThis.Element?.prototype, name, 'Fullscreen is blocked during assistant browser control.');
    }
    blockNativeUiMethod(globalThis.HTMLInputElement?.prototype, 'showPicker', 'Native pickers are blocked during assistant browser control.');
    blockNativeUiMethod(globalThis.HTMLSelectElement?.prototype, 'showPicker', 'Native pickers are blocked during assistant browser control.');
    blockNativeUiMethod(globalThis.HTMLVideoElement?.prototype, 'requestPictureInPicture', 'Picture-in-Picture is blocked during assistant browser control.');
    blockNativeUiMethod(globalThis.HTMLVideoElement?.prototype, 'webkitSetPresentationMode', 'Native video presentation is blocked during assistant browser control.');
    const nativeCredentials = globalThis.navigator?.credentials;
    const nativeCredentialsPrototype = nativeCredentials
      ? safeGetPrototypeOf(nativeCredentials)
      : globalThis.CredentialsContainer?.prototype;
    const nativeCredentialsHolder =
      typeof nativeCredentialsPrototype?.get === 'function' || typeof nativeCredentialsPrototype?.create === 'function'
        ? nativeCredentialsPrototype
        : nativeCredentials;
    blockNativeUiMethod(nativeCredentialsHolder, 'get', 'Passkey and security-key prompts are blocked during assistant browser control.');
    blockNativeUiMethod(nativeCredentialsHolder, 'create', 'Passkey and security-key prompts are blocked during assistant browser control.');
    const documentPictureInPicture = globalThis.documentPictureInPicture;
    const documentPictureInPicturePrototype = documentPictureInPicture
      ? safeGetPrototypeOf(documentPictureInPicture)
      : globalThis.DocumentPictureInPicture?.prototype;
    blockNativeUiMethod(
      typeof documentPictureInPicturePrototype?.requestWindow === 'function'
        ? documentPictureInPicturePrototype
        : documentPictureInPicture,
      'requestWindow',
      'Document Picture-in-Picture is blocked during assistant browser control.',
    );
    if (!${allowPrivateNetwork}) {
      const blockedWebRtc = function () {
        throw new SafeError('WebRTC is blocked while AI private-network access is disabled.');
      };
      const blockedFrameCreation = function () {
        throw new SafeError('Creating browser frames is blocked while AI private-network access is disabled.');
      };
      const maxGuardedFrames = 64;
      const frameBudgetError = new SafeError(
        'Browser evaluation found too many frames to enforce the private-network policy safely.',
      );
      const throwFrameBudgetError = () => { throw frameBudgetError; };
      const frameSelector = 'iframe,frame,object,embed';
      const frameMarkup = /<\\s*(?:iframe|frame|object|embed)\\b/i;
      const guardedWindowDocuments = new WeakMap();
      const containsFrameNode = (node) => {
        try {
          if (!node || node.nodeType !== 1 && node.nodeType !== 11) return false;
          if (node.nodeType === 1 && frameMarkup.test('<' + node.localName + '>')) return true;
          return typeof node.querySelector === 'function' && node.querySelector(frameSelector) !== null;
        } catch {
          return true;
        }
      };
      const installMethodGuard = (target, name, validate) => {
        if (!target) return false;
        try {
          const original = target[name];
          if (typeof original !== 'function') return false;
          safeDefineProperty(target, name, {
            configurable: false,
            enumerable: false,
            writable: false,
            value: function (...args) {
              validate(args);
              return safeApply(original, this, args);
            },
          });
          return true;
        } catch {
          return false;
        }
      };
      const installMarkupSetterGuard = (prototype, name) => {
        if (!prototype) return;
        try {
          const descriptor = safeGetOwnPropertyDescriptor(prototype, name);
          if (typeof descriptor?.set !== 'function') return;
          const originalSet = descriptor.set;
          safeDefineProperty(prototype, name, {
            ...descriptor,
            configurable: false,
            set: function (value) {
              if (frameMarkup.test(String(value))) blockedFrameCreation();
              return safeApply(originalSet, this, [value]);
            },
          });
        } catch {}
      };
      const rejectFrameNodes = (args) => {
        for (const value of args) if (containsFrameNode(value)) blockedFrameCreation();
      };
      const rejectFrameMarkup = (args) => {
        for (const value of args) if (typeof value === 'string' && frameMarkup.test(value)) blockedFrameCreation();
      };
      const blockWebRtcInWindow = (candidate) => {
        if (!candidate) return;
        let document;
        try { document = candidate.document; } catch {}
        const documentIdentity = document ?? candidate;
        if (guardedWindowDocuments.get(candidate) === documentIdentity) return;
        guardedWindowDocuments.set(candidate, documentIdentity);
        for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCIceTransport', 'RTCDataChannel']) {
          try {
            safeDefineProperty(candidate, name, {
              configurable: false,
              enumerable: false,
              writable: false,
              value: blockedWebRtc,
            });
          } catch {}
        }
        // Fresh same-origin frames have fresh WebRTC constructors. Prevent the
        // evaluated script from creating a new browsing context through DOM
        // factories, markup setters, or detached fragments. These guards remain
        // with the quarantined document until its required reload/navigation.
        if (document) {
          const documentTargets = [document, candidate.Document?.prototype];
          for (const target of documentTargets) {
            const createElementInstalled = installMethodGuard(target, 'createElement', (args) => {
              if (frameMarkup.test('<' + String(args[0] ?? '') + '>')) blockedFrameCreation();
            });
            const createElementNsInstalled = installMethodGuard(target, 'createElementNS', (args) => {
              if (frameMarkup.test('<' + String(args[1] ?? '') + '>')) blockedFrameCreation();
            });
            if (!createElementInstalled || !createElementNsInstalled) {
              throw new SafeError('Browser evaluation could not install private-network frame guards.');
            }
            installMethodGuard(target, 'write', rejectFrameMarkup);
            installMethodGuard(target, 'writeln', rejectFrameMarkup);
          }
        }
        for (const prototype of [
          candidate.Node?.prototype,
          candidate.Element?.prototype,
          candidate.Document?.prototype,
          candidate.DocumentFragment?.prototype,
        ]) {
          for (const name of ['appendChild', 'insertBefore', 'replaceChild', 'append', 'prepend', 'replaceChildren']) {
            installMethodGuard(prototype, name, rejectFrameNodes);
          }
        }
        for (const prototype of [candidate.Element?.prototype, candidate.CharacterData?.prototype, candidate.DocumentType?.prototype]) {
          for (const name of ['before', 'after', 'replaceWith']) installMethodGuard(prototype, name, rejectFrameNodes);
        }
        installMethodGuard(candidate.Element?.prototype, 'insertAdjacentElement', (args) => rejectFrameNodes([args[1]]));
        installMethodGuard(candidate.Element?.prototype, 'insertAdjacentHTML', (args) => rejectFrameMarkup([args[1]]));
        installMethodGuard(candidate.Range?.prototype, 'insertNode', rejectFrameNodes);
        installMarkupSetterGuard(candidate.Element?.prototype, 'innerHTML');
        installMarkupSetterGuard(candidate.Element?.prototype, 'outerHTML');
        installMarkupSetterGuard(candidate.ShadowRoot?.prototype, 'innerHTML');
        // A navigation gives an existing frame a new global. Register our load
        // listener before the evaluated script can register its own handler, so
        // same-origin constructors are replaced before its continuation runs.
        try {
          const elements = document?.querySelectorAll(frameSelector) ?? [];
          if (elements.length > maxGuardedFrames) throwFrameBudgetError();
          for (let index = 0; index < elements.length; index++) {
            const frame = elements[index];
            frame.addEventListener('load', () => {
              try {
                blockWebRtcInWindow(frame.contentWindow);
              } catch (error) {
                // A newly loaded document can reveal a much larger nested tree.
                // Destroy that browsing context rather than leaving any of its
                // unguarded descendants available to the evaluated script.
                if (error === frameBudgetError) try { frame.remove(); } catch {}
              }
            }, true);
          }
        } catch {}
      };
      blockWebRtcInWindow(globalThis);
      // Same-origin child globals are another route to the native constructor.
      // Bound the walk so a hostile frame tree cannot stall evaluation setup.
      const pendingFrames = [];
      let rootFrames;
      try { rootFrames = globalThis.frames; } catch {}
      if (rootFrames) {
        if (rootFrames.length > maxGuardedFrames) throwFrameBudgetError();
        for (let index = 0; index < rootFrames.length; index++) pendingFrames.push(rootFrames[index]);
      }
      for (let index = 0; index < pendingFrames.length; index++) {
        const child = pendingFrames[index];
        try {
          blockWebRtcInWindow(child);
          if (pendingFrames.length + child.frames.length > maxGuardedFrames) throwFrameBudgetError();
          for (let frameIndex = 0; frameIndex < child.frames.length; frameIndex++) {
            pendingFrames.push(child.frames[frameIndex]);
          }
        } catch (error) {
          if (error === frameBudgetError) throw error;
        }
      }
    }
    const limitMessage = 'Browser script result exceeds the ${maxChars}-character limit.';
    const boundedErrorMessage = (error) => {
      let message = 'Unknown error';
      try { message = typeof error?.message === 'string' ? error.message : safeString(error); } catch {}
      return safeApply(safeSlice, message, [0, 4096]);
    };
    let value;
    try {
      value = await (0, eval)(${JSON.stringify(script)});
    } catch (error) {
      throw new SafeError('Browser script failed: ' + boundedErrorMessage(error));
    }
    const limit = ${maxChars};
    let estimatedChars = 0;
    let serialized;
    let limitExceeded = false;
    try {
      serialized = safeStringify(value, (key, item) => {
        estimatedChars += key.length + 4;
        if (typeof item === 'string') estimatedChars += item.length;
        else if (typeof item === 'number' || typeof item === 'boolean') estimatedChars += safeString(item).length;
        else if (item === null) estimatedChars += 4;
        if (estimatedChars > limit) {
          limitExceeded = true;
          throw new SafeRangeError(limitMessage);
        }
        return item;
      });
    } catch (error) {
      if (limitExceeded) throw new SafeRangeError(limitMessage);
      throw new SafeError('The script result is not serializable: ' + boundedErrorMessage(error));
    }
    if (serialized === undefined) throw new SafeError('The script result is not JSON-serializable.');
    if (typeof serialized !== 'string') throw new SafeError('The script result was not serialized safely.');
    if (serialized.length > limit) throw new SafeRangeError(limitMessage);
    return serialized;
  })()`;
}
