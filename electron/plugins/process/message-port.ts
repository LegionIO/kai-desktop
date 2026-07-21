/**
 * The tiny subset of Electron's ParentPort used by the plugin transport.
 *
 * Keeping this structural interface Electron-free lets the exact same
 * callback/stream/abort protocol run over the authenticated socket used by the
 * Node SEA host. Electron utility processes still satisfy it directly.
 */
export type PluginMessageEvent = { data: unknown };

export interface PluginMessagePort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: PluginMessageEvent) => void): unknown;
  off(event: 'message', listener: (event: PluginMessageEvent) => void): unknown;
}
