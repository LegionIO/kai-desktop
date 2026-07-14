/**
 * Tests for analyzeCompletion (electron/agent/task-completion.ts) — the pure
 * decision function the autopilot uses to map an agent's terminal exit code to
 * the next task status. Exit-code-driven (NOT model-asserted): success requires
 * a clean exit and routes through the review pipeline. These tests lock the
 * decision table so a regression in the routing can't silently ship.
 */
import { describe, it, expect } from 'vitest';
import { analyzeCompletion, type CompletionAnalysisConfig } from '../task-completion.js';
import type { AgentFile } from '../../../shared/agent-types.js';
import type { TaskFile } from '../../../shared/task-types.js';

// analyzeCompletion ignores the agent/task args (prefixed _), so minimal stubs suffice.
const agent = {} as AgentFile;
const task = {} as TaskFile;
const cfg = (over: Partial<CompletionAnalysisConfig> = {}): CompletionAnalysisConfig => ({
  requireHumanReview: false,
  ...over,
});

describe('analyzeCompletion', () => {
  describe('timeout (exit 124)', () => {
    it('retries (→ in_progress + shouldRetry) while retryCount < 2', () => {
      for (const retryCount of [0, 1]) {
        const r = analyzeCompletion(124, agent, task, cfg({ retryCount }));
        expect(r.nextStatus).toBe('in_progress');
        expect(r.wasTimeout).toBe(true);
        expect(r.shouldRetry).toBe(true);
      }
    });

    it('blocks once retryCount reaches 2', () => {
      const r = analyzeCompletion(124, agent, task, cfg({ retryCount: 2 }));
      expect(r.nextStatus).toBe('blocked');
      expect(r.wasTimeout).toBe(true);
      expect(r.shouldRetry).toBeUndefined();
      expect(r.blockedReason).toMatch(/timeout/i);
    });

    it('treats a missing retryCount as 0 (retries)', () => {
      const r = analyzeCompletion(124, agent, task, cfg());
      expect(r.nextStatus).toBe('in_progress');
      expect(r.shouldRetry).toBe(true);
    });
  });

  describe('crash (exit > 1 or < 0)', () => {
    it('blocks with wasCrash for exit codes above 1', () => {
      for (const code of [2, 3, 127, 137]) {
        const r = analyzeCompletion(code, agent, task, cfg());
        expect(r.nextStatus).toBe('blocked');
        expect(r.wasCrash).toBe(true);
        expect(r.blockedReason).toMatch(new RegExp(String(code)));
      }
    });

    it('blocks with wasCrash for negative exit codes (signal death)', () => {
      const r = analyzeCompletion(-1, agent, task, cfg());
      expect(r.nextStatus).toBe('blocked');
      expect(r.wasCrash).toBe(true);
    });

    it('does NOT treat 124 as a crash even though 124 > 1 (timeout takes priority)', () => {
      const r = analyzeCompletion(124, agent, task, cfg({ retryCount: 5 }));
      expect(r.wasCrash).toBeUndefined();
      expect(r.wasTimeout).toBe(true);
    });
  });

  describe('success (exit 0)', () => {
    it('routes to ai_review when reviewers are assigned (takes priority over human review)', () => {
      const r = analyzeCompletion(0, agent, task, cfg({ reviewerAgentIds: ['rev-1'], requireHumanReview: true }));
      expect(r.nextStatus).toBe('ai_review');
    });

    it('routes to human_review when requireHumanReview and no reviewers', () => {
      const r = analyzeCompletion(0, agent, task, cfg({ requireHumanReview: true }));
      expect(r.nextStatus).toBe('human_review');
    });

    it('routes to done when no reviewers and no human review required', () => {
      const r = analyzeCompletion(0, agent, task, cfg());
      expect(r.nextStatus).toBe('done');
    });

    it('treats an empty reviewer array as no reviewers', () => {
      const r = analyzeCompletion(0, agent, task, cfg({ reviewerAgentIds: [] }));
      expect(r.nextStatus).toBe('done');
    });
  });

  describe('soft failure (exit 1)', () => {
    it('routes to ai_review for retry/analysis', () => {
      const r = analyzeCompletion(1, agent, task, cfg());
      expect(r.nextStatus).toBe('ai_review');
    });
  });

  describe('unknown / non-numeric exit (killed session, missing code)', () => {
    it('blocks a NaN exit code instead of treating it as a soft failure', () => {
      const r = analyzeCompletion(Number.NaN, agent, task, cfg());
      expect(r.nextStatus).toBe('blocked');
      expect(r.wasCrash).toBe(true);
    });

    it('blocks a non-finite (Infinity) exit code', () => {
      expect(analyzeCompletion(Number.POSITIVE_INFINITY, agent, task, cfg()).nextStatus).toBe('blocked');
    });

    it('a killed session (NaN) with reviewers still blocks — does not enter ai_review', () => {
      const r = analyzeCompletion(Number.NaN, agent, task, cfg({ reviewerAgentIds: ['rev-1'] }));
      expect(r.nextStatus).toBe('blocked');
    });
  });
});
