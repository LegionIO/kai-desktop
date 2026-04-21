import { z } from 'zod';
import { mkdir, readFile, writeFile, stat } from 'fs/promises';
import { dirname } from 'path';
import type { ToolDefinition } from './types.js';
import { runToolExecution, throwIfAborted } from './execution.js';
import { resolveToolPath } from './path-utils.js';
import {
  checkStaleness,
  checkFileSize,
  getConversationCache,
  encodeContent,
  updateCacheAfterWrite,
  detectEncoding,
  detectLineEnding,
} from './file-safety.js';

async function readIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

export function createFileWriteTool(): ToolDefinition {
  return {
    name: 'file_write',
    description: 'Write content to a file. Can write the full file, or patch specific lines.',
    inputSchema: z.object({
      path: z.string().describe('Absolute path to the file'),
      content: z.string().describe('Content to write'),
      mode: z.enum(['overwrite', 'append', 'insert_at_line', 'replace_lines']).optional().describe('Write mode (default: overwrite)'),
      atLine: z.number().optional().describe('Line number for insert_at_line mode'),
      startLine: z.number().optional().describe('Start line for replace_lines mode'),
      endLine: z.number().optional().describe('End line for replace_lines mode'),
      createDirs: z.boolean().optional().describe('Create parent directories if missing'),
    }),
    execute: async (input, context) => runToolExecution({
      context,
      timeoutMs: 20000,
      run: async (signal) => {
        throwIfAborted(signal);
        const { path, content, mode = 'overwrite', atLine, startLine, endLine, createDirs } = input as {
          path: string; content: string; mode?: string;
          atLine?: number; startLine?: number; endLine?: number; createDirs?: boolean;
        };
        const resolvedPath = await resolveToolPath(path, context.cwd);

        // File size guard
        const sizeError = await checkFileSize(resolvedPath);
        if (sizeError) return { error: sizeError, isError: true };

        // Staleness check
        const convId = context.conversationId ?? '';
        const staleError = await checkStaleness(resolvedPath, convId);
        if (staleError) return { error: staleError, isError: true };

        if (createDirs) {
          await mkdir(dirname(resolvedPath), { recursive: true });
        }
        throwIfAborted(signal);

        // Determine encoding from cached metadata or detect from file
        const cache = getConversationCache(convId);
        const cached = cache.get(resolvedPath);
        const encoding = cached?.encoding ?? 'utf-8';
        const lineEnding = cached?.lineEnding ?? 'lf';

        if (mode === 'overwrite') {
          const encoded = encodeContent(content, encoding, lineEnding);
          await writeFile(resolvedPath, encoded);
          const newStat = await stat(resolvedPath);
          updateCacheAfterWrite(resolvedPath, convId, content, encoding, lineEnding, newStat.mtimeMs, newStat.size);
          return { success: true, path: resolvedPath, bytesWritten: encoded.length };
        }

        if (mode === 'append') {
          const existing = await readIfExists(resolvedPath);
          const combined = existing + content;
          const encoded = encodeContent(combined, encoding, lineEnding);
          await writeFile(resolvedPath, encoded);
          const newStat = await stat(resolvedPath);
          updateCacheAfterWrite(resolvedPath, convId, combined, encoding, lineEnding, newStat.mtimeMs, newStat.size);
          return { success: true, path: resolvedPath, mode: 'append' };
        }

        if (mode === 'insert_at_line' && typeof atLine === 'number') {
          const existing = await readIfExists(resolvedPath);
          const lines = existing.split('\n');
          const insertIdx = Math.max(0, Math.min(lines.length, atLine - 1));
          lines.splice(insertIdx, 0, content);
          const combined = lines.join('\n');
          const encoded = encodeContent(combined, encoding, lineEnding);
          await writeFile(resolvedPath, encoded);
          const newStat = await stat(resolvedPath);
          updateCacheAfterWrite(resolvedPath, convId, combined, encoding, lineEnding, newStat.mtimeMs, newStat.size);
          return { success: true, path: resolvedPath, mode: 'insert_at_line', atLine: insertIdx + 1 };
        }

        if (mode === 'replace_lines' && typeof startLine === 'number' && typeof endLine === 'number') {
          const existing = await readIfExists(resolvedPath);
          const lines = existing.split('\n');
          const start = Math.max(0, startLine - 1);
          const end = Math.min(lines.length, endLine);
          lines.splice(start, end - start, content);
          const combined = lines.join('\n');
          const encoded = encodeContent(combined, encoding, lineEnding);
          await writeFile(resolvedPath, encoded);
          const newStat = await stat(resolvedPath);
          updateCacheAfterWrite(resolvedPath, convId, combined, encoding, lineEnding, newStat.mtimeMs, newStat.size);
          return { success: true, path: resolvedPath, mode: 'replace_lines', replacedRange: `${startLine}-${endLine}` };
        }

        return { error: 'Invalid write mode or missing parameters', isError: true };
      },
    }),
  };
}

export function createFileEditTool(): ToolDefinition {
  return {
    name: 'file_edit',
    description: 'Search and replace text in a file. The old_string must uniquely match exactly one location.',
    inputSchema: z.object({
      path: z.string().describe('Absolute path to the file'),
      old_string: z.string().describe('Exact text to find and replace'),
      new_string: z.string().describe('Replacement text'),
      replace_all: z.boolean().optional().describe('Replace all occurrences (default: false)'),
    }),
    execute: async (input, context) => runToolExecution({
      context,
      timeoutMs: 20000,
      run: async (signal) => {
        throwIfAborted(signal);
        const { path, old_string, new_string, replace_all = false } = input as {
          path: string; old_string: string; new_string: string; replace_all?: boolean;
        };
        const resolvedPath = await resolveToolPath(path, context.cwd);

        // File size guard
        const sizeError = await checkFileSize(resolvedPath);
        if (sizeError) return { error: sizeError, isError: true };

        // Staleness check
        const convId = context.conversationId ?? '';
        const staleError = await checkStaleness(resolvedPath, convId);
        if (staleError) return { error: staleError, isError: true };

        // Read file preserving encoding info
        const buffer = await readFile(resolvedPath);
        const encoding = detectEncoding(buffer);
        let content: string;
        if (encoding === 'utf-16le') {
          content = buffer.toString('utf16le');
          if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
        } else {
          content = buffer.toString('utf-8');
          if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
        }

        const lineEnding = detectLineEnding(content);
        throwIfAborted(signal);

        const occurrences = content.split(old_string).length - 1;
        if (occurrences === 0) return { error: 'old_string not found in file', isError: true };
        if (occurrences > 1 && !replace_all) {
          return { error: `old_string found ${occurrences} times. Use replace_all: true or provide more context.`, isError: true };
        }

        const updated = replace_all
          ? content.replaceAll(old_string, new_string)
          : content.replace(old_string, new_string);

        const encoded = encodeContent(updated, encoding, lineEnding);
        await writeFile(resolvedPath, encoded);

        // Update cache after successful write
        const newStat = await stat(resolvedPath);
        updateCacheAfterWrite(resolvedPath, convId, updated, encoding, lineEnding, newStat.mtimeMs, newStat.size);

        return { success: true, path: resolvedPath, replacements: replace_all ? occurrences : 1 };
      },
    }),
  };
}
