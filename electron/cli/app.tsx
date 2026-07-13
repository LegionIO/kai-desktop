import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp, useStdout, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { randomUUID } from 'crypto';
import { appendFileSync } from 'fs';
import { join } from 'path';
import type { LocalBridgeClient } from './client.js';
import { renderMarkdown, stripControl } from './render/markdown.js';
import { InputBox } from './components/InputBox.js';
import { ToolRow, type ToolStatus } from './components/ToolRow.js';
import { Picker, type PickerItem } from './components/Picker.js';
import { Banner } from './components/Banner.js';
import { expandFileMentions } from './mentions.js';
import { extractImageMentions } from './images.js';

// TEMP debug (issue #217): trace which stream events reach the CLI and whether
// the conversationId guard passes. Gated on the SAME env var as the backend's
// stream-pipeline log (KAI_DEBUG_STREAM) and written alongside it, so one flag
// lights up both ends of the GUI->CLI pipeline. Remove once #217 is resolved.
const CLI_DEBUG_ENABLED = !!process.env.KAI_DEBUG_STREAM;
const CLI_DEBUG_LOG = join(process.cwd(), 'debug-logs', 'stream-pipeline.log');
function cliDebugLog(msg: string): void {
  if (!CLI_DEBUG_ENABLED) return;
  try {
    appendFileSync(CLI_DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* best-effort */
  }
}

type StreamEvent = {
  conversationId?: string;
  type?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  durationMs?: number;
  data?: unknown;
};

// ask_user tool args: questions rendered as sequential pickers in the REPL.
type AskUserQuestion = {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
};

type ConversationRecord = {
  id: string;
  title: string | null;
  messages: unknown[];
  currentWorkingDirectory?: string | null;
};

type Turn =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'note'; text: string; id?: string; loading?: boolean }
  | { kind: 'error'; text: string };

type ToolEntry = {
  id: string;
  name: string;
  status: ToolStatus;
  durationMs?: number;
  error?: string;
  args?: unknown;
  result?: unknown;
};

type PickerState = {
  title: string;
  items: PickerItem[];
  onSelect: (value: string) => void;
  onCancel?: () => void; // Esc handler — e.g. reject/dismiss a pending tool so the backend isn't left hung
  onFreeText?: (value: string) => void; // when set, offer an "Other (type a message)" free-text row
} | null;

const CWD = process.cwd();

function newConversationRecord(cwd: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: null,
    fallbackTitle: null,
    messages: [],
    messageTree: [],
    headId: null,
    conversationCompaction: null,
    lastContextUsage: null,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: null,
    titleStatus: 'idle',
    titleUpdatedAt: null,
    messageCount: 0,
    userMessageCount: 0,
    runStatus: 'idle',
    hasUnread: false,
    lastAssistantUpdateAt: null,
    selectedModelKey: null,
    currentWorkingDirectory: cwd,
  };
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        const part = p as { type?: string; text?: string };
        return part?.type === 'text' && typeof part.text === 'string' ? part.text : '';
      })
      .join('');
  }
  return '';
}

export function App({
  client,
  recover,
  runtimeRef,
}: {
  client: LocalBridgeClient;
  recover?: () => Promise<boolean>;
  // Shared with startRepl so quit-time cleanup can cancel an in-flight turn.
  runtimeRef?: { activeConversationId: string | null; busy: boolean };
}): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();

  // Double Ctrl-C to quit (like codex/claude CLI): the first Ctrl-C shows a hint
  // under the composer; a second within the window actually quits. Ink's built-in
  // exitOnCtrlC is disabled (so startRepl's graceful shutdown handshake runs) and
  // in raw mode Ctrl-C arrives as input (not SIGINT), so we debounce it here.
  const [quitHint, setQuitHint] = useState(false);
  const quitArmedRef = useRef(false);
  const quitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useInput((_input, key) => {
    if (key.ctrl && _input === 'c') {
      if (quitArmedRef.current) {
        if (quitTimerRef.current) clearTimeout(quitTimerRef.current);
        exit();
        return;
      }
      quitArmedRef.current = true;
      setQuitHint(true);
      if (quitTimerRef.current) clearTimeout(quitTimerRef.current);
      quitTimerRef.current = setTimeout(() => {
        quitArmedRef.current = false;
        setQuitHint(false);
      }, 2000);
      return;
    }
    // Ctrl-O toggles expanded tool views (full args + result) for the run.
    if (key.ctrl && _input === 'o') setExpandTools((v) => !v);
  });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [tools, setTools] = useState<ToolEntry[]>([]);
  const [status, setStatus] = useState<'idle' | 'running' | 'awaiting-approval'>('idle');
  // Transient connection status shown near the composer (NOT in the scrollback
  // thread, so a reconnect can't clobber assistant output or clutter history).
  const [connState, setConnState] = useState<'ok' | 'reconnecting' | 'reconnected'>('ok');
  const connClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [conversationId, setConversationId] = useState<string>('');
  const [picker, setPicker] = useState<PickerState>(null);
  const [modelLabel, setModelLabel] = useState<string>('default');
  const [fallbackModelLabel, setFallbackModelLabel] = useState<string | null>(null); // runtime model-fallback override
  const [profileLabel, setProfileLabel] = useState<string>('unset');
  const [pending, setPending] = useState<'model' | 'profile' | null>(null); // which banner line is applying
  const [expandTools, setExpandTools] = useState<boolean>(false); // Ctrl-O: show full tool args/result
  const streamingRef = useRef<string>(''); // in-progress assistant text
  const convIdRef = useRef<string>('');
  const unsavedRecordRef = useRef<Record<string, unknown> | null>(null); // new chat not yet persisted
  // Messages typed while a turn is in flight are queued (FIFO) and flushed one
  // at a time after each `done`, instead of aborting the live turn. A ref (not
  // state) so the stream-event effect can read/flush without re-subscribing.
  const queueRef = useRef<string[]>([]);
  const sendMessageRef = useRef<
    (text: string, submitText?: string, attachments?: Array<{ image: string; mimeType?: string }>) => void
  >(() => {});
  // Guards double-draining the queue: the backend can emit `error` THEN `done`
  // for the same turn. Only the first terminal event of a turn drains one
  // queued message. Reset when a new turn starts (sendMessage).
  const turnSettledRef = useRef<boolean>(false);
  // Submit nonces this CLI originated. The backend echoes the nonce in the
  // broadcast `user-message` event; we skip rendering our OWN echo (we already
  // showed the turn optimistically), but render turns submitted elsewhere (GUI).
  const ownSubmitNoncesRef = useRef<Set<string>>(new Set());
  // Mirror of `status` for reads inside callbacks that must not re-create on
  // every status change (runCommand). Kept in sync below.
  const statusRef = useRef<'idle' | 'running' | 'awaiting-approval'>('idle');
  statusRef.current = status;
  // Keep the shared runtime ref current so startRepl's quit cleanup can cancel
  // an in-flight turn on the right conversation.
  if (runtimeRef) {
    runtimeRef.activeConversationId = conversationId || convIdRef.current || null;
    runtimeRef.busy = status === 'running' || status === 'awaiting-approval';
  }

  const pushTurn = useCallback((t: Turn) => setTurns((prev) => [...prev, t]), []);

  // A "loading note" shows a spinner in the transcript body while an async
  // command runs, then resolves in place to its final text. `resolveNote`
  // updates the matching id; if it never existed (e.g. cleared) it's a no-op.
  const pushLoadingNote = useCallback((id: string, text: string) => {
    setTurns((prev) => [...prev, { kind: 'note', id, text, loading: true }]);
  }, []);
  const resolveNote = useCallback((id: string, text: string) => {
    setTurns((prev) => prev.map((t) => (t.kind === 'note' && t.id === id ? { ...t, text, loading: false } : t)));
  }, []);

  // Reload the active branch's transcript from the store (used by /resume and
  // /rewind). Shows `note` at the top, then replays each message as a turn.
  const reloadTranscript = useCallback(
    async (id: string, note: string) => {
      const full = await client.invoke<{ messages?: unknown[] } | null>('conversations:get', id);
      const replay: Turn[] = [];
      for (const m of full?.messages ?? []) {
        const msg = m as { role?: string; content?: unknown };
        const text = contentToText(msg.content).trim();
        if (text) replay.push({ kind: msg.role === 'user' ? 'user' : 'assistant', text });
      }
      setTurns([{ kind: 'note', text: note }, ...replay]);
      setTools([]);
    },
    [client],
  );

  // Fetch model/profile catalog items in a normalized {label,value} shape.
  // agent:model-catalog → { models: [{key, displayName}], defaultKey }
  // agent:profiles      → { profiles: [{key, name}], defaultKey }
  const fetchCatalog = useCallback(
    async (kind: 'model' | 'profile'): Promise<{ items: PickerItem[]; defaultKey: string | null }> => {
      if (kind === 'model') {
        const res = await client.invoke<{
          models?: Array<{ key?: string; displayName?: string }>;
          defaultKey?: string | null;
        }>('agent:model-catalog');
        const items = (res?.models ?? [])
          .map((m) => ({ label: m.displayName ?? m.key ?? '?', value: m.key ?? '' }))
          .filter((i) => i.value);
        return { items, defaultKey: res?.defaultKey ?? null };
      }
      const res = await client.invoke<{
        profiles?: Array<{ key?: string; name?: string }>;
        defaultKey?: string | null;
      }>('agent:profiles');
      const items = (res?.profiles ?? [])
        .map((p) => ({ label: p.name ?? p.key ?? '?', value: p.key ?? '' }))
        .filter((i) => i.value);
      return { items, defaultKey: res?.defaultKey ?? null };
    },
    [client],
  );

  // Resolve the banner's model + profile labels from the conversation's
  // currently selected keys. Model resolution order:
  //   1. a selected profile's primaryModelKey (a profile drives the model), else
  //   2. the thread's selectedModelKey, else
  //   3. the catalog default.
  // A live `model-fallback` during a turn overrides this (see stream handler);
  // refreshBanner clears that override since it starts a fresh baseline.
  //
  // Pass `known` selected keys to skip the conversations:get (a full-store read
  // that is slow on a large store) — the new-chat path knows both are null.
  const refreshBanner = useCallback(
    async (known?: { selectedModelKey: string | null; selectedProfileKey: string | null }) => {
      try {
        const conv =
          known ??
          (await client.invoke<{ selectedModelKey?: string | null; selectedProfileKey?: string | null } | null>(
            'conversations:get',
            convIdRef.current,
          )) ??
          {};

        const [modelRes, profileRes] = await Promise.all([
          client.invoke<{ models?: Array<{ key?: string; displayName?: string }>; defaultKey?: string | null }>(
            'agent:model-catalog',
          ),
          client.invoke<{
            profiles?: Array<{ key?: string; name?: string; primaryModelKey?: string }>;
            defaultKey?: string | null;
          }>('agent:profiles'),
        ]);

        const modelName = (key: string | null | undefined): string =>
          (modelRes?.models ?? []).find((m) => m.key === key)?.displayName ?? (key || 'default');

        const profileKey = conv.selectedProfileKey ?? null;
        const profile = profileKey ? (profileRes?.profiles ?? []).find((p) => p.key === profileKey) : undefined;

        setProfileLabel(profile ? (profile.name ?? profile.key ?? profileKey!) : 'unset');

        // A selected profile drives the model; otherwise use the thread model or default.
        const effectiveModelKey = profile?.primaryModelKey ?? conv.selectedModelKey ?? modelRes?.defaultKey ?? null;
        setFallbackModelLabel(null); // new baseline — clear any prior runtime fallback
        setModelLabel(modelName(effectiveModelKey));
      } catch {
        // leave existing labels on transient errors
      }
    },
    [client],
  );

  // ── conversation setup ──────────────────────────────────────────────
  // Create a chat IN MEMORY only — defer the (slow, full-store) persistence
  // until the first message is actually sent. This makes startup and /new
  // instant instead of paying a full conversations.json write up front for a
  // chat the user might never send to.
  const createNew = useCallback(async () => {
    const rec = newConversationRecord(CWD);
    convIdRef.current = rec.id as string;
    setConversationId(rec.id as string);
    unsavedRecordRef.current = rec; // persisted lazily on first submit
    setTurns([]);
    setTools([]);
    // Fresh chat: both selection keys are null, so resolve banner labels from
    // the catalog directly — no conversations:get needed.
    void refreshBanner({ selectedModelKey: null, selectedProfileKey: null });
  }, [refreshBanner]);

  useEffect(() => {
    void createNew();
  }, []);

  // Render an ask_user tool call as sequential REPL pickers, then send the
  // collected answers back via agent:answer-tool-question (keyed by question
  // text, matching the GUI's contract). Falls back to approve on empty.
  const promptAskUser = useCallback(
    (toolCallId: string, questions: AskUserQuestion[]) => {
      const answers: Record<string, string> = {};
      const askNext = (i: number): void => {
        if (i >= questions.length) {
          void client.invoke('agent:answer-tool-question', toolCallId, answers).catch(() => {});
          setStatus('running');
          return;
        }
        const q = questions[i];
        setPicker({
          // Sanitize model-controlled display text at the terminal boundary
          // (ESC/OSC injection); keep the ORIGINAL label as the answer value so
          // the tool receives exactly what it offered.
          title: stripControl(q.question),
          items: q.options.map((o) => ({ label: stripControl(o.label), value: o.label })),
          onSelect: (v) => {
            setPicker(null);
            answers[q.question] = v;
            askNext(i + 1);
          },
          // "Other (type a message)" — free-text answer, matching the GUI's
          // AskUserQuestion affordance so the user isn't boxed into the options.
          onFreeText: (v) => {
            setPicker(null);
            answers[q.question] = v;
            askNext(i + 1);
          },
          // Esc mid-questionnaire → reject so the ask_user tool doesn't hang.
          onCancel: () => {
            setStatus('running');
            void client.invoke('agent:reject-tool', toolCallId).catch(() => {});
          },
        });
      };
      askNext(0);
    },
    [client],
  );

  // ── live stream subscription ────────────────────────────────────────
  useEffect(() => {
    const finalizeAssistant = (): void => {
      const text = streamingRef.current;
      streamingRef.current = '';
      if (text.trim()) setTurns((prev) => [...prev, { kind: 'assistant', text }]);
    };

    // Terminal handler for a turn (done OR error). Coalesced via turnSettledRef
    // so an `error`+`done` pair for the same turn drains the queue only once.
    // Flushes the next queued message as the next turn, else goes idle.
    const settleTurn = (): void => {
      if (turnSettledRef.current) return;
      turnSettledRef.current = true;
      if (queueRef.current.length > 0) {
        const next = queueRef.current.shift() as string;
        setTimeout(() => sendMessageRef.current(next), 0);
      } else {
        setStatus('idle');
      }
    };

    // On turn completion, any tool row still marked running/awaiting can't have
    // been left mid-execution — the turn is over. This is a backstop for a
    // GUI-driven (peer) turn whose tool-result arrives with a toolCallId that
    // doesn't match the CLI's tool-call row (execute-vs-stream id spaces), which
    // would otherwise leave the row spinning forever ("stuck on CLI, done on
    // GUI"). Mark such rows done so the CLI reflects the finished turn.
    const settleOpenToolRows = (): void => {
      setTools((prev) =>
        prev.some((t) => t.status === 'running' || t.status === 'awaiting')
          ? prev.map((t) => (t.status === 'running' || t.status === 'awaiting' ? { ...t, status: 'done' } : t))
          : prev,
      );
    };

    const off = client.on('agent:stream-event', (raw) => {
      const e = raw as StreamEvent;
      cliDebugLog(
        `[CLI-EVT] type=${e?.type} evConv=${e?.conversationId} myConv=${convIdRef.current} pass=${!!e && e.conversationId === convIdRef.current} streamLen=${streamingRef.current.length}`,
      );
      if (!e || e.conversationId !== convIdRef.current) return;
      switch (e.type) {
        case 'user-message': {
          // A user turn submitted into THIS conversation (the guard above already
          // scoped it). Skip our OWN echo — we showed it optimistically in
          // sendMessage and tagged it with a nonce the backend echoes here.
          const nonce = (e.data as { submitNonce?: string } | undefined)?.submitNonce;
          if (nonce && ownSubmitNoncesRef.current.has(nonce)) {
            ownSubmitNoncesRef.current.delete(nonce);
            break;
          }
          // A PEER-driven turn (e.g. the GUI on the same conversation). Flush any
          // in-progress assistant text into its own turn first, then open a clean
          // slate for this turn's response — otherwise the incoming text-deltas
          // accumulate onto stale streaming state and render mangled/partial.
          finalizeAssistant();
          streamingRef.current = '';
          turnSettledRef.current = false; // arm the terminal-event (done/error) guard
          if (e.text) pushTurn({ kind: 'user', text: e.text });
          setStatus('running');
          break;
        }
        case 'text-delta':
          if (e.text) {
            streamingRef.current += e.text;
            cliDebugLog(`[CLI-DELTA] appended len=${e.text.length} total=${streamingRef.current.length}`);
            // Force a re-render by touching state (streaming text shown live).
            setTurns((prev) => [...prev]);
          }
          break;
        case 'tool-call':
          if (e.toolCallId) {
            // Upsert by id: the backend re-emits tool-call with the same id
            // after PreToolUse hook sanitization, so appending would duplicate.
            const id = e.toolCallId;
            const name = e.toolName ?? 'tool';
            const args = e.args;
            cliDebugLog(`[CLI-TOOL-CALL] id=${id} name=${name}`);
            setTools((prev) =>
              prev.some((t) => t.id === id)
                ? prev.map((t) => (t.id === id ? { ...t, name, status: 'running', args } : t))
                : [...prev, { id, name, status: 'running', args }],
            );
          }
          break;
        case 'tool-result': {
          // A tool-result can still be a failure — the runtime emits errors as
          // tool-result with { isError: true } / { error }. Don't show success.
          const res = e.result as { isError?: boolean; error?: string } | undefined;
          const failed = !!res?.isError || typeof res?.error === 'string';
          cliDebugLog(
            `[CLI-TOOL-RESULT] id=${e.toolCallId} failed=${failed} matchesOpenRow=${tools.some((t) => t.id === e.toolCallId && t.status === 'running')}`,
          );
          setTools((prev) =>
            prev.map((t) =>
              t.id === e.toolCallId
                ? {
                    ...t,
                    status: failed ? 'error' : 'done',
                    durationMs: e.durationMs,
                    result: e.result,
                    ...(failed ? { error: res?.error ?? 'tool failed' } : {}),
                  }
                : t,
            ),
          );
          break;
        }
        case 'tool-error':
          setTools((prev) => prev.map((t) => (t.id === e.toolCallId ? { ...t, status: 'error', error: e.error } : t)));
          break;
        case 'tool-approval-required':
          setStatus('awaiting-approval');
          if (e.toolCallId) {
            setTools((prev) => prev.map((t) => (t.id === e.toolCallId ? { ...t, status: 'awaiting' } : t)));
            const id = e.toolCallId;
            // ask_user isn't a yes/no approval — it's a question set. Render the
            // questions as pickers and send the chosen answers back.
            const askArgs = e.args as { questions?: AskUserQuestion[] } | undefined;
            if (e.toolName === 'ask_user' && Array.isArray(askArgs?.questions) && askArgs.questions.length > 0) {
              promptAskUser(id, askArgs.questions);
              break;
            }
            setPicker({
              title: `Approve tool: ${e.toolName ?? 'tool'}?`,
              items: [
                { label: 'Approve', value: 'approve' },
                { label: 'Deny', value: 'deny' },
              ],
              onSelect: (v) => {
                setPicker(null);
                setStatus('running');
                void client.invoke(v === 'approve' ? 'agent:approve-tool' : 'agent:reject-tool', id).catch(() => {});
              },
              // Esc → dismiss the tool so the backend's pending approval resolves
              // (otherwise the stream hangs forever waiting on it).
              onCancel: () => {
                setStatus('running');
                void client.invoke('agent:dismiss-tool', id).catch(() => {});
              },
            });
          }
          break;
        case 'model-fallback': {
          // Runtime fallback to a different model — reflect the model actually
          // serving the turn in the banner.
          const fb = e.data as { toModel?: string; discardPartialAssistant?: boolean } | undefined;
          if (fb?.toModel) setFallbackModelLabel(fb.toModel);
          // If the runtime discarded the partial output before failing over,
          // drop what we've streamed so we don't show a superseded fragment.
          if (fb?.discardPartialAssistant) {
            streamingRef.current = '';
            setTurns((prev) => [...prev]);
          }
          break;
        }
        case 'error':
          finalizeAssistant();
          setTurns((prev) => [...prev, { kind: 'error', text: e.error ?? 'unknown error' }]);
          settleTurn();
          settleOpenToolRows();
          break;
        case 'done':
          finalizeAssistant();
          settleTurn();
          settleOpenToolRows();
          break;
      }
    });

    const offDisc = client.onDisconnect(() => {
      // Intentional close (our own /quit) → let the process exit normally.
      if (client.wasIntentionalClose() || !recover) {
        setTurns((prev) => [...prev, { kind: 'error', text: 'backend disconnected' }]);
        setTimeout(() => exit(), 100);
        return;
      }
      // Unexpected drop (leader crash) — try to recover the backend and resume.
      // Show the status near the composer (transient), not as a thread turn.
      if (connClearRef.current) clearTimeout(connClearRef.current);
      setConnState('reconnecting');
      setStatus('idle'); // any in-flight turn is lost with the crashed leader
      streamingRef.current = '';
      void (async () => {
        const ok = await recover();
        if (!ok) {
          setTurns((prev) => [...prev, { kind: 'error', text: 'could not reconnect — exiting' }]);
          setTimeout(() => exit(), 100);
          return;
        }
        // Re-assert the active conversation on the (possibly new) backend so
        // subsequent turns and broadcasts target it. A freshly-spawned backend
        // has no active id; a survivor keeps ours.
        if (convIdRef.current) {
          await client.invoke('conversations:set-active-id', convIdRef.current).catch(() => {});
        }
        setConnState('reconnected');
        if (connClearRef.current) clearTimeout(connClearRef.current);
        connClearRef.current = setTimeout(() => setConnState('ok'), 2500);
      })();
    });

    return () => {
      off();
      offDisc();
    };
  }, [client, recover, exit, promptAskUser]);

  // ── command + input handling ────────────────────────────────────────
  // Single-round-trip selection change. The backend patches only the selection
  // field (no full-record merge / 15MB re-read) and returns the resolved
  // effective-model label — so a /model or /profile switch is one fast IPC call
  // and the banner reflects a profile's primary model without extra fetches.
  const applySelectionFast = useCallback(
    async (cmd: 'model' | 'profile', value: string) => {
      // If the chat isn't persisted yet (lazy-create), patch the in-memory
      // record — no server round-trip. It'll be saved with the first message.
      const unsaved = unsavedRecordRef.current;
      if (unsaved) {
        unsaved[cmd === 'model' ? 'selectedModelKey' : 'selectedProfileKey'] = value;
        // Resolve labels from the catalog for the banner (fast, no store read).
        await refreshBanner({
          selectedModelKey: (unsaved.selectedModelKey as string | null) ?? null,
          selectedProfileKey: (unsaved.selectedProfileKey as string | null) ?? null,
        });
        return;
      }
      const res = await client.invoke<{ ok?: boolean; modelLabel?: string | null; profileLabel?: string | null }>(
        'conversations:set-selection',
        convIdRef.current,
        cmd,
        value,
      );
      if (res?.modelLabel) setModelLabel(res.modelLabel);
      if (cmd === 'profile') setProfileLabel(res?.profileLabel ?? 'unset');
      setFallbackModelLabel(null); // new baseline
    },
    [client, refreshBanner],
  );

  const runCommand = useCallback(
    async (cmd: string, arg: string) => {
      switch (cmd) {
        case 'help':
          pushTurn({
            kind: 'note',
            text:
              '/new  /resume  /model [name]  /profile [name]  /rewind [n]  /compact  /clear\n' +
              '/usage  /export [json|md] [path]  /mcp  /tools  /skills  /agents\n' +
              '/shot [caption]  /subagents  /subagent-stop [id]  /quit\n' +
              'attach an image inline with @path.png · keys: Esc cancel · Esc Esc rewind · Ctrl-O tools · Ctrl-C quit',
          });
          break;
        case 'new':
          // Switching conversations mid-turn would orphan the in-flight stream
          // (its terminal `done` arrives for the OLD id and is dropped, wedging
          // status at 'running'). Refuse while busy.
          if (statusRef.current === 'running' || statusRef.current === 'awaiting-approval') {
            pushTurn({ kind: 'note', text: 'a turn is in progress — wait for it to finish or /quit' });
            break;
          }
          await createNew();
          break;
        case 'clear':
          setTurns([]);
          setTools([]);
          break;
        case 'resume': {
          if (statusRef.current === 'running' || statusRef.current === 'awaiting-approval') {
            pushTurn({ kind: 'note', text: 'a turn is in progress — wait for it to finish or /quit' });
            break;
          }
          const list = (await client.invoke<ConversationRecord[]>('conversations:list')) ?? [];
          const here = list.filter((c) => c.currentWorkingDirectory === CWD);
          if (here.length === 0) {
            pushTurn({ kind: 'note', text: 'no previous chats in this directory' });
            break;
          }
          setPicker({
            title: 'Resume which chat?',
            items: here.slice(0, 20).map((c) => ({
              label: `${c.title ?? '(untitled)'}  ${c.id.slice(0, 8)}`,
              value: c.id,
            })),
            onSelect: (id) => {
              setPicker(null);
              void (async () => {
                convIdRef.current = id;
                unsavedRecordRef.current = null; // resuming a persisted chat — discard any unsaved draft
                setConversationId(id);
                await client.invoke('conversations:set-active-id', id);
                await reloadTranscript(id, `resumed ${id.slice(0, 8)}`);
                await refreshBanner();
              })();
            },
          });
          break;
        }
        case 'model':
        case 'profile': {
          const { items } = await fetchCatalog(cmd);
          if (items.length === 0) {
            pushTurn({ kind: 'note', text: `no ${cmd}s configured` });
            break;
          }
          if (arg) {
            const match = items.find((i) => i.value.toLowerCase().includes(arg.toLowerCase()));
            if (match) {
              // Optimistic banner update + a body loading note; then a SINGLE
              // round-trip patches the selection and returns resolved labels.
              if (cmd === 'model') setModelLabel(match.label);
              else setProfileLabel(match.label);
              setPending(cmd);
              const noteId = `n-${Date.now()}`;
              pushLoadingNote(noteId, `applying ${cmd} → ${match.label}`);
              await applySelectionFast(cmd, match.value);
              setPending(null);
              resolveNote(noteId, `${cmd} → ${match.label}`);
            } else {
              pushTurn({ kind: 'note', text: `no ${cmd} matching "${arg}"` });
            }
            break;
          }
          setPicker({
            title: cmd === 'model' ? 'Select model' : 'Select profile',
            items,
            onSelect: (v) => {
              setPicker(null);
              const label = items.find((i) => i.value === v)?.label ?? v;
              if (cmd === 'model') setModelLabel(label);
              else setProfileLabel(label);
              setPending(cmd);
              const noteId = `n-${Date.now()}`;
              pushLoadingNote(noteId, `applying ${cmd} → ${label}`);
              void applySelectionFast(cmd, v).finally(() => {
                setPending(null);
                resolveNote(noteId, `${cmd} → ${label}`);
              });
            },
          });
          break;
        }
        case 'compact': {
          if (statusRef.current === 'running' || statusRef.current === 'awaiting-approval') {
            pushTurn({ kind: 'note', text: 'a turn is in progress — wait for it to finish or /quit' });
            break;
          }
          if (unsavedRecordRef.current) {
            pushTurn({ kind: 'note', text: 'nothing to compact yet' });
            break;
          }
          const noteId = `n-${Date.now()}`;
          pushLoadingNote(noteId, 'compacting conversation…');
          const res = await client.invoke<{ ok?: boolean; error?: string; summarizedCount?: number }>(
            'conversations:compact',
            convIdRef.current,
          );
          if (res?.ok) {
            resolveNote(noteId, `compacted ${res.summarizedCount ?? 0} message(s) into a summary`);
          } else {
            const msg =
              res?.error === 'nothing-to-compact'
                ? 'nothing to compact yet'
                : res?.error === 'compaction-disabled'
                  ? 'compaction is disabled in settings'
                  : `compact failed: ${res?.error ?? 'unknown'}`;
            resolveNote(noteId, msg);
          }
          break;
        }
        case 'rewind':
        case 'revert': {
          // Rewinding mid-turn would fight the in-flight stream: its terminal
          // server-persist appends the assistant under the captured submit-time
          // parent and moves headId back, effectively undoing the rewind. Refuse
          // while busy.
          if (statusRef.current === 'running' || statusRef.current === 'awaiting-approval') {
            pushTurn({ kind: 'note', text: 'a turn is in progress — wait for it to finish or /quit' });
            break;
          }
          if (unsavedRecordRef.current) {
            pushTurn({ kind: 'note', text: 'nothing to rewind yet' });
            break;
          }
          const steps = Math.max(1, parseInt(arg, 10) || 1);
          const res = await client.invoke<{ ok?: boolean; error?: string; removed?: number }>(
            'conversations:rewind',
            convIdRef.current,
            steps,
          );
          if (!res?.ok) {
            pushTurn({
              kind: 'note',
              text:
                res?.error === 'compacted'
                  ? 'cannot rewind a compacted chat'
                  : res?.error === 'nothing-to-rewind'
                    ? 'nothing to rewind'
                    : `rewind failed: ${res?.error ?? 'unknown'}`,
            });
            break;
          }
          // Reload the (now shorter) transcript.
          await reloadTranscript(convIdRef.current, `rewound ${res.removed ?? 0} message(s)`);
          // Offer to revert file edits. NOTE: the diff tracker is
          // conversation-scoped, not turn-scoped, and diffs:revertAll reverts
          // every tracked edit in this chat — including edits from turns that
          // are still active after the rewind. Say so plainly so the user isn't
          // misled into discarding changes they meant to keep.
          const diffs = (await client.invoke<unknown[]>('diffs:list', convIdRef.current)) ?? [];
          if (diffs.length > 0) {
            setPicker({
              title: `Revert ALL ${diffs.length} tracked file edit(s) in this chat? (not just the rewound turn)`,
              items: [
                { label: 'Keep file changes', value: 'keep' },
                { label: 'Revert ALL file changes in this chat', value: 'revert' },
              ],
              onSelect: (v) => {
                setPicker(null);
                if (v === 'revert') {
                  void client
                    .invoke('diffs:revertAll', convIdRef.current)
                    .then(() => pushTurn({ kind: 'note', text: 'file edits reverted' }))
                    .catch((err) =>
                      pushTurn({
                        kind: 'error',
                        text: `revert failed: ${(err as { message?: string })?.message ?? err}`,
                      }),
                    );
                } else {
                  pushTurn({ kind: 'note', text: 'kept file changes' });
                }
              },
            });
          }
          break;
        }
        case 'usage':
        case 'cost': {
          const s = await client.invoke<{
            totalInputTokens?: number;
            totalOutputTokens?: number;
            totalTokens?: number;
            totalCacheReadTokens?: number;
            totalCacheWriteTokens?: number;
            cacheHitRatio?: number;
            llmRequests?: number;
            totalConversations?: number;
            imagesGenerated?: number;
            videosGenerated?: number;
          }>('usage:summary');
          if (!s) {
            pushTurn({ kind: 'note', text: 'no usage data yet' });
            break;
          }
          const n = (v?: number) => (v ?? 0).toLocaleString();
          const lines = [
            `tokens: ${n(s.totalTokens)} total  (in ${n(s.totalInputTokens)} / out ${n(s.totalOutputTokens)})`,
            `cache: read ${n(s.totalCacheReadTokens)} / write ${n(s.totalCacheWriteTokens)}` +
              (s.cacheHitRatio != null ? `  (${Math.round(s.cacheHitRatio * 100)}% hit)` : ''),
            `requests: ${n(s.llmRequests)}   chats: ${n(s.totalConversations)}` +
              (s.imagesGenerated ? `   images: ${n(s.imagesGenerated)}` : '') +
              (s.videosGenerated ? `   videos: ${n(s.videosGenerated)}` : ''),
          ];
          pushTurn({ kind: 'note', text: lines.join('\n') });
          break;
        }
        case 'export': {
          // Syntax: /export [json|md] [path…]. A leading format token is
          // consumed; EVERYTHING after it is the path (so paths with spaces
          // work). A format token anywhere alone (no path) is also accepted.
          const raw = arg.trim();
          let fmt: 'json' | 'markdown' = 'markdown';
          let targetPath = raw;
          const fmtMatch = raw.match(/^(json|md|markdown)\b\s*/i);
          if (fmtMatch) {
            fmt = fmtMatch[1].toLowerCase() === 'json' ? 'json' : 'markdown';
            targetPath = raw.slice(fmtMatch[0].length);
          }
          targetPath = targetPath.trim();
          if (!targetPath) targetPath = `${convIdRef.current.slice(0, 8)}.${fmt === 'json' ? 'json' : 'md'}`;
          const res = await client.invoke<{ ok?: boolean; filePath?: string; error?: string }>(
            'conversations:export',
            convIdRef.current,
            fmt,
            { targetPath },
          );
          if (res?.ok && res.filePath) {
            pushTurn({ kind: 'note', text: `exported (${fmt}) → ${stripControl(res.filePath)}` });
          } else {
            pushTurn({ kind: 'note', text: `export failed: ${stripControl(res?.error ?? 'unknown')}` });
          }
          break;
        }
        case 'mcp': {
          const config = await client.invoke<{ mcpServers?: Array<{ name: string; enabled?: boolean }> }>('config:get');
          const servers = Array.isArray(config?.mcpServers) ? config.mcpServers : [];
          if (servers.length === 0) {
            pushTurn({ kind: 'note', text: 'no MCP servers configured' });
            break;
          }
          const lines = servers.map(
            (sv) => `  ${sv.enabled === false ? '○' : '●'} ${stripControl(String(sv.name ?? '?'))}`,
          );
          pushTurn({ kind: 'note', text: `MCP servers:\n${lines.join('\n')}` });
          break;
        }
        case 'tools': {
          const config = await client.invoke<{ cliTools?: Array<{ name: string; enabled?: boolean }> }>('config:get');
          const cliTools = Array.isArray(config?.cliTools) ? config.cliTools : [];
          if (cliTools.length === 0) {
            pushTurn({ kind: 'note', text: 'no CLI tools configured' });
            break;
          }
          const lines = cliTools.map(
            (t) => `  ${t.enabled === false ? '○' : '●'} ${stripControl(String(t.name ?? '?'))}`,
          );
          pushTurn({ kind: 'note', text: `CLI tools:\n${lines.join('\n')}` });
          break;
        }
        case 'skills': {
          const listed = await client.invoke<Array<{ name: string; enabled?: boolean }>>('skills:list');
          const skills = Array.isArray(listed) ? listed : [];
          if (skills.length === 0) {
            pushTurn({ kind: 'note', text: 'no skills installed' });
            break;
          }
          const lines = skills.map(
            (sk) => `  ${sk.enabled === false ? '○' : '●'} ${stripControl(String(sk.name ?? '?'))}`,
          );
          pushTurn({ kind: 'note', text: `skills:\n${lines.join('\n')}` });
          break;
        }
        case 'agents': {
          const listed = await client.invoke<Array<{ name: string; status?: string }>>('agents:list');
          const agents = Array.isArray(listed) ? listed : [];
          if (agents.length === 0) {
            pushTurn({ kind: 'note', text: 'no agents configured' });
            break;
          }
          const lines = agents.map(
            (a) => `  ${stripControl(String(a.name ?? '?'))}${a.status ? `  (${stripControl(String(a.status))})` : ''}`,
          );
          pushTurn({ kind: 'note', text: `agents:\n${lines.join('\n')}` });
          break;
        }
        case 'subagents':
        case 'sub-agents': {
          const res = await client.invoke<{ ids?: string[] }>('agent:sub-agent-list');
          const ids = Array.isArray(res?.ids) ? res.ids : [];
          if (ids.length === 0) {
            pushTurn({ kind: 'note', text: 'no active sub-agents' });
            break;
          }
          const lines = ids.map((sid) => `  • ${stripControl(String(sid))}`);
          pushTurn({
            kind: 'note',
            text: `active sub-agents (${ids.length}):\n${lines.join('\n')}\n(stop one with /subagent-stop <id>)`,
          });
          break;
        }
        case 'subagent-stop':
        case 'sub-agent-stop': {
          const res = await client.invoke<{ ids?: string[] }>('agent:sub-agent-list');
          const ids = res?.ids ?? [];
          if (ids.length === 0) {
            pushTurn({ kind: 'note', text: 'no active sub-agents to stop' });
            break;
          }
          const target = arg.trim();
          if (target) {
            // Exact match wins; otherwise accept a prefix ONLY if it's
            // unambiguous — a prefix matching multiple ids must not silently
            // stop an arbitrary one.
            let match = ids.find((sid) => sid === target);
            if (!match) {
              const prefixed = ids.filter((sid) => sid.startsWith(target));
              if (prefixed.length === 1) match = prefixed[0];
              else if (prefixed.length > 1) {
                pushTurn({ kind: 'note', text: `ambiguous "${target}" — matches: ${prefixed.join(', ')}` });
                break;
              }
            }
            if (!match) {
              pushTurn({ kind: 'note', text: `no sub-agent matching "${target}"` });
              break;
            }
            try {
              await client.invoke('agent:sub-agent-stop', match);
              pushTurn({ kind: 'note', text: `stopped sub-agent ${match}` });
            } catch (err) {
              pushTurn({ kind: 'error', text: `stop failed: ${(err as { message?: string })?.message ?? err}` });
            }
            break;
          }
          // No id given → pick from a menu.
          setPicker({
            title: 'Stop which sub-agent?',
            items: ids.map((sid) => ({ label: sid, value: sid })),
            onSelect: (sid) => {
              setPicker(null);
              void client
                .invoke('agent:sub-agent-stop', sid)
                .then(() => pushTurn({ kind: 'note', text: `stopped sub-agent ${sid}` }))
                .catch((err) =>
                  pushTurn({ kind: 'error', text: `stop failed: ${(err as { message?: string })?.message ?? err}` }),
                );
            },
          });
          break;
        }
        case 'shot':
        case 'screenshot': {
          if (statusRef.current === 'running' || statusRef.current === 'awaiting-approval') {
            pushTurn({ kind: 'note', text: 'a turn is in progress — wait for it to finish or /quit' });
            break;
          }
          const noteId = `n-${Date.now()}`;
          pushLoadingNote(noteId, 'capturing screenshot…');
          let shot: { imageDataUrl?: string } | null = null;
          try {
            shot = await client.invoke<{ imageDataUrl?: string }>('app-shots:capture');
          } catch (err) {
            resolveNote(
              noteId,
              `screenshot failed: ${(err as { message?: string })?.message ?? 'App Shots may be disabled'}`,
            );
            break;
          }
          if (!shot?.imageDataUrl) {
            resolveNote(noteId, 'screenshot failed: no image captured');
            break;
          }
          resolveNote(noteId, 'captured screenshot — sending');
          const caption = arg.trim() || 'Describe this screenshot.';
          sendMessageRef.current(caption, undefined, [{ image: shot.imageDataUrl, mimeType: 'image/png' }]);
          break;
        }
        case 'quit':
        case 'exit':
          exit();
          break;
        default:
          pushTurn({ kind: 'note', text: `unknown command /${cmd} — try /help` });
      }
    },
    [
      client,
      createNew,
      pushTurn,
      exit,
      fetchCatalog,
      refreshBanner,
      applySelectionFast,
      pushLoadingNote,
      resolveNote,
      reloadTranscript,
    ],
  );

  // Terminal handler for a turn that failed BEFORE any stream event (submit
  // threw or resolved { ok:false }). Mirrors the effect's settleTurn: drain one
  // queued message or go idle, guarded so it runs once per turn.
  const failTurnAndDrain = useCallback(() => {
    if (turnSettledRef.current) return;
    turnSettledRef.current = true;
    if (queueRef.current.length > 0) {
      const next = queueRef.current.shift() as string;
      setTimeout(() => sendMessageRef.current(next), 0);
    } else {
      setStatus('idle');
    }
  }, []);

  const sendMessage = useCallback(
    (trimmed: string, submitText?: string, attachments?: Array<{ image: string; mimeType?: string }>) => {
      pushTurn({ kind: 'user', text: trimmed });
      setStatus('running');
      streamingRef.current = '';
      turnSettledRef.current = false; // new turn — arm the terminal-event guard
      // Tag this submit so we skip re-rendering our own broadcast echo of the
      // user turn (we just showed it above); the backend echoes this nonce.
      const submitNonce = randomUUID();
      ownSubmitNoncesRef.current.add(submitNonce);
      const toSubmit = submitText ?? trimmed;
      void (async () => {
        try {
          // Persist a lazily-created chat on its first message (see createNew).
          // Clear the draft only AFTER a successful put, so a failed save doesn't
          // lose it — the catch below leaves unsavedRecordRef intact for a retry.
          const unsaved = unsavedRecordRef.current;
          if (unsaved) {
            await client.invoke('conversations:put', unsaved);
            await client.invoke('conversations:set-active-id', unsaved.id);
            unsavedRecordRef.current = null;
          }
          // agent:submit RESOLVES with { ok:false } (doesn't throw) when the
          // conversation is gone — treat that as a terminal error so the turn
          // doesn't sit 'running' forever with no stream event to settle it.
          const res = await client.invoke<{ ok?: boolean; error?: string }>(
            'agent:submit',
            convIdRef.current,
            toSubmit,
            {
              cwd: CWD,
              submitNonce,
              ...(attachments && attachments.length > 0 ? { attachments } : {}),
            },
          );
          if (res && res.ok === false) {
            setTurns((prev) => [...prev, { kind: 'error', text: `submit failed: ${res.error ?? 'unknown'}` }]);
            failTurnAndDrain();
          }
        } catch (err) {
          setTurns((prev) => [
            ...prev,
            { kind: 'error', text: `submit failed: ${(err as { message?: string })?.message ?? err}` },
          ]);
          failTurnAndDrain();
        }
      })();
    },
    [client, pushTurn, failTurnAndDrain],
  );
  // Keep a ref so the stream-event effect (which doesn't depend on sendMessage)
  // can flush the queue on `done` without re-subscribing.
  sendMessageRef.current = sendMessage;

  const submit = useCallback(
    (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) return;
      if (trimmed.startsWith('/')) {
        const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
        void runCommand(cmd, rest.join(' '));
        return;
      }
      // A turn is in flight — queue this message instead of aborting it. It's
      // flushed after the current turn's `done` (see the stream-event effect).
      if (status === 'running' || status === 'awaiting-approval') {
        queueRef.current.push(trimmed);
        pushTurn({ kind: 'note', text: `queued: ${trimmed}` });
        return;
      }
      // Handle @mentions. Image mentions (@foo.png) become real image
      // attachments (agent:submit accepts image parts) and are stripped from the
      // prompt text; remaining @file mentions inline their contents as text.
      if (/(^|\s)@/.test(trimmed)) {
        const img = extractImageMentions(trimmed, CWD);
        for (const note of img.notes) pushTurn({ kind: 'note', text: note });
        // Run text @file expansion on whatever text remains after image tokens.
        const file = expandFileMentions(img.text, CWD);
        for (const note of file.notes) pushTurn({ kind: 'note', text: note });
        const attachments = img.attachments;
        const submitText = file.text !== trimmed ? file.text : undefined;
        if (submitText !== undefined || attachments.length > 0) {
          sendMessage(trimmed, submitText, attachments.length > 0 ? attachments : undefined);
          return;
        }
      }
      sendMessage(trimmed);
    },
    [status, runCommand, pushTurn, sendMessage],
  );

  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  // ESC while a turn is in flight → cancel it (agent:cancel-stream). Two quick
  // ESC presses while idle → open the rewind/revert menu (same as /rewind 1).
  // Skipped entirely when a Picker is open — the Picker owns ESC (its onCancel
  // rejects a pending tool, etc.), so we must not also act on it here.
  const lastEscRef = useRef<number>(0);
  const DOUBLE_ESC_MS = 500;
  useInput(
    (_input, key) => {
      if (!key.escape) return;
      if (picker) return; // Picker handles its own ESC
      const now = Date.now();
      if (statusRef.current === 'running' || statusRef.current === 'awaiting-approval') {
        lastEscRef.current = 0; // a cancel is not part of a double-ESC sequence
        pushTurn({ kind: 'note', text: 'cancelling…' });
        void client.invoke('agent:cancel-stream', convIdRef.current).catch(() => {});
        return;
      }
      // Idle: detect a double-ESC within the window → rewind menu.
      if (now - lastEscRef.current <= DOUBLE_ESC_MS) {
        lastEscRef.current = 0;
        void runCommand('rewind', '1');
      } else {
        lastEscRef.current = now;
      }
    },
    { isActive: true },
  );

  const cols = stdout?.columns ?? 80;

  return (
    <Box flexDirection="column" width={cols}>
      <Banner
        productName={__BRAND_PRODUCT_NAME}
        version={__APP_VERSION}
        modelLabel={fallbackModelLabel ?? modelLabel}
        modelFellBack={fallbackModelLabel !== null}
        profileLabel={profileLabel}
        pending={pending}
        cwd={CWD}
      />
      {/* Transcript */}
      <Box flexDirection="column" flexGrow={1}>
        {turns.map((t, i) => (
          <TurnView key={i} turn={t} />
        ))}
        {streamingRef.current.trim() ? (
          <Box marginTop={1} flexDirection="column">
            <Text color="magenta" bold>
              kai
            </Text>
            <Text>{renderMarkdown(streamingRef.current)}</Text>
          </Box>
        ) : null}
        {tools.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {tools.map((t) => (
              <ToolRow
                key={t.id}
                name={t.name}
                status={t.status}
                durationMs={t.durationMs}
                error={t.error}
                expanded={expandTools}
                args={t.args}
                result={t.result}
              />
            ))}
          </Box>
        ) : null}
      </Box>

      {/* Picker (approvals, model/profile, resume) overlays the input */}
      {picker ? (
        <Picker
          title={picker.title}
          items={picker.items}
          onSelect={picker.onSelect}
          onFreeText={picker.onFreeText}
          onCancel={() => {
            const c = picker.onCancel;
            setPicker(null);
            c?.();
          }}
        />
      ) : (
        <InputBox status={status} conversationId={conversationId} onSubmit={submit} />
      )}
      {connState !== 'ok' ? (
        <Box>
          {connState === 'reconnecting' ? (
            <Text color="yellow">
              <Spinner type="dots" /> <Text dimColor>backend disconnected — reconnecting…</Text>
            </Text>
          ) : (
            <Text color="green" dimColor>
              reconnected
            </Text>
          )}
        </Box>
      ) : null}
      {quitHint ? (
        <Box>
          <Text dimColor>Press Ctrl+C again to quit</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function TurnView({ turn }: { turn: Turn }): React.ReactElement {
  switch (turn.kind) {
    case 'user':
      return (
        <Box marginTop={1} flexDirection="column">
          <Text color="blue" bold>
            you
          </Text>
          <Text>{stripControl(turn.text)}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box marginTop={1} flexDirection="column">
          <Text color="magenta" bold>
            kai
          </Text>
          <Text>{renderMarkdown(turn.text)}</Text>
        </Box>
      );
    case 'error':
      return (
        <Box marginTop={1}>
          {/* Error text may carry model/provider-controlled content — strip
              ESC/OSC at the terminal boundary. */}
          <Text color="red">✗ {stripControl(turn.text)}</Text>
        </Box>
      );
    case 'note':
      return (
        <Box>
          {turn.loading ? (
            <Text color="yellow">
              <Spinner type="dots" />{' '}
            </Text>
          ) : null}
          <Text dimColor>{stripControl(turn.text)}</Text>
        </Box>
      );
  }
}
