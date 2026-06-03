/**
 * Integration test for the pi runtime — REAL subprocess, no child_process mock.
 *
 * Drives the real `PiRuntime.stream()` against a fake `pi` shim
 * (`__tests__/fixtures/fake-pi.mjs`) so we exercise the genuine spawn / stdin /
 * stdout / exit / process-group-kill paths that the unit test (which mocks
 * `child_process`) cannot. The shim is deterministic and needs no LLM.
 *
 * Only the two module boundaries that would otherwise reach the real machine
 * are stubbed:
 *   - `../detect.js`            → point `resolvePiCliPath` at the shim
 *   - `../../../utils/shell-env.js` → pass real `process.env` through so the
 *                                     shim inherits PATH (to find `node`) and
 *                                     the PI_FAKE_* control vars.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AppConfig } from '../../config/schema.js';
import type { StreamOptions, StreamEvent } from './types.js';
import type { ModelCatalogEntry } from '../model-catalog.js';

const SHIM = resolve(process.cwd(), 'electron/agent/runtime/__tests__/fixtures/fake-pi.mjs');

vi.mock('./detect.js', () => ({
  detectPiCli: vi.fn(async () => true),
  resolvePiCliPath: vi.fn(async () => SHIM),
}));

// Pass the real env through so the shim inherits PATH + the PI_FAKE_* vars.
vi.mock('../../utils/shell-env.js', () => ({
  getResolvedProcessEnv: vi.fn(() => ({ ...process.env })),
}));

const { PiRuntime } = await import('./pi-runtime.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmp: string;

function anthropicModel(): ModelCatalogEntry {
  return {
    key: 'k',
    displayName: 'Claude Sonnet',
    modelConfig: { provider: 'anthropic', endpoint: '', apiKey: 'sk-ant-not-real', modelName: 'claude-sonnet-4' },
  } as unknown as ModelCatalogEntry;
}

function makeOptions(overrides: Partial<StreamOptions> = {}): StreamOptions {
  return {
    conversationId: 'conv-1',
    messages: [{ role: 'user', content: 'List the files.' }],
    config: { agent: { runtime: 'pi' }, models: { providers: {}, catalog: [] } } as unknown as AppConfig,
    tools: [],
    appHome: tmp,
    primaryModel: anthropicModel(),
    ...overrides,
  } as StreamOptions;
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kai-pi-itest-'));
});

afterEach(() => {
  delete process.env.PI_FAKE_MODE;
  delete process.env.PI_FAKE_RECORD;
  delete process.env.PI_FAKE_PIDFILE;
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PiRuntime (integration — real subprocess)', () => {
  it('spawns the real pi binary and streams a full turn ending in done', async () => {
    process.env.PI_FAKE_MODE = 'normal';
    const events = await collect(new PiRuntime().stream(makeOptions()));

    const text = events
      .filter((e) => e.type === 'text-delta')
      .map((e) => e.text)
      .join('');
    expect(text).toContain('Hello from fake pi.');

    expect(events.find((e) => e.type === 'tool-call')?.toolName).toBe('bash');
    expect(events.find((e) => e.type === 'tool-result')?.result).toBe('a.txt\nb.txt');

    const usage = events.find((e) => e.type === 'context-usage');
    expect((usage?.data as { totalTokens?: number } | undefined)?.totalTokens).toBe(19);

    expect(events.some((e) => e.type === 'enrichment')).toBe(true);
    expect(events[events.length - 1].type).toBe('done');
  });

  it('passes the API key via env (not argv) and the prompt via stdin — verified on a real spawn', async () => {
    const record = join(tmp, 'record.json');
    process.env.PI_FAKE_MODE = 'normal';
    process.env.PI_FAKE_RECORD = record;

    await collect(new PiRuntime().stream(makeOptions()));

    expect(existsSync(record)).toBe(true);
    const rec = JSON.parse(readFileSync(record, 'utf8')) as {
      argv: string[];
      stdin: string;
      hasAnthropicKey: boolean;
    };

    expect(rec.argv).not.toContain('--api-key');
    expect(rec.argv.join(' ')).not.toContain('sk-ant-not-real');
    expect(rec.hasAnthropicKey).toBe(true); // key arrived via env
    expect(rec.stdin).toContain('List the files.'); // prompt arrived via stdin
    expect(rec.argv.slice(0, 2)).toEqual(['--mode', 'json']);
    expect(rec.argv).toContain('--session-id');
  });

  it('reuses the persisted piSessionId on the real --session-id arg', async () => {
    const record = join(tmp, 'record.json');
    process.env.PI_FAKE_MODE = 'normal';
    process.env.PI_FAKE_RECORD = record;

    await collect(new PiRuntime().stream(makeOptions({ conversationMetadata: { piSessionId: 'resume-me-1' } })));

    const rec = JSON.parse(readFileSync(record, 'utf8')) as { argv: string[] };
    expect(rec.argv[rec.argv.indexOf('--session-id') + 1]).toBe('resume-me-1');
  });

  it('surfaces a non-zero exit as an error event', async () => {
    process.env.PI_FAKE_MODE = 'fail';
    const events = await collect(new PiRuntime().stream(makeOptions()));
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events[events.length - 1].type).toBe('done');
  });

  it.skipIf(process.platform === 'win32')(
    'kills the whole process group on abort — the pi grandchild is reaped',
    async () => {
      const pidfile = join(tmp, 'grandchild.pid');
      process.env.PI_FAKE_MODE = 'hang';
      process.env.PI_FAKE_PIDFILE = pidfile;

      const ac = new AbortController();
      const collected: StreamEvent[] = [];
      const gen = new PiRuntime().stream(makeOptions({ abortSignal: ac.signal }));
      const consume = (async () => {
        for await (const e of gen) collected.push(e);
      })();

      // Wait for the shim to spawn its grandchild and record the pid.
      let pid = 0;
      for (let i = 0; i < 100 && !pid; i++) {
        if (existsSync(pidfile)) {
          const raw = readFileSync(pidfile, 'utf8').trim();
          if (raw) pid = Number(raw);
        }
        if (!pid) await sleep(50);
      }
      expect(pid).toBeGreaterThan(0);
      expect(isAlive(pid)).toBe(true);

      // Abort → runtime kills the process group (SIGTERM → SIGKILL).
      ac.abort();
      await consume;

      // The grandchild must be gone (poll briefly for the signal to land).
      let alive = true;
      for (let i = 0; i < 60 && alive; i++) {
        alive = isAlive(pid);
        if (alive) await sleep(50);
      }
      expect(alive).toBe(false);
      expect(collected[collected.length - 1]?.type).toBe('done');
    },
  );
});
