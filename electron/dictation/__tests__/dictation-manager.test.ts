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

  const state = {
    windows: [] as MockWindow[],
    browserWindowOptions: [] as Array<Record<string, unknown>>,
    accessibilityTrusted: true,
      recognizer: null as null | {
      recognizing?: (_sender: unknown, event: { result: { text?: string } }) => void;
      recognized?: (_sender: unknown, event: { result: { reason: number; text?: string } }) => void;
      canceled?: (_sender: unknown, event: { reason: number; errorCode: number; errorDetails?: string }) => void;
      startContinuousRecognitionAsync: ReturnType<typeof vi.fn>;
      stopContinuousRecognitionAsync: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    },
    pushStream: null as null | { write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> },
    focusedTextSelection: {
      ok: true,
      selectedTextRangeLocation: 0,
      selectedTextRangeLength: 0,
      elementSignature: 'role=QVhUZXh0RmllbGQ=|x=10|y=10|w=200',
    } as Record<string, unknown>,
    focusedTextRangeState: null as null | Record<string, unknown>,
    focusedTextRangeStateResponses: [] as Array<Record<string, unknown>>,
    focusedTextSelectionError: null as string | null,
    focusedTextSelectionResponses: [] as Array<Record<string, unknown>>,
    frontmostPid: null as number | null,
    enforceReadFrontmostGuard: true,
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
  const showDictationOverlay = vi.fn(async () => {});
  const hideDictationOverlay = vi.fn();
  const destroyDictationOverlay = vi.fn();
  const sendToOverlay = vi.fn();
  const getDictationTargetPid = vi.fn<() => number | null>(() => 4242);
  const recaptureDictationTargetFocus = vi.fn(async () => true);
  const startLocalMacosTakeoverMonitor = vi.fn((params: (typeof state.takeoverMonitorParams)[number]) => {
    state.takeoverMonitorParams.push(params);
    return { stop: vi.fn() };
  });
  const runLocalMacMouseCommand = vi.fn(async (args: string[]) => {
    if (args[0] === 'permissions') {
      return { ok: true, accessibilityTrusted: state.accessibilityTrusted };
    }
    if (args[0] === 'focusedTextSelection') {
      const requestedPid = args[1] ? Number(args[1]) : null;
      const frontmostPid = state.frontmostPid ?? getDictationTargetPid();
      if (state.enforceReadFrontmostGuard && requestedPid != null && requestedPid !== frontmostPid) {
        throw new Error('Frontmost application no longer matches dictation target');
      }
      if (state.focusedTextSelectionError) {
        throw new Error(state.focusedTextSelectionError);
      }
      if (state.focusedTextSelectionResponses.length > 0) {
        return state.focusedTextSelectionResponses.shift()!;
      }
      return state.focusedTextSelection;
    }
    if (args[0] === 'focusedTextRangeState') {
      const requestedPid = args[3] ? Number(args[3]) : null;
      const frontmostPid = state.frontmostPid ?? getDictationTargetPid();
      if (state.enforceReadFrontmostGuard && requestedPid != null && requestedPid !== frontmostPid) {
        throw new Error('Frontmost application no longer matches dictation target');
      }
      if (state.focusedTextRangeStateResponses.length > 0) {
        return state.focusedTextRangeStateResponses.shift()!;
      }
      if (state.focusedTextRangeState) {
        return state.focusedTextRangeState;
      }
      return {
        selectedTextRangeLocation: state.focusedTextSelection.selectedTextRangeLocation,
        selectedTextRangeLength: state.focusedTextSelection.selectedTextRangeLength,
        elementSignature: state.focusedTextSelection.elementSignature,
        rangeText: '',
        textUtf16Length: 0,
      };
    }
    return { ok: true };
  });

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
    state.accessibilityTrusted = true;
    state.recognizer = null;
    state.pushStream = null;
    state.focusedTextSelection = {
      ok: true,
      selectedTextRangeLocation: 0,
      selectedTextRangeLength: 0,
      elementSignature: 'role=QVhUZXh0RmllbGQ=|x=10|y=10|w=200',
    };
    state.focusedTextRangeState = null;
    state.focusedTextRangeStateResponses = [];
    state.focusedTextSelectionError = null;
    state.focusedTextSelectionResponses = [];
    state.frontmostPid = null;
    state.enforceReadFrontmostGuard = true;
    state.takeoverMonitorParams = [];
    globalShortcut.register.mockClear().mockReturnValue(true);
    globalShortcut.unregister.mockClear();
    ipcMain.handle.mockClear();
    showDictationOverlay.mockClear();
    hideDictationOverlay.mockClear();
    destroyDictationOverlay.mockClear();
    sendToOverlay.mockClear();
    getDictationTargetPid.mockClear();
    getDictationTargetPid.mockReturnValue(4242);
    recaptureDictationTargetFocus.mockClear();
    recaptureDictationTargetFocus.mockResolvedValue(true);
    startLocalMacosTakeoverMonitor.mockClear();
    runLocalMacMouseCommand.mockClear();
  };

  return {
    state,
    BrowserWindow,
    globalShortcut,
    ipcMain,
    showDictationOverlay,
    hideDictationOverlay,
    destroyDictationOverlay,
    sendToOverlay,
    getDictationTargetPid,
    recaptureDictationTargetFocus,
    startLocalMacosTakeoverMonitor,
    runLocalMacMouseCommand,
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
  showDictationOverlay: mocks.showDictationOverlay,
  hideDictationOverlay: mocks.hideDictationOverlay,
  destroyDictationOverlay: mocks.destroyDictationOverlay,
  sendToOverlay: mocks.sendToOverlay,
}));
vi.mock('../focus-preserver.js', () => ({
  getDictationTargetPid: mocks.getDictationTargetPid,
  recaptureDictationTargetFocus: mocks.recaptureDictationTargetFocus,
}));

function createConfig() {
  return {
    dictation: {
      enabled: true,
      hotkey: 'CommandOrControl+Shift+D',
      mode: 'toggle',
      inputDeviceId: null,
      vadSilenceDurationMs: 850,
      finalCleanupEnabled: false,
      livePartials: false,
      partialTyping: { ax: 'disabled', kb: 'disabled' },
    },
    audio: {
      azure: { region: 'eastus', subscriptionKey: 'test-key', sttLanguage: 'en-US' },
      recording: { language: 'en-US' },
    },
    models: { providers: {}, catalog: [] },
    realtime: {},
  };
}

describe('dictation manager lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('__BRAND_APP_SLUG', 'kai');
    mocks.reset();
  });

  it('isolates the hidden recorder session from the main Electron session', async () => {
    const manager = await import('../dictation-manager.js');

    manager.initDictation(createConfig() as never);
    await manager.toggleDictation();

    expect(mocks.state.browserWindowOptions[0]).toMatchObject({
      webPreferences: {
        partition: 'kai-dictation-recorder',
      },
    });

    await manager.toggleDictation();
  });

  it('tears the session down when Azure STT cancels with an error', async () => {
    const manager = await import('../dictation-manager.js');

    manager.initDictation(createConfig() as never);
    await manager.toggleDictation();
    expect(manager.getDictationState().state).toBe('active');

    mocks.state.recognizer?.canceled?.(null, {
      reason: 1,
      errorCode: 1,
      errorDetails: 'do not expose this detail',
    });

    await vi.waitFor(() => {
      expect(manager.getDictationState().state).toBe('idle');
    });
    expect(mocks.hideDictationOverlay).toHaveBeenCalled();
  });

  it('fails closed when the focused target app cannot be identified', async () => {
    const manager = await import('../dictation-manager.js');
    mocks.getDictationTargetPid.mockReturnValue(null);

    manager.initDictation(createConfig() as never);
    await manager.toggleDictation();

    expect(manager.getDictationState().state).toBe('idle');
    expect(mocks.state.browserWindowOptions).toHaveLength(0);
    expect(mocks.sendToOverlay).toHaveBeenCalledWith(
      'dictation:error',
      expect.stringContaining('target app'),
    );
  });

  it('fails closed before recording when Accessibility is not trusted', async () => {
    const manager = await import('../dictation-manager.js');
    mocks.state.accessibilityTrusted = false;

    manager.initDictation(createConfig() as never);
    await manager.toggleDictation();

    expect(manager.getDictationState().state).toBe('idle');
    expect(mocks.state.browserWindowOptions).toHaveLength(0);
    expect(mocks.sendToOverlay).toHaveBeenCalledWith(
      'dictation:error',
      expect.stringContaining('Accessibility permission'),
    );
  });

  it('fails closed before recording when the target cursor cannot be verified', async () => {
    const manager = await import('../dictation-manager.js');
    mocks.state.focusedTextSelection = {
      ok: true,
      selectedTextRangeLocation: 0,
      selectedTextRangeLength: 0,
      elementSignature: '',
    };

    manager.initDictation(createConfig() as never);
    await manager.toggleDictation();

    expect(manager.getDictationState().state).toBe('idle');
    expect(mocks.state.browserWindowOptions).toHaveLength(0);
    expect(mocks.runLocalMacMouseCommand).not.toHaveBeenCalledWith(
      expect.arrayContaining(['postText']),
    );
    expect(mocks.sendToOverlay).toHaveBeenCalledWith(
      'dictation:error',
      expect.stringContaining('cursor or selection'),
    );
  });

  it('starts in an unreadable AX target when KB full-patch is explicitly enabled', async () => {
    const manager = await import('../dictation-manager.js');
    const config = createConfig();
    config.dictation.partialTyping = { ax: 'disabled', kb: 'full-patch' };
    mocks.state.focusedTextSelection = {
      ok: true,
      selectedTextRangeLocation: 0,
      selectedTextRangeLength: 0,
      elementSignature: '',
    };

    manager.initDictation(config as never);
    await manager.toggleDictation();

    expect(manager.getDictationState().state).toBe('active');
    mocks.state.recognizer?.recognizing?.(null, {
      result: { text: 'blind kx' },
    });

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'postText',
        Buffer.from('blind kx', 'utf-8').toString('base64'),
        '4242',
        '--allow-unverified-keyboard',
      ]));
    });
    expect(mocks.sendToOverlay).not.toHaveBeenCalledWith(
      'dictation:error',
      expect.stringContaining('cursor or selection'),
    );
  });

  it('still refuses a secure AX target when KB full-patch is explicitly enabled', async () => {
    const manager = await import('../dictation-manager.js');
    const config = createConfig();
    config.dictation.partialTyping = { ax: 'disabled', kb: 'full-patch' };
    mocks.state.focusedTextSelectionError = 'Focused target is a secure text field';

    manager.initDictation(config as never);
    await manager.toggleDictation();

    expect(manager.getDictationState().state).toBe('idle');
    expect(mocks.runLocalMacMouseCommand).not.toHaveBeenCalledWith(
      expect.arrayContaining(['postText']),
    );
    expect(mocks.sendToOverlay).toHaveBeenCalledWith(
      'dictation:error',
      expect.stringContaining('secure text fields'),
    );
  });

  it('retargets a final transcript to the currently focused app when no live partial was typed', async () => {
    const manager = await import('../dictation-manager.js');
    mocks.getDictationTargetPid.mockReturnValue(1111);

    manager.initDictation(createConfig() as never);
    await manager.toggleDictation();
    expect(manager.getDictationState().state).toBe('active');

    mocks.recaptureDictationTargetFocus.mockImplementationOnce(async () => {
      mocks.state.frontmostPid = 2222;
      mocks.getDictationTargetPid.mockReturnValue(2222);
      mocks.state.focusedTextSelection = {
        ok: true,
        selectedTextRangeLocation: 7,
        selectedTextRangeLength: 0,
        elementSignature: 'role=QVhUZXh0QXJlYQ==|x=30|y=40|w=300',
      };
      return true;
    });

    mocks.state.recognizer?.recognized?.(null, {
      result: { reason: 1, text: 'hello notes' },
    } as never);

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'replaceTextAtomically',
        '7',
        '0',
        Buffer.from('hello notes ', 'utf-8').toString('base64'),
        '2222',
        Buffer.from('role=QVhUZXh0QXJlYQ==|x=30|y=40|w=300', 'utf-8').toString('base64'),
      ]));
    });
    expect(mocks.sendToOverlay).not.toHaveBeenCalledWith(
      'dictation:error',
      expect.stringContaining('could not safely type'),
    );
  });

  it('retargets the first live partial after switching apps before any partial was typed', async () => {
    const manager = await import('../dictation-manager.js');
    const config = createConfig();
    config.dictation.partialTyping = { ax: 'full-replacement', kb: 'disabled' };
    mocks.getDictationTargetPid.mockReturnValue(1111);

    manager.initDictation(config as never);
    await manager.toggleDictation();
    expect(manager.getDictationState().state).toBe('active');

    mocks.state.frontmostPid = 2222;
    mocks.recaptureDictationTargetFocus.mockImplementationOnce(async () => {
      mocks.getDictationTargetPid.mockReturnValue(2222);
      mocks.state.focusedTextSelection = {
        ok: true,
        selectedTextRangeLocation: 9,
        selectedTextRangeLength: 0,
        elementSignature: 'role=QVhUZXh0QXJlYQ==|x=80|y=90|w=300',
      };
      return true;
    });

    mocks.state.recognizer?.recognizing?.(null, {
      result: { text: 'first partial' },
    });

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'replaceTextAtomically',
        '9',
        '0',
        Buffer.from('first partial', 'utf-8').toString('base64'),
        '2222',
        Buffer.from('role=QVhUZXh0QXJlYQ==|x=80|y=90|w=300', 'utf-8').toString('base64'),
      ]));
    });
    expect(mocks.recaptureDictationTargetFocus).toHaveBeenCalled();
  });

  it('absorbs an AX-selected autocomplete suffix after the first partial', async () => {
    const manager = await import('../dictation-manager.js');
    const config = createConfig();
    const elementSignature = 'role=QVhUZXh0RmllbGQ=|x=80|y=90|w=300';
    config.dictation.partialTyping = { ax: 'full-replacement', kb: 'full-patch' };
    mocks.state.focusedTextSelection = {
      ok: true,
      selectedTextRangeLocation: 0,
      selectedTextRangeLength: 0,
      elementSignature,
    };

    manager.initDictation(config as never);
    await manager.toggleDictation();
    expect(manager.getDictationState().state).toBe('active');

    mocks.state.recognizer?.recognizing?.(null, {
      result: { text: 'open' },
    });

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'replaceTextAtomically',
        '0',
        '0',
        Buffer.from('open', 'utf-8').toString('base64'),
        '4242',
        Buffer.from(elementSignature, 'utf-8').toString('base64'),
      ]));
    });

    mocks.state.focusedTextSelection = {
      ok: true,
      selectedTextRangeLocation: 4,
      selectedTextRangeLength: 11,
      elementSignature,
    };
    mocks.state.focusedTextRangeState = {
      selectedTextRangeLocation: 4,
      selectedTextRangeLength: 11,
      elementSignature,
      rangeText: 'open',
      textUtf16Length: 15,
    };

    mocks.state.recognizer?.recognizing?.(null, {
      result: { text: 'open settings' },
    });

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'replaceTextAtomically',
        '0',
        '15',
        Buffer.from('open settings', 'utf-8').toString('base64'),
        '4242',
        Buffer.from(elementSignature, 'utf-8').toString('base64'),
      ]));
    });
    expect(mocks.runLocalMacMouseCommand).not.toHaveBeenCalledWith(expect.arrayContaining([
      '--allow-unverified-keyboard',
    ]));
    expect(mocks.sendToOverlay).not.toHaveBeenCalledWith(
      'dictation:error',
      expect.stringContaining('could not safely type'),
    );
  });

  it('uses blind KB full-patch after switching from AX to an unreadable target before the first live partial', async () => {
    const manager = await import('../dictation-manager.js');
    const config = createConfig();
    config.dictation.partialTyping = { ax: 'full-replacement', kb: 'full-patch' };
    mocks.getDictationTargetPid.mockReturnValue(1111);

    manager.initDictation(config as never);
    await manager.toggleDictation();
    expect(manager.getDictationState().state).toBe('active');

    mocks.recaptureDictationTargetFocus.mockImplementation(async () => {
      mocks.state.frontmostPid = 2222;
      mocks.getDictationTargetPid.mockReturnValue(2222);
      mocks.state.focusedTextSelection = {
        ok: true,
        selectedTextRangeLocation: 0,
        selectedTextRangeLength: 0,
        elementSignature: '',
      };
      return true;
    });

    mocks.state.recognizer?.recognizing?.(null, {
      result: { text: 'switched target' },
    });

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'postText',
        Buffer.from('switched target', 'utf-8').toString('base64'),
        '2222',
        '--allow-unverified-keyboard',
      ]));
    });
    expect(mocks.sendToOverlay).not.toHaveBeenCalledWith(
      'dictation:error',
      expect.stringContaining('could not safely type'),
    );
  });

  it('uses AX when a target refresh captures AX before the first post-switch partial', async () => {
    const manager = await import('../dictation-manager.js');
    const config = createConfig();
    const elementSignature = 'role=QVhUZXh0QXJlYQ==|x=80|y=90|w=300';
    config.dictation.partialTyping = { ax: 'full-replacement', kb: 'full-patch' };
    mocks.getDictationTargetPid.mockReturnValue(1111);
    mocks.state.focusedTextSelection = {
      ok: true,
      selectedTextRangeLocation: 0,
      selectedTextRangeLength: 0,
      elementSignature: '',
    };

    manager.initDictation(config as never);
    await manager.toggleDictation();
    expect(manager.getDictationState().state).toBe('active');

    mocks.recaptureDictationTargetFocus.mockImplementation(async () => {
      mocks.state.frontmostPid = 2222;
      mocks.getDictationTargetPid.mockReturnValue(2222);
      return true;
    });
    mocks.state.focusedTextSelectionResponses.push(
      {
        ok: true,
        selectedTextRangeLocation: 0,
        selectedTextRangeLength: 0,
        elementSignature: '',
      },
      {
        ok: true,
        selectedTextRangeLocation: 12,
        selectedTextRangeLength: 0,
        elementSignature,
      },
      {
        ok: true,
        selectedTextRangeLocation: 12,
        selectedTextRangeLength: 0,
        elementSignature,
      },
    );

    mocks.state.recognizer?.recognizing?.(null, {
      result: { text: 'now ax' },
    });

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'replaceTextAtomically',
        '12',
        '0',
        Buffer.from('now ax', 'utf-8').toString('base64'),
        '2222',
        Buffer.from(elementSignature, 'utf-8').toString('base64'),
      ]));
    });
    expect(mocks.runLocalMacMouseCommand).not.toHaveBeenCalledWith(expect.arrayContaining([
      '--allow-unverified-keyboard',
    ]));
    expect(mocks.sendToOverlay).toHaveBeenCalledWith('dictation:typing-mode', 'ax');
  });

  it('keeps stale first partials from typing after a target refresh', async () => {
    const manager = await import('../dictation-manager.js');
    const config = createConfig();
    const elementSignature = 'role=QVhUZXh0QXJlYQ==|x=80|y=90|w=300';
    config.dictation.partialTyping = { ax: 'full-replacement', kb: 'full-patch' };
    mocks.getDictationTargetPid.mockReturnValue(1111);
    mocks.state.focusedTextSelection = {
      ok: true,
      selectedTextRangeLocation: 0,
      selectedTextRangeLength: 0,
      elementSignature: '',
    };

    manager.initDictation(config as never);
    await manager.toggleDictation();
    expect(manager.getDictationState().state).toBe('active');

    let recaptureCount = 0;
    mocks.recaptureDictationTargetFocus.mockImplementation(async () => {
      recaptureCount++;
      mocks.state.frontmostPid = 2222;
      mocks.getDictationTargetPid.mockReturnValue(2222);
      if (recaptureCount === 1) {
        queueMicrotask(() => {
          mocks.state.recognizer?.recognizing?.(null, {
            result: { text: 'now ax' },
          });
        });
      }
      return true;
    });
    mocks.state.focusedTextSelectionResponses.push(
      {
        ok: true,
        selectedTextRangeLocation: 0,
        selectedTextRangeLength: 0,
        elementSignature: '',
      },
      {
        ok: true,
        selectedTextRangeLocation: 12,
        selectedTextRangeLength: 0,
        elementSignature,
      },
      {
        ok: true,
        selectedTextRangeLocation: 12,
        selectedTextRangeLength: 0,
        elementSignature,
      },
      {
        ok: true,
        selectedTextRangeLocation: 12,
        selectedTextRangeLength: 0,
        elementSignature,
      },
    );

    mocks.state.recognizer?.recognizing?.(null, {
      result: { text: 'n' },
    });

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'replaceTextAtomically',
        '12',
        '0',
        Buffer.from('now ax', 'utf-8').toString('base64'),
        '2222',
        Buffer.from(elementSignature, 'utf-8').toString('base64'),
      ]));
    });
    expect(mocks.runLocalMacMouseCommand).not.toHaveBeenCalledWith(expect.arrayContaining([
      Buffer.from('n', 'utf-8').toString('base64'),
    ]));
  });

  it('does not repeatedly delay streaming KX partials when AX remains unreadable', async () => {
    const manager = await import('../dictation-manager.js');
    const config = createConfig();
    const latestPartial = 'Now I have switched to a KX field';
    config.dictation.partialTyping = { ax: 'full-replacement', kb: 'full-patch' };
    mocks.getDictationTargetPid.mockReturnValue(1111);
    mocks.state.focusedTextSelection = {
      ok: true,
      selectedTextRangeLocation: 0,
      selectedTextRangeLength: 0,
      elementSignature: '',
    };

    manager.initDictation(config as never);
    await manager.toggleDictation();
    expect(manager.getDictationState().state).toBe('active');

    let recaptureCount = 0;
    mocks.recaptureDictationTargetFocus.mockImplementation(async () => {
      recaptureCount++;
      mocks.state.frontmostPid = 2222;
      mocks.getDictationTargetPid.mockReturnValue(2222);
      mocks.state.focusedTextSelection = {
        ok: true,
        selectedTextRangeLocation: 0,
        selectedTextRangeLength: 0,
        elementSignature: '',
      };
      if (recaptureCount === 1) {
        queueMicrotask(() => {
          mocks.state.recognizer?.recognizing?.(null, {
            result: { text: latestPartial },
          });
        });
      }
      return true;
    });

    mocks.state.recognizer?.recognizing?.(null, {
      result: { text: 'Now I' },
    });

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'postText',
        Buffer.from(latestPartial, 'utf-8').toString('base64'),
        '2222',
        '--allow-unverified-keyboard',
      ]));
    });
    expect(mocks.runLocalMacMouseCommand).not.toHaveBeenCalledWith(expect.arrayContaining([
      Buffer.from('Now I', 'utf-8').toString('base64'),
    ]));
    expect(recaptureCount).toBeLessThanOrEqual(3);
  });

  it('finalizes the first AX partial after switching from KB when cursor verification is stale', async () => {
    const manager = await import('../dictation-manager.js');
    const config = createConfig();
    const elementSignature = 'role=QVhUZXh0QXJlYQ==|x=80|y=90|w=300';
    config.dictation.partialTyping = { ax: 'full-replacement', kb: 'full-patch' };
    mocks.getDictationTargetPid.mockReturnValue(1111);
    mocks.state.focusedTextSelection = {
      ok: true,
      selectedTextRangeLocation: 0,
      selectedTextRangeLength: 0,
      elementSignature: '',
    };

    manager.initDictation(config as never);
    await manager.toggleDictation();
    expect(manager.getDictationState().state).toBe('active');

    mocks.recaptureDictationTargetFocus.mockImplementation(async () => {
      mocks.state.frontmostPid = 2222;
      mocks.getDictationTargetPid.mockReturnValue(2222);
      mocks.state.focusedTextSelection = {
        ok: true,
        selectedTextRangeLocation: 8,
        selectedTextRangeLength: 0,
        elementSignature,
      };
      return true;
    });

    mocks.state.recognizer?.recognizing?.(null, {
      result: { text: 'first ax' },
    });

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'replaceTextAtomically',
        '8',
        '0',
        Buffer.from('first ax', 'utf-8').toString('base64'),
        '2222',
        Buffer.from(elementSignature, 'utf-8').toString('base64'),
      ]));
    });

    mocks.state.focusedTextSelection = {
      ok: true,
      selectedTextRangeLocation: 99,
      selectedTextRangeLength: 0,
      elementSignature,
    };
    mocks.state.focusedTextRangeState = {
      selectedTextRangeLocation: 99,
      selectedTextRangeLength: 0,
      elementSignature,
      rangeText: 'first ax',
      textUtf16Length: 16,
    };

    mocks.state.recognizer?.recognized?.(null, {
      result: { reason: 1, text: 'first ax final' },
    } as never);

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'replaceTextAtomically',
        '8',
        '8',
        Buffer.from('first ax final ', 'utf-8').toString('base64'),
        '2222',
        Buffer.from(elementSignature, 'utf-8').toString('base64'),
      ]));
    });
    expect(mocks.sendToOverlay).not.toHaveBeenCalledWith(
      'dictation:error',
      expect.stringContaining('could not safely type'),
    );
  });

  it('finalizes an AX partial that appears as a suffix after switching from KB', async () => {
    const manager = await import('../dictation-manager.js');
    const config = createConfig();
    const elementSignature = 'role=QVhUZXh0QXJlYQ==|x=80|y=90|w=300';
    const existingText = 'https://example.com/';
    const partialText = 'first ax';
    const suffixLocation = existingText.length;
    config.dictation.partialTyping = { ax: 'full-replacement', kb: 'full-patch' };
    mocks.getDictationTargetPid.mockReturnValue(1111);
    mocks.state.focusedTextSelection = {
      ok: true,
      selectedTextRangeLocation: 0,
      selectedTextRangeLength: 0,
      elementSignature: '',
    };

    manager.initDictation(config as never);
    await manager.toggleDictation();
    expect(manager.getDictationState().state).toBe('active');

    mocks.recaptureDictationTargetFocus.mockImplementation(async () => {
      mocks.state.frontmostPid = 2222;
      mocks.getDictationTargetPid.mockReturnValue(2222);
      mocks.state.focusedTextSelection = {
        ok: true,
        selectedTextRangeLocation: 8,
        selectedTextRangeLength: 0,
        elementSignature,
      };
      return true;
    });

    mocks.state.recognizer?.recognizing?.(null, {
      result: { text: partialText },
    });

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'replaceTextAtomically',
        '8',
        '0',
        Buffer.from(partialText, 'utf-8').toString('base64'),
        '2222',
        Buffer.from(elementSignature, 'utf-8').toString('base64'),
      ]));
    });

    mocks.state.focusedTextSelection = {
      ok: true,
      selectedTextRangeLocation: existingText.length + partialText.length,
      selectedTextRangeLength: 0,
      elementSignature,
    };
    mocks.state.focusedTextRangeStateResponses.push(
      {
        selectedTextRangeLocation: existingText.length + partialText.length,
        selectedTextRangeLength: 0,
        elementSignature,
        rangeText: 'example.',
        textUtf16Length: existingText.length + partialText.length,
      },
      {
        selectedTextRangeLocation: existingText.length + partialText.length,
        selectedTextRangeLength: 0,
        elementSignature,
        rangeText: 'example.',
        textUtf16Length: existingText.length + partialText.length,
      },
      {
        selectedTextRangeLocation: existingText.length + partialText.length,
        selectedTextRangeLength: 0,
        elementSignature,
        rangeText: '',
        textUtf16Length: existingText.length + partialText.length,
      },
      {
        selectedTextRangeLocation: existingText.length + partialText.length,
        selectedTextRangeLength: 0,
        elementSignature,
        rangeText: partialText,
        textUtf16Length: existingText.length + partialText.length,
      },
    );

    mocks.state.recognizer?.recognized?.(null, {
      result: { reason: 1, text: 'first ax final' },
    } as never);

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'replaceTextAtomically',
        String(suffixLocation),
        String(partialText.length),
        Buffer.from('first ax final ', 'utf-8').toString('base64'),
        '2222',
        Buffer.from(elementSignature, 'utf-8').toString('base64'),
      ]));
    });
    expect(mocks.sendToOverlay).not.toHaveBeenCalledWith(
      'dictation:error',
      expect.stringContaining('could not safely type'),
    );
  });

  it('continues the second AX partial from a suffix after returning from KB', async () => {
    const manager = await import('../dictation-manager.js');
    const config = createConfig();
    const elementSignature = 'role=QVhUZXh0QXJlYQ==|x=80|y=90|w=300';
    const refreshedElementSignature = 'role=QVhUZXh0QXJlYQ==|x=80|y=90|w=301';
    const existingText = 'https://example.com/';
    const firstPartial = 'first ax';
    const secondPartial = 'first ax second';
    const suffixLocation = existingText.length;
    config.dictation.partialTyping = { ax: 'full-replacement', kb: 'full-patch' };
    mocks.getDictationTargetPid.mockReturnValue(1111);
    mocks.state.focusedTextSelection = {
      ok: true,
      selectedTextRangeLocation: 0,
      selectedTextRangeLength: 0,
      elementSignature: '',
    };

    manager.initDictation(config as never);
    await manager.toggleDictation();
    expect(manager.getDictationState().state).toBe('active');

    mocks.recaptureDictationTargetFocus.mockImplementation(async () => {
      mocks.state.frontmostPid = 2222;
      mocks.getDictationTargetPid.mockReturnValue(2222);
      mocks.state.focusedTextSelection = {
        ok: true,
        selectedTextRangeLocation: 8,
        selectedTextRangeLength: 0,
        elementSignature,
      };
      return true;
    });

    mocks.state.recognizer?.recognizing?.(null, {
      result: { text: firstPartial },
    });

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'replaceTextAtomically',
        '8',
        '0',
        Buffer.from(firstPartial, 'utf-8').toString('base64'),
        '2222',
        Buffer.from(elementSignature, 'utf-8').toString('base64'),
      ]));
    });

    mocks.state.focusedTextSelection = {
      ok: true,
      selectedTextRangeLocation: existingText.length + firstPartial.length,
      selectedTextRangeLength: 0,
      elementSignature: refreshedElementSignature,
    };
    mocks.state.focusedTextRangeStateResponses.push(
      {
        selectedTextRangeLocation: existingText.length + firstPartial.length,
        selectedTextRangeLength: 0,
        elementSignature: refreshedElementSignature,
        rangeText: 'example.',
        textUtf16Length: existingText.length + firstPartial.length,
      },
      {
        selectedTextRangeLocation: existingText.length + firstPartial.length,
        selectedTextRangeLength: 0,
        elementSignature: refreshedElementSignature,
        rangeText: 'example.',
        textUtf16Length: existingText.length + firstPartial.length,
      },
      {
        selectedTextRangeLocation: existingText.length + firstPartial.length,
        selectedTextRangeLength: 0,
        elementSignature: refreshedElementSignature,
        rangeText: '',
        textUtf16Length: existingText.length + firstPartial.length,
      },
      {
        selectedTextRangeLocation: existingText.length + firstPartial.length,
        selectedTextRangeLength: 0,
        elementSignature: refreshedElementSignature,
        rangeText: firstPartial,
        textUtf16Length: existingText.length + firstPartial.length,
      },
    );

    mocks.state.recognizer?.recognizing?.(null, {
      result: { text: secondPartial },
    });

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'replaceTextAtomically',
        String(suffixLocation),
        String(firstPartial.length),
        Buffer.from(secondPartial, 'utf-8').toString('base64'),
        '2222',
        Buffer.from(refreshedElementSignature, 'utf-8').toString('base64'),
      ]));
    });
    expect(mocks.sendToOverlay).not.toHaveBeenCalledWith(
      'dictation:error',
      expect.stringContaining('could not safely type'),
    );
  });

  it('refreshes the AX element signature after a successful partial mutation', async () => {
    const manager = await import('../dictation-manager.js');
    const config = createConfig();
    const initialElementSignature = 'role=QVhUZXh0RmllbGQ=|subrole=|id=|x=270|y=81|w=1439';
    const refreshedElementSignature = 'role=QVhUZXh0RmllbGQ=|subrole=|id=|x=283|y=81|w=1426';
    const location = 68;
    const firstPartial = 'first ax partial';
    const secondPartial = 'first ax partial continued';
    config.dictation.partialTyping = { ax: 'full-replacement', kb: 'full-patch' };
    mocks.state.frontmostPid = 2222;
    mocks.getDictationTargetPid.mockReturnValue(2222);
    mocks.state.focusedTextSelection = {
      ok: true,
      selectedTextRangeLocation: location,
      selectedTextRangeLength: 0,
      elementSignature: initialElementSignature,
    };

    manager.initDictation(config as never);
    await manager.toggleDictation();
    expect(manager.getDictationState().state).toBe('active');

    mocks.state.focusedTextSelectionResponses.push(
      {
        ok: true,
        selectedTextRangeLocation: location,
        selectedTextRangeLength: 0,
        elementSignature: initialElementSignature,
      },
      {
        ok: true,
        selectedTextRangeLocation: location,
        selectedTextRangeLength: 0,
        elementSignature: initialElementSignature,
      },
      {
        ok: true,
        selectedTextRangeLocation: location + firstPartial.length,
        selectedTextRangeLength: 0,
        elementSignature: refreshedElementSignature,
      },
    );

    mocks.state.recognizer?.recognizing?.(null, {
      result: { text: firstPartial },
    });

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'replaceTextAtomically',
        String(location),
        '0',
        Buffer.from(firstPartial, 'utf-8').toString('base64'),
        '2222',
        Buffer.from(initialElementSignature, 'utf-8').toString('base64'),
      ]));
    });

    mocks.state.focusedTextSelection = {
      ok: true,
      selectedTextRangeLocation: location + firstPartial.length,
      selectedTextRangeLength: 0,
      elementSignature: refreshedElementSignature,
    };

    mocks.state.recognizer?.recognizing?.(null, {
      result: { text: secondPartial },
    });

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'replaceTextAtomically',
        String(location),
        String(firstPartial.length),
        Buffer.from(secondPartial, 'utf-8').toString('base64'),
        '2222',
        Buffer.from(refreshedElementSignature, 'utf-8').toString('base64'),
      ]));
    });
    expect(mocks.sendToOverlay).not.toHaveBeenCalledWith(
      'dictation:error',
      expect.stringContaining('could not safely type'),
    );
  });

  it('round-trips KX to AX to KX to a previously used AX field', async () => {
    const manager = await import('../dictation-manager.js');
    const config = createConfig();
    const urlElementSignature = 'role=QVhUZXh0RmllbGQ=|x=20|y=30|w=600';
    const existingUrlText = 'https://example.com/';
    const returnedFirstPartial = 'return ax';
    const returnedSecondPartial = 'return ax second';
    const setKxTarget = () => {
      mocks.state.frontmostPid = 1111;
      mocks.getDictationTargetPid.mockReturnValue(1111);
      mocks.state.focusedTextSelection = {
        ok: true,
        selectedTextRangeLocation: 0,
        selectedTextRangeLength: 0,
        elementSignature: '',
      };
    };
    const setUrlTarget = (location: number) => {
      mocks.state.frontmostPid = 2222;
      mocks.getDictationTargetPid.mockReturnValue(2222);
      mocks.state.focusedTextSelection = {
        ok: true,
        selectedTextRangeLocation: location,
        selectedTextRangeLength: 0,
        elementSignature: urlElementSignature,
      };
    };

    config.dictation.partialTyping = { ax: 'full-replacement', kb: 'full-patch' };
    setKxTarget();

    manager.initDictation(config as never);
    await manager.toggleDictation();
    expect(manager.getDictationState().state).toBe('active');

    setUrlTarget(3);
    mocks.recaptureDictationTargetFocus.mockResolvedValue(true);
    mocks.state.recognizer?.recognizing?.(null, {
      result: { text: 'url one' },
    });

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'replaceTextAtomically',
        '3',
        '0',
        Buffer.from('url one', 'utf-8').toString('base64'),
        '2222',
        Buffer.from(urlElementSignature, 'utf-8').toString('base64'),
      ]));
    });

    setUrlTarget(3 + 'url one'.length);
    mocks.state.recognizer?.recognized?.(null, {
      result: { reason: 1, text: 'url one final' },
    } as never);

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'replaceTextAtomically',
        '3',
        String('url one'.length),
        Buffer.from('url one final ', 'utf-8').toString('base64'),
        '2222',
        Buffer.from(urlElementSignature, 'utf-8').toString('base64'),
      ]));
    });

    setKxTarget();
    mocks.state.recognizer?.recognizing?.(null, {
      result: { text: 'editor one' },
    });

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'postText',
        Buffer.from('editor one', 'utf-8').toString('base64'),
        '1111',
        '--allow-unverified-keyboard',
      ]));
    });

    mocks.state.recognizer?.recognized?.(null, {
      result: { reason: 1, text: 'editor one final' },
    } as never);

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'postText',
        Buffer.from(' final ', 'utf-8').toString('base64'),
        '1111',
        '--allow-unverified-keyboard',
      ]));
    });

    setUrlTarget(8);
    mocks.state.recognizer?.recognizing?.(null, {
      result: { text: returnedFirstPartial },
    });

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'replaceTextAtomically',
        '8',
        '0',
        Buffer.from(returnedFirstPartial, 'utf-8').toString('base64'),
        '2222',
        Buffer.from(urlElementSignature, 'utf-8').toString('base64'),
      ]));
    });

    setUrlTarget(existingUrlText.length + returnedFirstPartial.length);
    mocks.state.focusedTextRangeStateResponses.push(
      {
        selectedTextRangeLocation: existingUrlText.length + returnedFirstPartial.length,
        selectedTextRangeLength: 0,
        elementSignature: urlElementSignature,
        rangeText: 'example.',
        textUtf16Length: existingUrlText.length + returnedFirstPartial.length,
      },
      {
        selectedTextRangeLocation: existingUrlText.length + returnedFirstPartial.length,
        selectedTextRangeLength: 0,
        elementSignature: urlElementSignature,
        rangeText: 'example.',
        textUtf16Length: existingUrlText.length + returnedFirstPartial.length,
      },
      {
        selectedTextRangeLocation: existingUrlText.length + returnedFirstPartial.length,
        selectedTextRangeLength: 0,
        elementSignature: urlElementSignature,
        rangeText: '',
        textUtf16Length: existingUrlText.length + returnedFirstPartial.length,
      },
      {
        selectedTextRangeLocation: existingUrlText.length + returnedFirstPartial.length,
        selectedTextRangeLength: 0,
        elementSignature: urlElementSignature,
        rangeText: returnedFirstPartial,
        textUtf16Length: existingUrlText.length + returnedFirstPartial.length,
      },
    );

    mocks.state.recognizer?.recognizing?.(null, {
      result: { text: returnedSecondPartial },
    });

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'replaceTextAtomically',
        String(existingUrlText.length),
        String(returnedFirstPartial.length),
        Buffer.from(returnedSecondPartial, 'utf-8').toString('base64'),
        '2222',
        Buffer.from(urlElementSignature, 'utf-8').toString('base64'),
      ]));
    });
    expect(mocks.sendToOverlay).not.toHaveBeenCalledWith(
      'dictation:error',
      expect.stringContaining('could not safely type'),
    );
  });

  it('does not suppress the whole utterance when first-partial verification misses before any mutation', async () => {
    const manager = await import('../dictation-manager.js');
    const config = createConfig();
    config.dictation.partialTyping = { ax: 'full-replacement', kb: 'disabled' };

    manager.initDictation(config as never);
    await manager.toggleDictation();
    expect(manager.getDictationState().state).toBe('active');

    mocks.recaptureDictationTargetFocus.mockResolvedValue(true);
    mocks.state.focusedTextSelectionResponses.push(
      {
        ok: true,
        selectedTextRangeLocation: 10,
        selectedTextRangeLength: 0,
        elementSignature: 'role=QVhUZXh0QXJlYQ==|x=80|y=90|w=300',
      },
      {
        ok: true,
        selectedTextRangeLocation: 11,
        selectedTextRangeLength: 0,
        elementSignature: 'role=QVhUZXh0QXJlYQ==|x=80|y=90|w=300',
      },
      {
        ok: true,
        selectedTextRangeLocation: 12,
        selectedTextRangeLength: 0,
        elementSignature: 'role=QVhUZXh0QXJlYQ==|x=80|y=90|w=300',
      },
      {
        ok: true,
        selectedTextRangeLocation: 13,
        selectedTextRangeLength: 0,
        elementSignature: 'role=QVhUZXh0QXJlYQ==|x=80|y=90|w=300',
      },
    );

    mocks.state.recognizer?.recognizing?.(null, {
      result: { text: 'first' },
    });

    await vi.waitFor(() => {
      expect(mocks.recaptureDictationTargetFocus.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    expect(mocks.runLocalMacMouseCommand).not.toHaveBeenCalledWith(expect.arrayContaining([
      'replaceTextAtomically',
      '10',
    ]));

    mocks.state.focusedTextSelectionResponses.push(
      {
        ok: true,
        selectedTextRangeLocation: 20,
        selectedTextRangeLength: 0,
        elementSignature: 'role=QVhUZXh0QXJlYQ==|x=80|y=90|w=300',
      },
      {
        ok: true,
        selectedTextRangeLocation: 20,
        selectedTextRangeLength: 0,
        elementSignature: 'role=QVhUZXh0QXJlYQ==|x=80|y=90|w=300',
      },
    );

    mocks.state.recognizer?.recognizing?.(null, {
      result: { text: 'first retry' },
    });

    await vi.waitFor(() => {
      expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledWith(expect.arrayContaining([
        'replaceTextAtomically',
        '20',
        '0',
        Buffer.from('first retry', 'utf-8').toString('base64'),
      ]));
    });
  });
});
