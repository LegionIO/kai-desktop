import type { LLMModelConfig } from '../model-catalog.js';

/**
 * Moonshot AI (Kimi models) is configured as a generic 'openai-compatible'
 * provider, so `LLMModelConfig.provider` alone can't identify it — the
 * user-chosen provider key (e.g. "moonshot") is discarded during catalog
 * resolution. Detect it from the endpoint host or the `kimi-*` model name
 * instead, so its quirks can be patched automatically regardless of what the
 * user named the provider entry.
 */
export function isMoonshotModel(modelConfig: Pick<LLMModelConfig, 'provider' | 'endpoint' | 'modelName'>): boolean {
  if (modelConfig.provider !== 'openai-compatible') return false;
  const endpoint = modelConfig.endpoint?.toLowerCase() ?? '';
  if (endpoint.includes('moonshot.ai') || endpoint.includes('moonshot.cn')) return true;
  return /^kimi(-|$)/i.test(modelConfig.modelName ?? '');
}

/** Top-level keys across a set of anyOf/oneOf branch schemas. */
function collectBranchKeys(branches: unknown[]): Set<string> {
  const keys = new Set<string>();
  for (const branch of branches) {
    if (branch && typeof branch === 'object' && !Array.isArray(branch)) {
      for (const k of Object.keys(branch as Record<string, unknown>)) keys.add(k);
    }
  }
  return keys;
}

/**
 * Moonshot's tool-schema validator rejects a schema where ANY keyword —
 * `pattern`, `default`, whatever the generator produced — is declared BOTH
 * on a parent object and inside one of its `anyOf`/`oneOf` branches:
 *
 *   "conflicting keywords found in anyOf with parent: keywords (pattern) are
 *    defined on the parent schema and inside anyOf; remove them from the
 *    parent or from anyOf branches"
 *
 * Kai's zod -> JSON Schema generator can legitimately produce this shape for
 * an optional/nullable/union field (e.g. `.optional().default(false)`
 * duplicates `default` on both the parent and each branch). Rather than
 * enumerating specific keyword names — which just turns into whack-a-mole as
 * new ones surface — strip any parent key that's also a key on at least one
 * branch, keeping the (equally valid) branch-level copy. Keys unique to the
 * parent are left untouched.
 */
export function sanitizeMoonshotSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeMoonshotSchema);
  if (!schema || typeof schema !== 'object') return schema;

  const node = { ...(schema as Record<string, unknown>) };

  for (const key of ['properties', 'patternProperties', 'definitions', '$defs'] as const) {
    const value = node[key];
    if (value && typeof value === 'object') {
      node[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeMoonshotSchema(v)]),
      );
    }
  }
  for (const key of ['items', 'additionalProperties', 'not'] as const) {
    if (node[key] && typeof node[key] === 'object') node[key] = sanitizeMoonshotSchema(node[key]);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(node[key])) node[key] = (node[key] as unknown[]).map(sanitizeMoonshotSchema);
  }

  // Moonshot/Kimi's validator rejects a schema when a keyword sits on BOTH the
  // parent node AND inside an anyOf/oneOf branch. Strip the parent copy — but
  // FIRST propagate it into every branch that lacks the key, so a constraint the
  // parent applied to ALL branches isn't lost on the branches that didn't repeat
  // it (e.g. parent maxLength:10 duplicated in only one of two string branches).
  const anyOf = Array.isArray(node.anyOf) ? (node.anyOf as unknown[]) : null;
  const oneOf = Array.isArray(node.oneOf) ? (node.oneOf as unknown[]) : null;
  const branchArrays = [anyOf, oneOf].filter((b): b is unknown[] => b !== null);
  const branches = branchArrays.flat();
  if (branches.length > 0) {
    const branchKeys = collectBranchKeys(branches);
    const conflicting = Object.keys(node).filter(
      (key) => key !== 'anyOf' && key !== 'oneOf' && key !== 'allOf' && branchKeys.has(key),
    );
    if (conflicting.length > 0) {
      // Rewrite each branch, merging the parent's copy of every conflicting key
      // in. Scalars (default/pattern/maxLength): seed only where the branch
      // lacks the key. Objects (e.g. `properties`): shallow-union so a
      // parent-wide constraint isn't dropped on a branch with a partial copy
      // (branch wins per-key). Arrays: only `required` is a set we can safely
      // union — `type`/`enum`/tuple `items` are NARROWED by a branch on purpose,
      // so unioning them back would widen the contract; for those, seed-if-absent.
      const UNIONABLE_ARRAY_KEYS = new Set(['required']);
      const mergeInto = (branch: Record<string, unknown>, key: string): void => {
        const parentVal = node[key];
        const branchVal = branch[key];
        if (!(key in branch)) {
          branch[key] = parentVal;
          return;
        }
        if (
          parentVal &&
          typeof parentVal === 'object' &&
          !Array.isArray(parentVal) &&
          branchVal &&
          typeof branchVal === 'object' &&
          !Array.isArray(branchVal)
        ) {
          branch[key] = { ...(parentVal as Record<string, unknown>), ...(branchVal as Record<string, unknown>) };
          return;
        }
        if (UNIONABLE_ARRAY_KEYS.has(key) && Array.isArray(parentVal) && Array.isArray(branchVal)) {
          branch[key] = Array.from(new Set([...parentVal, ...branchVal]));
          return;
        }
        // Scalar, non-unionable array (type/enum/items), or type mismatch: the
        // branch's own value is authoritative — it intentionally narrowed the parent.
      };
      const seed = (arr: unknown[]): unknown[] =>
        arr.map((b) => {
          if (!b || typeof b !== 'object' || Array.isArray(b)) return b;
          const branch = { ...(b as Record<string, unknown>) };
          for (const key of conflicting) mergeInto(branch, key);
          return branch;
        });
      if (anyOf) node.anyOf = seed(anyOf);
      if (oneOf) node.oneOf = seed(oneOf);
      for (const key of conflicting) delete node[key];
    }
  }

  return node;
}

function sanitizeMoonshotToolsInBody(parsed: Record<string, unknown>): boolean {
  if (!Array.isArray(parsed.tools)) return false;
  let touched = false;
  parsed.tools = (parsed.tools as unknown[]).map((tool) => {
    if (!tool || typeof tool !== 'object') return tool;
    const t = { ...(tool as Record<string, unknown>) };
    // Chat Completions nests under `function`; the Responses API surface is flat.
    const target = t.function && typeof t.function === 'object' ? { ...(t.function as Record<string, unknown>) } : t;
    if (target.parameters && typeof target.parameters === 'object') {
      target.parameters = sanitizeMoonshotSchema(target.parameters);
      touched = true;
    }
    if (t.function) t.function = target;
    return t;
  });
  return touched;
}

/**
 * Fetch wrapper applying Moonshot/Kimi-specific request-body compatibility
 * fixes ahead of time, rather than reactively retrying after a 400:
 *  - sanitizes tool JSON schemas that trip Moonshot's stricter anyOf/parent
 *    keyword validator (see `sanitizeMoonshotSchema`).
 *  - omits an explicit `temperature` unless it's exactly 1 — Moonshot's API
 *    rejects any other value ("invalid temperature: only 1 is allowed for
 *    this model"), so any other configured temperature (global, profile, or
 *    thread override) is dropped in favor of the model's own default.
 */
export function createMoonshotCompatFetch(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body !== 'string') return inner(input, init);

    try {
      const parsed = JSON.parse(init.body) as Record<string, unknown>;
      let patched = sanitizeMoonshotToolsInBody(parsed);

      if (typeof parsed.temperature === 'number' && parsed.temperature !== 1) {
        delete parsed.temperature;
        patched = true;
      }

      if (!patched) return inner(input, init);

      return inner(input, {
        ...init,
        body: JSON.stringify(parsed),
      });
    } catch {
      return inner(input, init);
    }
  };
}
