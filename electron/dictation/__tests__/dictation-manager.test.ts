import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  type MockWindow = {
    destroyed: boolean;
    options: Record<string, unknown>;
    webContents: {
      session: { setPermissionRequestHandler: ReturnType<typeof vi.fn> };
      executeJavaScript: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    };
    loadFile: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
  };

  type NativeResponse = {
    ok?: boolean;
    typingMode?: 'ax' | 'kb' | 'idle';
    targetPid?: number | null;
    targetName?: string;
    targetBundleId?: string | null;
    capturedAt?: number;
    capturedAx?: boolean;
    partialText?: string;
    strategy?: 'disabled' | 'full-replacement' | 'ax-verified' | 'tail-only' | 'full-patch' | null;
    applied?: boolean;
  };

  type NativeOptions = {
    onTargetDirty?: (reason: string) => void;
    onExit?: (message: string) => void;
    onProtocolError?: (message: string) => void;
  };

  const state = {
    windows: [] as MockWindow[],
    browserWindowOptions: [] as Array<Record<string, unknown>>,
    recognizer: null as null | {
      recognizing?: (_sender: unknown, event: { result: { text?: string } }) => void;
      recognized?: (_sender: unknown, event: { result: { reason: number; text?: string } }) => void;
      canceled?: (_sender: unknown, event: { reason: number; errorCode: number; errorDetails?: string }) => void;
      startContinuousRecognitionAsync: ReturnType<typeof vi.fn>;
      stopContinuousRecognitionAsync: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    },
    pushStream: null as null | { write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> },
    targetPid: 4242 as number | null,
    beginResponse: {
      ok: true,
      typingMode: 'ax',
      targetPid: 4242,
      targetName: 'TextEdit',
      targetBundleId: 'com.apple.TextEdit',
      capturedAt: 1234,
      capturedAx: true,
      partialText: '',
      strategy: null,
      applied: false,
    } as NativeResponse,
    beginError: null as Error | null,
    refreshResponse: null as NativeResponse | null,
    applyPartialResponse: null as NativeResponse | null,
    applyFinalResponse: null as NativeResponse | null,
    takeoverMonitorParams: [] as Array<{
      onEvent: (event: { kind: 'mouse' | 'keyboard' | 'other'; eventType: string; keyCode?: number; x: number; y: number; timestampMs: number }) => void;
      onError?: (error: string) => void;
    }>,
  };

  const globalShortcut = {
    register: vi.fn(() => true),
    unregister: vi.fn(),
  };
  const ipcMain = {
    handle: vi.fn(),
  };
  const createDictationOverlay = vi.fn();
  const showDictationOverlay = vi.fn(async () => {});
  const hideDictationOverlay = vi.fn();
  const destroyDictationOverlay = vi.fn();
  const sendToOverlay = vi.fn();
  const getDictationTargetPid = vi.fn<() => number | null>(() => state.targetPid);
  const recaptureDictationTargetFocus = vi.fn(async () => true);
  const setDictationExternalFocusRefreshSuppressed = vi.fn();
  const setDictationTargetFocusSnapshot = vi.fn((snapshot: { pid?: number | null } | null) => {
    state.targetPid = snapshot?.pid ?? null;
  });
  const startLocalMacosTakeoverMonitor = vi.fn((params: (typeof state.takeoverMonitorParams)[number]) => {
    state.takeoverMonitorParams.push(params);
    return { stop: vi.fn() };
  });
  const runLocalMacMouseCommand = vi.fn(async () => ({ ok: true }));

  class DictationNativeSessionError extends Error {
    readonly errorCode?: string;

    constructor(message: string, errorCode?: string) {
      super(message);
      this.errorCode = errorCode;
    }
  }

  class DictationNativeSessionClient {
    static instances: DictationNativeSessionClient[] = [];
    readonly start = vi.fn(async () => {});
    readonly beginSession = vi.fn(async () => {
      if (state.beginError) throw state.beginError;
      return state.beginResponse;
    });
    // Main's dictation refactor renamed the production call from
    // `beginSession` to `beginSessionUnchecked`. Provide both on the mock
    // so the test works against whichever production source vitest ends
    // up loading (PR-head version with `beginSession`, or merge-with-main
    // version with `beginSessionUnchecked`).
    readonly beginSessionUnchecked = vi.fn(async () => {
      if (state.beginError) throw state.beginError;
      return state.beginResponse;
    });
    readonly startTargetTracking = vi.fn(async () => ({ ok: true }));
    readonly stopTargetTracking = vi.fn(async () => ({ ok: true }));
    readonly refreshTarget = vi.fn(async () => state.refreshResponse ?? {
      ...state.beginResponse,
      applied: false,
    });
    readonly applyPartial = vi.fn(async (text: string) => state.applyPartialResponse ?? {
      ...state.beginResponse,
      applied: true,
      partialText: text,
      strategy: state.beginResponse.typingMode === 'kb' ? 'full-patch' : 'full-replacement',
    });
    readonly applyFinal = vi.fn(async (text: string) => state.applyFinalResponse ?? {
      ...state.beginResponse,
      applied: true,
      partialText: '',
      strategy: null,
      text,
    });
    readonly endSession = vi.fn(async () => {});
    // Production cleanup path calls `close()` on the native session after
    // beginSessionUnchecked rejects (e.g. accessibility / secure-field
    // refusals). Stub it so the cleanup doesn't crash the test runner.
    readonly close = vi.fn(async () => {});
    readonly getTargetSnapshot = vi.fn((response: NativeResponse) => {
      if (!response.targetPid || !response.targetName) return null;
      return {
        appName: response.targetName,
        bundleId: response.targetBundleId ?? null,
        pid: response.targetPid,
        capturedAt: response.capturedAt ?? Date.now(),
      };
    });

    constructor(private readonly options: NativeOptions = {}) {
      DictationNativeSessionClient.instances.push(this);
    }

    emitTargetDirty(reason = 'keyboard:keyDown'): void {
      this.options.onTargetDirty?.(reason);
    }

    emitExit(message = 'helper exited'): void {
      this.options.onExit?.(message);
    }
  }

  class BrowserWindow {
    destroyed = false;
    options: Record<string, unknown>;
    webContents: MockWindow['webContents'];
    loadFile: MockWindow['loadFile'];
    close: MockWindow['close'];
    isDestroyed: MockWindow['isDestroyed'];

    constructor(options: Record<string, unknown>) {
      this.options = options;
      state.browserWindowOptions.push(options);
      this.webContents = {
        session: { setPermissionRequestHandler: vi.fn() },
        executeJavaScript: vi.fn(async (script: string) => {
          if (script.includes('startLiveStream')) return { ok: true, sampleRate: 16000 };
          if (script.includes('stopLiveStream')) return [];
          if (script.includes('drainLiveChunks')) return [];
          if (script.includes('getLevel')) return 0;
          return null;
        }),
        send: vi.fn(),
      };
      this.loadFile = vi.fn(async () => {});
      this.close = vi.fn(() => {
        this.destroyed = true;
      });
      this.isDestroyed = vi.fn(() => this.destroyed);
      state.windows.push(this as unknown as MockWindow);
    }

    static getAllWindows() {
      return state.windows;
    }
  }

  const reset = () => {
    state.windows = [];
    state.browserWindowOptions = [];
    state.recognizer = null;
    state.pushStream = null;
    state.targetPid = 4242;
    state.beginResponse = {
      ok: true,
      typingMode: 'ax',
      targetPid: 4242,
      targetName: 'TextEdit',
      targetBundleId: 'com.apple.TextEdit',
      capturedAt: 1234,
      capturedAx: true,
      partialText: '',
      strategy: null,
      applied: false,
    };
    state.beginError = null;
    state.refreshResponse = null;
    state.applyPartialResponse = null;
    state.applyFinalResponse = null;
    state.takeoverMonitorParams = [];
    DictationNativeSessionClient.instances = [];
    globalShortcut.register.mockClear().mockReturnValue(true);
    globalShortcut.unregister.mockClear();
    ipcMain.handle.mockClear();
    createDictationOverlay.mockClear();
    showDictationOverlay.mockClear();
    hideDictationOverlay.mockClear();
    destroyDictationOverlay.mockClear();
    sendToOverlay.mockClear();
    getDictationTargetPid.mockClear();
    getDictationTargetPid.mockImplementation(() => state.targetPid);
    recaptureDictationTargetFocus.mockClear().mockResolvedValue(true);
    setDictationExternalFocusRefreshSuppressed.mockClear();
    setDictationTargetFocusSnapshot.mockClear();
    startLocalMacosTakeoverMonitor.mockClear();
    runLocalMacMouseCommand.mockClear();
  };

  return {
    state,
    BrowserWindow,
    globalShortcut,
    ipcMain,
    createDictationOverlay,
    showDictationOverlay,
    hideDictationOverlay,
    destroyDictationOverlay,
    sendToOverlay,
    getDictationTargetPid,
    recaptureDictationTargetFocus,
    setDictationExternalFocusRefreshSuppressed,
    setDictationTargetFocusSnapshot,
    startLocalMacosTakeoverMonitor,
    runLocalMacMouseCommand,
    DictationNativeSessionClient,
    DictationNativeSessionError,
    reset,
  };
});

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));

vi.mock('electron', () => ({
  BrowserWindow: mocks.BrowserWindow,
  globalShortcut: mocks.globalShortcut,
  ipcMain: mocks.ipcMain,
  // Minimal `app` shape so transitive imports (computer-use, plugins,
  // utils/user-agent, ...) don't fail with `No "app" export defined on
  // the "electron" mock`. The dictation manager itself doesn't reference
  // these, but the production code path reaches into permissions.js
  // which does.
  app: {
    getName: vi.fn(() => 'Kai'),
    getVersion: vi.fn(() => '0.0.0-test'),
    getPath: vi.fn(() => '/tmp/kai-test'),
    isReady: vi.fn(() => true),
    isPackaged: false,
    focus: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
  },
  systemPreferences: {
    isTrustedAccessibilityClient: vi.fn(() => true),
    getMediaAccessStatus: vi.fn(() => 'granted'),
  },
  shell: { openExternal: vi.fn() },
  screen: { getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })) },
  Notification: vi.fn(),
  safeStorage: { isEncryptionAvailable: vi.fn(() => false), encryptString: vi.fn(), decryptString: vi.fn() },
  session: { defaultSession: {} },
  net: { fetch: vi.fn() },
  nativeImage: { createEmpty: vi.fn(() => ({})) },
  dialog: {},
}));

vi.mock('microsoft-cognitiveservices-speech-sdk', () => ({
  SpeechConfig: {
    fromSubscription: vi.fn(() => ({ setProperty: vi.fn(), speechRecognitionLanguage: '' })),
    fromEndpoint: vi.fn(() => ({ setProperty: vi.fn(), speechRecognitionLanguage: '' })),
    fromHost: vi.fn(() => ({ setProperty: vi.fn(), speechRecognitionLanguage: '' })),
  },
  PropertyId: { Speech_SegmentationSilenceTimeoutMs: 'Speech_SegmentationSilenceTimeoutMs' },
  AudioStreamFormat: { getWaveFormatPCM: vi.fn(() => ({})) },
  AudioInputStream: {
    createPushStream: vi.fn(() => {
      mocks.state.pushStream = { write: vi.fn(), close: vi.fn() };
      return mocks.state.pushStream;
    }),
  },
  AudioConfig: { fromStreamInput: vi.fn(() => ({})) },
  SpeechRecognizer: vi.fn().mockImplementation(function SpeechRecognizer() {
    const recognizer = {
      startContinuousRecognitionAsync: vi.fn((resolve: () => void) => resolve()),
      stopContinuousRecognitionAsync: vi.fn((resolve: () => void) => resolve()),
      close: vi.fn(),
    };
    mocks.state.recognizer = recognizer;
    return recognizer;
  }),
  ResultReason: { RecognizedSpeech: 1 },
  CancellationReason: { Error: 1, 1: 'Error' },
  CancellationErrorCode: { 1: 'ConnectionFailure' },
}));

vi.mock('ai', () => ({ generateText: vi.fn() }));
vi.mock('../../agent/language-model.js', () => ({ createLanguageModelFromConfig: vi.fn() }));
vi.mock('../../agent/model-catalog.js', () => ({ resolveModelCatalog: vi.fn(() => ({ defaultEntry: null })) }));
vi.mock('../../computer-use/permissions.js', () => ({ runLocalMacMouseCommand: mocks.runLocalMacMouseCommand }));
vi.mock('../../computer-use/harnesses/local-macos.js', () => ({
  startLocalMacosTakeoverMonitor: mocks.startLocalMacosTakeoverMonitor,
}));
vi.mock('../dictation-overlay.js', () => ({
  createDictationOverlay: mocks.createDictationOverlay,
  showDictationOverlay: mocks.showDictationOverlay,
  hideDictationOverlay: mocks.hideDictationOverlay,
  destroyDictationOverlay: mocks.destroyDictationOverlay,
  sendToOverlay: mocks.sendToOverlay,
}));
vi.mock('../focus-preserver.js', () => ({
  clearDictationTargetFocus: vi.fn(),
  getDictationTargetPid: mocks.getDictationTargetPid,
  // Production dictation-manager reads the target app name + bundle id when
  // building the native session config payload. Deterministic stubs keep the
  // unit suite from depending on real focus-tracking state.
  getDictationTargetAppName: vi.fn(() => 'TextEdit'),
  getDictationTargetBundleId: vi.fn(() => 'com.apple.TextEdit'),
  recaptureDictationTargetFocus: mocks.recaptureDictationTargetFocus,
  setDictationExternalFocusRefreshSuppressed: mocks.setDictationExternalFocusRefreshSuppressed,
  setDictationTargetFocusSnapshot: mocks.setDictationTargetFocusSnapshot,
}));
vi.mock('../native-session-client.js', () => ({
  DictationNativeSessionClient: mocks.DictationNativeSessionClient,
  DictationNativeSessionError: mocks.DictationNativeSessionError,
}));

function createConfig() {
  return {
    dictation: {
      enabled: true,
      hotkey: 'CommandOrControl+Shift+D',
      mode: 'toggle',
      language: 'en-US',
      livePartials: true,
      partialTyping: { ax: 'full-replacement', kb: 'disabled' },
    },
    audio: {
      azure: { subscriptionKey: 'test-key', region: 'eastus' },
    },
    models: { providers: {}, catalog: [] },
  };
}

describe('dictation manager native session lifecycle', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal('__BRAND_PRODUCT_NAME', 'Kai');
    vi.stubGlobal('__BRAND_APP_SLUG', 'kai');
    mocks.reset();
  });

  it('fails closed before recording when native Accessibility verification fails', async () => {
    const manager = await import('../dictation-manager.js');
    mocks.state.beginError = new mocks.DictationNativeSessionError(
      'Dictation requires macOS Accessibility permission before it can type safely.',
      'accessibility',
    );

    manager.initDictation(createConfig() as never);
    await manager.toggleDictation();

    expect(manager.getDictationState().state).toBe('idle');
    expect(mocks.showDictationOverlay).not.toHaveBeenCalled();
    expect(mocks.state.browserWindowOptions).toHaveLength(0);
    expect(mocks.sendToOverlay).toHaveBeenCalledWith(
      'dictation:error',
      expect.stringContaining('Accessibility permission'),
    );
  });

  it('rejects secure fields before recording', async () => {
    const manager = await import('../dictation-manager.js');
    mocks.state.beginError = new mocks.DictationNativeSessionError(
      'Dictation will not type into secure text fields.',
      'secure_field',
    );

    manager.initDictation(createConfig() as never);
    await manager.toggleDictation();

    expect(manager.getDictationState().state).toBe('idle');
    expect(mocks.showDictationOverlay).not.toHaveBeenCalled();
    expect(mocks.sendToOverlay).toHaveBeenCalledWith(
      'dictation:error',
      expect.stringContaining('secure text fields'),
    );
  });

  it('starts a verified AX target through the native session', async () => {
    const manager = await import('../dictation-manager.js');

    manager.initDictation(createConfig() as never);
    await manager.toggleDictation();

    const native = mocks.DictationNativeSessionClient.instances[0];
    expect(manager.getDictationState().state).toBe('active');
    expect(native.start).toHaveBeenCalled();
    expect(native.beginSessionUnchecked).toHaveBeenCalledWith(expect.objectContaining({
      allowBlindKeyboardFullPatch: false,
      ownAppName: expect.any(String),
      ownPid: expect.any(Number),
    }));
    expect(mocks.setDictationTargetFocusSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      pid: 4242,
      appName: 'TextEdit',
    }));
    expect(mocks.showDictationOverlay).toHaveBeenCalledWith({ skipFocusCapture: true });
    expect(native.startTargetTracking).toHaveBeenCalled();
    expect(mocks.sendToOverlay).toHaveBeenCalledWith('dictation:typing-mode', 'ax');
  });

  it('starts in unreadable AX targets when KB full-patch is enabled', async () => {
    const manager = await import('../dictation-manager.js');
    const config = createConfig();
    config.dictation.partialTyping = { ax: 'disabled', kb: 'full-patch' };
    mocks.state.beginResponse = {
      ...mocks.state.beginResponse,
      typingMode: 'kb',
      capturedAx: false,
    };

    manager.initDictation(config as never);
    await manager.toggleDictation();

    const native = mocks.DictationNativeSessionClient.instances[0];
    expect(manager.getDictationState().state).toBe('active');
    expect(native.beginSessionUnchecked).toHaveBeenCalledWith(expect.objectContaining({
      allowBlindKeyboardFullPatch: true,
    }));
    expect(mocks.sendToOverlay).toHaveBeenCalledWith('dictation:typing-mode', 'kb');
  });

  it('sends live partials and cleaned finals to the native session', async () => {
    const manager = await import('../dictation-manager.js');

    manager.initDictation(createConfig() as never);
    await manager.toggleDictation();
    const native = mocks.DictationNativeSessionClient.instances[0];

    mocks.state.recognizer?.recognizing?.(null, {
      result: { text: 'hello wor' },
    });

    await vi.waitFor(() => {
      expect(native.applyPartial).toHaveBeenCalledWith('hello wor');
    });

    mocks.state.recognizer?.recognized?.(null, {
      result: { reason: 1, text: 'hello world' },
    } as never);

    await vi.waitFor(() => {
      expect(native.applyFinal).toHaveBeenCalledWith('hello world ');
    });
  });

  it('refreshes the native target snapshot from target-dirty events', async () => {
    const manager = await import('../dictation-manager.js');
    mocks.state.refreshResponse = {
      ...mocks.state.beginResponse,
      targetPid: 7777,
      targetName: 'Notes',
      targetBundleId: 'com.apple.Notes',
      capturedAx: true,
    };

    manager.initDictation(createConfig() as never);
    await manager.toggleDictation();
    const native = mocks.DictationNativeSessionClient.instances[0];

    native.emitTargetDirty('keyboard:keyDown');

    await vi.waitFor(() => {
      expect(native.refreshTarget).toHaveBeenCalled();
    });
    expect(mocks.setDictationTargetFocusSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      pid: 7777,
      appName: 'Notes',
    }));
  });

  it('stops safely when the native helper exits mid-session', async () => {
    const manager = await import('../dictation-manager.js');

    manager.initDictation(createConfig() as never);
    await manager.toggleDictation();
    const native = mocks.DictationNativeSessionClient.instances[0];

    native.emitExit('helper crashed');

    await vi.waitFor(() => {
      expect(manager.getDictationState().state).toBe('idle');
    });
    expect(mocks.sendToOverlay).toHaveBeenCalledWith(
      'dictation:error',
      expect.stringContaining('native helper stopped unexpectedly'),
    );
    expect(native.endSession).toHaveBeenCalled();
  });

  it('keeps hold-mode release monitoring on the existing separate monitor', async () => {
    const manager = await import('../dictation-manager.js');
    const config = createConfig();
    config.dictation.mode = 'hold';

    manager.initDictation(config as never);
    const registered = (mocks.globalShortcut.register.mock.calls[0] as unknown[])[1] as () => void;
    registered();

    await vi.waitFor(() => {
      expect(manager.getDictationState().state).toBe('active');
    });
    expect(mocks.startLocalMacosTakeoverMonitor).toHaveBeenCalled();
  });
});
