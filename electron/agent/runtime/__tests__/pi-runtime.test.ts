/**
 * Unit tests for the pi CLI runtime adapter.
 *
 * `node:child_process` is mocked at the module boundary. A fake child process
 * exposes an async-iterable stdout that emits synthetic pi JSONL events; the
 * tests assert the translated Kai `StreamEvent` sequence plus the security
 * invariants (API key via env not argv, prompt via stdin, session-id wiring).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig } from '../../../config/schema.js';
import type { StreamOptions, StreamEvent } from '../types.js';
import type { ModelCatalogEntry } from '../../model-catalog.js';

// ---------------------------------------------------------------------------
// child_process mock
// ---------------------------------------------------------------------------

type SpawnCall = {
  command: string;
  args: string[];
  options: { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean; detached?: boolean };
};

const spawnState: {
  calls: SpawnCall[];
  events: object[];
  exitCode: number;
  emitErrorCode?: string;
  stdinWrites: string[];
} = { calls: [], events: [], exitCode: 0, stdinWrites: [] };

function makeFakeChild() {
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  let closed = false;
  const fireClose = () => {
    if (closed) return;
    closed = true;
    child.exitCode = spawnState.exitCode;
    for (const h of handlers['close'] ?? []) h(spawnState.exitCode);
  };

  const lines = spawnState.events.map((e) => JSON.stringify(e)).join('\n') + '\n';

  const child = {
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as string | null,
    stdin: {
      write: vi.fn((c: string) => spawnState.stdinWrites.push(String(c))),
      end: vi.fn(),
      on: vi.fn(),
    },
    stderr: { on: vi.fn() },
    stdout: {
      [Symbol.asyncIterator]() {
        let done = false;
        return {
          async next() {
            if (!done) {
              done = true;
              return { value: Buffer.from(lines, 'utf8'), done: false };
            }
            fireClose(); // exhausted → process exits
            return { value: undefined, done: true };
          },
          async return() {
            fireClose(); // for-await broke early (e.g. abort)
            return { value: undefined, done: true };
          },
        };
      },
    },
    on: vi.fn((ev: string, h: (...a: unknown[]) => void) => {
      (handlers[ev] ||= []).push(h);
      // Surface a spawn error (e.g. ENOENT) once a handler attaches.
      if (ev === 'error' && spawnState.emitErrorCode) {
        const err = new Error('spawn pi') as NodeJS.ErrnoException;
        err.code = spawnState.emitErrorCode;
        queueMicrotask(() => h(err));
      }
      return child;
    }),
    kill: vi.fn(() => {
      child.exitCode = 0;
    }),
  };
  return child;
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn((command: string, args: string[], options: SpawnCall['options']) => {
    spawnState.calls.push({ command, args, options });
    return makeFakeChild();
  }),
}));

vi.mock('../detect.js', () => ({
  detectPiCli: vi.fn(async () => true),
  resolvePiCliPath: vi.fn(async () => '/usr/local/bin/pi'),
}));

vi.mock('../../../utils/shell-env.js', () => ({
  getResolvedProcessEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
}));

const { PiRuntime } = await import('../pi-runtime.js');
const detect = await import('../detect.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function anthropicModel(): ModelCatalogEntry {
  return {
    key: 'k',
    displayName: 'Claude Sonnet',
    modelConfig: {
      provider: 'anthropic',
      endpoint: '', // first-party default
      apiKey: 'sk-ant-not-real',
      modelName: 'claude-sonnet-4',
    },
  } as unknown as ModelCatalogEntry;
}

function customEndpointModel(): ModelCatalogEntry {
  return {
    key: 'k',
    displayName: 'Internal GPT',
    modelConfig: {
      provider: 'openai-compatible',
      endpoint: 'https://llm-gateway.internal.example.com/v1',
      apiKey: 'gw-not-real',
      modelName: 'gpt-5',
    },
  } as unknown as ModelCatalogEntry;
}

function makeConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return {
    agent: { runtime: 'pi', ...overrides },
    models: { defaultModelKey: 'k', providers: {}, catalog: [] },
    systemPrompt: '',
    systemPrompts: {},
  } as unknown as AppConfig;
}

function makeOptions(overrides: Partial<StreamOptions> = {}): StreamOptions {
  return {
    conversationId: 'conv-1',
    messages: [{ role: 'user', content: 'List the files.' }],
    config: makeConfig(),
    tools: [],
    appHome: '/tmp/kai-test',
    primaryModel: anthropicModel(),
    ...overrides,
  } as StreamOptions;
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

beforeEach(() => {
  spawnState.calls = [];
  spawnState.events = [];
  spawnState.exitCode = 0;
  spawnState.emitErrorCode = undefined;
  spawnState.stdinWrites = [];
  (detect.detectPiCli as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  (detect.resolvePiCliPath as ReturnType<typeof vi.fn>).mockResolvedValue('/usr/local/bin/pi');
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PiRuntime', () => {
  describe('isAvailable', () => {
    it('reflects detectPiCli', async () => {
      const rt = new PiRuntime();
      await expect(rt.isAvailable()).resolves.toBe(true);
    });
  });

  describe('stream — event translation', () => {
    it('translates text_delta + tool_execution_* into Kai events ending in done', async () => {
      spawnState.events = [
        { type: 'header', sessionId: 'ignored' },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Listing…' } },
        { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } },
        { type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: 'a.txt\nb.txt', isError: false },
        { type: 'agent_end' },
      ];

      const events = await collect(new PiRuntime().stream(makeOptions()));

      expect(events.some((e) => e.type === 'text-delta' && (e.text ?? '').includes('Listing'))).toBe(true);
      const call = events.find((e) => e.type === 'tool-call');
      expect(call?.toolName).toBe('bash');
      const result = events.find((e) => e.type === 'tool-result');
      expect(result?.result).toBe('a.txt\nb.txt');
      expect(events[events.length - 1].type).toBe('done');
    });

    it('prefixes errored tool results with "Error:"', async () => {
      spawnState.events = [
        { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: {} },
        { type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: 'boom', isError: true },
        { type: 'agent_end' },
      ];
      const events = await collect(new PiRuntime().stream(makeOptions()));
      const result = events.find((e) => e.type === 'tool-result');
      expect(result?.result).toBe('Error: boom');
    });
  });

  describe('session id', () => {
    it('generates a session id, passes it via --session-id, and emits it as enrichment', async () => {
      spawnState.events = [{ type: 'agent_end' }];
      const events = await collect(new PiRuntime().stream(makeOptions()));

      const enrichment = events.find((e) => e.type === 'enrichment');
      const piSessionId = (enrichment?.data as { piSessionId?: string })?.piSessionId;
      expect(piSessionId).toBeTruthy();

      const args = spawnState.calls[0].args;
      const idx = args.indexOf('--session-id');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe(piSessionId);
      // Must not conflict with these resume flags.
      expect(args).not.toContain('--continue');
      expect(args).not.toContain('--resume');
      expect(args).not.toContain('--session');
      expect(args).not.toContain('--fork');
    });

    it('reuses an existing piSessionId from conversation metadata', async () => {
      spawnState.events = [{ type: 'agent_end' }];
      const events = await collect(
        new PiRuntime().stream(makeOptions({ conversationMetadata: { piSessionId: 'prev-session-1' } })),
      );
      const enrichment = events.find((e) => e.type === 'enrichment');
      expect((enrichment?.data as { piSessionId?: string })?.piSessionId).toBe('prev-session-1');
      const args = spawnState.calls[0].args;
      expect(args[args.indexOf('--session-id') + 1]).toBe('prev-session-1');
    });
  });

  describe('security invariants', () => {
    it('passes the API key via the provider env var, never on argv', async () => {
      spawnState.events = [{ type: 'agent_end' }];
      await collect(new PiRuntime().stream(makeOptions()));

      const { args, options } = spawnState.calls[0];
      expect(args).not.toContain('--api-key');
      expect(args.join(' ')).not.toContain('sk-ant-not-real');
      expect(options.env?.ANTHROPIC_API_KEY).toBe('sk-ant-not-real');
      // Mapped model args present.
      expect(args).toContain('--provider');
      expect(args[args.indexOf('--provider') + 1]).toBe('anthropic');
      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe('anthropic/claude-sonnet-4');
    });

    it('delivers the prompt via stdin, not argv', async () => {
      spawnState.events = [{ type: 'agent_end' }];
      await collect(new PiRuntime().stream(makeOptions()));

      expect(spawnState.stdinWrites.join('')).toContain('List the files.');
      expect(spawnState.calls[0].args.join(' ')).not.toContain('List the files.');
      expect(spawnState.calls[0].options.shell).toBe(false);
    });

    it('spawns --mode json in a detached process group with the resolved cwd', async () => {
      spawnState.events = [{ type: 'agent_end' }];
      await collect(new PiRuntime().stream(makeOptions({ cwd: '/work/repo' })));
      const { command, args, options } = spawnState.calls[0];
      expect(command).toBe('/usr/local/bin/pi');
      expect(args.slice(0, 2)).toEqual(['--mode', 'json']);
      expect(options.cwd).toBe('/work/repo');
      if (process.platform !== 'win32') expect(options.detached).toBe(true);
    });
  });

  describe('approval → tool scoping', () => {
    it('full-auto (default) passes no exclusions', async () => {
      spawnState.events = [{ type: 'agent_end' }];
      await collect(new PiRuntime().stream(makeOptions()));
      expect(spawnState.calls[0].args).not.toContain('--exclude-tools');
    });

    it('auto-edit excludes bash; suggest excludes bash,edit,write', async () => {
      spawnState.events = [{ type: 'agent_end' }];
      await collect(new PiRuntime().stream(makeOptions({ config: makeConfig({ piSdk: { approval: 'auto-edit' } }) })));
      let args = spawnState.calls[0].args;
      expect(args[args.indexOf('--exclude-tools') + 1]).toBe('bash');

      spawnState.calls = [];
      await collect(new PiRuntime().stream(makeOptions({ config: makeConfig({ piSdk: { approval: 'suggest' } }) })));
      args = spawnState.calls[0].args;
      expect(args[args.indexOf('--exclude-tools') + 1]).toBe('bash,edit,write');
    });
  });

  describe('model mapping fallback', () => {
    it('emits a note and passes no model/key for an unmappable custom endpoint', async () => {
      spawnState.events = [{ type: 'agent_end' }];
      const events = await collect(new PiRuntime().stream(makeOptions({ primaryModel: customEndpointModel() })));

      expect(events.some((e) => e.type === 'text-delta' && (e.text ?? '').includes("pi can't target"))).toBe(true);
      const { args, options } = spawnState.calls[0];
      expect(args).not.toContain('--provider');
      expect(args).not.toContain('--model');
      expect(options.env?.OPENAI_API_KEY).toBeUndefined();
    });
  });

  describe('not installed', () => {
    it('yields an install hint + done when pi is not on PATH', async () => {
      (detect.resolvePiCliPath as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      const events = await collect(new PiRuntime().stream(makeOptions()));
      expect(events[0].type).toBe('text-delta');
      expect(events[0].text).toContain('npm i -g @earendil-works/pi-coding-agent');
      expect(events[events.length - 1].type).toBe('done');
      expect(spawnState.calls.length).toBe(0);
    });
  });

  describe('process failure', () => {
    it('surfaces an ENOENT spawn error then done', async () => {
      spawnState.events = [];
      spawnState.emitErrorCode = 'ENOENT';
      const events = await collect(new PiRuntime().stream(makeOptions()));
      expect(events.some((e) => e.type === 'error' && (e.error ?? '').includes('could not be launched'))).toBe(true);
      expect(events[events.length - 1].type).toBe('done');
    });

    it('surfaces a non-zero exit code as an error', async () => {
      spawnState.events = [];
      spawnState.exitCode = 2;
      const events = await collect(new PiRuntime().stream(makeOptions()));
      expect(events.some((e) => e.type === 'error')).toBe(true);
    });
  });
});
