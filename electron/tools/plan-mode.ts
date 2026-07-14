import { z } from 'zod';
import { BrowserWindow } from 'electron';
import { mkdirSync, openSync, writeSync, closeSync, constants as fsConstants } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { broadcastToWebClients } from '../web-server/web-clients.js';
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

function broadcastModeChange(mode: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('agent:execution-mode-changed', mode);
  }
  broadcastToWebClients('agent:execution-mode-changed', mode);
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
      broadcastModeChange('plan-first');
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
    execute: async (input) => {
      const { planContent, planTitle, summary } = input as {
        planContent: string;
        planTitle?: string;
        summary?: string;
      };

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

      broadcastModeChange('auto');
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
