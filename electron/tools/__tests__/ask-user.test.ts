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

import { pendingQuestionAnswers, stashQuestionAnswers, createAskUserTool } from '../ask-user.js';
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
    expect(result).toEqual({ error: 'No user response received' });
    expect(listAlerts(appHome)).toHaveLength(0);
  });

  it('does NOT raise an alert in the interactive path (not headless)', async () => {
    const tool = createAskUserTool(appHome);
    const result = await tool.execute!({ questions: [q] }, ctx('tc-i'));
    expect(result).toEqual({ error: 'No user response received' });
    expect(listAlerts(appHome)).toHaveLength(0);
  });

  it('prefers stashed answers even when headless', async () => {
    const tool = createAskUserTool(appHome);
    stashQuestionAnswers('tc-h3', { Env: 'prod' });
    const result = await tool.execute!({ questions: [q] }, headlessCtx('tc-h3', 'conv-9'));
    expect(result).toEqual({ success: true, answers: { Env: 'prod' } });
    expect(listAlerts(appHome)).toHaveLength(0);
  });
});
