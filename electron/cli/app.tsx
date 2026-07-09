import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp, useStdout, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { randomUUID } from 'crypto';
import type { LocalBridgeClient } from './client.js';
import { renderMarkdown, stripControl } from './render/markdown.js';
import { InputBox } from './components/InputBox.js';
import { ToolRow, type ToolStatus } from './components/ToolRow.js';
import { Picker, type PickerItem } from './components/Picker.js';
import { Banner } from './components/Banner.js';

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

type ToolEntry = { id: string; name: string; status: ToolStatus; durationMs?: number; error?: string };

type PickerState = {
  title: string;
  items: PickerItem[];
  onSelect: (value: string) => void;
  onCancel?: () => void; // Esc handler — e.g. reject/dismiss a pending tool so the backend isn't left hung
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
}: {
  client: LocalBridgeClient;
  recover?: () => Promise<boolean>;
}): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();

  // Ctrl-C: Ink's built-in exitOnCtrlC is disabled (so startRepl's graceful
  // shutdown handshake can run) — in raw mode Ctrl-C arrives as input, not a
  // SIGINT signal, so we catch it here and route to Ink's exit(), which
  // resolves waitUntilExit() and lets startRepl clean up the backend.
  useInput((_input, key) => {
    if (key.ctrl && _input === 'c') exit();
  });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [tools, setTools] = useState<ToolEntry[]>([]);
  const [status, setStatus] = useState<'idle' | 'running' | 'awaiting-approval'>('idle');
  const [conversationId, setConversationId] = useState<string>('');
  const [picker, setPicker] = useState<PickerState>(null);
  const [modelLabel, setModelLabel] = useState<string>('default');
  const [fallbackModelLabel, setFallbackModelLabel] = useState<string | null>(null); // runtime model-fallback override
  const [profileLabel, setProfileLabel] = useState<string>('unset');
  const [pending, setPending] = useState<'model' | 'profile' | null>(null); // which banner line is applying
  const streamingRef = useRef<string>(''); // in-progress assistant text
  const convIdRef = useRef<string>('');
  const unsavedRecordRef = useRef<Record<string, unknown> | null>(null); // new chat not yet persisted
  // Messages typed while a turn is in flight are queued (FIFO) and flushed one
  // at a time after each `done`, instead of aborting the live turn. A ref (not
  // state) so the stream-event effect can read/flush without re-subscribing.
  const queueRef = useRef<string[]>([]);
  const sendMessageRef = useRef<(text: string) => void>(() => {});
  // Guards double-draining the queue: the backend can emit `error` THEN `done`
  // for the same turn. Only the first terminal event of a turn drains one
  // queued message. Reset when a new turn starts (sendMessage).
  const turnSettledRef = useRef<boolean>(false);
  // Mirror of `status` for reads inside callbacks that must not re-create on
  // every status change (runCommand). Kept in sync below.
  const statusRef = useRef<'idle' | 'running' | 'awaiting-approval'>('idle');
  statusRef.current = status;

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

    const off = client.on('agent:stream-event', (raw) => {
      const e = raw as StreamEvent;
      if (!e || e.conversationId !== convIdRef.current) return;
      switch (e.type) {
        case 'text-delta':
          if (e.text) {
            streamingRef.current += e.text;
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
            setTools((prev) =>
              prev.some((t) => t.id === id)
                ? prev.map((t) => (t.id === id ? { ...t, name, status: 'running' } : t))
                : [...prev, { id, name, status: 'running' }],
            );
          }
          break;
        case 'tool-result': {
          // A tool-result can still be a failure — the runtime emits errors as
          // tool-result with { isError: true } / { error }. Don't show success.
          const res = e.result as { isError?: boolean; error?: string } | undefined;
          const failed = !!res?.isError || typeof res?.error === 'string';
          setTools((prev) =>
            prev.map((t) =>
              t.id === e.toolCallId
                ? {
                    ...t,
                    status: failed ? 'error' : 'done',
                    durationMs: e.durationMs,
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
          break;
        case 'done':
          finalizeAssistant();
          settleTurn();
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
      setTurns((prev) => [
        ...prev,
        { kind: 'note', text: 'backend disconnected — reconnecting…', loading: true, id: 'reconnect' },
      ]);
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
        resolveNote('reconnect', 'reconnected');
      })();
    });

    return () => {
      off();
      offDisc();
    };
  }, [client, recover, exit, resolveNote, promptAskUser]);

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
            text: '/new  /resume  /model [name]  /profile [name]  /rewind [n]  /clear  /quit',
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
        case 'compact':
          pushTurn({ kind: 'note', text: '/compact not yet wired — coming soon' });
          break;
        case 'rewind':
        case 'revert': {
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

  const sendMessage = useCallback(
    (trimmed: string) => {
      pushTurn({ kind: 'user', text: trimmed });
      setStatus('running');
      streamingRef.current = '';
      turnSettledRef.current = false; // new turn — arm the terminal-event guard
      void (async () => {
        try {
          // Persist a lazily-created chat on its first message (see createNew).
          const unsaved = unsavedRecordRef.current;
          if (unsaved) {
            unsavedRecordRef.current = null;
            await client.invoke('conversations:put', unsaved);
            await client.invoke('conversations:set-active-id', unsaved.id);
          }
          await client.invoke('agent:submit', convIdRef.current, trimmed, { cwd: CWD });
        } catch (err) {
          setTurns((prev) => [
            ...prev,
            { kind: 'error', text: `submit failed: ${(err as { message?: string })?.message ?? err}` },
          ]);
          setStatus('idle');
        }
      })();
    },
    [client, pushTurn],
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
      sendMessage(trimmed);
    },
    [status, runCommand, pushTurn, sendMessage],
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
              <ToolRow key={t.id} name={t.name} status={t.status} durationMs={t.durationMs} error={t.error} />
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
          onCancel={() => {
            const c = picker.onCancel;
            setPicker(null);
            c?.();
          }}
        />
      ) : (
        <InputBox status={status} conversationId={conversationId} onSubmit={submit} />
      )}
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
