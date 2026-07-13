import type { IpcMain } from 'electron';
import { dialog } from 'electron';
import { readFileSync, writeFileSync, appendFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { readAllConversations } from './conversation-store.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type UsageEvent = {
  id: string;
  timestamp: string;
  modality: 'llm' | 'realtime' | 'tts' | 'stt' | 'image-gen' | 'video-gen';
  conversationId?: string;
  modelKey?: string;
  // LLM fields
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  // Audio fields
  durationSec?: number;
  // Media fields
  imageCount?: number;
  videoCount?: number;
  size?: string;
  quality?: string;
};

type UsageEventStore = {
  events: UsageEvent[];
};

type ConversationMeta = {
  id: string;
  title: string | null;
  modelKey: string | null;
  messageCount: number;
  createdAt: string;
  lastMessageAt: string | null;
};

type ConversationUsageSummary = ConversationMeta & {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  llmRequests: number;
};

type ModelUsageSummary = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requestCount: number;
  conversationCount: number;
};

type TimeSeriesBucket = {
  period: string;
  tokens: number;
  requests: number;
};

type UsageSummary = {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  cacheHitRatio: number;
  totalMessages: number;
  totalConversations: number;
  llmRequests: number;
  realtimeCalls: number;
  realtimeDurationSec: number;
  sttEvents: number;
  sttDurationSec: number;
  ttsEvents: number;
  ttsDurationSec: number;
  imagesGenerated: number;
  videosGenerated: number;
  earliestDate: string | null;
};

// ── Event store I/O ──────────────────────────────────────────────────────────
//
// Events are stored as an append-only NDJSON log (one compact JSON object per
// line) rather than a single JSON array. Recording an event is then an O(1)
// append instead of an O(n) read-parse-mutate-stringify-rewrite of the whole
// file — the old scheme made cumulative recording O(n²) and blocked the main
// process for ~1s per event once the array grew large. A legacy
// `usage-events.json` (JSON `{events:[...]}`) is migrated into the NDJSON log
// on first access so no historical usage is lost.

let _appHome: string | null = null;

function eventStorePath(): string {
  return join(_appHome!, 'data', 'usage-events.json');
}

function eventLogPath(): string {
  return join(_appHome!, 'data', 'usage-events.ndjson');
}

/** Serialize one event as a single NDJSON line (no embedded newlines — JSON.stringify
 *  escapes any \n inside string fields, so one event is always exactly one line). */
function serializeEventLine(event: UsageEvent): string {
  return JSON.stringify(event) + '\n';
}

function parseEventLines(text: string): UsageEvent[] {
  const out: UsageEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as UsageEvent);
    } catch {
      // Tolerate a torn final line after a crash (or any single corrupt line)
      // without discarding the rest of the log.
    }
  }
  return out;
}

/** Fold a legacy `usage-events.json` array into the NDJSON log exactly once, then
 *  remove the legacy file so its events aren't double-counted on later reads. */
function migrateLegacyStoreIfNeeded(): void {
  const legacyPath = eventStorePath();
  if (!existsSync(legacyPath)) return;
  try {
    const parsed = JSON.parse(readFileSync(legacyPath, 'utf-8')) as UsageEventStore;
    const events = Array.isArray(parsed?.events) ? parsed.events : [];
    if (events.length > 0) {
      // Append (don't overwrite) so any NDJSON events written concurrently survive.
      appendFileSync(eventLogPath(), events.map(serializeEventLine).join(''));
    }
    // Remove the legacy file so this migration runs only once.
    rmSync(legacyPath, { force: true });
  } catch {
    // A corrupt legacy file: leave it in place (don't delete unread data) and
    // continue with whatever the NDJSON log holds.
  }
}

function readEventStore(): UsageEventStore {
  migrateLegacyStoreIfNeeded();
  const p = eventLogPath();
  if (!existsSync(p)) return { events: [] };
  try {
    return { events: parseEventLines(readFileSync(p, 'utf-8')) };
  } catch {
    return { events: [] };
  }
}

export function recordUsageEvent(event: Omit<UsageEvent, 'id' | 'timestamp'>): void {
  if (!_appHome) return;
  // Fold any legacy JSON store into the NDJSON log first so this event lands in
  // the same place history will be read from.
  migrateLegacyStoreIfNeeded();
  const full: UsageEvent = {
    ...event,
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
  };
  // O(1) append — no read-modify-write of the whole log.
  appendFileSync(eventLogPath(), serializeEventLine(full));
}

// ── Conversation metadata (from conversations.json) ─────────────────────────

type ConvRecord = {
  id: string;
  title?: string | null;
  fallbackTitle?: string | null;
  selectedModelKey?: string | null;
  messages?: unknown[];
  messageTree?: unknown[];
  messageCount?: number;
  createdAt?: string;
  lastMessageAt?: string | null;
};

function getConversationMeta(appHome: string): Map<string, ConversationMeta> {
  const conversations = readAllConversations(appHome);
  const meta = new Map<string, ConversationMeta>();

  for (const conv of conversations as ConvRecord[]) {
    const msgs = conv.messageTree ?? conv.messages ?? [];
    meta.set(conv.id, {
      id: conv.id,
      title: conv.title ?? conv.fallbackTitle ?? null,
      modelKey: conv.selectedModelKey ?? null,
      messageCount: conv.messageCount ?? msgs.length,
      createdAt: conv.createdAt ?? '',
      lastMessageAt: conv.lastMessageAt ?? null,
    });
  }

  return meta;
}

// ── Aggregation from event store ─────────────────────────────────────────────

function aggregateByConversation(appHome: string): ConversationUsageSummary[] {
  const events = readEventStore();
  const meta = getConversationMeta(appHome);

  // Aggregate LLM events per conversation
  const byConv = new Map<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      totalTokens: number;
      llmRequests: number;
    }
  >();

  for (const evt of events.events) {
    if (evt.modality !== 'llm' || !evt.conversationId) continue;
    const existing = byConv.get(evt.conversationId);
    if (existing) {
      existing.inputTokens += evt.inputTokens ?? 0;
      existing.outputTokens += evt.outputTokens ?? 0;
      existing.cacheReadTokens += evt.cacheReadTokens ?? 0;
      existing.cacheWriteTokens += evt.cacheWriteTokens ?? 0;
      existing.totalTokens += evt.totalTokens ?? 0;
      existing.llmRequests += 1;
    } else {
      byConv.set(evt.conversationId, {
        inputTokens: evt.inputTokens ?? 0,
        outputTokens: evt.outputTokens ?? 0,
        cacheReadTokens: evt.cacheReadTokens ?? 0,
        cacheWriteTokens: evt.cacheWriteTokens ?? 0,
        totalTokens: evt.totalTokens ?? 0,
        llmRequests: 1,
      });
    }
  }

  const results: ConversationUsageSummary[] = [];

  for (const [convId, tokens] of byConv) {
    const convMeta = meta.get(convId);
    results.push({
      id: convId,
      title: convMeta?.title ?? null,
      modelKey: convMeta?.modelKey ?? null,
      messageCount: convMeta?.messageCount ?? 0,
      createdAt: convMeta?.createdAt ?? '',
      lastMessageAt: convMeta?.lastMessageAt ?? null,
      ...tokens,
    });
  }

  return results;
}

// ── Summary cache ────────────────────────────────────────────────────────────

let summaryCache: { data: UsageSummary; timestamp: number } | null = null;
const CACHE_TTL_MS = 30_000;

function buildSummary(appHome: string): UsageSummary {
  const now = Date.now();
  if (summaryCache && now - summaryCache.timestamp < CACHE_TTL_MS) {
    return summaryCache.data;
  }

  const events = readEventStore();

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let llmRequests = 0;
  let realtimeCalls = 0;
  let realtimeDurationSec = 0;
  let sttEvents = 0;
  let sttDurationSec = 0;
  let ttsEvents = 0;
  let ttsDurationSec = 0;
  let imagesGenerated = 0;
  let videosGenerated = 0;
  let earliestDate: string | null = null;

  const conversationIds = new Set<string>();

  for (const evt of events.events) {
    if (evt.conversationId) conversationIds.add(evt.conversationId);
    if (evt.timestamp && (!earliestDate || evt.timestamp < earliestDate)) {
      earliestDate = evt.timestamp;
    }

    switch (evt.modality) {
      case 'llm':
        totalInputTokens += evt.inputTokens ?? 0;
        totalOutputTokens += evt.outputTokens ?? 0;
        totalTokens += evt.totalTokens ?? 0;
        totalCacheReadTokens += evt.cacheReadTokens ?? 0;
        totalCacheWriteTokens += evt.cacheWriteTokens ?? 0;
        llmRequests++;
        break;
      case 'realtime':
        realtimeCalls++;
        realtimeDurationSec += evt.durationSec ?? 0;
        break;
      case 'stt':
        sttEvents++;
        sttDurationSec += evt.durationSec ?? 0;
        break;
      case 'tts':
        ttsEvents++;
        ttsDurationSec += evt.durationSec ?? 0;
        break;
      case 'image-gen':
        imagesGenerated += evt.imageCount ?? 1;
        break;
      case 'video-gen':
        videosGenerated += evt.videoCount ?? 1;
        break;
    }
  }

  const cacheHitRatio = totalTokens > 0 ? totalCacheReadTokens / totalTokens : 0;

  // Get total message count from conversation metadata
  const meta = getConversationMeta(appHome);
  let totalMessages = 0;
  for (const m of meta.values()) {
    totalMessages += m.messageCount;
  }

  const summary: UsageSummary = {
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    cacheHitRatio,
    totalMessages,
    totalConversations: conversationIds.size,
    llmRequests,
    realtimeCalls,
    realtimeDurationSec,
    sttEvents,
    sttDurationSec,
    ttsEvents,
    ttsDurationSec,
    imagesGenerated,
    videosGenerated,
    earliestDate,
  };

  summaryCache = { data: summary, timestamp: now };
  return summary;
}

// ── IPC Registration ─────────────────────────────────────────────────────────

export function registerUsageHandlers(ipcMain: IpcMain, appHome: string): void {
  _appHome = appHome;

  // 1. Aggregate summary
  ipcMain.handle('usage:summary', () => {
    return buildSummary(appHome);
  });

  // 2. Per-conversation breakdown (paginated + sortable + searchable)
  ipcMain.handle(
    'usage:by-conversation',
    (
      _event,
      params?: {
        offset?: number;
        limit?: number;
        search?: string;
        sortBy?: string;
        sortDir?: string;
      },
    ) => {
      summaryCache = null;

      let conversations = aggregateByConversation(appHome);

      // Search filter
      if (params?.search) {
        const q = params.search.toLowerCase();
        conversations = conversations.filter(
          (c) => (c.title ?? '').toLowerCase().includes(q) || c.id.toLowerCase().includes(q),
        );
      }

      // Sort
      const sortBy = params?.sortBy ?? 'totalTokens';
      const sortDir = params?.sortDir === 'asc' ? 1 : -1;
      conversations.sort((a, b) => {
        const av = (a as Record<string, unknown>)[sortBy];
        const bv = (b as Record<string, unknown>)[sortBy];
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sortDir;
        if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * sortDir;
        return 0;
      });

      const total = conversations.length;
      const offset = params?.offset ?? 0;
      const limit = params?.limit ?? 25;
      const page = conversations.slice(offset, offset + limit);

      return { conversations: page, total, offset, limit };
    },
  );

  // 3. Usage grouped by model
  ipcMain.handle('usage:by-model', () => {
    const events = readEventStore();
    const byModel = new Map<string, ModelUsageSummary>();

    for (const evt of events.events) {
      if (evt.modality !== 'llm') continue;
      const model = evt.modelKey ?? 'unknown';
      const existing = byModel.get(model);
      if (existing) {
        existing.inputTokens += evt.inputTokens ?? 0;
        existing.outputTokens += evt.outputTokens ?? 0;
        existing.totalTokens += evt.totalTokens ?? 0;
        existing.cacheReadTokens += evt.cacheReadTokens ?? 0;
        existing.cacheWriteTokens += evt.cacheWriteTokens ?? 0;
        existing.requestCount += 1;
        if (evt.conversationId) {
          // Track unique conversations per model (approximate via set)
          existing.conversationCount = existing.conversationCount; // already counted
        }
      } else {
        byModel.set(model, {
          model,
          inputTokens: evt.inputTokens ?? 0,
          outputTokens: evt.outputTokens ?? 0,
          totalTokens: evt.totalTokens ?? 0,
          cacheReadTokens: evt.cacheReadTokens ?? 0,
          cacheWriteTokens: evt.cacheWriteTokens ?? 0,
          requestCount: 1,
          conversationCount: 1,
        });
      }
    }

    // Fix conversation counts — count unique conversation IDs per model
    const modelConvSets = new Map<string, Set<string>>();
    for (const evt of events.events) {
      if (evt.modality !== 'llm' || !evt.conversationId) continue;
      const model = evt.modelKey ?? 'unknown';
      let set = modelConvSets.get(model);
      if (!set) {
        set = new Set();
        modelConvSets.set(model, set);
      }
      set.add(evt.conversationId);
    }
    for (const [model, set] of modelConvSets) {
      const entry = byModel.get(model);
      if (entry) entry.conversationCount = set.size;
    }

    return Array.from(byModel.values())
      .filter((m) => m.totalTokens > 0)
      .sort((a, b) => b.totalTokens - a.totalTokens);
  });

  // 4. Time-series bucketed data
  ipcMain.handle('usage:time-series', (_event, params?: { period?: string; days?: number }) => {
    const period = params?.period ?? 'daily';
    const days = params?.days ?? 90;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffIso = cutoff.toISOString();

    const events = readEventStore();
    const buckets = new Map<string, TimeSeriesBucket>();

    for (const evt of events.events) {
      if (evt.modality !== 'llm') continue;
      if (evt.timestamp < cutoffIso) continue;

      const key = bucketKey(evt.timestamp, period);
      const existing = buckets.get(key);
      if (existing) {
        existing.tokens += evt.totalTokens ?? 0;
        existing.requests += 1;
      } else {
        buckets.set(key, {
          period: key,
          tokens: evt.totalTokens ?? 0,
          requests: 1,
        });
      }
    }

    return Array.from(buckets.values()).sort((a, b) => a.period.localeCompare(b.period));
  });

  // 5. Non-LLM events
  ipcMain.handle('usage:non-llm-events', (_event, params?: { modality?: string }) => {
    const store = readEventStore();
    let events = store.events.filter((e) => e.modality !== 'llm');
    if (params?.modality) {
      events = events.filter((e) => e.modality === params.modality);
    }
    return events.slice().reverse();
  });

  // 6. Record a usage event (from renderer or other IPC callers)
  ipcMain.handle('usage:record-event', (_event, eventData: Omit<UsageEvent, 'id' | 'timestamp'>) => {
    recordUsageEvent(eventData);
    summaryCache = null;
    return { ok: true };
  });

  // 7. Export CSV
  ipcMain.handle('usage:export-csv', async () => {
    const events = readEventStore();
    const meta = getConversationMeta(appHome);

    const lines: string[] = [
      'timestamp,modality,conversation_id,conversation_title,model,input_tokens,output_tokens,cache_read,cache_write,total_tokens,duration_sec,image_count,video_count,size,quality',
    ];

    for (const e of events.events) {
      const convTitle = e.conversationId ? (meta.get(e.conversationId)?.title ?? '') : '';
      lines.push(
        [
          e.timestamp,
          e.modality,
          csvEscape(e.conversationId ?? ''),
          csvEscape(convTitle),
          csvEscape(e.modelKey ?? ''),
          e.inputTokens ?? '',
          e.outputTokens ?? '',
          e.cacheReadTokens ?? '',
          e.cacheWriteTokens ?? '',
          e.totalTokens ?? '',
          e.durationSec ?? '',
          e.imageCount ?? '',
          e.videoCount ?? '',
          e.size ?? '',
          e.quality ?? '',
        ].join(','),
      );
    }

    const csv = lines.join('\n');

    const result = await dialog.showSaveDialog({
      title: 'Export Usage Data',
      defaultPath: `usage-export-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });

    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    writeFileSync(result.filePath, csv, 'utf-8');
    return { ok: true, filePath: result.filePath };
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function bucketKey(isoDate: string, period: string): string {
  if (period === 'weekly') {
    // Compute the week's Monday entirely in UTC so it stays consistent with the
    // daily/monthly branches (which slice the UTC ISO string). Mixing local-time
    // getDay()/getDate() with a UTC-parsed date + toISOString() readback shifted
    // events near UTC midnight into the wrong week for users behind UTC.
    const d = new Date(isoDate);
    const day = d.getUTCDay(); // 0=Sun … 6=Sat
    const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1); // back up to Monday
    d.setUTCDate(diff);
    return d.toISOString().slice(0, 10);
  }
  if (period === 'monthly') {
    return isoDate.slice(0, 7);
  }
  return isoDate.slice(0, 10);
}

export function csvEscape(value: string): string {
  // Neutralize spreadsheet formula/DDE injection: a cell whose first character
  // is one of = + - @ (or a leading tab/CR that some parsers strip) is treated
  // as a formula by Excel/Sheets, so a user/model-influenced value like
  // `=HYPERLINK(...)` or `@SUM(...)` could execute on open. Prefix such cells
  // with a single quote — the standard OWASP mitigation — before delimiter
  // quoting. Empty strings are untouched.
  let safe = value;
  if (safe && /^[=+\-@\t\r]/.test(safe)) {
    safe = `'${safe}`;
  }
  if (safe.includes(',') || safe.includes('"') || safe.includes('\n')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/** Exposed for unit tests only. */
export const __internal = {
  serializeEventLine,
  parseEventLines,
  bucketKey,
  readEventStore,
  recordUsageEvent,
  migrateLegacyStoreIfNeeded,
  setAppHomeForTest: (home: string | null): void => {
    _appHome = home;
  },
  eventLogPath,
  eventStorePath,
};
