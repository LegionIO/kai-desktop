/**
 * Behavioural evaluation harness.
 *
 * Loads hand-crafted prompt files from ./smoke/*.md, runs each against the
 * pinned models for N samples, applies a deterministic rubric, scores with
 * @mastra/evals, and compares against committed baselines.
 *
 * Design notes:
 *   - Deterministic checks (length, required tokens, forbidden tokens,
 *     `required_patterns`) are the primary gate. The Mastra scorer is a
 *     secondary numeric signal compared against a per-prompt baseline
 *     (`score_mean - 2 * score_std`).
 *   - No LLM-as-judge. The rationale is documented in
 *     `../../../docs/TESTING_ARCHITECTURE.md` (Why No LLM-as-Judge) and
 *     `../../../docs/EVAL_RUBRIC.md`.
 *   - Real model calls are gated on `RUN_REAL_EVALS=1`. Without it, the
 *     harness validates structure only and exits with a recognisable
 *     "dry-run, no model" status.
 *   - Baselines containing the placeholder sentinel cause the harness to
 *     refuse to gate (graceful degradation), matching the coverage
 *     workflow's pattern.
 *
 * Exports (consumed by the unit test in `run-evals.test.ts`):
 *   - `parsePromptFile` / `discoverPrompts` — frontmatter loading.
 *   - `applyRubric` — deterministic check application.
 *   - `computeMeanStd` / `passesNumericFloor` — stats.
 *   - `loadBaseline` — baseline lookup with placeholder detection.
 *
 * The `main()` function is invoked only when this file is executed via
 * `tsx` / `node`. Importing the module never triggers the orchestration
 * loop, so the unit test can pull in the pure helpers without paying for
 * any side effects.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

// ─── Frontmatter parsing ────────────────────────────────────────────────────

export interface PromptRubric {
  length?: { min?: number; max?: number };
  required_tokens?: string[];
  forbidden_tokens?: string[];
  required_patterns?: string[];
}

export interface PromptFile {
  prompt_id: string;
  category: string;
  subcategory?: string;
  prompt: string;
  rubric: PromptRubric;
  score_floor: number;
  reference_output_hash: string;
}

/**
 * Parse a `.md` file with YAML frontmatter into a `PromptFile`.
 *
 * The frontmatter delimiter is a line containing only `---`. The first
 * `---` opens the block, the second `---` closes it. Everything between
 * the two delimiters is parsed as YAML.
 *
 * @throws if the file has no frontmatter, or the YAML is malformed, or
 *         required fields are missing.
 */
export function parsePromptFile(raw: string, sourcePath?: string): PromptFile {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new Error(
      `Prompt file is missing opening frontmatter '---' delimiter${sourcePath ? ` (${sourcePath})` : ''}`,
    );
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) {
    throw new Error(
      `Prompt file is missing closing frontmatter '---' delimiter${sourcePath ? ` (${sourcePath})` : ''}`,
    );
  }
  const yamlBlock = lines.slice(1, endIdx).join('\n');
  const parsed = parseYaml(yamlBlock) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Prompt file frontmatter did not parse to an object${sourcePath ? ` (${sourcePath})` : ''}`);
  }
  const required = ['prompt_id', 'category', 'prompt', 'rubric', 'score_floor', 'reference_output_hash'];
  for (const key of required) {
    if (!(key in parsed)) {
      throw new Error(
        `Prompt file frontmatter is missing required field '${key}'${sourcePath ? ` (${sourcePath})` : ''}`,
      );
    }
  }
  return {
    prompt_id: String(parsed.prompt_id),
    category: String(parsed.category),
    subcategory: parsed.subcategory ? String(parsed.subcategory) : undefined,
    prompt: String(parsed.prompt),
    rubric: (parsed.rubric ?? {}) as PromptRubric,
    score_floor: Number(parsed.score_floor),
    reference_output_hash: String(parsed.reference_output_hash),
  };
}

/**
 * Discover all `.md` prompt files under a directory (non-recursive).
 */
export function discoverPrompts(dir: string): PromptFile[] {
  if (!existsSync(dir)) {
    throw new Error(`Prompt directory does not exist: ${dir}`);
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  return files.sort().map((f) => {
    const path = join(dir, f);
    return parsePromptFile(readFileSync(path, 'utf8'), path);
  });
}

// ─── Deterministic rubric application ───────────────────────────────────────

export interface RubricResult {
  pass: boolean;
  failures: string[];
}

/**
 * Apply all deterministic rubric checks to a single output string.
 *
 * Length is measured in newline-separated lines (an output of N lines
 * has length N after trimming leading/trailing blank lines).
 *
 * `required_patterns` supports a small DSL:
 *   - `fenced_code:<lang>` — output must contain a fenced code block
 *     opened with the given language tag.
 *   - `count_substring:<needle>==<n>` — output must contain exactly
 *     `n` non-overlapping occurrences of `<needle>`.
 *   - `valid_json` — the trimmed output must `JSON.parse` without
 *     throwing.
 *   - `json_keys:<a>,<b>,...` — the parsed JSON object must have
 *     exactly the listed top-level keys (any order).
 *   - `json_value:<key>==<value>` — the parsed JSON's `<key>` must
 *     equal the string `<value>` interpreted as JSON (so `true`,
 *     `3`, and `"kai"` all work).
 *
 * The DSL is small on purpose — every pattern is a one-line predicate
 * whose semantics are obvious from the name. Maintainers extending the
 * rubric should add cases here and document them in `docs/EVAL_RUBRIC.md`.
 */
export function applyRubric(output: string, rubric: PromptRubric): RubricResult {
  const failures: string[] = [];
  const trimmed = output.trim();
  const nonEmptyLines = trimmed.split('\n').filter((l) => l.trim().length > 0).length;

  if (rubric.length) {
    if (typeof rubric.length.min === 'number' && nonEmptyLines < rubric.length.min) {
      failures.push(`length.min: ${nonEmptyLines} < ${rubric.length.min}`);
    }
    if (typeof rubric.length.max === 'number' && nonEmptyLines > rubric.length.max) {
      failures.push(`length.max: ${nonEmptyLines} > ${rubric.length.max}`);
    }
  }

  for (const tok of rubric.required_tokens ?? []) {
    if (!output.includes(tok)) {
      failures.push(`required_tokens: missing ${JSON.stringify(tok)}`);
    }
  }
  for (const tok of rubric.forbidden_tokens ?? []) {
    if (output.includes(tok)) {
      failures.push(`forbidden_tokens: present ${JSON.stringify(tok)}`);
    }
  }
  for (const pat of rubric.required_patterns ?? []) {
    const err = checkRequiredPattern(output, pat);
    if (err) failures.push(`required_patterns: ${err}`);
  }
  return { pass: failures.length === 0, failures };
}

function checkRequiredPattern(output: string, pattern: string): string | null {
  if (pattern.startsWith('fenced_code:')) {
    const lang = pattern.slice('fenced_code:'.length);
    const re = new RegExp('```' + escapeRegExp(lang) + '\\b');
    return re.test(output) ? null : `expected fenced code block tagged \`${lang}\``;
  }
  if (pattern.startsWith('count_substring:')) {
    const body = pattern.slice('count_substring:'.length);
    const eqIdx = body.lastIndexOf('==');
    if (eqIdx < 0) return `malformed pattern ${JSON.stringify(pattern)}`;
    const needle = body.slice(0, eqIdx);
    const expected = Number(body.slice(eqIdx + 2));
    if (!Number.isFinite(expected)) return `non-numeric count in ${JSON.stringify(pattern)}`;
    const actual = countSubstring(output, needle);
    return actual === expected
      ? null
      : `expected ${expected} occurrence(s) of ${JSON.stringify(needle)}, found ${actual}`;
  }
  if (pattern === 'valid_json') {
    try {
      JSON.parse(output.trim());
      return null;
    } catch (err) {
      return `output is not valid JSON (${(err as Error).message})`;
    }
  }
  if (pattern.startsWith('json_keys:')) {
    const expected = pattern
      .slice('json_keys:'.length)
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
      .sort();
    let parsed: unknown;
    try {
      parsed = JSON.parse(output.trim());
    } catch {
      return `json_keys requires valid JSON`;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return `json_keys requires a JSON object`;
    }
    const actual = Object.keys(parsed as Record<string, unknown>).sort();
    if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) {
      return `expected keys [${expected.join(',')}], found [${actual.join(',')}]`;
    }
    return null;
  }
  if (pattern.startsWith('json_value:')) {
    const body = pattern.slice('json_value:'.length);
    const eqIdx = body.indexOf('==');
    if (eqIdx < 0) return `malformed pattern ${JSON.stringify(pattern)}`;
    const key = body.slice(0, eqIdx);
    const rawExpected = body.slice(eqIdx + 2);
    let parsed: unknown;
    try {
      parsed = JSON.parse(output.trim());
    } catch {
      return `json_value requires valid JSON`;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return `json_value requires a JSON object`;
    }
    const actualValue = (parsed as Record<string, unknown>)[key];
    // Compare as JSON-parsed values so booleans/numbers round-trip.
    let expectedValue: unknown;
    try {
      expectedValue = JSON.parse(rawExpected);
    } catch {
      expectedValue = rawExpected;
    }
    if (actualValue !== expectedValue) {
      return `expected ${key}=${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)}`;
    }
    return null;
  }
  return `unknown required_patterns DSL: ${JSON.stringify(pattern)}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countSubstring(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const found = haystack.indexOf(needle, idx);
    if (found < 0) return count;
    count++;
    idx = found + needle.length;
  }
}

// ─── Stats ──────────────────────────────────────────────────────────────────

export interface MeanStd {
  mean: number;
  std: number;
  n: number;
}

/**
 * Sample mean and sample standard deviation (Bessel's correction).
 *
 * For n = 1, returns std = 0 — the caller should treat that as "no
 * variance estimate available, comparison is mean-only".
 */
export function computeMeanStd(values: number[]): MeanStd {
  const n = values.length;
  if (n === 0) return { mean: 0, std: 0, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { mean, std: 0, n };
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1);
  return { mean, std: Math.sqrt(variance), n };
}

/**
 * Score-against-baseline check.
 *
 * `score` must be >= `baselineMean - 2 * baselineStd`. The 2σ tolerance
 * is a deliberately loose threshold: it lets normal sampling jitter
 * pass while catching a step-change in behaviour. Rationale is
 * documented in `docs/EVAL_RUBRIC.md`.
 */
export function passesNumericFloor(score: number, baseline: MeanStd): boolean {
  return score >= baseline.mean - 2 * baseline.std;
}

// ─── Baseline loading ───────────────────────────────────────────────────────

export interface Baseline {
  model_id: string;
  prompt_id: string;
  captured_at: string;
  n_samples: number;
  score_mean: number | null;
  score_std: number | null;
  outputs_sha256: string[];
}

export interface LoadedBaseline {
  baseline: Baseline | null;
  status: 'ok' | 'placeholder' | 'missing';
  reason?: string;
}

const PLACEHOLDER_SENTINEL = 'PLACEHOLDER';

/**
 * Load a baseline file for a (modelId, promptId) pair.
 *
 * Returns one of three statuses:
 *   - `ok`: the file exists, has non-null `score_mean`/`score_std`, and
 *     the `captured_at` field does not contain the placeholder sentinel.
 *   - `placeholder`: the file exists but the `captured_at` field still
 *     contains the placeholder sentinel. The harness must NOT gate on
 *     numbers in this state.
 *   - `missing`: the file does not exist on disk. Same effect as
 *     `placeholder` — the harness cannot evaluate.
 *
 * Graceful degradation is intentional. The pattern mirrors the
 * coverage workflow's baseline-lookup behaviour.
 */
export function loadBaseline(baselineDir: string, modelId: string, promptId: string): LoadedBaseline {
  const path = join(baselineDir, modelId, `${promptId}.json`);
  if (!existsSync(path)) {
    return { baseline: null, status: 'missing', reason: `no baseline file at ${path}` };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return { baseline: null, status: 'missing', reason: `read failed: ${(err as Error).message}` };
  }
  let parsed: Baseline;
  try {
    parsed = JSON.parse(raw) as Baseline;
  } catch (err) {
    return { baseline: null, status: 'missing', reason: `JSON parse failed: ${(err as Error).message}` };
  }
  if (typeof parsed.captured_at === 'string' && parsed.captured_at.includes(PLACEHOLDER_SENTINEL)) {
    return {
      baseline: parsed,
      status: 'placeholder',
      reason: 'baseline is a placeholder; regenerate before gating',
    };
  }
  if (parsed.score_mean === null || parsed.score_std === null) {
    return {
      baseline: parsed,
      status: 'placeholder',
      reason: 'baseline score_mean or score_std is null',
    };
  }
  return { baseline: parsed, status: 'ok' };
}

// ─── Per-prompt verdict ─────────────────────────────────────────────────────

export interface PromptVerdict {
  prompt_id: string;
  model_id: string;
  /**
   * `pass`: every sample passed deterministic checks AND mean score
   *         was above the 2σ floor.
   * `fail`: at least one deterministic check failed, or the mean score
   *         fell below the floor.
   * `skipped-no-baseline`: harness ran but cannot gate because the
   *         baseline is missing or placeholder.
   * `skipped-dry-run`: harness was invoked without `RUN_REAL_EVALS=1`.
   */
  status: 'pass' | 'fail' | 'skipped-no-baseline' | 'skipped-dry-run';
  deterministic_failures: string[];
  sample_scores: number[];
  observed: MeanStd;
  baseline: Baseline | null;
  notes: string[];
}

// ─── Main orchestration (real-API path) ─────────────────────────────────────

/**
 * Compute the sha256 hex digest of a string. Used both for hashing
 * captured outputs (baseline regeneration) and for verifying captured
 * outputs against the committed checksum manifest.
 */
export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

interface PinnedModel {
  id: string;
  provider: 'anthropic' | 'openai';
}

const PINNED_MODELS: PinnedModel[] = [
  { id: 'claude-3-5-haiku-latest', provider: 'anthropic' },
  { id: 'gpt-4o-mini', provider: 'openai' },
];

const N_SAMPLES = 5;

/**
 * Render a multi-line summary suitable for stdout.
 */
export function renderSummary(verdicts: PromptVerdict[]): string {
  const lines: string[] = [];
  lines.push('# Behavioural evaluation summary');
  lines.push('');
  lines.push(`Prompts × models evaluated: ${verdicts.length}`);
  const counts = {
    pass: verdicts.filter((v) => v.status === 'pass').length,
    fail: verdicts.filter((v) => v.status === 'fail').length,
    'skipped-no-baseline': verdicts.filter((v) => v.status === 'skipped-no-baseline').length,
    'skipped-dry-run': verdicts.filter((v) => v.status === 'skipped-dry-run').length,
  };
  lines.push(`  pass:                ${counts.pass}`);
  lines.push(`  fail:                ${counts.fail}`);
  lines.push(`  skipped-no-baseline: ${counts['skipped-no-baseline']}`);
  lines.push(`  skipped-dry-run:     ${counts['skipped-dry-run']}`);
  lines.push('');
  for (const v of verdicts) {
    lines.push(`## ${v.prompt_id} × ${v.model_id} — ${v.status}`);
    if (v.deterministic_failures.length > 0) {
      lines.push(`  deterministic failures:`);
      for (const f of v.deterministic_failures) {
        lines.push(`    - ${f}`);
      }
    }
    if (v.sample_scores.length > 0) {
      lines.push(`  scores: [${v.sample_scores.map((s) => s.toFixed(3)).join(', ')}]`);
      lines.push(`  observed: mean=${v.observed.mean.toFixed(3)} std=${v.observed.std.toFixed(3)} n=${v.observed.n}`);
    }
    if (v.baseline && v.baseline.score_mean !== null && v.baseline.score_std !== null) {
      lines.push(
        `  baseline: mean=${v.baseline.score_mean.toFixed(3)} std=${v.baseline.score_std.toFixed(3)} n=${v.baseline.n_samples}`,
      );
    }
    for (const n of v.notes) {
      lines.push(`  note: ${n}`);
    }
  }
  return lines.join('\n');
}

interface MainOptions {
  promptDir: string;
  baselineDir: string;
  runReal: boolean;
  regen: boolean;
  models: PinnedModel[];
  nSamples: number;
}

/**
 * Top-level orchestration. Exported so the workflow can call it via
 * `tsx electron/__tests__/evals/run-evals.ts`. Imports are dynamic so
 * that pulling in the helpers above never instantiates a model client.
 */
export async function main(
  opts: MainOptions,
): Promise<{ exitCode: number; verdicts: PromptVerdict[]; summary: string }> {
  const prompts = discoverPrompts(opts.promptDir);
  const verdicts: PromptVerdict[] = [];

  for (const prompt of prompts) {
    for (const model of opts.models) {
      const verdict = await evaluateOne(prompt, model, opts);
      verdicts.push(verdict);
    }
  }

  const summary = renderSummary(verdicts);
  const failed = verdicts.some((v) => v.status === 'fail' || v.status === 'skipped-no-baseline');
  return { exitCode: failed ? 1 : 0, verdicts, summary };
}

async function evaluateOne(prompt: PromptFile, model: PinnedModel, opts: MainOptions): Promise<PromptVerdict> {
  const baselineResult = loadBaseline(opts.baselineDir, model.id, prompt.prompt_id);

  // Hermetic dry-run path: structure-only, no model calls.
  if (!opts.runReal) {
    return {
      prompt_id: prompt.prompt_id,
      model_id: model.id,
      status: 'skipped-dry-run',
      deterministic_failures: [],
      sample_scores: [],
      observed: { mean: 0, std: 0, n: 0 },
      baseline: baselineResult.baseline,
      notes: [
        'RUN_REAL_EVALS not set; harness validated structure only.',
        baselineResult.status !== 'ok'
          ? `baseline status: ${baselineResult.status} (${baselineResult.reason ?? ''})`
          : 'baseline status: ok',
      ],
    };
  }

  // Real-API path. Refuse to gate if the baseline is unavailable.
  if (baselineResult.status !== 'ok' && !opts.regen) {
    return {
      prompt_id: prompt.prompt_id,
      model_id: model.id,
      status: 'skipped-no-baseline',
      deterministic_failures: [],
      sample_scores: [],
      observed: { mean: 0, std: 0, n: 0 },
      baseline: baselineResult.baseline,
      notes: [
        `baseline unavailable (${baselineResult.status}): ${baselineResult.reason ?? ''}`,
        'Refusing to gate. Run with --regen-baselines after maintainer review.',
      ],
    };
  }

  // ── Dynamic-import the model SDK + the Mastra scorer. ─────────────
  // Static imports would pull these in at unit-test time and the fetch
  // firewall would flag any accidental client construction. Keeping
  // the import deferred to the real-API branch means the unit test
  // never even loads the SDK modules.
  const { runModel } = await import('./model-runner.js').catch(() => ({
    runModel: undefined as unknown as (m: PinnedModel, p: string) => Promise<string>,
  }));
  if (!runModel) {
    throw new Error('model-runner module is not implemented; cannot run real-API evaluation');
  }
  const { createKeywordCoverageScorer } = await import('@mastra/evals/scorers/prebuilt');
  const { createAgentTestRun, createTestMessage } = await import('@mastra/evals/scorers/utils');

  const scorer = createKeywordCoverageScorer();
  const sampleScores: number[] = [];
  const sampleHashes: string[] = [];
  const deterministicFailures: string[] = [];

  for (let i = 0; i < opts.nSamples; i++) {
    const output = await runModel(model, prompt.prompt);
    sampleHashes.push(sha256(output));
    const rubricResult = applyRubric(output, prompt.rubric);
    if (!rubricResult.pass) {
      deterministicFailures.push(...rubricResult.failures.map((f) => `[sample ${i}] ${f}`));
    }
    const testRun = createAgentTestRun({
      inputMessages: [createTestMessage({ content: prompt.prompt, role: 'user', id: `${prompt.prompt_id}-in-${i}` })],
      output: [createTestMessage({ content: output, role: 'assistant', id: `${prompt.prompt_id}-out-${i}` })],
    });
    const result = await scorer.run({ input: testRun.input, output: testRun.output });
    sampleScores.push(result.score);
  }

  const observed = computeMeanStd(sampleScores);

  // Regeneration mode: overwrite the baseline file and short-circuit
  // the gate. The reviewer who triggered regeneration is responsible
  // for inspecting the resulting numbers and committing them.
  if (opts.regen) {
    const newBaseline: Baseline = {
      model_id: model.id,
      prompt_id: prompt.prompt_id,
      captured_at: new Date().toISOString(),
      n_samples: opts.nSamples,
      score_mean: observed.mean,
      score_std: observed.std,
      outputs_sha256: sampleHashes,
    };
    writeFileSync(
      join(opts.baselineDir, model.id, `${prompt.prompt_id}.json`),
      `${JSON.stringify(newBaseline, null, 2)}\n`,
      'utf8',
    );
    return {
      prompt_id: prompt.prompt_id,
      model_id: model.id,
      status: 'pass',
      deterministic_failures: deterministicFailures,
      sample_scores: sampleScores,
      observed,
      baseline: newBaseline,
      notes: ['regenerated baseline; gate skipped'],
    };
  }

  // Gate evaluation.
  const baseline = baselineResult.baseline!;
  const baselineStats: MeanStd = {
    mean: baseline.score_mean ?? 0,
    std: baseline.score_std ?? 0,
    n: baseline.n_samples,
  };
  const floorOk = observed.mean >= Math.max(prompt.score_floor, baselineStats.mean - 2 * baselineStats.std);
  const status: PromptVerdict['status'] = deterministicFailures.length === 0 && floorOk ? 'pass' : 'fail';
  return {
    prompt_id: prompt.prompt_id,
    model_id: model.id,
    status,
    deterministic_failures: deterministicFailures,
    sample_scores: sampleScores,
    observed,
    baseline,
    notes: [
      `score floor = max(${prompt.score_floor}, ${baselineStats.mean.toFixed(3)} - 2 * ${baselineStats.std.toFixed(3)}) = ${Math.max(
        prompt.score_floor,
        baselineStats.mean - 2 * baselineStats.std,
      ).toFixed(3)}`,
    ],
  };
}

// ─── Script entry point ────────────────────────────────────────────────────

/**
 * Detect "run as a script". The harness only orchestrates models when
 * invoked directly (e.g. via `tsx`), never when imported. This lets the
 * unit test import the helpers without triggering any network activity.
 */
const isMain = (() => {
  if (typeof process === 'undefined') return false;
  const argv1 = process.argv?.[1];
  if (!argv1) return false;
  try {
    return fileURLToPath(import.meta.url) === argv1;
  } catch {
    return false;
  }
})();

if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const opts: MainOptions = {
    promptDir: join(here, 'smoke'),
    baselineDir: join(here, 'smoke', 'baselines'),
    runReal: process.env.RUN_REAL_EVALS === '1',
    regen: process.argv.includes('--regen-baselines'),
    models: PINNED_MODELS,
    nSamples: N_SAMPLES,
  };
  main(opts)
    .then(({ exitCode, summary }) => {
      process.stdout.write(`${summary}\n`);
      process.exit(exitCode);
    })
    .catch((err) => {
      process.stderr.write(`evals harness error: ${(err as Error).stack ?? err}\n`);
      process.exit(2);
    });
}
