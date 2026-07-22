/**
 * JSON-safe value encoding shared by the main-process plugin host and the
 * utility-process runtime. Electron's structured clone handles many of these
 * values natively, but the synchronous compatibility channel is framed JSON,
 * so both transports intentionally use one representation.
 */
const MARKER = '__kaiPluginWire';
const INTERNAL_MARKER = Symbol('kaiPluginWireMarker');

export type ZodWireCodec = {
  toJSONSchema: (schema: unknown) => unknown;
  fromJSONSchema: (schema: unknown) => unknown;
};

let zodWireCodec: ZodWireCodec | null = null;

/** Install the optional schema codec before transporting a Zod value. */
export function installZodWireCodec(codec: ZodWireCodec): void {
  zodWireCodec = codec;
}

export function isZodWireCodecLoaded(): boolean {
  return zodWireCodec !== null;
}

export function zodSchemaToJsonSchema(schema: unknown): unknown {
  const selfDescribing = schema as {
    toJSONSchema?: (options?: { io?: 'input' | 'output'; unrepresentable?: 'throw' | 'any' }) => unknown;
  };
  if (typeof selfDescribing?.toJSONSchema === 'function') {
    return selfDescribing.toJSONSchema({ io: 'input', unrepresentable: 'any' });
  }
  if (zodWireCodec) return zodWireCodec.toJSONSchema(schema);
  throw new Error('Zod schema transport is unavailable because the schema has no JSON Schema converter');
}

function jsonSchemaToZod(schema: unknown): unknown {
  if (!zodWireCodec) {
    throw new Error('Zod schema transport is unavailable because the optional codec was not loaded');
  }
  return zodWireCodec.fromJSONSchema(schema);
}

type Marker = {
  [MARKER]: string;
  [key: string]: unknown;
};

export type WireEncodeOptions = {
  registerFunction?: (
    fn: (...args: unknown[]) => unknown,
  ) => string | { id: string; async?: boolean; stream?: boolean };
  registerAbortSignal?: (signal: AbortSignal) => string;
};

export type WireDecodeOptions = {
  callFunction?: (id: string, args: unknown[], isAsync: boolean, isStream: boolean) => unknown;
  /** Called with each function stub the decoder creates, paired with its wire
   *  id. Lets the caller track the stub's lifetime (e.g. a FinalizationRegistry
   *  that releases the remote callback once every stub for the id is collected). */
  onFunctionStub?: (id: string, stub: (...args: unknown[]) => unknown) => void;
  resolveAbortSignal?: (id: string, aborted: boolean, reason: unknown) => AbortSignal;
};

function marker(kind: string, values: Record<string, unknown> = {}): Marker {
  const result = { [MARKER]: kind, ...values } as Marker;
  Object.defineProperty(result, INTERNAL_MARKER, { value: true });
  return result;
}

/** Detect whether an already-encoded payload needs the optional JSON-Schema →
 * Zod decoder. Plugin hosts use this before decoding inbound values so the
 * relatively heavy codec is loaded only when a schema actually crosses toward
 * the plugin, rather than for every plugin allowed to register tools. */
export function wireValueContainsZodSchema(value: unknown): boolean {
  const seen = new WeakSet<object>();

  const visit = (current: unknown, depth: number): boolean => {
    if (depth > 100 || current === null || typeof current !== 'object') return false;
    if (seen.has(current)) return false;
    seen.add(current);
    if (Array.isArray(current)) return current.some((entry) => visit(entry, depth + 1));
    const candidate = current as Marker;
    const kind = candidate[MARKER];
    if (kind === 'zod-schema') return true;
    if (kind === 'escaped-object') {
      const escaped = candidate.value;
      return (
        !!escaped &&
        typeof escaped === 'object' &&
        !Array.isArray(escaped) &&
        Object.values(escaped).some((entry) => visit(entry, depth + 1))
      );
    }
    return Object.entries(current).some(([key, entry]) => key !== MARKER && visit(entry, depth + 1));
  };

  return visit(value, 0);
}

function assignOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export function createFunctionRef(id: string, isAsync = false, isStream = false): unknown {
  return marker('function', { id, async: isAsync, stream: isStream });
}

export function encodeWire(value: unknown, options: WireEncodeOptions = {}): unknown {
  const seen = new WeakSet<object>();

  const visit = (current: unknown, depth: number): unknown => {
    if (depth > 100) throw new Error('Plugin IPC value exceeded the maximum nesting depth');
    if (current === undefined) return marker('undefined');
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      return Number.isFinite(current) ? current : marker('number', { value: String(current) });
    }
    if (typeof current === 'bigint') return marker('bigint', { value: current.toString() });
    if (typeof current === 'function') {
      if (!options.registerFunction) throw new Error('Plugin IPC cannot encode a function in this context');
      const registration = options.registerFunction(current as (...args: unknown[]) => unknown);
      return typeof registration === 'string'
        ? createFunctionRef(registration)
        : createFunctionRef(registration.id, registration.async === true, registration.stream === true);
    }
    if (typeof current === 'symbol') throw new Error('Plugin IPC cannot encode symbol values');
    if (typeof current !== 'object') return current;

    // Preserve only markers created by this module. A plugin-owned object is
    // allowed to use the same property name and must round-trip as data rather
    // than being interpreted as a protocol command.
    if ((current as { [INTERNAL_MARKER]?: boolean })[INTERNAL_MARKER] === true) return current;

    if (typeof AbortSignal !== 'undefined' && current instanceof AbortSignal) {
      if (!options.registerAbortSignal) {
        return marker('abort-signal', {
          id: '',
          aborted: current.aborted,
          reason: visit(current.reason, depth + 1),
        });
      }
      return marker('abort-signal', {
        id: options.registerAbortSignal(current),
        aborted: current.aborted,
        reason: visit(current.reason, depth + 1),
      });
    }
    if (current instanceof Date) return marker('date', { value: current.toISOString() });
    if (current instanceof URL) return marker('url', { value: current.toString() });
    if (current instanceof RegExp) return marker('regexp', { source: current.source, flags: current.flags });
    if (current instanceof Error) {
      return marker('error', {
        name: current.name,
        message: current.message,
        stack: current.stack,
        cause: visit(current.cause, depth + 1),
      });
    }
    if (typeof (current as { safeParse?: unknown }).safeParse === 'function') {
      try {
        return marker('zod-schema', {
          schema: visit(zodSchemaToJsonSchema(current), depth + 1),
        });
      } catch (error) {
        throw new Error('Plugin IPC could not convert a Zod schema to JSON Schema', { cause: error });
      }
    }
    if (Buffer.isBuffer(current)) return marker('bytes', { value: current.toString('base64') });
    if (current instanceof ArrayBuffer) {
      return marker('bytes', { value: Buffer.from(current).toString('base64') });
    }
    if (ArrayBuffer.isView(current)) {
      return marker('bytes', {
        value: Buffer.from(current.buffer, current.byteOffset, current.byteLength).toString('base64'),
      });
    }

    if (seen.has(current)) throw new Error('Plugin IPC cannot encode cyclic values');
    seen.add(current);
    try {
      if (Array.isArray(current)) return current.map((entry) => visit(entry, depth + 1));
      if (current instanceof Map) {
        return marker('map', {
          entries: [...current.entries()].map(([key, entry]) => [visit(key, depth + 1), visit(entry, depth + 1)]),
        });
      }
      if (current instanceof Set) {
        return marker('set', { values: [...current.values()].map((entry) => visit(entry, depth + 1)) });
      }

      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(current)) {
        assignOwn(result, key, visit(entry, depth + 1));
      }
      return Object.prototype.hasOwnProperty.call(current, MARKER)
        ? marker('escaped-object', { value: result })
        : result;
    } finally {
      seen.delete(current);
    }
  };

  return visit(value, 0);
}

export function decodeWire(value: unknown, options: WireDecodeOptions = {}): unknown {
  const visit = (current: unknown, depth: number): unknown => {
    if (depth > 100) throw new Error('Plugin IPC value exceeded the maximum nesting depth');
    if (current === null || typeof current !== 'object') return current;
    if (Array.isArray(current)) return current.map((entry) => visit(entry, depth + 1));

    const candidate = current as Marker;
    const kind = candidate[MARKER];
    if (typeof kind === 'string') {
      switch (kind) {
        case 'undefined':
          return undefined;
        case 'number':
          if (candidate.value === 'NaN') return Number.NaN;
          if (candidate.value === 'Infinity') return Number.POSITIVE_INFINITY;
          if (candidate.value === '-Infinity') return Number.NEGATIVE_INFINITY;
          return Number(candidate.value);
        case 'bigint':
          return BigInt(String(candidate.value));
        case 'date':
          return new Date(String(candidate.value));
        case 'url':
          return new URL(String(candidate.value));
        case 'regexp':
          return new RegExp(String(candidate.source), String(candidate.flags ?? ''));
        case 'zod-schema':
          return jsonSchemaToZod(visit(candidate.schema, depth + 1));
        case 'bytes':
          return Buffer.from(String(candidate.value ?? ''), 'base64');
        case 'error': {
          const error = new Error(String(candidate.message ?? 'Plugin process error'), {
            cause: visit(candidate.cause, depth + 1),
          });
          error.name = String(candidate.name ?? 'Error');
          if (typeof candidate.stack === 'string') error.stack = candidate.stack;
          return error;
        }
        case 'escaped-object': {
          const encoded = candidate.value;
          if (!encoded || typeof encoded !== 'object' || Array.isArray(encoded)) {
            throw new Error('Plugin IPC received an invalid escaped object');
          }
          const result: Record<string, unknown> = {};
          for (const [key, entry] of Object.entries(encoded)) {
            assignOwn(result, key, visit(entry, depth + 1));
          }
          return result;
        }
        case 'map':
          return new Map(
            Array.isArray(candidate.entries)
              ? candidate.entries.map((entry) => {
                  const pair = entry as unknown[];
                  return [visit(pair[0], depth + 1), visit(pair[1], depth + 1)];
                })
              : [],
          );
        case 'set':
          return new Set(
            Array.isArray(candidate.values) ? candidate.values.map((entry) => visit(entry, depth + 1)) : [],
          );
        case 'function': {
          if (!options.callFunction || typeof candidate.id !== 'string') {
            throw new Error('Plugin IPC received a function without a callback transport');
          }
          const fnId = candidate.id;
          const stub = (...args: unknown[]) =>
            options.callFunction!(fnId, args, candidate.async === true, candidate.stream === true);
          options.onFunctionStub?.(fnId, stub);
          return stub;
        }
        case 'abort-signal': {
          const id = typeof candidate.id === 'string' ? candidate.id : '';
          const aborted = candidate.aborted === true;
          const reason = visit(candidate.reason, depth + 1);
          if (options.resolveAbortSignal) return options.resolveAbortSignal(id, aborted, reason);
          const controller = new AbortController();
          if (aborted) controller.abort(reason);
          return controller.signal;
        }
        default:
          throw new Error(`Unknown plugin IPC marker: ${kind}`);
      }
    }

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(current)) {
      assignOwn(result, key, visit(entry, depth + 1));
    }
    return result;
  };

  return visit(value, 0);
}

export function serializeWireError(error: unknown): unknown {
  return encodeWire(error instanceof Error ? error : new Error(String(error)));
}

export function deserializeWireError(value: unknown): Error {
  const decoded = decodeWire(value);
  return decoded instanceof Error ? decoded : new Error(String(decoded));
}
