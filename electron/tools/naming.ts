import type { ToolDefinition, ToolSource } from './types.js';
import { createHash } from 'crypto';

export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Maximum length for tool names registered with the Claude Agent SDK.
 * The SDK's MCP bridge prefixes tool names with `mcp__kai__` (10 chars),
 * and APIs enforce a hard 64-char limit on tool names.
 * 64 - 10 = 54 chars max for tool names we register.
 */
export const MAX_TOOL_NAME_LENGTH = 54;

function sanitizeToolSegment(value: string, fallback = 'tool'): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');

  return normalized || fallback;
}

export function isValidToolName(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name);
}

export function makeSafeToolName(name: string, fallback = 'tool'): string {
  // Even a charset-valid name can exceed the length limit (the pattern doesn't
  // constrain length), which after the SDK's `mcp__kai__` prefix blows the 64-
  // char API cap. Always enforce the length; sanitize the fallback too so a bad
  // caller-supplied fallback can't itself violate the pattern.
  const safe = isValidToolName(name) ? name : sanitizeToolSegment(name, sanitizeToolSegment(fallback, 'tool'));
  return capToolNameLength(safe);
}

export function buildScopedToolName(
  source: Extract<ToolSource, 'mcp' | 'skill' | 'plugin'>,
  scope: string,
  rawName?: string,
): string {
  if (source === 'skill') return capToolNameLength(getScopedToolPrefix(source, scope));

  const full = [
    getScopedToolPrefix(source, scope).replace(/__$/, ''),
    sanitizeToolSegment(rawName ?? 'tool', 'tool'),
  ].join('__');

  return capToolNameLength(full);
}

/**
 * Enforce the API tool-name length limit. Truncates WITH a short deterministic
 * hash suffix so two distinct long names that share a 54-char prefix don't
 * collide (and silently shadow each other when spread into the tool map). A
 * name already within the limit is returned unchanged.
 */
function capToolNameLength(full: string): string {
  if (full.length <= MAX_TOOL_NAME_LENGTH) return full;
  const suffix = '_' + createHash('sha1').update(full).digest('hex').slice(0, 6);
  const head = full.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length).replace(/[_-]+$/, '');
  const truncated = head + suffix;
  console.warn(
    `[naming] Tool name exceeds ${MAX_TOOL_NAME_LENGTH}-char limit and was truncated: "${full}" → "${truncated}"`,
  );
  return truncated;
}

export function getScopedToolPrefix(source: Extract<ToolSource, 'mcp' | 'skill' | 'plugin'>, scope: string): string {
  if (source === 'skill') {
    return `${source}__${sanitizeToolSegment(scope, 'skill')}`;
  }

  return `${source}__${sanitizeToolSegment(scope, source)}__`;
}

export function findToolByName(tools: ToolDefinition[], toolName: string): ToolDefinition | undefined {
  // Exact NAME wins over any alias: an alias on an earlier tool must never
  // shadow a later tool whose real name is `toolName` (that would dispatch the
  // call to the wrong tool). Two passes: all exact names first, then aliases.
  return tools.find((tool) => tool.name === toolName) ?? tools.find((tool) => tool.aliases?.includes(toolName));
}

export function ensureSafeToolDefinition(tool: ToolDefinition): ToolDefinition {
  const safeName = makeSafeToolName(tool.name, tool.source ?? 'tool');
  if (safeName === tool.name) return tool;

  return {
    ...tool,
    name: safeName,
    originalName: tool.originalName ?? tool.name,
    aliases: Array.from(new Set([...(tool.aliases ?? []), tool.name])),
  };
}

export function ensureSafeToolDefinitions(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => ensureSafeToolDefinition(tool));
}

/**
 * Ensure every tool has a UNIQUE registered name. Two distinct sources can
 * sanitize to the same scoped name (e.g. MCP servers `foo bar` and `foo@bar`
 * both → `mcp__foo_bar__…`, or a skill name colliding with a built-in). The
 * agent tool map is keyed by name, so the later tool would silently SHADOW the
 * earlier one and calls would dispatch to the wrong tool.
 *
 * The FIRST occurrence of a name keeps it (stable for existing configs/aliases);
 * each subsequent collision gets a short deterministic hash suffix derived from
 * its sourceId+originalName, with the colliding name preserved as an alias.
 * A warning is logged so the collision is visible.
 */
export function dedupeToolNames(tools: ToolDefinition[]): ToolDefinition[] {
  const seen = new Set<string>();
  return tools.map((tool) => {
    if (!seen.has(tool.name)) {
      seen.add(tool.name);
      return tool;
    }
    const basis = `${tool.source ?? ''}:${tool.sourceId ?? ''}:${tool.originalName ?? tool.name}`;
    const hash = createHash('sha1').update(basis).digest('hex').slice(0, 6);
    // Build a disambiguated name that ALWAYS stays within the length limit, even
    // through the (astronomically unlikely) hash-collision retry: fold a bounded
    // counter into the suffix and re-fit the base against the total suffix length
    // each attempt — never just append chars (which would push a maxed-out name
    // over the limit → API rejection / tool loss).
    let disambiguated = '';
    for (let n = 0; ; n++) {
      const suffix = '_' + hash + (n === 0 ? '' : String(n));
      const base =
        tool.name.length + suffix.length > MAX_TOOL_NAME_LENGTH
          ? tool.name.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length).replace(/[_-]+$/, '')
          : tool.name;
      disambiguated = base + suffix;
      if (!seen.has(disambiguated)) break;
    }
    seen.add(disambiguated);
    console.warn(
      `[naming] Duplicate tool name "${tool.name}" (source=${tool.source ?? '?'} id=${tool.sourceId ?? '?'}) ` +
        `disambiguated to "${disambiguated}" to avoid silently shadowing an earlier tool.`,
    );
    return {
      ...tool,
      name: disambiguated,
      originalName: tool.originalName ?? tool.name,
      aliases: Array.from(new Set([...(tool.aliases ?? []), tool.name])),
    };
  });
}
