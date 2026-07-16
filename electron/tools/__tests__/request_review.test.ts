import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequestReviewTool } from '../request_review';
import { listAlerts, readAlert } from '../../ipc/alert-store';

let appHome: string;
beforeEach(() => {
  appHome = mkdtempSync(join(tmpdir(), 'kai-req-review-'));
  mkdirSync(join(appHome, 'data'), { recursive: true });
});
afterEach(() => rmSync(appHome, { recursive: true, force: true }));

const ctx = { toolCallId: 'tc-1', conversationId: 'conv-1' };

describe('request_review tool', () => {
  it('fyi creates an alert and does NOT suspend (run continues)', async () => {
    const tool = createRequestReviewTool(appHome);
    const res = (await tool.execute(
      { kind: 'fyi', title: 'Heads up', message: 'prod deploy skipped a step' },
      ctx,
    )) as Record<string, unknown>;
    expect(res.alerted).toBe(true);
    expect(res.suspend).toBe(false);
    const alerts = listAlerts(appHome);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('fyi');
    // Default (no awaitAck): FYI is auto-acknowledged — informational, not 'open'
    // (so it doesn't nag with a badge / sit in the open list).
    expect(readAlert(appHome, alerts[0].id)?.status).toBe('acknowledged');
    expect(readAlert(appHome, alerts[0].id)?.conversationId).toBe('conv-1');
  });

  it('fyi with awaitAck:true stays OPEN (needs the user to clear it)', async () => {
    const tool = createRequestReviewTool(appHome);
    const res = (await tool.execute(
      { kind: 'fyi', title: 'Heads up', message: 'please ack', awaitAck: true },
      ctx,
    )) as Record<string, unknown>;
    expect(res.suspend).toBe(false); // still non-blocking for the run
    expect(readAlert(appHome, res.alertId as string)?.status).toBe('open');
  });

  it('question creates a question alert and SUSPENDS', async () => {
    const tool = createRequestReviewTool(appHome);
    const res = (await tool.execute(
      {
        kind: 'question',
        title: 'Which env?',
        message: 'target ambiguous',
        questions: [{ question: 'Env?', header: 'Env', options: [{ label: 'staging' }, { label: 'prod' }] }],
      },
      ctx,
    )) as Record<string, unknown>;
    expect(res.suspend).toBe(true);
    const alert = readAlert(appHome, res.alertId as string);
    expect(alert?.kind).toBe('question');
    expect(alert?.questions?.[0].header).toBe('Env');
  });

  it('approval creates an approval alert and SUSPENDS', async () => {
    const tool = createRequestReviewTool(appHome);
    const res = (await tool.execute(
      { kind: 'approval', title: 'Deploy?', message: 'push to prod', approvalAction: 'deploy to prod' },
      ctx,
    )) as Record<string, unknown>;
    expect(res.suspend).toBe(true);
    expect(readAlert(appHome, res.alertId as string)?.approvalAction).toBe('deploy to prod');
  });

  it('errors when kind=question has no questions', async () => {
    const tool = createRequestReviewTool(appHome);
    const res = (await tool.execute({ kind: 'question', title: 't', message: 'm' }, ctx)) as Record<string, unknown>;
    expect(res.isError).toBe(true);
    expect(listAlerts(appHome)).toHaveLength(0);
  });

  it('errors without a conversation context', async () => {
    const tool = createRequestReviewTool(appHome);
    const res = (await tool.execute({ kind: 'fyi', title: 't', message: 'm' }, { toolCallId: 'x' })) as Record<
      string,
      unknown
    >;
    expect(res.isError).toBe(true);
    expect(listAlerts(appHome)).toHaveLength(0);
  });
});
