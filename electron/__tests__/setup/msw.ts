/**
 * Per-provider msw handler builders.
 *
 * Each builder loads its provider's JSONL fixtures and returns msw v2
 * `RequestHandler[]` that intercept the canonical SDK URLs for that
 * provider. Tests pull these in via `httpMock.use(...mockAnthropic())`
 * and trigger the SDK call under test.
 *
 * Fixture format: one JSON object per line. Each object MUST contain:
 *   - request: { method, url (string or regex source), body? }
 *   - response: { status, headers?, body | bodyStream }
 *
 * If `bodyStream` is present, the handler responds with a stream of
 * Server-Sent Events (used for streaming completions). Otherwise `body`
 * is returned as JSON.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { http, HttpResponse, type RequestHandler } from 'msw';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', '__fixtures__');

interface FixtureEntry {
  request: {
    method: string;
    url: string;
    body?: unknown;
  };
  response: {
    status: number;
    headers?: Record<string, string>;
    body?: unknown;
    bodyStream?: string[];
  };
}

function loadFixtures(provider: string, file: string): FixtureEntry[] {
  const path = join(FIXTURES_DIR, provider, file);
  if (!existsSync(path)) {
    throw new Error(
      `Fixture not found: ${path}. Run \`pnpm fixtures:gen\` after adding fixture inputs.`,
    );
  }
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  return lines.map((line, idx) => {
    try {
      return JSON.parse(line) as FixtureEntry;
    } catch (err) {
      throw new Error(
        `Failed to parse fixture ${path} at line ${idx + 1}: ${(err as Error).message}`,
      );
    }
  });
}

function streamResponse(events: string[], headers: Record<string, string>) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const evt of events) {
        controller.enqueue(encoder.encode(evt));
      }
      controller.close();
    },
  });
  return new HttpResponse(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      ...headers,
    },
  });
}

function buildHandler(
  matcher: RegExp | string,
  entry: FixtureEntry,
): RequestHandler {
  const handler = http.post(matcher, () => {
    if (entry.response.bodyStream) {
      return streamResponse(
        entry.response.bodyStream,
        entry.response.headers ?? {},
      );
    }
    return HttpResponse.json(entry.response.body ?? {}, {
      status: entry.response.status,
      headers: entry.response.headers,
    });
  });
  return handler;
}

// ─── Anthropic ─────────────────────────────────────────────────────────────
const ANTHROPIC_URL = /https:\/\/api\.anthropic\.com\/v1\/messages.*/;

export function mockAnthropic(fixture = 'simple-completion.jsonl'): RequestHandler[] {
  const entries = loadFixtures('anthropic', fixture);
  return entries.map((e) => buildHandler(ANTHROPIC_URL, e));
}

// ─── OpenAI Chat Completions + Responses API ───────────────────────────────
const OPENAI_CHAT_URL = /https:\/\/api\.openai\.com\/v1\/chat\/completions.*/;
const OPENAI_RESPONSES_URL = /https:\/\/api\.openai\.com\/v1\/responses.*/;

export function mockOpenAI(fixture = 'chat-basic.jsonl'): RequestHandler[] {
  const entries = loadFixtures('openai', fixture);
  // Heuristic: route /responses fixtures by checking the recorded request URL.
  return entries.map((e) => {
    const url = e.request.url.includes('/responses')
      ? OPENAI_RESPONSES_URL
      : OPENAI_CHAT_URL;
    return buildHandler(url, e);
  });
}

// ─── Bedrock ───────────────────────────────────────────────────────────────
const BEDROCK_URL = /https:\/\/bedrock-runtime\.[^/]+\.amazonaws\.com\/model\/.+\/invoke/;

export function mockBedrock(
  fixture = 'claude-via-bedrock.jsonl',
): RequestHandler[] {
  const entries = loadFixtures('bedrock', fixture);
  return entries.map((e) => buildHandler(BEDROCK_URL, e));
}

// ─── Azure OpenAI ──────────────────────────────────────────────────────────
const AZURE_URL =
  /https:\/\/[^.]+\.openai\.azure\.com\/openai\/deployments\/.+\/chat\/completions/;

export function mockAzure(
  fixture = 'azure-openai-chat.jsonl',
): RequestHandler[] {
  const entries = loadFixtures('azure', fixture);
  return entries.map((e) => buildHandler(AZURE_URL, e));
}

// ─── Claude Agent SDK ──────────────────────────────────────────────────────
// The Anthropic Agent SDK currently uses the same /v1/messages endpoint as
// the bare Anthropic SDK, so this is functionally a thin wrapper. Kept as
// a separate export so tests document their intent and so the implementation
// can diverge if the SDK adds dedicated endpoints.
export function mockClaudeSDK(
  fixture = 'agent-streaming.jsonl',
): RequestHandler[] {
  const entries = loadFixtures('claude-sdk', fixture);
  return entries.map((e) => buildHandler(ANTHROPIC_URL, e));
}

// ─── OpenAI Codex SDK ──────────────────────────────────────────────────────
// Codex SDK uses /v1/responses with tool/MCP framing.
export function mockCodex(
  fixture = 'streaming-with-mcp.jsonl',
): RequestHandler[] {
  const entries = loadFixtures('codex', fixture);
  return entries.map((e) => buildHandler(OPENAI_RESPONSES_URL, e));
}

// ─── URL pattern exports (for the canary/coverage tests) ───────────────────
export const PROVIDER_URLS = {
  anthropic: ANTHROPIC_URL,
  openaiChat: OPENAI_CHAT_URL,
  openaiResponses: OPENAI_RESPONSES_URL,
  bedrock: BEDROCK_URL,
  azure: AZURE_URL,
} as const;
