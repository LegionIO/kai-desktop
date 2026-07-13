/**
 * Tests for the Responses-API request-body repair (createResponsesApiPatchingFetch
 * in language-model.ts). The OpenAI Responses API requires every tool call/result
 * item to be well-formed; the llm-gateway 400s ("Missing required parameter:
 * 'input[N].output'") when a function_call_output reaches it with a missing/
 * malformed output, or a function_call has no matching output. This wrapper
 * repairs the body before it leaves the client. We stub global fetch to capture
 * the outgoing body.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { __internal } from '../language-model.js';

const { createResponsesApiPatchingFetch } = __internal;

const RESP_URL = 'https://llm-gateway.uhg.com/responses';

// Capture the body the wrapper actually sends by stubbing global fetch.
function withCapturedFetch(): { sentBody: () => Record<string, unknown> | null } {
  let captured: Record<string, unknown> | null = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      captured = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      return new Response('{}', { status: 200 });
    }),
  );
  return { sentBody: () => captured };
}

afterEach(() => vi.unstubAllGlobals());

async function send(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const cap = withCapturedFetch();
  const patch = createResponsesApiPatchingFetch();
  await patch(RESP_URL, { method: 'POST', body: JSON.stringify(body) });
  return cap.sentBody();
}

describe('Responses-API body repair — missing/malformed tool output (input[N].output)', () => {
  it('backfills a missing output on an existing function_call_output', async () => {
    const out = await send({
      model: 'gpt-5.4',
      input: [
        { type: 'function_call', call_id: 'c1', name: 'sh', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1' /* output MISSING */ },
      ],
    });
    const item = (out!.input as Array<Record<string, unknown>>)[1];
    expect(typeof item.output).toBe('string');
    expect(item.output).toBe('Tool execution did not return a result.');
  });

  it('coerces a non-string (object) output to a JSON string', async () => {
    const out = await send({
      model: 'gpt-5.4',
      input: [
        { type: 'function_call', call_id: 'c1', name: 'sh', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: { ok: true } },
      ],
    });
    const item = (out!.input as Array<Record<string, unknown>>)[1];
    expect(item.output).toBe(JSON.stringify({ ok: true }));
  });

  it('leaves a valid string output untouched', async () => {
    const out = await send({
      model: 'gpt-5.4',
      input: [
        { type: 'function_call', call_id: 'c1', name: 'sh', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: 'done' },
      ],
    });
    const item = (out!.input as Array<Record<string, unknown>>)[1];
    expect(item.output).toBe('done');
  });

  it('still injects a function_call_output for an ORPHANED function_call', async () => {
    const out = await send({
      model: 'gpt-5.4',
      input: [{ type: 'function_call', call_id: 'orphan', name: 'sh', arguments: '{}' }],
    });
    const items = out!.input as Array<Record<string, unknown>>;
    const injected = items.find((it) => it.type === 'function_call_output' && it.call_id === 'orphan');
    expect(injected).toBeDefined();
    expect(typeof injected!.output).toBe('string');
  });

  it('does not touch a non-/responses URL', async () => {
    const cap = withCapturedFetch();
    const patch = createResponsesApiPatchingFetch();
    const body = { input: [{ type: 'function_call_output', call_id: 'c1' }] };
    await patch('https://example.com/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) });
    // Passed through unchanged (no repair on a non-responses endpoint).
    const item = (cap.sentBody()!.input as Array<Record<string, unknown>>)[0];
    expect(item.output).toBeUndefined();
  });
});
