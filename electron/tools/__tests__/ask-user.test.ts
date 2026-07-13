/**
 * Tests for ask-user.ts: the ask_user tool's read+delete-on-execute contract and
 * the FIFO bound on pendingQuestionAnswers. Answers are normally consumed by
 * execute(), but a turn aborted after the user answered and before execute
 * re-runs orphans the entry — stashQuestionAnswers caps the map so that leak
 * stays bounded (matches loginAttempts/exitCodes bounded-map patterns).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { pendingQuestionAnswers, stashQuestionAnswers, createAskUserTool } from '../ask-user.js';
import type { ToolExecutionContext } from '../types.js';

beforeEach(() => {
  pendingQuestionAnswers.clear();
});

const ctx = (toolCallId: string): ToolExecutionContext => ({ toolCallId }) as ToolExecutionContext;

describe('stashQuestionAnswers', () => {
  it('stores answers under the toolCallId', () => {
    stashQuestionAnswers('tc-1', { Q: 'A' });
    expect(pendingQuestionAnswers.get('tc-1')).toEqual({ Q: 'A' });
  });

  it('bounds the map at 100 entries, evicting oldest-first (FIFO)', () => {
    for (let i = 0; i < 150; i++) stashQuestionAnswers(`tc-${i}`, { n: String(i) });
    expect(pendingQuestionAnswers.size).toBe(100);
    // The oldest 50 were evicted; the newest 100 (tc-50..tc-149) remain.
    expect(pendingQuestionAnswers.has('tc-0')).toBe(false);
    expect(pendingQuestionAnswers.has('tc-49')).toBe(false);
    expect(pendingQuestionAnswers.has('tc-50')).toBe(true);
    expect(pendingQuestionAnswers.has('tc-149')).toBe(true);
  });

  it('re-stashing an existing key updates it without growing the map', () => {
    stashQuestionAnswers('dup', { v: '1' });
    stashQuestionAnswers('dup', { v: '2' });
    expect(pendingQuestionAnswers.size).toBe(1);
    expect(pendingQuestionAnswers.get('dup')).toEqual({ v: '2' });
  });
});

describe('createAskUserTool execute', () => {
  it('reads AND deletes the stashed answers (one-time consume)', async () => {
    const tool = createAskUserTool();
    stashQuestionAnswers('tc-x', { Pick: 'Option A' });
    const result = await tool.execute!({ questions: [] }, ctx('tc-x'));
    expect(result).toEqual({ success: true, answers: { Pick: 'Option A' } });
    // Consumed: the entry is gone, so a second execute finds nothing.
    expect(pendingQuestionAnswers.has('tc-x')).toBe(false);
  });

  it('returns an error when no answers were stashed for the toolCallId', async () => {
    const tool = createAskUserTool();
    const result = await tool.execute!({ questions: [] }, ctx('tc-missing'));
    expect(result).toEqual({ error: 'No user response received' });
  });
});
