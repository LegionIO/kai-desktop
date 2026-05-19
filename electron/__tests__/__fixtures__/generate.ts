/**
 * Typed JSONL fixture generator.
 *
 * Run with: `pnpm fixtures:gen`
 *
 * Edit `FIXTURE_INPUTS` below to add or modify recorded request/response
 * pairs. Each entry is a discriminated union keyed by `provider`; the union
 * arms use the real SDK types where they exist so a fixture that drifts away
 * from the real wire format is a compile error.
 *
 * The generator:
 *   1. Validates each input against its provider arm.
 *   2. Redacts known auth headers (`authorization`, `x-api-key`, `api-key`).
 *   3. Sorts JSON keys recursively for deterministic output.
 *   4. Writes one fixture file per `{provider, file}` group as JSONL.
 *   5. Re-hashes every fixture file into `.checksum` (sha256 manifest).
 */

import { mkdirSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import type { ChatCompletionCreateParamsBase as OpenAIChatParams } from 'openai/resources/chat/completions';

// Anthropic and Bedrock body shapes are validated at runtime by the msw
// handlers (and by the canary tests). We keep them as `Record<string,
// unknown>` here because pulling in `@anthropic-ai/sdk` or
// `@aws-sdk/client-bedrock-runtime` purely for typedefs would bloat
// devDependencies without buying us much: the wire format is well
// documented and rarely changes.
type AnthropicMessageParams = Record<string, unknown>;

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// ---------------------------------------------------------------------------
// Public input shape — discriminated union by `provider`.
// ---------------------------------------------------------------------------
type FixtureInput =
  | AnthropicInput
  | OpenAIInput
  | OpenAIResponsesInput
  | BedrockInput
  | AzureInput
  | ClaudeSDKInput
  | CodexInput
  | MastraInput;

interface FixtureFile {
  file: string;
  entries: FixtureEntry[];
}

interface FixtureEntry {
  request: { method: string; url: string; body?: unknown; headers?: Record<string, string> };
  response: {
    status: number;
    headers?: Record<string, string>;
    body?: unknown;
    bodyStream?: string[];
  };
}

interface AnthropicInput {
  provider: 'anthropic';
  file: string;
  entries: Array<{
    requestBody: AnthropicMessageParams;
    responseBody?: unknown;
    responseStream?: string[];
    status?: number;
  }>;
}

interface OpenAIInput {
  provider: 'openai';
  file: string;
  entries: Array<{
    requestBody: OpenAIChatParams;
    responseBody?: unknown;
    responseStream?: string[];
    status?: number;
  }>;
}

interface OpenAIResponsesInput {
  provider: 'openai-responses';
  file: string;
  entries: Array<{
    requestBody: Record<string, unknown>;
    responseBody?: unknown;
    responseStream?: string[];
    status?: number;
  }>;
}

interface BedrockInput {
  provider: 'bedrock';
  file: string;
  entries: Array<{
    modelId: string;
    region: string;
    requestBody: Record<string, unknown>;
    responseBody?: unknown;
    status?: number;
  }>;
}

interface AzureInput {
  provider: 'azure';
  file: string;
  entries: Array<{
    resource: string;
    deployment: string;
    requestBody: Record<string, unknown>;
    responseBody?: unknown;
    responseStream?: string[];
    status?: number;
  }>;
}

interface ClaudeSDKInput {
  provider: 'claude-sdk';
  file: string;
  entries: Array<{
    requestBody: AnthropicMessageParams;
    responseBody?: unknown;
    responseStream?: string[];
    status?: number;
  }>;
}

interface CodexInput {
  provider: 'codex';
  file: string;
  entries: Array<{
    requestBody: Record<string, unknown>;
    responseBody?: unknown;
    responseStream?: string[];
    status?: number;
  }>;
}

interface MastraInput {
  provider: 'mastra';
  file: string;
  entries: Array<{
    requestUrl: string;
    requestBody: Record<string, unknown>;
    responseBody?: unknown;
    responseStream?: string[];
    status?: number;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => sortKeys(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out as unknown as T;
  }
  return value;
}

function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (
      lower === 'authorization' ||
      lower === 'x-api-key' ||
      lower === 'api-key' ||
      lower === 'cookie' ||
      lower.startsWith('x-amz-')
    ) {
      out[k] = 'test-key-not-real';
    } else {
      out[k] = v;
    }
  }
  return out;
}

function buildAnthropic(input: AnthropicInput | ClaudeSDKInput): FixtureFile {
  return {
    file: input.file,
    entries: input.entries.map((e) => ({
      request: {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        body: e.requestBody,
        headers: redactHeaders({
          'content-type': 'application/json',
          'x-api-key': 'test-key-not-real',
          'anthropic-version': '2023-06-01',
        }),
      },
      response: e.responseStream
        ? {
            status: e.status ?? 200,
            headers: { 'content-type': 'text/event-stream' },
            bodyStream: e.responseStream,
          }
        : {
            status: e.status ?? 200,
            headers: { 'content-type': 'application/json' },
            body: e.responseBody ?? {},
          },
    })),
  };
}

function buildOpenAI(input: OpenAIInput): FixtureFile {
  return {
    file: input.file,
    entries: input.entries.map((e) => ({
      request: {
        method: 'POST',
        url: 'https://api.openai.com/v1/chat/completions',
        body: e.requestBody,
        headers: redactHeaders({
          'content-type': 'application/json',
          authorization: 'Bearer test-key-not-real',
        }),
      },
      response: e.responseStream
        ? {
            status: e.status ?? 200,
            headers: { 'content-type': 'text/event-stream' },
            bodyStream: e.responseStream,
          }
        : {
            status: e.status ?? 200,
            headers: { 'content-type': 'application/json' },
            body: e.responseBody ?? {},
          },
    })),
  };
}

function buildOpenAIResponses(input: OpenAIResponsesInput): FixtureFile {
  return {
    file: input.file,
    entries: input.entries.map((e) => ({
      request: {
        method: 'POST',
        url: 'https://api.openai.com/v1/responses',
        body: e.requestBody,
        headers: redactHeaders({
          'content-type': 'application/json',
          authorization: 'Bearer test-key-not-real',
        }),
      },
      response: e.responseStream
        ? {
            status: e.status ?? 200,
            headers: { 'content-type': 'text/event-stream' },
            bodyStream: e.responseStream,
          }
        : {
            status: e.status ?? 200,
            headers: { 'content-type': 'application/json' },
            body: e.responseBody ?? {},
          },
    })),
  };
}

function buildBedrock(input: BedrockInput): FixtureFile {
  return {
    file: input.file,
    entries: input.entries.map((e) => ({
      request: {
        method: 'POST',
        url: `https://bedrock-runtime.${e.region}.amazonaws.com/model/${encodeURIComponent(e.modelId)}/invoke`,
        body: e.requestBody,
        headers: redactHeaders({
          'content-type': 'application/json',
          authorization: 'AWS4-HMAC-SHA256 test-key-not-real',
        }),
      },
      response: {
        status: e.status ?? 200,
        headers: { 'content-type': 'application/json' },
        body: e.responseBody ?? {},
      },
    })),
  };
}

function buildAzure(input: AzureInput): FixtureFile {
  return {
    file: input.file,
    entries: input.entries.map((e) => ({
      request: {
        method: 'POST',
        url: `https://${e.resource}.openai.azure.com/openai/deployments/${e.deployment}/chat/completions?api-version=2024-02-15-preview`,
        body: e.requestBody,
        headers: redactHeaders({
          'content-type': 'application/json',
          'api-key': 'test-key-not-real',
        }),
      },
      response: e.responseStream
        ? {
            status: e.status ?? 200,
            headers: { 'content-type': 'text/event-stream' },
            bodyStream: e.responseStream,
          }
        : {
            status: e.status ?? 200,
            headers: { 'content-type': 'application/json' },
            body: e.responseBody ?? {},
          },
    })),
  };
}

function buildCodex(input: CodexInput): FixtureFile {
  return {
    file: input.file,
    entries: input.entries.map((e) => ({
      request: {
        method: 'POST',
        url: 'https://api.openai.com/v1/responses',
        body: e.requestBody,
        headers: redactHeaders({
          'content-type': 'application/json',
          authorization: 'Bearer test-key-not-real',
        }),
      },
      response: e.responseStream
        ? {
            status: e.status ?? 200,
            headers: { 'content-type': 'text/event-stream' },
            bodyStream: e.responseStream,
          }
        : {
            status: e.status ?? 200,
            headers: { 'content-type': 'application/json' },
            body: e.responseBody ?? {},
          },
    })),
  };
}

function buildMastra(input: MastraInput): FixtureFile {
  return {
    file: input.file,
    entries: input.entries.map((e) => ({
      request: {
        method: 'POST',
        url: e.requestUrl,
        body: e.requestBody,
        headers: redactHeaders({ 'content-type': 'application/json' }),
      },
      response: e.responseStream
        ? {
            status: e.status ?? 200,
            headers: { 'content-type': 'text/event-stream' },
            bodyStream: e.responseStream,
          }
        : {
            status: e.status ?? 200,
            headers: { 'content-type': 'application/json' },
            body: e.responseBody ?? {},
          },
    })),
  };
}

// ---------------------------------------------------------------------------
// Inputs — edit these to add new fixtures.
// ---------------------------------------------------------------------------
const FIXTURE_INPUTS: FixtureInput[] = [
  {
    provider: 'anthropic',
    file: 'simple-completion.jsonl',
    entries: [
      {
        requestBody: {
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'Say hi.' }],
        },
        responseBody: {
          id: 'msg_test_0001',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi.' }],
          model: 'claude-3-5-sonnet-20241022',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      },
    ],
  },
  {
    provider: 'openai',
    file: 'chat-basic.jsonl',
    entries: [
      {
        requestBody: {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'Say hi.' }],
        } as OpenAIChatParams,
        responseBody: {
          id: 'chatcmpl-test-0001',
          object: 'chat.completion',
          created: 1735689600,
          model: 'gpt-4o-mini',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Hi.' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        },
      },
    ],
  },
  {
    provider: 'bedrock',
    file: 'claude-via-bedrock.jsonl',
    entries: [
      {
        modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        region: 'us-east-1',
        requestBody: {
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'Say hi.' }],
        },
        responseBody: {
          id: 'msg_bdrk_test_0001',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi.' }],
          model: 'claude-3-5-sonnet-20241022-v2:0',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      },
    ],
  },
  {
    provider: 'azure',
    file: 'azure-openai-chat.jsonl',
    entries: [
      {
        resource: 'kai-test',
        deployment: 'gpt-4o-mini',
        requestBody: {
          messages: [{ role: 'user', content: 'Say hi.' }],
        },
        responseBody: {
          id: 'chatcmpl-azure-test-0001',
          object: 'chat.completion',
          created: 1735689600,
          model: 'gpt-4o-mini',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Hi.' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        },
      },
    ],
  },
  {
    provider: 'codex',
    file: 'streaming-with-mcp.jsonl',
    entries: [
      {
        requestBody: {
          model: 'gpt-4o-mini',
          input: 'Say hi.',
          stream: true,
          tools: [
            {
              type: 'mcp',
              server_label: 'test-mcp',
              server_url: 'http://localhost:1/mcp',
            },
          ],
        },
        responseStream: [
          'data: {"type":"response.created","response":{"id":"resp_test_0001"}}\n\n',
          'data: {"type":"response.output_text.delta","delta":"Hi."}\n\n',
          'data: {"type":"response.completed","response":{"id":"resp_test_0001"}}\n\n',
          'data: [DONE]\n\n',
        ],
      },
    ],
  },
  {
    provider: 'anthropic',
    file: 'tool-use.jsonl',
    entries: [
      {
        requestBody: {
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 256,
          messages: [{ role: 'user', content: 'What is the weather in NYC?' }],
          tools: [
            {
              name: 'get_weather',
              description: 'Get weather for a city.',
              input_schema: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
            },
          ],
        },
        responseBody: {
          id: 'msg_test_tool_0001',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will check the weather for you.' },
            {
              type: 'tool_use',
              id: 'toolu_test_0001',
              name: 'get_weather',
              input: { city: 'NYC' },
            },
          ],
          model: 'claude-3-5-sonnet-20241022',
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 25, output_tokens: 35 },
        },
      },
    ],
  },
  {
    provider: 'anthropic',
    file: 'streaming-multi-block.jsonl',
    entries: [
      {
        requestBody: {
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 256,
          stream: true,
          messages: [{ role: 'user', content: 'Tell a quick story.' }],
        },
        responseStream: [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stream_0001","type":"message","role":"assistant","content":[],"model":"claude-3-5-sonnet-20241022","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":8,"output_tokens":0}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Once upon"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" a time."}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":4}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ],
      },
    ],
  },
  {
    provider: 'anthropic',
    file: 'error-rate-limit.jsonl',
    entries: [
      {
        requestBody: {
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'Trigger rate limit.' }],
        },
        responseBody: {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'Number of request tokens has exceeded your per-minute rate limit.',
          },
        },
        status: 429,
      },
    ],
  },
  {
    provider: 'openai',
    file: 'chat-streaming.jsonl',
    entries: [
      {
        requestBody: {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'Stream a short greeting.' }],
          stream: true,
        } as OpenAIChatParams,
        responseStream: [
          'data: {"id":"chatcmpl-stream-0001","object":"chat.completion.chunk","created":1735689600,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-stream-0001","object":"chat.completion.chunk","created":1735689600,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"lo!"},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-stream-0001","object":"chat.completion.chunk","created":1735689600,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ],
      },
    ],
  },
  {
    provider: 'openai',
    file: 'chat-tool-calls.jsonl',
    entries: [
      {
        requestBody: {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'What is the weather in SF?' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Get weather for a city.',
                parameters: {
                  type: 'object',
                  properties: { city: { type: 'string' } },
                  required: ['city'],
                },
              },
            },
          ],
        } as OpenAIChatParams,
        responseBody: {
          id: 'chatcmpl-tool-0001',
          object: 'chat.completion',
          created: 1735689600,
          model: 'gpt-4o-mini',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_test_0001',
                    type: 'function',
                    function: {
                      name: 'get_weather',
                      arguments: '{"city":"SF"}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
        },
      },
    ],
  },
  {
    provider: 'claude-sdk',
    file: 'init-then-tool-use.jsonl',
    entries: [
      {
        requestBody: {
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 256,
          messages: [{ role: 'user', content: 'List files.' }],
          tools: [
            {
              name: 'mcp__kai__list_files',
              description: 'List files in a dir.',
              input_schema: {
                type: 'object',
                properties: { path: { type: 'string' } },
              },
            },
          ],
        },
        responseBody: {
          id: 'msg_sdk_init_0001',
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_sdk_0001',
              name: 'mcp__kai__list_files',
              input: { path: '.' },
            },
          ],
          model: 'claude-3-5-sonnet-20241022',
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 50, output_tokens: 20 },
        },
      },
    ],
  },
  {
    provider: 'claude-sdk',
    file: 'session-resume.jsonl',
    entries: [
      {
        requestBody: {
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 256,
          messages: [{ role: 'user', content: 'Continue.' }],
        },
        responseBody: {
          id: 'msg_sdk_resume_0001',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Resuming session.' }],
          model: 'claude-3-5-sonnet-20241022',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 4 },
        },
      },
    ],
  },
  {
    provider: 'codex',
    file: 'tool-call-deltas.jsonl',
    entries: [
      {
        requestBody: {
          model: 'gpt-4o-mini',
          input: 'Run a shell command.',
          stream: true,
          tools: [
            {
              type: 'mcp',
              server_label: 'kai',
              server_url: 'http://localhost:2/mcp',
            },
          ],
        },
        responseStream: [
          'data: {"type":"response.created","response":{"id":"resp_tool_0001"}}\n\n',
          'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_tool_0001","name":"shell","arguments":""}}\n\n',
          'data: {"type":"response.function_call_arguments.delta","delta":"{\\"cmd\\":\\"ls"}\n\n',
          'data: {"type":"response.function_call_arguments.delta","delta":"\\"}"}\n\n',
          'data: {"type":"response.completed","response":{"id":"resp_tool_0001"}}\n\n',
          'data: [DONE]\n\n',
        ],
      },
    ],
  },
  {
    provider: 'mastra',
    file: 'tool-call-sequence.jsonl',
    entries: [
      {
        requestUrl: 'https://api.openai.com/v1/chat/completions',
        requestBody: {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'Read a file.' }],
          stream: true,
        },
        responseStream: [
          'data: {"id":"chatcmpl-mastra-0001","object":"chat.completion.chunk","created":1735689600,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-mastra-0001","object":"chat.completion.chunk","created":1735689600,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"Reading file..."},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-mastra-0001","object":"chat.completion.chunk","created":1735689600,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_mastra_0001","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}]},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-mastra-0001","object":"chat.completion.chunk","created":1735689600,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n',
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------
function build(input: FixtureInput): { provider: string; file: FixtureFile } {
  switch (input.provider) {
    case 'anthropic':
      return { provider: 'anthropic', file: buildAnthropic(input) };
    case 'openai':
      return { provider: 'openai', file: buildOpenAI(input) };
    case 'openai-responses':
      return { provider: 'openai', file: buildOpenAIResponses(input) };
    case 'bedrock':
      return { provider: 'bedrock', file: buildBedrock(input) };
    case 'azure':
      return { provider: 'azure', file: buildAzure(input) };
    case 'claude-sdk':
      return { provider: 'claude-sdk', file: buildAnthropic(input) };
    case 'codex':
      return { provider: 'codex', file: buildCodex(input) };
    case 'mastra':
      return { provider: 'mastra', file: buildMastra(input) };
  }
}

function toJsonl(file: FixtureFile): string {
  return file.entries.map((e) => JSON.stringify(sortKeys(e))).join('\n') + '\n';
}

function listFixtureFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listFixtureFiles(full));
    } else if (name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out.sort();
}

function writeChecksumManifest(root: string): void {
  const files = listFixtureFiles(root);
  const lines: string[] = [];
  for (const f of files) {
    const hash = createHash('sha256').update(readFileSync(f)).digest('hex');
    lines.push(`${hash}  ${relative(root, f)}`);
  }
  writeFileSync(join(root, '.checksum'), lines.join('\n') + '\n');
}

function main(): void {
  for (const input of FIXTURE_INPUTS) {
    const built = build(input);
    const out = join(__dirname, built.provider, built.file.file);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, toJsonl(built.file));
    console.info(`[fixtures] wrote ${relative(__dirname, out)}`);
  }
  writeChecksumManifest(__dirname);
  console.info(`[fixtures] wrote ${relative(__dirname, join(__dirname, '.checksum'))}`);
}

main();
