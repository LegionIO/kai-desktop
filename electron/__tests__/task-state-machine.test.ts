/**
 * Tests for the task state machine (shared/task-state-machine.ts).
 *
 * Covers the transition table's structural invariants (reachability, no
 * dead-ends), the three query helpers, and the permissive vs trigger-scoped
 * distinction that the main-process validator (electron/ipc/tasks.ts) relies on.
 */

import { describe, it, expect } from 'vitest';
import {
  TASK_TRANSITIONS,
  getValidManualTransitions,
  getAutoTransitions,
  isValidTransition,
} from '../../shared/task-state-machine';
import { taskUpdateSchema } from '../ipc/tasks';
import type { KaiTaskStatus } from '../../shared/task-types';

const ALL_STATUSES: KaiTaskStatus[] = ['todo', 'in_progress', 'blocked', 'ai_review', 'human_review', 'done'];

describe('isValidTransition', () => {
  it('allows the documented forward flow', () => {
    expect(isValidTransition('todo', 'in_progress')).toBe(true);
    expect(isValidTransition('in_progress', 'ai_review')).toBe(true);
    expect(isValidTransition('in_progress', 'human_review')).toBe(true);
    expect(isValidTransition('in_progress', 'done')).toBe(true);
    expect(isValidTransition('ai_review', 'done')).toBe(true);
    expect(isValidTransition('human_review', 'done')).toBe(true);
  });

  it('allows reopening a done task', () => {
    expect(isValidTransition('done', 'todo')).toBe(true);
    expect(isValidTransition('done', 'in_progress')).toBe(true);
  });

  it('allows blocking and unblocking', () => {
    expect(isValidTransition('in_progress', 'blocked')).toBe(true);
    expect(isValidTransition('todo', 'blocked')).toBe(true);
    expect(isValidTransition('blocked', 'in_progress')).toBe(true);
    expect(isValidTransition('blocked', 'todo')).toBe(true);
  });

  it('treats a self-transition as valid (no-op)', () => {
    for (const s of ALL_STATUSES) {
      expect(isValidTransition(s, s)).toBe(true);
    }
  });

  it('rejects transitions not in the table', () => {
    // blocked can only go to in_progress or todo — not straight to done/review.
    expect(isValidTransition('blocked', 'done')).toBe(false);
    expect(isValidTransition('blocked', 'ai_review')).toBe(false);
    expect(isValidTransition('blocked', 'human_review')).toBe(false);
    // ai_review/human_review cannot go to blocked.
    expect(isValidTransition('ai_review', 'blocked')).toBe(false);
    expect(isValidTransition('human_review', 'blocked')).toBe(false);
    // done cannot go directly to blocked.
    expect(isValidTransition('done', 'blocked')).toBe(false);
  });
});

describe('transition table structural invariants', () => {
  it('has no duplicate from→to rules', () => {
    const seen = new Set<string>();
    for (const rule of TASK_TRANSITIONS) {
      const key = `${rule.from}→${rule.to}`;
      expect(seen.has(key), `duplicate rule ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('has no self-loop rules (self-transitions are handled by isValidTransition, not the table)', () => {
    for (const rule of TASK_TRANSITIONS) {
      expect(rule.from).not.toBe(rule.to);
    }
  });

  it('every status is reachable from todo', () => {
    const reachable = new Set<KaiTaskStatus>(['todo']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const rule of TASK_TRANSITIONS) {
        if (reachable.has(rule.from) && !reachable.has(rule.to)) {
          reachable.add(rule.to);
          grew = true;
        }
      }
    }
    for (const s of ALL_STATUSES) {
      expect(reachable.has(s), `${s} unreachable from todo`).toBe(true);
    }
  });

  it('every status can still reach done (no dead-end states)', () => {
    // Reverse-reachability from done.
    const canReachDone = new Set<KaiTaskStatus>(['done']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const rule of TASK_TRANSITIONS) {
        if (canReachDone.has(rule.to) && !canReachDone.has(rule.from)) {
          canReachDone.add(rule.from);
          grew = true;
        }
      }
    }
    for (const s of ALL_STATUSES) {
      expect(canReachDone.has(s), `${s} cannot reach done`).toBe(true);
    }
  });
});

describe('getValidManualTransitions', () => {
  it('returns manual + both, never auto-only targets', () => {
    const manual = getValidManualTransitions('in_progress');
    expect(manual).toContain('todo'); // manual-only rule
    expect(manual).toContain('done'); // both
    expect(manual).toContain('blocked'); // both
  });

  it('a blocked task can be manually moved to in_progress or todo', () => {
    expect(getValidManualTransitions('blocked').sort()).toEqual(['in_progress', 'todo']);
  });
});

describe('getAutoTransitions', () => {
  it('returns auto + both targets for reconciliation', () => {
    const auto = getAutoTransitions('in_progress');
    // These are `both`, so reconciliation may drive them.
    expect(auto).toContain('ai_review');
    expect(auto).toContain('human_review');
    expect(auto).toContain('done');
    expect(auto).toContain('blocked');
    // Manual-only 'in_progress → todo' must NOT be auto-drivable.
    expect(auto).not.toContain('todo');
  });

  it('auto transitions are always a subset of what isValidTransition permits', () => {
    for (const from of ALL_STATUSES) {
      for (const to of getAutoTransitions(from)) {
        expect(isValidTransition(from, to)).toBe(true);
      }
    }
  });
});

describe('taskUpdateSchema (tasks:update payload validation, #100 MED)', () => {
  it('accepts a valid partial update', () => {
    const r = taskUpdateSchema.safeParse({ status: 'in_progress', priority: 5, title: 'work' });
    expect(r.success).toBe(true);
  });

  it('accepts an empty update (no fields)', () => {
    expect(taskUpdateSchema.safeParse({}).success).toBe(true);
  });

  it('rejects a forged run with a wrong-typed field', () => {
    const r = taskUpdateSchema.safeParse({
      runs: [
        {
          id: 'r1',
          number: 'not-a-number',
          type: 'execution',
          agentId: 'a',
          agentName: 'A',
          terminalSessionId: 't',
          startedAt: 'now',
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a reviewResults entry with an invalid status enum', () => {
    const r = taskUpdateSchema.safeParse({
      reviewResults: [{ agentId: 'a', agentName: 'A', status: 'hacked' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a non-integer lastExitCode', () => {
    expect(taskUpdateSchema.safeParse({ lastExitCode: 1.5 }).success).toBe(false);
  });

  it('rejects a title that exceeds the length cap', () => {
    expect(taskUpdateSchema.safeParse({ title: 'x'.repeat(100000) }).success).toBe(false);
  });

  it('rejects an out-of-range priority', () => {
    expect(taskUpdateSchema.safeParse({ priority: 9999 }).success).toBe(false);
  });

  it('passes through unknown fields for forward-compat', () => {
    const r = taskUpdateSchema.safeParse({ status: 'todo', someFutureField: 'ok' });
    expect(r.success).toBe(true);
    if (r.success) expect((r.data as Record<string, unknown>).someFutureField).toBe('ok');
  });

  it('accepts a valid runs + reviewResults + metadata payload', () => {
    const r = taskUpdateSchema.safeParse({
      runs: [
        {
          id: 'r1',
          number: 1,
          type: 'execution',
          agentId: 'a',
          agentName: 'A',
          terminalSessionId: 't',
          startedAt: '2026-07-11T00:00:00Z',
          exitCode: 0,
          outcome: 'approved',
        },
      ],
      reviewResults: [{ agentId: 'a', agentName: 'A', status: 'approved', feedback: 'lgtm' }],
      metadata: { category: 'feature', labels: ['x'] },
    });
    expect(r.success).toBe(true);
  });
});
