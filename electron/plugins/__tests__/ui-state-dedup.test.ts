import { describe, it, expect } from 'vitest';
import { uiStateChanged } from '../plugin-manager.js';

/**
 * The UI-state broadcast dedup (plugin-manager.ts): identical snapshots must NOT
 * re-broadcast. A plugin (e.g. msgraph) can publish a large, growing
 * publishedState, and broadcastUIState() fires on many triggers — without dedup
 * the full (multi-MB) snapshot was re-sent to every window/web/CLI client on
 * every emit, flooding the CLI socket and tripping its heartbeat (reconnect loop).
 */
describe('uiStateChanged (UI-state broadcast dedup)', () => {
  it('is false for a byte-identical snapshot (emit skipped)', () => {
    const json = JSON.stringify({ pluginStates: { msgraph: { threads: [1, 2, 3] } } });
    expect(uiStateChanged(json, json)).toBe(false);
  });

  it('is true when any content changed (emit proceeds)', () => {
    const a = JSON.stringify({ pluginStates: { msgraph: { n: 1 } } });
    const b = JSON.stringify({ pluginStates: { msgraph: { n: 2 } } });
    expect(uiStateChanged(a, b)).toBe(true);
  });

  it('treats the initial empty->populated transition as a change', () => {
    expect(uiStateChanged('', JSON.stringify({ banners: [] }))).toBe(true);
  });
});
