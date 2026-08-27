/**
 * Shared resolver for media source URLs in renderer components.
 *
 * Attachments and generated media can be carried three ways in a content part's
 * `image`/`data`/`src`:
 *   - a `data:` URL (inline base64) — usable directly everywhere
 *   - an `http(s):` URL — usable directly everywhere
 *   - a `kai-media://<type>/<name>` URL — an offloaded/generated file served from
 *     the app-home media dir
 *
 * In the Electron renderer the custom media protocol handler resolves
 * `kai-media://` directly, so it can be used as an element `src` unchanged. In the
 * WEB bridge there is no such protocol handler; the web server exposes the same
 * files under `/media/<type>/<name>`, so `kai-media://` must be rewritten to that
 * relative path. This mirrors the rewrite MarkdownText applies to markdown media,
 * centralised so every `<img>`/`<iframe>`/preview site (not just markdown) resolves
 * media consistently in both modes.
 */

const MEDIA_PROTOCOL_PREFIX = __BRAND_MEDIA_PROTOCOL + '://';

/** True when running inside the authenticated web bridge (no Electron protocols). */
export function isWebBridgeRuntime(): boolean {
  return Boolean(
    (window as unknown as Record<string, unknown>).app &&
      ((window as unknown as { app?: Record<string, unknown> }).app as Record<string, unknown>)?.__isWebBridge,
  );
}

/** Whether a src value is a `kai-media://` URL that needs runtime resolution. */
export function isMediaProtocolUrl(src: unknown): src is string {
  return typeof src === 'string' && src.startsWith(MEDIA_PROTOCOL_PREFIX);
}

/**
 * Resolve a media src for use as an element `src`/`href` in the current runtime.
 * - `data:` / `http(s):` / other values → returned unchanged.
 * - `kai-media://…` → returned unchanged in Electron (the protocol handler serves
 *   it); rewritten to `/media/…` in the web bridge (served by the web server).
 */
export function resolveMediaSrc(src: string): string {
  if (!isMediaProtocolUrl(src)) return src;
  if (isWebBridgeRuntime()) {
    return '/media/' + src.slice(MEDIA_PROTOCOL_PREFIX.length);
  }
  return src;
}
