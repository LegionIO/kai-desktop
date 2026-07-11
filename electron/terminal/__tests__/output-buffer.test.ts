/**
 * Tests for the terminal output-buffer (output-buffer.ts) — the in-memory +
 * on-disk ring buffer that replays PTY/virtual-session output. Covers the
 * behaviors where a regression silently corrupts or loses replay: the MAX_LINES
 * trim, LRU in-memory eviction (flush-before-evict so data survives), the
 * memory→disk getBuffer fallback, sessionId path-traversal sanitization, and the
 * CHUNK_SEP disk round-trip.
 *
 * The module holds module-global Maps with no reset export, so each test uses a
 * unique sessionId. A real temp dir backs the disk layer.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  initOutputBuffer,
  appendOutput,
  getBuffer,
  clearBuffer,
  hasBuffer,
  listPersistedSessions,
  flushAll,
} from '../output-buffer.js';

let root: string;
let logDir: string;
let seq = 0;
const id = (label: string) => `sess-${label}-${seq++}`;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kai-obuf-'));
  initOutputBuffer(root);
  logDir = join(root, 'data', 'terminal-logs');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('appendOutput + getBuffer', () => {
  it('accumulates chunks in order', () => {
    const s = id('order');
    appendOutput(s, 'a');
    appendOutput(s, 'b');
    appendOutput(s, 'c');
    expect(getBuffer(s)).toEqual(['a', 'b', 'c']);
    clearBuffer(s);
  });

  it('trims to the most recent MAX_LINES entries', () => {
    const s = id('trim');
    for (let i = 0; i < 5100; i++) appendOutput(s, String(i));
    const buf = getBuffer(s);
    expect(buf.length).toBe(5000);
    // Oldest 100 dropped; newest retained.
    expect(buf[0]).toBe('100');
    expect(buf[buf.length - 1]).toBe('5099');
    clearBuffer(s);
  });

  it('returns an empty array for an unknown session', () => {
    expect(getBuffer(id('unknown'))).toEqual([]);
  });
});

describe('disk persistence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('flushes to disk on the debounce timer and reloads via getBuffer', () => {
    const s = id('flush');
    appendOutput(s, 'x');
    appendOutput(s, 'y');
    expect(existsSync(join(logDir, `${s}.log`))).toBe(false); // debounced, not yet
    vi.advanceTimersByTime(2000);
    expect(existsSync(join(logDir, `${s}.log`))).toBe(true);

    // Drop from memory (simulate: clear only in-memory would need internal access,
    // so instead assert the disk round-trip via a fresh session file below).
    clearBuffer(s);
  });

  it('round-trips through CHUNK_SEP: getBuffer loads a disk-only session', () => {
    const s = id('diskonly');
    // Write a log file directly using the same NUL separator the module uses.
    writeFileSync(join(logDir, `${s}.log`), ['one', 'two', 'three'].join('\x00'), 'utf-8');
    expect(getBuffer(s)).toEqual(['one', 'two', 'three']);
    clearBuffer(s);
  });

  it('filters empty entries when loading from disk', () => {
    const s = id('empties');
    writeFileSync(join(logDir, `${s}.log`), ['a', '', 'b', ''].join('\x00'), 'utf-8');
    expect(getBuffer(s)).toEqual(['a', 'b']);
    clearBuffer(s);
  });
});

describe('hasBuffer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is true for in-memory content and false after clear', () => {
    const s = id('has');
    expect(hasBuffer(s)).toBe(false);
    appendOutput(s, 'z');
    expect(hasBuffer(s)).toBe(true);
    vi.advanceTimersByTime(2000); // flush to disk
    clearBuffer(s);
    expect(hasBuffer(s)).toBe(false); // memory + disk both gone
  });

  it('is true for a disk-only session with no in-memory buffer', () => {
    const s = id('hasdisk');
    writeFileSync(join(logDir, `${s}.log`), 'chunk', 'utf-8');
    expect(hasBuffer(s)).toBe(true);
    clearBuffer(s);
  });
});

describe('clearBuffer', () => {
  it('removes both the in-memory buffer and the disk log', () => {
    const s = id('clear');
    writeFileSync(join(logDir, `${s}.log`), 'data', 'utf-8');
    appendOutput(s, 'mem');
    clearBuffer(s);
    expect(getBuffer(s)).toEqual([]);
    expect(existsSync(join(logDir, `${s}.log`))).toBe(false);
  });
});

describe('listPersistedSessions', () => {
  it('lists session ids from .log files with the extension stripped', () => {
    const s = id('listed');
    writeFileSync(join(logDir, `${s}.log`), 'x', 'utf-8');
    // A non-.log file must be ignored.
    writeFileSync(join(logDir, `${s}.txt`), 'x', 'utf-8');
    const listed = listPersistedSessions();
    expect(listed).toContain(s);
    expect(listed).not.toContain(`${s}.log`);
    expect(listed).not.toContain(`${s}.txt`);
    clearBuffer(s);
  });
});

describe('path-traversal sanitization', () => {
  it('collapses traversal / unsafe chars in the sessionId to underscores', () => {
    const evil = '../../etc/passwd';
    appendOutput(evil, 'pwned');
    flushAll(); // synchronous flush regardless of timers
    // No file escaped the log dir.
    expect(existsSync(join(root, 'etc', 'passwd'))).toBe(false);
    // The sanitized name lives inside the log dir; every unsafe char became '_'.
    const files = readdirSync(logDir).filter((f) => f.includes('passwd'));
    expect(files.length).toBe(1);
    expect(files[0]).toBe('______etc_passwd.log');
    expect(files[0]).not.toContain('/');
    expect(files[0]).not.toContain('..'); // no traversal sequence survived
    clearBuffer(evil);
  });
});

describe('flushAll', () => {
  it('writes every in-memory buffer to disk synchronously', () => {
    const a = id('flushall-a');
    const b = id('flushall-b');
    appendOutput(a, '1');
    appendOutput(b, '2');
    flushAll();
    expect(existsSync(join(logDir, `${a}.log`))).toBe(true);
    expect(existsSync(join(logDir, `${b}.log`))).toBe(true);
    clearBuffer(a);
    clearBuffer(b);
  });
});

describe('LRU in-memory eviction', () => {
  it('evicts the oldest in-memory session past the cap but preserves its data on disk', () => {
    // MAX_IN_MEMORY_SESSIONS = 64. Create 65 sessions; the first should be
    // evicted from memory but flushed to disk, so getBuffer reloads it intact.
    const first = id('lru-first');
    appendOutput(first, 'first-data');
    const rest: string[] = [];
    for (let i = 0; i < 64; i++) {
      const s = id(`lru-${i}`);
      rest.push(s);
      appendOutput(s, `d${i}`);
    }
    // The first session was evicted from memory on the 65th session's creation,
    // but flushed to disk first — so it must reload with its content intact.
    expect(existsSync(join(logDir, `${first}.log`))).toBe(true);
    expect(getBuffer(first)).toEqual(['first-data']);
    clearBuffer(first);
    for (const s of rest) clearBuffer(s);
  });
});
