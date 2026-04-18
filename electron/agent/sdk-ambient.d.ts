/**
 * Ambient type declarations for optional agent SDK dependencies.
 * These packages are dynamically imported at runtime; the declarations
 * allow TypeScript to type-check the import() calls even when the
 * packages are not installed.
 */

declare module '@anthropic-ai/claude-agent-sdk' {
  export interface ClaudeAgentOptions {
    systemPrompt?: string;
    cwd?: string;
    maxTurns?: number;
    env?: Record<string, string>;
    allowedTools?: string[];
    [key: string]: unknown;
  }

  export function query(params: {
    prompt: string;
    options?: ClaudeAgentOptions;
  }): AsyncIterable<unknown>;
}

declare module '@openai/codex-sdk' {
  export interface CodexOptions {
    env?: Record<string, string>;
    apiKey?: string;
    baseUrl?: string;
    codexPathOverride?: string;
    config?: Record<string, unknown>;
  }

  export interface CodexThreadOptions {
    workingDirectory?: string;
    skipGitRepoCheck?: boolean;
    model?: string;
    [key: string]: unknown;
  }

  export interface CodexRunStreamedResult {
    events: AsyncIterable<unknown>;
  }

  export interface CodexThread {
    run(prompt: string, options?: Record<string, unknown>): Promise<unknown>;
    runStreamed(prompt: string, options?: Record<string, unknown>): Promise<CodexRunStreamedResult>;
  }

  export class Codex {
    constructor(options?: CodexOptions);
    startThread(options?: CodexThreadOptions): CodexThread;
    resumeThread(id: string, options?: CodexThreadOptions): CodexThread;
  }
}
