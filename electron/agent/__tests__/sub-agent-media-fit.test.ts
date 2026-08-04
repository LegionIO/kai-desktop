import { describe, it, expect, vi } from 'vitest';

import { estimateSubAgentStaticTokens, createSubAgentMediaFitter } from '../sub-agent-media-fit';
import type { MediaFitConfig } from '../media-fit';

const MEDIA_CONFIG: MediaFitConfig = {
  enabled: true,
  strategy: 'downscale',
  minDimension: 256,
  minQuality: 40,
  reserveTokens: 4000,
};

describe('estimateSubAgentStaticTokens', () => {
  it('with a known model, returns an EXACT token estimate (o200k) + allowance (not bytes*4)', () => {
    const prompt = 'x'.repeat(3000); // ~750 o200k tokens ('x' repeats compress well)
    const tokens = estimateSubAgentStaticTokens(prompt, [], () => ({}), 3000, 'gpt-4o');
    // exact prompt tokens (well under 3000) + 3000 allowance — far below the old
    // bytes*4 bug (~12000+) that would exhaust a small window.
    expect(tokens).toBeGreaterThan(3000);
    expect(tokens).toBeLessThan(5000);
  });

  it('without a model, uses the UTF-8 byte CEILING (true upper bound) + allowance', () => {
    const prompt = 'x'.repeat(3000);
    const tokens = estimateSubAgentStaticTokens(prompt, [], () => ({}), 3000);
    // byte ceiling: ~3000 (prompt) + newline + "[]" + 3000 allowance.
    expect(tokens).toBeGreaterThanOrEqual(6000);
    expect(tokens).toBeLessThan(6100);
  });

  it('uses the byte CEILING for a fallback-encoding model (Claude) — never the o200k undercount', () => {
    const prompt = 'x'.repeat(3000);
    const claude = estimateSubAgentStaticTokens(prompt, [], () => ({}), 0, 'claude-3-5-sonnet');
    const gpt = estimateSubAgentStaticTokens(prompt, [], () => ({}), 0, 'gpt-4o');
    // Claude has no canonical encoder here → byte ceiling (≈ 3000+), strictly higher
    // than the o200k exact count for gpt-4o (which compresses the repeated char).
    expect(claude).toBeGreaterThan(gpt);
    expect(claude).toBeGreaterThanOrEqual(3000);
  });

  it('the allowance is added in token units (no ×4 inflation)', () => {
    const withAllowance = estimateSubAgentStaticTokens('', [], () => ({}), 3000, 'gpt-4o');
    const withoutAllowance = estimateSubAgentStaticTokens('', [], () => ({}), 0, 'gpt-4o');
    expect(withAllowance - withoutAllowance).toBe(3000);
  });

  it('serializes tool schemas via the injected converter', () => {
    const converter = vi.fn(() => ({ type: 'object', properties: { q: { type: 'string' } } }));
    const tokens = estimateSubAgentStaticTokens('', [{ name: 't', inputSchema: {} }], converter, 0, 'gpt-4o');
    expect(converter).toHaveBeenCalledOnce();
    expect(tokens).toBeGreaterThan(0);
  });
});

describe('createSubAgentMediaFitter', () => {
  it('is a pass-through when media fitting is disabled', async () => {
    const { fit } = createSubAgentMediaFitter({
      mediaConfig: { ...MEDIA_CONFIG, enabled: false },
      eligibleModels: [{ modelConfig: { modelName: 'gpt-4o', maxInputTokens: 128000 } as never }],
      windowOverride: undefined,
      staticInputTokens: 0,
      messages: [],
    });
    const result = { _modelContent: [{ type: 'image', data: 'AAAA', mediaType: 'image/png' }] };
    expect(await fit(result)).toBe(result);
  });

  it('leaves a non-media result unchanged', async () => {
    const { fit } = createSubAgentMediaFitter({
      mediaConfig: MEDIA_CONFIG,
      eligibleModels: [{ modelConfig: { modelName: 'gpt-4o', maxInputTokens: 128000 } as never }],
      windowOverride: undefined,
      staticInputTokens: 0,
      messages: [],
    });
    const result = { text: 'hello' };
    expect(await fit(result)).toBe(result);
  });

  // The following tests observe the BUDGET via `_modelContent` TEXT parts (kept
  // whole when they fit, truncated when they don't) — a reliable signal, unlike
  // fake image payloads which now always fail-closed (drop) since they can't be
  // measured without a real decode.
  const textPart = (n: number) => ({ _modelContent: [{ type: 'text', text: 'y'.repeat(n) }] });
  const keptTextLen = (r: unknown): number => {
    const parts = (r as { _modelContent?: Array<{ type: string; text?: string }> })._modelContent ?? [];
    return parts.filter((p) => p.type === 'text').reduce((s, p) => s + (p.text?.length ?? 0), 0);
  };

  it('reset(fallbackModelName) recomputes the static estimate under the fallback tokenizer', async () => {
    // Primary gpt-4o (small static via exact encode) vs Claude fallback (byte ceiling
    // ≈ 4000). A text block that fits under the primary's larger remaining budget
    // gets TRUNCATED under Claude's smaller one after reset.
    const computeStatic = (mn: string): number =>
      estimateSubAgentStaticTokens('x'.repeat(4000), [], () => ({}), 0, mn);
    const fitter = createSubAgentMediaFitter({
      mediaConfig: { ...MEDIA_CONFIG, reserveTokens: 0 },
      eligibleModels: [{ modelConfig: { modelName: 'gpt-4o', maxInputTokens: 5000 } as never }],
      windowOverride: 5000,
      staticInputTokens: computeStatic('gpt-4o'),
      computeStaticInputTokens: computeStatic,
      messages: [],
    });
    const before = await fitter.fit(textPart(3000), 't1', {});
    // Fallback to Claude: static jumps to byte ceiling AND the fit window narrows to
    // the fallback model (same 5000 here) → less budget → shorter truncation.
    fitter.reset({ modelConfig: { modelName: 'claude-3-5-sonnet', maxInputTokens: 5000 } as never });
    const after = await fitter.fit(textPart(3000), 't2', {});
    // Less budget after the fallback → the same text is truncated shorter.
    expect(keptTextLen(after)).toBeLessThan(keptTextLen(before));
  });

  it('reset() clears same-turn committed charges (a fallback re-frees the budget)', async () => {
    const fitter = createSubAgentMediaFitter({
      mediaConfig: { ...MEDIA_CONFIG, reserveTokens: 0 },
      eligibleModels: [{ modelConfig: { modelName: 'gpt-4o', maxInputTokens: 4000 } as never }],
      windowOverride: 4000,
      staticInputTokens: 0,
      messages: [],
    });
    // Eat the budget with a big arg on the first attempt.
    fitter.chargeArgs('t1', { blob: 'x'.repeat(9000) });
    const before = await fitter.fit(textPart(2000), 't2', {});
    fitter.reset(); // fallback re-frees the budget
    const after = await fitter.fit(textPart(2000), 't3', {});
    expect(keptTextLen(after)).toBeGreaterThan(keptTextLen(before));
  });

  it('rechargeArgs charges the DELTA when a PreToolUse hook enlarges args (later text truncated shorter)', async () => {
    const mk = () =>
      createSubAgentMediaFitter({
        mediaConfig: { ...MEDIA_CONFIG, reserveTokens: 0 },
        eligibleModels: [{ modelConfig: { modelName: 'gpt-4o', maxInputTokens: 4000 } as never }],
        windowOverride: 4000,
        staticInputTokens: 0,
        messages: [],
      });
    // Baseline: only the small original args charged.
    const base = mk();
    base.chargeArgs('t1', { q: 'x' });
    const withSmall = await base.fit(textPart(3000), 't2', {});
    // Same small charge, then a PreToolUse rewrite ENLARGES the args → recharge delta.
    const grown = mk();
    grown.chargeArgs('t1', { q: 'x' });
    grown.rechargeArgs('t1', { q: 'x'.repeat(3000) });
    const withGrown = await grown.fit(textPart(3000), 't2', {});
    // The enlarged args consume more budget → the following text is truncated shorter.
    expect(keptTextLen(withGrown)).toBeLessThan(keptTextLen(withSmall));
  });

  it('rechargeArgs never REDUCES the charge when a hook shrinks args (no under-reserve)', async () => {
    const mk = () =>
      createSubAgentMediaFitter({
        mediaConfig: { ...MEDIA_CONFIG, reserveTokens: 0 },
        eligibleModels: [{ modelConfig: { modelName: 'gpt-4o', maxInputTokens: 4000 } as never }],
        windowOverride: 4000,
        staticInputTokens: 0,
        messages: [],
      });
    const shrunk = mk();
    shrunk.chargeArgs('t1', { q: 'x'.repeat(3000) });
    shrunk.rechargeArgs('t1', { q: 'x' }); // hook shrank args — must NOT free budget
    const afterShrink = await shrunk.fit(textPart(3000), 't2', {});
    const stillBig = mk();
    stillBig.chargeArgs('t1', { q: 'x'.repeat(3000) });
    const noRecharge = await stillBig.fit(textPart(3000), 't2', {});
    expect(keptTextLen(afterShrink)).toBe(keptTextLen(noRecharge));
  });

  it('charges a tool-call argument against the budget (later text is truncated shorter)', async () => {
    const { fit, chargeArgs } = createSubAgentMediaFitter({
      mediaConfig: { ...MEDIA_CONFIG, reserveTokens: 0 },
      eligibleModels: [{ modelConfig: { modelName: 'gpt-4o', maxInputTokens: 4000 } as never }],
      windowOverride: 4000,
      staticInputTokens: 0,
      messages: [],
    });
    const noArg = await fit(textPart(3000), 't0', {});
    const { fit: fit2, chargeArgs: charge2 } = createSubAgentMediaFitter({
      mediaConfig: { ...MEDIA_CONFIG, reserveTokens: 0 },
      eligibleModels: [{ modelConfig: { modelName: 'gpt-4o', maxInputTokens: 4000 } as never }],
      windowOverride: 4000,
      staticInputTokens: 0,
      messages: [],
    });
    charge2('t1', { blob: 'x'.repeat(9000) });
    const withArg = await fit2(textPart(3000), 't2', {});
    void chargeArgs;
    expect(keptTextLen(withArg)).toBeLessThan(keptTextLen(noArg));
  });

  it('counts a historical branch _modelContent image as NATIVE tokens, not base64 text', async () => {
    // A branch carrying a prior tool result whose `_modelContent` holds base64 image
    // bytes. Counted as TEXT the base64 chars inflate ~4× (byte ceiling) and blow the
    // window; the media-stripped projection counts it as the (smaller) native/byte-
    // estimate instead. Use a size where the difference is decisive: ~300k base64 chars
    // ≈ 225 KiB decoded. As TEXT that's a ~300k-char string → ~300k+ token ceiling (over
    // a 260k window); as media it's the image byte estimate (~decoded/2 ≈ 112k) → fits.
    const bigBase64 = 'A'.repeat(300_000);
    const branchWithHistoricalImage = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'prev',
            toolName: 'screenshot',
            args: {},
            result: { _modelContent: [{ type: 'image', data: bigBase64, mediaType: 'image/png' }] },
          },
        ],
      },
    ];
    const strippedFitter = createSubAgentMediaFitter({
      mediaConfig: { ...MEDIA_CONFIG, reserveTokens: 0 },
      eligibleModels: [{ modelConfig: { modelName: 'gpt-4o', maxInputTokens: 260_000 } as never }],
      windowOverride: 260_000,
      staticInputTokens: 0,
      messages: branchWithHistoricalImage as never,
    });
    const res = await strippedFitter.fit(textPart(3000), 't2', {});
    // Media stripped → the 3000-char text result fits whole. If base64 were counted as
    // text (~300k+ tokens > 260k window) the result would be dropped/truncated.
    expect(keptTextLen(res)).toBe(3000);
  });
});
