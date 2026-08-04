import { z } from 'zod';
import { withWorkingDirectoryPrompt } from './instructions.js';
import { resolveConversationTokenization } from './tokenization.js';
import { estimateToolTokens } from './compaction.js';

/** Flat token allowance for Mastra's workspace + provider-defined tool schemas
 *  that aren't enumerated in `tools` at a given estimation site — folded into the
 *  static-input budget so it isn't over-optimistic. Conservative order-of-magnitude
 *  for the built-in file/shell/grep toolset. Shared by the media-fit budget, overflow
 *  recovery (agent.ts), and the on-demand /compact window reduction (conversations.ts)
 *  so all three charge the same static cost. */
export const WORKSPACE_TOOL_SCHEMA_TOKENS_ALLOWANCE = 3000;

/**
 * Estimate the STATIC per-request input tokens a Mastra turn submits that aren't in
 * the message branch: the assembled system prompt (base + working-directory / project
 * instructions) plus the tool schemas as the provider receives them (z.toJSONSchema,
 * which includes parameter descriptions a raw serialize omits), plus a flat allowance
 * (in tokens) for workspace/provider-defined tool schemas not enumerated in `tools`.
 * Returns TOKENS via the model's EXACT tokenizer for a canonical (o200k) model, and
 * the UTF-8 BYTE ceiling (a true upper bound) for a fallback-encoding model whose only
 * local encoder would under-count the provider. Shared so the media-fit budget,
 * overflow recovery, and /compact all charge the same static cost.
 */
/**
 * Canonical serialization of the tool schemas exactly as charged to the static-input
 * budget: name + description + inputSchema rendered via z.toJSONSchema (draft-7) — the
 * SAME form the estimator counts. Exported so /compact's static-input drift fingerprint
 * hashes identical bytes (a raw JSON.stringify of a Zod schema would miss parameter-
 * description changes that DO enlarge the sent schema).
 */
export function serializeToolSchemasForStatic(tools: readonly unknown[]): string {
  try {
    const schemas = tools.map((t) => {
      const tool = t as { name?: unknown; description?: unknown; inputSchema?: unknown };
      let parameters: unknown = tool.inputSchema;
      try {
        if (tool.inputSchema) {
          parameters = z.toJSONSchema(tool.inputSchema as Parameters<typeof z.toJSONSchema>[0], { target: 'draft-7' });
        }
      } catch {
        /* keep the raw schema reference */
      }
      return { name: tool.name, description: tool.description, parameters };
    });
    return JSON.stringify(schemas) ?? '';
  } catch {
    return '';
  }
}

export async function estimateStaticRequestTokens(
  baseSystemPrompt: string,
  cwd: string | undefined,
  tools: readonly unknown[],
  extraSchemaAllowanceTokens: number,
  modelName?: string,
): Promise<number> {
  let assembledPrompt = baseSystemPrompt ?? '';
  try {
    assembledPrompt = await withWorkingDirectoryPrompt(baseSystemPrompt ?? '', cwd);
  } catch {
    /* best-effort — use the base prompt */
  }
  const schemaText = serializeToolSchemasForStatic(tools);
  // Token count of the assembled prompt + serialized schemas. Use the model's REAL
  // encoder only when it's the CANONICAL one (o200k models); for a model whose only
  // local encoder is the fallback (Claude/Gemini/Bedrock/etc.), the fallback encode
  // can UNDER-count the provider, so use the tokenizer-independent UTF-8 BYTE ceiling
  // (a true upper bound). Allowance is already token-valued.
  const staticText = `${assembledPrompt}\n${schemaText}`;
  const tok = modelName ? resolveConversationTokenization(modelName) : undefined;
  const staticTokens =
    tok?.encoding && !tok.isFallbackEncoding
      ? estimateToolTokens(staticText, modelName)
      : Buffer.byteLength(staticText, 'utf8');
  return staticTokens + Math.max(0, extraSchemaAllowanceTokens);
}
