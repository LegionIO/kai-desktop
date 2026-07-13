/**
 * Tests for shouldAdoptBroadcastActiveId — the anti-hijack guard for the sidebar.
 * "Active conversation" is a single GLOBAL backend value, so any client (a second
 * GUI window, or the `kai` CLI) flipping it broadcasts to everyone. This guard
 * decides whether THIS window should follow that broadcast onto a new selection.
 * The bug it fixes: the CLI creating/selecting a chat yanked the GUI user's
 * selection outline onto a different conversation.
 */
import { describe, it, expect } from 'vitest';
import { shouldAdoptBroadcastActiveId } from '../conversation-selection';

describe('shouldAdoptBroadcastActiveId', () => {
  it('adopts when this window has no selection yet (initial load)', () => {
    expect(shouldAdoptBroadcastActiveId(null, 'conv-a')).toBe(true);
  });

  it('adopts (idempotent) when the broadcast active-id already matches our selection', () => {
    expect(shouldAdoptBroadcastActiveId('conv-a', 'conv-a')).toBe(true);
  });

  it('does NOT adopt when a DIFFERENT conversation becomes active (the CLI-hijack case)', () => {
    // GUI is on conv-a; the CLI creates/selects conv-b and flips the global active.
    // The GUI must keep its own selection, not jump to conv-b.
    expect(shouldAdoptBroadcastActiveId('conv-a', 'conv-b')).toBe(false);
  });

  it('does NOT adopt a null active-id here (null is handled by a separate branch)', () => {
    expect(shouldAdoptBroadcastActiveId('conv-a', null)).toBe(false);
    expect(shouldAdoptBroadcastActiveId(null, null)).toBe(false);
  });
});
