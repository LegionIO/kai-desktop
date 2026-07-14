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
vi.mock('../alert-notify.js', () => ({ setAlertCreatedHandler: vi.fn() }));

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
