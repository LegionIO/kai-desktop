import { describe, it, expect } from 'vitest';
import {
  markConversationCompacting,
  clearConversationCompacting,
  isConversationCompacting,
} from '../compaction-ui-store';

describe('compaction-ui-store (module-level, survives ComposerInput remounts)', () => {
  it('marks and clears a conversation id', () => {
    expect(isConversationCompacting('c1')).toBe(false);
    markConversationCompacting('c1');
    expect(isConversationCompacting('c1')).toBe(true);
    clearConversationCompacting('c1');
    expect(isConversationCompacting('c1')).toBe(false);
  });

  it('tracks concurrent compactions in different chats independently', () => {
    markConversationCompacting('a');
    markConversationCompacting('b');
    expect(isConversationCompacting('a')).toBe(true);
    expect(isConversationCompacting('b')).toBe(true);
    clearConversationCompacting('a');
    expect(isConversationCompacting('a')).toBe(false);
    // Clearing one chat must NOT clear the other (the scalar-marker bug this guards).
    expect(isConversationCompacting('b')).toBe(true);
    clearConversationCompacting('b');
  });

  it('treats null/undefined ids as not compacting', () => {
    expect(isConversationCompacting(null)).toBe(false);
    expect(isConversationCompacting(undefined)).toBe(false);
  });

  it('ref-counts local marks so an overlapping clear does not cancel a still-running compact', () => {
    // Two overlapping runCompact calls for the same chat (e.g. one accepted, one that
    // the backend rejects as busy) each mark then clear. The rejected call's clear must
    // NOT drop the id while the accepted call is still running.
    markConversationCompacting('dup');
    markConversationCompacting('dup');
    expect(isConversationCompacting('dup')).toBe(true);
    clearConversationCompacting('dup'); // rejected call finishes first
    expect(isConversationCompacting('dup')).toBe(true); // accepted call still holds it
    clearConversationCompacting('dup'); // accepted call finishes
    expect(isConversationCompacting('dup')).toBe(false);
  });

  it('ignores an unbalanced clear (no local mark)', () => {
    expect(isConversationCompacting('never-marked')).toBe(false);
    clearConversationCompacting('never-marked');
    expect(isConversationCompacting('never-marked')).toBe(false);
  });
});
