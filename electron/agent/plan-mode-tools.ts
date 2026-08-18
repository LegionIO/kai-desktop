import type { ExecutionMode } from '../config/schema.js';
import type { ToolSource } from '../tools/types.js';

/**
 * The ONLY custom/registered tools allowed in plan-first (plan) mode. Plan mode is a
 * READ-ONLY planning turn: it may inspect (web_fetch/web_search), ask the user, and
 * enter/exit plan mode, but must NOT run anything that mutates state (shell, file writes,
 * MCP/skill/plugin actions, workspace execution). Anything not in this set is filtered out.
 *
 * Shared so EVERY stream entry point applies the same filter — the main GUI/CLI stream path
 * AND the plugin-generate path used by idle/automation/alert-recovery resumes (a recovered
 * turn in a plan-first conversation must be just as read-only as an interactive one; R129).
 *
 * These are all BUILT-IN tools. The allowlist is matched by name AND provenance (R151): a
 * CLI/plugin/MCP/skill tool can register ANY name — a CLI tool named `web_search` backed by
 * `git`/`gh` would otherwise keep the allowlisted name (CLI tools register before built-ins, and
 * dedup keeps the first) and slip a mutating executor into the "read-only" set. Only a built-in
 * (source 'builtin' or untagged) with an allowlisted name is kept.
 */
export const PLAN_MODE_CUSTOM_TOOLS = new Set([
  'ask_user',
  'enter_plan_mode',
  'exit_plan_mode',
  'web_fetch',
  'web_search',
]);

/** A tool is plan-mode-safe only if its name is allowlisted AND it is a BUILT-IN (source
 *  'builtin' or undefined — the built-in default). A same-named CLI/plugin/MCP/skill tool is a
 *  spoof and must be dropped in plan-first (R151). */
function isPlanModeSafe(tool: { name: string; source?: ToolSource }): boolean {
  if (!PLAN_MODE_CUSTOM_TOOLS.has(tool.name)) return false;
  return tool.source === undefined || tool.source === 'builtin';
}

/** Filter a tool list down to the plan-mode-safe set when in plan-first; identity otherwise. */
export function toolsForExecutionMode<T extends { name: string; source?: ToolSource }>(
  tools: T[],
  executionMode: ExecutionMode,
): T[] {
  if (executionMode === 'plan-first') {
    return tools.filter(isPlanModeSafe);
  }
  return tools;
}

/**
 * Strip the INTERACTIVE plan-mode TRANSITION tools (enter_plan_mode/exit_plan_mode) from a
 * headless tool set — automation runs AND plugin agent.generate|stream (R138 f-5 / R139 f-1).
 * These drive an interactive plan-review flow (mid-stream tool-refiltering + a GUI approval on
 * exit) that the linear streamForPlugin/generateForPlugin path can't perform — it never restarts,
 * so a run that entered plan mode mid-stream would keep its pre-transition MUTATING tools, and
 * exit_plan_mode would write ~/.kai/plans/<title>.md without the GUI approval gate. A plan-first
 * conversation resumed headlessly still runs read-only (mode is filtered at run START by
 * executionMode); it simply can't mid-stream TOGGLE plan mode, which is meaningless without an
 * interactive user.
 */
export function withoutMidStreamPlanTools<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter((t) => t.name !== 'enter_plan_mode' && t.name !== 'exit_plan_mode');
}
