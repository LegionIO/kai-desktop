import { useState, useEffect, useCallback, useRef, useMemo, createContext, useContext, type FC, type PropsWithChildren } from 'react';
import { createPortal } from 'react-dom';
import {
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ActionBarPrimitive,
  useAui,
  useThreadRuntime,
  useMessage,
  useComposerRuntime,
  getExternalStoreMessage,
} from '@assistant-ui/react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  SendHorizontalIcon,
  CopyIcon,
  CheckIcon,
  RefreshCwIcon,
  InfoIcon,
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
  ChevronUpIcon,
  MonitorIcon,
  FolderOpenIcon,
  ImageIcon,
  LoaderIcon,
  MessageSquareTextIcon,
  ArrowUpIcon,
} from 'lucide-react';
import { app } from '@/lib/ipc-client';
import { cn, refocusComposer } from '@/lib/utils';
import { copyTextToClipboard, logClipboardError } from '@/lib/clipboard';
import { useAttachments } from '@/providers/AttachmentContext';
import { useBranchNav, useCurrentWorkingDirectory, useRuntimeConversationId, type TokenUsageData } from '@/providers/RuntimeProvider';
import { useConfig } from '@/providers/ConfigProvider';
import { useRealtime } from '@/providers/RealtimeProvider';
import { MarkdownText } from './MarkdownText';
import { UserCodeMarkdown } from './UserCodeMarkdown';
import { SplashBackground } from '@/components/SplashBackground';
import { ToolCallDisplay } from './ToolGroup';
import { SubAgentInline } from './SubAgentInline';
import { MaxTurnsContinueCard } from './MaxTurnsContinueCard';
import { PipelineInsights } from './PipelineInsights';
import type { PipelineEnrichments } from './PipelineInsights';
import { ComposerInput } from './ComposerInput';
import { RichChatInput } from './RichChatInput';
import { RecordingButton } from './RecordingButton';
import { RecordingOverlay } from './RecordingOverlay';
import { CallButton } from './CallButton';
import { SearchBar } from './SearchBar';
import type { ReasoningEffort } from './ReasoningEffortSelector';
import { ChatSettingsButton } from './ChatSettingsButton';
import { Tooltip } from '@/components/ui/Tooltip';
import { FallbackBanner, ComputerUseFallbackBanner } from './FallbackBanner';
import { usePopoverAlign } from '@/hooks/usePopoverAlign';
import { useSplitButtonHover } from '@/hooks/useSplitButtonHover';
import { useFullWidthContent } from '@/hooks/useFullWidthContent';
import { useVoiceRecording } from '@/hooks/useVoiceRecording';
import { CallOverlay } from './CallOverlay';
import { ComputerSessionPanel } from './ComputerSessionPanel';
import { ComputerSetupPanel } from './ComputerSetupPanel';
import { ComputerSettingsButton } from './ComputerSettingsButton';
import type { ExecutionMode } from './ChatSettingsButton';
import { useComputerUse } from '@/providers/ComputerUseProvider';
import { shouldShowComputerSetup, isComputerSessionTerminal, type ComputerSession, type ComputerUseTarget, type ComputerUseApprovalMode } from '../../../shared/computer-use';
import { getResponseTiming, formatElapsed } from '@/lib/response-timing';
import { formatModelDisplayName } from '@/lib/model-display';
import { SPINNER_VERBS } from '@/config/spinner-verbs';
import { useTasksOptional } from '@/providers/TaskProvider';

export type ThreadMode = 'chat' | 'computer';

/** Lightweight context so deeply-nested message components can read thread-level metadata. */
type ThreadMetaState = { selectedModelKey: string | null; resolvedRuntime: string | null; reasoningEffort: string | null };
const ThreadMetaContext = createContext<ThreadMetaState>({ selectedModelKey: null, resolvedRuntime: null, reasoningEffort: null });
const useThreadMeta = () => useContext(ThreadMetaContext);

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
  const fullWidth = useFullWidthContent();
  // useRuntimeConversationId updates in the same React batch as setTree/setHeadId,
  // so the scroll fires only after the new thread's messages are already in the DOM.
  const runtimeConversationId = useRuntimeConversationId();
  const threadRuntime = useThreadRuntime();
  const [hasMessages, setHasMessages] = useState(() => threadRuntime.getState().messages.length > 0);

  // Scroll to the bottom whenever the active conversation changes.
  // We key off runtimeConversationId (not the IPC-driven useActiveConversationId)
  // because it updates only after the new thread's tree has been loaded into state.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // rAF lets the browser finish painting the new messages before we scroll
    const raf = requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  // intentional: only scroll when the active conversation changes, not on every dep update
  }, [runtimeConversationId]);
  // Track whether the splash should hide instantly (loading existing thread)
  // vs fade out gradually (user just sent first message in new thread).
  const [splashInstantHide, setSplashInstantHide] = useState(false);
  useEffect(() => {
    return threadRuntime.subscribe(() => {
      const count = threadRuntime.getState().messages.length;
      setHasMessages(count > 0);
      if (count > 1) setSplashInstantHide(true);
    });
  }, [threadRuntime]);
  // Reset instant-hide flag when switching to an empty thread
  useEffect(() => {
    const count = threadRuntime.getState().messages.length;
    if (count === 0) setSplashInstantHide(false);
  }, [threadRuntime]);


  useEffect(() => {
    if (!window.app?.onFind) return;
    const cleanup = window.app.onFind(() => setSearchOpen(true));
    return cleanup;
  }, []);

  // Resolve the actual runtime (e.g. "auto" → "mastra") so message info shows the real value
  const [resolvedRuntime, setResolvedRuntime] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    app.agent.getActiveRuntime()
      .then((id) => { if (!cancelled) setResolvedRuntime(id as string); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedModelKey]); // re-fetch when model changes as runtime may change with it

  const threadMeta = useMemo<ThreadMetaState>(
    () => ({ selectedModelKey, resolvedRuntime, reasoningEffort }),
    [selectedModelKey, resolvedRuntime, reasoningEffort],
  );

  return (
    <ThreadMetaContext.Provider value={threadMeta}>
    <ThreadPrimitive.Root className="relative flex h-full min-h-0 flex-col" id="kai-chat-viewport">
      <SplashBackground visible={!hasMessages} instant={splashInstantHide} />
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-20 h-16 bg-gradient-to-b from-background from-55% to-transparent transition-opacity ease-out md:h-20"
        style={{
          opacity: hasMessages ? 1 : 0,
          transitionDuration: hasMessages ? '0ms' : '50ms',
          transitionDelay: hasMessages ? '0ms' : '0ms',
        }}
      />
      <SearchBar visible={searchOpen} onClose={() => setSearchOpen(false)} viewportRef={viewportRef} />
      <FallbackBanner />
      <ComputerUseFallbackBanner />
      {mode === 'chat' ? (
        <ThreadPrimitive.Viewport ref={viewportRef} className="relative min-h-0 flex-1 overflow-y-auto">
          <PinnedUserMessage viewportRef={viewportRef} />
          <div className="flex min-h-full flex-col">
            <div className="flex-1">
              <div className={cn('relative z-10 mx-auto flex w-full flex-col px-3 pr-5 pt-16 md:px-6 md:pr-8 md:pt-20', !fullWidth && 'max-w-3xl')}>
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
    </ThreadMetaContext.Provider>
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
  const fullWidth = useFullWidthContent();
  const activeComputerSession = getActiveComputerSession(activeConversationId, sessionsByConversation);

  if (!activeComputerSession) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-3 pb-4 pt-16 md:px-6 md:pb-6 md:pt-20">
          <div className={cn('mx-auto flex w-full min-h-0 flex-col', !fullWidth && 'max-w-3xl')}>
            <div className="flex min-h-full flex-1 items-center justify-center rounded-2xl border border-dashed border-border/60 bg-card/20 px-6 py-8">
              <div className="max-w-md text-center">
                <MonitorIcon className="mx-auto h-8 w-8 text-muted-foreground/40" />
                <div className="mt-3 text-sm font-medium">{activeConversationId ? 'No Active Session' : 'Select a Chat'}</div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {activeConversationId
                    ? 'Configure a goal and start a session using the controls below.'
                    : 'Choose or create a chat from the sidebar first.'}
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
      <div className="px-3 pb-4 pt-16 md:px-6 md:pb-6 md:pt-20">
        <div className={cn('mx-auto flex w-full min-h-0 flex-col', !fullWidth && 'max-w-3xl')}>
          <ComputerSessionPanel session={activeComputerSession} stickyTopClassName="top-12 md:top-14" />
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

/**
 * Pinned user message — sticks to the top of the viewport when the user
 * scrolls past their last message, so they always know what they asked.
 */
const PinnedUserMessage: FC<{ viewportRef: React.RefObject<HTMLDivElement | null> }> = ({ viewportRef }) => {
  const threadRuntime = useThreadRuntime();
  const fullWidth = useFullWidthContent();
  const [lastUserMessage, setLastUserMessage] = useState<{
    text: string;
    imageCount: number;
    fileCount: number;
  } | null>(null);
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Subscribe to thread messages and extract last user message content
  useEffect(() => {
    const update = () => {
      const msgs = threadRuntime.getState().messages;
      // Find the last user message
      let lastUser = null;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') {
          lastUser = msgs[i];
          break;
        }
      }
      if (!lastUser || lastUser === msgs[msgs.length - 1]) {
        // No user message, or user message is the very last message (no response yet)
        setLastUserMessage(null);
        return;
      }
      const textParts = (lastUser.content ?? [])
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      const imageCount = (lastUser.content ?? []).filter((p) => p.type === 'image').length;
      const fileCount = (lastUser.content ?? []).filter((p) => p.type === 'file').length;
      setLastUserMessage(textParts || imageCount || fileCount ? { text: textParts, imageCount, fileCount } : null);
    };
    update();
    return threadRuntime.subscribe(update);
  }, [threadRuntime]);

  // Collapse when the pinned message hides
  useEffect(() => {
    if (!visible) setExpanded(false);
  }, [visible]);

  // Only show the indicator when the user's last message has scrolled far
  // enough out of view that finding it again is non-trivial (at least 0.75x
  // viewport height above the visible area).
  // Uses scroll listener + rAF polling (not MutationObserver — that causes
  // infinite loops because the indicator itself changing visibility mutates
  // the DOM). The rAF polling is needed because Electron's programmatic
  // scrollTo() (used by assistant-ui auto-scroll) may not fire DOM scroll
  // events reliably.
  useEffect(() => {
    if (!lastUserMessage) {
      setVisible(false);
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) return;

    let currentlyVisible = false;
    const recompute = () => {
      const currentSentinels = viewport.querySelectorAll('[data-pinned-sentinel]');
      const currentSentinel = currentSentinels[currentSentinels.length - 1] as HTMLElement | undefined;
      if (!currentSentinel) {
        currentlyVisible = false;
        setVisible(false);
        return;
      }
      const viewportRect = viewport.getBoundingClientRect();
      const sentinelRect = currentSentinel.getBoundingClientRect();
      // How far the bottom of the sentinel is above the top of the viewport.
      // Positive means the sentinel is above the visible area (scrolled past).
      const distanceAboveViewport = viewportRect.top - sentinelRect.bottom;
      // Hysteresis: show sooner (20px) when scrolling down, but only hide
      // when the sentinel is back in view (-40px) when scrolling up.
      if (currentlyVisible) {
        // Already showing — only hide when sentinel is back in view
        currentlyVisible = distanceAboveViewport >= -40;
      } else {
        // Not showing — show once sentinel is out of view
        currentlyVisible = distanceAboveViewport >= 20;
      }
      setVisible(currentlyVisible);
    };

    // Poll via rAF for 1.5s after mount to catch auto-scroll settling.
    // This is needed because Electron's programmatic scrollTo() may not
    // fire DOM scroll events.
    let rafId = 0;
    const startTime = Date.now();
    const poll = () => {
      recompute();
      if (Date.now() - startTime < 1500) {
        rafId = requestAnimationFrame(poll);
      }
    };
    rafId = requestAnimationFrame(poll);

    // Re-evaluate on scroll (works in browser, may not fire in Electron
    // for programmatic scrolls)
    viewport.addEventListener('scroll', recompute, { passive: true });

    return () => {
      cancelAnimationFrame(rafId);
      viewport.removeEventListener('scroll', recompute);
    };
  }, [lastUserMessage, viewportRef]);

  const scrollToOriginal = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const sentinels = viewport.querySelectorAll(`[data-pinned-sentinel]`);
    const sentinel = sentinels[sentinels.length - 1];
    sentinel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [viewportRef]);

  if (!lastUserMessage) return null;

  return (
    <div
      className={`pointer-events-none sticky top-0 z-[35] transition-all duration-200 ${
        visible
          ? 'pt-14 md:pt-16 translate-y-0 opacity-100'
          : 'h-0 overflow-hidden opacity-0'
      }`}
    >
      <div className={cn('mx-auto flex w-full justify-end px-3 pr-5 md:px-6 md:pr-8', !fullWidth && 'max-w-3xl')}>
        <div className="max-w-[88%] md:max-w-[72%]">
          <div
            className="pointer-events-auto ml-auto flex w-fit max-w-full items-stretch rounded-xl border text-foreground shadow-lg backdrop-blur-md"
            style={{
              backgroundColor: 'var(--app-user-bubble)',
              borderColor: 'var(--app-user-bubble-border)',
            }}
          >
            {/* Expandable text area — grows to the left of the icons */}
            {expanded && (
              <div className="min-w-0 animate-in fade-in slide-in-from-right-2 duration-150">
                <p className="px-4 py-2.5 text-sm leading-6">{lastUserMessage.text}</p>
              </div>
            )}

            {/* Action buttons — always anchored right, never move */}
            <div className="flex shrink-0 items-start gap-0.5 px-2 py-2">
              <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-foreground/50 transition-colors hover:bg-foreground/10 hover:text-foreground/80"
                title={expanded ? 'Collapse message' : 'Show message'}
              >
                <MessageSquareTextIcon className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={scrollToOriginal}
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-foreground/50 transition-colors hover:bg-foreground/10 hover:text-foreground/80"
                title="Scroll to message"
              >
                <ArrowUpIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>
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

  return createPortal(
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
    </div>,
    document.body,
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
  const isPendingApproval = props.approvalStatus === 'pending' && !hasResult;
  const isError = props.isError || (hasResult && props.result && typeof props.result === 'object' && (
    (props.result as Record<string, unknown>).error || (props.result as Record<string, unknown>).isError === true
  ));
  const isRunning = !hasResult && !isPendingApproval;
  const dotColor = isPendingApproval
    ? 'bg-amber-400 animate-pulse'
    : isRunning
      ? 'bg-blue-500 animate-pulse'
      : isError
        ? 'bg-red-500'
        : 'bg-emerald-500';

  // Bridge: create task queue entry when a plan is approved
  const taskCtx = useTasksOptional();
  const handlePlanApproved = useCallback(async (data: { title: string; description: string; planFileName?: string; toolCallId: string }) => {
    const task = await taskCtx?.createTaskFromPlan({
      title: data.title,
      description: data.description,
      planFileName: data.planFileName,
      sourceToolCallId: data.toolCallId,
    });
    return task ?? null;
  }, [taskCtx]);

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
        onPlanApproved={handlePlanApproved}
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

/** Animated verb text shared by both the timeline spinner and the between-tools spinner */
const ThinkingSpinnerText: FC = () => {
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
    <span className="text-xs font-mono whitespace-pre thinking-verb-shimmer">
      {displayText}
    </span>
  );
};

const ThinkingSpinner: FC = () => {
  return (
    <div className="timeline-item py-0.5">
      <span className="timeline-dot-icon">
        <span className="thinking-spinner text-primary select-none" aria-hidden="true" />
      </span>
      <ThinkingSpinnerText />
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
  const isRunning = message.status?.type === 'running';
  const content = message.content ?? [];
  const hasContent = content.some((p: { type: string; text?: string }) =>
    p.type === 'tool-call' || (p.type === 'text' && p.text?.trim()),
  );
  const isEmpty = !isRunning && !hasContent;

  // Detect "thinking between tool calls" — model is running, content exists,
  // but there's no actively-executing tool (all tool calls have results).
  // Rules:
  //  - A regular tool is "done" when result !== undefined AND finishedAt !== undefined.
  //  - A sub_agent tool is always treated as "handled" — it has its own inline UI and
  //    streams partial results early, so we never want it to suppress the parent spinner.
  const allToolsDone = isRunning && hasContent && content.every(
    (p: { type: string; toolName?: string; result?: unknown; finishedAt?: string }) =>
      p.type !== 'tool-call' ||
      p.toolName === 'sub_agent' || p.toolName === 'agent' ||
      (p.result !== undefined && p.finishedAt !== undefined),
  );

  // A sub_agent (or SDK 'agent') is actively running when it has no result yet (or result but no finishedAt)
  const hasRunnningSubAgent = isRunning && content.some(
    (p: { type: string; toolName?: string; result?: unknown; finishedAt?: string }) =>
      p.type === 'tool-call' && (p.toolName === 'sub_agent' || p.toolName === 'agent') && p.finishedAt === undefined,
  );

  // Any regular tool (non-agent) is actively executing when it has no result yet and isn't pending approval
  const hasRunningTool = isRunning && content.some(
    (p: { type: string; toolName?: string; result?: unknown; approvalStatus?: string }) =>
      p.type === 'tool-call' &&
      p.toolName !== 'sub_agent' && p.toolName !== 'agent' &&
      p.result === undefined &&
      p.approvalStatus !== 'pending',
  );

  // Detect paused-for-input — a tool is awaiting user approval/answer
  const isAwaitingInput = isRunning && content.some(
    (p: { type: string; approvalStatus?: string; result?: unknown }) =>
      p.type === 'tool-call' && p.approvalStatus === 'pending' && p.result === undefined,
  );

  // Check if this message has an interrupt (source: 'interrupt' or 'unspoken')
  const hasInterrupt = content.some((p: { type: string; source?: string }) =>
    p.type === 'text' && (p.source === 'interrupt' || p.source === 'unspoken'),
  );

  // Extract pipeline enrichments stored as a content part
  const enrichmentsPart = content.find((p: { type: string }) => p.type === 'enrichments') as
    | { type: 'enrichments'; enrichments: PipelineEnrichments }
    | undefined;
  const pipelineEnrichments = enrichmentsPart?.enrichments ?? null;

  // Extract max-turns-reached content parts for interactive continue card
  const maxTurnsParts = (content.filter((p: { type: string }) => p.type === 'max-turns-reached') as unknown) as
    Array<{ type: 'max-turns-reached'; text: string; status: 'pending' | 'continued' }>;

  // Mark first/last .timeline-item so CSS can clip the line at the dots
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const recalcTimeline = () => {
      const allItems = Array.from(el.querySelectorAll('.timeline-item'));
      const items = allItems.filter((item) => {
        // Exclude the initial typing-dots spinner (hidden by CSS once content renders)
        const parent = item.closest('.aui-typing-dots');
        if (parent && getComputedStyle(parent).display === 'none') return false;
        // Exclude the between-tools spinner
        if (item.closest('.timeline-detached')) return false;
        return true;
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
    };

    recalcTimeline();

    // Recalculate when the container resizes (e.g. plan card expanding)
    const ro = new ResizeObserver(recalcTimeline);
    ro.observe(el);
    return () => ro.disconnect();
  });

  return (
    <MessagePrimitive.Root className={`group flex justify-start ${message.isLast && isRunning ? 'mb-2' : 'mb-8'}`}>
      <div className="w-full max-w-4xl">
        <div ref={contentRef} className="aui-assistant-content relative overflow-hidden pr-4 pt-3 text-foreground">
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
              {/* Thinking spinner: shown when model is running with content but no active tool output,
                  when a sub-agent is working, or when a regular tool is actively executing */}
              {(allToolsDone || hasRunnningSubAgent || hasRunningTool) && (
                <div className="mt-5 timeline-detached">
                  <ThinkingSpinner />
                </div>
              )}
            </>
          )}
          {pipelineEnrichments && <PipelineInsights enrichments={pipelineEnrichments} />}
          {maxTurnsParts.map((part, i) => (
            <MaxTurnsContinueCard key={`max-turns-${i}`} part={part} messageId={message.id} />
          ))}
        </div>
        <div className={`flex items-center gap-1 mt-1.5 transition-opacity ${isRunning && !isAwaitingInput ? 'opacity-0 pointer-events-none' : message.isLast ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
          <AssistantActionBar />
          {!isRunning && <MessageInfoIndicator />}
          <MessageTimestamp date={message.createdAt} align="left" />
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
      <Tooltip content="Regenerate">
        <ActionBarPrimitive.Reload className="flex h-7 w-7 items-center justify-center rounded-xl hover:bg-muted transition-colors">
          <RefreshCwIcon className="h-3.5 w-3.5 text-muted-foreground" />
        </ActionBarPrimitive.Reload>
      </Tooltip>

      <BranchPicker />
    </ActionBarPrimitive.Root>
  );
};

const RUNTIME_DISPLAY_NAMES: Record<string, string> = {
  mastra: 'Mastra',
  'claude-agent-sdk': 'Claude Code',
  'codex-sdk': 'Codex',
  auto: 'Auto',
};

const EFFORT_DISPLAY_NAMES: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
};

function formatCompactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const MessageInfoIndicator: FC = () => {
  const message = useMessage();
  const { selectedModelKey, resolvedRuntime, reasoningEffort } = useThreadMeta();
  const { config } = useConfig();
  const responseTiming = getResponseTiming(message);

  // Access the original StoredMessage via assistant-ui's external store binding
  const storedMessage = getExternalStoreMessage<{ tokenUsage?: TokenUsageData; messageMeta?: Record<string, unknown> }>(message);
  const stored = Array.isArray(storedMessage) ? storedMessage[0] : storedMessage;
  const meta = stored?.messageMeta;

  // Prefer persisted per-message values; fall back to live context for older messages
  const persistedModelDisplay = meta?.sourceModelDisplayName as string | undefined;
  const persistedEffort = meta?.reasoningEffort as string | undefined;
  const persistedRuntimeId = meta?.runtimeId as string | undefined;

  // Model: persisted display name > catalog lookup > formatted raw key.
  // When the message was handled by a plugin inference provider (persistedRuntimeId
  // is set from messageMeta), the provider manages its own model routing — don't
  // show the Kai UI model selection since it doesn't reflect what was actually used.
  // Only show a model if the daemon explicitly reports one via sourceModelDisplayName.
  const sourceModel = meta?.sourceModel as string | undefined;
  const modelKey = persistedRuntimeId
    ? (sourceModel ?? null)  // inference provider: only show if daemon reported it
    : (selectedModelKey ?? (config as { models?: { defaultModelKey?: string } })?.models?.defaultModelKey ?? sourceModel ?? null);

  // Runtime
  const effectiveRuntimeId = persistedRuntimeId ?? resolvedRuntime;

  // Effort
  const effectiveEffort = persistedEffort ?? reasoningEffort;

  const elapsedMs = responseTiming?.durationMs
    ?? (responseTiming?.startedAt && responseTiming?.finishedAt
      ? Math.max(0, new Date(responseTiming.finishedAt).getTime() - new Date(responseTiming.startedAt).getTime())
      : undefined);

  // Token usage from the original stored message
  const tokenUsage = stored?.tokenUsage ?? null;

  // Only show if we have at least one piece of info
  if (!modelKey && !effectiveRuntimeId && elapsedMs == null && !effectiveEffort && !tokenUsage) return null;

  // Look up catalog display name as fallback when no persisted display name
  const catalog = (config as { models?: { catalog?: Array<{ key: string; displayName: string; provider: string; modelName: string }> } })?.models?.catalog;
  const catalogEntry = !persistedModelDisplay && modelKey
    ? catalog?.find((m) => m.key === modelKey)
      ?? catalog?.find((m) => `${m.provider}:${m.modelName}` === modelKey)
      ?? catalog?.find((m) => m.modelName === modelKey || m.modelName === modelKey.split(':').slice(1).join(':'))
    : undefined;
  const modelDisplay = persistedModelDisplay
    ?? catalogEntry?.displayName
    ?? (modelKey ? formatModelDisplayName(modelKey.includes(':') ? modelKey.split(':').slice(1).join(':') : modelKey) : null);
  const runtimeDisplay = effectiveRuntimeId ? RUNTIME_DISPLAY_NAMES[effectiveRuntimeId] ?? effectiveRuntimeId : null;
  const effortDisplay = effectiveEffort ? EFFORT_DISPLAY_NAMES[effectiveEffort] ?? effectiveEffort : null;
  const elapsedDisplay = elapsedMs != null ? formatElapsed(Math.max(1, elapsedMs)) : null;

  return (
    <Tooltip
      content={
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px]">
          {modelDisplay && (
            <>
              <span className="text-popover-foreground/50">Model</span>
              <span>{modelDisplay}</span>
            </>
          )}
          {runtimeDisplay && (
            <>
              <span className="text-popover-foreground/50">Runtime</span>
              <span>{runtimeDisplay}</span>
            </>
          )}
          {effortDisplay && (
            <>
              <span className="text-popover-foreground/50">Effort</span>
              <span>{effortDisplay}</span>
            </>
          )}
          {tokenUsage && (
            <>
              <span className="text-popover-foreground/50">Tokens</span>
              <span className="tabular-nums">
                {formatCompactTokens(tokenUsage.totalTokens)}
                <span className="text-popover-foreground/35 ml-1">
                  ({formatCompactTokens(tokenUsage.inputTokens)} in · {formatCompactTokens(tokenUsage.outputTokens)} out)
                </span>
              </span>
            </>
          )}
          {tokenUsage && (tokenUsage.cacheReadTokens > 0 || tokenUsage.cacheWriteTokens > 0) && (
            <>
              <span className="text-popover-foreground/50">Cache</span>
              <span className="tabular-nums">
                {formatCompactTokens(tokenUsage.cacheReadTokens)} read · {formatCompactTokens(tokenUsage.cacheWriteTokens)} write
                {tokenUsage.totalTokens > 0 && tokenUsage.cacheReadTokens > 0 && (
                  <span className="text-emerald-400/70 ml-1">
                    ({Math.round((tokenUsage.cacheReadTokens / tokenUsage.totalTokens) * 100)}% hit)
                  </span>
                )}
              </span>
            </>
          )}
          {elapsedDisplay && (
            <>
              <span className="text-popover-foreground/50">Elapsed</span>
              <span>{elapsedDisplay}</span>
            </>
          )}
        </div>
      }
      contentClassName="z-50 rounded-lg bg-popover px-2.5 py-1.5 text-xs font-medium text-popover-foreground shadow-lg ring-1 ring-border/50 animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
      side="right"
      delayDuration={150}
    >
      <button type="button" className="flex h-7 w-7 items-center justify-center rounded-xl hover:bg-muted transition-colors">
        <InfoIcon className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
    </Tooltip>
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
    <Tooltip content="Copy">
      <button type="button" className="flex h-7 w-7 items-center justify-center rounded-xl hover:bg-muted transition-colors" onClick={() => { void handleCopy(); }}>
        {copied ? <CheckIcon className="h-3.5 w-3.5 text-green-500" /> : <CopyIcon className="h-3.5 w-3.5 text-muted-foreground" />}
      </button>
    </Tooltip>
  );
};

const SpeakButton: FC = () => {
  const message = useMessage();
  // The assistant-ui runtime tracks speech state on the message:
  // message.speech is non-null when speaking, null when idle
  const isSpeaking = (message as { speech?: unknown }).speech != null;

  if (isSpeaking) {
    return (
      <Tooltip content="Stop speaking">
        <ActionBarPrimitive.StopSpeaking
          className="flex h-7 w-7 items-center justify-center rounded-xl hover:bg-muted transition-colors"
        >
          <SquareIcon className="h-3 w-3 text-primary" />
        </ActionBarPrimitive.StopSpeaking>
      </Tooltip>
    );
  }

  return (
    <Tooltip content="Read">
      <ActionBarPrimitive.Speak
        className="flex h-7 w-7 items-center justify-center rounded-xl hover:bg-muted transition-colors"
      >
        <Volume2Icon className="h-3.5 w-3.5 text-muted-foreground" />
      </ActionBarPrimitive.Speak>
    </Tooltip>
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
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive transition-colors hover:bg-destructive/20"
    >
      <StopCircleIcon className="h-4 w-4" />
    </button>
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
  const fullWidth = useFullWidthContent();
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

  const recordingEnabled = (config as Record<string, unknown> | null)?.audio
    ? ((config as Record<string, unknown>).audio as { recording?: { enabled?: boolean } })?.recording?.enabled ?? true
    : true;
  const {
    recordingState,
    elapsedSec: recordingElapsedSec,
    inputLevel: recordingInputLevel,
    isMuted: recordingMuted,
    toggleMute: toggleRecordingMute,
    startRecording,
    stopAndTranscribe,
    cancelRecording,
  } = useVoiceRecording();

  const isRecording = recordingState === 'recording' || recordingState === 'transcribing';


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
    // Refocus the composer after the native dialog closes.
    refocusComposer();
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

  // Voice recording: stop, transcribe, put text in composer (don't send)
  const handleRecordingDone = useCallback(async () => {
    const transcript = await stopAndTranscribe();
    if (transcript.trim()) {
      composerRuntime.setText(transcript.trim());
    }
  }, [stopAndTranscribe, composerRuntime]);

  const handleRecordingCancel = useCallback(() => {
    cancelRecording();
  }, [cancelRecording]);

  const cwdName = currentWorkingDirectory?.split('/').pop() ?? currentWorkingDirectory;
  const menuItemClassName = 'flex cursor-default items-center gap-2 rounded-lg px-3 py-2 text-sm text-foreground outline-none transition-colors data-[highlighted]:bg-muted/70';

  // When recording, show the RecordingOverlay instead of the normal composer
  if (isRecording) {
    return (
      <RecordingOverlay
        elapsedSec={recordingElapsedSec}
        inputLevel={recordingInputLevel}
        isMuted={recordingMuted}
        isTranscribing={recordingState === 'transcribing'}
        onToggleMute={toggleRecordingMute}
        onCancel={handleRecordingCancel}
        onDone={handleRecordingDone}
      />
    );
  }

  return (
    <div className={cn('relative z-20 mx-auto w-full px-5 pb-4 pt-4 md:pb-5 md:pt-5', !fullWidth && 'max-w-3xl')}>
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
      <div className="mx-auto w-full">
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
                  renderRecording={recordingEnabled ? () => (
                    <RecordingButton onStart={startRecording} />
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
                  placeholder={computerUseToggled ? (activeComputerSession && isComputerSessionTerminal(activeComputerSession.status) ? 'Continue the session with a follow-up...' : `What should ${__BRAND_PRODUCT_NAME} do on your computer?`) : 'Discuss your thoughts and ideas...'}
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
                        <Tooltip content={currentWorkingDirectory ? cwdName ?? 'Working directory' : 'Working directory'} side="top" sideOffset={8}>
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
                  <ChatSettingsButton
                    reasoningEffort={reasoningEffort}
                    onChangeReasoningEffort={onChangeReasoningEffort}
                    executionMode={executionMode}
                    onChangeExecutionMode={onChangeExecutionMode}
                    selectedModelKey={selectedModelKey}
                    onSelectModel={onSelectModel}
                    selectedProfileKey={selectedProfileKey}
                    onSelectProfile={onSelectProfile}
                    fallbackEnabled={fallbackEnabled}
                    onToggleFallback={onToggleFallback}
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
                  <CallButton />
                  {recordingEnabled && <RecordingButton onStart={startRecording} />}
                  <ThreadPrimitive.If running={false}>
                    <Tooltip content="Send message" side="top" sideOffset={8}>
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
                    </Tooltip>
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
