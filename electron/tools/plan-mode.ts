import { z } from 'zod';
import { mkdirSync, openSync, writeSync, closeSync, constants as fsConstants } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { broadcastToAllWindows } from '../utils/window-send.js';
import type { ToolDefinition } from './types.js';

const ADJECTIVES = [
  'bright',
  'calm',
  'cheerful',
  'cosmic',
  'drifting',
  'elegant',
  'floating',
  'gentle',
  'happy',
  'luminous',
  'merry',
  'noble',
  'quiet',
  'radiant',
  'serene',
  'tender',
  'vivid',
  'warm',
  'bold',
  'crisp',
];
const VERBS = [
  'baking',
  'brewing',
  'doodling',
  'gathering',
  'humming',
  'leaping',
  'noodling',
  'pondering',
  'seeking',
  'spinning',
  'toasting',
  'tumbling',
  'weaving',
  'wishing',
  'splashing',
  'sniffing',
  'twirling',
  'frolicking',
  'prancing',
  'sprouting',
];
const NOUNS = [
  'star',
  'tiger',
  'sparrow',
  'duckling',
  'raccoon',
  'pretzel',
  'pumpkin',
  'horizon',
  'island',
  'glade',
  'pudding',
  'bunny',
  'toast',
  'pizza',
  'dragonfly',
  'fern',
  'quokka',
  'sphinx',
  'goblet',
  'sloth',
];

function generatePlanName(): string {
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
  return `${pick(ADJECTIVES)}-${pick(VERBS)}-${pick(NOUNS)}`;
}

/**
 * Turn a model-supplied plan title into a safe, single-segment filename slug.
 * Strips everything except [a-z0-9] (collapsing runs to '-'), so a traversal- or
 * separator-laden title (e.g. "../../etc/passwd") can only ever produce a plain
 * slug that stays inside the plans dir. Falls back to a random name when the
 * title is absent OR sanitizes to empty (e.g. an all-punctuation title, which
 * would otherwise yield a degenerate ".md" filename).
 */
function slugifyPlanTitle(planTitle: string | undefined): string {
  const slug = (planTitle ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || generatePlanName();
}

/** Persist the authoritative per-conversation executionMode in the MAIN process
 *  BEFORE broadcasting, wired from the IPC layer (setExecutionModePersister). The
 *  broadcast is fire-and-forget and the renderer normally persists the mode via its
 *  next submit — but if the window is reloading when the (guarded) broadcast skips
 *  it, the renderer never learns the change and the next turn runs under the stale
 *  mode's tool policy. Persisting in main makes the broadcast a notification/reconcile
 *  rather than the source of truth (R108 finding-4). No-op until wired. */
type ExecutionModePersister = (conversationId: string, mode: 'auto' | 'plan-first') => boolean;
let executionModePersister: ExecutionModePersister | null = null;
export function setExecutionModePersister(fn: ExecutionModePersister | null): void {
  executionModePersister = fn;
}

/** Apply a mode change: persist (authoritative) then broadcast. Returns whether the persist
 *  SUCCEEDED — a plan-first ENTER must fail closed if it didn't (R136 f-1), so the renderer
 *  doesn't restart into a plan-first the trust-disk reconcile can't see. `auto` exits and the
 *  unwired case return true (best-effort is fine when leaving plan mode / no persister). */
function applyModeChange(conversationId: string | undefined, mode: 'auto' | 'plan-first'): boolean {
  // A plan-first ENTER with NO conversationId (e.g. a direct `tool` automation action) can't be
  // persisted anywhere — treat it as a FAILED entry (R139 f-2), not a silent success, so it can't
  // broadcast an unscoped Plan-First that shows in the UI while disk stays 'auto' (next turn then
  // runs mutating tools). enter_plan_mode is meaningless without a conversation to scope it to.
  if (mode === 'plan-first' && (!conversationId || !executionModePersister)) {
    return false;
  }
  let persisted = true;
  if (conversationId && executionModePersister) {
    try {
      persisted = executionModePersister(conversationId, mode);
    } catch {
      persisted = false;
    }
  }
  // Only broadcast when the authoritative disk state MATCHES what we'd announce. Broadcasting
  // plan-first after a FAILED persist would make the UI show Plan-First while disk stays 'auto',
  // and the next submit (trust-disk) would run mutating tools despite the displayed mode (R137
  // f-3). On a failed plan-first persist, suppress the broadcast (the tool also returns
  // success:false). A failed 'auto' persist is less critical but treat it the same for symmetry.
  if (persisted) broadcastModeChange(mode, conversationId);
  return persisted;
}

function broadcastModeChange(mode: string, conversationId?: string): void {
  // Guarded, non-throwing fan-out (mirrors agent.ts broadcastExecutionMode): a
  // navigating window's send throwing must not interrupt the plan-mode transition
  // sequence around it (R107 finding-4 class). Carry conversationId so the renderer
  // applies the mode ONLY when it matches the DISPLAYED conversation — a background
  // conversation exiting plan mode must not flip the viewed conversation to `auto`
  // and expose mutating tools there (R121 finding-1).
  broadcastToAllWindows('agent:execution-mode-changed', { conversationId: conversationId ?? null, mode });
}

export function createEnterPlanModeTool(): ToolDefinition {
  return {
    name: 'enter_plan_mode',
    description: [
      'Switch the current session to plan-first mode.',
      'Call this when the user asks you to plan, think first, explore before coding, or enter plan mode.',
      'In plan mode only read-only tools are available (file_read, grep, glob, list_directory, web_fetch, web_search).',
      'Write tools (file_write, file_edit, sh) are disabled.',
    ].join(' '),
    inputSchema: z.object({
      reason: z.string().optional().describe('Brief reason for entering plan mode'),
    }),
    execute: async (input, context) => {
      const { reason } = input as { reason?: string };
      // SELF-GUARD (R141): only run in a context that can actually enforce plan mode — an
      // interactive/SDK run whose driver intercepts this tool to restart read-only. Every other
      // executor (Pi/Codex/OpenCode bridges, task agents, sub-agents, observer, plugin inference,
      // realtime, direct automation tool actions) calls execute DIRECTLY with planModeGateable
      // ABSENT — there, entering plan mode would flip the mode but the run keeps its MUTATING
      // tool set (no restart), so refuse instead.
      if (!context.planModeGateable) {
        return {
          success: false,
          error: 'Plan mode is not available in this run. Continue normally; do not treat this turn as plan mode.',
        };
      }
      // FAIL CLOSED (R136 f-1): if plan-first can't be persisted (disk write failed / no record),
      // do NOT report success — a GUI/CLI restart into plan-first would then trust the stale
      // disk 'auto' at reconcile and run mutating tools during "planning". Tell the model the
      // transition failed so it stays in the current (safe) mode rather than assuming read-only.
      const entered = applyModeChange(context.conversationId, 'plan-first');
      if (!entered) {
        return {
          success: false,
          error:
            'Could not enter plan mode (failed to persist the mode). Continue WITHOUT assuming read-only planning; do not treat this turn as plan mode.',
        };
      }
      const cwd = context.cwd;
      return {
        success: true,
        mode: 'plan-first',
        message: [
          'Switched to plan-first mode. The following rules apply IMMEDIATELY for the remainder of this turn:',
          '',
          'TOOLS: Only use read-only tools (file_read, grep, glob, list_directory, web_fetch, web_search). Do NOT use file_write, file_edit, or sh.',
          '',
          cwd
            ? `WORKING DIRECTORY: ${cwd} — Use this as the base path for all tool calls. When calling grep, glob, or list_directory, either omit the path parameter or use this directory. NEVER navigate the filesystem from / or /Users.`
            : '',
          '',
          'WORKFLOW: Be thorough in exploration. Read all relevant files, trace code paths. Use ask_user to clarify requirements. End your turn by calling exit_plan_mode to present your plan.',
        ]
          .filter(Boolean)
          .join('\n'),
        ...(reason ? { reason } : {}),
      };
    },
  };
}

export function createExitPlanModeTool(): ToolDefinition {
  return {
    name: 'exit_plan_mode',
    description: [
      'Exit plan-first mode and enter implementation mode where write tools are available.',
      'Call this when you have finished producing your plan and the user is ready to proceed with implementation.',
      'Pass the full plan as markdown in planContent. This tool requires user approval before executing — the user will see the plan in a side panel and an approve/reject prompt.',
    ].join(' '),
    inputSchema: z.object({
      planContent: z
        .string()
        .describe(
          'The full plan as markdown. Include Context, Implementation Steps, Files to Modify, and Verification sections.',
        ),
      planTitle: z
        .string()
        .optional()
        .describe('Short title for the plan file (e.g. "add-dark-mode"). If omitted, a random name is generated.'),
      summary: z.string().optional().describe('Brief summary of the plan that was produced'),
    }),
    execute: async (input, context) => {
      const { planContent, planTitle, summary } = input as {
        planContent: string;
        planTitle?: string;
        summary?: string;
      };

      // SELF-GUARD (R141): exit_plan_mode WRITES the plan file + flips mode to auto. That must
      // only happen AFTER user approval, which only the gateable runtimes perform (the Mastra
      // streamHandler approval hook; the SDK createExitPlanModeHandler). An ungated executor
      // (Pi/Codex/OpenCode bridge, task/sub-agent, observer, plugin inference, realtime,
      // automation tool action) calls execute DIRECTLY with planModeGateable ABSENT — saving the
      // plan + leaving plan mode with NO approval. Refuse there.
      if (!context.planModeGateable) {
        return {
          success: false,
          error: 'exit_plan_mode requires an interactive approval flow not available in this run.',
        };
      }

      // Bound the plan size: model-generated content is normally small, but a
      // runaway plan shouldn't be able to write an unbounded file / block the
      // main process. 1 MiB is far larger than any real plan.
      const MAX_PLAN_BYTES = 1024 * 1024;
      if (typeof planContent === 'string' && Buffer.byteLength(planContent, 'utf-8') > MAX_PLAN_BYTES) {
        return { success: false, error: `Plan is too large (max ${MAX_PLAN_BYTES} bytes).` };
      }

      // Write the plan to ~/.kai/plans/<name>.md
      const planName = slugifyPlanTitle(planTitle);
      const plansDir = join(homedir(), '.kai', 'plans');
      const planFilePath = join(plansDir, `${planName}.md`);
      try {
        mkdirSync(plansDir, { recursive: true });
        // O_NOFOLLOW so a pre-existing symlink at the target can't redirect the
        // write outside the plans dir. O_TRUNC keeps the overwrite-on-same-title
        // behavior (plan files are ephemeral working artifacts). Fd write + close
        // in finally so the descriptor never leaks on a mid-write error.
        const fd = openSync(
          planFilePath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
          0o644,
        );
        try {
          writeSync(fd, planContent, null, 'utf-8');
        } finally {
          closeSync(fd);
        }
      } catch (err) {
        // Fail soft — stay in plan mode so the user can retry rather than crash
        // the tool call.
        return { success: false, error: `Failed to save plan: ${err instanceof Error ? err.message : String(err)}` };
      }

      // Flip to auto (implementation mode). If the auto persist FAILS (conversation record
      // temporarily unwritable), do NOT report mode:auto — disk + UI stay plan-first and the
      // next trust-disk turn would remain read-only, so a success:true/mode:auto here is FALSE
      // (R142 f-2). The plan file DID save, so surface that but report the mode is unchanged.
      const switchedToAuto = applyModeChange(context.conversationId, 'auto');
      if (!switchedToAuto) {
        return {
          success: false,
          mode: 'plan-first',
          planFilePath,
          planName: `${planName}.md`,
          error:
            'Plan saved, but could not switch to implementation mode (failed to persist). The conversation is still in plan mode; retry exit_plan_mode.',
        };
      }
      return {
        success: true,
        mode: 'auto',
        planFilePath,
        planName: `${planName}.md`,
        message: [
          `Plan approved and saved to ${planFilePath}.`,
          'The plan has been added to Tasks.',
          'Implementation will happen in Tasks with a separate agent session that reads the plan.',
          'Do NOT offer to implement the plan yourself in this conversation.',
          'Simply acknowledge that the plan is in Tasks and the user can implement it from there.',
        ].join(' '),
        ...(summary ? { summary } : {}),
      };
    },
  };
}

/** Exposed for unit tests only. */
export const __internal = { slugifyPlanTitle };
