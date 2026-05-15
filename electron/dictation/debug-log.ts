import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DEBUG_LOG_DIR = join(process.cwd(), 'debug-logs');
const DEBUG_LOG_PATH = join(DEBUG_LOG_DIR, 'dictation.log');

export function dictationDebugLog(tag: string, fields: Record<string, unknown> = {}): void {
  try {
    mkdirSync(DEBUG_LOG_DIR, { recursive: true });
    const body = Object.entries(fields)
      .map(([key, value]) => `${key}=${formatValue(value)}`)
      .join(' ');
    appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] [${tag}]${body ? ` ${body}` : ''}\n`);
  } catch {
    // Debug logging must never interfere with dictation.
  }
}

function formatValue(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return JSON.stringify(text.length > 180 ? `${text.slice(0, 180)}...` : text);
}
