import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { decodeWire, deserializeWireError, encodeWire, installZodWireCodec, serializeWireError } from '../wire.js';
import { zodWireCodec } from '../zod-wire-codec.js';

installZodWireCodec(zodWireCodec);

describe('plugin process wire encoding', () => {
  it('round-trips supported non-JSON values explicitly', () => {
    const input = {
      missing: undefined,
      big: 12345678901234567890n,
      when: new Date('2026-07-20T12:34:56.000Z'),
      url: new URL('https://example.test/path?q=1'),
      pattern: /plugin/gi,
      bytes: Buffer.from('hello'),
      map: new Map<string, number>([['a', 1]]),
      set: new Set(['x', 'y']),
      nan: Number.NaN,
    };

    const result = decodeWire(encodeWire(input)) as typeof input;
    expect(result.missing).toBeUndefined();
    expect(result.big).toBe(input.big);
    expect(result.when.toISOString()).toBe(input.when.toISOString());
    expect(result.url.toString()).toBe(input.url.toString());
    expect(result.pattern).toEqual(input.pattern);
    expect(Buffer.from(result.bytes).toString()).toBe('hello');
    expect(result.map.get('a')).toBe(1);
    expect(result.set.has('y')).toBe(true);
    expect(Number.isNaN(result.nan)).toBe(true);
  });

  it('turns functions into callback references without serializing source code', async () => {
    const original = vi.fn((value: number) => value * 2);
    const functions = new Map<string, (...args: unknown[]) => unknown>();
    const encoded = encodeWire(
      { fn: original },
      {
        registerFunction: (fn) => {
          functions.set('callback-1', fn);
          return 'callback-1';
        },
      },
    );
    const callRemote = vi.fn((id: string, args: unknown[]) => functions.get(id)?.(...args));
    const decoded = decodeWire(encoded, { callFunction: callRemote }) as { fn: (value: number) => number };

    expect(decoded.fn(21)).toBe(42);
    expect(callRemote).toHaveBeenCalledWith('callback-1', [21], false);
    expect(original).toHaveBeenCalledWith(21);
  });

  it('reports each decoded function stub with its id via onFunctionStub', () => {
    const encoded = encodeWire(
      { a: (x: number) => x, b: (y: number) => y },
      { registerFunction: (fn) => (fn.length >= 0 ? { id: `cb-${Math.random()}`, async: false } : { id: 'x' }) },
    );
    const seen: Array<{ id: string; isFn: boolean }> = [];
    const decoded = decodeWire(encoded, {
      callFunction: (id, args) => id + String(args),
      onFunctionStub: (id, stub) => seen.push({ id, isFn: typeof stub === 'function' }),
    }) as { a: unknown; b: unknown };
    // One stub reported per decoded function, each paired with a real function.
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.isFn && typeof s.id === 'string')).toBe(true);
    expect(typeof decoded.a).toBe('function');
    expect(typeof decoded.b).toBe('function');
  });

  it('preserves whether a callback uses the asynchronous transport', async () => {
    const original = async (value: number) => value + 1;
    const encoded = encodeWire(original, {
      registerFunction: () => ({ id: 'async-1', async: true }),
    });
    const callRemote = vi.fn(async (_id: string, args: unknown[], isAsync: boolean) => {
      expect(isAsync).toBe(true);
      return original(args[0] as number);
    });
    const decoded = decodeWire(encoded, { callFunction: callRemote }) as (value: number) => Promise<number>;

    await expect(decoded(41)).resolves.toBe(42);
    expect(callRemote).toHaveBeenCalledWith('async-1', [41], true);
  });

  it('reconstructs Zod schemas used in tool and inference-provider descriptors', () => {
    const schema = z.object({ value: z.string(), count: z.number().int().optional() });
    const decoded = decodeWire(encodeWire(schema)) as z.ZodType;
    expect(decoded.safeParse({ value: 'ok', count: 2 }).success).toBe(true);
    expect(decoded.safeParse({ value: 1 }).success).toBe(false);
  });

  it('preserves error name, message, stack, and cause', () => {
    const source = new TypeError('bad plugin value', { cause: new Error('root cause') });
    const result = deserializeWireError(serializeWireError(source));
    expect(result).toBeInstanceOf(Error);
    expect(result.name).toBe('TypeError');
    expect(result.message).toBe('bad plugin value');
    expect((result.cause as Error).message).toBe('root cause');
    expect(result.stack).toContain('bad plugin value');
  });

  it('rejects cyclic payloads with a bounded, actionable error', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => encodeWire(cyclic)).toThrow('cyclic');
  });

  it('round-trips plugin data that happens to use the wire marker key', () => {
    const input = { __kaiPluginWire: 'function', id: 'ordinary-plugin-data', nested: { ok: true } };
    expect(decodeWire(encodeWire(input))).toEqual(input);
  });
});
