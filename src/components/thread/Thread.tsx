import { useState, useEffect, useCallback, useRef, type FC, type PropsWithChildren } from 'react';
import {
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ActionBarPrimitive,
  useAui,
  useThreadRuntime,
  useMessage,
  useComposerRuntime,
} from '@assistant-ui/react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  SendHorizontalIcon,
  CopyIcon,
  CheckIcon,
  RefreshCwIcon,
  StopCircleIcon,
  PlusIcon,
  XIcon,
  FileIcon,
  FileTextIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  BanIcon,

  Volume2Icon,
  SquareIcon,
  MicIcon,
  PointerIcon,
  ChevronUpIcon,
  PhoneIcon,
  MonitorIcon,
  FolderOpenIcon,
  ImageIcon,
  LoaderIcon,
  MessageSquareTextIcon,
  ArrowUpIcon,
  ArrowDownIcon,
} from 'lucide-react';
import { app } from '@/lib/ipc-client';
import { copyTextToClipboard, logClipboardError } from '@/lib/clipboard';
import { useAttachments } from '@/providers/AttachmentContext';
import { useAssistantResponseTiming, useBranchNav, useCurrentWorkingDirectory, type TokenUsageData } from '@/providers/RuntimeProvider';
import { useConfig } from '@/providers/ConfigProvider';
import { useRealtime } from '@/providers/RealtimeProvider';
import { isDictationSupportedForProvider, createUnifiedDictationAdapter, type DictationSession, type AudioProvider } from '@/lib/audio/speech-adapters';
import { WebAudioMonitor } from '@/lib/audio/web-audio-monitor';
import { MarkdownText } from './MarkdownText';
import { UserCodeMarkdown } from './UserCodeMarkdown';
import { ElapsedBadge } from './ElapsedBadge';
import { backgrounds } from '@/components/backgrounds';
import { ToolCallDisplay } from './ToolGroup';
import { SubAgentInline } from './SubAgentInline';
import { PipelineInsights } from './PipelineInsights';
import type { PipelineEnrichments } from './PipelineInsights';
import { TokenUsage } from './TokenUsage';
import { ComposerInput } from './ComposerInput';
import { RichChatInput } from './RichChatInput';
import { DeviceRow } from './DeviceRow';
import { SearchBar } from './SearchBar';
import type { ReasoningEffort } from './ReasoningEffortSelector';
import { ModelSettingsButton } from './ModelSettingsButton';
import { Tooltip } from '@/components/ui/Tooltip';
import { FallbackBanner, ComputerUseFallbackBanner } from './FallbackBanner';
import { usePopoverAlign } from '@/hooks/usePopoverAlign';
import { useSplitButtonHover } from '@/hooks/useSplitButtonHover';
import { CallOverlay } from './CallOverlay';
import { ComputerSessionPanel } from './ComputerSessionPanel';
import { ComputerSetupPanel } from './ComputerSetupPanel';
import { ComputerSettingsButton } from './ComputerSettingsButton';
import type { ExecutionMode } from './ModelSettingsButton';
import { useComputerUse } from '@/providers/ComputerUseProvider';
import { usePlugins } from '@/providers/PluginProvider';
import { shouldShowComputerSetup, isComputerSessionTerminal, type ComputerSession, type ComputerUseTarget, type ComputerUseApprovalMode } from '../../../shared/computer-use';
import { getResponseTiming } from '@/lib/response-timing';
import { SPINNER_VERBS } from '@/config/spinner-verbs';

export type ThreadMode = 'chat' | 'computer';

export const Thread: FC<{
  mode: ThreadMode;
  onChangeMode: (mode: ThreadMode) => void;
  selectedModelKey: string | null;
  onSelectModel: (key: string) => void;
  reasoningEffort: ReasoningEffort;
  onChangeReasoningEffort: (value: ReasoningEffort) => void;
  executionMode: ExecutionMode;
  onChangeExecutionMode: (value: ExecutionMode) => void;
  selectedProfileKey: string | null;
  onSelectProfile: (key: string | null, primaryModelKey: string | null) => void;
  fallbackEnabled: boolean;
  onToggleFallback: (value: boolean) => void;
}> = ({ mode, onChangeMode, selectedModelKey, onSelectModel, reasoningEffort, onChangeReasoningEffort, executionMode, onChangeExecutionMode, selectedProfileKey, onSelectProfile, fallbackEnabled, onToggleFallback }) => {
  const [searchOpen, setSearchOpen] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const { callState } = useRealtime();
  const activeConversationId = useActiveConversationId();
  const threadRuntime = useThreadRuntime();
  const [hasMessages, setHasMessages] = useState(() => threadRuntime.getState().messages.length > 0);
  useEffect(() => {
    return threadRuntime.subscribe(() => {
      setHasMessages(threadRuntime.getState().messages.length > 0);
    });
  }, [threadRuntime]);

  const { uiState: pluginUIState } = usePlugins();
  const threadDecorations = (pluginUIState?.threadDecorations ?? []).filter((decoration) => (
    decoration.visible && (!decoration.conversationId || decoration.conversationId === activeConversationId)
  ));

  useEffect(() => {
    if (!window.app?.onFind) return;
    const cleanup = window.app.onFind(() => setSearchOpen(true));
    return cleanup;
  }, []);

  return (
    <ThreadPrimitive.Root className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <FadingSplash>
        <EmptyThreadBackground />
      </FadingSplash>
      <SearchBar visible={searchOpen} onClose={() => setSearchOpen(false)} viewportRef={viewportRef} />
      <FallbackBanner />
      <ComputerUseFallbackBanner />
      {threadDecorations.length > 0 && (
        <div className="border-b border-border/60 bg-background/65 px-3 py-2 backdrop-blur-sm md:px-6">
          <div className="mx-auto flex w-full max-w-5xl flex-wrap gap-2">
            {threadDecorations.map((decoration) => (
              <span
                key={`${decoration.pluginName}-${decoration.id}`}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                  decoration.variant === 'error'
                    ? 'bg-red-500/10 text-red-700 dark:text-red-300'
                    : decoration.variant === 'warning'
                      ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                      : decoration.variant === 'success'
                        ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                        : 'bg-blue-500/10 text-blue-700 dark:text-blue-300'
                }`}
              >
                {decoration.label}
              </span>
            ))}
          </div>
        </div>
      )}
      {mode === 'chat' ? (
        <ThreadPrimitive.Viewport ref={viewportRef} className="relative min-h-0 flex-1 overflow-y-auto">
          <PinnedUserMessage viewportRef={viewportRef} />
          <div className="flex min-h-full flex-col">
            <div className="flex-1">
              <div className="relative z-10 mx-auto flex w-full max-w-5xl flex-col px-3 pr-5 pt-16 md:px-6 md:pr-8 md:pt-20">
                <ThreadPrimitive.Messages
                  components={{
                    UserMessage,
                    AssistantMessage,
                  }}
                />

                <div className="min-h-2" />
              </div>
            </div>
            <div className="sticky bottom-0 z-20">
              {hasMessages && <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-[15] h-56 bg-gradient-to-t from-background from-25% via-background/70 via-55% to-transparent md:h-64" />}
            {callState.isInCall ? (
              <CallOverlay />
            ) : (
              <Composer
                mode={mode}
                onChangeMode={onChangeMode}
                selectedModelKey={selectedModelKey}
                onSelectModel={onSelectModel}
                reasoningEffort={reasoningEffort}
                onChangeReasoningEffort={onChangeReasoningEffort}
                executionMode={executionMode}
                onChangeExecutionMode={onChangeExecutionMode}
                selectedProfileKey={selectedProfileKey}
                onSelectProfile={onSelectProfile}
                fallbackEnabled={fallbackEnabled}
                onToggleFallback={onToggleFallback}
              />
            )}
          </div>
          </div>
        </ThreadPrimitive.Viewport>
      ) : (
        <>
          <ComputerTabSurface />
          {callState.isInCall ? (
            <CallOverlay />
          ) : (
            <Composer
              mode={mode}
              onChangeMode={onChangeMode}
              selectedModelKey={selectedModelKey}
              onSelectModel={onSelectModel}
              reasoningEffort={reasoningEffort}
              onChangeReasoningEffort={onChangeReasoningEffort}
              executionMode={executionMode}
              onChangeExecutionMode={onChangeExecutionMode}
              selectedProfileKey={selectedProfileKey}
              onSelectProfile={onSelectProfile}
              fallbackEnabled={fallbackEnabled}
              onToggleFallback={onToggleFallback}
            />
          )}
        </>
      )}
    </ThreadPrimitive.Root>
  );
};

function useActiveConversationId(): string | null {
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    app.conversations.getActiveId()
      .then((id) => {
        if (!cancelled) setActiveConversationId(id as string | null);
      })
      .catch(() => {
        if (!cancelled) setActiveConversationId(null);
      });

    const unsubscribe = app.conversations.onChanged((store) => {
      const payload = store as { activeConversationId?: string | null } | null;
      if (!cancelled) {
        setActiveConversationId(payload?.activeConversationId ?? null);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return activeConversationId;
}

function getActiveComputerSession(
  conversationId: string | null,
  sessionsByConversation: Map<string, ComputerSession[]>,
): ComputerSession | undefined {
  if (!conversationId) return undefined;
  return sessionsByConversation.get(conversationId)?.[0];
}

const ComputerTabSurface: FC = () => {
  const activeConversationId = useActiveConversationId();
  const { sessionsByConversation } = useComputerUse();
  const activeComputerSession = getActiveComputerSession(activeConversationId, sessionsByConversation);

  if (!activeComputerSession) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-3 py-4 md:px-6">
          <div className="mx-auto flex w-full max-w-5xl min-h-0 flex-col">
            <div className="flex min-h-full flex-1 items-center justify-center rounded-2xl border border-dashed border-border/60 bg-card/20 px-6 py-8">
              <div className="max-w-md text-center">
                <MonitorIcon className="mx-auto h-8 w-8 text-muted-foreground/40" />
                <div className="mt-3 text-sm font-medium">{activeConversationId ? 'No Active Session' : 'Select a Conversation'}</div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {activeConversationId
                    ? 'Configure a goal and start a session using the controls below.'
                    : 'Choose or create a conversation from the sidebar first.'}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="px-3 py-4 md:px-6">
        <div className="mx-auto flex w-full max-w-5xl min-h-0 flex-col">
          <ComputerSessionPanel session={activeComputerSession} />
        </div>
      </div>
    </div>
  );
};

/** Directory browser for web UI users to select a working directory on the host. */
const DirectoryBrowser: FC<{ onSelect: (path: string) => void; onCancel: () => void }> = ({ onSelect, onCancel }) => {
  const [currentPath, setCurrentPath] = useState<string>('~');
  const [resolvedPath, setResolvedPath] = useState<string>('');
  const [entries, setEntries] = useState<Array<{ name: string; isDirectory: boolean }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDirectory = useCallback(async (dirPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await (window.app as unknown as Record<string, unknown> & { fs: { listDirectory: (p: string) => Promise<{ path?: string; entries: Array<{ name: string; isDirectory: boolean }>; error?: string }> } }).fs.listDirectory(dirPath);
      if (result.error) {
        setError(result.error);
        setEntries([]);
      } else {
        setEntries(result.entries);
        if (result.path) {
          setResolvedPath(result.path);
          setCurrentPath(result.path);
        }
      }
    } catch (err) {
      setError(String(err));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadDirectory(currentPath); }, []);

  const navigateTo = (dirName: string) => {
    const next = currentPath === '/' ? `/${dirName}` : `${currentPath}/${dirName}`;
    setCurrentPath(next);
    void loadDirectory(next);
  };

  const navigateUp = () => {
    const parent = currentPath.replace(/\/[^/]+\/?$/, '') || '/';
    setCurrentPath(parent);
    void loadDirectory(parent);
  };

  return (
    <div className="absolute inset-x-0 bottom-full z-30 mx-3 mb-2 max-h-[60vh] overflow-hidden rounded-2xl border border-border/70 bg-card/95 shadow-xl backdrop-blur-md md:mx-6">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <FolderOpenIcon className="h-4 w-4 shrink-0 text-primary" />
          <span className="text-xs font-medium">Select Working Directory</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onSelect(resolvedPath || currentPath)}
            className="rounded-lg bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Select
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-border/70 px-3 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/50"
          >
            Cancel
          </button>
        </div>
      </div>
      <div className="border-b border-border/40 bg-muted/20 px-4 py-1.5">
        <span className="block truncate text-[11px] font-mono text-muted-foreground" title={resolvedPath || currentPath}>
          {resolvedPath || currentPath}
        </span>
      </div>
      <div className="max-h-[45vh] overflow-y-auto">
        {currentPath !== '/' && (
          <button
            type="button"
            onClick={navigateUp}
            className="flex w-full items-center gap-2 px-4 py-2 text-xs transition-colors hover:bg-muted/50"
          >
            <ChevronLeftIcon className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">..</span>
          </button>
        )}
        {loading && (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">Loading...</div>
        )}
        {error && (
          <div className="px-4 py-3 text-xs text-red-400">{error}</div>
        )}
        {!loading && !error && entries.filter((e) => e.isDirectory).map((entry) => (
          <button
            key={entry.name}
            type="button"
            onClick={() => navigateTo(entry.name)}
            className="flex w-full items-center gap-2 px-4 py-2 text-xs transition-colors hover:bg-muted/50"
          >
            <FolderOpenIcon className="h-3.5 w-3.5 text-primary/70" />
            <span className="truncate">{entry.name}</span>
          </button>
        ))}
        {!loading && !error && entries.filter((e) => e.isDirectory).length === 0 && (
          <div className="px-4 py-3 text-xs text-muted-foreground">No subdirectories</div>
        )}
      </div>
    </div>
  );
};

const GuidanceComposer: FC<{ sessionId: string; onReturnToChat: () => void }> = ({ sessionId, onReturnToChat }) => {
  const [text, setText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const { sendGuidance } = useComputerUse();

  const handleSend = () => {
    if (!text.trim() || isSending) return;
    setIsSending(true);
    void sendGuidance(sessionId, text.trim())
      .then(() => setText(''))
      .finally(() => setIsSending(false));
  };

  return (
    <div className="rounded-2xl border border-border/70 app-composer-glass px-3 py-3 app-composer-shadow">
      <div className="flex items-center gap-2">
        <RichChatInput
          value={text}
          onChange={setText}
          onSubmit={handleSend}
          placeholder="Guide the session... (Enter to send)"
          className="min-h-[36px] max-h-[180px] flex-1 bg-transparent px-1 py-1 text-sm outline-none"
        />
        <Tooltip content="Return to chat">
          <button
            type="button"
            onClick={onReturnToChat}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-500/15 text-blue-600 transition-colors hover:bg-blue-500/25 dark:text-blue-400"
          >
            <MonitorIcon className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
        <button
          type="button"
          onClick={handleSend}
          disabled={!text.trim() || isSending}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
        >
          <SendHorizontalIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};

/** Pick a random background, never repeating the last one shown */
function pickBackground(): FC {
  const lastIndex = parseInt(sessionStorage.getItem('__bg_last_index') ?? '-1', 10);
  const available = backgrounds.length > 1
    ? backgrounds.filter((_, i) => i !== lastIndex)
    : backgrounds;
  return available[Math.floor(Math.random() * available.length)];
}

/**
 * Randomly selected background for the empty thread state.
 * Never repeats the same background consecutively.
 *
 * Background is selected once on mount via useState initializer.
 * FadingSplash unmounts children when fading out (visible=false),
 * so each new empty thread triggers a fresh mount and a new pick.
 *
 * The last-shown index is persisted in sessionStorage so it survives
 * HMR and component remounts. The write happens in a useEffect (not during
 * pick) to avoid React StrictMode double-invocation issues.
 */
const EmptyThreadBackground: FC = () => {
  const [Background] = useState<FC>(() => pickBackground());

  // Persist which background is displayed — useEffect only commits once,
  // unlike useState initializers which StrictMode may call twice.
  useEffect(() => {
    const idx = backgrounds.indexOf(Background);
    if (idx !== -1) sessionStorage.setItem('__bg_last_index', String(idx));
  }, [Background]);

  return (
    <div className="absolute inset-0">
      <Background />
    </div>
  );
};

/**
 * User-message navigator — sticks to the top of the viewport and lets you
 * jump up/down between user messages in the thread.
 */
const PinnedUserMessage: FC<{ viewportRef: React.RefObject<HTMLDivElement | null> }> = ({ viewportRef }) => {
  const threadRuntime = useThreadRuntime();

  // All user messages extracted from the thread (text + attachment counts)
  const [userMessages, setUserMessages] = useState<
    { text: string; imageCount: number; fileCount: number }[]
  >([]);

  // Navigation state computed from scroll position
  const [prevIdx, setPrevIdx] = useState<number | null>(null);
  const [nextIdx, setNextIdx] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Subscribe to thread messages and extract all user messages
  useEffect(() => {
    const update = () => {
      const msgs = threadRuntime.getState().messages;
      const users: { text: string; imageCount: number; fileCount: number }[] = [];
      for (const msg of msgs) {
        if (msg.role !== 'user') continue;
        const textParts = (msg.content ?? [])
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join('\n');
        const imageCount = (msg.content ?? []).filter((p) => p.type === 'image').length;
        const fileCount = (msg.content ?? []).filter((p) => p.type === 'file').length;
        if (textParts || imageCount || fileCount) {
          users.push({ text: textParts, imageCount, fileCount });
        }
      }
      setUserMessages(users);
    };
    update();
    return threadRuntime.subscribe(update);
  }, [threadRuntime]);

  // Collapse preview when the widget hides
  useEffect(() => {
    if (prevIdx === null && nextIdx === null) setExpanded(false);
  }, [prevIdx, nextIdx]);

  // Scroll listener: determine which user messages are above/below the viewport
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || userMessages.length === 0) {
      setPrevIdx(null);
      setNextIdx(null);
      return;
    }

    let rafId = 0;
    const compute = () => {
      const sentinels = viewport.querySelectorAll('[data-pinned-sentinel]');
      if (sentinels.length === 0) {
        setPrevIdx(null);
        setNextIdx(null);
        return;
      }

      const viewTop = viewport.scrollTop;
      const viewBottom = viewTop + viewport.clientHeight;
      const threshold = 48; // px — sentinel must be this far outside the viewport to count

      let prev: number | null = null;
      let next: number | null = null;

      for (let i = 0; i < sentinels.length; i++) {
        const el = sentinels[i] as HTMLElement;
        const top = el.offsetTop;
        const bottom = top + el.offsetHeight;

        if (bottom < viewTop + threshold) {
          // Sentinel is above the viewport
          prev = i;
        } else if (top > viewBottom - threshold && next === null) {
          // Sentinel is below the viewport
          next = i;
        }
      }

      setPrevIdx(prev);
      setNextIdx(next);
    };

    const onScroll = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(compute);
    };

    // Initial computation
    compute();

    viewport.addEventListener('scroll', onScroll, { passive: true });
    // Recompute when DOM changes (new messages)
    const mo = new MutationObserver(compute);
    mo.observe(viewport, { childList: true, subtree: true });

    return () => {
      cancelAnimationFrame(rafId);
      viewport.removeEventListener('scroll', onScroll);
      mo.disconnect();
    };
  }, [viewportRef, userMessages.length]);

  const scrollTo = useCallback(
    (idx: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const sentinels = viewport.querySelectorAll('[data-pinned-sentinel]');
      sentinels[idx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    [viewportRef],
  );

  const visible = prevIdx !== null || nextIdx !== null;
  const prevMsg = prevIdx !== null ? userMessages[prevIdx] : null;
  const nextMsg = nextIdx !== null ? userMessages[nextIdx] : null;
  const hasAnyText = (prevMsg?.text || nextMsg?.text);

  if (userMessages.length === 0) return null;

  return (
    <div
      className={`sticky top-0 z-[35] transition-all duration-200 ${
        visible
          ? 'pt-14 md:pt-16 translate-y-0 opacity-100'
          : 'h-0 overflow-hidden pointer-events-none opacity-0'
      }`}
    >
      <div className="mx-auto flex w-full max-w-5xl justify-end px-3 pr-5 md:px-6 md:pr-8">
        <div className="max-w-[88%] md:max-w-[72%]">
          <div
            className="ml-auto flex w-fit max-w-full items-stretch rounded-xl border text-foreground shadow-lg backdrop-blur-md"
            style={{
              backgroundColor: 'var(--app-user-bubble)',
              borderColor: 'var(--app-user-bubble-border)',
            }}
          >
            {/* Stacked rows: each direction gets its own preview + arrow */}
            <div className="flex min-w-0 flex-col">
              {prevIdx !== null && (
                <div className="flex items-center">
                  {expanded && prevMsg?.text && (
                    <div className="min-w-0 flex-1 animate-in fade-in slide-in-from-right-2 duration-150">
                      <p className="line-clamp-2 px-4 py-2 text-sm leading-5 text-foreground/80">{prevMsg.text}</p>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => scrollTo(prevIdx)}
                    className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-foreground/50 transition-colors hover:bg-foreground/10 hover:text-foreground/80"
                    title="Previous user message"
                  >
                    <ArrowUpIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {prevIdx !== null && nextIdx !== null && (
                <div className="mx-2 border-t border-foreground/10" />
              )}
              {nextIdx !== null && (
                <div className="flex items-center">
                  {expanded && nextMsg?.text && (
                    <div className="min-w-0 flex-1 animate-in fade-in slide-in-from-right-2 duration-150">
                      <p className="line-clamp-2 px-4 py-2 text-sm leading-5 text-foreground/80">{nextMsg.text}</p>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => scrollTo(nextIdx)}
                    className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-foreground/50 transition-colors hover:bg-foreground/10 hover:text-foreground/80"
                    title="Next user message"
                  >
                    <ArrowDownIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>

            {/* Toggle button for expand/collapse — sits on the right edge */}
            {hasAnyText && (
              <div className="flex items-center border-l border-foreground/10 px-1">
                <button
                  type="button"
                  onClick={() => setExpanded((e) => !e)}
                  className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-foreground/50 transition-colors hover:bg-foreground/10 hover:text-foreground/80"
                  title={expanded ? 'Collapse previews' : 'Show previews'}
                >
                  <MessageSquareTextIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Wrapper that fades the splash IN (500ms) when the thread is empty,
 * then fades it OUT (300ms) when the first message is sent.
 *
 * When `visible` is false, children are unmounted (returned null).
 * This means EmptyThreadBackground remounts on each new empty thread,
 * triggering a fresh pickBackground() via its useState initializer.
 */
const FadingSplash: FC<PropsWithChildren> = ({ children }) => {
  const threadRuntime = useThreadRuntime();
  const [visible, setVisible] = useState(true);
  const [fadingOut, setFadingOut] = useState(false);
  const [fadedIn, setFadedIn] = useState(false);
  const fadingOutRef = useRef(false);

  // Reset visibility when threadRuntime identity changes (thread switch)
  useEffect(() => {
    const msgs = threadRuntime.getState().messages;
    if (msgs.length === 0) {
      setVisible(true);
      setFadingOut(false);
      fadingOutRef.current = false;
      setFadedIn(false);
      // Double RAF: first frame paints at opacity:0, second frame triggers the transition
      requestAnimationFrame(() => requestAnimationFrame(() => setFadedIn(true)));
    } else {
      setVisible(false);
      setFadingOut(true);
      fadingOutRef.current = true;
    }
  }, [threadRuntime]);

  // Subscribe to message changes — fade out when messages appear,
  // fade in when messages go back to empty.
  useEffect(() => {
    return threadRuntime.subscribe(() => {
      const msgs = threadRuntime.getState().messages;
      if (msgs.length > 0 && !fadingOutRef.current) {
        // When loading an existing thread (many messages appear at once),
        // hide the splash instantly to avoid a visible overlay during the
        // scroll-to-bottom positioning. Only use the gradual fade when a
        // single message is sent in a new conversation.
        if (msgs.length > 1) {
          setVisible(false);
          setFadingOut(false);
          fadingOutRef.current = true;
        } else {
          setFadingOut(true);
          fadingOutRef.current = true;
        }
      } else if (msgs.length === 0) {
        setVisible(true);
        setFadingOut(false);
        fadingOutRef.current = false;
        setFadedIn(false);
        requestAnimationFrame(() => requestAnimationFrame(() => setFadedIn(true)));
      }
    });
  }, [threadRuntime]);

  // Unmount children after fade-out completes
  useEffect(() => {
    if (!fadingOut) return;
    const timer = setTimeout(() => setVisible(false), 300);
    return () => clearTimeout(timer);
  }, [fadingOut]);

  if (!visible) return null;

  return (
    <div
      className="absolute inset-0 bottom-3 z-10 transition-opacity ease-out"
      style={{
        opacity: fadingOut ? 0 : fadedIn ? 1 : 0,
        transitionDuration: fadingOut ? '300ms' : '2000ms',
      }}
    >
      <div>{children}</div>
    </div>
  );
};

const UserMessage: FC = () => {
  const message = useMessage();
  const { config } = useConfig();
  const ttsEnabled = (config as Record<string, unknown> | null)?.audio
    ? ((config as Record<string, unknown>).audio as { tts?: { enabled?: boolean } })?.tts?.enabled ?? true
    : true;
  return (
    <MessagePrimitive.Root className="group mb-6 flex justify-end" data-pinned-sentinel>
      <div className="max-w-[88%] md:max-w-[72%]">
        <div
          className="w-fit ml-auto rounded-xl border px-4 py-2.5 text-foreground"
          style={{
            backgroundColor: 'var(--app-user-bubble)',
            borderColor: 'var(--app-user-bubble-border)',
          }}
        >
          <MessagePrimitive.Content components={userContentComponents} />
        </div>
        <div className={`flex items-center justify-end gap-1 mt-1 transition-opacity ${message.isLast ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
          <MessageTimestamp date={message.createdAt} align="right" />
          <ActionBarPrimitive.Root className="flex items-center gap-1">
            <CopyButton />
            {ttsEnabled && <SpeakButton />}
          </ActionBarPrimitive.Root>
        </div>
      </div>
    </MessagePrimitive.Root>
  );
};

const UserImagePart: FC<{ image: string }> = ({ image }) => {
  const [previewOpen, setPreviewOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setPreviewOpen(true)} className="block my-1">
        <img
          src={image}
          alt="Attached"
          className="max-w-[25vw] max-h-[200px] rounded-lg object-contain cursor-pointer hover:opacity-90 transition-opacity"
        />
      </button>
      {previewOpen && <FilePreviewModal src={image} onClose={() => setPreviewOpen(false)} />}
    </>
  );
};

const UserFilePart: FC<{ data?: string; mimeType?: string; filename?: string; file?: unknown }> = (props) => {
  const [previewOpen, setPreviewOpen] = useState(false);
  const filename = props.filename ?? 'file';
  const mimeType = props.mimeType ?? '';
  const data = props.data ?? '';
  const isPdf = mimeType === 'application/pdf';
  const isPreviewable = isPdf || mimeType.startsWith('image/');

  const ext = filename.split('.').pop()?.toUpperCase() ?? 'FILE';
  const iconColors: Record<string, string> = {
    PDF: 'bg-red-500/20 text-red-400',
    JSON: 'bg-yellow-500/20 text-yellow-400',
    MD: 'bg-blue-500/20 text-blue-400',
    TS: 'bg-blue-600/20 text-blue-300',
    TSX: 'bg-blue-600/20 text-blue-300',
    JS: 'bg-yellow-400/20 text-yellow-300',
    PY: 'bg-green-500/20 text-green-400',
    CSV: 'bg-emerald-500/20 text-emerald-400',
    TXT: 'bg-gray-500/20 text-gray-400',
  };
  const badgeClass = iconColors[ext] ?? 'bg-gray-500/20 text-gray-400';

  return (
    <>
      <button
        type="button"
        onClick={() => isPreviewable && data && setPreviewOpen(true)}
        className={`flex items-center gap-2.5 my-1.5 rounded-lg border px-3 py-2 text-left transition-colors ${isPreviewable ? 'cursor-pointer' : 'cursor-default'}`}
        style={{
          backgroundColor: 'var(--app-file-chip)',
          borderColor: 'var(--app-user-bubble-border)',
        }}
        onMouseEnter={(event) => {
          if (isPreviewable) event.currentTarget.style.backgroundColor = 'var(--app-file-chip-hover)';
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.backgroundColor = 'var(--app-file-chip)';
        }}
      >
        <div className={`flex h-9 w-9 items-center justify-center rounded-md text-[10px] font-bold ${badgeClass}`}>
          {ext}
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-xs font-medium truncate max-w-[200px]">{filename}</span>
          <span className="text-[10px] opacity-60">{mimeType}</span>
        </div>
        {isPreviewable && (
          <span className="text-[10px] opacity-50 ml-auto shrink-0">Click to preview</span>
        )}
      </button>
      {previewOpen && data && <FilePreviewModal src={data} onClose={() => setPreviewOpen(false)} />}
    </>
  );
};

const FilePreviewModal: FC<{ src: string; onClose: () => void }> = ({ src, onClose }) => {
  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex cursor-pointer items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-label="File preview"
    >
      <div className="flex flex-col items-end gap-2" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-800 border border-neutral-600 shadow-xl hover:bg-neutral-600 active:bg-neutral-500 cursor-pointer select-none transition-colors"
        >
          <XIcon className="h-5 w-5 text-white pointer-events-none" />
        </button>
        {src.startsWith('data:application/pdf') ? (
          <iframe src={src} className="w-[80vw] h-[85vh] rounded-lg bg-white" title="PDF preview" />
        ) : (
          <img src={src} alt="Preview" className="max-w-[90vw] max-h-[85vh] rounded-lg object-contain" />
        )}
      </div>
    </div>
  );
};

/**
 * ToolFallback receives props directly from assistant-ui:
 * { toolCallId, toolName, args, argsText, result, isError, addResult, resume, ... }
 */
const ToolFallback: FC<{
  toolCallId: string;
  toolName: string;
  args: unknown;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
  startedAt?: string;
  finishedAt?: string;
  originalResult?: unknown;
  compactionMeta?: {
    wasCompacted: boolean;
    extractionDurationMs: number;
  };
  compactionPhase?: 'start' | 'complete' | null;
  liveOutput?: {
    stdout?: string;
    stderr?: string;
    truncated?: boolean;
    stopped?: boolean;
  };
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  approvalId?: string;
}> = (props) => {
  const hasResult = props.result !== undefined;
  const isError = props.isError || (hasResult && props.result && typeof props.result === 'object' && (
    (props.result as Record<string, unknown>).error || (props.result as Record<string, unknown>).isError === true
  ));
  const isRunning = !hasResult;
  const dotColor = isRunning
    ? 'bg-blue-500 animate-pulse'
    : isError
      ? 'bg-red-500'
      : 'bg-emerald-500';

  const threadRuntime = useThreadRuntime();
  const handleSendFeedback = useCallback((text: string) => {
    threadRuntime.append({
      role: 'user',
      content: [{ type: 'text', text }],
    });
  }, [threadRuntime]);

  // Render sub-agent tool calls with the specialized component
  if (props.toolName === 'sub_agent') {
    return (
      <div className="timeline-item my-1">
        <span className={`timeline-dot timeline-dot-tool ${dotColor}`} />
        <SubAgentInline
          toolCallId={props.toolCallId}
          args={props.args}
          result={props.result}
          isError={props.isError}
          liveOutput={props.liveOutput}
        />
      </div>
    );
  }

  return (
    <div className="timeline-item my-1">
      <span className={`timeline-dot timeline-dot-tool ${dotColor}`} />
      <ToolCallDisplay
        part={{
          type: 'tool-call',
          toolCallId: props.toolCallId ?? `tc-${Date.now()}`,
          toolName: props.toolName ?? 'unknown',
          args: props.args ?? {},
          argsText: props.argsText ?? JSON.stringify(props.args, null, 2),
          result: props.result,
          isError: props.isError,
          startedAt: props.startedAt,
          finishedAt: props.finishedAt,
          originalResult: props.originalResult,
          compactionMeta: props.compactionMeta,
          compactionPhase: props.compactionPhase,
          liveOutput: props.liveOutput,
          approvalStatus: props.approvalStatus,
          approvalId: props.approvalId,
        }}
        onSendFeedback={handleSendFeedback}
      />
    </div>
  );
};

/** Wraps consecutive tool calls */
const ToolGroupWrapper: FC<PropsWithChildren> = ({ children }) => (
  <div className="space-y-0">
    {children}
  </div>
);

/* ── Hoisted components for MessagePrimitive.Content (stable refs prevent remounting) ── */

const UserTextPart: FC<{ text: string }> = ({ text }) => {
  if (text.startsWith('\n\n--- File:') || text.startsWith('\n[Attached file:')) return null;
  return <UserCodeMarkdown text={text} className="text-sm leading-6 text-foreground" />;
};

const userContentComponents = {
  Text: UserTextPart,
  Image: UserImagePart,
  File: UserFilePart,
};

const AssistantTextPart: FC<{ text: string }> = ({ text }) => {
  if (!text) return null;
  return (
    <div className="timeline-item py-0.5">
      <span className="timeline-dot bg-[oklch(0.55_0.01_0)]" />
      <div className="min-w-0 flex-1"><MarkdownText text={text} /></div>
    </div>
  );
};

const ThinkingSpinner: FC = () => {
  const [currentVerb, setCurrentVerb] = useState<string>(
    () => SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)],
  );
  const [displayText, setDisplayText] = useState(() => currentVerb + '...');
  const [cursorPos, setCursorPos] = useState(-1); // -1 = no cursor visible
  const nextVerbRef = useRef('');
  const frameRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pick a new verb every ~4s and animate the transition
  useEffect(() => {
    const interval = setInterval(() => {
      let next: string;
      do {
        next = SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)];
      } while (next === currentVerb);
      nextVerbRef.current = next + '...';
      setCursorPos(0); // start sweep
    }, 4000);
    return () => clearInterval(interval);
  }, [currentVerb]);

  // Animate the block cursor sweep: reveal new text char-by-char
  useEffect(() => {
    if (cursorPos < 0) return; // no animation in progress

    const target = nextVerbRef.current;
    const maxLen = Math.max(displayText.length, target.length);

    if (cursorPos > maxLen) {
      // Animation complete — settle on new text
      setDisplayText(target);
      setCursorPos(-1);
      setCurrentVerb(target.replace(/\.\.\.$/, ''));
      return;
    }

    // Build the display: new chars up to cursor, then cursor block, then old chars after
    const revealed = target.slice(0, cursorPos);
    const remaining = displayText.slice(cursorPos + 1);
    setDisplayText(revealed + '\u2588' + remaining); // █ block cursor

    frameRef.current = setTimeout(() => {
      setCursorPos((p) => p + 1);
    }, 25); // ~25ms per character for a quick sweep

    return () => {
      if (frameRef.current) clearTimeout(frameRef.current);
    };
  }, [cursorPos]);

  return (
    <div className="timeline-item py-0.5">
      <span className="timeline-dot-icon">
        <span className="thinking-spinner text-muted-foreground/50 select-none" aria-hidden="true" />
      </span>
      <span className="text-xs font-mono text-muted-foreground/60 whitespace-pre">
        {displayText}
      </span>
    </div>
  );
};

/** Inline interrupt divider — shown where the user interrupted the AI's speech */
const InterruptDivider: FC = () => (
  <div className="my-2 flex items-center gap-2">
    <div className="h-px flex-1 bg-amber-500/40" />
    <div className="flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5">
      <SquareIcon className="h-2.5 w-2.5 text-amber-600 dark:text-amber-400" />
      <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">Interrupted</span>
    </div>
    <div className="h-px flex-1 bg-amber-500/40" />
  </div>
);

/** Struck-through text for the unspoken portion after an interrupt */
const UnspokenTextPart: FC<{ text: string }> = ({ text }) => {
  if (!text) return null;
  return (
    <div className="py-0.5 text-muted-foreground/50 line-through decoration-muted-foreground/30">
      <MarkdownText text={text} />
    </div>
  );
};

const assistantContentComponents = {
  Text: AssistantTextPart,
  tools: {
    Fallback: ToolFallback,
  },
  ToolGroup: ToolGroupWrapper,
};

const AssistantMessage: FC = () => {
  const message = useMessage();
  const { activeRunStartedAt } = useAssistantResponseTiming();
  const isRunning = message.status?.type === 'running';
  const content = message.content ?? [];
  const hasContent = content.some((p: { type: string; text?: string }) =>
    p.type === 'tool-call' || (p.type === 'text' && p.text?.trim()),
  );
  const isEmpty = !isRunning && !hasContent;

  // Check if this message has an interrupt (source: 'interrupt' or 'unspoken')
  const hasInterrupt = content.some((p: { type: string; source?: string }) =>
    p.type === 'text' && (p.source === 'interrupt' || p.source === 'unspoken'),
  );

  // Extract pipeline enrichments stored as a content part
  const enrichmentsPart = content.find((p: { type: string }) => p.type === 'enrichments') as
    | { type: 'enrichments'; enrichments: PipelineEnrichments }
    | undefined;
  const pipelineEnrichments = enrichmentsPart?.enrichments ?? null;

  const tokenUsage = (message as { tokenUsage?: TokenUsageData }).tokenUsage ?? null;
  const responseTiming = getResponseTiming(message);
  const badgeStartedAt = responseTiming?.startedAt ?? (isRunning ? activeRunStartedAt ?? undefined : undefined);
  const badgeFinishedAt = responseTiming?.finishedAt;

  // Mark first/last .timeline-item so CSS can clip the line at the dots
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const allItems = Array.from(el.querySelectorAll('.timeline-item'));
    const items = allItems.filter((item) => {
      const parent = item.closest('.aui-typing-dots');
      return !parent || getComputedStyle(parent).display !== 'none';
    });
    if (items.length >= 2) {
      const containerRect = el.getBoundingClientRect();
      const firstDot = items[0].querySelector('.timeline-dot, .timeline-dot-icon');
      const lastDot = items[items.length - 1].querySelector('.timeline-dot, .timeline-dot-icon');
      if (firstDot && lastDot) {
        const firstRect = firstDot.getBoundingClientRect();
        const lastRect = lastDot.getBoundingClientRect();
        const top = firstRect.top + firstRect.height / 2 - containerRect.top;
        const bottom = containerRect.bottom - (lastRect.top + lastRect.height / 2);
        el.style.setProperty('--timeline-top', `${top}px`);
        el.style.setProperty('--timeline-bottom', `${bottom}px`);
        el.classList.add('has-timeline');
      } else {
        el.classList.remove('has-timeline');
      }
    } else {
      el.classList.remove('has-timeline');
    }
  });

  return (
    <MessagePrimitive.Root className="group mb-8 flex justify-start">
      <div className="w-full max-w-4xl">
        <div ref={contentRef} className="aui-assistant-content relative overflow-hidden pr-4 py-3 text-foreground">
          {isEmpty ? (
            <div className="flex items-center gap-2 py-0.5 text-muted-foreground">
              <BanIcon className="h-3.5 w-3.5" />
              <span className="text-xs italic">Response cancelled</span>
            </div>
          ) : hasInterrupt ? (
            /* Render interrupted message with custom layout */
            <>
              {content.map((part: { type: string; text?: string; source?: string }, idx: number) => {
                if (part.type !== 'text') return null;
                if (part.source === 'interrupt') return <InterruptDivider key={`interrupt-${idx}`} />;
                if (part.source === 'unspoken') return <UnspokenTextPart key={`unspoken-${idx}`} text={part.text ?? ''} />;
                return <AssistantTextPart key={`text-${idx}`} text={part.text ?? ''} />;
              })}
            </>
          ) : (
            <>
              <MessagePrimitive.Content components={assistantContentComponents} />
              {/* Thinking spinner: visible inside assistant bubble, hidden by CSS once content parts render */}
              <div className="aui-typing-dots">
                <ThinkingSpinner />
              </div>
            </>
          )}
          {pipelineEnrichments && <PipelineInsights enrichments={pipelineEnrichments} />}
          {tokenUsage && !isRunning && <TokenUsage usage={tokenUsage} />}
        </div>
        <div className={`flex items-center gap-1 mt-1 transition-opacity ${message.isLast ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
          <AssistantActionBar />
          <MessageTimestamp date={message.createdAt} align="left" />
          {badgeStartedAt && (
            <span className="ml-2 -translate-y-px">
              <ElapsedBadge
                startedAt={badgeStartedAt}
                finishedAt={badgeFinishedAt}
                isRunning={isRunning}
              />
            </span>
          )}
        </div>
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  const { config } = useConfig();
  const ttsEnabled = (config as Record<string, unknown> | null)?.audio
    ? ((config as Record<string, unknown>).audio as { tts?: { enabled?: boolean } })?.tts?.enabled ?? true
    : true;
  return (
    <ActionBarPrimitive.Root className="flex items-center gap-1">
      <CopyButton />
      {ttsEnabled && <SpeakButton />}
      <ActionBarPrimitive.Reload asChild>
        <button type="button" className="flex h-7 w-7 items-center justify-center rounded-xl hover:bg-muted transition-colors" title="Regenerate">
          <RefreshCwIcon className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </ActionBarPrimitive.Reload>

      <BranchPicker />
    </ActionBarPrimitive.Root>
  );
};

/** Custom branch picker using our tree-based branching */
const BranchPicker: FC = () => {
  const nav = useBranchNav();
  if (!nav || nav.total <= 1) return null;

  return (
    <div className="flex items-center gap-0.5 ml-1">
      <button
        type="button"
        onClick={nav.goToPrevious}
        disabled={nav.current <= 1}
        className="flex h-7 w-7 items-center justify-center rounded-xl hover:bg-muted transition-colors disabled:opacity-30"
        title="Previous variant"
      >
        <ChevronLeftIcon className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      <span className="text-[10px] text-muted-foreground tabular-nums min-w-[2rem] text-center">
        {nav.current} / {nav.total}
      </span>
      <button
        type="button"
        onClick={nav.goToNext}
        disabled={nav.current >= nav.total}
        className="flex h-7 w-7 items-center justify-center rounded-xl hover:bg-muted transition-colors disabled:opacity-30"
        title="Next variant"
      >
        <ChevronRightIcon className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
    </div>
  );
};

const CopyButton: FC = () => {
  const aui = useAui();
  const message = useMessage();
  const [copied, setCopied] = useState(false);
  const hasCopyableContent = (message.role !== 'assistant' || message.status?.type !== 'running')
    && message.content.some((part: { type: string; text?: string }) => part.type === 'text' && (part.text?.length ?? 0) > 0);

  const handleCopy = useCallback(async () => {
    const valueToCopy = aui.message().getCopyText();
    if (!valueToCopy) return;

    try {
      await copyTextToClipboard(valueToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      setCopied(false);
      logClipboardError('Failed to copy message', error);
    }
  }, [aui]);

  if (!hasCopyableContent) return null;

  return (
    <button type="button" className="flex h-7 w-7 items-center justify-center rounded-xl hover:bg-muted transition-colors" title="Copy" onClick={() => { void handleCopy(); }}>
      {copied ? <CheckIcon className="h-3.5 w-3.5 text-green-500" /> : <CopyIcon className="h-3.5 w-3.5 text-muted-foreground" />}
    </button>
  );
};

const SpeakButton: FC = () => {
  const message = useMessage();
  // The assistant-ui runtime tracks speech state on the message:
  // message.speech is non-null when speaking, null when idle
  const isSpeaking = (message as { speech?: unknown }).speech != null;

  if (isSpeaking) {
    return (
      <ActionBarPrimitive.StopSpeaking asChild>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-xl hover:bg-muted transition-colors"
          title="Stop speaking"
        >
          <SquareIcon className="h-3 w-3 text-primary" />
        </button>
      </ActionBarPrimitive.StopSpeaking>
    );
  }

  return (
    <ActionBarPrimitive.Speak asChild>
      <button
        type="button"
        className="flex h-7 w-7 items-center justify-center rounded-xl hover:bg-muted transition-colors"
        title="Read aloud"
      >
        <Volume2Icon className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
    </ActionBarPrimitive.Speak>
  );
};

const MessageTimestamp: FC<{ date?: Date; align: 'left' | 'right' }> = ({ date, align }) => {
  if (!date) return null;
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  let label: string;
  if (isToday) {
    label = time;
  } else if (isYesterday) {
    label = `Yesterday ${time}`;
  } else {
    label = `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
  }

  return (
    <div className={`text-[10px] text-muted-foreground/60 mt-0.5 ${align === 'right' ? 'text-right' : 'text-left'}`}>
      {label}
    </div>
  );
};

/** Stop generation without restoring composer text (unlike ComposerPrimitive.Cancel which restores draft) */
const StopButton: FC = () => {
  const threadRuntime = useThreadRuntime();
  const composerRuntime = useComposerRuntime();
  return (
    <button
      type="button"
      onClick={() => {
        threadRuntime.cancelRun();
        // Force-clear the composer so it doesn't restore the previous message text
        composerRuntime.setText('');
      }}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-destructive text-destructive-foreground transition-colors hover:bg-destructive/90"
    >
      <StopCircleIcon className="h-4 w-4" />
    </button>
  );
};

interface DictationButtonProps {
  onListeningChange?: (listening: boolean) => void;
  startRef?: React.RefObject<(() => void) | null>;
  stopRef?: React.RefObject<(() => void) | null>;
  getText?: () => string;
  setText?: (text: string) => void;
}

const DictationButton: FC<DictationButtonProps> = ({ onListeningChange, startRef, stopRef, getText: externalGetText, setText: externalSetText }) => {
  const composerRuntime = useComposerRuntime();
  const getTextFn = useCallback(() => externalGetText ? externalGetText() : (composerRuntime.getState().text ?? ''), [externalGetText, composerRuntime]);
  const setTextFn = useCallback((text: string) => externalSetText ? externalSetText(text) : composerRuntime.setText(text), [externalSetText, composerRuntime]);
  const { config, updateConfig } = useConfig();
  const [isListening, _setIsListening] = useState(false);
  const [isActivating, setIsActivating] = useState(false);
  const setIsListening = useCallback((v: boolean) => {
    _setIsListening(v);
    if (v) setIsActivating(false); // transition from activating → listening
    onListeningChange?.(v);
  }, [onListeningChange]);

  // Short audio feedback tones via Web Audio API
  const playTone = useCallback((frequency: number, endFrequency: number, duration = 0.12) => {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(frequency, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(endFrequency, ctx.currentTime + duration);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration);
      setTimeout(() => ctx.close(), (duration + 0.1) * 1000);
    } catch { /* audio not available */ }
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [devices, setDevices] = useState<Array<{ deviceId: string; label: string }>>([]);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const sessionRef = useRef<DictationSession | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const popover = usePopoverAlign();
  const levelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const webMonitorUnsubRef = useRef<(() => void) | null>(null);

  const audioConfig = (config as Record<string, unknown> | null)?.audio as {
    provider?: AudioProvider;
    azure?: { endpoint?: string; region?: string; subscriptionKey?: string; sttLanguage?: string };
    dictation?: { enabled?: boolean; language?: string; continuous?: boolean; inputDeviceId?: string };
  } | undefined;
  const isWebBridgeDictation = Boolean((window as unknown as Record<string, unknown>).app && (window.app as Record<string, unknown>).__isWebBridge);
  // Azure STT relies on main-process mic capture which isn't available over
  // the web bridge — fall back to native Web Speech API for browser users.
  const audioProvider: AudioProvider = isWebBridgeDictation ? 'native' : (audioConfig?.provider ?? 'native');
  const dictationConfig = audioConfig?.dictation;
  const azureConfig = audioConfig?.azure;
  const selectedDeviceId = dictationConfig?.inputDeviceId;

  // Close picker on outside click
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    window.addEventListener('pointerdown', handler);
    return () => window.removeEventListener('pointerdown', handler);
  }, [pickerOpen]);

  // Load devices and start level monitoring when picker opens
  useEffect(() => {
    if (!pickerOpen) {
      if (!isWebBridgeDictation) window.app?.mic?.stopMonitor();
      if (levelTimerRef.current) { clearInterval(levelTimerRef.current); levelTimerRef.current = null; }
      webMonitorUnsubRef.current?.();
      webMonitorUnsubRef.current = null;
      setLevels({});
      return;
    }

    if (isWebBridgeDictation) {
      // Browser: use shared WebAudioMonitor for level monitoring
      let cancelled = false;
      const monitor = WebAudioMonitor.getInstance();
      (async () => {
        try {
          const inputs = await monitor.listInputDevices();
          if (cancelled) return;
          setDevices(inputs);
          const ids = inputs.map((d) => d.deviceId);
          webMonitorUnsubRef.current = monitor.subscribeAll(ids);
          // Poll levels from the shared monitor
          levelTimerRef.current = setInterval(() => {
            setLevels(monitor.getLevels());
          }, 66);
        } catch {
          setDevices([]);
        }
      })();
      return () => {
        cancelled = true;
        if (levelTimerRef.current) { clearInterval(levelTimerRef.current); levelTimerRef.current = null; }
        webMonitorUnsubRef.current?.();
        webMonitorUnsubRef.current = null;
      };
    }

    const mic = window.app?.mic;
    if (!mic) return;

    // Load device list, then start monitoring all devices
    mic.listDevices().then((devs) => {
      setDevices(devs);
      // Get unique device IDs (include 'default' for system default)
      const ids = ['default', ...devs.filter(d => d.deviceId !== 'default').map(d => d.deviceId)];
      mic.startMonitor(ids).then(() => {
        // Poll all levels ~15 fps
        levelTimerRef.current = setInterval(() => {
          mic.getLevel().then(setLevels).catch(() => setLevels({}));
        }, 66);
      });
    }).catch(() => setDevices([]));

    return () => {
      if (!isWebBridgeDictation) mic.stopMonitor();
      if (levelTimerRef.current) { clearInterval(levelTimerRef.current); levelTimerRef.current = null; }
    };
  }, [pickerOpen, isWebBridgeDictation]);

  // Whether "Hold to record" mode is active (continuous defaults to true = hold mode)
  const holdToRecord = dictationConfig?.continuous ?? true;

  const selectDevice = useCallback((deviceId: string | undefined) => {
    updateConfig('audio.dictation.inputDeviceId', deviceId);
  }, [updateConfig]);

  const handleStop = useCallback(() => {
    if (!isListening && !isActivating) return;
    console.log('[DictationButton] Stopping...');
    sessionRef.current?.stop();
    setIsListening(false);
    setIsActivating(false);
    sessionRef.current = null;
    playTone(480, 320); // falling tone — stop
  }, [isListening, isActivating, setIsListening, playTone]);

  const handleStart = useCallback(() => {
    setError(null);
    if (isListening || isActivating) return;

    // Enter activating state (light blue) before the SDK is ready
    setIsActivating(true);

    console.log('[DictationButton] Starting, provider=%s, deviceId=%s', audioProvider, selectedDeviceId ?? 'default');
    if (!isDictationSupportedForProvider(audioProvider, Boolean(azureConfig?.subscriptionKey))) {
      setIsActivating(false);
      setError('Speech recognition is not supported');
      return;
    }

    try {
      const adapter = createUnifiedDictationAdapter({
        provider: audioProvider,
        enabled: true,
        language: dictationConfig?.language ?? 'en-US',
        continuous: dictationConfig?.continuous ?? true,
        azure: audioProvider === 'azure' ? {
          endpoint: azureConfig?.endpoint,
          region: azureConfig?.region ?? 'eastus',
          subscriptionKey: azureConfig?.subscriptionKey ?? '',
          language: azureConfig?.sttLanguage ?? dictationConfig?.language ?? 'en-US',
          continuous: dictationConfig?.continuous ?? true,
          inputDeviceId: selectedDeviceId,
        } : undefined,
      });

      if (!adapter) { setIsActivating(false); setError('Failed to create dictation adapter'); return; }

      const session = adapter.listen();
      sessionRef.current = session;

      // Transition to listening when the speech engine is actually ready
      let transitioned = false;
      const fallbackTimer = setTimeout(() => {
        if (transitioned || !sessionRef.current) return;
        transitioned = true;
        setIsListening(true);
        playTone(320, 480);
      }, 500);

      session.onSpeechStart(() => {
        if (transitioned) return;
        transitioned = true;
        clearTimeout(fallbackTimer);
        setIsListening(true); // clears isActivating
        playTone(320, 480); // rising tone — listening
      });

      // Track the committed text (finalized segments) vs partial preview
      let baseText = getTextFn();

      session.onSpeech((result) => {
        const transcript = result.transcript?.trim();
        if (!transcript) return;
        console.log('[DictationButton] onSpeech: "%s" isFinal=%s', transcript, result.isFinal);
        if (result.isFinal) {
          baseText = baseText ? baseText.trimEnd() + ' ' + transcript : transcript;
          setTextFn(baseText);
        } else {
          const preview = baseText ? baseText.trimEnd() + ' ' + transcript : transcript;
          setTextFn(preview);
        }
      });

      const extSession = session as DictationSession & {
        onError?: (cb: (err: string) => void) => void;
      };
      extSession.onError?.((err) => {
        console.error('[DictationButton] onError:', err);
        clearTimeout(fallbackTimer);
        setIsListening(false);
        setIsActivating(false);
        sessionRef.current = null;
        setError(err === 'not-allowed' ? 'Microphone permission denied'
          : err === 'no-speech' ? 'No speech detected — try again'
          : err === 'network' ? 'Network connection required'
          : `Dictation error: ${err}`);
      });
    } catch (err) {
      console.error('[DictationButton] Failed:', err);
      setIsListening(false);
      setIsActivating(false);
      setError('Failed to start dictation');
    }
  }, [isListening, isActivating, audioProvider, dictationConfig, azureConfig, getTextFn, setTextFn, selectedDeviceId, setIsListening, playTone]);

  // Expose start/stop to parent via refs (for keyboard shortcut)
  useEffect(() => {
    if (startRef) (startRef as { current: (() => void) | null }).current = handleStart;
    if (stopRef) (stopRef as { current: (() => void) | null }).current = handleStop;
    return () => {
      if (startRef) (startRef as { current: (() => void) | null }).current = null;
      if (stopRef) (stopRef as { current: (() => void) | null }).current = null;
    };
  }, [startRef, stopRef, handleStart, handleStop]);

  // Poll session status for cleanup
  useEffect(() => {
    if (!isListening || !sessionRef.current) return;
    const session = sessionRef.current;
    const interval = setInterval(() => {
      if (session.status.type === 'ended') {
        setIsListening(false);
        sessionRef.current = null;
        clearInterval(interval);
      }
    }, 200);
    return () => clearInterval(interval);
  }, [isListening]);

  useEffect(() => { return () => { sessionRef.current?.cancel(); }; }, []);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);

  const isActive = isListening;
  const { expanded: dictationExpanded, containerProps: dictationContainerProps } = useSplitButtonHover({ popoverOpen: pickerOpen, forceExpanded: isActive || isActivating });

  return (
    <div ref={rootRef} {...dictationContainerProps} className="relative flex items-center">
      {/* Joined button group: chevron/dots + mic */}
      <div className={`flex items-center overflow-hidden rounded-lg border transition-colors ${
        isActive
          ? 'border-primary/50 bg-primary/10'
          : isActivating
            ? 'border-primary/30 bg-primary/5'
            : 'border-border/50 bg-muted/40'
      }`}>
        {/* Left segment: chevron (idle) or animated dots (active) */}
        <div className={`overflow-hidden transition-[max-width,opacity] duration-200 ease-out ${
          dictationExpanded ? 'max-w-[2.5rem] opacity-100' : 'max-w-0 opacity-0'
        }`}>
          {isActive || isActivating ? (
              <div className="flex h-10 w-10 items-center justify-center gap-[3px]">
                <span className="h-[5px] w-[5px] rounded-full bg-primary animate-bounce [animation-delay:0ms]" />
                <span className="h-[5px] w-[5px] rounded-full bg-primary animate-bounce [animation-delay:150ms]" />
                <span className="h-[5px] w-[5px] rounded-full bg-primary animate-bounce [animation-delay:300ms]" />
              </div>
            ) : (
              <Tooltip content="Microphone settings" side="top" sideOffset={8}>
                <button
                  type="button"
                  onClick={() => setPickerOpen(!pickerOpen)}
                  className="flex h-10 w-10 shrink-0 items-center justify-center transition-colors hover:bg-muted/50 text-muted-foreground"
                >
                  <ChevronUpIcon className={`h-3.5 w-3.5 transition-transform ${pickerOpen ? '' : 'rotate-180'}`} />
                </button>
              </Tooltip>
            )
          }
        </div>

        {/* Right segment: mic button */}
        <Tooltip
          content={
            <span className="flex items-center gap-2">
              {holdToRecord ? 'Press and hold to record' : 'Click to start/stop dictation'}
              <kbd className="inline-flex items-center gap-0.5 rounded bg-background/20 px-1.5 py-0.5 text-[10px] font-semibold"><span className="text-[13px] leading-none">⌘</span>D</kbd>
            </span>
          }
          side="top"
          sideOffset={8}
        >
          <button
            type="button"
            onMouseDown={holdToRecord ? handleStart : undefined}
            onMouseUp={holdToRecord ? handleStop : undefined}
            onMouseLeave={holdToRecord ? handleStop : undefined}
            onTouchStart={holdToRecord ? (e) => { e.preventDefault(); handleStart(); } : undefined}
            onTouchEnd={holdToRecord ? (e) => { e.preventDefault(); handleStop(); } : undefined}
            onClick={holdToRecord ? undefined : () => {
              if (isListening || isActivating) { handleStop(); } else { handleStart(); }
            }}
            className={`flex h-10 w-10 shrink-0 items-center justify-center transition-colors ${
              isActive
                ? 'bg-primary text-primary-foreground'
                : isActivating
                  ? 'bg-primary/40 text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted/50'
            }`}
          >
            <MicIcon className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>

      {/* Error tooltip */}
      {error && (
        <div className="absolute bottom-full right-0 mb-2 whitespace-nowrap rounded-lg bg-popover border border-border/50 px-2.5 py-1.5 text-[10px] text-muted-foreground shadow-lg z-50">
          {error}
        </div>
      )}

      {/* Device picker popover — toggled by chevron button */}
      {pickerOpen && (
        <div ref={popover.ref} style={popover.style} className="absolute bottom-full right-0 z-50 mb-2 w-[300px] max-w-[calc(100vw-2rem)] rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-[0_16px_40px_rgba(5,4,15,0.28)] backdrop-blur-xl">
          {/* Input device header with level indicator */}
          <div className="flex items-center gap-2 px-3 pt-2 pb-1">
            <MicIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide shrink-0">Input Device</span>
            <div className="flex-1 h-1.5 rounded-full bg-muted/50 overflow-hidden">
              {(() => {
                const pct = Math.min(100, Math.round((levels[selectedDeviceId ?? 'default'] ?? 0) * 500));
                const barColor = pct > 60 ? '#22c55e' : pct > 20 ? '#eab308' : '#6b7280';
                return (
                  <div
                    className="h-full rounded-full transition-all duration-75"
                    style={{ width: `${pct}%`, backgroundColor: barColor }}
                  />
                );
              })()}
            </div>
          </div>

          <div className="max-h-[280px] overflow-y-auto space-y-0.5">
            {/* Default device */}
            <DeviceRow
              label="System Default"
              selected={!selectedDeviceId}
              level={levels['default'] ?? 0}
              onClick={() => selectDevice(undefined)}
            />

            {devices.filter(d => d.deviceId !== 'default').map((d) => (
              <DeviceRow
                key={d.deviceId}
                label={d.label}
                selected={selectedDeviceId === d.deviceId}
                level={levels[d.deviceId] ?? 0}
                onClick={() => selectDevice(d.deviceId)}
              />
            ))}

            {devices.length === 0 && (
              <div className="px-3 py-3 text-[10px] text-muted-foreground text-center">
                No input devices found
              </div>
            )}
          </div>

          {/* Hold to record toggle */}
          <div className="border-t border-border/50 mx-1.5 mt-0.5" />
          <div className="flex items-center justify-between px-3 py-2">
            <div className="flex items-center gap-2">
              <PointerIcon className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Hold to record</span>
            </div>
            <button
              type="button"
              onClick={() => updateConfig('audio.dictation.continuous', !(dictationConfig?.continuous ?? true))}
              className={`relative inline-flex h-[22px] w-[40px] shrink-0 items-center rounded-full transition-colors ${
                (dictationConfig?.continuous ?? true) ? 'bg-primary' : 'bg-muted-foreground/30'
              }`}
            >
              <span className={`inline-block h-[16px] w-[16px] rounded-full bg-white shadow-sm transition-transform ${
                (dictationConfig?.continuous ?? true) ? 'translate-x-[21px]' : 'translate-x-[3px]'
              }`} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const CallButton: FC = () => {
  const { startCall } = useRealtime();

  const handleClick = useCallback(async () => {
    try {
      const id = await app.conversations.getActiveId() as string | null;
      if (id) {
        await startCall(id);
      }
    } catch (err) {
      console.error('[CallButton] Failed to start call:', err);
    }
  }, [startCall]);

  return (
    <Tooltip content="Start voice call" side="top" sideOffset={8}>
      <button
        type="button"
        onClick={handleClick}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-muted/40 transition-colors text-muted-foreground hover:bg-muted/60"
      >
        <PhoneIcon className="h-4 w-4" />
      </button>
    </Tooltip>
  );
};

const Composer: FC<{
  mode: ThreadMode;
  onChangeMode: (mode: ThreadMode) => void;
  selectedModelKey: string | null;
  onSelectModel: (key: string) => void;
  reasoningEffort: ReasoningEffort;
  onChangeReasoningEffort: (value: ReasoningEffort) => void;
  executionMode: ExecutionMode;
  onChangeExecutionMode: (value: ExecutionMode) => void;
  selectedProfileKey: string | null;
  onSelectProfile: (key: string | null, primaryModelKey: string | null) => void;
  fallbackEnabled: boolean;
  onToggleFallback: (value: boolean) => void;
}> = ({ mode, onChangeMode, selectedModelKey, onSelectModel, reasoningEffort, onChangeReasoningEffort, executionMode, onChangeExecutionMode, selectedProfileKey, onSelectProfile, fallbackEnabled, onToggleFallback }) => {
  const composerRuntime = useComposerRuntime();
  const { attachments, addAttachments, removeAttachment } = useAttachments();
  const { currentWorkingDirectory, setCurrentWorkingDirectory } = useCurrentWorkingDirectory();
  const { config } = useConfig();
  const { sessionsByConversation, startSession, continueSession, sendGuidance } = useComputerUse();
  const activeConversationId = useActiveConversationId();
  const [composerText, setComposerText] = useState(() => composerRuntime.getState().text ?? '');

  // Computer-use inline toggle state
  const computerUseEnabled = (config as Record<string, unknown> | null)?.computerUse
    ? ((config as Record<string, unknown>).computerUse as { enabled?: boolean })?.enabled ?? false
    : false;
  const computerConfig = (config as Record<string, unknown> | null)?.computerUse as {
    defaultTarget?: ComputerUseTarget;
    approvalModeDefault?: ComputerUseApprovalMode;
  } | undefined;
  const [computerUseToggled, setComputerUseToggled] = useState(false);
  const [computerTarget, setComputerTarget] = useState<ComputerUseTarget>(computerConfig?.defaultTarget ?? 'local-macos');
  const [computerApprovalMode, setComputerApprovalMode] = useState<ComputerUseApprovalMode>(computerConfig?.approvalModeDefault ?? 'autonomous');
  const [isStartingComputerSession, setIsStartingComputerSession] = useState(false);

  useEffect(() => {
    setComputerTarget(computerConfig?.defaultTarget ?? 'local-macos');
    setComputerApprovalMode(computerConfig?.approvalModeDefault ?? 'autonomous');
  }, [computerConfig?.defaultTarget, computerConfig?.approvalModeDefault]);

  const dictationEnabled = (config as Record<string, unknown> | null)?.audio
    ? ((config as Record<string, unknown>).audio as { dictation?: { enabled?: boolean } })?.dictation?.enabled ?? true
    : true;
  const [isDictating, setIsDictating] = useState(false);
  const dictationStartRef = useRef<(() => void) | null>(null);
  const dictationStopRef = useRef<(() => void) | null>(null);

  // ⌘D keyboard shortcut: hold to record, release to stop
  const dictatingViaKeyboard = useRef(false);
  useEffect(() => {
    if (!dictationEnabled) return;
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
        e.preventDefault();
        dictatingViaKeyboard.current = true;
        dictationStartRef.current?.();
      }
    };
    const stop = () => {
      if (dictatingViaKeyboard.current) {
        dictatingViaKeyboard.current = false;
        dictationStopRef.current?.();
      }
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', stop);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', stop);
      window.removeEventListener('blur', stop);
    };
  }, [dictationEnabled]);

  const isWebBridge = Boolean((window as unknown as Record<string, unknown>).app && (window.app as Record<string, unknown>).__isWebBridge);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFileAccept, setPendingFileAccept] = useState<string>('*/*');
  const [cwdPopoverOpen, setCwdPopoverOpen] = useState(false);
  const cwdRootRef = useRef<HTMLDivElement>(null);
  const cwdPopover = usePopoverAlign();
  const { expanded: cwdExpanded, containerProps: cwdContainerProps } = useSplitButtonHover({ popoverOpen: cwdPopoverOpen });
  const [showDirectoryBrowser, setShowDirectoryBrowser] = useState(false);

  // Close CWD popover on outside click
  useEffect(() => {
    if (!cwdPopoverOpen) return;
    const handler = (e: PointerEvent) => {
      if (!cwdRootRef.current?.contains(e.target as Node)) {
        setCwdPopoverOpen(false);
      }
    };
    window.addEventListener('pointerdown', handler);
    return () => window.removeEventListener('pointerdown', handler);
  }, [cwdPopoverOpen]);

  const activeComputerSession = getActiveComputerSession(activeConversationId, sessionsByConversation);
  const showComputerSetup = shouldShowComputerSetup(activeComputerSession);

  useEffect(() => {
    const unsubscribe = composerRuntime.subscribe(() => {
      setComposerText(composerRuntime.getState().text ?? '');
    });
    return unsubscribe;
  }, [composerRuntime]);

  const handleAttachFiles = async (filters?: Array<{ name: string; extensions: string[] }>) => {
    if (isWebBridge) {
      // On web: use browser file picker
      const accept = filters?.flatMap((f) => f.extensions.map((e) => `.${e}`)).join(',') || '*/*';
      setPendingFileAccept(accept);
      // Trigger after state update so the input has the right accept
      setTimeout(() => fileInputRef.current?.click(), 0);
      return;
    }
    try {
      const result = await app.dialog.openFile({ filters }) as { canceled: boolean; files?: Array<{ name: string; mime: string; isImage: boolean; size: number; dataUrl: string; text?: string }> };
      if (!result.canceled && result.files) addAttachments(result.files);
    } catch (err) { console.error('Attach failed:', err); }
  };

  const handleWebFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    const readers: Promise<{ name: string; mime: string; isImage: boolean; size: number; dataUrl: string; text?: string }>[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      readers.push(new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const isImage = file.type.startsWith('image/');
          const isText = file.type.startsWith('text/') || file.type === 'application/json';
          if (isText) {
            const textReader = new FileReader();
            textReader.onload = () => resolve({ name: file.name, mime: file.type || 'application/octet-stream', isImage, size: file.size, dataUrl, text: textReader.result as string });
            textReader.readAsText(file);
          } else {
            resolve({ name: file.name, mime: file.type || 'application/octet-stream', isImage, size: file.size, dataUrl });
          }
        };
        reader.readAsDataURL(file);
      }));
    }
    void Promise.all(readers).then((results) => addAttachments(results));
    // Reset so the same file can be re-selected
    event.target.value = '';
  };

  const handleAttachDirectory = async () => {
    if (isWebBridge) {
      setShowDirectoryBrowser(true);
      return;
    }
    try {
      const result = await app.dialog.openDirectory();
      if (!result.canceled && result.directoryPath) {
        await setCurrentWorkingDirectory(result.directoryPath);
      }
    } catch (err) {
      console.error('Attach directory failed:', err);
    }
  };

  const handleSend = useCallback(() => {
    if (!composerText.trim() && attachments.length === 0) return;

    if (computerUseToggled && mode === 'chat' && composerText.trim()) {
      if (!activeConversationId) return;
      setIsStartingComputerSession(true);

      // Active non-terminal session → send guidance
      if (activeComputerSession && !isComputerSessionTerminal(activeComputerSession.status)) {
        void sendGuidance(activeComputerSession.id, composerText.trim()).then(() => {
          composerRuntime.setText('');
        }).finally(() => {
          setIsStartingComputerSession(false);
        });
        return;
      }

      // Terminal session → continue; otherwise → start new
      const canContinue = activeComputerSession && isComputerSessionTerminal(activeComputerSession.status);
      const promise = canContinue
        ? continueSession(activeComputerSession.id, composerText.trim())
        : startSession(composerText.trim(), {
            conversationId: activeConversationId,
            target: computerTarget,
            surface: 'docked',
            approvalMode: computerApprovalMode,
            modelKey: selectedModelKey,
            profileKey: selectedProfileKey,
            fallbackEnabled,
            reasoningEffort,
          });

      void promise.then(() => {
        composerRuntime.setText('');
      }).finally(() => {
        setIsStartingComputerSession(false);
      });
      return;
    }

    composerRuntime.send();
  }, [
    attachments.length, composerRuntime, composerText, computerUseToggled, mode,
    activeConversationId, activeComputerSession, startSession, continueSession, sendGuidance,
    computerTarget, computerApprovalMode, selectedModelKey, selectedProfileKey,
    fallbackEnabled, reasoningEffort,
  ]);

  const canSend = composerText.trim().length > 0 || attachments.length > 0;
  const hasFileAttachments = attachments.length > 0;
  const cwdName = currentWorkingDirectory?.split('/').pop() ?? currentWorkingDirectory;
  const menuItemClassName = 'flex cursor-default items-center gap-2 rounded-lg px-3 py-2 text-sm text-foreground outline-none transition-colors data-[highlighted]:bg-muted/70';

  return (
    <div className="relative z-20 px-3 pb-3 pt-4 md:px-6 md:pb-6 md:pt-5">
      {/* Hidden file input for web bridge */}
      {isWebBridge && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={pendingFileAccept}
          className="hidden"
          onChange={handleWebFileInputChange}
        />
      )}
      {/* Directory browser for web bridge */}
      {showDirectoryBrowser && (
        <DirectoryBrowser
          onSelect={async (path) => {
            setShowDirectoryBrowser(false);
            await setCurrentWorkingDirectory(path);
          }}
          onCancel={() => setShowDirectoryBrowser(false)}
        />
      )}
      <div className="mx-auto w-full max-w-5xl">
        {mode === 'chat' && hasFileAttachments && (
          <div className="mb-3 flex flex-wrap gap-2">
            {attachments.map((file, i) => (
              <div key={`${file.name}-${i}`} className="group/att flex items-center gap-1.5 rounded-2xl border border-border/50 bg-muted/40 px-2.5 py-2 text-xs">
                {file.isImage ? (
                  <img src={file.dataUrl} alt={file.name} className="h-10 w-10 rounded object-cover" />
                ) : (
                  <FileIcon className="h-4 w-4 text-muted-foreground" />
                )}
                <div className="flex flex-col">
                  <span className="max-w-[120px] truncate font-medium">{file.name}</span>
                  <span className="text-[10px] text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</span>
                </div>
                <button
                  type="button"
                  onClick={() => removeAttachment(i)}
                  className="ml-1 rounded p-0.5 opacity-100 transition-opacity hover:bg-destructive/10 md:opacity-0 md:group-hover/att:opacity-100"
                >
                  <XIcon className="h-3 w-3 text-muted-foreground" />
                </button>
              </div>
            ))}
          </div>
        )}

        {mode === 'computer' && !showComputerSetup ? (
          /* Guidance composer — shown when a session is active */
          activeComputerSession ? (
            <GuidanceComposer sessionId={activeComputerSession.id} onReturnToChat={() => {
              setComputerUseToggled(false);
              onChangeMode('chat');
            }} />
          ) : null
        ) : (
          <ComposerPrimitive.Root className="flex flex-col gap-0 rounded-2xl border border-border/70 app-composer-glass px-3 py-3 app-composer-shadow">
            {mode === 'computer' ? (
              <>
                <ComputerSetupPanel
                  conversationId={activeConversationId}
                  selectedModelKey={selectedModelKey}
                  onSelectModel={onSelectModel}
                  reasoningEffort={reasoningEffort}
                  onChangeReasoningEffort={onChangeReasoningEffort}
                  selectedProfileKey={selectedProfileKey}
                  onSelectProfile={onSelectProfile}
                  fallbackEnabled={fallbackEnabled}
                  onToggleFallback={onToggleFallback}
                  activeComputerSession={activeComputerSession}
                  onOpenPopout={() => { void app.computerUse.openSetupWindow(activeConversationId ?? undefined); }}
                  renderDictation={dictationEnabled ? ({ getText, setText, onDictatingChange }) => (
                    <DictationButton
                      onListeningChange={onDictatingChange}
                      getText={getText}
                      setText={setText}
                    />
                  ) : undefined}
                />
                <div className="mt-2 flex justify-end">
                  <Tooltip content="Return to chat">
                    <button
                      type="button"
                      onClick={() => {
                        setComputerUseToggled(false);
                        onChangeMode('chat');
                      }}
                      className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                    >
                      <MonitorIcon className="h-3.5 w-3.5" />
                      <span>Back to Chat</span>
                    </button>
                  </Tooltip>
                </div>
              </>
            ) : (
              <>
                <ComposerInput
                  placeholder={isDictating ? 'Listening...' : computerUseToggled ? (activeComputerSession && isComputerSessionTerminal(activeComputerSession.status) ? 'Continue the session with a follow-up...' : `What should ${__BRAND_PRODUCT_NAME} do on your computer?`) : __BRAND_COMPOSER_PLACEHOLDER}
                  className="min-h-[48px] max-h-[220px] w-full overflow-y-auto px-1 py-0.5 text-base md:text-[15px]"
                  autoFocus
                />
                <div className="flex flex-col gap-1.5 md:flex-row md:items-center md:justify-between md:gap-3">
                  <div className="flex min-w-0 flex-1 items-center gap-1.5 md:gap-2">
                    <DropdownMenu.Root>
                      <Tooltip content="Add files" side="top" sideOffset={8}>
                        <DropdownMenu.Trigger asChild>
                          <button type="button" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-muted/40 transition-colors hover:bg-muted/60 text-muted-foreground">
                            <PlusIcon className="h-4 w-4" />
                          </button>
                        </DropdownMenu.Trigger>
                      </Tooltip>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          align="start"
                          sideOffset={8}
                          className="z-50 min-w-[240px] rounded-2xl border border-border/70 bg-popover/95 p-1.5 text-popover-foreground shadow-xl backdrop-blur-md"
                        >
                          <DropdownMenu.Item className={menuItemClassName} onSelect={() => { void handleAttachFiles([{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }]); }}>
                            <ImageIcon className="h-4 w-4 text-muted-foreground" />
                            <span>Image</span>
                          </DropdownMenu.Item>
                          <DropdownMenu.Item className={menuItemClassName} onSelect={() => { void handleAttachFiles([{ name: 'PDF', extensions: ['pdf'] }]); }}>
                            <FileIcon className="h-4 w-4 text-muted-foreground" />
                            <span>PDF</span>
                          </DropdownMenu.Item>
                          <DropdownMenu.Item className={menuItemClassName} onSelect={() => { void handleAttachFiles([{ name: 'Documents', extensions: ['txt', 'md', 'json', 'csv', 'html', 'htm', 'js', 'jsx', 'ts', 'tsx', 'css', 'scss', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'sh', 'yaml', 'yml', 'toml', 'xml'] }]); }}>
                            <FileTextIcon className="h-4 w-4 text-muted-foreground" />
                            <span>Text / Document</span>
                          </DropdownMenu.Item>
                          <DropdownMenu.Separator className="my-1 h-px bg-border/60" />
                          <DropdownMenu.Item className={menuItemClassName} onSelect={() => { void handleAttachFiles(); }}>
                            <FileIcon className="h-4 w-4 text-muted-foreground" />
                            <span>Any File</span>
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                    {/* Working directory split button */}
                    <div ref={cwdRootRef} {...cwdContainerProps} className="relative flex items-center">
                      <div className={`flex items-center overflow-hidden rounded-lg border transition-colors ${
                        currentWorkingDirectory
                          ? 'border-primary/50 bg-primary/10'
                          : 'border-border/50 bg-muted/40'
                      }`}>
                        {/* Left segment: folder icon — opens picker */}
                        <Tooltip content={currentWorkingDirectory ? cwdName ?? 'Working directory' : 'Set working directory'} side="top" sideOffset={8}>
                          <button
                            type="button"
                            onClick={() => { void handleAttachDirectory(); }}
                            className={`flex h-10 w-10 shrink-0 items-center justify-center transition-colors ${
                              currentWorkingDirectory
                                ? 'hover:bg-primary/15 text-primary'
                                : 'hover:bg-muted/50 text-muted-foreground'
                            }`}
                          >
                            <FolderOpenIcon className="h-4 w-4" />
                          </button>
                        </Tooltip>
                        {/* Right segment: chevron — opens CWD popover (only when set) */}
                        {currentWorkingDirectory && (
                          <div className={`overflow-hidden transition-[max-width,opacity] duration-200 ease-out ${
                            cwdExpanded ? 'max-w-[2.5rem] opacity-100' : 'max-w-0 opacity-0'
                          }`}>
                            <Tooltip content="Directory settings" side="top" sideOffset={8}>
                              <button
                                type="button"
                                onClick={() => setCwdPopoverOpen((o) => !o)}
                                className="flex h-10 w-10 shrink-0 items-center justify-center transition-colors hover:bg-primary/15 text-primary"
                              >
                                <ChevronUpIcon className={`h-3.5 w-3.5 transition-transform ${cwdPopoverOpen ? '' : 'rotate-180'}`} />
                              </button>
                            </Tooltip>
                          </div>
                        )}
                      </div>

                      {/* CWD popover */}
                      {cwdPopoverOpen && currentWorkingDirectory && (
                        <div ref={cwdPopover.ref} style={cwdPopover.style} className="absolute bottom-full left-0 z-50 mb-2 w-[280px] max-w-[calc(100vw-2rem)] rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-[0_16px_40px_rgba(5,4,15,0.28)] backdrop-blur-xl">
                          <div className="flex items-center gap-2 px-3 pt-2 pb-1">
                            <FolderOpenIcon className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Working Directory</span>
                          </div>
                          <div className="px-3 py-2">
                            <p className="text-xs font-medium text-foreground truncate" title={cwdName ?? undefined}>{cwdName}</p>
                            <p className="mt-0.5 text-[10px] text-muted-foreground truncate" title={currentWorkingDirectory}>{currentWorkingDirectory}</p>
                          </div>
                          <div className="border-t border-border/50 mx-1.5 mt-0.5" />
                          <button
                            type="button"
                            onClick={() => { void setCurrentWorkingDirectory(null); setCwdPopoverOpen(false); }}
                            className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs text-destructive transition-colors hover:bg-destructive/10"
                          >
                            <XIcon className="h-3.5 w-3.5" />
                            <span>Clear directory</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 md:gap-2">
                  <ModelSettingsButton
                    selectedModelKey={selectedModelKey}
                    onSelectModel={onSelectModel}
                    reasoningEffort={reasoningEffort}
                    onChangeReasoningEffort={onChangeReasoningEffort}
                    fallbackEnabled={fallbackEnabled}
                    onToggleFallback={onToggleFallback}
                    selectedProfileKey={selectedProfileKey}
                    onSelectProfile={onSelectProfile}
                    executionMode={executionMode}
                    onChangeExecutionMode={onChangeExecutionMode}
                  />
                  {computerUseEnabled && (
                    <ComputerSettingsButton
                      target={computerTarget}
                      onChangeTarget={setComputerTarget}
                      approvalMode={computerApprovalMode}
                      onChangeApprovalMode={setComputerApprovalMode}
                      toggled={computerUseToggled}
                      onToggle={() => {
                        const next = !computerUseToggled;
                        setComputerUseToggled(next);
                        if (next && activeComputerSession && !isComputerSessionTerminal(activeComputerSession.status) && activeComputerSession.surface === 'docked') {
                          onChangeMode('computer');
                        }
                      }}
                    />
                  )}
                  {dictationEnabled && <DictationButton onListeningChange={setIsDictating} startRef={dictationStartRef} stopRef={dictationStopRef} />}
                  <CallButton />
                  <ThreadPrimitive.If running={false}>
                    <button
                      type="button"
                      onClick={handleSend}
                      disabled={!canSend || isStartingComputerSession}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                    >
                      {isStartingComputerSession ? (
                        <LoaderIcon className="h-4 w-4 animate-spin" />
                      ) : computerUseToggled ? (
                        <MonitorIcon className="h-4 w-4" />
                      ) : (
                        <SendHorizontalIcon className="h-4 w-4" />
                      )}
                    </button>
                  </ThreadPrimitive.If>
                  <ThreadPrimitive.If running>
                    <StopButton />
                  </ThreadPrimitive.If>
                  </div>
                </div>
              </>
            )}
          </ComposerPrimitive.Root>
        )}
      </div>
    </div>
  );
};
