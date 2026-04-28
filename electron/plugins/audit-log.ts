/**
 * Plugin Audit Logger
 *
 * Append-only JSONL log at ~/.kai/audit/plugin-operations.jsonl.
 * Every filesystem, execution, and detection operation performed by plugins
 * is recorded here for transparency and debugging.
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AuditEntry } from './types.js';

const AUDIT_DIR = join(homedir(), '.kai', 'audit');
const AUDIT_FILE = join(AUDIT_DIR, 'plugin-operations.jsonl');

let initialized = false;

function ensureAuditDir(): void {
  if (initialized) return;
  if (!existsSync(AUDIT_DIR)) {
    mkdirSync(AUDIT_DIR, { recursive: true });
  }
  initialized = true;
}

/**
 * Write an audit entry to the JSONL log.
 * Failures are logged to stderr but never thrown — audit must not break plugin operations.
 */
export function writeAuditEntry(entry: AuditEntry): void {
  ensureAuditDir();
  try {
    appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    console.error('[AuditLog] Failed to write audit entry:', err);
  }
}

/** Get the path to the audit log file. */
export function getAuditLogPath(): string {
  return AUDIT_FILE;
}
