/**
 * Centralized browser audio monitoring utility.
 *
 * Provides reference-counted, per-device microphone level monitoring using a
 * single shared AudioContext. This prevents multiple components from opening
 * competing getUserMedia streams which can starve the Web Speech API and cause
 * "network" errors during dictation.
 *
 * Desktop (Electron) code should continue using the IPC mic monitor
 * (window.app.mic.startMonitor / getLevel / stopMonitor). This class is only
 * for the web bridge path.
 */

export interface AudioDevice {
  deviceId: string;
  label: string;
}

interface DeviceMonitor {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  data: Uint8Array<ArrayBuffer>;
  refCount: number;
  level: number;
  ready: boolean;
}

export class WebAudioMonitor {
  private static instance: WebAudioMonitor | null = null;

  private audioCtx: AudioContext | null = null;
  private monitors = new Map<string, DeviceMonitor>();
  /** Tracks in-flight setup promises so concurrent subscribes wait for the same setup. */
  private pending = new Map<string, Promise<void>>();
  private updateTimer: ReturnType<typeof setInterval> | null = null;
  private cachedDevices: AudioDevice[] | null = null;
  private cachedAt = 0;
  private static readonly CACHE_TTL = 5000;

  private constructor() {}

  static getInstance(): WebAudioMonitor {
    if (!WebAudioMonitor.instance) {
      WebAudioMonitor.instance = new WebAudioMonitor();
    }
    return WebAudioMonitor.instance;
  }

  /**
   * Enumerate input devices. Requests mic permission if needed so labels are
   * populated. Results are cached for 5 seconds.
   */
  async listInputDevices(): Promise<AudioDevice[]> {
    if (this.cachedDevices && Date.now() - this.cachedAt < WebAudioMonitor.CACHE_TTL) {
      return this.cachedDevices;
    }
    // Request permission so labels are populated
    const temp = await navigator.mediaDevices.getUserMedia({ audio: true });
    temp.getTracks().forEach((t) => t.stop());

    const all = await navigator.mediaDevices.enumerateDevices();
    const devices = all
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Microphone' }));
    this.cachedDevices = devices;
    this.cachedAt = Date.now();
    return devices;
  }

  /**
   * Subscribe to level monitoring for a device. Returns an unsubscribe
   * function. The getUserMedia stream opens on the first subscriber and closes
   * when the last unsubscribes.
   *
   * The returned function is idempotent (safe to call multiple times).
   */
  subscribe(deviceId: string): () => void {
    const existing = this.monitors.get(deviceId);
    if (existing) {
      existing.refCount++;
    } else {
      // Create placeholder; async setup fills it in
      this.setupDevice(deviceId);
    }

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.release(deviceId);
    };
  }

  /**
   * Subscribe to multiple devices at once. Returns a single unsubscribe
   * function that releases all of them.
   */
  subscribeAll(deviceIds: string[]): () => void {
    const unsubs = deviceIds.map((id) => this.subscribe(id));
    let called = false;
    return () => {
      if (called) return;
      called = true;
      unsubs.forEach((fn) => fn());
    };
  }

  /** Current level (0–1) for a device, or 0 if not monitored / not yet ready. */
  getLevel(deviceId: string): number {
    return this.monitors.get(deviceId)?.level ?? 0;
  }

  /** Current levels for all monitored devices. Includes a `'default'` alias. */
  getLevels(): Record<string, number> {
    const out: Record<string, number> = {};
    let first: number | undefined;
    for (const [id, mon] of this.monitors) {
      out[id] = mon.level;
      if (first === undefined) first = mon.level;
    }
    // Alias 'default' to the first device if not explicitly monitored
    if (!out['default'] && first !== undefined) {
      out['default'] = first;
    }
    return out;
  }

  /** Tear down everything and clear the singleton. */
  destroy(): void {
    this.stopTimer();
    for (const [, mon] of this.monitors) {
      this.teardownMonitor(mon);
    }
    this.monitors.clear();
    this.pending.clear();
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    this.cachedDevices = null;
    WebAudioMonitor.instance = null;
  }

  // ── Internals ─────────────────────────────────────────────────────

  private ensureAudioContext(): AudioContext {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      this.audioCtx = new AudioContext();
    }
    // Resume if suspended (Chrome autoplay policy)
    if (this.audioCtx.state === 'suspended') {
      void this.audioCtx.resume();
    }
    return this.audioCtx;
  }

  private setupDevice(deviceId: string): void {
    // Avoid duplicate setup
    if (this.pending.has(deviceId)) return;

    // Create a placeholder so subsequent subscribe() calls increment refCount
    const placeholder: DeviceMonitor = {
      stream: null!,
      source: null!,
      analyser: null!,
      data: null!,
      refCount: 1,
      level: 0,
      ready: false,
    };
    this.monitors.set(deviceId, placeholder);

    const promise = (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: deviceId },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });

        const mon = this.monitors.get(deviceId);
        if (!mon || mon.refCount <= 0) {
          // Unsubscribed during setup
          stream.getTracks().forEach((t) => t.stop());
          this.monitors.delete(deviceId);
          return;
        }

        const ctx = this.ensureAudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        // Do NOT connect analyser to destination — monitoring only, no playback

        mon.stream = stream;
        mon.source = source;
        mon.analyser = analyser;
        mon.data = new Uint8Array(analyser.fftSize) as Uint8Array<ArrayBuffer>;
        mon.ready = true;

        // Listen for device unplug
        for (const track of stream.getTracks()) {
          track.addEventListener('ended', () => {
            mon.level = 0;
            mon.ready = false;
          });
        }

        this.ensureTimer();
      } catch {
        // getUserMedia failed (device gone, permission denied, etc.)
        const mon = this.monitors.get(deviceId);
        if (mon && mon.refCount <= 0) {
          this.monitors.delete(deviceId);
        }
      } finally {
        this.pending.delete(deviceId);
      }
    })();

    this.pending.set(deviceId, promise);
  }

  private release(deviceId: string): void {
    const mon = this.monitors.get(deviceId);
    if (!mon) return;
    mon.refCount--;
    if (mon.refCount <= 0) {
      this.teardownMonitor(mon);
      this.monitors.delete(deviceId);
      if (this.monitors.size === 0) {
        this.stopTimer();
      }
    }
  }

  private teardownMonitor(mon: DeviceMonitor): void {
    if (!mon.ready) return;
    try { mon.source.disconnect(); } catch { /* ignore */ }
    try { mon.analyser.disconnect(); } catch { /* ignore */ }
    mon.stream.getTracks().forEach((t) => t.stop());
    mon.ready = false;
  }

  private ensureTimer(): void {
    if (this.updateTimer) return;
    this.updateTimer = setInterval(() => this.updateLevels(), 16);
  }

  private stopTimer(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  }

  private updateLevels(): void {
    for (const [, mon] of this.monitors) {
      if (!mon.ready) continue;
      mon.analyser.getByteTimeDomainData(mon.data);
      let sum = 0;
      for (let j = 0; j < mon.data.length; j++) {
        const v = (mon.data[j] - 128) / 128;
        sum += v * v;
      }
      mon.level = Math.sqrt(sum / mon.data.length);
    }
  }
}
