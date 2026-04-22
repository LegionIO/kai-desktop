/**
 * Workspace Agent — streams LLM responses for workspace engines.
 *
 * Each engine (insights, ideation, roadmap, execution, changelog, etc.) gets a
 * stateless call with a custom system prompt.  Under the hood this calls the
 * `workspace:stream` IPC which uses the AI SDK's `streamText()` directly,
 * bypassing the full Mastra agent pipeline.
 */

import { app } from './ipc-client';
import { generateId } from './utils';

// Debug: confirm this module is loaded and using the new IPC
console.warn('[workspace-agent] Module loaded — using workspace:stream IPC (not agent:stream)');

// ── Engine system prompts ──────────────────────────────────────

const ENGINE_SYSTEM_PROMPTS: Record<string, string> = {
  insights: [
    'You are a codebase analysis assistant embedded in a workspace IDE.',
    'The user has opened a project and wants to understand their codebase.',
    'Analyze code structure, explain patterns, identify dependencies, and answer questions about the project.',
    'Be concise but thorough. Reference specific files and line numbers when relevant.',
  ].join(' '),

  ideation: [
    'You are an AI code improvement analyst. Analyze the user\'s codebase and generate actionable improvement ideas.',
    'Categories to analyze: code quality, performance, security, documentation, UI/UX, architecture.',
    'For each idea: provide a title, description, severity (info/low/medium/high/critical), category (code-improvement/code-quality/performance/security/documentation/ui-ux), affected files, and suggested fix.',
    'After your analysis, output a JSON block fenced with ```json that matches this schema:',
    '{"ideas": [{"title": "...", "description": "...", "category": "code-improvement|code-quality|performance|security|documentation|ui-ux", "severity": "info|low|medium|high|critical", "affectedFiles": ["..."], "suggestedFix": "..."}]}',
    'You may include explanatory text before the JSON block.',
  ].join(' '),

  roadmap: [
    'You are a technical product manager AI. Analyze the user\'s project and generate a development roadmap.',
    'Break the roadmap into phases (3-4 phases). Each phase has features with priorities and effort estimates.',
    'After your analysis, output a JSON block fenced with ```json that matches this schema:',
    '{"phases": [{"name": "...", "description": "...", "features": [{"title": "...", "description": "...", "priority": "low|medium|high|critical", "effort": "small|medium|large|xlarge", "status": "planned|in_progress|completed"}]}]}',
    'You may include explanatory text before the JSON block.',
  ].join(' '),

  planning: [
    'You are a senior software architect planning a code change.',
    'The user will describe a task they want to accomplish in their codebase.',
    'Think carefully about the project structure and existing patterns based on the information provided.',
    'Output a JSON block fenced with ```json matching this schema:',
    '{"approach": "Description of the overall strategy and why this approach was chosen",',
    '"steps": [{"id": "1", "description": "Specific actionable step", "status": "pending"}, ...],',
    '"filesToModify": ["relative/path/to/file.ts", ...],',
    '"testsToRun": ["npm test -- --filter ...", ...],',
    '"risks": ["Specific risk description", ...]}',
    'Be specific — reference actual files, functions, and patterns.',
    'Keep steps actionable and ordered. Include 3-8 steps.',
    'Identify real risks, not generic ones.',
    'You may include explanatory text before the JSON block.',
  ].join(' '),

  execution: [
    'You are an autonomous code execution agent. You MUST use tools to make real file changes.',
    '',
    'AVAILABLE TOOLS: file_read, file_write, file_edit, sh, glob, grep, list_directory',
    '',
    'MANDATORY WORKFLOW for each step:',
    '1. Call file_read to read the file you need to change',
    '2. Call file_edit or file_write to make the actual change',
    '3. Optionally call file_read again to verify the change',
    '4. Output [STEP_COMPLETE:N] after the step is done',
    '',
    'CRITICAL RULES:',
    '- You MUST call file_edit or file_write for EVERY change. Text descriptions of changes are WORTHLESS.',
    '- NEVER output [STEP_COMPLETE:N] unless you have called file_edit or file_write in that step.',
    '- Do NOT describe what you would do. DO IT by calling tools.',
    '- If file_edit fails, try file_write with the complete new file content.',
    '- You have FULL permission to modify any file. No confirmation needed.',
    '- Execute ALL plan steps, not just the first one.',
  ].join('\n'),

  review: [
    'You are a senior code reviewer. You are given a task description and the git diff of changes made to fulfill that task.',
    'Review the code changes carefully for: correctness, potential bugs, security issues, code quality, and whether they actually fulfill the task requirements.',
    'After your analysis, you MUST output a JSON block fenced with ```json that matches this schema:',
    '{"approved": true|false, "summary": "one-line summary of your review", "comments": ["specific feedback item 1", "specific feedback item 2"]}',
    'Be specific — reference file names and describe what you found. If the changes look correct and complete, approve. If there are issues, reject and explain what needs fixing.',
  ].join(' '),

  changelog: [
    'You are a changelog generator with access to git tools.',
    'You MUST use the `sh` tool to run git commands to gather real information.',
    '',
    'WORKFLOW:',
    '1. Run `sh` with command `git log --oneline -30` to see recent commits',
    '2. Run `sh` with command `git tag --sort=-creatordate | head -5` to find latest tags',
    '3. If a previous tag exists, run `sh` with `git log {lastTag}..HEAD --oneline` for changes since last release',
    '4. Analyze the commits and categorize them',
    '5. Suggest a version bump: major (breaking), minor (features), patch (fixes)',
    '',
    'FORMAT: Follow Keep-a-Changelog (https://keepachangelog.com) format.',
    'Group changes under: Added, Changed, Deprecated, Removed, Fixed, Security.',
    '',
    'After analysis, output a JSON block fenced with ```json matching this schema:',
    '{"version": "x.y.z", "date": "YYYY-MM-DD", "summary": "...",',
    ' "versionBump": "major|minor|patch",',
    ' "changes": [{"type": "added|changed|fixed|removed|deprecated|security", "description": "..."}],',
    ' "keepAChangelog": "full formatted markdown for CHANGELOG.md"}',
    '',
    'You may include explanatory text before the JSON block.',
  ].join('\n'),

  'task-parse': [
    'You are a task creation assistant. The user gives you a natural language description of something they want to accomplish in their codebase.',
    'Extract a structured task from it. Output ONLY a JSON block fenced with ```json that matches this schema:',
    '{"title": "concise title under 80 chars", "description": "full description of what needs to be done", "priority": "low|medium|high|critical", "labels": ["optional", "category", "labels"]}',
    'Infer priority from urgency cues (fix/bug/broken → high, improve/refactor → medium, docs/style → low).',
    'If the input is vague, do your best — a reasonable title and description is better than asking for clarification.',
  ].join(' '),
};

// ── Stream event types ─────────────────────────────────────────

export type WorkspaceStreamCallbacks = {
  onTextDelta?: (text: string) => void;
  onToolCall?: (toolCallId: string, toolName: string, args: unknown) => void;
  onToolResult?: (toolCallId: string, toolName: string, result: unknown) => void;
  onToolProgress?: (toolCallId: string, toolName: string, data: unknown) => void;
  onDone?: () => void;
  onCancelled?: () => void;
  onError?: (error: string) => void;
};

// ── History key helper ──────────────────────────────────────────

function getHistoryKey(workspaceId: string, engine: string): string {
  return `ws:${workspaceId}:${engine}`;
}

/** Reset the conversation history for an engine on the server side. */
export function resetEngineConversation(workspaceId: string, engine: string): void {
  const historyKey = getHistoryKey(workspaceId, engine);
  app.workspaceStream.resetHistory(historyKey).catch(() => {});
}

// ── Main streaming function ────────────────────────────────────

/**
 * Stream an LLM response for a workspace engine.
 *
 * Calls the LLM directly via `workspace:stream` IPC (no Mastra agent).
 * Conversation history is maintained server-side per (workspace + engine) pair.
 * Returns a cancel function.
 */
export function streamWorkspaceEngine(opts: {
  workspaceId: string;
  engine: string;
  userMessage: string;
  projectPath: string;
  freshConversation?: boolean;
  executionMode?: 'auto' | 'plan-first' | 'confirm-writes';
} & WorkspaceStreamCallbacks): () => void {
  const { workspaceId, engine, userMessage, projectPath, freshConversation } = opts;

  console.info(`[workspace-agent] streamWorkspaceEngine called: engine=${engine} tools=${engine === 'execution'}`);

  const streamId = `ws-${engine}-${generateId()}`;
  const historyKey = getHistoryKey(workspaceId, engine);
  const systemPrompt = ENGINE_SYSTEM_PROMPTS[engine] ?? '';

  // Enable tools for execution and changelog engines
  const enableTools = engine === 'execution' || engine === 'changelog';

  const messages = [
    { role: 'system', content: `${systemPrompt}\n\nProject directory: ${projectPath}` },
    { role: 'user', content: userMessage },
  ];

  // Subscribe to stream events, filtering to our stream ID
  const unsubscribe = app.workspaceStream.onStreamEvent((event: unknown) => {
    const e = event as {
      streamId: string;
      type: string;
      text?: string;
      toolCallId?: string;
      toolName?: string;
      args?: unknown;
      result?: unknown;
      data?: unknown;
      error?: string;
    };

    if (e.streamId !== streamId) return;

    switch (e.type) {
      case 'text-delta':
        opts.onTextDelta?.(e.text ?? '');
        break;
      case 'tool-call':
        opts.onToolCall?.(e.toolCallId ?? '', e.toolName ?? 'unknown', e.args);
        break;
      case 'tool-result':
        opts.onToolResult?.(e.toolCallId ?? '', e.toolName ?? 'unknown', e.result);
        break;
      case 'tool-progress':
        opts.onToolProgress?.(e.toolCallId ?? '', e.toolName ?? 'unknown', e.data);
        break;
      case 'error':
        opts.onError?.(e.error ?? 'Unknown error');
        cleanup();
        break;
      case 'cancelled':
        // User-initiated stop — use dedicated callback or fall back to onDone
        (opts.onCancelled ?? opts.onDone)?.();
        cleanup();
        break;
      case 'done':
        opts.onDone?.();
        cleanup();
        break;
    }
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    unsubscribe();
  };

  // Fire off the stream (server accumulates history)
  try {
    app.workspaceStream.stream(streamId, historyKey, messages, undefined, freshConversation, enableTools).catch((err: unknown) => {
      console.error('[workspace-agent] Stream promise rejected:', err);
      opts.onError?.((err as Error).message ?? String(err));
      cleanup();
    });
  } catch (err) {
    console.error('[workspace-agent] Stream call threw synchronously:', err);
    opts.onError?.((err as Error).message ?? String(err));
    cleanup();
  }

  // Return cancel function
  return () => {
    app.workspaceStream.cancelStream(streamId).catch(() => {});
    cleanup();
  };
}

// ── JSON extraction helper ─────────────────────────────────────

/**
 * Extract a JSON object from an LLM response that may contain markdown
 * fenced code blocks and/or surrounding explanatory text.
 */
export function extractJsonFromResponse<T = unknown>(text: string): T | null {
  // Try to extract from ```json ... ``` blocks first
  const fencedMatch = text.match(/```json\s*\n?([\s\S]*?)```/);
  if (fencedMatch) {
    try {
      return JSON.parse(fencedMatch[1].trim()) as T;
    } catch { /* fall through */ }
  }

  // Try to extract from plain ``` ... ``` blocks
  const plainFenceMatch = text.match(/```\s*\n?([\s\S]*?)```/);
  if (plainFenceMatch) {
    try {
      return JSON.parse(plainFenceMatch[1].trim()) as T;
    } catch { /* fall through */ }
  }

  // Try to parse the entire text as JSON
  try {
    return JSON.parse(text.trim()) as T;
  } catch { /* fall through */ }

  // Try to find a JSON object in the text
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]) as T;
    } catch { /* fall through */ }
  }

  return null;
}
