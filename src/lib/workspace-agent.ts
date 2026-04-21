/**
 * Workspace Agent — streams LLM responses for workspace engines
 *
 * Each engine (insights, ideation, roadmap, execution, changelog) gets a
 * dedicated conversation with a custom system prompt.  Under the hood this
 * reuses the existing `agent:stream` IPC and `agent:stream-event` broadcast,
 * so every feature of the main chat pipeline (tool use, compaction, etc.) is
 * available to workspace engines automatically.
 */

import { app } from './ipc-client';
import { generateId } from './utils';

// ── Engine system prompts ──────────────────────────────────────

const ENGINE_SYSTEM_PROMPTS: Record<string, string> = {
  insights: [
    'You are a codebase analysis assistant embedded in a workspace IDE.',
    'The user has opened a project and wants to understand their codebase.',
    'Analyze code structure, explain patterns, identify dependencies, and answer questions about the project.',
    'Use the available tools (file_read, list_directory, glob, file_search, sh) to explore the codebase before answering.',
    'Be concise but thorough. Reference specific files and line numbers when relevant.',
  ].join(' '),

  ideation: [
    'You are an AI code improvement analyst. Analyze the user\'s codebase and generate actionable improvement ideas.',
    'Categories to analyze: code quality, performance, security, documentation, UI/UX, architecture.',
    'For each idea: provide a title, description, severity (info/low/medium/high/critical), category (code-improvement/code-quality/performance/security/documentation/ui-ux), affected files, and suggested fix.',
    'Use tools to scan the codebase. After your analysis, output a JSON block fenced with ```json that matches this schema:',
    '{"ideas": [{"title": "...", "description": "...", "category": "code-improvement|code-quality|performance|security|documentation|ui-ux", "severity": "info|low|medium|high|critical", "affectedFiles": ["..."], "suggestedFix": "..."}]}',
    'You may include explanatory text before the JSON block.',
  ].join(' '),

  roadmap: [
    'You are a technical product manager AI. Analyze the user\'s project and generate a development roadmap.',
    'Break the roadmap into phases (3-4 phases). Each phase has features with priorities and effort estimates.',
    'Use tools to understand the current state of the project before planning.',
    'After your analysis, output a JSON block fenced with ```json that matches this schema:',
    '{"phases": [{"name": "...", "description": "...", "features": [{"title": "...", "description": "...", "priority": "low|medium|high|critical", "effort": "small|medium|large|xlarge", "status": "planned|in_progress|completed"}]}]}',
    'You may include explanatory text before the JSON block.',
  ].join(' '),

  planning: [
    'You are a senior software architect planning a code change.',
    'The user will describe a task they want to accomplish in their codebase.',
    'Analyze the codebase using available tools (file_read, list_directory, glob, file_search, sh) to understand the relevant code BEFORE planning.',
    'Explore the project structure, read key files, and understand existing patterns.',
    'After your analysis, output a JSON block fenced with ```json matching this schema:',
    '{"approach": "Description of the overall strategy and why this approach was chosen",',
    '"steps": [{"id": "1", "description": "Specific actionable step", "status": "pending"}, ...],',
    '"filesToModify": ["relative/path/to/file.ts", ...],',
    '"testsToRun": ["npm test -- --filter ...", ...],',
    '"risks": ["Specific risk description", ...]}',
    'Be specific — reference actual files, functions, and patterns you found in the codebase.',
    'Keep steps actionable and ordered. Include 3-8 steps.',
    'Identify real risks based on what you found, not generic ones.',
    'You may include explanatory text before the JSON block.',
  ].join(' '),

  execution: [
    'You are an autonomous software engineer that WRITES CODE. You are NOT an assistant — you are a code implementer.',
    'Your ONLY job is to use tools to make real file changes. You MUST call file_edit, file_write, or sh tools.',
    'WORKFLOW: 1) Use file_read to understand current code. 2) Use file_edit or file_write to make changes. 3) Use sh to run tests.',
    'Start by reading the first file that needs changes, then edit it. Do NOT output analysis without tool calls.',
    'After each plan step is implemented, output: [STEP_COMPLETE:N]',
    'You have FULL permission to edit any file. Do not ask for confirmation. Just do it.',
    'CRITICAL RULE: Your very first action must be a tool call (file_read or list_directory). Never start with just text.',
  ].join(' '),

  review: [
    'You are a senior code reviewer. You are given a task description and the git diff of changes made to fulfill that task.',
    'Review the code changes carefully for: correctness, potential bugs, security issues, code quality, and whether they actually fulfill the task requirements.',
    'After your analysis, you MUST output a JSON block fenced with ```json that matches this schema:',
    '{"approved": true|false, "summary": "one-line summary of your review", "comments": ["specific feedback item 1", "specific feedback item 2"]}',
    'Be specific — reference file names and describe what you found. If the changes look correct and complete, approve. If there are issues, reject and explain what needs fixing.',
  ].join(' '),

  changelog: [
    'You are a release notes generator. Analyze the git history and completed tasks to generate a changelog.',
    'Use the "sh" tool to run "git log" commands to understand recent changes.',
    'Categorize changes as Added, Changed, Fixed, or Removed.',
    'After your analysis, output a JSON block fenced with ```json that matches this schema:',
    '{"version": "x.y.z", "date": "YYYY-MM-DD", "summary": "...", "changes": [{"type": "added|changed|fixed|removed", "description": "..."}]}',
    'You may include explanatory text before the JSON block.',
  ].join(' '),

  'task-parse': [
    'You are a task creation assistant. The user gives you a natural language description of something they want to accomplish in their codebase.',
    'Extract a structured task from it. Output ONLY a JSON block fenced with ```json that matches this schema:',
    '{"title": "concise title under 80 chars", "description": "full description of what needs to be done", "priority": "low|medium|high|critical", "labels": ["optional", "category", "labels"]}',
    'Infer priority from urgency cues (fix/bug/broken → high, improve/refactor → medium, docs/style → low).',
    'If the input is vague, do your best — a reasonable title and description is better than asking for clarification.',
  ].join(' '),
};

// ── Conversation ID tracking ───────────────────────────────────

const conversationMap = new Map<string, string>();

function getConversationKey(workspaceId: string, engine: string): string {
  return `ws:${workspaceId}:${engine}`;
}

function getOrCreateConversationId(workspaceId: string, engine: string): string {
  const key = getConversationKey(workspaceId, engine);
  if (!conversationMap.has(key)) {
    conversationMap.set(key, `workspace-${engine}-${generateId()}`);
  }
  return conversationMap.get(key)!;
}

/** Reset the conversation for an engine, forcing a fresh context on next use. */
export function resetEngineConversation(workspaceId: string, engine: string): void {
  const key = getConversationKey(workspaceId, engine);
  conversationMap.delete(key);
}

// ── Stream event types ─────────────────────────────────────────

export type WorkspaceStreamCallbacks = {
  onTextDelta?: (text: string) => void;
  onToolCall?: (toolCallId: string, toolName: string, args: unknown) => void;
  onToolResult?: (toolCallId: string, toolName: string, result: unknown) => void;
  onToolProgress?: (toolCallId: string, toolName: string, data: unknown) => void;
  onDone?: () => void;
  onError?: (error: string) => void;
};

// ── Main streaming function ────────────────────────────────────

/**
 * Stream an LLM response for a workspace engine.
 *
 * Returns a cancel function.  Calling it aborts the active stream.
 */
export function streamWorkspaceEngine(opts: {
  workspaceId: string;
  engine: string;
  userMessage: string;
  projectPath: string;
  freshConversation?: boolean;
  executionMode?: 'auto' | 'plan-first' | 'confirm-writes';
} & WorkspaceStreamCallbacks): () => void {
  const { workspaceId, engine, userMessage, projectPath, freshConversation, executionMode } = opts;

  // Optionally reset conversation context
  if (freshConversation) {
    resetEngineConversation(workspaceId, engine);
  }

  const conversationId = getOrCreateConversationId(workspaceId, engine);
  const systemPrompt = ENGINE_SYSTEM_PROMPTS[engine] ?? '';

  // Build the message list: system prompt first, then the user message
  const messages = [
    {
      role: 'system',
      content: [{ type: 'text', text: `${systemPrompt}\n\nProject directory: ${projectPath}` }],
    },
    {
      role: 'user',
      content: [{ type: 'text', text: userMessage }],
    },
  ];

  // Subscribe to stream events, filtering to our conversation
  const unsubscribe = app.agent.onStreamEvent((event: unknown) => {
    const e = event as {
      conversationId: string;
      type: string;
      text?: string;
      toolCallId?: string;
      toolName?: string;
      args?: unknown;
      result?: unknown;
      error?: string;
      data?: unknown;
      subAgentConversationId?: string;
      approvalStatus?: string;
      approvalId?: string;
    };

    // Ignore events for other conversations and sub-agent events
    if (e.conversationId !== conversationId) return;
    if (e.subAgentConversationId) return;

    // Auto-approve any tool calls waiting for approval (workspace execution is autonomous)
    if (e.approvalStatus === 'pending' && e.toolCallId) {
      app.agent.approveToolCall(e.toolCallId).catch(() => {});
    }

    switch (e.type) {
      case 'text-delta':
        opts.onTextDelta?.(e.text ?? '');
        break;
      case 'tool-call':
        // Auto-answer ask_user tools (execution is autonomous)
        if (e.toolName === 'ask_user' && e.toolCallId) {
          app.agent.answerToolQuestion(e.toolCallId, { answer: 'Yes, proceed with the implementation.' }).catch(() => {});
        }
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

  // Fire off the stream via the existing IPC
  app.agent.stream(
    conversationId,
    messages,
    undefined,  // use default model key
    'medium',   // reasoning effort
    undefined,  // profile key
    false,      // fallback enabled
    projectPath,
    executionMode ?? 'auto',  // default to auto for workspace engines
  ).catch((err: unknown) => {
    opts.onError?.((err as Error).message ?? String(err));
    cleanup();
  });

  // Return cancel function
  return () => {
    app.agent.cancelStream(conversationId).catch(() => { /* ignore cancel errors */ });
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
