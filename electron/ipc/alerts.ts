/**
 * Alerts IPC — the runtime layer over the pure `alert-store`.
 *
 * Automation (headless) runs raise alerts via the `request_review` tool or the
 * `ask_user` headless fallback. This module:
 *   - exposes `alerts:*` IPC (list/get/answer/decide/dismiss/unreadCount),
 *   - fires an OS notification + broadcasts `alerts:changed` when an alert is
 *     created (so the tab badge and optional front-most modal react live),
 *   - on answer/decide, re-injects the user's response as a NEW turn into the
 *     originating conversation (reusing the automation agent-run machinery via
 *     `resumeConversationWithMessage`) so the suspended run continues.
 *
 * Bridge parity: every channel here is mirrored in web-server.ts + preload.ts.
 */
import { BrowserWindow, Notification, type IpcMain } from 'electron';
import {
  createAlert,
  readAlert,
  listAlerts,
  openAlertCount,
  resolveAlert,
  reopenAlert,
  dismissAlert,
  type Alert,
  type CreateAlertInput,
} from './alert-store.js';
import { readConversation } from './conversation-store.js';
import { resumeConversationWithMessage, type ActionDeps } from '../automations/actions.js';
import { setAlertCreatedHandler } from './alert-notify.js';
import { setRecoveredAnswerDeliverer } from '../tools/ask-user.js';
import { isGuiFocused } from '../agent/kai-presence.js';
import { traceDiagnostic } from '../diagnostics/debug-trace.js';
import { broadcastToAllWindows } from '../utils/window-send.js';
import { openNotificationWindow, closeNotificationWindow } from '../notification-window.js';

/** Deps the alerts layer needs: where alerts live + how to resume a conversation. */
export interface AlertsDeps {
  appHome: string;
  /** Full automation ActionDeps so we can reuse `resumeConversationWithMessage`. */
  getActionDeps: () => ActionDeps;
  /** Effective alert surface (mutually exclusive): 'off' | 'modal' | 'window'. */
  alertSurface: () => 'off' | 'modal' | 'window';
}

let deps: AlertsDeps | null = null;

/** Wire up the alerts layer. Called once from main.ts after the automation engine exists. */
export function initializeAlerts(d: AlertsDeps): void {
  deps = d;
  // Let the tools layer (request_review / ask_user fallback) trigger OS
  // notifications + UI broadcasts after it writes the alert store directly.
  setAlertCreatedHandler(notifyNewAlert);
  // Let the ask_user raced-answer machinery deliver an answer whose run finished
  // before consuming it (ordinary completion + in-flight delivery + no genuine
  // successor) — into the ORIGIN conversation as a labeled turn, with a persistent
  // Alert as the durable fallback (see deliverRecoveredAnswer). Wired here (not a
  // direct import in agent.ts) so the tools/agent layers stay free of the
  // automations/alerts graph — mirrors setAlertCreatedHandler.
  setRecoveredAnswerDeliverer(deliverRecoveredAnswer);
}

/** Allocate a stable user-turn id GUARANTEED not to collide with an existing node in
 *  the conversation tree. A colliding id would be reminted by appendConversationMessages,
 *  so the persisted node's id would differ from the requested one and the commit-check
 *  by-id would false-negative (→ reopen → duplicate). Random ids make a collision
 *  astronomically unlikely, but verify against the current tree and regenerate to be
 *  safe (R105 finding-1). */
function allocateFreshTurnId(appHome: string, conversationId: string, prefix: string): string {
  let existing: Set<string>;
  try {
    const conv = readConversation(appHome, conversationId) as { messageTree?: Array<{ id?: unknown }> } | null;
    existing = new Set((conv?.messageTree ?? []).map((m) => (typeof m?.id === 'string' ? m.id : '')).filter(Boolean));
  } catch {
    existing = new Set();
  }
  for (let i = 0; i < 8; i++) {
    const id = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    if (!existing.has(id)) return id;
  }
  // Astronomically unreachable; fall back to a highly-entropic id.
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** Collect the conversation's persisted per-thread overrides into the shape
 *  `resumeConversationWithMessage` forwards to the stream. Returns `undefined`
 *  when none are set so callers can omit the field entirely (R92). */
function buildThreadOverrides(conv: {
  temperature?: number | null;
  systemPromptOverride?: string | null;
  maxSteps?: number | null;
  maxRetries?: number | null;
  runtimeOverride?: string | null;
}):
  | {
      temperature?: number | null;
      systemPromptOverride?: string | null;
      maxSteps?: number | null;
      maxRetries?: number | null;
      runtimeOverride?: string | null;
    }
  | undefined {
  const overrides: {
    temperature?: number | null;
    systemPromptOverride?: string | null;
    maxSteps?: number | null;
    maxRetries?: number | null;
    runtimeOverride?: string | null;
  } = {};
  if (typeof conv.temperature === 'number') overrides.temperature = conv.temperature;
  if (typeof conv.systemPromptOverride === 'string') overrides.systemPromptOverride = conv.systemPromptOverride;
  if (typeof conv.maxSteps === 'number') overrides.maxSteps = conv.maxSteps;
  if (typeof conv.maxRetries === 'number') overrides.maxRetries = conv.maxRetries;
  if (typeof conv.runtimeOverride === 'string') overrides.runtimeOverride = conv.runtimeOverride;
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

/**
 * Deliver an ALREADY-COLLECTED raced answer whose run finished before it could be
 * consumed (the ordinary-completion / in-flight-delivery orphan case — see the
 * ask_user raced-answer machinery in agent.ts). We already have the user's answer,
 * so this does NOT re-ask: it re-injects the answer into the ORIGINATING
 * conversation as a clearly-labeled `[Answering your earlier question …]` user turn
 * (idle conv → fresh turn; busy conv → a follow-up in the SAME chat — a legitimate
 * late user message, NOT a cross-turn splice). This is why it can't misdeliver the
 * way the raced-answer HANDOFF could: the answer only ever reaches the origin
 * conversation, never an unrelated turn's tool loop.
 *
 * If inline delivery isn't possible (conversation gone, or the resume throws /
 * rejects busy), fall back to a persistent `question` Alert carrying the answer so
 * it survives an app restart and the user can re-surface it — nothing is silently
 * lost. Returns `{ delivered:true }` only when the inline re-inject was launched.
 */
export async function deliverRecoveredAnswer(
  conversationId: string,
  questionTitle: string,
  answers: Record<string, string>,
): Promise<{ delivered: boolean }> {
  if (!deps) return { delivered: false };
  // Recovery normalizer — NOT the strict alerts:answer sanitizeAnswer: ask_user
  // permits question text > 200 chars and free-text ("Other") answers with no
  // 2000-char cap, and this answer was ALREADY collected + accepted. Rejecting a
  // valid long answer here would drop it to the evictable in-memory stash (lost on
  // restart). So keep every string entry, truncating only pathological outliers to
  // a generous bound (defensive against an unbounded value inflating the prompt).
  const MAX_RECOVERY_VALUE = 16 * 1024;
  const clean: Record<string, string> = {};
  if (answers && typeof answers === 'object' && !Array.isArray(answers)) {
    for (const [k, v] of Object.entries(answers)) {
      if (typeof k !== 'string' || typeof v !== 'string') continue;
      clean[k] = v.length > MAX_RECOVERY_VALUE ? `${v.slice(0, MAX_RECOVERY_VALUE)}…` : v;
    }
  }
  if (Object.keys(clean).length === 0) return { delivered: false };
  const title = questionTitle.trim() || 'your earlier question';
  const lines = Object.entries(clean).map(([header, choice]) => `- ${header} → ${choice}`);
  const body = lines.length ? lines.join('\n') : '(no answer provided)';
  // Unique per-delivery id embedded in the labeled turn. The post-failure
  // committed-check matches THIS exact id, so two concurrent recoveries into the
  // same conversation can't be confused — even when one's answer text is a prefix
  // of the other's, or when both carry identical answers (R94). Rendered as a
  // trailing HTML comment so it doesn't clutter the visible turn but survives the
  // JSON round-trip on disk.
  const deliveryId = `rcv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const text = `[Answering your earlier question "${title}"]\n${body}\n<!-- ${deliveryId} -->`;
  // Stable id for the persisted user turn so the post-failure commit-check finds it
  // by EXACT id even if a policy hook strips the in-content marker (R104). Collision-
  // free vs the current tree so appendConversationMessages won't remint it (R105 f-1).
  const userTurnId = allocateFreshTurnId(deps.appHome, conversationId, `rcv-turn-${deliveryId}`);
  const correlationId = `recovered-answer-${conversationId}`;
  // Inline re-inject into the ORIGIN conversation when it still exists on disk.
  const conv = readConversation(deps.appHome, conversationId);
  if (conv) {
    const convBefore = conv as {
      selectedModelKey?: string | null;
      selectedProfileKey?: string | null;
      currentWorkingDirectory?: string | null;
      fallbackEnabled?: boolean;
      executionMode?: 'auto' | 'plan-first' | null;
      reasoningEffort?: string | null;
      temperature?: number | null;
      systemPromptOverride?: string | null;
      maxSteps?: number | null;
      maxRetries?: number | null;
      runtimeOverride?: string | null;
      messages?: unknown[];
    };
    const threadOverrides = buildThreadOverrides(convBefore);
    try {
      // Preserve the conversation's OWN model/profile/cwd/fallback/executionMode so
      // the recovered answer runs under the same context the question was asked in —
      // not the global default (R89/R90/R91). executionMode especially: a plan-first
      // conversation must NOT resume in auto and expose mutating workspace tools.
      // reasoningEffort + per-thread overrides (temperature/systemPrompt/maxSteps/…)
      // are threaded too so the resume honors the conversation's own runtime (R92).
      await resumeConversationWithMessage(conversationId, text, deps.getActionDeps(), {
        correlationId,
        ...(convBefore.selectedModelKey ? { modelKey: convBefore.selectedModelKey } : {}),
        ...(convBefore.selectedProfileKey ? { profileKey: convBefore.selectedProfileKey } : {}),
        ...(convBefore.currentWorkingDirectory ? { cwd: convBefore.currentWorkingDirectory } : {}),
        ...(typeof convBefore.fallbackEnabled === 'boolean' ? { fallbackEnabled: convBefore.fallbackEnabled } : {}),
        ...(convBefore.executionMode ? { executionMode: convBefore.executionMode } : {}),
        ...(convBefore.reasoningEffort ? { reasoningEffort: convBefore.reasoningEffort } : {}),
        ...(threadOverrides ? { threadOverrides } : {}),
        userTurnId,
      });
      traceDiagnostic({
        scope: 'alert',
        event: 'recovered-answer.delivered',
        correlationId,
        conversationId,
        fields: { answerCount: Object.keys(clean).length },
      });
      return { delivered: true };
    } catch {
      // fall through to the durable Alert fallback — but first determine whether the
      // failure was BEFORE or AFTER the user turn was committed to the branch.
      // resumeConversationWithMessage persists the labeled user turn EARLY, then
      // streams; a throw AFTER commit (generation/finalization failure) means the
      // answer is ALREADY on-branch, so telling the user to re-send would DUPLICATE
      // it (and repeat tool side effects). Detect the committed turn on disk and word
      // the fallback accordingly (R90).
      try {
        const after = readConversation(deps.appHome, conversationId) as {
          messages?: Array<{ id?: unknown; role?: unknown; content?: unknown }>;
          messageTree?: Array<{ id?: unknown; role?: unknown; content?: unknown }>;
        } | null;
        // The CURRENT resume committed its user turn iff a message carrying THIS
        // resume's UNIQUE deliveryId is on disk. Search the WHOLE message set (tree +
        // active branch), NOT a count-based suffix: a count-relative slice breaks if
        // the branch was rewound to a shorter one while the resume was queued (the
        // committed turn then sits outside `slice(beforeMessageCount)` and is missed,
        // wrongly reporting delivered:false → duplicate resend). The deliveryId is
        // globally unique and appears ONLY in this recovery's turn, so a full-set scan
        // can't false-positive on a concurrent/earlier recovery either (R94/R96).
        const nodes: Array<{ id?: unknown; role?: unknown; content?: unknown }> = [
          ...(Array.isArray(after?.messageTree) ? after!.messageTree : []),
          ...(Array.isArray(after?.messages) ? after!.messages : []),
        ];
        // Committed iff a user node carries THIS resume's exact userTurnId (durable
        // against a content-rewriting policy hook, R104) OR the in-content marker
        // survived (fast path / cooperative-inject where the id may differ).
        const committed = nodes.some(
          (m) => m?.role === 'user' && (m.id === userTurnId || JSON.stringify(m.content ?? '').includes(deliveryId)),
        );
        if (committed) {
          // The answer IS on-branch; only the response generation failed. Do NOT invite
          // a resend (it would duplicate). Surface an informational alert instead.
          try {
            const alert = createAlert(deps.appHome, {
              kind: 'fyi',
              title: `Answer applied, response incomplete: ${title}`,
              body: `Your answer was recorded on the conversation, but generating the response failed. Continue in the conversation — do NOT re-send (that would duplicate it):\n${body}`,
              conversationId,
            });
            notifyNewAlert(alert);
            traceDiagnostic({
              scope: 'alert',
              event: 'recovered-answer.committed-response-failed',
              correlationId,
              conversationId,
              alertId: alert.id,
              fields: { answerCount: Object.keys(clean).length },
            });
          } catch {
            /* best-effort */
          }
          // Committed = the answer reached the branch; report delivered so the caller
          // consumes the stash and doesn't ALSO route it elsewhere.
          return { delivered: true };
        }
      } catch {
        /* fall through to the pre-commit "re-send" fallback below */
      }
    }
  }
  // Durable fallback: raise a persistent `fyi` Alert that RECORDS the answer the
  // user gave (in the body) so it's neither silently lost nor misdelivered — it
  // survives an app restart and the user can re-send it manually from the
  // conversation if still relevant. NOT a `question` alert: we already have the
  // answer, so re-asking would be confusing, and an answerable synthetic question
  // (`alerts:answer`) would re-inject the SYNTHETIC choice ("Resend"/"Discard"),
  // not the saved answer — the wrong payload.
  try {
    const alert = createAlert(deps.appHome, {
      kind: 'fyi',
      title: `Answer not delivered: ${title}`,
      body: `Your answer arrived after the turn ended, so it wasn't applied:\n${body}\n\nIf it's still relevant, re-send it in the conversation.`,
      conversationId,
    });
    notifyNewAlert(alert);
    traceDiagnostic({
      scope: 'alert',
      event: 'recovered-answer.alerted',
      correlationId,
      conversationId,
      alertId: alert.id,
      fields: { answerCount: Object.keys(clean).length },
    });
  } catch {
    /* best-effort — the caller retains its bounded-stash copy as the last resort */
  }
  return { delivered: false };
}

/** Push an `alerts:changed` event to every window + web client (tab badge / modal host). */
function broadcastAlertsChanged(payload: {
  reason: 'created' | 'resolved' | 'dismissed';
  alert?: Alert;
  /** When true, a present user is already looking at Kai — the renderer should
   *  NOT pop a modal/steal focus (the inline card is the surface). Still updates
   *  the Alerts tab/badge. */
  suppressSurface?: boolean;
}): void {
  // Close the dedicated pop-out window once the alert is answered/dismissed (from
  // any surface: the window, the tab, or the in-app modal) so it can't linger.
  if ((payload.reason === 'resolved' || payload.reason === 'dismissed') && payload.alert) {
    closeNotificationWindow(payload.alert.id);
  }
  // Guarded, non-throwing fan-out: a navigating window's send throwing here must not
  // propagate — the alerts:answer/decide handler broadcasts BEFORE resume(), so a
  // throw would leave the alert persisted-as-answered but never resumed (its answer
  // never injected, and non-retryable) (R107 finding-2).
  broadcastToAllWindows('alerts:changed', payload);
}

/** Bring the main window front-most + focused (used when surfaceAlertsAsModal is on). */
function focusMainWindowForModal(): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  // Briefly float it above other apps so a background automation alert is
  // immediately actionable, then release so it doesn't stay pinned.
  win.setAlwaysOnTop(true);
  setTimeout(() => {
    try {
      if (!win.isDestroyed()) win.setAlwaysOnTop(false);
    } catch {
      /* window gone */
    }
  }, 1500);
}

/**
 * Raise a new alert: persist it, notify the OS, broadcast to UIs, and (if the
 * setting is on and the alert needs an answer) surface a front-most modal.
 * This is the single entry point both `request_review` (via IPC-less direct
 * call is NOT used — the tool writes the store itself) and the ask_user
 * fallback funnel their notification through.
 */
export function raiseAlert(input: CreateAlertInput): Alert {
  if (!deps) throw new Error('alerts not initialized');
  const alert = createAlert(deps.appHome, input);
  notifyNewAlert(alert);
  return alert;
}

/** Fire the OS notification + broadcast + optional modal for an already-created alert.
 *  Exported as the hook `request_review` / the ask_user fallback call after they
 *  write the store directly (they live in the tools layer and can't import electron). */
export function notifyNewAlert(alert: Alert): void {
  // Presence-aware surfacing: when the user is looking at the Kai GUI they can
  // see the inline request_review card / Alerts tab, so DON'T also fire an OS
  // notification or steal focus with a modal/pop-out. The alert is still
  // persisted + broadcast (inline card + Alerts history). When they're away,
  // surface it normally so a headless/automation run isn't missed.
  //
  // NB: for ALERTS, presence means the GUI is focused — NOT `isKaiPresent()`.
  // A connected CLI heartbeats every few seconds (keeping isCliPresent() true)
  // but the CLI has no live alert UI, so treating CLI liveness as "the alert is
  // visible" would silently swallow the OS notification/pop-out for a blocking
  // question/approval and leave the automation waiting invisibly.
  const present = (() => {
    try {
      return isGuiFocused();
    } catch {
      return false;
    }
  })();

  const surface = deps?.alertSurface() ?? 'off';
  traceDiagnostic({
    scope: 'alert',
    event: 'alert.created',
    // Stable id derived from alert.id so a filter follows the alert from creation
    // through answer → resumed agent turn (answer/resume use the same `alert-<id>`).
    correlationId: `alert-${alert.id}`,
    conversationId: alert.conversationId,
    alertId: alert.id,
    fields: { kind: alert.kind, present, surface, status: alert.status },
  });

  const verb = alert.kind === 'fyi' ? 'Flagged for review' : alert.kind === 'approval' ? 'Approval needed' : 'Question';
  if (!present) {
    try {
      if (Notification.isSupported()) {
        const n = new Notification({ title: `${verb}: ${alert.title}`, body: alert.body.slice(0, 240) });
        n.on('click', () => {
          focusMainWindowForModal();
          broadcastToAllWindows('alerts:navigate', { alertId: alert.id });
        });
        n.show();
      }
    } catch {
      // Notifications can throw on some platforms/permission states — non-fatal.
    }
  }
  // Always broadcast so the inline card + Alerts tab/history update live. Pass
  // `suppressSurface` so the renderer's AlertModalHost skips the modal for a
  // present user (the broadcast alone would otherwise pop it regardless).
  broadcastAlertsChanged({ reason: 'created', alert, suppressSurface: present });
  // Surface (modal/pop-out) only when AWAY and not an fyi (fyi never steals focus).
  if (!present && alert.kind !== 'fyi') {
    if (surface === 'modal') {
      focusMainWindowForModal();
    } else if (surface === 'window') {
      openNotificationWindow({ source: 'alert', id: alert.id, alert });
    }
  }
}

/** Human-readable summary of a question answer, for re-injection as a user turn. */
function formatAnswer(alert: Alert, answer: Record<string, string>): string {
  const lines: string[] = [];
  const byHeader = new Map((alert.questions ?? []).map((q) => [q.header, q.question] as const));
  for (const [header, choice] of Object.entries(answer)) {
    const question = byHeader.get(header) ?? header;
    lines.push(`- ${question} → ${choice}`);
  }
  const body = lines.length ? lines.join('\n') : '(no answer provided)';
  return `[Answering your earlier question "${alert.title}"]\n${body}`;
}

function formatDecision(alert: Alert, decision: 'approve' | 'deny', note?: string): string {
  const action = alert.approvalAction ? ` for: ${alert.approvalAction}` : '';
  const base =
    decision === 'approve'
      ? `[Approved${action}] You may proceed.`
      : `[Denied${action}] Do not proceed; stop or choose a different course.`;
  const trimmed = note?.trim();
  return trimmed ? `${base}\nNote from the user: ${trimmed}` : base;
}

/** Append the user's response into the originating conversation and re-run the
 *  agent. If the resume fails (conversation gone/busy), RE-OPEN the alert so the
 *  user's answer isn't silently lost and they can retry. */
async function resume(alert: Alert, userText: string): Promise<void> {
  if (!deps) throw new Error('alerts not initialized');
  // Unique per-delivery marker (trailing HTML comment) so a post-failure check can
  // tell whether THIS answer's user turn was committed to the branch. A resume can
  // persist the user turn EARLY, run tools, then throw during finalization — blindly
  // reopening the alert on ANY failure then lets the user re-answer, appending the
  // turn again and repeating tool side effects. Search the full tree for the marker;
  // reopen ONLY when the turn was not committed (R101 finding-4). Mirrors
  // deliverRecoveredAnswer's committed-check.
  const deliveryId = `alert-rcv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const markedText = `${userText}\n<!-- ${deliveryId} -->`;
  // Allocate a STABLE id for the resumed user turn and thread it through so the
  // idle-resume append persists the turn under EXACTLY this id. A post-failure commit
  // check then looks for THIS id (durable against a content-rewriting hook, and immune
  // to a CONCURRENT unrelated GUI/CLI user turn — the ordered barrier serializes only
  // automation turns, so "any new user id = committed" would false-positive and leave
  // the alert wrongly resolved with its answer never delivered, R103 finding-2). The
  // in-content marker stays as a fallback for the cooperative-inject path (which mints
  // its own id): if BOTH are absent we conservatively reopen (re-answerable) rather
  // than silently drop.
  const userTurnId = allocateFreshTurnId(deps.appHome, alert.conversationId, `alert-turn-${alert.id}`);
  try {
    // Run the resumed turn in the conversation's OWN context (model/profile/cwd/
    // fallback/executionMode) rather than the global default (R90/R91) — a plan-first
    // conversation must resume in plan-first, not auto (which would expose mutating
    // tools).
    const conv = readConversation(deps.appHome, alert.conversationId) as {
      selectedModelKey?: string | null;
      selectedProfileKey?: string | null;
      currentWorkingDirectory?: string | null;
      fallbackEnabled?: boolean;
      executionMode?: 'auto' | 'plan-first' | null;
      reasoningEffort?: string | null;
      temperature?: number | null;
      systemPromptOverride?: string | null;
      maxSteps?: number | null;
      maxRetries?: number | null;
      runtimeOverride?: string | null;
    } | null;
    const threadOverrides = conv ? buildThreadOverrides(conv) : undefined;
    await resumeConversationWithMessage(alert.conversationId, markedText, deps.getActionDeps(), {
      correlationId: `alert-${alert.id}`,
      ...(conv?.selectedModelKey ? { modelKey: conv.selectedModelKey } : {}),
      ...(conv?.selectedProfileKey ? { profileKey: conv.selectedProfileKey } : {}),
      ...(conv?.currentWorkingDirectory ? { cwd: conv.currentWorkingDirectory } : {}),
      ...(typeof conv?.fallbackEnabled === 'boolean' ? { fallbackEnabled: conv.fallbackEnabled } : {}),
      ...(conv?.executionMode ? { executionMode: conv.executionMode } : {}),
      ...(conv?.reasoningEffort ? { reasoningEffort: conv.reasoningEffort } : {}),
      ...(threadOverrides ? { threadOverrides } : {}),
      userTurnId,
    });
  } catch (err) {
    // Only reopen (invite a re-answer) when the answer's user turn is NOT already on
    // the branch — otherwise re-answering would duplicate it + repeat tool effects.
    let committed = false;
    try {
      const after = readConversation(deps.appHome, alert.conversationId) as {
        messages?: Array<{ id?: unknown; role?: unknown; content?: unknown }>;
        messageTree?: Array<{ id?: unknown; role?: unknown; content?: unknown }>;
      } | null;
      const nodes: Array<{ id?: unknown; role?: unknown; content?: unknown }> = [
        ...(Array.isArray(after?.messageTree) ? after!.messageTree : []),
        ...(Array.isArray(after?.messages) ? after!.messages : []),
      ];
      // Committed iff a user node carrying THIS resume's exact stable userTurnId is
      // on the tree (durable, hook-proof, and can't match a concurrent unrelated turn)
      // OR — for the cooperative-inject path, which mints its own id — the in-content
      // marker survived (fast path). NOT "any new user id": a concurrent GUI/CLI turn
      // would false-positive and leave the alert wrongly resolved (R103 finding-2).
      committed = nodes.some((m) => {
        if (m?.role !== 'user') return false;
        if (m.id === userTurnId) return true;
        return JSON.stringify(m.content ?? '').includes(deliveryId);
      });
    } catch {
      /* if we can't read, fall through to reopen (safer to let the user retry) */
    }
    if (!committed) {
      const reopened = deps ? reopenAlert(deps.appHome, alert.id) : null;
      if (reopened) broadcastAlertsChanged({ reason: 'created', alert: reopened });
    }
    throw err;
  }
}

export function registerAlertsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('alerts:list', (_e, openOnly?: boolean) => {
    if (!deps) return [];
    return listAlerts(deps.appHome, !!openOnly);
  });

  ipcMain.handle('alerts:get', (_e, id: string) => {
    if (!deps) return null;
    return readAlert(deps.appHome, id);
  });

  ipcMain.handle('alerts:unreadCount', () => {
    if (!deps) return 0;
    return openAlertCount(deps.appHome);
  });

  ipcMain.handle('alerts:answer', async (_e, id: string, answer: Record<string, string>) => {
    if (!deps) return { ok: false, error: 'alerts not initialized' };
    if (!isValidAlertId(id)) return { ok: false, error: 'invalid alert id' };
    const clean = sanitizeAnswer(answer);
    if (!clean) return { ok: false, error: 'answer must be an object of { header: choice } strings' };
    // Enforce kind: only a `question` alert is answerable this way (an approval
    // must go through alerts:decide). Prevents cross-kind resolution.
    const existing = readAlert(deps.appHome, id);
    if (!existing) return { ok: false, error: 'alert not found' };
    if (existing.kind !== 'question') {
      return { ok: false, error: `alert ${id} is a "${existing.kind}", not a question` };
    }
    // The answer resumes by re-injecting into the originating conversation; if
    // that conversation no longer exists on disk (e.g. an ad-hoc plugin run's
    // synthetic id), resuming is impossible — don't resolve into a lost answer.
    if (!readConversation(deps.appHome, existing.conversationId)) {
      return { ok: false, error: 'the conversation this alert belongs to no longer exists' };
    }
    const resolved = resolveAlert(deps.appHome, id, clean);
    if (!resolved) return { ok: false, error: 'alert not open' };
    traceDiagnostic({
      scope: 'alert',
      event: 'alert.answered',
      correlationId: `alert-${id}`,
      conversationId: resolved.conversationId,
      alertId: id,
      // Count only — question headers can carry sensitive prose and must not be
      // written in metadata-only trace mode.
      fields: { answerCount: Object.keys(clean).length },
    });
    broadcastAlertsChanged({ reason: 'resolved', alert: resolved });
    // Resume in the background; don't make the UI wait on a full agent turn.
    void resume(resolved, formatAnswer(resolved, clean))
      .then(() => {
        traceDiagnostic({
          scope: 'alert',
          event: 'alert.resume-complete',
          correlationId: `alert-${id}`,
          conversationId: resolved.conversationId,
          alertId: id,
        });
      })
      .catch((err) => {
        traceDiagnostic({
          scope: 'alert',
          event: 'alert.resume-failed',
          level: 'error',
          correlationId: `alert-${id}`,
          conversationId: resolved.conversationId,
          alertId: id,
          fields: { error: err },
        });
        console.error('[alerts] resume after answer failed:', err);
      });
    return { ok: true };
  });

  ipcMain.handle('alerts:decide', async (_e, id: string, decision: 'approve' | 'deny', note?: string) => {
    if (!deps) return { ok: false, error: 'alerts not initialized' };
    if (!isValidAlertId(id)) return { ok: false, error: 'invalid alert id' };
    if (decision !== 'approve' && decision !== 'deny') {
      return { ok: false, error: "decision must be 'approve' or 'deny'" };
    }
    if (note !== undefined && (typeof note !== 'string' || note.length > 4000)) {
      return { ok: false, error: 'note must be a string under 4000 chars' };
    }
    const existing = readAlert(deps.appHome, id);
    if (!existing) return { ok: false, error: 'alert not found' };
    if (existing.kind !== 'approval') {
      return { ok: false, error: `alert ${id} is a "${existing.kind}", not an approval` };
    }
    if (!readConversation(deps.appHome, existing.conversationId)) {
      return { ok: false, error: 'the conversation this alert belongs to no longer exists' };
    }
    const resolved = resolveAlert(deps.appHome, id, decision);
    if (!resolved) return { ok: false, error: 'alert not open' };
    broadcastAlertsChanged({ reason: 'resolved', alert: resolved });
    void resume(resolved, formatDecision(resolved, decision, note)).catch((err) => {
      console.error('[alerts] resume after decision failed:', err);
    });
    return { ok: true };
  });

  ipcMain.handle('alerts:dismiss', (_e, id: string) => {
    if (!deps) return { ok: false, error: 'alerts not initialized' };
    if (!isValidAlertId(id)) return { ok: false, error: 'invalid alert id' };
    const dismissed = dismissAlert(deps.appHome, id);
    if (!dismissed) return { ok: false, error: 'alert not found' };
    broadcastAlertsChanged({ reason: 'dismissed', alert: dismissed });
    return { ok: true };
  });
}

/** Alert ids are UUIDs from randomUUID(); reject anything else (bounds + shape). */
function isValidAlertId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** Coerce an answer map to bounded `{ header: choice }` strings, or null if invalid.
 *  Guards against non-string/nested/oversized values reaching the store + resume prompt. */
function sanitizeAnswer(answer: unknown): Record<string, string> | null {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
  const entries = Object.entries(answer as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 20) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (typeof k !== 'string' || k.length > 200) return null;
    if (typeof v !== 'string' || v.length > 2000) return null;
    out[k] = v;
  }
  return out;
}

/** Pure formatters + validators exposed for unit tests. */
export const __internal = { formatAnswer, formatDecision, isValidAlertId, sanitizeAnswer };
