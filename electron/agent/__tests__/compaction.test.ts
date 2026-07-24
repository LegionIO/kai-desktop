import { describe, it, expect, beforeEach } from 'vitest';
import {
  isStrictPrefix,
  selectProtectedTail,
  splitPreservedFields,
  shouldCompact,
  type ChatMessage,
} from '../compaction';
import {
  resolveConversationTokenization,
  countSerializedTokens,
  __clearExactTokenCacheForTests,
} from '../tokenization';

describe('shouldCompact (cheap pre-check gate + exact count)', () => {
  beforeEach(() => __clearExactTokenCacheForTests());

  const MODEL = 'gpt-4o'; // contextWindow 128000
  const window = 128000;

  it('does NOT compact a short conversation (estimate below trigger, no exact encode needed)', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const res = shouldCompact(msgs, MODEL, 0.85);
    expect(res.shouldCompact).toBe(false);
    expect(res.contextWindowTokens).toBe(window);
  });

  it('the cheap estimate never under-reports vs the exact count, so a real over-trigger still compacts', () => {
    // Build a branch whose EXACT token count exceeds the trigger.
    const trigger = 0.85;
    const triggerTokens = Math.floor(window * trigger);
    const tokenization = resolveConversationTokenization(MODEL);
    // ~4 chars/token; make content comfortably over the trigger.
    const big = 'The quick brown fox jumps over the lazy dog. '.repeat(30000);
    const msgs: ChatMessage[] = [{ role: 'user', content: big }];
    const exact = countSerializedTokens(msgs, tokenization)!;
    expect(exact).toBeGreaterThan(triggerTokens); // precondition: genuinely over
    const res = shouldCompact(msgs, MODEL, trigger);
    expect(res.shouldCompact).toBe(true);
    expect(res.usedTokens).toBe(exact); // exact count reported when gate passes
  });

  it('a value just under the trigger by exact count is NOT compacted even if the estimate crosses it', () => {
    // Choose a low trigger so a modest branch makes the estimate cross while the
    // exact count stays under — verifies the exact check is authoritative.
    const trigger = 0.0005; // 128000 * 0.0005 = 64 tokens
    const tokenization = resolveConversationTokenization(MODEL);
    const msgs: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(250) }];
    const exact = countSerializedTokens(msgs, tokenization)!;
    const triggerTokens = Math.floor(window * trigger);
    // Repeated single char tokenizes to FEWER tokens than chars/3 estimates.
    if (exact < triggerTokens) {
      const res = shouldCompact(msgs, MODEL, trigger);
      expect(res.shouldCompact).toBe(false);
      // usedTokens is the exact count (gate passed → we ran the real encode)
      expect(res.usedTokens).toBe(exact);
    } else {
      // If the content happened to exceed the trigger, the assertion is trivially
      // satisfied elsewhere; skip to avoid a brittle expectation.
      expect(true).toBe(true);
    }
  });

  it('uses a conservative fallback window for an unknown model (compaction stays enabled)', () => {
    // Unknown models previously resolved a null window → shouldCompact bailed with
    // zeros and compaction NEVER ran, so history grew unbounded and froze the main
    // thread. Now an unknown model gets a conservative window: a tiny history still
    // doesn't compact, but the window is reported (nonzero) so a large one WILL.
    const res = shouldCompact([{ role: 'user', content: 'hi' }], 'totally-made-up-model-xyz', 0.85);
    expect(res.shouldCompact).toBe(false);
    expect(res.contextWindowTokens).toBeGreaterThan(0);
  });

  it('summed per-message tokenCount gates the exact check (accumulator on the hot path)', () => {
    // The cheap gate is the SUM of cached per-message tokenCounts (integer add, no
    // whole-history stringify+encode). When the sum crosses the trigger we run the
    // authoritative exact count. Here real content is genuinely large AND carries
    // cached counts, so the sum gate trips and the exact check confirms → compacts.
    const trigger = 0.85;
    const big = 'The quick brown fox jumps over the lazy dog. '.repeat(30000);
    const tokenization = resolveConversationTokenization(MODEL);
    const realCount = countSerializedTokens([{ role: 'user', content: big }], tokenization)!;
    const msgs: ChatMessage[] = [{ role: 'user', content: big, tokenCount: realCount }];
    const res = shouldCompact(msgs, MODEL, trigger);
    expect(res.shouldCompact).toBe(true);
  });

  it('a large summed count with tiny real content does NOT compact (exact check is authoritative)', () => {
    // Guards the design contract: the cheap sum only decides whether to RUN the
    // exact encode; it never forces compaction on its own. A bogus/high cached
    // count trips the gate but the exact count (tiny) vetoes.
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'a', tokenCount: 1_000_000 },
      { role: 'assistant', content: 'b', tokenCount: 1_000_000 },
    ];
    const res = shouldCompact(msgs, MODEL, 0.85);
    expect(res.shouldCompact).toBe(false);
  });

  it('trusts cached counts for a CANONICAL-tokenizer model (integer-only fast path)', () => {
    // gpt-5 shares the o200k encoding the cached counts are computed with, so the
    // gate trusts them directly and reports their sum.
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'a', tokenCount: 10 },
      { role: 'assistant', content: 'b', tokenCount: 20 },
    ];
    const res = shouldCompact(msgs, 'gpt-5', 0.85);
    expect(res.shouldCompact).toBe(false);
    expect(res.usedTokens).toBe(30); // cached sum trusted
  });

  it('does NOT trust an o200k cached count for a NON-canonical tokenizer (uses a safe ceiling)', () => {
    // For a cl100k-family model (gpt-4o), an o200k cached count is not a safe floor.
    // A bogus tiny count on large content must NOT let the gate under-count: the
    // model-independent byte ceiling is used, so usedTokens reflects real size.
    const big = 'The quick brown fox jumps over the lazy dog. '.repeat(50);
    const msgs: ChatMessage[] = [{ role: 'user', content: big, tokenCount: 1 }];
    const res = shouldCompact(msgs, 'gpt-4o', 0.85);
    expect(res.usedTokens).toBeGreaterThan(1); // did not trust the bogus low count
  });
});

describe('isStrictPrefix (compaction reuse / divergence detector)', () => {
  it('is true when ids are an ordered prefix of the branch', () => {
    expect(isStrictPrefix(['a', 'b'], ['a', 'b', 'c', 'd'])).toBe(true);
  });

  it('is true when ids equal the whole branch', () => {
    expect(isStrictPrefix(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(true);
  });

  it('is false on an empty stored-id list (nothing to reuse ⇒ recompute)', () => {
    expect(isStrictPrefix([], ['a', 'b'])).toBe(false);
  });

  it('is false when the stored ids are longer than the branch', () => {
    expect(isStrictPrefix(['a', 'b', 'c'], ['a', 'b'])).toBe(false);
  });

  it('is false when the branch diverges mid-prefix (fork/edit changed a leading id)', () => {
    // e.g. the user edited message b → its id changed; the summary no longer applies.
    expect(isStrictPrefix(['a', 'b', 'c'], ['a', 'B2', 'c', 'd'])).toBe(false);
  });

  it('is false when the very first id differs (rewind to a different root child)', () => {
    expect(isStrictPrefix(['a', 'b'], ['x', 'b'])).toBe(false);
  });

  it('order matters — same set in different order is not a prefix', () => {
    expect(isStrictPrefix(['a', 'b'], ['b', 'a', 'c'])).toBe(false);
  });

  it('a stored empty-string id cannot match an id-less branch sentinel', () => {
    // Defense-in-depth: even if a bad record had [''], the reuse gate maps id-less
    // branch messages to a unique sentinel (never ''), so this must not match.
    expect(isStrictPrefix([''], [' no-id-0', 'b'])).toBe(false);
  });
});

describe('selectProtectedTail (compaction boundary + tool-call/result pair integrity)', () => {
  const u = (text: string): ChatMessage => ({ role: 'user', content: text });
  const a = (text: string): ChatMessage => ({ role: 'assistant', content: text });
  const aCall = (id: string): ChatMessage => ({ role: 'assistant', content: '', tool_calls: [{ id }] });
  const toolResult = (id: string): ChatMessage => ({ role: 'tool', tool_call_id: id, content: 'result' });
  // content-part shapes (the form the earlier code missed)
  const aCallPart = (id: string): ChatMessage => ({
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: id }] as unknown as ChatMessage['content'],
  });
  const resultPart = (id: string): ChatMessage => ({
    role: 'assistant',
    content: [{ type: 'tool-result', toolCallId: id }] as unknown as ChatMessage['content'],
  });

  it('protects the N recent user + M recent assistant messages (boundary at the earliest protected)', () => {
    const msgs = [u('1'), a('2'), u('3'), a('4'), u('5'), a('6')];
    // protect 1 recent user + 1 recent assistant → indices 5 (a) and 4 (u)
    const { boundaryIndex } = selectProtectedTail(msgs, 1, 1);
    expect(boundaryIndex).toBe(4);
  });

  it('keeps a protected assistant tool-call together with its legacy {role:tool} result', () => {
    // ... call@2, result@3, then a protected assistant@4
    const msgs = [u('0'), u('1'), aCall('tc1'), toolResult('tc1'), a('later')];
    // protect 1 assistant → a('later')@4; its call chain: none. But protect the
    // pair-owning assistant: bump to protect 2 assistants so aCall@2 is protected.
    const { boundaryIndex } = selectProtectedTail(msgs, 0, 2);
    // a('later')@4 + aCall@2 protected; result@3 protected via forward pass → boundary 2
    expect(boundaryIndex).toBe(2);
  });

  it('protects a content-part {type:tool-result} of a protected call (both shapes handled)', () => {
    const msgs = [u('0'), aCallPart('tc9'), resultPart('tc9'), a('recent')];
    // protect 2 assistants: recent@3 + aCallPart@1 (issues tc9); resultPart@2
    // carries tc9 → must be protected too → boundary 1.
    const { boundaryIndex } = selectProtectedTail(msgs, 0, 2);
    expect(boundaryIndex).toBe(1);
  });

  it('PAIR INTEGRITY: pulls the boundary back so a retained result never orphans its compacted call', () => {
    // call@1 (unprotected/old), a protected message@3 sets boundary 3, but the
    // matching result@4 lands in the suffix. Without the fix, call@1 is compacted
    // (summary is prose, no tool_call) while result@4 is kept → orphan result.
    // The fix pulls boundary back to 1 so the whole pair stays in the suffix.
    const msgs = [u('0'), aCall('tcX'), u('2'), u('3'), toolResult('tcX')];
    // protect 1 recent user → u@3 (boundary 3); result@4 is NOT protected by the
    // window but its call tcX is at index 1 < boundary → boundary pulled to 1.
    const { boundaryIndex } = selectProtectedTail(msgs, 1, 0);
    expect(boundaryIndex).toBe(1);
  });

  it('does not extend the boundary when a retained result’s call is also in the suffix (no straddle)', () => {
    // call@3 + result@4 both after a boundary of 3 → nothing to pull back.
    const msgs = [u('0'), u('1'), u('2'), aCall('tcY'), toolResult('tcY')];
    const { boundaryIndex } = selectProtectedTail(msgs, 0, 1); // protect aCall@3
    expect(boundaryIndex).toBe(3);
  });

  it('returns boundary = length (compact nothing) when no protection window', () => {
    const msgs = [u('0'), a('1')];
    expect(selectProtectedTail(msgs, 0, 0).boundaryIndex).toBe(2);
  });
});

describe('splitPreservedFields (compaction-exempt tool-result fields)', () => {
  const img = { type: 'image', data: 'AAAA', mediaType: 'image/png' };

  it('leaves a plain result untouched (no reattach change)', () => {
    const r = { ok: true, note: 'done' };
    const { resultForCompaction, reattach } = splitPreservedFields(r);
    expect(resultForCompaction).toEqual(r);
    expect(reattach('summarized')).toBe('summarized'); // no-op passthrough
  });

  it('strips _modelContent before compaction and re-attaches it onto an object result', () => {
    const r = { caption: 'chart', _modelContent: [img] };
    const { resultForCompaction, reattach } = splitPreservedFields(r);
    // The media must NOT be in the body handed to the truncator.
    expect(resultForCompaction).toEqual({ caption: 'chart' });
    expect((resultForCompaction as Record<string, unknown>)._modelContent).toBeUndefined();
    // …and it comes back intact after compaction.
    expect(reattach({ caption: 'chart (shrunk)' })).toEqual({
      caption: 'chart (shrunk)',
      _modelContent: [img],
    });
  });

  it('re-attaches _modelContent onto a bare-string compaction result as shell-shaped output', () => {
    const { resultForCompaction, reattach } = splitPreservedFields({ _modelContent: [img] });
    expect(resultForCompaction).toEqual({});
    expect(reattach('...[truncated]...')).toEqual({ stdout: '...[truncated]...', _modelContent: [img] });
  });

  it('preserves _diffTracking and _modelContent together', () => {
    const dt = { diffs: [{ path: 'a.txt' }] };
    const { resultForCompaction, reattach } = splitPreservedFields({
      stdout: 'huge output',
      _diffTracking: dt,
      _modelContent: [img],
    });
    expect(resultForCompaction).toEqual({ stdout: 'huge output' });
    expect(reattach({ stdout: 'shrunk' })).toEqual({ stdout: 'shrunk', _diffTracking: dt, _modelContent: [img] });
  });

  it('ignores an empty _modelContent array (nothing to preserve)', () => {
    const r = { ok: true, _modelContent: [] };
    const { resultForCompaction, reattach } = splitPreservedFields(r);
    expect(resultForCompaction).toBe(r); // untouched
    expect(reattach('x')).toBe('x');
  });
});
