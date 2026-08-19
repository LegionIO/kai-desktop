import type { AppConfig } from '../config/schema.js';

type BrowserConfig = AppConfig['browser'];

const BROWSER_CONTROL_POLICY_RANK = { allow: 0, ask: 1, deny: 2 } as const;
const BROWSER_PASSWORD_POLICY_RANK = { automatic: 0, ask: 1, 'user-only': 2 } as const;
const CONFIG_RECOVERY_INITIAL_DELAY_MS = 250;
const CONFIG_RECOVERY_MAX_DELAY_MS = 30_000;

function assistantPolicyTightened(previous: BrowserConfig, next: BrowserConfig): boolean {
  return (
    BROWSER_CONTROL_POLICY_RANK[next.readAccess] > BROWSER_CONTROL_POLICY_RANK[previous.readAccess] ||
    BROWSER_CONTROL_POLICY_RANK[next.structuredActions] > BROWSER_CONTROL_POLICY_RANK[previous.structuredActions] ||
    BROWSER_CONTROL_POLICY_RANK[next.scriptInjection] > BROWSER_CONTROL_POLICY_RANK[previous.scriptInjection] ||
    BROWSER_PASSWORD_POLICY_RANK[next.passwordAccess] > BROWSER_PASSWORD_POLICY_RANK[previous.passwordAccess]
  );
}

export type BrowserConfigTransitionManager = {
  handleConfigChanged: (config: BrowserConfig) => Promise<BrowserConfigTransitionResult>;
};

export type BrowserConfigTransitionResult = Readonly<{
  committed: boolean;
}>;

export type BrowserConfigTransitionCoordinator = {
  handle: (config: BrowserConfig) => void;
  isPending: () => boolean;
};

type BrowserConfigTransitionOptions = {
  initialConfig: BrowserConfig;
  getManager: () => BrowserConfigTransitionManager | null;
  getPersistedConfig: () => BrowserConfig;
  rollbackConfig: (config: BrowserConfig) => void;
  onAssistantAuthorityRevoked: () => void;
  onTransitionCommitted?: (config: BrowserConfig) => void;
  onError: (error: unknown) => void;
};

function cloneBrowserConfig(config: BrowserConfig): BrowserConfig {
  return { ...config };
}

function sameBrowserConfig(left: BrowserConfig, right: BrowserConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Coordinates persisted Browser settings with BrowserManager's asynchronous
 * Chromium/profile transition. Config IPC writes are intentionally synchronous,
 * so a failed transition is compensated by restoring the last config the native
 * manager actually applied. Generation + persisted-value checks prevent an older
 * failure from rolling back a newer Settings write.
 */
export function createBrowserConfigTransitionCoordinator(
  options: BrowserConfigTransitionOptions,
): BrowserConfigTransitionCoordinator {
  let generation = 0;
  let lastObservedEnabled = options.initialConfig.enabled;
  let lastObservedDataScope = options.initialConfig.dataScope;
  let lastObservedPolicy = cloneBrowserConfig(options.initialConfig);
  let lastAppliedConfig = cloneBrowserConfig(options.initialConfig);
  let pendingGeneration: number | null = null;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryDelayMs = CONFIG_RECOVERY_INITIAL_DELAY_MS;

  const cancelRecoveryTimer = (): void => {
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryTimer = null;
    recoveryDelayMs = CONFIG_RECOVERY_INITIAL_DELAY_MS;
  };

  let handleConfig: (config: BrowserConfig) => void;

  const scheduleRecovery = (requestGeneration: number, target: BrowserConfig): void => {
    if (requestGeneration !== generation || recoveryTimer) return;
    const delayMs = recoveryDelayMs;
    recoveryDelayMs = Math.min(recoveryDelayMs * 2, CONFIG_RECOVERY_MAX_DELAY_MS);
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      attemptRecovery(requestGeneration, target);
    }, delayMs);
    recoveryTimer.unref?.();
  };

  const attemptRecovery = (requestGeneration: number, target: BrowserConfig): void => {
    if (requestGeneration !== generation) return;

    let persisted: BrowserConfig;
    try {
      persisted = options.getPersistedConfig();
    } catch (readError) {
      options.onError(readError);
      scheduleRecovery(requestGeneration, target);
      return;
    }

    // An external writer won the race after this transition started. Reconcile
    // Chromium to that authoritative value immediately instead of leaving the
    // old failed generation as a permanent tool-publication hold.
    if (!sameBrowserConfig(persisted, target)) {
      handleConfig(persisted);
      return;
    }

    try {
      options.rollbackConfig(cloneBrowserConfig(lastAppliedConfig));
    } catch (rollbackError) {
      options.onError(rollbackError);
      scheduleRecovery(requestGeneration, target);
      return;
    }

    // Production rollbackConfig synchronously republishes the restored config
    // and therefore starts a newer generation. A non-reentrant adapter has still
    // completed the compensating write; settle this failed generation without
    // publishing tools. A future config notification/window reads the restored
    // value, while a permanently failing manager cannot spin in a microtask loop.
    if (requestGeneration === generation && pendingGeneration === requestGeneration) {
      pendingGeneration = null;
    }
  };

  handleConfig = (config) => {
    cancelRecoveryTimer();
    const target = cloneBrowserConfig(config);
    const requestGeneration = ++generation;
    pendingGeneration = requestGeneration;

    // Disabling Browser and swapping its authenticated Chromium partition are
    // both capability boundaries. A turn admitted against conversation data
    // must not continue in the global profile (or vice versa).
    const policyTightened = assistantPolicyTightened(lastObservedPolicy, target);
    if ((lastObservedEnabled && !target.enabled) || target.dataScope !== lastObservedDataScope || policyTightened) {
      try {
        options.onAssistantAuthorityRevoked();
      } catch (error) {
        options.onError(error);
      }
    }
    lastObservedEnabled = target.enabled;
    lastObservedDataScope = target.dataScope;
    lastObservedPolicy = target;

    const manager = options.getManager();
    if (!manager) {
      lastAppliedConfig = target;
      if (pendingGeneration === requestGeneration) pendingGeneration = null;
      try {
        options.onTransitionCommitted?.(cloneBrowserConfig(target));
      } catch (error) {
        options.onError(error);
      }
      return;
    }

    // Defer the call so a manager implementation that throws synchronously
    // enters the same guarded rejection/rollback path as an async failure.
    void Promise.resolve()
      .then(() => manager.handleConfigChanged(target))
      .then((result) => {
        // Superseded requests still finish their fail-closed drains, but the
        // manager deliberately resolves them without publishing their stale
        // policy/profile state. Only a committed result is a rollback base.
        if (!result.committed) return;
        lastAppliedConfig = target;
        if (requestGeneration !== generation) return;
        if (pendingGeneration === requestGeneration) pendingGeneration = null;
        try {
          options.onTransitionCommitted?.(cloneBrowserConfig(target));
        } catch (error) {
          options.onError(error);
        }
      })
      .catch((error) => {
        options.onError(error);
        if (requestGeneration !== generation) return;
        attemptRecovery(requestGeneration, target);
      });
  };

  return {
    isPending: () => pendingGeneration !== null,
    handle: handleConfig,
  };
}
