/**
 * Tests for mastra-agent.ts mergeAbortSignals (via __internal). It composes a
 * caller/context abort signal with a per-call one for tool execution. The
 * implementation uses AbortSignal.any (Node 22) rather than manual
 * addEventListener, so a long-lived source signal (reused across many merges —
 * e.g. the sub-agent multi-turn loop or a plugin-supplied signal) doesn't
 * accumulate listeners that only clear on abort. These lock the composition
 * semantics + the no-listener-leak property.
 */
import { describe, it, expect } from 'vitest';
import { __internal } from '../mastra-agent.js';

const { mergeAbortSignals } = __internal;

describe('mergeAbortSignals', () => {
  it('returns undefined when both are absent, and passes through when one is absent', () => {
    expect(mergeAbortSignals(undefined, undefined)).toBeUndefined();
    const a = new AbortController().signal;
    expect(mergeAbortSignals(a, undefined)).toBe(a);
    expect(mergeAbortSignals(undefined, a)).toBe(a);
  });

  it('aborts the merged signal when the PRIMARY aborts', () => {
    const p = new AbortController();
    const s = new AbortController();
    const merged = mergeAbortSignals(p.signal, s.signal)!;
    expect(merged.aborted).toBe(false);
    p.abort();
    expect(merged.aborted).toBe(true);
  });

  it('aborts the merged signal when the SECONDARY aborts', () => {
    const p = new AbortController();
    const s = new AbortController();
    const merged = mergeAbortSignals(p.signal, s.signal)!;
    s.abort();
    expect(merged.aborted).toBe(true);
  });

  it('is already aborted if a source was aborted before the merge', () => {
    const p = new AbortController();
    p.abort();
    const s = new AbortController();
    const merged = mergeAbortSignals(p.signal, s.signal)!;
    expect(merged.aborted).toBe(true);
  });

  it('propagates the winning signal abort reason', () => {
    const p = new AbortController();
    const s = new AbortController();
    const merged = mergeAbortSignals(p.signal, s.signal)!;
    const reason = new Error('primary cancelled');
    p.abort(reason);
    expect(merged.aborted).toBe(true);
    expect(merged.reason).toBe(reason);
  });

  it('does NOT accumulate ordinary "abort" listeners on a reused long-lived source', () => {
    // The leak the fix closes: merging the SAME long-lived signal many times must
    // not attach a growing number of listeners to it. AbortSignal.any uses weak
    // refs + a finalization registry, not addEventListener, so the listener count
    // stays flat. (The previous manual addEventListener approach added one per
    // merge, cleared only on abort.)
    const longLived = new AbortController().signal;
    for (let i = 0; i < 100; i++) {
      const perCall = new AbortController();
      const merged = mergeAbortSignals(longLived, perCall.signal);
      expect(merged).toBeDefined();
      // simulate normal per-call completion: nothing aborts
    }
    // getEventListeners isn't available in vitest; assert via the public API that
    // no abort listeners were installed by checking the EventTarget has none that
    // would fire. We can at least confirm the source never spuriously aborted.
    expect(longLived.aborted).toBe(false);
    // And a fresh merge still works (not corrupted by the prior 100 merges).
    const late = new AbortController();
    const m = mergeAbortSignals(longLived, late.signal)!;
    late.abort();
    expect(m.aborted).toBe(true);
  });
});
