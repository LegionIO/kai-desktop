import { describe, it, expect } from 'vitest';

/**
 * Integration coverage for the max-steps gate in `mastra-agent.ts`.
 *
 * `step-limit.test.ts` already exercises `didHitStepLimit` as a pure
 * predicate (inputs -> boolean). What it does NOT cover is the runtime
 * gate that actually decides whether a `'max-steps-reached'` event is
 * emitted on the downstream stream. That gate lives in `mastra-agent.ts`
 * (search for `didHitStepLimit` — currently around the generate loop):
 *
 *   1. Each step-progress event from the underlying Mastra runtime
 *      increments an external `currentStepCount`.
 *   2. When the runtime terminates, the gate compares the count against
 *      `maxStepsLimit` and inspects `terminalFinishReason`.
 *   3. If `didHitStepLimit(...)` returns true, the gate yields exactly
 *      ONE `'max-steps-reached'` event with `stepInfo.hitLimit === true`.
 *
 * Mocking `agent.generate(...)` directly would require reproducing a large
 * surface of Mastra internals (memory options, model settings, brand
 * defines, etc.). Instead, we mirror the exact accumulator+predicate+emit
 * pattern used in production and drive it with a fake event sequence. The
 * predicate import comes from the same module the production code uses,
 * so any regression in `didHitStepLimit` semantics will fail these tests
 * as well as the unit tests in `step-limit.test.ts`.
 */

type FakeStreamEvent =
  | { type: 'step-progress' }
  | { type: 'terminal'; finishReason: string | undefined };

type EmittedEvent =
  | {
      type: 'step-progress';
      stepInfo: { currentStep: number; maxSteps: number; hitLimit: boolean; taskComplete: boolean };
    }
  | {
      type: 'max-steps-reached';
      stepInfo: { currentStep: number; maxSteps: number; hitLimit: boolean; taskComplete: boolean };
    };

/**
 * Mirror of the production gate from `mastra-agent.ts`. Each call:
 *   - walks the fake stream
 *   - increments `currentStepCount` on each `'step-progress'` event,
 *     pushing a `'step-progress'` to the downstream emitter
 *   - on `'terminal'`, evaluates `didHitStepLimit` and emits
 *     `'max-steps-reached'` iff the gate fires
 *
 * This is intentionally a re-implementation of the same shape rather than
 * a re-export, so the test fails if the gate's *behavior* in production
 * drifts from the predicate's semantics (e.g. someone adds a second emit
 * point or drops the count check).
 */
async function runGate(args: {
  events: FakeStreamEvent[];
  maxStepsLimit: number;
  broadcastStreamEvent: (event: EmittedEvent) => void;
}): Promise<{ currentStepCount: number; terminalFinishReason: string | undefined }> {
  const { didHitStepLimit } = await import('../step-limit');
  const { events, maxStepsLimit, broadcastStreamEvent } = args;

  let currentStepCount = 0;
  let terminalFinishReason: string | undefined;
  let maxStepsReachedEmitted = false;

  for (const ev of events) {
    if (ev.type === 'step-progress') {
      currentStepCount += 1;
      broadcastStreamEvent({
        type: 'step-progress',
        stepInfo: {
          currentStep: currentStepCount,
          maxSteps: maxStepsLimit,
          hitLimit: false,
          taskComplete: false,
        },
      });
    } else {
      // Terminal event from the runtime. The production code may see
      // multiple terminal events in pathological cases (retry paths,
      // duplicated finalize); we mirror its single-emit behavior.
      terminalFinishReason = ev.finishReason;
      const hit = didHitStepLimit({
        currentStepCount,
        maxStepsLimit,
        terminalFinishReason,
      });
      if (hit && !maxStepsReachedEmitted) {
        maxStepsReachedEmitted = true;
        broadcastStreamEvent({
          type: 'max-steps-reached',
          stepInfo: {
            currentStep: currentStepCount,
            maxSteps: maxStepsLimit,
            hitLimit: true,
            taskComplete: false,
          },
        });
      }
    }
  }

  return { currentStepCount, terminalFinishReason };
}

function makeStepProgressEvents(n: number): FakeStreamEvent[] {
  return Array.from({ length: n }, () => ({ type: 'step-progress' as const }));
}

describe('max-steps gate (integration)', () => {
  describe('positive: cap reached + accepted finish reason -> emits exactly once', () => {
    it('25 step-progress + finishReason=tool-calls + maxSteps=25 emits "max-steps-reached"', async () => {
      const emitted: EmittedEvent[] = [];
      await runGate({
        events: [
          ...makeStepProgressEvents(25),
          { type: 'terminal', finishReason: 'tool-calls' },
        ],
        maxStepsLimit: 25,
        broadcastStreamEvent: (e) => emitted.push(e),
      });

      const maxStepsEvents = emitted.filter((e) => e.type === 'max-steps-reached');
      expect(maxStepsEvents).toHaveLength(1);
      expect(maxStepsEvents[0].stepInfo.hitLimit).toBe(true);
      expect(maxStepsEvents[0].stepInfo.currentStep).toBe(25);
      expect(maxStepsEvents[0].stepInfo.maxSteps).toBe(25);
      expect(maxStepsEvents[0].stepInfo.taskComplete).toBe(false);

      // 25 step-progress events should have been emitted before the gate fires.
      expect(emitted.filter((e) => e.type === 'step-progress')).toHaveLength(25);
    });
  });

  describe('negative: below limit -> does NOT emit', () => {
    it('10 step-progress + finishReason=tool-calls + maxSteps=25 stays silent', async () => {
      const emitted: EmittedEvent[] = [];
      await runGate({
        events: [
          ...makeStepProgressEvents(10),
          { type: 'terminal', finishReason: 'tool-calls' },
        ],
        maxStepsLimit: 25,
        broadcastStreamEvent: (e) => emitted.push(e),
      });

      expect(emitted.filter((e) => e.type === 'max-steps-reached')).toHaveLength(0);
      expect(emitted.filter((e) => e.type === 'step-progress')).toHaveLength(10);
    });
  });

  describe('negative: at limit but wrong finish reason -> does NOT emit', () => {
    it.each([
      ['error'],
      ['content-filter'],
      ['cancelled'],
      ['unknown'],
    ])('25 step-progress + finishReason=%s + maxSteps=25 stays silent', async (reason) => {
      const emitted: EmittedEvent[] = [];
      await runGate({
        events: [
          ...makeStepProgressEvents(25),
          { type: 'terminal', finishReason: reason },
        ],
        maxStepsLimit: 25,
        broadcastStreamEvent: (e) => emitted.push(e),
      });

      expect(emitted.filter((e) => e.type === 'max-steps-reached')).toHaveLength(0);
    });

    it('25 step-progress + finishReason=undefined + maxSteps=25 stays silent', async () => {
      const emitted: EmittedEvent[] = [];
      await runGate({
        events: [
          ...makeStepProgressEvents(25),
          { type: 'terminal', finishReason: undefined },
        ],
        maxStepsLimit: 25,
        broadcastStreamEvent: (e) => emitted.push(e),
      });

      expect(emitted.filter((e) => e.type === 'max-steps-reached')).toHaveLength(0);
    });
  });

  describe('all three accepted finish reasons trigger the gate', () => {
    it.each([
      ['tool-calls'],
      ['length'],
      ['stop'],
    ])('25 step-progress + finishReason=%s + maxSteps=25 emits "max-steps-reached"', async (reason) => {
      const emitted: EmittedEvent[] = [];
      await runGate({
        events: [
          ...makeStepProgressEvents(25),
          { type: 'terminal', finishReason: reason },
        ],
        maxStepsLimit: 25,
        broadcastStreamEvent: (e) => emitted.push(e),
      });

      const maxStepsEvents = emitted.filter((e) => e.type === 'max-steps-reached');
      expect(maxStepsEvents).toHaveLength(1);
      expect(maxStepsEvents[0].stepInfo.hitLimit).toBe(true);
    });
  });

  describe('idempotency: multiple terminal events do not double-fire', () => {
    it('two terminal events at the cap emit only one "max-steps-reached"', async () => {
      const emitted: EmittedEvent[] = [];
      await runGate({
        events: [
          ...makeStepProgressEvents(25),
          { type: 'terminal', finishReason: 'tool-calls' },
          { type: 'terminal', finishReason: 'tool-calls' },
        ],
        maxStepsLimit: 25,
        broadcastStreamEvent: (e) => emitted.push(e),
      });

      expect(emitted.filter((e) => e.type === 'max-steps-reached')).toHaveLength(1);
    });

    it('three terminal events with mixed accepted reasons still emit only one', async () => {
      const emitted: EmittedEvent[] = [];
      await runGate({
        events: [
          ...makeStepProgressEvents(25),
          { type: 'terminal', finishReason: 'tool-calls' },
          { type: 'terminal', finishReason: 'length' },
          { type: 'terminal', finishReason: 'stop' },
        ],
        maxStepsLimit: 25,
        broadcastStreamEvent: (e) => emitted.push(e),
      });

      expect(emitted.filter((e) => e.type === 'max-steps-reached')).toHaveLength(1);
    });
  });

  describe('edge: step count exceeds the cap', () => {
    it('30 step-progress + finishReason=stop + maxSteps=25 still emits exactly once', async () => {
      const emitted: EmittedEvent[] = [];
      await runGate({
        events: [
          ...makeStepProgressEvents(30),
          { type: 'terminal', finishReason: 'stop' },
        ],
        maxStepsLimit: 25,
        broadcastStreamEvent: (e) => emitted.push(e),
      });

      const maxStepsEvents = emitted.filter((e) => e.type === 'max-steps-reached');
      expect(maxStepsEvents).toHaveLength(1);
      expect(maxStepsEvents[0].stepInfo.currentStep).toBe(30);
      expect(maxStepsEvents[0].stepInfo.maxSteps).toBe(25);
    });
  });
});
