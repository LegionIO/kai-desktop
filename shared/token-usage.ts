export type TokenUsageData = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
};

const INPUT_KEYS = ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens'];
const OUTPUT_KEYS = ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens'];
const CACHE_READ_KEYS = [
  'cacheReadTokens',
  'cache_read_tokens',
  'cacheReadInputTokens',
  'cache_read_input_tokens',
  'cachedInputTokens',
  'cached_input_tokens',
];
const CACHE_WRITE_KEYS = [
  'cacheWriteTokens',
  'cache_write_tokens',
  'cacheCreationInputTokens',
  'cache_creation_input_tokens',
];
const TOTAL_KEYS = ['totalTokens', 'total_tokens'];

function toTokenCount(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && value.trim().length === 0) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

function readTokenCount(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const count = toTokenCount(record[key]);
    if (count !== undefined) return count;
  }
  const usage = record.usage;
  if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
    for (const key of keys) {
      const count = toTokenCount((usage as Record<string, unknown>)[key]);
      if (count !== undefined) return count;
    }
  }
  return undefined;
}

export function normalizeTokenUsage(value: unknown): TokenUsageData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const inputTokens = readTokenCount(record, INPUT_KEYS);
  const outputTokens = readTokenCount(record, OUTPUT_KEYS);
  const cacheReadTokens = readTokenCount(record, CACHE_READ_KEYS);
  const cacheWriteTokens = readTokenCount(record, CACHE_WRITE_KEYS);
  const totalTokens = readTokenCount(record, TOTAL_KEYS);

  if (
    inputTokens === undefined
    && outputTokens === undefined
    && cacheReadTokens === undefined
    && cacheWriteTokens === undefined
    && totalTokens === undefined
  ) {
    return null;
  }

  const normalizedInput = inputTokens ?? 0;
  const normalizedOutput = outputTokens ?? 0;
  return {
    inputTokens: normalizedInput,
    outputTokens: normalizedOutput,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
    totalTokens: totalTokens ?? normalizedInput + normalizedOutput,
  };
}
