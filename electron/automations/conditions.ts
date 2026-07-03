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
      try {
        const re = new RegExp(String(value ?? ''), caseSensitive ? '' : 'i');
        return { ok: re.test(typeof actual === 'string' ? actual : safeStringify(actual)) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
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
  const results = conditions.map((c) => {
    const r = evaluateCondition(c, payload);
    if (r.error) errors.push(r.error);
    return r.ok;
  });
  const ok = mode === 'any' ? results.some(Boolean) : results.every(Boolean);
  return { ok, errors };
}
