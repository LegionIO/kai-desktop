import { describe, it, expect, vi } from 'vitest';

// alerts.ts imports electron + the automations/web-clients graph at module load;
// stub them so we can unit-test the pure answer/decision formatters.
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  Notification: class {
    static isSupported() {
      return false;
    }
    show() {}
  },
}));
vi.mock('../../automations/actions.js', () => ({
  resumeConversationWithMessage: vi.fn(async () => undefined),
}));
vi.mock('../../web-server/web-clients.js', () => ({ broadcastToWebClients: vi.fn() }));
vi.mock('../alert-notify.js', () => ({ setAlertCreatedHandler: vi.fn(), notifyAlertCreated: vi.fn() }));
vi.mock('../conversation-store.js', () => ({
  readConversation: vi.fn(() => ({ id: 'c1' })),
  isWriteTombstoned: vi.fn(() => false),
}));
vi.mock('../alert-store.js', async () => {
  const actual = (await vi.importActual('../alert-store.js')) as Record<string, unknown>;
  return { ...actual, createAlert: vi.fn(() => ({ id: 'alert-1', kind: 'question' })), dismissAlert: vi.fn() };
});
vi.mock('../../tools/ask-user.js', () => ({ setRecoveredAnswerDeliverer: vi.fn() }));

import { __internal } from '../alerts';
import type { Alert } from '../alert-store';

const base: Alert = {
  id: 'a1',
  kind: 'question',
  status: 'answered',
  title: 'Deploy target',
  body: 'ambiguous',
  conversationId: 'c1',
  createdAt: new Date().toISOString(),
  questions: [
    {
      question: 'Which environment should I deploy to?',
      header: 'Env',
      options: [{ label: 'staging' }, { label: 'prod' }],
    },
  ],
};

describe('alerts formatters', () => {
  it('formatAnswer maps header → original question text and lists the choice', () => {
    const out = __internal.formatAnswer(base, { Env: 'prod' });
    expect(out).toContain('Deploy target');
    expect(out).toContain('Which environment should I deploy to? → prod');
  });

  it('formatAnswer falls back to the header when no matching question', () => {
    const out = __internal.formatAnswer({ ...base, questions: [] }, { Region: 'us-east' });
    expect(out).toContain('Region → us-east');
  });

  it('formatAnswer handles an empty answer object', () => {
    const out = __internal.formatAnswer(base, {});
    expect(out).toContain('(no answer provided)');
  });

  it('formatDecision distinguishes approve vs deny and includes the action', () => {
    const alert: Alert = { ...base, kind: 'approval', approvalAction: 'push to prod' };
    expect(__internal.formatDecision(alert, 'approve')).toContain('Approved');
    expect(__internal.formatDecision(alert, 'approve')).toContain('push to prod');
    expect(__internal.formatDecision(alert, 'deny')).toContain('Denied');
    expect(__internal.formatDecision(alert, 'deny')).toContain('Do not proceed');
  });

  it('formatDecision appends a free-text note when the user provides one', () => {
    const alert: Alert = { ...base, kind: 'approval', approvalAction: 'push to prod' };
    const out = __internal.formatDecision(alert, 'approve', 'but skip the migration step');
    expect(out).toContain('Approved');
    expect(out).toContain('Note from the user: but skip the migration step');
    // Empty/whitespace note is ignored.
    expect(__internal.formatDecision(alert, 'deny', '   ')).not.toContain('Note from the user');
  });
});

describe('alerts IPC validators', () => {
  it('isValidAlertId accepts UUIDs and rejects everything else', () => {
    expect(__internal.isValidAlertId('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
    expect(__internal.isValidAlertId('../../etc/passwd')).toBe(false);
    expect(__internal.isValidAlertId('not-a-uuid')).toBe(false);
    expect(__internal.isValidAlertId('')).toBe(false);
    expect(__internal.isValidAlertId(42)).toBe(false);
    expect(__internal.isValidAlertId(null)).toBe(false);
  });

  it('sanitizeAnswer coerces a bounded string map and rejects bad shapes', () => {
    expect(__internal.sanitizeAnswer({ Env: 'prod' })).toEqual({ Env: 'prod' });
    expect(__internal.sanitizeAnswer({})).toBeNull(); // empty
    expect(__internal.sanitizeAnswer([])).toBeNull(); // array
    expect(__internal.sanitizeAnswer(null)).toBeNull();
    expect(__internal.sanitizeAnswer('x')).toBeNull();
    expect(__internal.sanitizeAnswer({ Env: 123 })).toBeNull(); // non-string value
    expect(__internal.sanitizeAnswer({ Env: { nested: 'x' } })).toBeNull(); // nested
  });

  it('sanitizeAnswer rejects oversized keys/values and too many entries', () => {
    expect(__internal.sanitizeAnswer({ k: 'a'.repeat(2001) })).toBeNull();
    expect(__internal.sanitizeAnswer({ ['k'.repeat(201)]: 'v' })).toBeNull();
    const many: Record<string, string> = {};
    for (let i = 0; i < 21; i++) many[`k${i}`] = 'v';
    expect(__internal.sanitizeAnswer(many)).toBeNull();
  });
});

describe('deliverRecoveredAnswer (raced answer whose run finished before consuming it)', () => {
  it('re-injects into the ORIGIN conversation as a labeled turn when it still exists', async () => {
    const { initializeAlerts, deliverRecoveredAnswer } = await import('../alerts');
    const { resumeConversationWithMessage } = await import('../../automations/actions.js');
    const { readConversation } = await import('../conversation-store.js');
    // Echo the persisted turn back on the post-resume read so the R118 disk-commit
    // confirmation passes immediately (no ~3s poll).
    let persistedText = '';
    (resumeConversationWithMessage as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_conv: string, promptText: string) => {
        persistedText = promptText;
      },
    );
    (readConversation as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      id: 'c1',
      messages: persistedText ? [{ role: 'user', content: persistedText }] : [],
    }));
    const actionDeps = {} as never;
    initializeAlerts({ appHome: '/tmp/app', getActionDeps: () => actionDeps, alertSurface: () => 'off' });

    const res = await deliverRecoveredAnswer('c1', 'Deploy target', { Env: 'prod' });
    expect(res).toEqual({ delivered: true });
    const call = (resumeConversationWithMessage as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(call?.[0]).toBe('c1');
    expect(call?.[1]).toContain('[Answering your earlier question "Deploy target"]');
    expect(call?.[1]).toContain('- Env → prod');
  });

  it('records a durable pending-delivery alert before the resume and dismisses it once committed on disk (R117/R118)', async () => {
    const { initializeAlerts, deliverRecoveredAnswer } = await import('../alerts');
    const { resumeConversationWithMessage } = await import('../../automations/actions.js');
    const { readConversation } = await import('../conversation-store.js');
    const { createAlert, dismissAlert } = await import('../alert-store.js');
    (createAlert as unknown as ReturnType<typeof vi.fn>).mockClear();
    (dismissAlert as unknown as ReturnType<typeof vi.fn>).mockClear();
    // Capture the persisted text (with its unique deliveryId) and, after the resume,
    // have readConversation return a tree containing THIS turn — so the disk-commit
    // confirmation (R118: server-owned cooperative persist may be deferred) passes and
    // the pending durability alert is dismissed.
    let persistedText = '';
    (resumeConversationWithMessage as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_conv: string, promptText: string) => {
        persistedText = promptText;
      },
    );
    (readConversation as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      id: 'c1',
      messages: persistedText ? [{ role: 'user', content: persistedText }] : [],
    }));
    initializeAlerts({ appHome: '/tmp/app', getActionDeps: () => ({}) as never, alertSurface: () => 'off' });

    const res = await deliverRecoveredAnswer('c1', 'Deploy target', { Env: 'prod' });
    expect(res).toEqual({ delivered: true });
    // A durable pending-delivery record was created BEFORE the resume...
    expect(createAlert as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    // ...and dismissed once the turn was confirmed committed on disk (id from mock).
    expect(dismissAlert as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('/tmp/app', 'alert-1');
  });

  it('abandons delivery + dismisses the pending alert when the conversation is DELETED during the resume wait (R133/R134)', async () => {
    const { initializeAlerts, deliverRecoveredAnswer } = await import('../alerts');
    const { resumeConversationWithMessage } = await import('../../automations/actions.js');
    const { readConversation, isWriteTombstoned } = await import('../conversation-store.js');
    const { createAlert, dismissAlert } = await import('../alert-store.js');
    (createAlert as unknown as ReturnType<typeof vi.fn>).mockClear();
    (dismissAlert as unknown as ReturnType<typeof vi.fn>).mockClear();
    (readConversation as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({ id: 'c1', messages: [] }));
    // Deletion is signaled by the EXPLICIT tombstone (isWriteTombstoned), NOT a null read.
    // The conversation is live at entry, then the resume marks it deleted.
    let deleted = false;
    (isWriteTombstoned as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => deleted);
    (resumeConversationWithMessage as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      deleted = true;
    });
    initializeAlerts({ appHome: '/tmp/app', getActionDeps: () => ({}) as never, alertSurface: () => 'off' });

    const res = await deliverRecoveredAnswer('c1', 'Deploy target', { Env: 'prod' });
    expect(res).toEqual({ delivered: false });
    expect(dismissAlert as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('/tmp/app', 'alert-1');
    (isWriteTombstoned as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => false); // reset for later tests
  });

  it('does NOT abandon on a TRANSIENT null read (I/O error) — only an explicit delete tombstone abandons (R134)', async () => {
    const { initializeAlerts, deliverRecoveredAnswer } = await import('../alerts');
    const { resumeConversationWithMessage } = await import('../../automations/actions.js');
    const { readConversation, isWriteTombstoned } = await import('../conversation-store.js');
    (isWriteTombstoned as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false); // never deleted
    // The resume commits the turn; isWriteTombstoned is false so delivery is treated as
    // committed/normal — NOT abandoned as if deleted.
    let persistedText = '';
    (resumeConversationWithMessage as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_c: string, t: string) => {
        persistedText = t;
      },
    );
    (readConversation as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      id: 'c1',
      messages: persistedText ? [{ role: 'user', content: persistedText }] : [],
    }));
    initializeAlerts({ appHome: '/tmp/app', getActionDeps: () => ({}) as never, alertSurface: () => 'off' });

    const res = await deliverRecoveredAnswer('c1', 'Deploy target', { Env: 'prod' });
    expect(res).toEqual({ delivered: true });
  });

  it('raises a persistent question Alert (delivered:false) when the conversation is gone', async () => {
    const { initializeAlerts, deliverRecoveredAnswer } = await import('../alerts');
    const { readConversation } = await import('../conversation-store.js');
    const { createAlert } = await import('../alert-store.js');
    (readConversation as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
    initializeAlerts({ appHome: '/tmp/app', getActionDeps: () => ({}) as never, alertSurface: () => 'off' });

    const res = await deliverRecoveredAnswer('gone', 'Deploy target', { Env: 'prod' });
    expect(res).toEqual({ delivered: false });
    expect(createAlert as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it('falls back to a generic label when no question title is provided', async () => {
    const { initializeAlerts, deliverRecoveredAnswer } = await import('../alerts');
    const { resumeConversationWithMessage } = await import('../../automations/actions.js');
    const { readConversation } = await import('../conversation-store.js');
    let persistedText = '';
    (resumeConversationWithMessage as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_conv: string, promptText: string) => {
        persistedText = promptText;
      },
    );
    (readConversation as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      id: 'c1',
      messages: persistedText ? [{ role: 'user', content: persistedText }] : [],
    }));
    initializeAlerts({ appHome: '/tmp/app', getActionDeps: () => ({}) as never, alertSurface: () => 'off' });

    await deliverRecoveredAnswer('c1', '', { Env: 'prod' });
    const call = (resumeConversationWithMessage as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(call?.[1]).toContain('your earlier question');
  });

  it('threads the conversation reasoningEffort + per-thread overrides into the resume (R92/R93)', async () => {
    const { initializeAlerts, deliverRecoveredAnswer } = await import('../alerts');
    const { resumeConversationWithMessage } = await import('../../automations/actions.js');
    const { readConversation } = await import('../conversation-store.js');
    let persistedText = '';
    (resumeConversationWithMessage as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_conv: string, promptText: string) => {
        persistedText = promptText;
      },
    );
    (readConversation as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      id: 'c1',
      selectedModelKey: 'm1',
      reasoningEffort: 'high',
      temperature: 0.2,
      systemPromptOverride: 'be terse',
      maxSteps: 7,
      runtimeOverride: 'codex-sdk',
      // Echo the committed turn post-resume so the R118 disk-commit check passes fast.
      messages: persistedText ? [{ role: 'user', content: persistedText }] : [],
    }));
    initializeAlerts({ appHome: '/tmp/app', getActionDeps: () => ({}) as never, alertSurface: () => 'off' });

    await deliverRecoveredAnswer('c1', 'Deploy target', { Env: 'prod' });
    const call = (resumeConversationWithMessage as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    const opts = call?.[3] as {
      reasoningEffort?: string;
      threadOverrides?: {
        temperature?: number;
        systemPromptOverride?: string;
        maxSteps?: number;
        runtimeOverride?: string;
      };
    };
    expect(opts?.reasoningEffort).toBe('high');
    expect(opts?.threadOverrides).toMatchObject({
      temperature: 0.2,
      systemPromptOverride: 'be terse',
      maxSteps: 7,
      runtimeOverride: 'codex-sdk',
    });
  });

  it("does NOT report delivered when a CONCURRENT recovery's turn (not this one) is in the suffix (R93)", async () => {
    const { initializeAlerts, deliverRecoveredAnswer } = await import('../alerts');
    const { resumeConversationWithMessage } = await import('../../automations/actions.js');
    const { readConversation } = await import('../conversation-store.js');
    const { createAlert } = await import('../alert-store.js');
    (createAlert as unknown as ReturnType<typeof vi.fn>).mockClear();
    // Pre-resume snapshot: 2 messages. After a pre-commit throw, the suffix contains
    // ONLY a DIFFERENT recovery's labeled turn (recovery A committed "Env → staging"),
    // never THIS recovery's exact text ("Env → prod"). A prefix match would
    // false-positive; the exact-text match must not.
    (readConversation as unknown as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ id: 'c1', messages: [{ role: 'user' }, { role: 'assistant' }] })
      .mockReturnValueOnce({
        id: 'c1',
        messages: [
          { role: 'user' },
          { role: 'assistant' },
          { role: 'user', content: '[Answering your earlier question "Other"]\n- Env → staging' },
        ],
      });
    (resumeConversationWithMessage as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('busy'));
    initializeAlerts({ appHome: '/tmp/app', getActionDeps: () => ({}) as never, alertSurface: () => 'off' });

    const res = await deliverRecoveredAnswer('c1', 'Deploy target', { Env: 'prod' });
    // Not committed → fall through to the durable re-send Alert (delivered:false) so
    // THIS recovery's answer is NOT dropped as if it landed.
    expect(res).toEqual({ delivered: false });
    expect(createAlert as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it("reports delivered when THIS recovery's committed turn is in the suffix after a post-commit failure (R92/R93/R94)", async () => {
    const { initializeAlerts, deliverRecoveredAnswer } = await import('../alerts');
    const { resumeConversationWithMessage } = await import('../../automations/actions.js');
    const { readConversation } = await import('../conversation-store.js');
    // Capture the exact labeled text (with its unique per-delivery id) the resume
    // was asked to persist, then have the "after" read echo it back as a committed
    // turn — so the committed-check matches THIS delivery's own id, not a guess.
    let persistedText = '';
    (resumeConversationWithMessage as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_conv: string, promptText: string) => {
        persistedText = promptText;
        throw new Error('gen failed'); // fail AFTER the (simulated) commit
      },
    );
    // Read-count-independent: every readConversation returns a conv whose tree carries
    // THIS resume's committed labeled turn (persistedText, captured above). Covers the
    // pre-resume read, the fresh-id-allocation read, and the post-failure check read.
    (readConversation as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      id: 'c1',
      messages: [
        { role: 'user' },
        { role: 'assistant' },
        { role: 'user', content: persistedText },
        // A post-generation assistant/error node makes the labeled turn NOT the tail.
        { role: 'assistant', content: 'partial' },
      ],
    }));
    initializeAlerts({ appHome: '/tmp/app', getActionDeps: () => ({}) as never, alertSurface: () => 'off' });

    const res = await deliverRecoveredAnswer('c1', 'Deploy target', { Env: 'prod' });
    // Committed (answer on-branch) even though generation failed → delivered:true so
    // the stash is consumed and the caller doesn't route it a second time.
    expect(res).toEqual({ delivered: true });
  });

  it('finds the committed turn via a full messageTree scan even after a rewind to a SHORTER branch (R96)', async () => {
    const { initializeAlerts, deliverRecoveredAnswer } = await import('../alerts');
    const { resumeConversationWithMessage } = await import('../../automations/actions.js');
    const { readConversation } = await import('../conversation-store.js');
    let persistedText = '';
    (resumeConversationWithMessage as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_conv: string, promptText: string) => {
        persistedText = promptText;
        throw new Error('gen failed'); // fail AFTER commit
      },
    );
    // The ACTIVE branch (messages) is rewound to 1 node — the committed recovered turn
    // lives on the messageTree, NOT within a count-relative suffix of `messages`. A
    // count-based slice would miss it; the full-tree scan must not. Read-count-independent
    // (covers the pre-resume, fresh-id-allocation, and post-failure reads).
    (readConversation as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      id: 'c1',
      messages: [{ role: 'user', content: 'unrelated rewound head' }],
      messageTree: [
        { role: 'user', content: 'old' },
        { role: 'user', content: persistedText },
      ],
    }));
    initializeAlerts({ appHome: '/tmp/app', getActionDeps: () => ({}) as never, alertSurface: () => 'off' });

    const res = await deliverRecoveredAnswer('c1', 'Deploy target', { Env: 'prod' });
    expect(res).toEqual({ delivered: true });
  });

  it('returns delivered:false for an empty/invalid answer (nothing to deliver)', async () => {
    const { initializeAlerts, deliverRecoveredAnswer } = await import('../alerts');
    initializeAlerts({ appHome: '/tmp/app', getActionDeps: () => ({}) as never, alertSurface: () => 'off' });
    expect(await deliverRecoveredAnswer('c1', 't', {})).toEqual({ delivered: false });
  });
});
