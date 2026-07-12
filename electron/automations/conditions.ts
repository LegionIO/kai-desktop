import { createContext, runInContext } from 'node:vm';
import type { AutomationCondition } from '../config/schema.js';

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return String(v);
  }
}

export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const normalized = path.replace(/\[(\w+)\]/g, '.$1').replace(/^\./, '');
  let cur: unknown = obj;
  for (const seg of normalized.split('.')) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

function asComparableString(v: unknown, caseSensitive: boolean): string {
  const s = typeof v === 'string' ? v : v == null ? '' : safeStringify(v);
  return caseSensitive ? s : s.toLowerCase();
}

/** Hygiene caps for the `matches` regex op (defense-in-depth on top of the
 *  timeout, which is the actual ReDoS protection). */
const MAX_REGEX_SOURCE_BYTES = 2 * 1024;
const MAX_REGEX_INPUT_BYTES = 64 * 1024;
/** Wall-clock budget for a single regex test — a catastrophic-backtracking
 *  (ReDoS) pattern from a user rule against untrusted payload content must not
 *  hang the main thread. Mirrors the `expression` op's vm timeout. */
const REGEX_TEST_TIMEOUT_MS = 50;

/**
 * Run `regex.test(input)` with a hard wall-clock timeout so a ReDoS pattern
 * can't hang the Electron main thread. A plain re.test() is synchronous and
 * uninterruptible, so we execute it inside a node:vm context with a timeout —
 * the same mechanism the `expression` op already uses. `codeGeneration` is
 * disabled and the globals are the regex + input only (no realm escape).
 * Returns false on timeout, oversize input/source, or any error.
 */
function safeRegexTest(source: string, input: string, caseSensitive: boolean): ConditionEvalResult {
  if (source.length > MAX_REGEX_SOURCE_BYTES) {
    return { ok: false, error: `matches: regex source exceeds ${MAX_REGEX_SOURCE_BYTES} bytes` };
  }
  if (input.length > MAX_REGEX_INPUT_BYTES) {
    // Anchors make truncation change semantics, so reject rather than truncate.
    return { ok: false, error: `matches: input exceeds ${MAX_REGEX_INPUT_BYTES} bytes` };
  }
  let re: RegExp;
  try {
    re = new RegExp(source, caseSensitive ? '' : 'i');
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const ctx = createContext({ __re: re, __input: input }, { codeGeneration: { strings: false, wasm: false } });
    const result = runInContext('__re.test(__input)', ctx, { timeout: REGEX_TEST_TIMEOUT_MS });
    return { ok: Boolean(result) };
  } catch (err) {
    // Timeout (ReDoS) or any vm error → treat as non-match, surface the reason.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type ConditionEvalResult = { ok: boolean; error?: string };

export function evaluateCondition(cond: AutomationCondition, payload: unknown): ConditionEvalResult {
  const { op, path, value, caseSensitive } = cond;

  if (op === 'expression') {
    const src = typeof value === 'string' ? value : '';
    if (!src.trim()) return { ok: false };
    try {
      // Materialize `event` inside the VM context via JSON so its prototype
      // chain (Object/Array/Function) belongs to the VM realm, not the main
      // realm. Combined with a null-prototype global and disabled string
      // codegen, this blocks `constructor.constructor('return process')()`
      // escapes through both `this` and `event`. Defense-in-depth only:
      // automation rules are user-authored config with the same trust level as
      // MCP server commands, not a hard security boundary.
      const json = safeStringify(payload) || 'null';
      const ctx = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
      runInContext(`var event = JSON.parse(${JSON.stringify(json)});`, ctx);
      const result = runInContext(src, ctx, { timeout: 50 });
      return { ok: Boolean(result) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const actual = getPath(payload, path);

  switch (op) {
    case 'exists':
      return { ok: actual !== undefined && actual !== null };
    case 'equals':
      if (typeof actual === 'string' || typeof value === 'string') {
        return { ok: asComparableString(actual, caseSensitive) === asComparableString(value, caseSensitive) };
      }
      return { ok: actual === value };
    case 'notEquals': {
      const eq = evaluateCondition({ ...cond, op: 'equals' }, payload);
      return { ok: !eq.ok };
    }
    case 'contains':
      if (Array.isArray(actual)) {
        return {
          ok: actual.some(
            (item) => asComparableString(item, caseSensitive) === asComparableString(value, caseSensitive),
          ),
        };
      }
      return { ok: asComparableString(actual, caseSensitive).includes(asComparableString(value, caseSensitive)) };
    case 'startsWith':
      return { ok: asComparableString(actual, caseSensitive).startsWith(asComparableString(value, caseSensitive)) };
    case 'endsWith':
      return { ok: asComparableString(actual, caseSensitive).endsWith(asComparableString(value, caseSensitive)) };
    case 'matches':
      return safeRegexTest(
        String(value ?? ''),
        typeof actual === 'string' ? actual : safeStringify(actual),
        caseSensitive,
      );
    case 'in':
      if (!Array.isArray(value)) return { ok: false };
      return {
        ok: value.some((v) => asComparableString(v, caseSensitive) === asComparableString(actual, caseSensitive)),
      };
    default:
      return { ok: false };
  }
}

export function evaluateConditions(
  conditions: AutomationCondition[],
  mode: 'all' | 'any',
  payload: unknown,
): { ok: boolean; errors: string[] } {
  if (conditions.length === 0) return { ok: true, errors: [] };
  const errors: string[] = [];
  // Short-circuit: stop as soon as the outcome is decided (an 'all' that hits a
  // false, or an 'any' that hits a true) so a cheap early condition can avoid
  // running an expensive later one (e.g. a regex/expression) against untrusted
  // payload content — reduces amplification.
  let ok = mode === 'all';
  for (const c of conditions) {
    const r = evaluateCondition(c, payload);
    if (r.error) errors.push(r.error);
    if (mode === 'any') {
      if (r.ok) {
        ok = true;
        break;
      }
    } else if (!r.ok) {
      ok = false;
      break;
    }
  }
  return { ok, errors };
}
