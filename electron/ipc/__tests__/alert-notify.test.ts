import { describe, it, expect, beforeEach } from 'vitest';
import { setAlertCreatedHandler, notifyAlertCreated } from '../alert-notify';
import type { Alert } from '../alert-store';

const sampleAlert: Alert = {
  id: 'a1',
  kind: 'question',
  status: 'open',
  title: 'Which env?',
  body: 'ambiguous target',
  conversationId: 'c1',
  createdAt: new Date().toISOString(),
};

describe('alert-notify seam', () => {
  beforeEach(() => setAlertCreatedHandler(null));

  it('is a no-op when no handler is registered', () => {
    expect(() => notifyAlertCreated(sampleAlert)).not.toThrow();
  });

  it('forwards the alert to the registered handler', () => {
    const seen: Alert[] = [];
    setAlertCreatedHandler((a) => seen.push(a));
    notifyAlertCreated(sampleAlert);
    expect(seen).toEqual([sampleAlert]);
  });

  it('swallows handler errors so a failed notification never breaks the caller', () => {
    setAlertCreatedHandler(() => {
      throw new Error('notification backend down');
    });
    expect(() => notifyAlertCreated(sampleAlert)).not.toThrow();
  });

  it('unregisters when set to null', () => {
    let count = 0;
    setAlertCreatedHandler(() => count++);
    notifyAlertCreated(sampleAlert);
    setAlertCreatedHandler(null);
    notifyAlertCreated(sampleAlert);
    expect(count).toBe(1);
  });
});
