import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp, useStdout } from 'ink';
import { randomUUID } from 'crypto';
import type { LocalBridgeClient } from './client.js';
import { renderMarkdown } from './render/markdown.js';
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
  error?: string;
  durationMs?: number;
  data?: unknown;
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
  | { kind: 'note'; text: string }
  | { kind: 'error'; text: string };

type ToolEntry = { id: string; name: string; status: ToolStatus; durationMs?: number; error?: string };

type PickerState = {
  title: string;
  items: PickerItem[];
  onSelect: (value: string) => void;
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

export function App({ client }: { client: LocalBridgeClient }): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [tools, setTools] = useState<ToolEntry[]>([]);
  const [status, setStatus] = useState<'idle' | 'running' | 'awaiting-approval'>('idle');
  const [conversationId, setConversationId] = useState<string>('');
  const [picker, setPicker] = useState<PickerState>(null);
  const [modelLabel, setModelLabel] = useState<string>('default');
  const [profileLabel, setProfileLabel] = useState<string>('unset');
  const [pending, setPending] = useState<string | null>(null); // transient "applying…" hint
  const streamingRef = useRef<string>(''); // in-progress assistant text
  const convIdRef = useRef<string>('');

  const pushTurn = useCallback((t: Turn) => setTurns((prev) => [...prev, t]), []);

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
  // currently selected keys (null ⇒ model shows the catalog default, profile
  // shows "unset"). Called on new-chat, resume, and after a /model or /profile
  // switch so the banner always reflects live state.
  const refreshBanner = useCallback(async () => {
    try {
      const conv =
        (await client.invoke<{ selectedModelKey?: string | null; selectedProfileKey?: string | null } | null>(
          'conversations:get',
          convIdRef.current,
        )) ?? {};
      const [model, profile] = await Promise.all([fetchCatalog('model'), fetchCatalog('profile')]);

      const modelKey = conv.selectedModelKey ?? model.defaultKey;
      setModelLabel(model.items.find((i) => i.value === modelKey)?.label ?? (modelKey || 'default'));

      const profileKey = conv.selectedProfileKey ?? null;
      setProfileLabel(profileKey ? (profile.items.find((i) => i.value === profileKey)?.label ?? profileKey) : 'unset');
    } catch {
      // leave existing labels on transient errors
    }
  }, [client, fetchCatalog]);

  // ── conversation setup ──────────────────────────────────────────────
  const createNew = useCallback(async () => {
    const rec = newConversationRecord(CWD);
    await client.invoke('conversations:put', rec);
    await client.invoke('conversations:set-active-id', rec.id);
    convIdRef.current = rec.id as string;
    setConversationId(rec.id as string);
    setTurns([]);
    setTools([]);
    void refreshBanner();
  }, [client, refreshBanner]);

  useEffect(() => {
    void createNew();
  }, []);

  // ── live stream subscription ────────────────────────────────────────
  useEffect(() => {
    const finalizeAssistant = (): void => {
      const text = streamingRef.current;
      streamingRef.current = '';
      if (text.trim()) setTurns((prev) => [...prev, { kind: 'assistant', text }]);
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
            setTools((prev) => [...prev, { id: e.toolCallId!, name: e.toolName ?? 'tool', status: 'running' }]);
          }
          break;
        case 'tool-result':
          setTools((prev) =>
            prev.map((t) => (t.id === e.toolCallId ? { ...t, status: 'done', durationMs: e.durationMs } : t)),
          );
          break;
        case 'tool-error':
          setTools((prev) => prev.map((t) => (t.id === e.toolCallId ? { ...t, status: 'error', error: e.error } : t)));
          break;
        case 'tool-approval-required':
          setStatus('awaiting-approval');
          if (e.toolCallId) {
            setTools((prev) => prev.map((t) => (t.id === e.toolCallId ? { ...t, status: 'awaiting' } : t)));
            const id = e.toolCallId;
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
            });
          }
          break;
        case 'error':
          finalizeAssistant();
          setTurns((prev) => [...prev, { kind: 'error', text: e.error ?? 'unknown error' }]);
          break;
        case 'done':
          finalizeAssistant();
          setStatus('idle');
          break;
      }
    });

    const offDisc = client.onDisconnect(() => {
      setTurns((prev) => [...prev, { kind: 'error', text: 'backend disconnected' }]);
      setTimeout(() => exit(), 100);
    });

    return () => {
      off();
      offDisc();
    };
  }, [client]);

  // ── command + input handling ────────────────────────────────────────
  const applySelection = useCallback(
    async (cmd: string, value: string) => {
      const conv = (await client.invoke<Record<string, unknown> | null>('conversations:get', convIdRef.current)) ?? {};
      const patch = cmd === 'model' ? { ...conv, selectedModelKey: value } : { ...conv, selectedProfileKey: value };
      await client.invoke('conversations:put', patch);
    },
    [client],
  );

  const runCommand = useCallback(
    async (cmd: string, arg: string) => {
      switch (cmd) {
        case 'help':
          pushTurn({
            kind: 'note',
            text: '/new  /resume  /model [name]  /profile [name]  /compact  /rewind  /clear  /quit',
          });
          break;
        case 'new':
          await createNew();
          break;
        case 'clear':
          setTurns([]);
          setTools([]);
          break;
        case 'resume': {
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
                setConversationId(id);
                await client.invoke('conversations:set-active-id', id);
                const full = await client.invoke<ConversationRecord | null>('conversations:get', id);
                const replay: Turn[] = [];
                for (const m of full?.messages ?? []) {
                  const msg = m as { role?: string; content?: unknown };
                  const text = contentToText(msg.content).trim();
                  if (text) replay.push({ kind: msg.role === 'user' ? 'user' : 'assistant', text });
                }
                setTurns([{ kind: 'note', text: `resumed ${id.slice(0, 8)}` }, ...replay]);
                setTools([]);
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
              // Optimistic: reflect the choice immediately, show a spinner while
              // the change propagates to the leader (several socket round-trips).
              if (cmd === 'model') setModelLabel(match.label);
              else setProfileLabel(match.label);
              setPending(`applying ${cmd}…`);
              await applySelection(cmd, match.value);
              await refreshBanner();
              setPending(null);
              pushTurn({ kind: 'note', text: `${cmd} → ${match.label}` });
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
              setPending(`applying ${cmd}…`);
              void applySelection(cmd, v)
                .then(() => refreshBanner())
                .finally(() => {
                  setPending(null);
                  pushTurn({ kind: 'note', text: `${cmd} → ${label}` });
                });
            },
          });
          break;
        }
        case 'compact':
          pushTurn({ kind: 'note', text: 'compacting…' });
          try {
            await client.invoke('agent:compact', convIdRef.current);
            pushTurn({ kind: 'note', text: 'compacted' });
          } catch (err) {
            pushTurn({ kind: 'error', text: `compact failed: ${err instanceof Error ? err.message : String(err)}` });
          }
          break;
        case 'rewind':
        case 'revert':
          pushTurn({ kind: 'note', text: '/rewind not yet wired — coming soon' });
          break;
        case 'quit':
        case 'exit':
          exit();
          break;
        default:
          pushTurn({ kind: 'note', text: `unknown command /${cmd} — try /help` });
      }
    },
    [client, createNew, pushTurn, exit, fetchCatalog, refreshBanner, applySelection],
  );

  const submit = useCallback(
    (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) return;
      if (trimmed.startsWith('/')) {
        const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
        void runCommand(cmd, rest.join(' '));
        return;
      }
      pushTurn({ kind: 'user', text: trimmed });
      setStatus('running');
      streamingRef.current = '';
      void client.invoke('agent:submit', convIdRef.current, trimmed, { cwd: CWD }).catch((err) => {
        setTurns((prev) => [...prev, { kind: 'error', text: `submit failed: ${err?.message ?? err}` }]);
        setStatus('idle');
      });
    },
    [client, runCommand, pushTurn],
  );

  const cols = stdout?.columns ?? 80;

  return (
    <Box flexDirection="column" width={cols}>
      <Banner
        productName={__BRAND_PRODUCT_NAME}
        version={__APP_VERSION}
        modelLabel={modelLabel}
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
        <Picker title={picker.title} items={picker.items} onSelect={picker.onSelect} onCancel={() => setPicker(null)} />
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
          <Text>{turn.text}</Text>
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
          <Text color="red">✗ {turn.text}</Text>
        </Box>
      );
    case 'note':
      return (
        <Box>
          <Text dimColor>{turn.text}</Text>
        </Box>
      );
  }
}
