import { MAX_BROWSER_ROLE_CHARS, MAX_BROWSER_SELECTOR_CHARS } from './input-validation.js';
import { browserSemanticHelpersExpression } from './semantics.js';

export const MAX_BROWSER_INSPECTION_ELEMENTS = 200;
export const MAX_BROWSER_INSPECTION_VISIBLE_TEXT_CHARS = 50_000;
export const MAX_BROWSER_INSPECTION_NAME_CHARS = 200;
export const MAX_BROWSER_INSPECTION_TEXT_CHARS = 500;
export const MAX_BROWSER_INSPECTION_OCCLUSION_POINTS = 512;
export const MAX_BROWSER_INSPECTION_DOM_VISITS = 10_000;
export const MAX_BROWSER_INSPECTION_CANDIDATES = 2_000;

/** Build the expression evaluated in Chromium's isolated world. Every
 * page-controlled string is bounded before CDP clones the result into main. */
export function browserInspectionExpression(): string {
  return `(() => {
    const bounded = (value, limit) => {
      let text = '';
      try { text = value == null ? '' : String(value); } catch { return ''; }
      return text.slice(0, limit);
    };
    ${browserSemanticHelpersExpression()}
    const selectorFor = (el) => {
      const isUnique = (selector) => {
        if (!selector || selector.length > ${MAX_BROWSER_SELECTOR_CHARS}) return false;
        try {
          const matches = document.querySelectorAll(selector);
          return matches.length === 1 && matches[0] === el;
        } catch { return false; }
      };
      const rawId = bounded(el.id, ${MAX_BROWSER_SELECTOR_CHARS - 1});
      if (rawId) {
        let escapedId = rawId;
        try { escapedId = CSS.escape(rawId); } catch {}
        const idSelector = '#' + escapedId;
        if (isUnique(idSelector)) return idSelector;
      }
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && parts.length < 32) {
        let part = bounded(node.tagName, 128).toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const same = Array.from(parent.children).filter((candidate) => candidate.tagName === node.tagName);
          if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        const structural = parts.join(' > ');
        if (isUnique(structural)) return structural;
        const ancestorId = bounded(node.id, ${MAX_BROWSER_SELECTOR_CHARS - 1});
        if (ancestorId) {
          let escapedAncestorId = ancestorId;
          try { escapedAncestorId = CSS.escape(ancestorId); } catch {}
          const anchored = '#' + escapedAncestorId + (parts.length > 1 ? ' > ' + parts.slice(1).join(' > ') : '');
          if (isUnique(anchored)) return anchored;
        }
        if (structural.length >= ${MAX_BROWSER_SELECTOR_CHARS}) break;
        node = parent;
      }
      // Returning an ambiguous selector is worse than omitting it: a later AI
      // action could otherwise target the first matching destructive control.
      return '';
    };
    const viewportWidth = Number.isFinite(innerWidth) ? innerWidth : 0;
    const viewportHeight = Number.isFinite(innerHeight) ? innerHeight : 0;
    const occlusionPoints = [];
    const rememberOcclusionPoint = (x, y) => {
      if (
        occlusionPoints.length >= ${MAX_BROWSER_INSPECTION_OCCLUSION_POINTS} ||
        !Number.isFinite(x) ||
        !Number.isFinite(y)
      ) return false;
      occlusionPoints.push({ x, y });
      return true;
    };
    const viewportRect = (rect) => {
      const left = Number.isFinite(rect.left) ? rect.left : 0;
      const top = Number.isFinite(rect.top) ? rect.top : 0;
      const width = Number.isFinite(rect.width) ? rect.width : 0;
      const height = Number.isFinite(rect.height) ? rect.height : 0;
      const right = Number.isFinite(rect.right) ? rect.right : left + width;
      const bottom = Number.isFinite(rect.bottom) ? rect.bottom : top + height;
      const clipped = {
        left: Math.max(0, left),
        top: Math.max(0, top),
        right: Math.min(viewportWidth, right),
        bottom: Math.min(viewportHeight, bottom),
      };
      return width > 0 && height > 0 && clipped.right > clipped.left && clipped.bottom > clipped.top
        ? clipped
        : null;
    };
    const styleAllowsVisibility = (el) => {
      let node = el;
      while (node && node.nodeType === 1) {
        let style;
        try { style = getComputedStyle(node); } catch { return false; }
        const opacity = Number.parseFloat(style.opacity);
        if (
          node.hidden ||
          node.getAttribute?.('aria-hidden') === 'true' ||
          style.visibility === 'hidden' ||
          style.visibility === 'collapse' ||
          style.display === 'none' ||
          style.contentVisibility === 'hidden' ||
          (Number.isFinite(opacity) && opacity <= 0)
        ) return false;
        node = node.parentElement;
      }
      return true;
    };
    const samplePoints = (rect) => {
      const insetX = Math.min(2, (rect.right - rect.left) / 2);
      const insetY = Math.min(2, (rect.bottom - rect.top) / 2);
      return [
        [(rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2],
        [rect.left + insetX, rect.top + insetY],
        [rect.right - insetX, rect.top + insetY],
        [rect.left + insetX, rect.bottom - insetY],
        [rect.right - insetX, rect.bottom - insetY],
      ];
    };
    const hasUnoccludedPoint = (el, rect, allowDescendant) => {
      if (typeof document.elementsFromPoint !== 'function') return false;
      for (const [x, y] of samplePoints(rect)) {
        let stack;
        try { stack = Array.from(document.elementsFromPoint(x, y) || []); } catch { continue; }
        const targetIndex = stack.findIndex((candidate) =>
          candidate === el || (allowDescendant && typeof el.contains === 'function' && el.contains(candidate))
        );
        if (targetIndex < 0) continue;
        // Normal DOM hit testing respects overflow and clip-path but skips
        // pointer-events:none overlays. Record each admitted point so main can
        // repeat the hit test through CDP with that CSS rule ignored.
        let blocked = false;
        for (let index = 0; index < targetIndex; index += 1) {
          const candidate = stack[index];
          if (allowDescendant && typeof el.contains === 'function' && el.contains(candidate)) continue;
          let style;
          try { style = getComputedStyle(candidate); } catch { blocked = true; break; }
          const opacity = Number.parseFloat(style.opacity);
          if (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.visibility !== 'collapse' &&
            (!Number.isFinite(opacity) || opacity > 0)
          ) { blocked = true; break; }
        }
        if (!blocked && rememberOcclusionPoint(x, y)) return true;
      }
      return false;
    };
    const visibleElementRect = (el) => {
      if (!el || el.nodeType !== 1 || !styleAllowsVisibility(el)) return null;
      let raw;
      try { raw = el.getBoundingClientRect(); } catch { return null; }
      const clipped = viewportRect(raw);
      return clipped ? { raw, clipped } : null;
    };
    const isVisible = (el) => {
      const rect = visibleElementRect(el);
      return !!rect && hasUnoccludedPoint(el, rect.clipped, true);
    };
    const isTextVisible = (textNode, parent) => {
      if (!styleAllowsVisibility(parent) || typeof document.createRange !== 'function') return false;
      let rects;
      try {
        const range = document.createRange();
        range.selectNodeContents(textNode);
        rects = Array.from(range.getClientRects()).slice(0, 64);
        range.detach?.();
      } catch { return false; }
      return rects.some((rawRect) => {
        const rect = viewportRect(rawRect);
        return !!rect && hasUnoccludedPoint(parent, rect, false);
      });
    };
    const visibleTextWithin = (root, limit) => {
      if (!root || typeof document.createTreeWalker !== 'function') return '';
      const parts = [];
      let length = 0;
      let visited = 0;
      let walker;
      try { walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); } catch { return ''; }
      for (let textNode = walker.nextNode(); textNode && visited < 10000 && length < limit; textNode = walker.nextNode()) {
        visited += 1;
        const parent = textNode.parentElement;
        const tag = parent?.tagName;
        if (
          !parent ||
          tag === 'SCRIPT' ||
          tag === 'STYLE' ||
          tag === 'NOSCRIPT' ||
          tag === 'TEMPLATE' ||
          !isTextVisible(textNode, parent)
        ) continue;
        const text = bounded(textNode.textContent, limit - length).replace(/\\s+/g, ' ').trim();
        if (!text) continue;
        parts.push(text);
        length += text.length + 1;
      }
      return bounded(parts.join(' '), limit);
    };
    const isInteractiveCandidate = (el) => {
      const tag = bounded(el?.tagName, 32).toUpperCase();
      if (tag === 'A' || tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
      if (tag === 'INPUT') {
        const type = bounded(el.getAttribute?.('type') ?? el.type, 64).toLowerCase();
        return type !== 'password';
      }
      if (typeof el?.getAttribute !== 'function') return false;
      return el.getAttribute('role') !== null || el.getAttribute('tabindex') !== null;
    };
    const elements = [];
    let visitedElements = 0;
    let visitedCandidates = 0;
    let truncated = false;
    let elementWalker = null;
    const inspectionRoot = document.documentElement ?? document.body;
    try {
      if (inspectionRoot) elementWalker = document.createTreeWalker(inspectionRoot, NodeFilter.SHOW_ELEMENT);
      else truncated = true;
    } catch { truncated = true; }
    while (elementWalker) {
      if (
        elements.length >= ${MAX_BROWSER_INSPECTION_ELEMENTS} ||
        visitedElements >= ${MAX_BROWSER_INSPECTION_DOM_VISITS} ||
        visitedCandidates >= ${MAX_BROWSER_INSPECTION_CANDIDATES}
      ) {
        truncated = true;
        break;
      }
      let el;
      try { el = elementWalker.nextNode(); } catch { truncated = true; break; }
      if (!el) break;
      visitedElements += 1;
      if (!isInteractiveCandidate(el)) continue;
      // CSS-hidden and off-viewport controls must not consume the separate
      // hit-testing budget and starve later visible controls. Occluded controls
      // still count because proving occlusion is the expensive operation.
      const candidateRect = visibleElementRect(el);
      if (!candidateRect) continue;
      visitedCandidates += 1;
      if (!hasUnoccludedPoint(el, candidateRect.clipped, true)) continue;
      const rect = candidateRect.raw;
      elements.push({
        id: 'el-' + elements.length,
        selector: selectorFor(el),
        role: bounded(roleFor(el), ${MAX_BROWSER_ROLE_CHARS}) || undefined,
        name: bounded(accessibleNameFor(el), ${MAX_BROWSER_INSPECTION_NAME_CHARS}),
        text: visibleTextWithin(el, ${MAX_BROWSER_INSPECTION_TEXT_CHARS}).trim(),
        x: Number.isFinite(rect.left) ? rect.left : 0,
        y: Number.isFinite(rect.top) ? rect.top : 0,
        width: Number.isFinite(rect.width) ? rect.width : 0,
        height: Number.isFinite(rect.height) ? rect.height : 0,
        disabled: !!el.disabled,
      });
    }
    return {
      visibleText: visibleTextWithin(document.body, ${MAX_BROWSER_INSPECTION_VISIBLE_TEXT_CHARS}),
      scrollX: Number.isFinite(globalThis.scrollX) ? globalThis.scrollX : 0,
      scrollY: Number.isFinite(globalThis.scrollY) ? globalThis.scrollY : 0,
      viewportWidth,
      viewportHeight,
      truncated,
      elements,
      __kaiOcclusionPoints: occlusionPoints,
    };
  })()`;
}
