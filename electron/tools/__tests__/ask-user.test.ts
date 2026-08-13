/**
 * Tests for ask-user.ts: the ask_user tool's read+delete-on-execute contract and
 * the FIFO bound on pendingQuestionAnswers. Answers are normally consumed by
 * execute(), but a turn aborted after the user answered and before execute
 * re-runs orphans the entry — stashQuestionAnswers caps the map so that leak
 * stays bounded (matches loginAttempts/exitCodes bounded-map patterns).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// alert-notify pulls in electron via the alerts IPC handler it forwards to; the
// tool only needs the store write to happen, so stub the notify seam.
vi.mock('../../ipc/alert-notify.js', () => ({ notifyAlertCreated: vi.fn() }));

import { pendingQuestionAnswers, stashQuestionAnswers, createAskUserTool, resolveAskUserGateOutcome, ASK_USER_NO_ANSWER_ERROR, waitForRacedAnswer, rekeyRacedAnswer, formatRacedAnswerAsUserTurn } from '../ask-user.js';
import { listAlerts, readAlert } from '../../ipc/alert-store.js';
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

describe('rekeyRacedAnswer', () => {
  it('is a NO-OP when the ids are equal — the answer stays retrievable (regression)', () => {
    // ask_user pairs by id-identity, so streamId === execId. A naive
    // copy-then-delete would delete the entry it just wrote; rekey must not.
    stashQuestionAnswers('same-id', { Q: 'kept' });
    rekeyRacedAnswer('same-id', 'same-id', { Q: 'kept' });
    expect(pendingQuestionAnswers.get('same-id')).toEqual({ Q: 'kept' });
  });

  it('moves the answer from the stream id to a DIFFERENT exec id', () => {
    stashQuestionAnswers('stream-id', { Q: 'moved' });
    rekeyRacedAnswer('stream-id', 'exec-id', { Q: 'moved' });
    expect(pendingQuestionAnswers.has('stream-id')).toBe(false);
    expect(pendingQuestionAnswers.get('exec-id')).toEqual({ Q: 'moved' });
  });
});

describe('formatRacedAnswerAsUserTurn', () => {
  it('renders each question → choice as a user-turn message', () => {
    const text = formatRacedAnswerAsUserTurn({
      'Which environment?': 'prod',
      'Confirm region?': 'us-east-1',
    });
    expect(text).toContain('[Answering your question]');
    expect(text).toContain('- Which environment? → prod');
    expect(text).toContain('- Confirm region? → us-east-1');
  });

  it('falls back to a placeholder when there are no answers', () => {
    expect(formatRacedAnswerAsUserTurn({})).toContain('(no answer provided)');
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
    expect(result).toEqual({ error: ASK_USER_NO_ANSWER_ERROR });
  });
});

describe('resolveAskUserGateOutcome', () => {
  it('runs the tool (no skip) when the user approved', () => {
    expect(resolveAskUserGateOutcome(true, false)).toEqual({ skip: false });
    // Even if the controller aborted, an explicit approve still runs.
    expect(resolveAskUserGateOutcome(true, true)).toEqual({ skip: false });
  });

  it('skips with a "dismissed" result on a genuine reject (false)', () => {
    const out = resolveAskUserGateOutcome(false, false);
    expect(out.skip).toBe(true);
    if (out.skip) {
      expect(out.reason).toBe('reject');
      expect(out.result.isError).toBe(true);
      expect(out.result.error).toMatch(/dismissed/i);
    }
  });

  it('skips with a "dismissed" result when the user closed the card (dismiss, not aborted)', () => {
    const out = resolveAskUserGateOutcome('dismiss', false);
    expect(out.skip).toBe(true);
    if (out.skip) {
      expect(out.reason).toBe('dismiss');
      expect(out.result.error).toMatch(/dismissed/i);
    }
  });

  it('skips with a NEUTRAL "cancelled" result when dismiss is due to an abort (turn ended)', () => {
    // The bug scenario: the user DID answer, but the turn controller aborted
    // (superseded / plan-restart) and settled the approval as dismiss. The gate
    // must NOT emit the scary "dismissed the question" error — it reports a
    // neutral cancellation, and the raced answer (recovered separately) can run.
    const out = resolveAskUserGateOutcome('dismiss', true);
    expect(out.skip).toBe(true);
    if (out.skip) {
      expect(out.reason).toBe('abort');
      expect(out.result.error).toMatch(/cancelled|turn ended/i);
      expect(out.result.error).not.toMatch(/dismissed the question/i);
    }
  });
});

describe('waitForRacedAnswer', () => {
  it('returns immediately when the answer is already stashed', async () => {
    stashQuestionAnswers('tc-now', { Q: 'A' });
    const answer = await waitForRacedAnswer('tc-now', 20, 10);
    expect(answer).toEqual({ Q: 'A' });
  });

  it('resolves as soon as an answer lands within the grace window (abort-first race)', async () => {
    // The answer IPC lands shortly AFTER the gate began waiting — exactly the
    // abort-first race the grace wait is meant to cover.
    setTimeout(() => stashQuestionAnswers('tc-late', { Q: 'landed' }), 30);
    const answer = await waitForRacedAnswer('tc-late', 20, 10);
    expect(answer).toEqual({ Q: 'landed' });
  });

  it('resolves undefined after exhausting its poll attempts when no answer arrives', async () => {
    // Attempt-count bound (not a wall-clock deadline) so it terminates even
    // under vitest's frozen system clock (vi.setSystemTime in the global setup).
    const answer = await waitForRacedAnswer('tc-never', 3, 5);
    expect(answer).toBeUndefined();
  });
});

describe('createAskUserTool headless fallback', () => {
  let appHome: string;
  beforeEach(() => {
    appHome = mkdtempSync(join(tmpdir(), 'kai-askuser-'));
    mkdirSync(join(appHome, 'data'), { recursive: true });
  });
  afterEach(() => rmSync(appHome, { recursive: true, force: true }));

  const q = { question: 'Which environment?', header: 'Env', options: [{ label: 'staging' }, { label: 'prod' }] };
  const headlessCtx = (toolCallId: string, conversationId?: string): ToolExecutionContext =>
    ({ toolCallId, conversationId, isHeadless: true }) as ToolExecutionContext;

  it('raises a question alert instead of failing when headless with no answer', async () => {
    const tool = createAskUserTool(appHome);
    const result = (await tool.execute!({ questions: [q] }, headlessCtx('tc-h', 'conv-9'))) as Record<string, unknown>;
    expect(result.suspended).toBe(true);
    expect(typeof result.alertId).toBe('string');
    const alerts = listAlerts(appHome);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('question');
    const alert = readAlert(appHome, result.alertId as string);
    expect(alert?.conversationId).toBe('conv-9');
    expect(alert?.questions?.[0].header).toBe('Env');
  });

  it('still errors (no alert) when headless but there is no conversation to resume into', async () => {
    const tool = createAskUserTool(appHome);
    const result = await tool.execute!({ questions: [q] }, headlessCtx('tc-h2', undefined));
    expect(result).toEqual({ error: ASK_USER_NO_ANSWER_ERROR });
    expect(listAlerts(appHome)).toHaveLength(0);
  });

  it('does NOT raise an alert in the interactive path (not headless)', async () => {
    const tool = createAskUserTool(appHome);
    const result = await tool.execute!({ questions: [q] }, ctx('tc-i'));
    expect(result).toEqual({ error: ASK_USER_NO_ANSWER_ERROR });
    expect(listAlerts(appHome)).toHaveLength(0);
  });

  it('prefers stashed answers even when headless', async () => {
    const tool = createAskUserTool(appHome);
    stashQuestionAnswers('tc-h3', { Env: 'prod' });
    const result = await tool.execute!({ questions: [q] }, headlessCtx('tc-h3', 'conv-9'));
    expect(result).toEqual({ success: true, answers: { Env: 'prod' } });
    expect(listAlerts(appHome)).toHaveLength(0);
  });

  it('does not spawn a duplicate alert for the same conversation + question (loop guard)', async () => {
    const tool = createAskUserTool(appHome);
    const r1 = (await tool.execute!({ questions: [q] }, headlessCtx('tc-d1', 'conv-9'))) as Record<string, unknown>;
    const r2 = (await tool.execute!({ questions: [q] }, headlessCtx('tc-d2', 'conv-9'))) as Record<string, unknown>;
    expect(r1.suspended).toBe(true);
    expect(r2.suspended).toBe(true);
    // Same alert reused, only one created.
    expect(r2.alertId).toBe(r1.alertId);
    expect(listAlerts(appHome)).toHaveLength(1);
  });
});
