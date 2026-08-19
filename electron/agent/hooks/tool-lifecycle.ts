import { redactBrowserToolArgsForExposure, redactBrowserToolErrorForExposure } from '../../../shared/browser.js';
import { hookDispatcher } from './dispatcher.js';

export type PreparedToolUse =
  | {
      allowed: true;
      args: unknown;
      exposedArgs: unknown;
    }
  | {
      allowed: false;
      args: { redacted: true; reason: string };
      exposedArgs: { redacted: true; reason: string };
      result: { isError: true; error: string };
    };

/** Apply PreToolUse at execution boundaries that do not pass through the
 * Mastra runtime. Browser typing is redacted before hook fan-out, and a denied
 * call replaces its arguments with a reason-only sentinel so PostToolUse and
 * the provider can never recover the rejected raw payload. */
export async function prepareToolUseWithHooks(
  conversationId: string,
  toolCallId: string,
  toolName: string,
  args: unknown,
): Promise<PreparedToolUse> {
  const exposedArgs = redactBrowserToolArgsForExposure(toolName, args);
  const preTool = await hookDispatcher.dispatch('PreToolUse', {
    conversationId,
    toolCallId,
    toolName,
    args: exposedArgs,
  });
  if (preTool.denied) {
    const reason = preTool.reason ?? 'Blocked by PreToolUse hook.';
    const deniedArgs = { redacted: true as const, reason };
    return {
      allowed: false,
      args: deniedArgs,
      exposedArgs: deniedArgs,
      result: { isError: true, error: reason },
    };
  }
  const replacement = preTool.modified ? (preTool.payload as { args?: unknown } | undefined)?.args : undefined;
  const effectiveArgs = replacement !== undefined ? replacement : args;
  return {
    allowed: true,
    args: effectiveArgs,
    exposedArgs: redactBrowserToolArgsForExposure(toolName, effectiveArgs),
  };
}

export type PostToolUseResult = {
  result: unknown;
  denied: boolean;
  modified: boolean;
};

/** Apply PostToolUse before a result crosses back into an inference provider
 * or Realtime transport. */
export async function applyPostToolUseHooks(
  conversationId: string,
  toolCallId: string,
  toolName: string,
  exposedArgs: unknown,
  result: unknown,
): Promise<PostToolUseResult> {
  const postTool = await hookDispatcher.dispatch('PostToolUse', {
    conversationId,
    toolCallId,
    toolName,
    args: exposedArgs,
    result,
  });
  if (postTool.denied) {
    return {
      result: { isError: true, error: postTool.reason ?? 'Blocked by PostToolUse hook.' },
      denied: true,
      modified: postTool.modified,
    };
  }
  const replacement = postTool.modified ? (postTool.payload as { result?: unknown } | undefined)?.result : undefined;
  return {
    result: replacement !== undefined ? replacement : result,
    denied: false,
    modified: postTool.modified,
  };
}

export type ToolLifecycleExecution = {
  conversationId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  validate: (args: unknown) => unknown;
  execute: (args: unknown) => Promise<unknown>;
};

/** Execute a tool at an inference-runtime bridge boundary while preserving the
 * same enforcing lifecycle contract as the native Mastra and Realtime paths.
 * Validation deliberately runs after PreToolUse so a modify hook can replace
 * the input, and execution/validation failures still pass through PostToolUse
 * before anything is returned to the provider. */
export async function executeToolWithLifecycleHooks(options: ToolLifecycleExecution): Promise<unknown> {
  const { conversationId, toolCallId, toolName } = options;
  const prepared = await prepareToolUseWithHooks(conversationId, toolCallId, toolName, options.args);
  if (!prepared.allowed) {
    return (await applyPostToolUseHooks(conversationId, toolCallId, toolName, prepared.exposedArgs, prepared.result))
      .result;
  }

  let validatedArgs: unknown;
  try {
    validatedArgs = options.validate(prepared.args);
  } catch (error) {
    const errorResult = { isError: true as const, error: redactBrowserToolErrorForExposure(toolName, error) };
    const postTool = await applyPostToolUseHooks(
      conversationId,
      toolCallId,
      toolName,
      prepared.exposedArgs,
      errorResult,
    );
    if (postTool.denied || postTool.modified) return postTool.result;
    throw new Error(errorResult.error);
  }

  const exposedArgs = redactBrowserToolArgsForExposure(toolName, validatedArgs);
  let result: unknown;
  try {
    result = await options.execute(validatedArgs);
  } catch (error) {
    const errorResult = { isError: true as const, error: redactBrowserToolErrorForExposure(toolName, error) };
    const postTool = await applyPostToolUseHooks(conversationId, toolCallId, toolName, exposedArgs, errorResult);
    if (postTool.denied || postTool.modified) return postTool.result;
    throw new Error(errorResult.error);
  }

  return (await applyPostToolUseHooks(conversationId, toolCallId, toolName, exposedArgs, result)).result;
}
