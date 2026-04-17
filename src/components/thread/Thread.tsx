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
  CpuIcon,
  Volume2Icon,
  SquareIcon,
  MicIcon,
  ChevronUpIcon,
  PhoneIcon,
  MonitorIcon,
  FolderOpenIcon,
  ImageIcon,
} from 'lucide-react';
import { app } from '@/lib/ipc-client';
import { copyTextToClipboard, logClipboardError } from '@/lib/clipboard';
import { useAttachments } from '@/providers/AttachmentContext';
import { useAssistantResponseTiming, useBranchNav, useCurrentWorkingDirectory, type TokenUsageData } from '@/providers/RuntimeProvider';
import { useConfig } from '@/providers/ConfigProvider';
import { useRealtime } from '@/providers/RealtimeProvider';
import { isDictationSupportedForProvider, createUnifiedDictationAdapter, type DictationSession, type AudioProvider } from '@/lib/audio/speech-adapters';
import { MarkdownText } from './MarkdownText';
import { UserCodeMarkdown } from './UserCodeMarkdown';
import { ElapsedBadge } from './ElapsedBadge';
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
import { CallOverlay } from './CallOverlay';
import { ComputerSessionPanel } from './ComputerSessionPanel';
import { ComputerSetupPanel } from './ComputerSetupPanel';
import { useComputerUse } from '@/providers/ComputerUseProvider';
import { usePlugins } from '@/providers/PluginProvider';
import { shouldShowComputerSetup, type ComputerSession } from '../../../shared/computer-use';
import { getResponseTiming } from '@/lib/response-timing';
import { SPINNER_VERBS } from '@/config/spinner-verbs';
const MATRIX_GLYPHS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890@#$%^&*+-/~{[|`]}<>01';

export type ThreadMode = 'chat' | 'computer';

export const Thread: FC<{
  mode: ThreadMode;
  onChangeMode: (mode: ThreadMode) => void;
  selectedModelKey: string | null;
  onSelectModel: (key: string) => void;
  reasoningEffort: ReasoningEffort;
  onChangeReasoningEffort: (value: ReasoningEffort) => void;
  selectedProfileKey: string | null;
  onSelectProfile: (key: string | null, primaryModelKey: string | null) => void;
  fallbackEnabled: boolean;
  onToggleFallback: (value: boolean) => void;
}> = ({ mode, onChangeMode, selectedModelKey, onSelectModel, reasoningEffort, onChangeReasoningEffort, selectedProfileKey, onSelectProfile, fallbackEnabled, onToggleFallback }) => {
  const [searchOpen, setSearchOpen] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const { callState } = useRealtime();
  const activeConversationId = useActiveConversationId();
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
    <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col overflow-hidden">
      <SearchBar visible={searchOpen} onClose={() => setSearchOpen(false)} viewportRef={viewportRef} />
      <FallbackBanner />
      <ComputerUseFallbackBanner />
      <ThreadModeTabs mode={mode} onChange={onChangeMode} />
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
          <ThreadPrimitive.Empty>
            <EmptyThreadBackground />
          </ThreadPrimitive.Empty>
          <ThreadWelcome />
          <div className="relative z-10 mx-auto flex w-full max-w-5xl flex-col px-3 pt-4 md:px-6 md:pt-8">
            <ThreadPrimitive.Messages
              components={{
                UserMessage,
                AssistantMessage,
              }}
            />

            <div className="min-h-8" />
          </div>
        </ThreadPrimitive.Viewport>
      ) : (
        <ComputerTabSurface />
      )}
      {callState.isInCall ? (
        <CallOverlay />
      ) : (
        <Composer
          mode={mode}
          selectedModelKey={selectedModelKey}
          onSelectModel={onSelectModel}
          reasoningEffort={reasoningEffort}
          onChangeReasoningEffort={onChangeReasoningEffort}
          selectedProfileKey={selectedProfileKey}
          onSelectProfile={onSelectProfile}
          fallbackEnabled={fallbackEnabled}
          onToggleFallback={onToggleFallback}
        />
      )}
    </ThreadPrimitive.Root>
  );
};

const ThreadModeTabs: FC<{ mode: ThreadMode; onChange: (mode: ThreadMode) => void }> = ({ mode, onChange }) => {
  const { config } = useConfig();
  const computerUseEnabled = (config as Record<string, unknown> | null)?.computerUse
    ? ((config as Record<string, unknown>).computerUse as { enabled?: boolean })?.enabled ?? false
    : false;

  if (!computerUseEnabled) return null;

  return (
    <div className="border-b border-border/70 bg-background/85 px-3 py-2 backdrop-blur-md md:px-6">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-1.5">
        <button
          type="button"
          onClick={() => onChange('chat')}
          className={`rounded-xl px-3 py-1.5 text-xs font-medium transition-colors ${mode === 'chat' ? 'bg-primary text-primary-foreground' : 'border border-border/70 bg-card/60 text-muted-foreground hover:bg-muted/50'}`}
        >
          Chat
        </button>
        <button
          type="button"
          onClick={() => onChange('computer')}
          className={`rounded-xl px-3 py-1.5 text-xs font-medium transition-colors ${mode === 'computer' ? 'bg-primary text-primary-foreground' : 'border border-border/70 bg-card/60 text-muted-foreground hover:bg-muted/50'}`}
        >
          Computer
        </button>
      </div>
    </div>
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

const GuidanceComposer: FC<{ sessionId: string }> = ({ sessionId }) => {
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
    <div className="rounded-[1.7rem] border border-border/70 bg-card/78 px-3 py-3 app-composer-shadow">
      <div className="flex items-center gap-2">
        <RichChatInput
          value={text}
          onChange={setText}
          onSubmit={handleSend}
          placeholder="Guide the session... (Enter to send)"
          className="min-h-[36px] max-h-[180px] flex-1 bg-transparent px-1 py-1 text-sm outline-none"
        />
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

const ThreadWelcome: FC = () => {
  const threadRuntime = useThreadRuntime();
  const gradientText = __BRAND_THEME_GRADIENT_TEXT !== 'false';

  const handleSuggestion = useCallback((text: string) => {
    threadRuntime.append({
      role: 'user',
      content: [{ type: 'text', text }],
    });
  }, [threadRuntime]);

  return (
    <ThreadPrimitive.Empty>
      <div className="absolute inset-0 z-20 flex flex-col overflow-y-auto px-3 py-4 md:px-6 md:py-8">
        <div className="m-auto flex w-full max-w-2xl select-none flex-col items-center">
          <div className="mb-3 inline-flex items-center gap-0.5 text-2xl font-semibold md:text-4xl">
            <span className={`app-wordmark ${gradientText ? 'app-gradient-text' : 'app-gradient-text-off'}`}>{__BRAND_WORDMARK}</span>
            <CpuIcon className="h-6 w-6 text-primary/80 md:h-9 md:w-9" />
          </div>
          <p className="max-w-xl text-center text-sm text-muted-foreground">
            Your local neural workspace for coding, tooling, and system automation.
          </p>
          <div className="mt-8 grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
            {['List files in my home directory', 'Search for TODO comments in my code', 'Help me write a shell script', 'Explain a file in my project'].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => handleSuggestion(s)}
                className="rounded-2xl border border-border/70 bg-card/45 px-4 py-3 text-left text-xs transition-colors hover:bg-accent/70"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
    </ThreadPrimitive.Empty>
  );
};

/** Build-time-configured background for the empty thread state */
const EmptyThreadBackground: FC = () => {
  const background = __BRAND_THEME_BACKGROUND || 'matrix-rain';

  if (background === 'none') return null;
  if (background === 'gradient') return <GradientBackground />;
  if (background === 'constellation') return <ConstellationBackground />;
  return <MatrixRainBackground />;
};

/** Subtle radial gradient alternative to the matrix rain */
const GradientBackground: FC = () => (
  <div
    aria-hidden="true"
    className="pointer-events-none absolute inset-0 overflow-hidden"
  >
    <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse 70% 50% at 50% 30%, var(--app-shell-glow), transparent)' }} />
    <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at 30% 70%, var(--brand-accent-subtle), transparent 50%)' }} />
    <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-background via-background/75 to-transparent" />
  </div>
);

const MatrixRainBackground: FC = () => (
  <div
    aria-hidden="true"
    className="pointer-events-none absolute inset-0 overflow-hidden"
  >
    <canvas ref={useMatrixCanvas()} className="absolute inset-0 h-full w-full opacity-45" />
    <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-background via-background/70 to-transparent" />
    <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-background via-background/75 to-transparent" />
    <div className="absolute inset-y-0 left-0 w-28 bg-gradient-to-r from-background via-background/85 to-transparent" />
    <div className="absolute inset-y-0 right-0 w-28 bg-gradient-to-l from-background via-background/85 to-transparent" />
    <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at center, var(--brand-accent-subtle), transparent 58%)' }} />
  </div>
);

function useMatrixCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    let frameId = 0;
    let animationFrame = 0;
    let drops: number[] = [];
    let columnCount = 0;
    const fontSize = 14;

    const setup = () => {
      const parent = canvas.parentElement;
      const width = parent?.clientWidth ?? window.innerWidth;
      const height = parent?.clientHeight ?? window.innerHeight;
      const devicePixelRatio = window.devicePixelRatio || 1;

      canvas.width = Math.floor(width * devicePixelRatio);
      canvas.height = Math.floor(height * devicePixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      context.setTransform(1, 0, 0, 1, 0, 0);
      context.scale(devicePixelRatio, devicePixelRatio);

      columnCount = Math.ceil(width / fontSize);
      drops = Array.from({ length: columnCount }, () => 1);
    };

    const draw = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const styles = getComputedStyle(document.documentElement);

      context.fillStyle = styles.getPropertyValue('--app-matrix-fade').trim() || 'rgba(10, 10, 10, 0.08)';
      context.fillRect(0, 0, width, height);

      context.fillStyle = styles.getPropertyValue('--app-matrix-glyph').trim() || 'rgba(160, 160, 160, 0.7)';
      context.font = `${fontSize}px Monaco, "Cascadia Code", monospace`;

      for (let index = 0; index < drops.length; index += 1) {
        const glyph = MATRIX_GLYPHS[Math.floor(Math.random() * MATRIX_GLYPHS.length)];
        const x = index * fontSize;
        const y = drops[index] * fontSize;

        context.fillText(glyph, x, y);

        if (y > height && Math.random() > 0.975) {
          drops[index] = 0;
        }

        drops[index] += 1;
      }

      frameId = window.setTimeout(() => {
        animationFrame = window.requestAnimationFrame(draw);
      }, 65);
    };

    setup();
    draw();

    const handleResize = () => {
      window.clearTimeout(frameId);
      window.cancelAnimationFrame(animationFrame);
      setup();
      draw();
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.clearTimeout(frameId);
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  return canvasRef;
}

const ConstellationBackground: FC = () => (
  <div
    aria-hidden="true"
    className="pointer-events-none absolute inset-0 overflow-hidden"
  >
    <canvas ref={useConstellationCanvas()} className="absolute inset-0 h-full w-full" />
    <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-background via-background/70 to-transparent" />
    <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-background via-background/75 to-transparent" />
    <div className="absolute inset-y-0 left-0 w-28 bg-gradient-to-r from-background via-background/85 to-transparent" />
    <div className="absolute inset-y-0 right-0 w-28 bg-gradient-to-l from-background via-background/85 to-transparent" />
    <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at center, var(--brand-accent-subtle), transparent 58%)' }} />
  </div>
);

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  opacity: number;
  /** false = background star (twinkles, never connects) */
  connectable: boolean;
  /** Number of spikes on the star shape (3–6) */
  spikes: number;
  /** Rotation angle in radians — slowly drifts */
  rotation: number;
  /** Twinkle phase offset (radians) — used for blinking stars */
  twinklePhase: number;
  /** Ticks until next random velocity nudge */
  nudgeCountdown: number;
}

/** Draw a spiked star: prominent circle body with thin needle spikes protruding outward */
function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, spikes: number, size: number, rotation: number) {
  const bodyRadius = size * 0.7;
  const spikeLength = size * 1.8;
  const spikeHalfWidth = Math.PI * 0.06; /* narrow spike base */

  /* Draw circle body */
  ctx.beginPath();
  ctx.arc(cx, cy, bodyRadius, 0, Math.PI * 2);
  ctx.fill();

  /* Draw each spike as a thin triangle from the circle edge outward */
  for (let i = 0; i < spikes; i += 1) {
    const angle = rotation + (i * Math.PI * 2) / spikes;
    const tipX = cx + Math.cos(angle) * spikeLength;
    const tipY = cy + Math.sin(angle) * spikeLength;
    const baseX1 = cx + Math.cos(angle - spikeHalfWidth) * bodyRadius;
    const baseY1 = cy + Math.sin(angle - spikeHalfWidth) * bodyRadius;
    const baseX2 = cx + Math.cos(angle + spikeHalfWidth) * bodyRadius;
    const baseY2 = cy + Math.sin(angle + spikeHalfWidth) * bodyRadius;

    ctx.beginPath();
    ctx.moveTo(baseX1, baseY1);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(baseX2, baseY2);
    ctx.closePath();
    ctx.fill();
  }
}

function useConstellationCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    let frameId = 0;
    let animationFrame = 0;
    let particles: Particle[] = [];
    let tick = 0;

    const nodeCount = 35;
    const starCount = 1200;
    const totalCount = nodeCount + starCount;
    const connectionDistance = 160;
    const maxConnectionsPerNode = 3;
    const nodeSpeed = 0.35;
    const starSpeed = 0.06;

    /**
     * Persistent connection state. Keys are "i:j" (lower index first).
     * `strength` lerps toward 1 when in range, toward 0 when out of range.
     * Connections are removed once strength drops below 0.02.
     */
    const connections = new Map<string, { strength: number }>();
    const fadeInRate = 0.04;   /* frames to reach full opacity: ~25 */
    const fadeOutRate = 0.02;  /* frames to disappear: ~50 */

    /** Shooting star state */
    interface ShootingStar {
      x: number; y: number;
      vx: number; vy: number;
      life: number;      /* frames remaining */
      maxLife: number;    /* total lifespan */
      tailLength: number; /* px */
    }
    let shootingStar: ShootingStar | null = null;
    const shootingStarChance = 0.003; /* ~0.3% per frame ≈ one every ~20s */
    const shootingStarFrames = 38;    /* ~2.5s at 65ms/frame */

    const makeParticle = (width: number, height: number, connectable: boolean): Particle => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * (connectable ? nodeSpeed : starSpeed) * 2,
      vy: (Math.random() - 0.5) * (connectable ? nodeSpeed : starSpeed) * 2,
      radius: connectable ? 2.5 + Math.random() * 2.5 : 1.2 + Math.random() * 2,
      opacity: connectable ? 0.6 + Math.random() * 0.35 : 0.3 + Math.random() * 0.6,
      connectable,
      spikes: 3 + Math.floor(Math.random() * 4),
      rotation: Math.random() * Math.PI * 2,
      twinklePhase: Math.random() * Math.PI * 2,
      nudgeCountdown: 60 + Math.floor(Math.random() * 200),
    });

    let prevWidth = 0;
    let prevHeight = 0;

    const setup = () => {
      const container = canvas.parentElement;
      const width = container?.offsetWidth ?? window.innerWidth;
      const height = container?.offsetHeight ?? window.innerHeight;
      const dpr = window.devicePixelRatio || 1;

      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      context.setTransform(1, 0, 0, 1, 0, 0);
      context.scale(dpr, dpr);

      // When the canvas grows, rescale existing particle positions so they
      // spread across the full area instead of staying clumped in the old region.
      if (prevWidth > 0 && prevHeight > 0 && (width > prevWidth || height > prevHeight)) {
        const sx = width / prevWidth;
        const sy = height / prevHeight;
        for (const p of particles) {
          p.x *= sx;
          p.y *= sy;
        }
      }

      prevWidth = width;
      prevHeight = height;

      const kept = particles.filter(
        (p) => p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height,
      );
      const keptNodes = kept.filter((p) => p.connectable);
      const keptStars = kept.filter((p) => !p.connectable);

      const freshNodes = Array.from(
        { length: Math.max(0, nodeCount - keptNodes.length) },
        () => makeParticle(width, height, true),
      );
      const freshStars = Array.from(
        { length: Math.max(0, starCount - keptStars.length) },
        () => makeParticle(width, height, false),
      );

      particles = [...keptNodes, ...freshNodes, ...keptStars, ...freshStars];
    };

    const draw = () => {
      const container = canvas.parentElement;
      const width = container?.offsetWidth ?? window.innerWidth;
      const height = container?.offsetHeight ?? window.innerHeight;
      const dpr = window.devicePixelRatio || 1;

      /* If the container grew beyond the canvas buffer, resize immediately
         so the full area is rendered without waiting for a resize event. */
      const needW = Math.floor(width * dpr);
      const needH = Math.floor(height * dpr);
      if (canvas.width < needW || canvas.height < needH) {
        canvas.width = needW;
        canvas.height = needH;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.scale(dpr, dpr);
      }

      const styles = getComputedStyle(document.documentElement);
      tick += 1;

      const dotColor = styles.getPropertyValue('--app-constellation-dot').trim() || 'rgba(160, 160, 160, 0.5)';
      const lineColor = styles.getPropertyValue('--app-constellation-line').trim() || 'rgba(160, 160, 160, 0.18)';

      /* Clear frame completely — no motion trails */
      context.globalAlpha = 1;
      context.clearRect(0, 0, width, height);

      /* Update positions + nudge velocities for organic movement */
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;

        if (p.x < 0 || p.x > width) p.vx *= -1;
        if (p.y < 0 || p.y > height) p.vy *= -1;
        p.x = Math.max(0, Math.min(width, p.x));
        p.y = Math.max(0, Math.min(height, p.y));

        /* Random velocity nudges — keeps constellations reshaping */
        p.nudgeCountdown -= 1;
        if (p.nudgeCountdown <= 0) {
          const cap = p.connectable ? nodeSpeed : starSpeed;
          p.vx += (Math.random() - 0.5) * cap * 1.2;
          p.vy += (Math.random() - 0.5) * cap * 1.2;
          /* Clamp speed */
          const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
          if (speed > cap) {
            p.vx = (p.vx / speed) * cap;
            p.vy = (p.vy / speed) * cap;
          }
          p.nudgeCountdown = 60 + Math.floor(Math.random() * 200);
        }

        /* Slow rotation drift */
        p.rotation += p.connectable ? 0.003 : 0.006;

        /* Randomly promote stars to connectors or demote connectors to stars.
           ~0.1% chance per frame keeps the network evolving unpredictably. */
        if (Math.random() < 0.001) {
          p.connectable = !p.connectable;
          if (p.connectable) {
            /* Promoted: grow slightly, speed up */
            p.radius = 2.5 + Math.random() * 2.5;
            const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 0.01;
            const scale = nodeSpeed / Math.max(speed, 0.01);
            p.vx *= scale;
            p.vy *= scale;
          } else {
            /* Demoted: shrink, slow down */
            p.radius = 1.2 + Math.random() * 2;
            p.vx *= 0.2;
            p.vy *= 0.2;
          }
        }
      }

      /* ── Update persistent connections ──────────────────────────────────
         Build a set of in-range pairs, fade existing connections in/out,
         and probabilistically form new ones. */
      const inRangePairs = new Set<string>();
      const connectionCounts = new Uint8Array(totalCount);

      /* Count existing strong connections toward the cap */
      for (const [key, conn] of connections) {
        if (conn.strength < 0.3) continue;
        const [a, b] = key.split(':').map(Number);
        connectionCounts[a] += 1;
        connectionCounts[b] += 1;
      }

      for (let i = 0; i < particles.length; i += 1) {
        if (connectionCounts[i] >= maxConnectionsPerNode) continue;

        for (let j = i + 1; j < particles.length; j += 1) {
          if (connectionCounts[j] >= maxConnectionsPerNode) continue;
          if (!particles[i].connectable && !particles[j].connectable) continue;

          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < connectionDistance) {
            const key = `${i}:${j}`;
            inRangePairs.add(key);

            if (!connections.has(key)) {
              /* New connection — probabilistic formation */
              const proximity = 1 - dist / connectionDistance;
              let chance = 0.008 + proximity * 0.015; /* slow: ~1-2% per frame */
              if (!particles[i].connectable || !particles[j].connectable) chance *= 0.5;
              if (Math.random() < chance) {
                connections.set(key, { strength: 0.05 });
                connectionCounts[i] += 1;
                connectionCounts[j] += 1;
              }
            }
          }
        }
      }

      /* Fade connections in/out, detect loops, and draw */

      /* First pass: build adjacency from strong connections for loop detection */
      const neighbors = new Map<number, Set<number>>();
      const activeEdges: Array<{ key: string; conn: { strength: number }; a: number; b: number }> = [];

      for (const [key, conn] of connections) {
        if (inRangePairs.has(key)) {
          conn.strength = Math.min(1, conn.strength + fadeInRate);
        } else {
          conn.strength -= fadeOutRate;
        }

        if (conn.strength <= 0.02) {
          connections.delete(key);
          continue;
        }

        const [a, b] = key.split(':').map(Number);
        if (!particles[a] || !particles[b]) { connections.delete(key); continue; }

        activeEdges.push({ key, conn, a, b });

        if (conn.strength > 0.3) {
          if (!neighbors.has(a)) neighbors.set(a, new Set());
          if (!neighbors.has(b)) neighbors.set(b, new Set());
          neighbors.get(a)!.add(b);
          neighbors.get(b)!.add(a);
        }
      }

      /* Detect edges that are part of a triangle (3-node loop) */
      const loopEdges = new Set<string>();
      for (const { key, a, b } of activeEdges) {
        const aN = neighbors.get(a);
        const bN = neighbors.get(b);
        if (!aN || !bN) continue;
        /* If a and b share a common neighbor, this edge is part of a triangle */
        for (const n of aN) {
          if (n !== b && bN.has(n)) {
            loopEdges.add(key);
            /* Also mark the other two edges of the triangle */
            const minAn = Math.min(a, n);
            const maxAn = Math.max(a, n);
            const minBn = Math.min(b, n);
            const maxBn = Math.max(b, n);
            loopEdges.add(`${minAn}:${maxAn}`);
            loopEdges.add(`${minBn}:${maxBn}`);
            break;
          }
        }
      }

      /* Draw edges */
      const pulse = 0.7 + 0.3 * Math.sin(tick * 0.08); /* slow pulsate for loop edges */
      for (const { key, conn, a, b } of activeEdges) {
        const pi = particles[a];
        const pj = particles[b];
        const dx = pi.x - pj.x;
        const dy = pi.y - pj.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const distAlpha = dist < connectionDistance ? 1 - dist / connectionDistance : 0.3;
        const isLoop = loopEdges.has(key);

        context.globalAlpha = conn.strength * distAlpha * (isLoop ? pulse : 1);
        context.strokeStyle = lineColor;
        context.lineWidth = isLoop ? 2 : 1.2;
        context.beginPath();
        context.moveTo(pi.x, pi.y);
        context.lineTo(pj.x, pj.y);
        context.stroke();
      }

      /* Draw all particles as star shapes */
      context.fillStyle = dotColor;
      for (const p of particles) {
        let alpha = p.opacity;

        if (!p.connectable) {
          /* Stars twinkle with a slow sine wave */
          const twinkle = Math.sin(tick * 0.04 + p.twinklePhase);
          alpha = p.opacity * (0.3 + 0.7 * ((twinkle + 1) / 2));
        }

        context.globalAlpha = alpha;
        drawStar(context, p.x, p.y, p.spikes, p.radius, p.rotation);
        context.fill();
      }

      /* ── Shooting star ──────────────────────────────────────────────────
         Randomly spawns from a random edge, streaks across at a random
         angle, fades in then out over ~2.5s, then disappears. */
      if (!shootingStar && Math.random() < shootingStarChance) {
        const edge = Math.floor(Math.random() * 4); /* 0=top 1=right 2=bottom 3=left */
        let sx: number, sy: number;
        if (edge === 0)      { sx = Math.random() * width;  sy = 0; }
        else if (edge === 1) { sx = width;                   sy = Math.random() * height; }
        else if (edge === 2) { sx = Math.random() * width;  sy = height; }
        else                 { sx = 0;                       sy = Math.random() * height; }

        /* Aim roughly toward center with some randomness */
        const targetX = width * (0.3 + Math.random() * 0.4);
        const targetY = height * (0.3 + Math.random() * 0.4);
        const angle = Math.atan2(targetY - sy, targetX - sx) + (Math.random() - 0.5) * 0.6;
        const speed = 12 + Math.random() * 8; /* fast! */

        shootingStar = {
          x: sx, y: sy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: shootingStarFrames,
          maxLife: shootingStarFrames,
          tailLength: 60 + Math.random() * 40,
        };
      }

      if (shootingStar) {
        const s = shootingStar;
        s.x += s.vx;
        s.y += s.vy;
        s.life -= 1;

        /* Fade in for first 20%, full brightness middle 60%, fade out last 20% */
        const progress = 1 - s.life / s.maxLife;
        let alpha: number;
        if (progress < 0.2) alpha = progress / 0.2;
        else if (progress > 0.8) alpha = (1 - progress) / 0.2;
        else alpha = 1;

        /* Draw tail (gradient line from current pos backward along velocity) */
        const tailX = s.x - (s.vx / Math.sqrt(s.vx * s.vx + s.vy * s.vy)) * s.tailLength;
        const tailY = s.y - (s.vy / Math.sqrt(s.vx * s.vx + s.vy * s.vy)) * s.tailLength;

        const grad = context.createLinearGradient(tailX, tailY, s.x, s.y);
        grad.addColorStop(0, 'transparent');
        grad.addColorStop(1, dotColor);

        context.globalAlpha = alpha * 0.9;
        context.strokeStyle = grad;
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(tailX, tailY);
        context.lineTo(s.x, s.y);
        context.stroke();

        /* Bright head dot */
        context.globalAlpha = alpha;
        context.fillStyle = dotColor;
        context.beginPath();
        context.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
        context.fill();

        /* Remove when expired or off-screen */
        if (s.life <= 0 || s.x < -100 || s.x > width + 100 || s.y < -100 || s.y > height + 100) {
          shootingStar = null;
        }
      }

      context.globalAlpha = 1;

      frameId = window.setTimeout(() => {
        animationFrame = window.requestAnimationFrame(draw);
      }, 65);
    };

    setup();
    draw();

    const handleResize = () => {
      window.clearTimeout(frameId);
      window.cancelAnimationFrame(animationFrame);
      setup();
      draw();
    };

    // Use ResizeObserver on the container so the canvas is correctly sized
    // on first layout (Electron may render before the window is fully sized).
    const container = canvas.parentElement;
    let ro: ResizeObserver | undefined;
    if (container) {
      ro = new ResizeObserver(handleResize);
      ro.observe(container);
    }

    window.addEventListener('resize', handleResize);
    return () => {
      window.clearTimeout(frameId);
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', handleResize);
      ro?.disconnect();
    };
  }, []);

  return canvasRef;
}

const UserMessage: FC = () => {
  const message = useMessage();
  const { config } = useConfig();
  const ttsEnabled = (config as Record<string, unknown> | null)?.audio
    ? ((config as Record<string, unknown>).audio as { tts?: { enabled?: boolean } })?.tts?.enabled ?? true
    : true;
  return (
    <MessagePrimitive.Root className="group mb-6 flex justify-end">
      <div className="max-w-[88%] md:max-w-[72%]">
        <div
          className="rounded-xl border px-4 py-2.5 text-foreground"
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
        }}
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
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-destructive text-destructive-foreground transition-colors hover:bg-destructive/90"
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
  const levelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const webMonitorRef = useRef<Array<{ stream: MediaStream; audioContext: AudioContext; analyser: AnalyserNode; data: Uint8Array<ArrayBuffer> }>>([]);

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
      // Clean up browser audio monitoring
      for (const item of webMonitorRef.current) {
        try { item.audioContext.close(); } catch { /* ignore */ }
        item.stream.getTracks().forEach(t => t.stop());
      }
      webMonitorRef.current = [];
      setLevels({});
      return;
    }

    if (isWebBridgeDictation) {
      // Browser: request permission for labels, enumerate, then monitor levels
      let cancelled = false;
      (async () => {
        try {
          // Request mic access so device labels are populated
          const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          tempStream.getTracks().forEach(t => t.stop());
          if (cancelled) return;

          const allDevices = await navigator.mediaDevices.enumerateDevices();
          if (cancelled) return;

          const inputs = allDevices
            .filter((d) => d.kind === 'audioinput')
            .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Microphone' }));
          setDevices(inputs);

          // Open a stream for each device and monitor levels via Web Audio API
          const monitors: typeof webMonitorRef.current = [];
          for (const device of inputs) {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({
                audio: { deviceId: { exact: device.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
              });
              if (cancelled) { stream.getTracks().forEach(t => t.stop()); break; }
              const audioContext = new AudioContext();
              const source = audioContext.createMediaStreamSource(stream);
              const analyser = audioContext.createAnalyser();
              analyser.fftSize = 2048;
              source.connect(analyser);
              monitors.push({ stream, audioContext, analyser, data: new Uint8Array(analyser.fftSize) as Uint8Array<ArrayBuffer> });
            } catch { /* device open failed, skip */ }
          }
          if (cancelled) {
            for (const m of monitors) { try { m.audioContext.close(); } catch { /* ignore */ } m.stream.getTracks().forEach(t => t.stop()); }
            return;
          }
          webMonitorRef.current = monitors;

          // Map device IDs to monitors for level polling
          const deviceIdToMonitor = new Map<string, typeof monitors[number]>();
          inputs.forEach((d, i) => { if (monitors[i]) deviceIdToMonitor.set(d.deviceId, monitors[i]); });

          // Poll levels at ~15 fps
          levelTimerRef.current = setInterval(() => {
            const lvls: Record<string, number> = {};
            for (const [id, mon] of deviceIdToMonitor) {
              mon.analyser.getByteTimeDomainData(mon.data);
              let sum = 0;
              for (let j = 0; j < mon.data.length; j++) {
                const v = (mon.data[j] - 128) / 128;
                sum += v * v;
              }
              lvls[id] = Math.sqrt(sum / mon.data.length);
            }
            // Also set 'default' level from the first device
            if (inputs.length > 0 && lvls[inputs[0].deviceId] !== undefined) {
              lvls['default'] = lvls[inputs[0].deviceId];
            }
            setLevels(lvls);
          }, 66);
        } catch {
          setDevices([]);
        }
      })();
      return () => {
        cancelled = true;
        if (levelTimerRef.current) { clearInterval(levelTimerRef.current); levelTimerRef.current = null; }
        for (const item of webMonitorRef.current) {
          try { item.audioContext.close(); } catch { /* ignore */ }
          item.stream.getTracks().forEach(t => t.stop());
        }
        webMonitorRef.current = [];
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

  return (
    <div ref={rootRef} className="relative flex items-center">
      {/* Joined button group: chevron/dots + mic */}
      <div className={`flex items-center overflow-hidden rounded-xl border transition-colors ${
        isActive
          ? 'border-primary/50 bg-primary/10'
          : isActivating
            ? 'border-primary/30 bg-primary/5'
            : 'border-border/70 bg-card/70'
      }`}>
        {/* Left segment: chevron (idle) or animated dots (active) */}
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
                <ChevronUpIcon className={`h-3.5 w-3.5 transition-transform ${pickerOpen ? 'rotate-180' : ''}`} />
              </button>
            </Tooltip>
          )
        }

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
        <div className="absolute bottom-full right-0 mb-2 whitespace-nowrap rounded-lg bg-card border border-border/70 px-2.5 py-1.5 text-[10px] text-muted-foreground shadow-lg z-50">
          {error}
        </div>
      )}

      {/* Device picker popover — toggled by chevron button */}
      {pickerOpen && (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-[300px] rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-[0_16px_40px_rgba(5,4,15,0.28)] backdrop-blur-xl">
          {/* Level indicator bar */}
          <div className="flex items-center gap-2 px-3 pt-2 pb-1">
            <MicIcon className="h-3.5 w-3.5 text-muted-foreground" />
            <div className="flex-1 h-1.5 rounded-full bg-muted/50 overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all duration-75"
                style={{ width: `${Math.min(100, Math.round((levels[selectedDeviceId ?? 'default'] ?? 0) * 500))}%` }}
              />
            </div>
          </div>

          <div className="px-3 py-2 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
            Input Device
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
          <div className="flex items-center justify-between border-t border-border/50 mx-1.5 mt-1 px-2 py-2">
            <div className="flex items-center gap-2">
              <MicIcon className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-foreground">Hold to record</span>
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
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors bg-muted/60 text-muted-foreground hover:bg-muted"
      >
        <PhoneIcon className="h-4 w-4" />
      </button>
    </Tooltip>
  );
};

const Composer: FC<{
  mode: ThreadMode;
  selectedModelKey: string | null;
  onSelectModel: (key: string) => void;
  reasoningEffort: ReasoningEffort;
  onChangeReasoningEffort: (value: ReasoningEffort) => void;
  selectedProfileKey: string | null;
  onSelectProfile: (key: string | null, primaryModelKey: string | null) => void;
  fallbackEnabled: boolean;
  onToggleFallback: (value: boolean) => void;
}> = ({ mode, selectedModelKey, onSelectModel, reasoningEffort, onChangeReasoningEffort, selectedProfileKey, onSelectProfile, fallbackEnabled, onToggleFallback }) => {
  const composerRuntime = useComposerRuntime();
  const { attachments, addAttachments, removeAttachment } = useAttachments();
  const { currentWorkingDirectory, setCurrentWorkingDirectory } = useCurrentWorkingDirectory();
  const { config } = useConfig();
  const { sessionsByConversation } = useComputerUse();
  const activeConversationId = useActiveConversationId();
  const [composerText, setComposerText] = useState(() => composerRuntime.getState().text ?? '');
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
  const [showDirectoryBrowser, setShowDirectoryBrowser] = useState(false);

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
    composerRuntime.send();
  }, [attachments.length, composerRuntime, composerText]);

  const canSend = composerText.trim().length > 0 || attachments.length > 0;
  const hasFileAttachments = attachments.length > 0;
  const cwdName = currentWorkingDirectory?.split('/').pop() ?? currentWorkingDirectory;
  const menuItemClassName = 'flex cursor-default items-center gap-2 rounded-lg px-3 py-2 text-sm text-foreground outline-none transition-colors data-[highlighted]:bg-muted/70';

  return (
    <div className="relative z-20 border-t border-border/70 bg-background/88 px-3 pb-3 pt-3 backdrop-blur-md md:px-6 md:pb-6 md:pt-4">
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
              <div key={`${file.name}-${i}`} className="group/att flex items-center gap-1.5 rounded-2xl border border-border/70 bg-card/65 px-2.5 py-2 text-xs">
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
            <GuidanceComposer sessionId={activeComputerSession.id} />
          ) : null
        ) : (
          <ComposerPrimitive.Root className="flex flex-col gap-0 rounded-[1.7rem] border border-border/70 bg-card/78 px-3 py-3 app-composer-shadow">
            {mode === 'computer' ? (
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
            ) : (
              <>
                {currentWorkingDirectory && (
                  <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-muted/25 px-3 py-2 text-[11px]">
                    <div className="flex min-w-0 items-center gap-2">
                      <FolderOpenIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="shrink-0 font-medium text-foreground/90">Working Dir</span>
                      <span className="shrink-0 text-muted-foreground">/</span>
                      <span className="max-w-[360px] truncate text-muted-foreground" title={currentWorkingDirectory}>
                        {currentWorkingDirectory}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <span className="max-w-[120px] truncate text-[10px] text-foreground/80" title={cwdName ?? undefined}>
                        {cwdName}
                      </span>
                      <button
                        type="button"
                        onClick={() => { void setCurrentWorkingDirectory(null); }}
                        className="rounded-md p-1 transition-colors hover:bg-destructive/10"
                        title="Clear current working directory"
                      >
                        <XIcon className="h-3 w-3 text-muted-foreground" />
                      </button>
                    </div>
                  </div>
                )}
                <ComposerInput
                  placeholder={isDictating ? 'Listening...' : __BRAND_COMPOSER_PLACEHOLDER}
                  className="min-h-[48px] max-h-[220px] w-full overflow-y-auto px-1 py-0.5 text-base md:text-[15px]"
                  autoFocus
                />
                <div className="flex items-center justify-between gap-2 md:gap-3">
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 md:gap-2">
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <button type="button" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-card/70 transition-colors hover:bg-muted/50" title="Add attachment">
                          <PlusIcon className="h-4 w-4 text-muted-foreground" />
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          align="start"
                          sideOffset={8}
                          className="z-50 min-w-[240px] rounded-2xl border border-border/70 bg-popover/95 p-1.5 text-popover-foreground shadow-xl backdrop-blur-md"
                        >
                          <DropdownMenu.Item className={menuItemClassName} onSelect={() => { void handleAttachDirectory(); }}>
                            <FolderOpenIcon className="h-4 w-4 text-muted-foreground" />
                            <span>Working Directory</span>
                          </DropdownMenu.Item>
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
                  </div>
                  <ModelSettingsButton
                    selectedModelKey={selectedModelKey}
                    onSelectModel={onSelectModel}
                    reasoningEffort={reasoningEffort}
                    onChangeReasoningEffort={onChangeReasoningEffort}
                    fallbackEnabled={fallbackEnabled}
                    onToggleFallback={onToggleFallback}
                    selectedProfileKey={selectedProfileKey}
                    onSelectProfile={onSelectProfile}
                  />
                  {dictationEnabled && <DictationButton onListeningChange={setIsDictating} startRef={dictationStartRef} stopRef={dictationStopRef} />}
                  <CallButton />
                  <ThreadPrimitive.If running={false}>
                    <button
                      type="button"
                      onClick={handleSend}
                      disabled={!canSend}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                    >
                        <SendHorizontalIcon className="h-4 w-4" />
                    </button>
                  </ThreadPrimitive.If>
                  <ThreadPrimitive.If running>
                    <StopButton />
                  </ThreadPrimitive.If>
                </div>
              </>
            )}
          </ComposerPrimitive.Root>
        )}
      </div>
    </div>
  );
};
