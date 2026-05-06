/**
 * Background speech collector for native Web Speech API.
 *
 * Runs SpeechRecognition in the background during a recording session,
 * buffering all final results instead of inserting them live into the
 * composer. When stop() is called, returns the full accumulated transcript.
 *
 * This provides the "record first, transcribe after" UX even though
 * the Web Speech API can only do real-time streaming internally. The key
 * difference from the old dictation approach: text doesn't appear in the
 * composer until the user presses stop.
 */

function debugLog(msg: string) {
  try {
    const w = window as unknown as { app?: { debug?: { log: (file: string, message: string) => void } } };
    w.app?.debug?.log('recording', msg);
  } catch { /* ignore */ }
}

interface SpeechRecognitionInstance extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance;
}

export interface BackgroundSpeechCollector {
  /** Start collecting speech in the background */
  start: () => void;
  /** Stop collecting and return the full accumulated transcript */
  stop: () => string;
  /** Cancel and discard all collected text */
  destroy: () => void;
}

/**
 * Create a background speech collector that listens via Web Speech API
 * and accumulates final results without inserting them into the UI.
 */
export function createBackgroundSpeechCollector(language: string): BackgroundSpeechCollector {
  const SpeechRecognitionClass = (
    (window as Window & { SpeechRecognition?: SpeechRecognitionConstructor }).SpeechRecognition
    || (window as Window & { webkitSpeechRecognition?: SpeechRecognitionConstructor }).webkitSpeechRecognition
  );

  if (!SpeechRecognitionClass) {
    debugLog('SpeechRecognition NOT available in this context');
    return {
      start: () => { debugLog('no-op start — SpeechRecognition not available'); },
      stop: () => { debugLog('no-op stop — returning empty'); return ''; },
      destroy: () => {},
    };
  }

  debugLog(`SpeechRecognition IS available, creating collector language=${language}`);

  const results: string[] = [];
  let recognition: SpeechRecognitionInstance | null = null;
  let stopRequested = false;
  let started = false;

  const restartableErrors = new Set(['network', 'no-speech', 'aborted']);

  function createRecognition(): SpeechRecognitionInstance {
    const rec = new SpeechRecognitionClass!();
    rec.lang = language;
    rec.continuous = true;
    rec.interimResults = false; // Only collect final results

    rec.addEventListener('result', (event: Event) => {
      const e = event as Event & { results: SpeechRecognitionResultList; resultIndex: number };
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result?.isFinal && result[0]) {
          const text = result[0].transcript.trim();
          if (text) {
            results.push(text);
            debugLog(`result: collected="${text}" totalSegments=${results.length}`);
          }
        }
      }
    });

    rec.addEventListener('end', () => {
      debugLog(`end event: stopRequested=${stopRequested} started=${started}`);
      if (!stopRequested && started) {
        tryRestart();
      }
    });

    rec.addEventListener('error', (event: Event) => {
      const errorEvent = event as Event & { error?: string };
      const errorType = errorEvent.error ?? 'unknown';
      debugLog(`error event: type=${errorType}`);

      if (!stopRequested && restartableErrors.has(errorType)) {
        return;
      }
    });

    return rec;
  }

  function tryRestart() {
    if (stopRequested || !started) return;
    try {
      debugLog('auto-restarting recognition');
      recognition = createRecognition();
      recognition.start();
    } catch (err) {
      debugLog(`restart failed: ${err}`);
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      stopRequested = false;

      try {
        recognition = createRecognition();
        recognition.start();
        debugLog(`started language=${language}`);
      } catch (err) {
        debugLog(`failed to start: ${err}`);
      }
    },

    stop(): string {
      stopRequested = true;
      started = false;

      try {
        recognition?.stop();
      } catch { /* ignore */ }
      recognition = null;

      const transcript = results.join(' ');
      debugLog(`stopped segments=${results.length} chars=${transcript.length} text="${transcript.substring(0, 200)}"`);
      return transcript;
    },

    destroy() {
      stopRequested = true;
      started = false;
      results.length = 0;

      try {
        recognition?.abort();
      } catch { /* ignore */ }
      recognition = null;
    },
  };
}
