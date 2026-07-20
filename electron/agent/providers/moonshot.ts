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

  const branches = [
    ...(Array.isArray(node.anyOf) ? (node.anyOf as unknown[]) : []),
    ...(Array.isArray(node.oneOf) ? (node.oneOf as unknown[]) : []),
  ];
  if (branches.length > 0) {
    const branchKeys = collectBranchKeys(branches);
    for (const key of Object.keys(node)) {
      if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') continue;
      if (branchKeys.has(key)) delete node[key];
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
