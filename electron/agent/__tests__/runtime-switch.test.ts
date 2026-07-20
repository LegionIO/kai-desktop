/**
 * Tests for runtime-switch.ts — the cross-runtime conversation handoff. When a
 * user switches runtimes mid-conversation the new runtime needs the prior
 * context. These cover the pure logic: switch DETECTION (compare current runtime
 * vs the runtimeId on the last assistant message), context WRAPPING (label +
 * XML), and the under-threshold transcript path of generateSwitchContext (which
 * stays raw and makes no LLM call). The summarizer path is LLM-wrapped and out of
 * scope here.
 */
import { describe, it, expect } from 'vitest';
import { detectRuntimeSwitch, wrapSwitchContext, generateSwitchContext } from '../runtime-switch.js';
import type { LLMModelConfig } from '../model-catalog.js';

const modelConfig = {
  provider: 'anthropic',
  modelName: 'claude-sonnet-4',
  apiKey: 'k',
} as LLMModelConfig;

const assistant = (text: string, runtimeId?: string) => ({
  role: 'assistant',
  content: text,
  ...(runtimeId ? { messageMeta: { runtimeId } } : {}),
});
const user = (text: string) => ({ role: 'user', content: text });

describe('detectRuntimeSwitch', () => {
  it('returns the prior runtime id when the last tagged assistant msg differs', () => {
    const msgs = [user('hi'), assistant('hello', 'claude-agent-sdk'), user('again')];
    expect(detectRuntimeSwitch(msgs, 'codex-sdk')).toBe('claude-agent-sdk');
  });

  it('returns null when the last tagged assistant msg is the same runtime', () => {
    const msgs = [user('hi'), assistant('hello', 'codex-sdk'), user('again')];
    expect(detectRuntimeSwitch(msgs, 'codex-sdk')).toBeNull();
  });

  it('uses the MOST RECENT tagged assistant message (walks backwards)', () => {
    const msgs = [
      assistant('a', 'mastra'),
      assistant('b', 'claude-agent-sdk'), // most recent tagged → this one wins
      user('q'),
    ];
    expect(detectRuntimeSwitch(msgs, 'codex-sdk')).toBe('claude-agent-sdk');
  });

  it('returns null when no assistant message carries a runtimeId', () => {
    const msgs = [user('hi'), assistant('hello'), user('again')];
    expect(detectRuntimeSwitch(msgs, 'codex-sdk')).toBeNull();
  });

  it('ignores user messages and empty history', () => {
    expect(detectRuntimeSwitch([user('a'), user('b')], 'codex-sdk')).toBeNull();
    expect(detectRuntimeSwitch([], 'codex-sdk')).toBeNull();
  });

  it('skips an untagged assistant message to find an earlier tagged one', () => {
    const msgs = [assistant('old', 'mastra'), assistant('new-untagged')];
    // The most recent assistant has no runtimeId → keep walking → finds mastra.
    expect(detectRuntimeSwitch(msgs, 'codex-sdk')).toBe('mastra');
  });
});

describe('wrapSwitchContext', () => {
  it('resolves a known runtime id to its label and wraps in XML tags', () => {
    const out = wrapSwitchContext('BODY', 'claude-agent-sdk');
    expect(out).toContain('<prior-conversation-context>');
    expect(out).toContain('</prior-conversation-context>');
    expect(out).toContain('Claude Agent SDK'); // label, not the raw id
    expect(out).toContain('BODY');
  });

  it('falls back to the raw id for an unknown runtime', () => {
    const out = wrapSwitchContext('X', 'some-future-runtime');
    expect(out).toContain('some-future-runtime');
  });
});

describe('generateSwitchContext (under-threshold, no LLM)', () => {
  it('builds a transcript excluding the last user message (the new prompt)', async () => {
    const msgs = [user('first question'), assistant('first answer', 'mastra'), user('THE NEW PROMPT')];
    const ctx = await generateSwitchContext(msgs, modelConfig);
    expect(ctx).toBe('User: first question\n\nAssistant: first answer');
    expect(ctx).not.toContain('THE NEW PROMPT'); // last user msg excluded
  });

  it('extracts text from content-array parts', async () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'array question' },
          { type: 'image', image: 'x' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'array answer' }] },
      user('new prompt'),
    ];
    const ctx = await generateSwitchContext(msgs, modelConfig);
    expect(ctx).toBe('User: array question\n\nAssistant: array answer');
  });

  it('skips non-user/assistant roles and empty content', async () => {
    const msgs = [
      { role: 'system', content: 'sys' },
      user('  '), // whitespace-only → dropped
      assistant('real answer', 'mastra'),
      user('new prompt'),
    ];
    const ctx = await generateSwitchContext(msgs, modelConfig);
    expect(ctx).toBe('Assistant: real answer');
  });

  it('returns null when there is no usable history', async () => {
    // Only the new prompt (last user message) → nothing to transcribe.
    expect(await generateSwitchContext([user('only the new prompt')], modelConfig)).toBeNull();
    expect(await generateSwitchContext([], modelConfig)).toBeNull();
  });

  it('honors a pre-aborted signal before processing a short transcript', async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    expect(
      await generateSwitchContext([user('old'), assistant('answer', 'mastra'), user('new')], modelConfig, {
        abortSignal: ctrl.signal,
      }),
    ).toBeNull();
  });

  it('returns null immediately when the abort signal is already aborted (over threshold)', async () => {
    // A large transcript pushes over the summarize threshold; a pre-aborted
    // signal must short-circuit to null without calling the summarizer.
    const big = 'x'.repeat(50_000);
    const msgs = [user('q'), assistant(big, 'mastra'), user('new')];
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await generateSwitchContext(msgs, modelConfig, { abortSignal: ctrl.signal })).toBeNull();
  });
});
