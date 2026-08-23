import { z } from 'zod';
import type { AppConfig } from '../config/schema.js';
import { getBrowserManager } from '../browser/service.js';
import type {
  BrowserAutofillApproval,
  BrowserDocumentApproval,
  BrowserTabsApproval,
  BrowserTabsReadApproval,
} from '../browser/manager.js';
import { browserActionRequestSchema, browserScreenshotToolInputSchema } from '../browser/input-validation.js';
import { MAX_BROWSER_URL_CHARS } from '../browser/metadata.js';
import { fitBrowserScreenshotForModel } from '../browser/screenshots.js';
import { sanitizeBrowserNetworkError } from '../browser/network-diagnostics.js';
import { broadcastStreamEventRaw, registerPendingApproval } from '../ipc/tool-approval.js';
import type {
  BrowserActionRequest,
  BrowserControlPolicy,
  BrowserManagerState,
  BrowserTab,
} from '../../shared/browser.js';
import { redactBrowserToolArgsForExposure, redactBrowserToolErrorForExposure } from '../../shared/browser.js';
import type { ToolDefinition, ToolExecutionContext } from './types.js';

const MAX_APPROVAL_ARGUMENT_CHARS = 12_000;

type BrowserApprovalTarget = Pick<BrowserDocumentApproval, 'tabId' | 'origin'> & { destinationOrigin?: string };

function assistantVisiblePageIdentity(page: Pick<BrowserTab, 'title' | 'url' | 'sensitive'>): {
  title: string;
  url: string;
  redacted: boolean;
} {
  if (page.sensitive) return { title: 'Sensitive page', url: 'about:blank', redacted: true };
  if (page.url === 'about:blank') {
    return { title: 'New tab', url: page.url, redacted: page.title !== 'New tab' };
  }
  try {
    const parsed = new URL(page.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      // User-owned tabs may display file:, data:, blob:, or custom-scheme
      // content that assistant control intentionally cannot access. Do not turn
      // tab listing into a side channel for local paths or inline payloads.
      return { title: 'Private page', url: 'about:blank', redacted: true };
    }
    // Tab visibility needs the site identity, not page-controlled titles or
    // secret-bearing path, query, fragment, or URL credentials. Authenticated
    // sites routinely put account names and document subjects in titles.
    const safeUrl = parsed.origin;
    return {
      title: safeUrl,
      url: safeUrl,
      redacted: safeUrl !== page.url || page.title !== safeUrl,
    };
  } catch {
    return { title: 'Private page', url: 'about:blank', redacted: true };
  }
}

function assistantVisibleTab(tab: BrowserTab): BrowserTab {
  // Favicons and native error details are renderer-only chrome. Remote pages
  // can provide arbitrarily large data URLs, while persistence errors can carry
  // local filesystem paths, so neither belongs in model-facing tool results.
  const identity = assistantVisiblePageIdentity(tab);
  const { documentToken: _documentToken, ...visibleTab } = tab;
  return {
    ...visibleTab,
    title: identity.title,
    url: identity.url,
    favicon: undefined,
    error: undefined,
  };
}

function assistantVisibleState(state: BrowserManagerState): BrowserManagerState {
  // Native auth, permission, and password-save prompts are renderer-only UI.
  // Keep this boundary allowlisted so identities, origins, realms, or future
  // prompt fields can never drift into a model-facing browser_tabs result.
  return {
    conversationId: state.conversationId,
    tabs: state.tabs.map(assistantVisibleTab),
    activeTabId: state.activeTabId,
  };
}

function boundedApprovalValue(value: unknown, budget: { remaining: number; truncated: boolean }, depth = 0): unknown {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const keep = Math.max(0, Math.min(value.length, budget.remaining));
    budget.remaining -= keep;
    if (keep === value.length) return value;
    budget.truncated = true;
    return `${value.slice(0, keep)}… [truncated]`;
  }
  if (depth >= 5 || budget.remaining <= 0) {
    budget.truncated = true;
    return '[truncated]';
  }
  if (Array.isArray(value)) {
    if (value.length > 50) budget.truncated = true;
    return value.slice(0, 50).map((item) => boundedApprovalValue(item, budget, depth + 1));
  }
  if (typeof value !== 'object') return String(value);
  const output: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 50) budget.truncated = true;
  for (const [key, item] of entries.slice(0, 50)) {
    if (budget.remaining <= 0) {
      output._truncated = true;
      budget.truncated = true;
      break;
    }
    if (key.length > 200) budget.truncated = true;
    output[key.slice(0, 200)] = boundedApprovalValue(item, budget, depth + 1);
  }
  return output;
}

/** Preserve the actual operation the user is approving while bounding the
 * event that is persisted and rendered in approval UIs. Typed page content is
 * always transient: the target may be a password, OTP, or token field whose
 * semantics cannot be trusted until after approval. */
export function browserApprovalArgs(
  toolName: string,
  input: unknown,
  reason: string,
  target?: BrowserApprovalTarget,
): Record<string, unknown> {
  const displayInput = redactBrowserToolArgsForExposure(toolName, input);
  const displayTarget = target
    ? {
        tabId: target.tabId,
        origin: '[redacted Browser origin]',
        ...(target.destinationOrigin ? { destinationOrigin: '[redacted Browser origin]' } : {}),
      }
    : undefined;
  const source =
    displayInput && typeof displayInput === 'object' && !Array.isArray(displayInput)
      ? { ...(displayInput as Record<string, unknown>), ...(displayTarget ? { target: displayTarget } : {}) }
      : { input: displayInput, ...(displayTarget ? { target: displayTarget } : {}) };
  const budget = { remaining: MAX_APPROVAL_ARGUMENT_CHARS, truncated: false };
  const bounded = boundedApprovalValue(source, budget);
  if (budget.truncated) {
    throw new Error('This Browser operation is too large to display completely for approval. Shorten it and retry.');
  }
  const details =
    bounded && typeof bounded === 'object' && !Array.isArray(bounded)
      ? (bounded as Record<string, unknown>)
      : { input: bounded };
  return { ...details, approvalKind: 'browser-control', reason };
}

function capturedApprovalTarget(value: unknown): BrowserApprovalTarget | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as { tabId?: unknown; origin?: unknown; destinationOrigin?: unknown };
  return typeof candidate.tabId === 'string' && typeof candidate.origin === 'string'
    ? {
        tabId: candidate.tabId,
        origin: candidate.origin,
        ...(typeof candidate.destinationOrigin === 'string' ? { destinationOrigin: candidate.destinationOrigin } : {}),
      }
    : undefined;
}

function conversationId(context: ToolExecutionContext): string {
  if (!context.conversationId) throw new Error('Browser tools require an active chat.');
  return context.conversationId;
}

function assistantRun(
  context: ToolExecutionContext,
  activeConversationId: string,
): { id: string; abortSignal?: AbortSignal } {
  if (!context.browserOwnerId) throw new Error('Browser tools require assistant turn ownership.');
  const run = { id: context.browserOwnerId, abortSignal: context.abortSignal };
  getBrowserManager().assertAssistantRun(activeConversationId, run);
  return run;
}

function assistantTargetResolver(
  manager: ReturnType<typeof getBrowserManager>,
  activeConversationId: string,
  requestedTabId: string | undefined,
  run: { id: string; abortSignal?: AbortSignal },
): (commit?: boolean) => string {
  let previewedTabId: string | undefined;
  return (commit = false) => {
    if (!commit) {
      previewedTabId ??= manager.previewAssistantTabId(activeConversationId, requestedTabId, run);
      return previewedTabId;
    }
    // Ask-policy capture is descriptive only. Commit the exact previewed tab
    // only after approval succeeds so a denial cannot mutate this run's
    // implicit background target.
    return manager.resolveAssistantTabId(activeConversationId, previewedTabId ?? requestedTabId, run);
  };
}

function assertBrowserToolAvailable(getConfig: () => AppConfig, context: ToolExecutionContext): void {
  if (context.abortSignal?.aborted) throw new Error('Browser action was cancelled.');
  if (!getConfig().browser.enabled) throw new Error('The in-app browser is disabled in Settings.');
}

async function enforcePolicy<Approval = never>(
  getPolicy: () => BrowserControlPolicy,
  toolName: string,
  reason: string,
  input: unknown,
  context: ToolExecutionContext,
  denyMessage = `${toolName} is disabled in Browser Settings.`,
  captureApproval?: () => Approval | Promise<Approval>,
): Promise<Approval | undefined> {
  const policy = getPolicy();
  if (policy === 'deny') throw new Error(denyMessage);
  if (policy !== 'ask') return undefined;
  if (!context.conversationId || !context.toolCallId || !context.abortSignal || context.isHeadless) {
    throw new Error(`${toolName} requires approval from a live user.`);
  }
  const approval = await captureApproval?.();
  const approvalTarget = capturedApprovalTarget(approval);
  const decisionPromise = registerPendingApproval(context.toolCallId, context.abortSignal, 'native-browser', {
    conversationId: context.conversationId,
    browserOwnerId: context.browserOwnerId,
    // The persisted/broadcast approval event stays redacted. The exact input is
    // retained only for the lifetime of this pending approval and is available
    // through an authority-checked native IPC so the user can make an informed
    // decision (especially for arbitrary browser_evaluate JavaScript).
    privateDetails: {
      browserInput: input,
      ...(approvalTarget ? { browserTarget: approvalTarget } : {}),
    },
  });
  broadcastStreamEventRaw({
    conversationId: context.conversationId,
    type: 'tool-approval-required',
    toolCallId: context.toolCallId,
    runGeneration: context.browserOwnerId, // R254: run-scope the pop-out (see mcp-manage)
    toolName,
    args: browserApprovalArgs(toolName, input, reason, approvalTarget),
  });
  const decision = await decisionPromise;
  if (decision !== true)
    throw new Error(decision === 'dismiss' ? 'Browser approval was dismissed.' : 'Browser approval was denied.');
  // Approval authorizes the call under the policy shown to the user; it must
  // not preserve an allow-capability if Settings changed to deny while the
  // prompt was waiting.
  if (getPolicy() === 'deny') throw new Error(denyMessage);
  return approval;
}

const tabId = z.string().uuid().optional().describe("Tab id. Omit to use this assistant run's current background tab.");

export function createBrowserTools(getConfig: () => AppConfig): ToolDefinition[] {
  const browserTabs: ToolDefinition = {
    name: 'browser_tabs',
    description:
      'List and manage the current chat’s in-app Chromium tabs. Tabs load and remain controllable in the background without the Browser sidebar being mounted, visible, or focused. Assistant tabs close when the turn ends unless keep_open is set.',
    inputSchema: z.object({
      action: z.enum([
        'list',
        'open',
        'close',
        'duplicate',
        'reopen_closed',
        'keep_open',
        'close_others',
        'close_right',
      ]),
      tabId,
      url: z.string().max(MAX_BROWSER_URL_CHARS).optional().describe('URL or search query for open.'),
      background: z.boolean().optional(),
    }),
    execute: async (input, context) => {
      assertBrowserToolAvailable(getConfig, context);
      const payload = input as {
        action:
          | 'list'
          | 'open'
          | 'close'
          | 'duplicate'
          | 'reopen_closed'
          | 'keep_open'
          | 'close_others'
          | 'close_right';
        tabId?: string;
        url?: string;
        background?: boolean;
      };
      const cid = conversationId(context);
      const manager = getBrowserManager();
      const run = assistantRun(context, cid);
      if (payload.action === 'list') {
        const approvedTabs = await enforcePolicy<BrowserTabsReadApproval>(
          () => getConfig().browser.readAccess ?? 'allow',
          'browser_tabs',
          'List browser tabs for the current chat',
          payload,
          context,
          undefined,
          () => manager.captureTabsReadApproval(cid),
        );
        assertBrowserToolAvailable(getConfig, context);
        if (approvedTabs) manager.assertTabsReadApproval(cid, approvedTabs);
        // Another Browser policy can revoke the whole assistant capability while
        // a read-only approval remains on screen. Never expose even an unchanged
        // tab snapshot after that run has ended.
        manager.assertAssistantRun(cid, run);
        return assistantVisibleState(manager.getState(cid));
      }
      const tabsAction = payload.action as BrowserTabsApproval['action'];
      const requiresTarget = payload.action !== 'open' && payload.action !== 'reopen_closed';
      const resolveTarget = assistantTargetResolver(manager, cid, payload.tabId, run);
      const approvedTabs = await enforcePolicy<BrowserTabsApproval>(
        () => getConfig().browser.structuredActions,
        'browser_tabs',
        `Manage browser tab: ${payload.action}`,
        payload,
        context,
        undefined,
        () => manager.captureTabsApproval(cid, tabsAction, requiresTarget ? resolveTarget() : undefined, run),
      );
      assertBrowserToolAvailable(getConfig, context);
      if (payload.action === 'open') {
        const opened = await manager.createTab(
          {
            conversationId: cid,
            url: payload.url,
            background: payload.background,
            owner: 'assistant',
          },
          run,
        );
        return { ok: true, action: payload.action, tabId: opened.id };
      }
      if (payload.action === 'reopen_closed') {
        const reopened = await manager.reopenClosedTab(cid, 'assistant', run, approvedTabs);
        return { ok: reopened !== null, action: payload.action, tabId: reopened?.id ?? null };
      }
      const targetTabId = resolveTarget(true);
      if (payload.action === 'duplicate') {
        const duplicated = await manager.duplicateAssistantTab(cid, targetTabId!, run, approvedTabs);
        return { ok: true, action: payload.action, tabId: duplicated.id };
      }
      const command =
        payload.action === 'keep_open'
          ? 'keep-open'
          : (payload.action.replaceAll('_', '-') as Parameters<typeof manager.commandTab>[2]);
      await manager.commandTab(cid, targetTabId!, command, 'assistant', run, approvedTabs);
      // Mutation authority is independent from Browser read authority. Return
      // only an operation receipt; a full tab inventory would let an allowlisted
      // structured action bypass readAccess=deny/ask and enumerate origins.
      return { ok: true, action: payload.action, tabId: targetTabId };
    },
  };

  const browserInspect: ToolDefinition = {
    name: 'browser_inspect',
    description:
      'Inspect page text and interactive elements in a current-chat browser tab, including while the Browser sidebar is hidden or unmounted. Password values are excluded, and inspection is blocked while password data is present.',
    inputSchema: z.object({ tabId }),
    execute: async (input, context) => {
      assertBrowserToolAvailable(getConfig, context);
      const payload = input as { tabId?: string };
      const cid = conversationId(context);
      const manager = getBrowserManager();
      const run = assistantRun(context, cid);
      const resolveTarget = assistantTargetResolver(manager, cid, payload.tabId, run);
      const approvedDocument = await enforcePolicy<BrowserDocumentApproval>(
        () => getConfig().browser.readAccess ?? 'allow',
        'browser_inspect',
        'Inspect the current web page',
        payload,
        context,
        undefined,
        () => manager.captureDocumentApproval(cid, resolveTarget(), run),
      );
      assertBrowserToolAvailable(getConfig, context);
      const targetTabId = resolveTarget(true);
      const inspection = await manager.inspect(cid, approvedDocument?.tabId ?? targetTabId, run, approvedDocument);
      const identity = assistantVisiblePageIdentity({ ...inspection, sensitive: false });
      return { ...inspection, title: identity.title, url: identity.url };
    },
  };

  const browserNetwork: ToolDefinition = {
    name: 'browser_network',
    description:
      'Inspect bounded page-load timings and recent network requests for a current-chat Browser tab, including during background operation with no mounted sidebar. Request and response bodies, headers, hostnames, credentials, paths, query strings, and fragments are never returned; opaque origin tokens correlate requests safely. Can wait for the load event or a network-idle window.',
    inputSchema: z.object({
      tabId,
      waitFor: z.enum(['none', 'load', 'network-idle']).optional().default('none'),
      limit: z.number().int().min(1).max(100).optional().default(50),
      timeoutMs: z.number().int().min(100).max(30_000).optional().default(10_000),
      idleMs: z.number().int().min(100).max(5_000).optional().default(500),
    }),
    execute: async (input, context) => {
      assertBrowserToolAvailable(getConfig, context);
      const payload = input as {
        tabId?: string;
        waitFor?: 'none' | 'load' | 'network-idle';
        limit?: number;
        timeoutMs?: number;
        idleMs?: number;
      };
      const cid = conversationId(context);
      const manager = getBrowserManager();
      const run = assistantRun(context, cid);
      const resolveTarget = assistantTargetResolver(manager, cid, payload.tabId, run);
      const approvedDocument = await enforcePolicy<BrowserDocumentApproval>(
        () => getConfig().browser.readAccess ?? 'allow',
        'browser_network',
        'Inspect page-load timing and recent network requests',
        payload,
        context,
        undefined,
        () => manager.captureDocumentApproval(cid, resolveTarget(), run),
      );
      assertBrowserToolAvailable(getConfig, context);
      const targetTabId = resolveTarget(true);
      const request = { ...payload, tabId: approvedDocument?.tabId ?? targetTabId };
      try {
        return await manager.networkDiagnostics(cid, request, run, approvedDocument);
      } catch (error) {
        // The network tool promises not to expose hostnames. The generic
        // Browser sanitizer intentionally retains bare HTTP(S) origins, so
        // collapse native/load failures to bounded Chromium error codes here.
        throw new Error(sanitizeBrowserNetworkError(error) ?? 'Network request failed.');
      }
    },
  };

  const browserAction: ToolDefinition = {
    name: 'browser_action',
    description:
      'Interact with the in-app Chromium browser using real mouse/keyboard input or semantic element targeting. No mounted, visible, or focused Browser sidebar is required; when the sidebar is already open it mirrors actions live.',
    inputSchema: browserActionRequestSchema,
    execute: async (input, context) => {
      assertBrowserToolAvailable(getConfig, context);
      const payload = input as BrowserActionRequest;
      const cid = conversationId(context);
      const manager = getBrowserManager();
      const run = assistantRun(context, cid);
      const resolveTarget = assistantTargetResolver(manager, cid, payload.tabId, run);
      const approvedDocument = await enforcePolicy<BrowserDocumentApproval>(
        () => getConfig().browser.structuredActions,
        'browser_action',
        'Interact with the current web page',
        payload,
        context,
        undefined,
        () => manager.captureDocumentApproval(cid, resolveTarget(), run),
      );
      assertBrowserToolAvailable(getConfig, context);
      const targetTabId = resolveTarget(true);
      const request = { ...payload, tabId: approvedDocument?.tabId ?? targetTabId };
      const result = approvedDocument
        ? await manager.action(cid, request, run, approvedDocument)
        : await manager.action(cid, request, run);
      // Structured-action authority does not grant read authority. Return only
      // a receipt; callers must use browser_tabs under readAccess to inspect the
      // resulting page or tab metadata.
      return { ok: result.ok, action: payload.kind, tabId: result.tab.id };
    },
  };

  const browserScreenshot: ToolDefinition = {
    name: 'browser_screenshot',
    description:
      'Capture the browser viewport, complete page, or a CSS-selected component even while the Browser sidebar is hidden or unmounted. The image is returned directly to the model and can optionally be retained as a Kai media file.',
    inputSchema: browserScreenshotToolInputSchema,
    execute: async (input, context) => {
      assertBrowserToolAvailable(getConfig, context);
      const payload = input as {
        tabId?: string;
        mode: 'viewport' | 'full-page' | 'element';
        selector?: string;
        saveToFile?: boolean;
      };
      const cid = conversationId(context);
      const manager = getBrowserManager();
      const run = assistantRun(context, cid);
      const resolveTarget = assistantTargetResolver(manager, cid, payload.tabId, run);
      const approvedDocument = await enforcePolicy<BrowserDocumentApproval>(
        () => getConfig().browser.readAccess ?? 'allow',
        'browser_screenshot',
        `Capture a ${payload.mode} screenshot of the current web page`,
        payload,
        context,
        undefined,
        () => manager.captureDocumentApproval(cid, resolveTarget(), run),
      );
      assertBrowserToolAvailable(getConfig, context);
      const targetTabId = resolveTarget(true);
      const request = { ...payload, tabId: approvedDocument?.tabId ?? targetTabId };
      const { shot, modelImage } = await manager.screenshot(
        cid,
        request,
        'assistant',
        run,
        async (captured, abortSignal) => {
          if (abortSignal?.aborted) throw new Error('Browser screenshot processing was cancelled.');
          if (!captured.dataUrl) throw new Error('The browser screenshot did not return image data.');
          const separator = captured.dataUrl.indexOf(',');
          if (separator < 0) throw new Error('The browser screenshot returned malformed image data.');
          const original = Buffer.from(captured.dataUrl.slice(separator + 1), 'base64');
          const fitted = await fitBrowserScreenshotForModel(
            original,
            captured.width,
            captured.height,
            undefined,
            undefined,
            abortSignal,
          );
          if (abortSignal?.aborted) throw new Error('Browser screenshot processing was cancelled.');
          return { shot: captured, modelImage: fitted };
        },
        approvedDocument,
      );
      return {
        tabId: shot.tabId,
        mode: shot.mode,
        width: modelImage.width,
        height: modelImage.height,
        mimeType: modelImage.mimeType,
        ...(modelImage.width !== shot.width || modelImage.height !== shot.height
          ? { originalWidth: shot.width, originalHeight: shot.height }
          : {}),
        filePath: shot.filePath,
        _modelContent: [{ type: 'image', data: modelImage.data.toString('base64'), mediaType: modelImage.mimeType }],
      };
    },
  };

  const browserEvaluate: ToolDefinition = {
    name: 'browser_evaluate',
    description:
      'Run JavaScript in a current-chat page in the background and return a bounded JSON-serializable result; no mounted Browser sidebar is required. Controlled separately by the Browser script-injection policy.',
    inputSchema: z.object({ tabId, script: z.string().min(1).max(100_000) }),
    execute: async (input, context) => {
      assertBrowserToolAvailable(getConfig, context);
      const payload = input as { tabId?: string; script: string };
      const cid = conversationId(context);
      const manager = getBrowserManager();
      const run = assistantRun(context, cid);
      const resolveTarget = assistantTargetResolver(manager, cid, payload.tabId, run);
      const approvedDocument = await enforcePolicy<BrowserDocumentApproval>(
        () => getConfig().browser.scriptInjection,
        'browser_evaluate',
        'Run JavaScript in the current web page',
        payload,
        context,
        undefined,
        () => manager.captureDocumentApproval(cid, resolveTarget(), run),
      );
      assertBrowserToolAvailable(getConfig, context);
      const targetTabId = resolveTarget(true);
      return {
        result: approvedDocument
          ? await manager.evaluate(cid, payload.script, approvedDocument.tabId, run, approvedDocument)
          : await manager.evaluate(cid, payload.script, targetTabId, run),
      };
    },
  };

  const browserAutofill: ToolDefinition = {
    name: 'browser_autofill',
    description:
      'Fill a matching saved credential into the current page without revealing the password, including while the Browser sidebar is hidden or unmounted. Availability follows the Browser password AI-access policy.',
    inputSchema: z.object({ tabId, credentialId: z.string().uuid().optional() }),
    execute: async (input, context) => {
      assertBrowserToolAvailable(getConfig, context);
      const payload = input as { tabId?: string; credentialId?: string };
      const cid = conversationId(context);
      const manager = getBrowserManager();
      const run = assistantRun(context, cid);
      const resolveTarget = assistantTargetResolver(manager, cid, payload.tabId, run);
      const passwordPolicy = (): BrowserControlPolicy => {
        const policy = getConfig().browser.passwordAccess;
        return policy === 'automatic' ? 'allow' : policy === 'ask' ? 'ask' : 'deny';
      };
      const approvedDocument = await enforcePolicy<BrowserAutofillApproval>(
        passwordPolicy,
        'browser_autofill',
        'Fill a saved password without revealing it',
        payload,
        context,
        'Saved-password autofill is user-only in Browser Settings.',
        () => manager.captureAutofillApproval(cid, resolveTarget(), payload.credentialId, run),
      );
      assertBrowserToolAvailable(getConfig, context);
      const targetTabId = resolveTarget(true);
      const resolvedTabId = approvedDocument?.tabId ?? targetTabId;
      if (approvedDocument) {
        await manager.autofill(cid, resolvedTabId, payload.credentialId, 'assistant', run, approvedDocument);
      } else {
        await manager.autofill(cid, resolvedTabId, payload.credentialId, 'assistant', run);
      }
      return { filled: true, tabId: resolvedTabId, passwordExposed: false };
    },
  };

  return [
    browserTabs,
    browserInspect,
    browserNetwork,
    browserAction,
    browserScreenshot,
    browserEvaluate,
    browserAutofill,
  ].map((tool) => {
    const execute = tool.execute;
    return {
      ...tool,
      source: 'browser' as const,
      execute: async (input: unknown, context: ToolExecutionContext) => {
        try {
          return await execute(input, context);
        } catch (error) {
          throw new Error(redactBrowserToolErrorForExposure(tool.name, error));
        }
      },
    };
  });
}
