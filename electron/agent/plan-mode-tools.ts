import type { ExecutionMode } from '../config/schema.js';

/**
 * The ONLY custom/registered tools allowed in plan-first (plan) mode. Plan mode is a
 * READ-ONLY planning turn: it may inspect (web_fetch/web_search), ask the user, and
 * enter/exit plan mode, but must NOT run anything that mutates state (shell, file writes,
 * MCP/skill/plugin actions, workspace execution). Anything not in this set is filtered out.
 *
 * Shared so EVERY stream entry point applies the same filter — the main GUI/CLI stream path
 * AND the plugin-generate path used by idle/automation/alert-recovery resumes (a recovered
 * turn in a plan-first conversation must be just as read-only as an interactive one; R129).
 */
export const PLAN_MODE_CUSTOM_TOOLS = new Set([
  'ask_user',
  'enter_plan_mode',
  'exit_plan_mode',
  'web_fetch',
  'web_search',
]);

/** Filter a tool list down to the plan-mode-safe set when in plan-first; identity otherwise. */
export function toolsForExecutionMode<T extends { name: string }>(tools: T[], executionMode: ExecutionMode): T[] {
  if (executionMode === 'plan-first') {
    return tools.filter((tool) => PLAN_MODE_CUSTOM_TOOLS.has(tool.name));
  }
  return tools;
}
