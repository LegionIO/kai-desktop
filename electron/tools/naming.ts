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
  if (isValidToolName(name)) return name;
  return sanitizeToolSegment(name, fallback);
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
  return tools.find((tool) => tool.name === toolName || tool.aliases?.includes(toolName));
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
    const suffix = '_' + createHash('sha1').update(basis).digest('hex').slice(0, 6);
    // Fit the suffix within the length limit by trimming the base name if needed.
    const base =
      tool.name.length + suffix.length > MAX_TOOL_NAME_LENGTH
        ? tool.name.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length).replace(/[_-]+$/, '')
        : tool.name;
    let disambiguated = base + suffix;
    // Extremely unlikely, but guarantee uniqueness even if the hash collides.
    while (seen.has(disambiguated)) disambiguated += 'x';
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
