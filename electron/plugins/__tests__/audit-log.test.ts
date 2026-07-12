/**
 * Tests for the plugin audit log (electron/plugins/audit-log.ts). Every plugin
 * fs/exec/detect operation is recorded here (append-only JSONL) for transparency.
 * The security-critical property: writeAuditEntry must NEVER throw — a failing
 * audit write must not break the plugin operation it's recording. HOME is
 * repointed to a temp dir before import (AUDIT_DIR is ~/.kai/audit, homedir-derived
 * at module load).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AuditEntry } from '../types.js';

const HOME = mkdtempSync(join(tmpdir(), 'kai-auditlog-'));
process.env.HOME = HOME;

const { writeAuditEntry, getAuditLogPath } = await import('../audit-log.js');

const AUDIT_FILE = join(HOME, '.kai', 'audit', 'plugin-operations.jsonl');
const entry = (over: Partial<AuditEntry> = {}): AuditEntry =>
  ({
    timestamp: '2026-01-01T00:00:00.000Z',
    pluginName: 'p',
    action: 'exec:run',
    target: 'git',
    approved: true,
    ...over,
  }) as AuditEntry;

describe('getAuditLogPath', () => {
  it('points at ~/.kai/audit/plugin-operations.jsonl', () => {
    expect(getAuditLogPath()).toBe(AUDIT_FILE);
  });
});

describe('writeAuditEntry', () => {
  it('appends a JSONL line and creates the audit dir on first write', () => {
    writeAuditEntry(entry({ action: 'exec:run', target: 'git' }));
    expect(existsSync(AUDIT_FILE)).toBe(true);
    const lines = readFileSync(AUDIT_FILE, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ pluginName: 'p', action: 'exec:run', target: 'git' });
  });

  it('is append-only: successive writes accumulate one parseable line each', () => {
    writeAuditEntry(entry({ action: 'exec:run', target: 'npm' }));
    writeAuditEntry(entry({ action: 'tools:detect', target: 'python' }));
    const lines = readFileSync(AUDIT_FILE, 'utf-8').trim().split('\n');
    // 1 from the previous test + 2 here (module state persists across tests in-file).
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(lines.some((l) => JSON.parse(l).target === 'npm')).toBe(true);
    expect(lines.some((l) => JSON.parse(l).action === 'tools:detect')).toBe(true);
  });

  it('NEVER throws when the entry cannot be serialized (audit must not break plugin ops)', () => {
    const cyclic: Record<string, unknown> = { pluginName: 'p', action: 'exec:run', target: 'x', approved: true };
    cyclic.self = cyclic; // JSON.stringify throws on a cyclic structure
    expect(() => writeAuditEntry(cyclic as unknown as AuditEntry)).not.toThrow();
    // A BigInt value also makes JSON.stringify throw — still swallowed.
    expect(() => writeAuditEntry({ ...entry(), bad: 10n } as unknown as AuditEntry)).not.toThrow();
  });
});
