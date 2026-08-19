import { describe, expect, it } from 'vitest';
import { BrowserAssistantRunRegistry } from '../assistant-runs.js';

describe('BrowserAssistantRunRegistry', () => {
  it('rejects unknown and ended owner ids instead of granting an implicit generation', async () => {
    const runs = new BrowserAssistantRunRegistry();
    expect(() => runs.acquire('chat-1', 'unknown')).toThrow(/ended or is not registered/);

    runs.begin('chat-1', 'run-1');
    expect(runs.assertActive('chat-1', 'run-1')).toBeGreaterThan(0);
    await runs.end('chat-1', 'run-1');

    expect(() => runs.assertActive('chat-1', 'run-1')).toThrow(/ended or is not registered/);
    expect(runs.size).toBe(0);
  });

  it('stops accepting work synchronously and deletes the capability after operations drain', async () => {
    const runs = new BrowserAssistantRunRegistry();
    runs.begin('chat-1', 'run-1');
    const lease = runs.acquire('chat-1', 'run-1');
    let ended = false;
    const cleanup = runs.end('chat-1', 'run-1').then(() => {
      ended = true;
    });

    expect(() => runs.acquire('chat-1', 'run-1')).toThrow(/ended or is not registered/);
    await Promise.resolve();
    expect(ended).toBe(false);
    lease.release();
    await cleanup;
    expect(ended).toBe(true);
    expect(runs.size).toBe(0);
  });

  it('invalidates every run owned by a removed conversation without retaining entries', async () => {
    const runs = new BrowserAssistantRunRegistry();
    runs.begin('chat-1', 'run-a');
    runs.begin('chat-1', 'run-b');
    runs.begin('chat-2', 'run-c');

    await runs.endConversation('chat-1');

    expect(() => runs.assertActive('chat-1', 'run-a')).toThrow();
    expect(() => runs.assertActive('chat-1', 'run-b')).toThrow();
    expect(runs.assertActive('chat-2', 'run-c')).toBeGreaterThan(0);
    expect(runs.size).toBe(1);
  });

  it('prevents Realtime and text Browser ownership from overlapping in one conversation', async () => {
    const runs = new BrowserAssistantRunRegistry();
    runs.begin('chat-1', 'text-run');

    expect(() => runs.begin('chat-1', 'realtime-run', 'realtime')).toThrow(/another assistant modality/i);
    expect(() => runs.begin('chat-2', 'realtime-run', 'realtime')).not.toThrow();

    const lease = runs.acquire('chat-1', 'text-run');
    const ending = runs.end('chat-1', 'text-run');
    expect(() => runs.begin('chat-1', 'realtime-run-2', 'realtime')).toThrow(/another assistant modality/i);
    lease.release();
    await ending;

    expect(() => runs.begin('chat-1', 'realtime-run-2', 'realtime')).not.toThrow();
  });

  it('allows the existing text-turn handoff protocol but only one Realtime owner', () => {
    const runs = new BrowserAssistantRunRegistry();
    runs.begin('chat-1', 'text-a');
    expect(() => runs.begin('chat-1', 'text-b')).not.toThrow();

    runs.begin('chat-2', 'realtime-a', 'realtime');
    expect(() => runs.begin('chat-2', 'realtime-b', 'realtime')).toThrow(/another assistant modality/i);
  });

  it('clear revokes new work immediately but retains acquired operations until release', () => {
    const runs = new BrowserAssistantRunRegistry();
    runs.begin('chat-1', 'run-1');
    const lease = runs.acquire('chat-1', 'run-1');

    runs.clear();

    expect(() => runs.acquire('chat-1', 'run-1')).toThrow(/ended or is not registered/);
    expect(runs.size).toBe(1);
    lease.release();
    expect(runs.size).toBe(0);
  });
});
