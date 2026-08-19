export const MAX_BROWSER_EVALUATION_RESULT_CHARS = 200_000;
export const BROWSER_PRIVATE_NETWORK_GUARD_ACTIVATOR = '__kaiBrowserActivatePrivateNetworkGuard_v1__';

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
    const SafeError = Error;
    const SafeRangeError = RangeError;
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
