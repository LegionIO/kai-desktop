/**
 * Persistent Alerts store — powers the Alerts/Questions feature.
 *
 * An automation (or any headless agent run) can raise an alert when it needs
 * the user: a `question` (answer resumes the thread), an `fyi` flag (informational,
 * non-blocking), or an `approval` (approve/deny resumes the thread). Alerts are
 * persisted so they survive restarts and can be answered whenever the user
 * returns.
 *
 * Storage mirrors the conversation store: one JSON file per alert under
 * `~/.kai/data/alerts/<id>.json` plus a lightweight `alerts-index.json` for the
 * list view (no need to read every alert body to render the tab / badge).
 * These helpers are pure (I/O only, no Electron / IPC) so they're unit-tested;
 * the IPC layer (electron/ipc/alerts.ts) does notifications + thread re-injection.
 */
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

/** One multiple-choice question — mirrors the ask_user tool's question shape. */
export interface AlertQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export type AlertKind = 'question' | 'fyi' | 'approval';
export type AlertStatus = 'open' | 'answered' | 'dismissed';

export interface Alert {
  id: string;
  kind: AlertKind;
  status: AlertStatus;
  title: string;
  body: string;
  /** For `question`: the questions to render (ask_user-style). */
  questions?: AlertQuestion[];
  /** For `approval`: a short description of the action being approved. */
  approvalAction?: string;
  /** The conversation the raising run belongs to — where the answer re-injects. */
  conversationId: string;
  /** The automation rule that raised it, if any (for display/attribution). */
  ruleId?: string;
  createdAt: string;
  answeredAt?: string;
  /** For `question`: answers keyed by question text. For `approval`: the decision. */
  answer?: Record<string, string> | 'approve' | 'deny';
}

/** Lightweight index row — everything the tab/badge needs without reading bodies. */
export interface AlertIndexEntry {
  id: string;
  kind: AlertKind;
  status: AlertStatus;
  title: string;
  conversationId: string;
  ruleId?: string;
  createdAt: string;
}

export interface AlertIndex {
  alerts: Record<string, AlertIndexEntry>;
}

// ── paths ────────────────────────────────────────────────────────────────────

function alertsDir(appHome: string): string {
  return join(appHome, 'data', 'alerts');
}
function alertPath(appHome: string, id: string): string {
  return join(alertsDir(appHome), `${sanitizeId(id)}.json`);
}
function alertIndexPath(appHome: string): string {
  return join(appHome, 'data', 'alerts-index.json');
}

/** Guard against path traversal via a malicious alert id (ids flow in from IPC). */
function sanitizeId(id: string): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`Invalid alert id: ${JSON.stringify(id)}`);
  }
  return id;
}

// ── index ──────────────────────────────────────────────────────────────────

export function readAlertIndex(appHome: string): AlertIndex {
  const p = alertIndexPath(appHome);
  if (!existsSync(p)) return { alerts: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as AlertIndex;
    if (parsed && typeof parsed === 'object' && parsed.alerts && typeof parsed.alerts === 'object') {
      return parsed;
    }
  } catch {
    // Corrupt index → rebuild from the per-alert files (fail-safe, not fail-empty).
    return rebuildIndexFromFiles(appHome);
  }
  return { alerts: {} };
}

function writeAlertIndex(appHome: string, index: AlertIndex): void {
  atomicWriteFileSync(alertIndexPath(appHome), JSON.stringify(index, null, 2));
}

function toIndexEntry(a: Alert): AlertIndexEntry {
  return {
    id: a.id,
    kind: a.kind,
    status: a.status,
    title: a.title,
    conversationId: a.conversationId,
    ...(a.ruleId ? { ruleId: a.ruleId } : {}),
    createdAt: a.createdAt,
  };
}

/** Reconstruct the index by scanning the alert files — used if the index is
 *  corrupt/missing so a bad index can't lose alerts. */
function rebuildIndexFromFiles(appHome: string): AlertIndex {
  const dir = alertsDir(appHome);
  const index: AlertIndex = { alerts: {} };
  if (!existsSync(dir)) return index;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const a = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as Alert;
      if (a && typeof a.id === 'string') index.alerts[a.id] = toIndexEntry(a);
    } catch {
      // skip unreadable file
    }
  }
  return index;
}

// ── read ──────────────────────────────────────────────────────────────────

export function readAlert(appHome: string, id: string): Alert | null {
  let p: string;
  try {
    p = alertPath(appHome, id);
  } catch {
    return null;
  }
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as Alert;
  } catch {
    return null;
  }
}

/** All alerts, newest-first. `openOnly` filters to status 'open' (the tab default). */
export function listAlerts(appHome: string, openOnly = false): AlertIndexEntry[] {
  const entries = Object.values(readAlertIndex(appHome).alerts);
  const filtered = openOnly ? entries.filter((e) => e.status === 'open') : entries;
  // Newest-first, with id as a stable tiebreak (two alerts can share a
  // millisecond createdAt during rapid automation runs).
  return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/** Count of open alerts — for the tab badge. */
export function openAlertCount(appHome: string): number {
  return Object.values(readAlertIndex(appHome).alerts).filter((e) => e.status === 'open').length;
}

// ── write ──────────────────────────────────────────────────────────────────

function persist(appHome: string, alert: Alert): Alert {
  mkdirSync(alertsDir(appHome), { recursive: true });
  atomicWriteFileSync(alertPath(appHome, alert.id), JSON.stringify(alert, null, 2));
  const index = readAlertIndex(appHome);
  index.alerts[alert.id] = toIndexEntry(alert);
  writeAlertIndex(appHome, index);
  return alert;
}

export interface CreateAlertInput {
  kind: AlertKind;
  title: string;
  body: string;
  conversationId: string;
  questions?: AlertQuestion[];
  approvalAction?: string;
  ruleId?: string;
}

export function createAlert(appHome: string, input: CreateAlertInput): Alert {
  const alert: Alert = {
    id: randomUUID(),
    kind: input.kind,
    status: 'open',
    title: input.title,
    body: input.body,
    conversationId: input.conversationId,
    createdAt: new Date().toISOString(),
    ...(input.questions ? { questions: input.questions } : {}),
    ...(input.approvalAction ? { approvalAction: input.approvalAction } : {}),
    ...(input.ruleId ? { ruleId: input.ruleId } : {}),
  };
  return persist(appHome, alert);
}

/** Record a question answer / approval decision and mark answered. Returns the
 *  updated alert, or null if it doesn't exist or isn't open. */
export function resolveAlert(
  appHome: string,
  id: string,
  answer: Record<string, string> | 'approve' | 'deny',
): Alert | null {
  const alert = readAlert(appHome, id);
  if (!alert || alert.status !== 'open') return null;
  const updated: Alert = { ...alert, status: 'answered', answer, answeredAt: new Date().toISOString() };
  return persist(appHome, updated);
}

/** Re-open an answered alert (used when resuming the conversation failed, so the
 *  user's answer isn't lost and they can retry). Clears the recorded answer.
 *  Returns the updated alert, or null if it doesn't exist / isn't answered. */
export function reopenAlert(appHome: string, id: string): Alert | null {
  const alert = readAlert(appHome, id);
  if (!alert || alert.status !== 'answered') return null;
  const updated: Alert = { ...alert, status: 'open' };
  delete updated.answer;
  delete updated.answeredAt;
  return persist(appHome, updated);
}

/** Dismiss an alert (fyi, or a question/approval the user chooses to drop).
 *  Returns the updated alert, or null if it doesn't exist. */
export function dismissAlert(appHome: string, id: string): Alert | null {
  const alert = readAlert(appHome, id);
  if (!alert) return null;
  if (alert.status === 'dismissed') return alert;
  const updated: Alert = { ...alert, status: 'dismissed', answeredAt: new Date().toISOString() };
  return persist(appHome, updated);
}

/** Exposed for tests only. */
export const __internal = { rebuildIndexFromFiles, sanitizeId };
