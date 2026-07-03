import type { AutomationRule } from '../config/schema.js';
import type { SourceCatalogEntry } from './types.js';

export function flattenSchemaPaths(schema: Record<string, unknown> | undefined, prefix = ''): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const props = schema.properties;
  if (!props || typeof props !== 'object') return prefix ? [prefix] : [];

  const out: string[] = [];
  for (const [key, child] of Object.entries(props as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    out.push(path);
    if (child && typeof child === 'object') {
      const c = child as Record<string, unknown>;
      if (c.type === 'object' && c.properties) {
        out.push(...flattenSchemaPaths(c, path));
      } else if (c.type === 'array' && c.items && typeof c.items === 'object') {
        out.push(...flattenSchemaPaths(c.items as Record<string, unknown>, `${path}[0]`));
      }
    }
  }
  return out;
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function closestPath(target: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(target.toLowerCase(), c.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best && bestDist <= Math.max(2, Math.floor(target.length / 3)) ? best : undefined;
}

export function validateRulePaths(rule: AutomationRule, catalog: SourceCatalogEntry[]): string[] {
  const warnings: string[] = [];

  const source = catalog.find((c) => c.source === rule.trigger.source);
  if (!source) {
    warnings.push(
      `Trigger source "${rule.trigger.source}" is not in the event catalog. Available: ${catalog.map((c) => c.source).join(', ') || '(none)'}.`,
    );
    return warnings;
  }

  const eventDesc = source.events.find((e) => e.event === rule.trigger.event);
  if (!eventDesc) {
    warnings.push(
      `Trigger event "${rule.trigger.event}" is not declared by ${source.displayName}. Available: ${source.events.map((e) => e.event).join(', ') || '(none)'}.`,
    );
    return warnings;
  }

  for (const action of rule.actions) {
    if (action.type !== 'plugin-action') continue;
    const target = catalog.find((c) => c.source === `plugin.${action.pluginName}`);
    if (!target) {
      warnings.push(`plugin-action targets "${action.pluginName}", which has not declared any automation actions.`);
      continue;
    }
    if (!target.actions.some((a) => a.targetId === action.targetId)) {
      const declared = target.actions.map((a) => a.targetId).join(', ') || '(none)';
      warnings.push(
        `plugin-action targetId "${action.targetId}" is not declared by ${target.displayName}. Declared: ${declared}.`,
      );
    }
  }

  const paths = flattenSchemaPaths(eventDesc.payloadSchema);
  if (paths.length === 0) return warnings;

  for (const cond of rule.conditions) {
    if (cond.op === 'expression' || !cond.path) continue;
    const normalized = cond.path.replace(/\[\d+\]/g, '[0]');
    if (!paths.includes(normalized)) {
      const suggestion = closestPath(normalized, paths);
      warnings.push(
        `Condition path "${cond.path}" is not in the declared payload schema for ${rule.trigger.source}:${rule.trigger.event}.` +
          (suggestion ? ` Did you mean "${suggestion}"?` : ` Known paths: ${paths.join(', ')}.`),
      );
    }
  }

  return warnings;
}
