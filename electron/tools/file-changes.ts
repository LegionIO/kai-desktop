import { z } from 'zod';
import type { AppConfig } from '../config/schema.js';
import type { ToolDefinition, ToolExecutionContext } from './types.js';
import { getDiffText, listDiffsForConversation, revertDiff, revertToOp } from './diff-tracker.js';
import { isPathAllowed } from './file-access.js';

/**
 * Agent-facing view of the per-conversation file-edit diff tracker so the model
 * can inspect and undo its own changes. Scoped to the current conversation via
 * the tool execution context — the model cannot read another chat's diffs.
 */

const listInputSchema = z.object({});

const getInputSchema = z.object({
  path: z.string().min(1).describe('Absolute path of a file previously reported by list_file_changes.'),
});

const revertInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .optional()
    .describe('Absolute path to revert. Omit to revert every tracked file in this conversation.'),
  toOpIndex: z
    .number()
    .int()
    .optional()
    .describe(
      'Optional: roll the file back to its state after this op index (0-based, from list_file_changes ops). -1 restores the pre-edit original. Requires a single `path`.',
    ),
});

export function createFileChangesTools(getConfig: () => AppConfig): ToolDefinition[] {
  const list: ToolDefinition = {
    name: 'list_file_changes',
    description: [
      'List every file you have created, edited, or deleted in this conversation, with line counts and',
      'the sequence of edit operations per file. Use this to review your own changes before reporting',
      'completion, or to decide what to undo. Returns unified-diff text per file.',
    ].join(' '),
    inputSchema: listInputSchema,
    execute: async (_input, context) => {
      const conversationId = (context as ToolExecutionContext | undefined)?.conversationId;
      if (!conversationId) return { ok: false, error: 'No conversation context available.' };
      const config = getConfig();
      // Re-check current file-access policy: a path tracked while allowed may
      // since have been denied (or file access disabled). Don't expose or allow
      // reverting content the agent can no longer access.
      const diffs = listDiffsForConversation(conversationId).filter((d) => isPathAllowed(d.path, config).allowed);
      return {
        ok: true,
        fileCount: diffs.length,
        files: diffs.map((d) => ({
          path: d.path,
          additions: d.additions,
          deletions: d.deletions,
          created: d.created,
          deleted: d.deleted,
          revertable: d.revertable,
          opCount: d.ops.length,
          ops: d.ops.map((op, i) => ({
            index: i,
            toolName: op.toolName,
            additions: op.additions,
            deletions: op.deletions,
            at: op.at,
            snapshotAvailable: op.snapshotAvailable === true,
          })),
          unifiedDiff: d.unifiedDiff,
        })),
      };
    },
  };

  const get: ToolDefinition = {
    name: 'get_file_change',
    description: 'Return the full unified diff for one file changed in this conversation.',
    inputSchema: getInputSchema,
    execute: async (input, context) => {
      const conversationId = (context as ToolExecutionContext | undefined)?.conversationId;
      if (!conversationId) return { ok: false, error: 'No conversation context available.' };
      const { path } = input as z.infer<typeof getInputSchema>;
      if (!isPathAllowed(path, getConfig()).allowed) {
        return { ok: false, error: `Path ${path} is not currently allowed by file-access policy.` };
      }
      const unifiedDiff = getDiffText(conversationId, path);
      if (unifiedDiff === null) return { ok: false, error: `No tracked changes for ${path}.` };
      return { ok: true, path, unifiedDiff };
    },
  };

  const revert: ToolDefinition = {
    name: 'revert_file_changes',
    description: [
      'Undo file changes made in this conversation. With `path`, reverts that one file to its pre-edit',
      'original (or, with `toOpIndex`, to a specific earlier op). With no `path`, reverts ALL tracked',
      'files. Only files whose original content was captured can be reverted; others are reported as skipped.',
    ].join(' '),
    inputSchema: revertInputSchema,
    execute: async (input, context) => {
      const conversationId = (context as ToolExecutionContext | undefined)?.conversationId;
      if (!conversationId) return { ok: false, error: 'No conversation context available.' };
      const config = getConfig();
      const { path, toOpIndex } = input as z.infer<typeof revertInputSchema>;
      if (!path) {
        if (toOpIndex !== undefined) return { ok: false, error: 'toOpIndex requires a single path.' };
        // Only revert paths still permitted by the current policy.
        const allowed = listDiffsForConversation(conversationId).filter((d) => isPathAllowed(d.path, config).allowed);
        let reverted = 0;
        const skipped: string[] = [];
        for (const d of allowed) {
          const r = revertDiff(conversationId, d.path);
          if (r.success) reverted++;
          else skipped.push(d.path);
        }
        return { ok: skipped.length === 0, reverted, skipped };
      }
      if (!isPathAllowed(path, config).allowed) {
        return { ok: false, error: `Path ${path} is not currently allowed by file-access policy.` };
      }
      const r =
        toOpIndex !== undefined ? revertToOp(conversationId, path, toOpIndex) : revertDiff(conversationId, path);
      return { ok: r.success, ...(r.error ? { error: r.error } : {}) };
    },
  };

  return [list, get, revert];
}
