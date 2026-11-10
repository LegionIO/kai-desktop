import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { readBoundedFile } from './files.js';
import type { BridgeActivity } from '../../shared/plugin-bridge.js';

const grantSchema = z.object({
  pluginId: z.string().optional(),
  access: z.array(z.string()),
  approvedAt: z.string(),
  allowOverlap: z.boolean().default(false),
});
const stateSchema = z.object({
  version: z.literal(1),
  instanceId: z.string(),
  importsEnabled: z.boolean().default(false),
  sharingEnabled: z.boolean().default(false),
  remoteEnabled: z.boolean().default(false),
  grants: z.record(z.string(), grantSchema).default({}),
  installations: z.record(z.string(), z.string()).default({}),
  exportSources: z.array(z.string()).default([]),
  exportTools: z.array(z.string()).default([]),
});
export type BridgeState = z.infer<typeof stateSchema>;

/** Kept separate from ordinary config: no general config setter accepts grants. */
export class BridgeStateStore {
  private state: BridgeState;
  private readonly path: string;
  private readonly activity: BridgeActivity[] = [];
  private readError = false;

  constructor(appHome: string) {
    this.path = join(appHome, 'plugin-bridge', 'approvals.json');
    this.state = stateSchema.parse({ version: 1, instanceId: randomUUID() });
    if (existsSync(this.path)) {
      // A corrupt approval ledger must never become an empty, overwriteable ledger.
      try {
        this.state = stateSchema.parse(JSON.parse(readBoundedFile(this.path)));
      } catch {
        this.readError = true;
        this.record(
          'error',
          'Bridge approval storage could not be read. Bridge access is disabled; repair the approval file before making changes.',
        );
      }
    }
  }
  get(): BridgeState {
    return structuredClone(this.state);
  }
  update(change: (state: BridgeState) => void): void {
    if (this.readError)
      throw new Error('Bridge approval storage is unreadable. Existing approvals have not been overwritten.');
    const next = this.get();
    change(next);
    const validated = stateSchema.parse(next);
    mkdirSync(join(this.path, '..'), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(this.path, JSON.stringify(validated, null, 2), { mode: 0o600 });
    this.state = validated;
  }
  record(kind: BridgeActivity['kind'], message: string, sourceId?: string): void {
    this.activity.unshift({ id: randomUUID(), at: new Date().toISOString(), kind, message, sourceId });
    this.activity.length = Math.min(this.activity.length, 200);
  }
  recent(): BridgeActivity[] {
    return structuredClone(this.activity);
  }
}

export function assertBridgeConfigWriteAllowed(path: string): void {
  if (['pluginBridge', 'mcpExport'].some((key) => path === key || path.startsWith(`${key}.`)) || !path) {
    throw new Error('Plugin Bridge settings require the dedicated human approval controls.');
  }
}
