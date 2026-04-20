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
      'The mode change takes effect on your next response turn.',
    ].join(' '),
    inputSchema: z.object({
      reason: z.string().optional().describe('Brief reason for entering plan mode'),
    }),
    execute: async (input) => {
      const { reason } = input as { reason?: string };
      broadcastModeChange('plan-first');
      return {
        success: true,
        mode: 'plan-first',
        message: 'Switched to plan-first mode. Write tools (file_write, file_edit, sh) are disabled until the user exits plan mode. Focus on reading, exploring, and producing a detailed implementation plan. When your plan is complete, call exit_plan_mode to let the user review and approve.',
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
