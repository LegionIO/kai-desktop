import { z } from 'zod';
import { BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { broadcastToWebClients } from '../web-server/web-clients.js';
import type { ToolDefinition } from './types.js';

const ADJECTIVES = ['bright', 'calm', 'cheerful', 'cosmic', 'drifting', 'elegant', 'floating', 'gentle', 'happy', 'luminous', 'merry', 'noble', 'quiet', 'radiant', 'serene', 'tender', 'vivid', 'warm', 'bold', 'crisp'];
const VERBS = ['baking', 'brewing', 'doodling', 'gathering', 'humming', 'leaping', 'noodling', 'pondering', 'seeking', 'spinning', 'toasting', 'tumbling', 'weaving', 'wishing', 'splashing', 'sniffing', 'twirling', 'frolicking', 'prancing', 'sprouting'];
const NOUNS = ['star', 'tiger', 'sparrow', 'duckling', 'raccoon', 'pretzel', 'pumpkin', 'horizon', 'island', 'glade', 'pudding', 'bunny', 'toast', 'pizza', 'dragonfly', 'fern', 'quokka', 'sphinx', 'goblet', 'sloth'];

function generatePlanName(): string {
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
  return `${pick(ADJECTIVES)}-${pick(VERBS)}-${pick(NOUNS)}`;
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
        ].filter(Boolean).join('\n'),
        ...(reason ? { reason } : {}),
      };
    },
  };
}

export function createExitPlanModeTool(): ToolDefinition {
  return {
    name: 'exit_plan_mode',
    description: [
      'Exit plan-first mode and return to normal auto mode where all tools are available.',
      'Call this when you have finished producing your plan and the user is ready to proceed with implementation.',
      'Pass the full plan as markdown in planContent. This tool requires user approval before executing — the user will see the plan in a side panel and an approve/reject prompt.',
    ].join(' '),
    inputSchema: z.object({
      planContent: z.string().describe('The full plan as markdown. Include Context, Implementation Steps, Files to Modify, and Verification sections.'),
      planTitle: z.string().optional().describe('Short title for the plan file (e.g. "add-dark-mode"). If omitted, a random name is generated.'),
      summary: z.string().optional().describe('Brief summary of the plan that was produced'),
    }),
    execute: async (input) => {
      const { planContent, planTitle, summary } = input as { planContent: string; planTitle?: string; summary?: string };

      // Write the plan to ~/.kai/plans/<name>.md
      const planName = planTitle
        ? planTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
        : generatePlanName();
      const plansDir = join(homedir(), '.kai', 'plans');
      mkdirSync(plansDir, { recursive: true });
      const planFilePath = join(plansDir, `${planName}.md`);
      writeFileSync(planFilePath, planContent, 'utf-8');

      broadcastModeChange('auto');
      return {
        success: true,
        mode: 'auto',
        planFilePath,
        planName: `${planName}.md`,
        message: 'Plan mode has been deactivated. All tools including file_write, file_edit, and sh are now available. The PLAN MODE ACTIVE restriction from the system prompt no longer applies. You may now proceed with implementation using any tools.',
        ...(summary ? { summary } : {}),
      };
    },
  };
}
