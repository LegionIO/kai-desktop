import { describe, it, expect } from 'vitest';
import { didHitStepLimit } from '../step-limit';

/**
 * The AI SDK / Mastra runtime does not surface a dedicated `'max-steps'`
 * finishReason; once the configured maxSteps is reached the stream simply
 * terminates with the *last step's* finishReason. The gate that decides
 * whether to emit a `'max-steps-reached'` event therefore has to compare an
 * externally-tracked step count against the configured cap and gate on the
 * set of plausible terminal reasons. These tests exercise that gate so a
 * regression to the old `terminalFinishReason === 'max-steps'` check would
 * fail loudly.
 */
describe('didHitStepLimit (max-steps gate)', () => {
  describe('fires when step count meets the cap and reason is plausible', () => {
    it.each([
      ['tool-calls'],
      ['length'],
      ['stop'],
    ])('returns true for terminalFinishReason=%s when steps == cap', (reason) => {
      expect(
        didHitStepLimit({
          currentStepCount: 5,
          maxStepsLimit: 5,
          terminalFinishReason: reason,
        }),
      ).toBe(true);
    });

    it('returns true when step count exceeds the cap', () => {
      expect(
        didHitStepLimit({
          currentStepCount: 7,
          maxStepsLimit: 5,
          terminalFinishReason: 'tool-calls',
        }),
      ).toBe(true);
    });
  });

  describe('does not fire below the cap', () => {
    it.each([
      ['tool-calls'],
      ['length'],
      ['stop'],
    ])('returns false for %s when steps < cap', (reason) => {
      expect(
        didHitStepLimit({
          currentStepCount: 4,
          maxStepsLimit: 5,
          terminalFinishReason: reason,
        }),
      ).toBe(false);
    });

    it('returns false on a fresh run (zero steps)', () => {
      expect(
        didHitStepLimit({
          currentStepCount: 0,
          maxStepsLimit: 5,
          terminalFinishReason: 'stop',
        }),
      ).toBe(false);
    });
  });

  describe('does not fire on terminal reasons that mean something else', () => {
    it.each([
      ['error'],
      ['content-filter'],
      ['cancelled'],
      ['unknown'],
      [undefined],
    ])('returns false even at the cap when reason is %s', (reason) => {
      expect(
        didHitStepLimit({
          currentStepCount: 5,
          maxStepsLimit: 5,
          terminalFinishReason: reason as string | undefined,
        }),
      ).toBe(false);
    });
  });

  describe('regression: legacy "max-steps" string does not falsely trigger', () => {
    it('returns false when finishReason is literally "max-steps" but step count is below cap', () => {
      // The AI SDK never actually emits this string, but if it ever did we
      // would still want to defer to the step counter rather than the string.
      expect(
        didHitStepLimit({
          currentStepCount: 2,
          maxStepsLimit: 5,
          terminalFinishReason: 'max-steps',
        }),
      ).toBe(false);
    });
  });

  describe('end-to-end shape: stream emits N step-progress events then terminates', () => {
    it('fires when an external counter ticks to maxStepsLimit before a tool-calls terminal', () => {
      // Simulate the stream loop: each step-progress event bumps the counter,
      // then the run terminates with finishReason='tool-calls'.
      const maxStepsLimit = 3;
      let currentStepCount = 0;
      const fakeStreamEvents = [
        { type: 'step-progress' },
        { type: 'step-progress' },
        { type: 'step-progress' },
      ];
      for (const ev of fakeStreamEvents) {
        if (ev.type === 'step-progress') currentStepCount += 1;
      }
      const terminalFinishReason = 'tool-calls';

      expect(
        didHitStepLimit({
          currentStepCount,
          maxStepsLimit,
          terminalFinishReason,
        }),
      ).toBe(true);
    });

    it('does not fire when only N-1 step-progress events arrive before terminating with stop', () => {
      const maxStepsLimit = 3;
      let currentStepCount = 0;
      const fakeStreamEvents = [
        { type: 'step-progress' },
        { type: 'step-progress' },
      ];
      for (const ev of fakeStreamEvents) {
        if (ev.type === 'step-progress') currentStepCount += 1;
      }
      const terminalFinishReason = 'stop';

      expect(
        didHitStepLimit({
          currentStepCount,
          maxStepsLimit,
          terminalFinishReason,
        }),
      ).toBe(false);
    });
  });
});
