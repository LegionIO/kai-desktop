let enabled = false;
let sessionStartMs = 0;
let lastEventMs = 0;
let eventSeq = 0;

export function setDictationDebugEnabled(value: boolean): void {
  enabled = value;
}

export function isDictationDebugEnabled(): boolean {
  return enabled;
}

export function resetDictationDebugSession(): void {
  sessionStartMs = Date.now();
  lastEventMs = sessionStartMs;
  eventSeq = 0;
}

export function dictationDebugLog(tag: string, fields: Record<string, unknown> = {}): void {
  if (!enabled) return;
  const now = Date.now();
  eventSeq += 1;
  const deltaSession = sessionStartMs > 0 ? now - sessionStartMs : 0;
  const deltaPrev = lastEventMs > 0 ? now - lastEventMs : 0;
  lastEventMs = now;

  const prefix = `seq=${eventSeq} t=+${deltaSession}ms dt=${deltaPrev}ms`;
  const body = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(' ');
  console.info(`[Dictation] [${tag}] ${prefix}${body ? ` ${body}` : ''}`);
}

function formatValue(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 200 ? `"${text.slice(0, 200)}..."` : JSON.stringify(text);
}
