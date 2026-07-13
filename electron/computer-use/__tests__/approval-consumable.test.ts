/**
 * Tests for isApprovalDecisionConsumable — the atomicity guard shared by
 * SessionManager.approveAction and rejectAction. A computer-use approval
 * decision may only be consumed while its approval is still {status:'pending'}
 * AND its action is still {status:'awaiting-approval'}. This stops a stale or
 * duplicate approve/reject (arriving after the action already ran, was rejected,
 * stopped, or finalized) from resurrecting/pausing the session and corrupting
 * the action history that later feeds model prompts.
 */
import { describe, it, expect, vi } from 'vitest';

// session-manager.ts imports electron + window/orchestrator modules at load.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/kai', getName: () => 'Kai' },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {},
  screen: {},
}));

import { isApprovalDecisionConsumable } from '../session-manager.js';

type ApprovalStatus = 'pending' | 'approved' | 'rejected';
type ActionStatus = 'awaiting-approval' | 'approved' | 'rejected' | 'completed' | 'failed' | 'running';

const session = (approvalStatus: ApprovalStatus | null, actionStatus: ActionStatus | null, id = 'act-1') =>
  ({
    approvals: approvalStatus ? [{ actionId: id, status: approvalStatus }] : [],
    actions: actionStatus ? [{ id, status: actionStatus }] : [],
  }) as unknown as Parameters<typeof isApprovalDecisionConsumable>[0];

describe('isApprovalDecisionConsumable', () => {
  it('is true only when approval is pending AND action is awaiting-approval', () => {
    expect(isApprovalDecisionConsumable(session('pending', 'awaiting-approval'), 'act-1')).toBe(true);
  });

  it('is false when the approval already resolved (approved/rejected)', () => {
    expect(isApprovalDecisionConsumable(session('approved', 'awaiting-approval'), 'act-1')).toBe(false);
    expect(isApprovalDecisionConsumable(session('rejected', 'awaiting-approval'), 'act-1')).toBe(false);
  });

  it('is false when the action already left awaiting-approval', () => {
    // The dangerous stale-reject/approve cases: action is mid-execution or done.
    for (const s of ['approved', 'running', 'completed', 'failed', 'rejected'] as ActionStatus[]) {
      expect(isApprovalDecisionConsumable(session('pending', s), 'act-1'), s).toBe(false);
    }
  });

  it('is false when there is no matching approval or action', () => {
    expect(isApprovalDecisionConsumable(session(null, 'awaiting-approval'), 'act-1')).toBe(false);
    expect(isApprovalDecisionConsumable(session('pending', null), 'act-1')).toBe(false);
    expect(isApprovalDecisionConsumable(session(null, null), 'act-1')).toBe(false);
  });

  it('is false when the id does not match the pending approval/action', () => {
    expect(isApprovalDecisionConsumable(session('pending', 'awaiting-approval', 'act-1'), 'act-OTHER')).toBe(false);
  });

  it('matches by actionId across multiple approvals/actions', () => {
    const s = {
      approvals: [
        { actionId: 'a', status: 'approved' },
        { actionId: 'b', status: 'pending' },
      ],
      actions: [
        { id: 'a', status: 'completed' },
        { id: 'b', status: 'awaiting-approval' },
      ],
    } as unknown as Parameters<typeof isApprovalDecisionConsumable>[0];
    expect(isApprovalDecisionConsumable(s, 'b')).toBe(true); // b is still consumable
    expect(isApprovalDecisionConsumable(s, 'a')).toBe(false); // a already decided+completed
  });
});
