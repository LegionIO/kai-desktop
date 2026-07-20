// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { RuntimeProvider, useStepTracking, useRuntimeConversationId } from '../RuntimeProvider';
import { AttachmentProvider } from '../AttachmentContext';

// ---------------------------------------------------------------------------
// Shared mock state — used both by vi.mock('@/lib/ipc-client') and
// buildWindowApp() so all IPC paths (module-level app Proxy and window.app)
// resolve to the same controlled stubs.
// ---------------------------------------------------------------------------

type StreamEventCallback = (event: unknown) => void;
type ConversationsChangedCallback = (store: unknown) => void;

let streamEventCallback: StreamEventCallback | null = null;
let _conversationsChangedCallback: ConversationsChangedCallback | null = null;
const mockStream = vi.fn().mockResolvedValue(undefined);
const mockGetActiveId = vi.fn().mockResolvedValue('conv-active');
const mockGet = vi.fn().mockResolvedValue({
  id: 'conv-active',
  title: null,
  fallbackTitle: null,
  messages: [],
  messageTree: [],
  headId: null,
  conversationCompaction: null,
  lastContextUsage: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastMessageAt: null,
  titleStatus: 'idle',
  titleUpdatedAt: null,
  messageCount: 0,
  userMessageCount: 0,
  runStatus: 'idle',
  hasUnread: false,
  lastAssistantUpdateAt: null,
  selectedModelKey: null,
});
const mockPut = vi.fn().mockResolvedValue(undefined);
const mockSetActiveId = vi.fn().mockResolvedValue(undefined);
const mockList = vi.fn().mockResolvedValue([]);
const mockConfigGet = vi.fn().mockResolvedValue({});
const mockConfigOnChanged = vi.fn().mockReturnValue(() => {});
const mockHomedir = vi.fn().mockResolvedValue('/home/test');

// ---------------------------------------------------------------------------
// Mock @/lib/ipc-client so the module-level `app` Proxy is replaced with a
// controlled stub. This prevents persistConversation from calling getApp()
// across async boundaries (e.g. after afterEach deletes window.app) and
// emitting [Runtime] Failed to persist stderr noise.
//
// All functions delegate to the same module-level mocks above, so beforeEach
// resets (mockGet.mockClear etc.) apply uniformly.
// ---------------------------------------------------------------------------

vi.mock('@/lib/ipc-client', () => ({
  app: {
    conversations: {
      get: (...args: unknown[]) => mockGet(...args),
      put: (...args: unknown[]) => mockPut(...args),
      list: (...args: unknown[]) => mockList(...args),
      delete: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
      getActiveId: (...args: unknown[]) => mockGetActiveId(...args),
      setActiveId: (...args: unknown[]) => mockSetActiveId(...args),
      onChanged: vi.fn().mockImplementation((cb: ConversationsChangedCallback) => {
        _conversationsChangedCallback = cb;
        return () => {
          _conversationsChangedCallback = null;
        };
      }),
    },
    agent: {
      stream: (...args: unknown[]) => mockStream(...args),
      cancelStream: vi.fn().mockResolvedValue(undefined),
      generateTitle: vi.fn().mockResolvedValue({ title: null }),
      onStreamEvent: vi.fn().mockImplementation((cb: StreamEventCallback) => {
        streamEventCallback = cb;
        return () => {
          streamEventCallback = null;
        };
      }),
      sendSubAgentMessage: vi.fn().mockResolvedValue({ ok: true }),
      stopSubAgent: vi.fn().mockResolvedValue({ ok: true }),
      listSubAgents: vi.fn().mockResolvedValue({ ids: [] }),
      approveToolCall: vi.fn().mockResolvedValue({ ok: true }),
      rejectToolCall: vi.fn().mockResolvedValue({ ok: true }),
      dismissToolCall: vi.fn().mockResolvedValue({ ok: true }),
      answerToolQuestion: vi.fn().mockResolvedValue({ ok: true }),
      getAvailableRuntimes: vi.fn().mockResolvedValue([]),
      getActiveRuntime: vi.fn().mockResolvedValue('mastra'),
    },
    config: {
      get: (...args: unknown[]) => mockConfigGet(...args),
      set: vi.fn().mockResolvedValue({}),
      onChanged: (...args: unknown[]) => mockConfigOnChanged(...args),
    },
    platform: {
      homedir: (...args: unknown[]) => mockHomedir(...args),
    },
  },
}));

function buildWindowApp() {
  return {
    config: {
      get: mockConfigGet,
      set: vi.fn().mockResolvedValue({}),
      onChanged: mockConfigOnChanged,
    },
    agent: {
      stream: mockStream,
      cancelStream: vi.fn().mockResolvedValue(undefined),
      generateTitle: vi.fn().mockResolvedValue({ title: null }),
      onStreamEvent: vi.fn().mockImplementation((cb: StreamEventCallback) => {
        streamEventCallback = cb;
        return () => {
          streamEventCallback = null;
        };
      }),
      sendSubAgentMessage: vi.fn().mockResolvedValue({ ok: true }),
      stopSubAgent: vi.fn().mockResolvedValue({ ok: true }),
      listSubAgents: vi.fn().mockResolvedValue({ ids: [] }),
      approveToolCall: vi.fn().mockResolvedValue({ ok: true }),
      rejectToolCall: vi.fn().mockResolvedValue({ ok: true }),
      dismissToolCall: vi.fn().mockResolvedValue({ ok: true }),
      answerToolQuestion: vi.fn().mockResolvedValue({ ok: true }),
      getAvailableRuntimes: vi.fn().mockResolvedValue([]),
      getActiveRuntime: vi.fn().mockResolvedValue('mastra'),
    },
    conversations: {
      list: mockList,
      get: mockGet,
      put: mockPut,
      delete: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
      getActiveId: mockGetActiveId,
      setActiveId: mockSetActiveId,
      onChanged: vi.fn().mockImplementation((cb: ConversationsChangedCallback) => {
        _conversationsChangedCallback = cb;
        return () => {
          _conversationsChangedCallback = null;
        };
      }),
    },
    platform: { homedir: mockHomedir },
    realtime: {
      startSession: vi.fn().mockResolvedValue({ ok: true }),
      endSession: vi.fn().mockResolvedValue({ ok: true }),
      sendAudio: vi.fn(),
      getStatus: vi.fn().mockResolvedValue({ status: 'idle' }),
      onEvent: vi.fn().mockReturnValue(() => {}),
    },
    profileCatalog: vi.fn().mockResolvedValue({ profiles: [], defaultKey: null }),
    modelCatalog: vi.fn().mockResolvedValue([]),
    memory: {
      clear: vi.fn().mockResolvedValue({ success: true }),
      testEmbedding: vi.fn().mockResolvedValue({ ok: true }),
    },
    mcp: { testConnection: vi.fn().mockResolvedValue({ status: 'ok', toolCount: 0 }) },
    cliTools: { checkBinaries: vi.fn().mockResolvedValue({}) },
    skills: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({ success: true }),
      toggle: vi.fn().mockResolvedValue({ success: true }),
    },
    plugins: {
      getUIState: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      getConfig: vi.fn().mockResolvedValue({}),
      setConfig: vi.fn().mockResolvedValue({ success: true }),
      modalAction: vi.fn().mockResolvedValue(null),
      bannerAction: vi.fn().mockResolvedValue(null),
      action: vi.fn().mockResolvedValue(null),
      marketplaceCatalog: vi.fn().mockResolvedValue([]),
      marketplaceInstall: vi.fn().mockResolvedValue({ success: true }),
      marketplaceUninstall: vi.fn().mockResolvedValue({ success: true }),
      marketplaceRefresh: vi.fn().mockResolvedValue([]),
      onUIStateChanged: vi.fn().mockReturnValue(() => {}),
      onEvent: vi.fn().mockReturnValue(() => {}),
      onNavigationRequest: vi.fn().mockReturnValue(() => {}),
      onNavigateDirect: vi.fn().mockReturnValue(() => {}),
      onModalCallback: vi.fn().mockReturnValue(() => {}),
    },
    dialog: {
      openFile: vi.fn().mockResolvedValue(null),
      openDirectory: vi.fn().mockResolvedValue({ canceled: true }),
      openDirectoryFiles: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
    },
    clipboard: { writeText: vi.fn().mockResolvedValue({ ok: true }) },
    image: {
      fetch: vi.fn().mockResolvedValue({ data: '', mime: '' }),
      save: vi.fn().mockResolvedValue({ canceled: true }),
    },
    shell: { openPath: vi.fn().mockResolvedValue({ ok: true }) },
    partitions: {
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue({ success: true }),
    },
    plans: { readFile: vi.fn().mockResolvedValue({ content: '' }) },
    tasks: {
      list: vi.fn().mockResolvedValue([]),
      listAll: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({ ok: true }),
      unarchive: vi.fn().mockResolvedValue({}),
      getOrder: vi.fn().mockResolvedValue(null),
      saveOrder: vi.fn().mockResolvedValue({ ok: true }),
      onChanged: vi.fn().mockReturnValue(() => {}),
      terminalCreate: vi.fn().mockResolvedValue({}),
      terminalWrite: vi.fn().mockResolvedValue(undefined),
      terminalResize: vi.fn().mockResolvedValue(undefined),
      terminalKill: vi.fn().mockResolvedValue({ ok: true }),
      onTerminalData: vi.fn().mockReturnValue(() => {}),
      onTerminalExit: vi.fn().mockReturnValue(() => {}),
      streamPlan: vi.fn().mockResolvedValue({ taskId: 'test' }),
      cancelPlanStream: vi.fn().mockResolvedValue({ ok: true }),
      generateTitle: vi.fn().mockResolvedValue({ title: null }),
      onStreamEvent: vi.fn().mockReturnValue(() => {}),
    },
    agents: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({ ok: true }),
      assignTask: vi.fn().mockResolvedValue({ ok: true }),
      unassignTask: vi.fn().mockResolvedValue({ ok: true }),
      start: vi.fn().mockResolvedValue({}),
      stop: vi.fn().mockResolvedValue({ ok: true }),
      synthesizePrompt: vi.fn().mockResolvedValue({ ok: true }),
      onChanged: vi.fn().mockReturnValue(() => {}),
    },
    workspaces: {
      create: vi.fn().mockResolvedValue({}),
      rename: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      setActive: vi.fn().mockResolvedValue(undefined),
      saveLastConversation: vi.fn().mockResolvedValue(undefined),
      browseDirectory: vi.fn().mockResolvedValue(null),
    },
    usage: {
      summary: vi.fn().mockResolvedValue({}),
      byConversation: vi.fn().mockResolvedValue([]),
      byModel: vi.fn().mockResolvedValue([]),
      timeSeries: vi.fn().mockResolvedValue([]),
      nonLlmEvents: vi.fn().mockResolvedValue([]),
      recordEvent: vi.fn().mockResolvedValue({}),
      exportCsv: vi.fn().mockResolvedValue({}),
    },
    autoUpdate: {
      check: vi.fn().mockResolvedValue({ ok: true }),
      install: vi.fn().mockResolvedValue(undefined),
      onStatus: vi.fn().mockReturnValue(() => {}),
    },
    mic: {
      listDevices: vi.fn().mockResolvedValue([]),
      startRecording: vi.fn().mockResolvedValue({ ok: true }),
      stopRecording: vi.fn().mockResolvedValue({}),
      cancelRecording: vi.fn().mockResolvedValue({ ok: true }),
      startMonitor: vi.fn().mockResolvedValue({}),
      getLevel: vi.fn().mockResolvedValue({}),
      stopMonitor: vi.fn().mockResolvedValue({ ok: true }),
      liveStart: vi.fn().mockResolvedValue({ ok: true }),
      liveMicStart: vi.fn().mockResolvedValue({ ok: true }),
      liveMicDrain: vi.fn().mockResolvedValue([]),
      liveMicStop: vi.fn().mockResolvedValue({ ok: true }),
      liveAudio: vi.fn(),
      liveStop: vi.fn().mockResolvedValue({ ok: true }),
      onPartial: vi.fn().mockReturnValue(() => {}),
      onFinal: vi.fn().mockReturnValue(() => {}),
      onSttError: vi.fn().mockReturnValue(() => {}),
    },
    dictation: {
      toggle: vi.fn().mockResolvedValue({ state: 'idle', elapsed: 0 }),
      stop: vi.fn().mockResolvedValue({ state: 'idle', elapsed: 0 }),
      getState: vi.fn().mockResolvedValue({ state: 'idle', elapsed: 0 }),
      setDevice: vi.fn().mockResolvedValue({ ok: true }),
      setOverlayInteractive: vi.fn(),
      resizeOverlay: vi.fn(),
      restoreOverlayFocus: vi.fn(),
      onStateChange: vi.fn().mockReturnValue(() => {}),
      onLevel: vi.fn().mockReturnValue(() => {}),
      onPartial: vi.fn().mockReturnValue(() => {}),
      onFinal: vi.fn().mockReturnValue(() => {}),
      onError: vi.fn().mockReturnValue(() => {}),
    },
    computerUse: {
      startSession: vi.fn().mockResolvedValue({}),
      pauseSession: vi.fn().mockResolvedValue({}),
      resumeSession: vi.fn().mockResolvedValue({}),
      stopSession: vi.fn().mockResolvedValue({}),
      approveAction: vi.fn().mockResolvedValue({}),
      rejectAction: vi.fn().mockResolvedValue({}),
      listSessions: vi.fn().mockResolvedValue([]),
      getSession: vi.fn().mockResolvedValue({}),
      setSurface: vi.fn().mockResolvedValue({}),
      sendGuidance: vi.fn().mockResolvedValue({}),
      updateSessionSettings: vi.fn().mockResolvedValue({}),
      continueSession: vi.fn().mockResolvedValue({}),
      markSessionsSeen: vi.fn().mockResolvedValue({}),
      openSetupWindow: vi.fn().mockResolvedValue({}),
      getLocalMacosPermissions: vi.fn().mockResolvedValue({}),
      requestLocalMacosPermissions: vi.fn().mockResolvedValue({}),
      requestSingleLocalMacosPermission: vi.fn().mockResolvedValue({}),
      openLocalMacosPrivacySettings: vi.fn().mockResolvedValue({ opened: null }),
      probeInputMonitoring: vi.fn().mockResolvedValue({ inputMonitoringGranted: false }),
      checkFullScreenApps: vi.fn().mockResolvedValue({ apps: [], problematicApps: [] }),
      exitFullScreenApps: vi.fn().mockResolvedValue({ exited: [], failed: [] }),
      listRunningApps: vi.fn().mockResolvedValue({ apps: [] }),
      listDisplays: vi.fn().mockResolvedValue({ displays: [] }),
      focusSession: vi.fn().mockResolvedValue({}),
      overlayMouseEnter: vi.fn(),
      overlayMouseLeave: vi.fn(),
      onEvent: vi.fn().mockReturnValue(() => {}),
      onOverlayState: vi.fn().mockReturnValue(() => {}),
      onFocusThread: vi.fn().mockReturnValue(() => {}),
    },
    onMenuOpenSettings: vi.fn().mockReturnValue(() => {}),
    onFind: vi.fn().mockReturnValue(() => {}),
    onModelSwitched: vi.fn().mockReturnValue(() => {}),
    onExecutionModeChanged: vi.fn().mockReturnValue(() => {}),
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ACTIVE_CONV_ID = 'conv-active';

/** Thin consumer that renders step-tracking context values as data-testid text nodes */
function StepTrackingConsumer() {
  const { stepInfo, showIncompleteTaskBanner, onContinueTask, onAdjustSettings, onDismissBanner } = useStepTracking();
  const activeConvId = useRuntimeConversationId();
  return (
    <div>
      <span data-testid="active-conv-id">{activeConvId ?? 'null'}</span>
      <span data-testid="current-step">{stepInfo?.currentStep ?? 'null'}</span>
      <span data-testid="max-steps">{stepInfo?.maxSteps ?? 'null'}</span>
      <span data-testid="hit-limit">{stepInfo?.hitLimit ? 'true' : 'false'}</span>
      <span data-testid="show-banner">{showIncompleteTaskBanner ? 'true' : 'false'}</span>
      <button data-testid="btn-continue" onClick={onContinueTask}>
        continue
      </button>
      <button data-testid="btn-adjust" onClick={onAdjustSettings}>
        adjust
      </button>
      <button data-testid="btn-dismiss" onClick={onDismissBanner}>
        dismiss
      </button>
    </div>
  );
}

function AllProviders({ children, conversationId = ACTIVE_CONV_ID }: { children: ReactNode; conversationId?: string }) {
  return (
    <AttachmentProvider>
      <RuntimeProvider conversationId={conversationId}>{children}</RuntimeProvider>
    </AttachmentProvider>
  );
}

/** Render and wait for the provider to finish its async setup */
async function renderWithProviders(conversationId = ACTIVE_CONV_ID) {
  const result = render(
    <AllProviders conversationId={conversationId}>
      <StepTrackingConsumer />
    </AllProviders>,
  );
  // Wait until the active conversation ID is loaded into context.
  // Use a longer timeout because under CI load the provider's async
  // mount sequence (load conv -> setActiveConversationId -> re-render
  // -> activeIdRef.current sync via useEffect) can take >1s.
  await waitFor(
    () => {
      expect(screen.getByTestId('active-conv-id').textContent).toBe(conversationId);
    },
    { timeout: 3000 },
  );
  // Also wait until the stream event subscription has been registered,
  // otherwise emitStreamEvent will silently no-op via optional chaining.
  await waitFor(
    () => {
      expect(streamEventCallback).not.toBeNull();
    },
    { timeout: 3000 },
  );
  return result;
}

/** Emit a stream event through the captured callback.
 *  Throws if the subscription was never registered, so flaky tests fail
 *  loudly instead of silently passing a no-op through optional chaining. */
async function emitStreamEvent(event: Record<string, unknown>) {
  if (!streamEventCallback) {
    throw new Error('emitStreamEvent called before provider subscribed to onStreamEvent');
  }
  await act(async () => {
    streamEventCallback?.(event);
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  streamEventCallback = null;
  _conversationsChangedCallback = null;
  mockStream.mockClear();
  (window as unknown as Record<string, unknown>).app = buildWindowApp();
  // Suppress expected console output
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  // Drain any stream accumulator for the active conversation before the
  // component unmounts (test-file afterEach runs before vitest.setup cleanup
  // in LIFO order, so streamEventCallback is still live here).
  // This prevents module-level streamAccumulators from leaking into the next
  // test and causing loadConversationState to see hasActiveStream=true.
  if (streamEventCallback) {
    act(() => {
      streamEventCallback?.({ conversationId: ACTIVE_CONV_ID, type: 'done' });
    });
  }
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).app;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RuntimeProvider - Step Tracking', () => {
  describe('step-progress event handling', () => {
    it('updates stepInfo state when step-progress event received', async () => {
      await renderWithProviders();

      expect(screen.getByTestId('current-step').textContent).toBe('null');

      await emitStreamEvent({
        conversationId: ACTIVE_CONV_ID,
        type: 'step-progress',
        stepInfo: { currentStep: 5, maxSteps: 25, hitLimit: false, taskComplete: false },
      });

      await waitFor(() => {
        expect(screen.getByTestId('current-step').textContent).toBe('5');
        expect(screen.getByTestId('max-steps').textContent).toBe('25');
        expect(screen.getByTestId('hit-limit').textContent).toBe('false');
      });
    });

    it('only updates stepInfo for active conversation', async () => {
      await renderWithProviders();

      await emitStreamEvent({
        conversationId: 'some-other-conv-id',
        type: 'step-progress',
        stepInfo: { currentStep: 10, maxSteps: 25, hitLimit: false, taskComplete: false },
      });

      // stepInfo should remain null — event was for a different conversation
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(screen.getByTestId('current-step').textContent).toBe('null');
    });
  });

  describe('max-steps-reached event handling', () => {
    it('shows incomplete task banner when limit reached', async () => {
      await renderWithProviders();

      expect(screen.getByTestId('show-banner').textContent).toBe('false');

      await emitStreamEvent({
        conversationId: ACTIVE_CONV_ID,
        type: 'max-steps-reached',
        stepInfo: { currentStep: 25, maxSteps: 25, hitLimit: true, taskComplete: false },
      });
      await waitFor(() => {
        expect(screen.getByTestId('show-banner').textContent).toBe('true');
        expect(screen.getByTestId('hit-limit').textContent).toBe('true');
        expect(screen.getByTestId('current-step').textContent).toBe('25');
      });
    });

    it('does not show banner if conversation dismissed', async () => {
      await renderWithProviders();

      // Dismiss the banner first via the callback
      act(() => {
        screen.getByTestId('btn-dismiss').click();
      });

      // Now receive max-steps-reached for the same conversation
      await emitStreamEvent({
        conversationId: ACTIVE_CONV_ID,
        type: 'max-steps-reached',
        stepInfo: { currentStep: 25, maxSteps: 25, hitLimit: true, taskComplete: false },
      });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      // Banner should remain hidden because this conversation was dismissed
      expect(screen.getByTestId('show-banner').textContent).toBe('false');
    });

    it('logs warning when max steps reached', async () => {
      await renderWithProviders();
      const warnSpy = vi.spyOn(console, 'warn');

      await emitStreamEvent({
        conversationId: ACTIVE_CONV_ID,
        type: 'max-steps-reached',
        stepInfo: { currentStep: 25, maxSteps: 25, hitLimit: true, taskComplete: false },
      });

      await waitFor(() => {
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MAX_STEPS'));
      });
    });
  });

  describe('handleContinueTask', () => {
    it('sends continuation message', async () => {
      await renderWithProviders();

      await emitStreamEvent({
        conversationId: ACTIVE_CONV_ID,
        type: 'max-steps-reached',
        stepInfo: { currentStep: 25, maxSteps: 25, hitLimit: true, taskComplete: false },
      });
      await waitFor(() => expect(screen.getByTestId('show-banner').textContent).toBe('true'));

      act(() => {
        screen.getByTestId('btn-continue').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('show-banner').textContent).toBe('false');
      });
      expect(mockStream).toHaveBeenCalledWith(
        ACTIVE_CONV_ID,
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.arrayContaining([
              expect.objectContaining({ type: 'text', text: 'Please continue the previous task' }),
            ]),
          }),
        ]),
        undefined,
        expect.any(String),
        undefined,
        expect.any(Boolean),
        undefined,
        expect.any(String),
        undefined,
        expect.stringMatching(/^msg-/),
      );

      const responseMessageId = mockStream.mock.calls.at(-1)?.[9] as string;
      await emitStreamEvent({
        conversationId: ACTIVE_CONV_ID,
        type: 'text-delta',
        text: 'Continuing now.',
        responseMessageId,
      });
      await emitStreamEvent({ conversationId: ACTIVE_CONV_ID, type: 'done', responseMessageId });

      await waitFor(() => {
        const persisted = mockPut.mock.calls
          .map((call) => call[0] as { messageTree?: Array<{ id: string; role: string }> })
          .find((conversation) =>
            conversation.messageTree?.some(
              (message) => message.id === responseMessageId && message.role === 'assistant',
            ),
          );
        expect(persisted).toBeDefined();
      });
    });

    it('hides banner and clears stepInfo', async () => {
      await renderWithProviders();

      await emitStreamEvent({
        conversationId: ACTIVE_CONV_ID,
        type: 'max-steps-reached',
        stepInfo: { currentStep: 25, maxSteps: 25, hitLimit: true, taskComplete: false },
      });
      await waitFor(() => expect(screen.getByTestId('show-banner').textContent).toBe('true'));

      act(() => {
        screen.getByTestId('btn-continue').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('show-banner').textContent).toBe('false');
        expect(screen.getByTestId('current-step').textContent).toBe('null');
      });
    });

    it('does not continue if already running', async () => {
      await renderWithProviders();

      // Trigger a text-delta so isRunning becomes true via the stream handler
      await emitStreamEvent({ conversationId: ACTIVE_CONV_ID, type: 'text-delta', text: 'hello' });
      await waitFor(() => expect(screen.getByTestId('show-banner').textContent).toBe('false'));

      const directStreamSpy = vi.fn().mockResolvedValue(undefined);
      if (window.app) {
        (window.app as unknown as Record<string, Record<string, unknown>>).agent.stream = directStreamSpy;
      }

      act(() => {
        screen.getByTestId('btn-continue').click();
      });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(directStreamSpy).not.toHaveBeenCalled();
    });
  });

  describe('handleAdjustSettings', () => {
    it('dispatches kai:open-settings event', async () => {
      await renderWithProviders();

      const openSettingsEvents: Event[] = [];
      const handler = (e: Event) => openSettingsEvents.push(e);
      window.addEventListener('kai:open-settings', handler);

      act(() => {
        screen.getByTestId('btn-adjust').click();
      });

      expect(openSettingsEvents).toHaveLength(1);
      window.removeEventListener('kai:open-settings', handler);
    });

    it('navigates to the max-turns setting synchronously', async () => {
      await renderWithProviders();

      const navigateEvents: Event[] = [];
      const handler = (e: Event) => navigateEvents.push(e);
      window.addEventListener('kai:navigate-settings', handler);

      act(() => {
        screen.getByTestId('btn-adjust').click();
      });

      expect(navigateEvents).toHaveLength(1);
      expect((navigateEvents[0] as CustomEvent).detail).toEqual({
        section: 'models',
        tab: 'runtimes',
        anchorId: 'agent.maxTurns',
      });

      window.removeEventListener('kai:navigate-settings', handler);
    });

    it('hides banner when called', async () => {
      await renderWithProviders();

      await emitStreamEvent({
        conversationId: ACTIVE_CONV_ID,
        type: 'max-steps-reached',
        stepInfo: { currentStep: 25, maxSteps: 25, hitLimit: true, taskComplete: false },
      });
      await waitFor(() => expect(screen.getByTestId('show-banner').textContent).toBe('true'));

      act(() => {
        screen.getByTestId('btn-adjust').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('show-banner').textContent).toBe('false');
      });
    });
  });

  describe('handleDismissBanner', () => {
    it('adds conversation to dismissed set', async () => {
      await renderWithProviders();

      // Show banner, dismiss it, then verify a new max-steps-reached doesn't show it again
      await emitStreamEvent({
        conversationId: ACTIVE_CONV_ID,
        type: 'max-steps-reached',
        stepInfo: { currentStep: 25, maxSteps: 25, hitLimit: true, taskComplete: false },
      });
      await waitFor(() => expect(screen.getByTestId('show-banner').textContent).toBe('true'));

      act(() => {
        screen.getByTestId('btn-dismiss').click();
      });
      await waitFor(() => expect(screen.getByTestId('show-banner').textContent).toBe('false'));

      // A second max-steps-reached should NOT re-show the banner
      await emitStreamEvent({
        conversationId: ACTIVE_CONV_ID,
        type: 'max-steps-reached',
        stepInfo: { currentStep: 25, maxSteps: 25, hitLimit: true, taskComplete: false },
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(screen.getByTestId('show-banner').textContent).toBe('false');
    });

    it('hides banner', async () => {
      await renderWithProviders();

      await emitStreamEvent({
        conversationId: ACTIVE_CONV_ID,
        type: 'max-steps-reached',
        stepInfo: { currentStep: 25, maxSteps: 25, hitLimit: true, taskComplete: false },
      });
      await waitFor(() => expect(screen.getByTestId('show-banner').textContent).toBe('true'));

      act(() => {
        screen.getByTestId('btn-dismiss').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('show-banner').textContent).toBe('false');
      });
    });

    it('logs dismissal', async () => {
      await renderWithProviders();
      const infoSpy = vi.spyOn(console, 'info');

      act(() => {
        screen.getByTestId('btn-dismiss').click();
      });

      await waitFor(() => {
        expect(infoSpy).toHaveBeenCalledWith(
          expect.stringContaining('banner dismissed'),
          expect.objectContaining({ conversationId: ACTIVE_CONV_ID }),
        );
      });
    });
  });

  describe('StepTrackingContext', () => {
    it('provides stepInfo to consumers', async () => {
      await renderWithProviders();

      await emitStreamEvent({
        conversationId: ACTIVE_CONV_ID,
        type: 'step-progress',
        stepInfo: { currentStep: 3, maxSteps: 10, hitLimit: false, taskComplete: false },
      });

      await waitFor(() => {
        expect(screen.getByTestId('current-step').textContent).toBe('3');
        expect(screen.getByTestId('max-steps').textContent).toBe('10');
      });
    });

    it('provides showIncompleteTaskBanner state', async () => {
      await renderWithProviders();

      expect(screen.getByTestId('show-banner').textContent).toBe('false');

      await emitStreamEvent({
        conversationId: ACTIVE_CONV_ID,
        type: 'max-steps-reached',
        stepInfo: { currentStep: 10, maxSteps: 10, hitLimit: true, taskComplete: false },
      });

      await waitFor(() => {
        expect(screen.getByTestId('show-banner').textContent).toBe('true');
      });
    });

    it('provides all callback functions', async () => {
      await renderWithProviders();

      expect(screen.getByTestId('btn-continue')).toBeInTheDocument();
      expect(screen.getByTestId('btn-adjust')).toBeInTheDocument();
      expect(screen.getByTestId('btn-dismiss')).toBeInTheDocument();
    });
  });
});

describe('Step Tracking - Integration', () => {
  it('full flow: receive event -> show banner -> continue -> hide banner', async () => {
    await renderWithProviders();

    // 1. Receive max-steps-reached
    await emitStreamEvent({
      conversationId: ACTIVE_CONV_ID,
      type: 'max-steps-reached',
      stepInfo: { currentStep: 25, maxSteps: 25, hitLimit: true, taskComplete: false },
    });
    await waitFor(() => {
      expect(screen.getByTestId('show-banner').textContent).toBe('true');
      expect(screen.getByTestId('hit-limit').textContent).toBe('true');
    });

    // 2. Continue task — banner hides and step info clears
    act(() => {
      screen.getByTestId('btn-continue').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('show-banner').textContent).toBe('false');
      expect(screen.getByTestId('current-step').textContent).toBe('null');
    });
    expect(mockStream).toHaveBeenCalledOnce();
  });

  it('full flow: receive event -> dismiss -> event again -> banner stays hidden', async () => {
    await renderWithProviders();

    // 1. Receive event, show banner
    await emitStreamEvent({
      conversationId: ACTIVE_CONV_ID,
      type: 'max-steps-reached',
      stepInfo: { currentStep: 25, maxSteps: 25, hitLimit: true, taskComplete: false },
    });
    await waitFor(() => expect(screen.getByTestId('show-banner').textContent).toBe('true'));

    // 2. Dismiss
    act(() => {
      screen.getByTestId('btn-dismiss').click();
    });
    await waitFor(() => expect(screen.getByTestId('show-banner').textContent).toBe('false'));

    // 3. Another event — banner must remain hidden
    await emitStreamEvent({
      conversationId: ACTIVE_CONV_ID,
      type: 'max-steps-reached',
      stepInfo: { currentStep: 25, maxSteps: 25, hitLimit: true, taskComplete: false },
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.getByTestId('show-banner').textContent).toBe('false');
  });

  it('progress indicator updates during streaming', async () => {
    await renderWithProviders();

    // Simulate step-by-step progress events
    for (let step = 1; step <= 5; step++) {
      await emitStreamEvent({
        conversationId: ACTIVE_CONV_ID,
        type: 'step-progress',
        stepInfo: { currentStep: step, maxSteps: 25, hitLimit: false, taskComplete: false },
      });
      await waitFor(() => {
        expect(screen.getByTestId('current-step').textContent).toBe(String(step));
      });
    }

    expect(screen.getByTestId('max-steps').textContent).toBe('25');
    expect(screen.getByTestId('show-banner').textContent).toBe('false');
  });
});
