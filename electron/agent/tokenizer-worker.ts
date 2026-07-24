/**
 * Off-main-thread tiktoken tokenizer.
 *
 * WHY THIS EXISTS: tiktoken's `encode()` is a synchronous WASM call whose BPE
 * merge cost is CONTENT-dependent, not just length-dependent. A large or
 * pathological conversation branch (long same-byte runs, near-repetitive
 * periodic content just past any distinct-char heuristic) can block the caller
 * for seconds. When that caller is the Electron MAIN thread (the compaction
 * gate + budget-fit on the send path) the whole UI freezes at 100% CPU. No
 * in-thread heuristic can make that impossible — there is always an input just
 * past whatever threshold stays accurate enough. So the WHOLE-BRANCH encodes
 * run HERE, in a worker_thread, and the main thread `await`s the result: the
 * event loop stays live (timers, IPC, renderer paints) while the worker does
 * the CPU work in its own thread.
 *
 * The SAME safety guards as the synchronous path still apply inside the worker
 * (long-run / repetition / size caps, `<|endoftext|>` throw → byte ceiling) so
 * a pathological input can't wedge the worker THREAD either — it just falls
 * back to the byte ceiling, exactly as the sync path does. The guards are
 * duplicated here (not imported from tokenization.ts) so this worker's module
 * graph stays tiny: only `tiktoken` + `node:worker_threads`, nothing that would
 * pull the Electron/Mastra graph into a worker bundle.
 */
import { parentPort } from 'node:worker_threads';
import { encoding_for_model } from 'tiktoken';

type ModelEncoding = ReturnType<typeof encoding_for_model>;

/** RPC request from the main thread. `base` selects the encoder; `text` is the
 *  already-serialized branch/message string; `maxExactChars` is the size cap
 *  above which we byte-ceiling instead of encoding (mirrors the sync caps). */
type EncodeRequest = {
  type: 'encode';
  id: number;
  encodingModel: string;
  text: string;
  maxExactChars: number;
};

type EncodeResponse = { type: 'result'; id: number; count: number } | { type: 'error'; id: number; message: string };

// Mirror of tokenization.ts guards (kept in sync intentionally — see module doc).
const MAX_ENCODE_RUN = 8_192;
const REPETITIVE_LEN_THRESHOLD = 16_384;
const REPETITIVE_MAX_DISTINCT = 24;

function longestCharRun(s: string): number {
  let best = 0;
  let cur = 0;
  let prev = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === prev) {
      cur++;
    } else {
      cur = 1;
      prev = c;
    }
    if (cur > best) {
      best = cur;
      if (best > MAX_ENCODE_RUN) return best;
    }
  }
  return best;
}

function looksRepetitive(s: string): boolean {
  if (s.length <= REPETITIVE_LEN_THRESHOLD) return false;
  const seen = new Set<number>();
  for (let i = 0; i < s.length; i++) {
    seen.add(s.charCodeAt(i));
    if (seen.size > REPETITIVE_MAX_DISTINCT) return false;
  }
  return true;
}

/** UTF-8 byte length — a true token CEILING (byte-level BPE emits ≤ 1 token per
 *  UTF-8 byte). Used whenever the exact encode is skipped or throws. */
function byteCeiling(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

const encodingCache = new Map<string, ModelEncoding | null>();
function resolveEncoding(encodingModel: string): ModelEncoding | null {
  const cached = encodingCache.get(encodingModel);
  if (cached !== undefined) return cached;
  let enc: ModelEncoding | null = null;
  try {
    enc = encoding_for_model(encodingModel as Parameters<typeof encoding_for_model>[0]);
  } catch {
    try {
      enc = encoding_for_model('gpt-5' as Parameters<typeof encoding_for_model>[0]);
    } catch {
      enc = null;
    }
  }
  encodingCache.set(encodingModel, enc);
  return enc;
}

function encodeCapped(serialized: string, encoding: ModelEncoding, maxExactChars: number): number {
  if (serialized.length > maxExactChars) return byteCeiling(serialized);
  if (longestCharRun(serialized) > MAX_ENCODE_RUN || looksRepetitive(serialized)) {
    return byteCeiling(serialized);
  }
  try {
    return encoding.encode(serialized).length;
  } catch {
    // Reserved-marker text (`<|endoftext|>`) throws by default — byte-ceiling it.
    return byteCeiling(serialized);
  }
}

parentPort?.on('message', (msg: EncodeRequest) => {
  if (msg?.type !== 'encode') return;
  const respond = (res: EncodeResponse): void => parentPort?.postMessage(res);
  try {
    const encoding = resolveEncoding(msg.encodingModel);
    if (!encoding) {
      // No encoder at all — the byte ceiling is still a safe upper bound.
      respond({ type: 'result', id: msg.id, count: byteCeiling(msg.text) });
      return;
    }
    respond({ type: 'result', id: msg.id, count: encodeCapped(msg.text, encoding, msg.maxExactChars) });
  } catch (error) {
    respond({ type: 'error', id: msg.id, message: error instanceof Error ? error.message : String(error) });
  }
});

// Signal the parent that this worker's module graph loaded successfully. The
// client waits for this before trusting the worker; a crash BEFORE it arrives
// means the worker is unavailable and the client uses its synchronous fallback.
parentPort?.postMessage({ type: 'ready' });
