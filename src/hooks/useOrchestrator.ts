/**
 * useOrchestrator — React hook wrapping the `window.app.orchestrator` IPC surface.
 *
 * Provides the autopilot/dispatcher UI with reactive access to dispatcher state
 * (enabled flag, last decisions, assignments) plus methods to toggle, configure,
 * force a tick, and clear the activity log. Gracefully degrades if the IPC
 * surface is missing (e.g. older main-process build).
 */

import { useCallback, useEffect, useState } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────

export type MatchingStrategy = 'best-fit' | 'round-robin' | 'random';

export interface DispatcherConfig {
  /** Master enable for the autopilot loop. */
  enabled: boolean;
  /** Polling interval in seconds between ticks. */
  intervalSeconds: number;
  /** Maximum number of tasks running concurrently under autopilot. */
  maxConcurrent: number;
  /** Strategy used to match tasks to agents. */
  matchingStrategy: MatchingStrategy;
  /** Auto-start the assigned agent (vs. just assigning it). */
  autoStart: boolean;
  /** Require human review before completion is finalized. */
  requireHumanReview: boolean;
}

export interface DispatchDecision {
  /** Stable id for this decision row. */
  id: string;
  /** Timestamp (ISO string) of the decision. */
  timestamp: string;
  /** Task that was considered/dispatched. */
  taskId: string;
  /** Agent that was selected (null if no match). */
  agentId: string | null;
  /** Match score 0–1 (best-fit). */
  score: number;
  /** Outcome: assigned, started, skipped, etc. */
  outcome: 'assigned' | 'started' | 'skipped' | 'no-match' | 'error';
  /** Human readable reason / note (e.g. "no idle agent"). */
  reason?: string;
}

export interface TaskDispatcherState {
  config: DispatcherConfig;
  /** Whether the dispatcher tick loop is actively running. */
  running: boolean;
  /** Recent decisions, newest first. */
  log: DispatchDecision[];
  /** Currently assigned (running) task ids under autopilot. */
  assignedTaskIds: string[];
  /** Last tick timestamp (ISO string), or null if never ticked. */
  lastTickAt: string | null;
}

// ── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: DispatcherConfig = {
  enabled: false,
  intervalSeconds: 30,
  maxConcurrent: 3,
  matchingStrategy: 'best-fit',
  autoStart: false,
  requireHumanReview: true,
};

const DEFAULT_STATE: TaskDispatcherState = {
  config: DEFAULT_CONFIG,
  running: false,
  log: [],
  assignedTaskIds: [],
  lastTickAt: null,
};

// ── IPC accessor ──────────────────────────────────────────────────────────

interface OrchestratorAPI {
  getState?: () => Promise<TaskDispatcherState>;
  toggle?: (enabled: boolean) => Promise<{ ok: boolean }>;
  setConfig?: (patch: Partial<DispatcherConfig>) => Promise<{ ok: boolean }>;
  getConfig?: () => Promise<DispatcherConfig>;
  forceTick?: () => Promise<{ ok: boolean }>;
  clearLog?: () => Promise<{ ok: boolean }>;
  onStateChanged?: (callback: (state: TaskDispatcherState) => void) => () => void;
}

function getOrchestratorAPI(): OrchestratorAPI | null {
  try {
    const w = window as unknown as { app?: { orchestrator?: OrchestratorAPI } };
    return w.app?.orchestrator ?? null;
  } catch {
    return null;
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────

export interface UseOrchestratorReturn {
  /** Current dispatcher state. */
  state: TaskDispatcherState;
  /** True if the orchestrator IPC surface is available. */
  available: boolean;
  /** True until the first state load resolves. */
  loading: boolean;
  /** Toggle the autopilot on/off. */
  toggle: (enabled: boolean) => Promise<void>;
  /** Patch the dispatcher config. */
  setConfig: (patch: Partial<DispatcherConfig>) => Promise<void>;
  /** Re-fetch current config. */
  getConfig: () => Promise<DispatcherConfig | null>;
  /** Force an immediate tick (debug). */
  forceTick: () => Promise<void>;
  /** Clear the activity log. */
  clearLog: () => Promise<void>;
  /** Manually re-fetch state. */
  refresh: () => Promise<void>;
}

export function useOrchestrator(): UseOrchestratorReturn {
  const api = getOrchestratorAPI();
  const available = !!api?.getState;

  const [state, setState] = useState<TaskDispatcherState>(DEFAULT_STATE);
  const [loading, setLoading] = useState<boolean>(available);

  const refresh = useCallback(async () => {
    if (!api?.getState) return;
    try {
      const next = await api.getState();
      if (next) setState(next);
    } catch (err) {
      console.warn('[useOrchestrator] getState failed:', err);
    } finally {
      setLoading(false);
    }
  }, [api]);

  // Initial load
  useEffect(() => {
    if (!available) {
      setLoading(false);
      return;
    }
    void refresh();
  }, [available, refresh]);

  // Subscribe to state changes
  useEffect(() => {
    if (!api?.onStateChanged) return;
    let cleanup: (() => void) | undefined;
    try {
      cleanup = api.onStateChanged((next) => {
        if (next) setState(next);
      });
    } catch (err) {
      console.warn('[useOrchestrator] onStateChanged failed:', err);
    }
    return () => {
      try {
        cleanup?.();
      } catch {
        /* ignore */
      }
    };
  }, [api]);

  const toggle = useCallback(
    async (enabled: boolean) => {
      if (!api?.toggle) return;
      try {
        await api.toggle(enabled);
        await refresh();
      } catch (err) {
        console.warn('[useOrchestrator] toggle failed:', err);
      }
    },
    [api, refresh],
  );

  const setConfig = useCallback(
    async (patch: Partial<DispatcherConfig>) => {
      if (!api?.setConfig) return;
      try {
        await api.setConfig(patch);
        await refresh();
      } catch (err) {
        console.warn('[useOrchestrator] setConfig failed:', err);
      }
    },
    [api, refresh],
  );

  const getConfig = useCallback(async (): Promise<DispatcherConfig | null> => {
    if (!api?.getConfig) return null;
    try {
      return await api.getConfig();
    } catch (err) {
      console.warn('[useOrchestrator] getConfig failed:', err);
      return null;
    }
  }, [api]);

  const forceTick = useCallback(async () => {
    if (!api?.forceTick) return;
    try {
      await api.forceTick();
      await refresh();
    } catch (err) {
      console.warn('[useOrchestrator] forceTick failed:', err);
    }
  }, [api, refresh]);

  const clearLog = useCallback(async () => {
    if (!api?.clearLog) return;
    try {
      await api.clearLog();
      await refresh();
    } catch (err) {
      console.warn('[useOrchestrator] clearLog failed:', err);
    }
  }, [api, refresh]);

  return {
    state,
    available,
    loading,
    toggle,
    setConfig,
    getConfig,
    forceTick,
    clearLog,
    refresh,
  };
}
