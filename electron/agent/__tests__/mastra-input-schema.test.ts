// @vitest-environment node
/**
 * toMastraInputSchema enriches the opaque AJV "must NOT have additional
 * properties" validation issue (which drops the offending property name) with
 * the actual unexpected key + the allowed set, so a model that invents args
 * like `tail`/`background` on the `node`/CLI tool gets an actionable error.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { __internal } from '../mastra-agent.js';

const { toMastraInputSchema } = __internal;

// The CLI/shell tool shape: command required, cwd/timeout optional, closed.
const cliSchema = z.object({
  command: z.string(),
  cwd: z.string().optional(),
  timeout: z.number().optional(),
});

async function validate(schema: ReturnType<typeof toMastraInputSchema>, value: unknown) {
  const std = (schema as { ['~standard']: { validate: (v: unknown) => unknown } })['~standard'];
  return await std.validate(value);
}

describe('toMastraInputSchema — additional-property error enrichment', () => {
  it('names the unexpected property and lists the allowed set', async () => {
    const schema = toMastraInputSchema(cliSchema);
    const result = (await validate(schema, {
      command: "console.log('hi')",
      timeout: 15,
      cwd: '/Users/kyle boyer', // a space here is FINE — not the problem
      tail: '20',
      background: 'null',
    })) as { issues?: Array<{ message: string; path?: unknown[] }> };

    expect(result.issues && result.issues.length).toBeGreaterThan(0);
    const messages = (result.issues ?? []).map((i) => i.message);
    // Both invented keys are named (order-independent).
    const joined = messages.join(' | ');
    expect(joined).toContain('tail');
    expect(joined).toContain('background');
    // Allowed set is surfaced.
    expect(joined).toContain('command');
    // No longer the bare opaque message.
    expect(messages.every((m) => m !== 'must NOT have additional properties')).toBe(true);
    // Each enriched issue now carries a non-empty path (so `fields` populates).
    expect((result.issues ?? []).every((i) => Array.isArray(i.path) && i.path.length > 0)).toBe(true);
  });

  it('leaves a fully-valid input untouched (no issues)', async () => {
    const schema = toMastraInputSchema(cliSchema);
    const result = (await validate(schema, { command: 'ls', cwd: '/tmp', timeout: 1000 })) as {
      issues?: unknown[];
      value?: unknown;
    };
    expect(result.issues ?? []).toHaveLength(0);
  });

  it('does not touch a missing-required-field error (only additionalProperties enriched)', async () => {
    const schema = toMastraInputSchema(cliSchema);
    const result = (await validate(schema, { cwd: '/tmp' })) as { issues?: Array<{ message: string }> };
    // command is required → there IS an issue, but it's not our enriched one.
    expect((result.issues ?? []).length).toBeGreaterThan(0);
    expect((result.issues ?? []).some((i) => /additional|unexpected property/.test(i.message))).toBe(false);
  });
});
