import { z } from 'zod';
import { BrowserWindow } from 'electron';
import { broadcastToWebClients } from '../web-server/web-clients.js';
import type { ToolDefinition } from './types.js';

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
      'This tool requires user approval before executing — the user will see an approve/reject prompt.',
    ].join(' '),
    inputSchema: z.object({
      summary: z.string().optional().describe('Brief summary of the plan that was produced'),
    }),
    execute: async (input) => {
      const { summary } = input as { summary?: string };
      broadcastModeChange('auto');
      return {
        success: true,
        mode: 'auto',
        message: 'Plan mode has been deactivated. All tools including file_write, file_edit, and sh are now available. The PLAN MODE ACTIVE restriction from the system prompt no longer applies. You may now proceed with implementation using any tools.',
        ...(summary ? { summary } : {}),
      };
    },
  };
}
