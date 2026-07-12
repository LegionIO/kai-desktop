/**
 * Tests for OpenAIRealtimeSttSession teardown/error safety (openai-realtime-stt.ts):
 * a late server message must NOT invoke transcript/error callbacks after the
 * session is canceled/destroyed, and a fatal top-level `error` must tear the
 * session down (not leave a half-open WS). `ws` is mocked so no socket opens;
 * private handlers are driven directly.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('ws', () => ({ default: class {} }));

const { OpenAIRealtimeSttSession } = await import('../openai-realtime-stt.js');

type Cbs = {
  onPartial: ReturnType<typeof vi.fn>;
  onFinal: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
};
function makeSession() {
  const callbacks: Cbs = { onPartial: vi.fn(), onFinal: vi.fn(), onError: vi.fn() };
  const session = new OpenAIRealtimeSttSession(
    { baseUrl: 'wss://api.openai.com', apiKey: 'sk-test', model: 'gpt-realtime-whisper' },
    callbacks as unknown as {
      onPartial: (text: string) => void;
      onFinal: (text: string) => void;
      onError: (error: string) => void;
    },
  );
  return { session: session as unknown as Record<string, unknown>, callbacks };
}

const deltaMsg = JSON.stringify({
  type: 'conversation.item.input_audio_transcription.delta',
  delta: 'secret words',
});

describe('callback suppression after teardown', () => {
  it('does not fire onPartial for a message that arrives after cancel()', () => {
    const { session, callbacks } = makeSession();
    (session.cancel as () => void)();
    (session.handleMessage as (d: unknown) => void)(deltaMsg);
    expect(callbacks.onPartial).not.toHaveBeenCalled();
  });

  it('does not fire onPartial for a message that arrives after destroy()', () => {
    const { session, callbacks } = makeSession();
    (session.destroy as () => void)();
    (session.handleMessage as (d: unknown) => void)(deltaMsg);
    expect(callbacks.onPartial).not.toHaveBeenCalled();
  });

  it('handleError is a no-op after abort', () => {
    const { session, callbacks } = makeSession();
    (session.cancel as () => void)();
    (session.handleError as (m: string) => void)('boom');
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it('processes a delta normally before teardown', () => {
    const { session, callbacks } = makeSession();
    (session.handleMessage as (d: unknown) => void)(deltaMsg);
    expect(callbacks.onPartial).toHaveBeenCalledWith('secret words');
  });
});

describe('fatal protocol error tears down the session', () => {
  it('a top-level error message marks the session aborted', () => {
    const { session, callbacks } = makeSession();
    const errMsg = JSON.stringify({ type: 'error', error: { message: 'fatal' } });
    (session.handleMessage as (d: unknown) => void)(errMsg);
    expect(callbacks.onError).toHaveBeenCalledWith('fatal');
    // After failAndClose, a subsequent message is ignored (aborted).
    (session.handleMessage as (d: unknown) => void)(deltaMsg);
    expect(callbacks.onPartial).not.toHaveBeenCalled();
  });
});
