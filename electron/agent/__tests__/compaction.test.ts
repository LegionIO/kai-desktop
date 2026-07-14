import { describe, it, expect } from 'vitest';
import { isStrictPrefix, selectProtectedTail, splitPreservedFields, type ChatMessage } from '../compaction';

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
