export type PartialTypingMode = 'ax' | 'kb';

export type PartialTypingStrategy = 'disabled' | 'full-replacement' | 'ax-verified' | 'tail-only' | 'full-patch';

export type PartialTypingConfig = Partial<Record<PartialTypingMode, PartialTypingStrategy>>;

export type PartialTypingConfigSource = {
  livePartials?: boolean;
  partialTyping?: PartialTypingConfig;
};

export const PARTIAL_STRATEGIES_BY_MODE: Record<PartialTypingMode, ReadonlySet<PartialTypingStrategy>> = {
  ax: new Set(['disabled', 'full-replacement', 'ax-verified']),
  kb: new Set(['disabled', 'ax-verified', 'tail-only', 'full-patch']),
};

export function normalizePartialTypingStrategy(
  mode: PartialTypingMode,
  strategy: PartialTypingStrategy,
): PartialTypingStrategy {
  if (PARTIAL_STRATEGIES_BY_MODE[mode].has(strategy)) return strategy;
  return mode === 'ax' ? 'full-replacement' : 'ax-verified';
}

export function getPartialTypingStrategyForConfig(
  source: PartialTypingConfigSource | null | undefined,
  mode: PartialTypingMode,
): PartialTypingStrategy {
  const configured = source?.partialTyping?.[mode];
  if (configured) return normalizePartialTypingStrategy(mode, configured);

  // Backward compatibility for configs that only have the old boolean.
  if (source?.livePartials) {
    return mode === 'ax' ? 'full-replacement' : 'disabled';
  }

  return 'disabled';
}

export function hasEnabledPartialTypingStrategy(source: PartialTypingConfigSource | null | undefined): boolean {
  return getPartialTypingStrategyForConfig(source, 'ax') !== 'disabled'
    || getPartialTypingStrategyForConfig(source, 'kb') !== 'disabled';
}

export function resolveActivePartialTypingMode(
  source: PartialTypingConfigSource | null | undefined,
  hasAxSpan: boolean,
  axSuppressed: boolean,
): PartialTypingMode {
  const canUseAx = hasAxSpan && !axSuppressed;
  if (canUseAx && getPartialTypingStrategyForConfig(source, 'ax') !== 'disabled') {
    return 'ax';
  }
  if (getPartialTypingStrategyForConfig(source, 'kb') !== 'disabled') {
    return 'kb';
  }
  return canUseAx ? 'ax' : 'kb';
}
