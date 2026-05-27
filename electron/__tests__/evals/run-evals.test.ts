/**
 * Hermetic unit test for the behavioural eval harness.
 *
 * This file exercises only the pure helpers exported from `run-evals.ts`:
 *   - `parsePromptFile` / `discoverPrompts` — frontmatter parsing.
 *   - `applyRubric` — deterministic check application.
 *   - `computeMeanStd` / `passesNumericFloor` — stats.
 *   - `loadBaseline` — baseline lookup with placeholder detection.
 *
 * Nothing in this test instantiates a model client, opens a network
 * connection, or imports `model-runner.ts`. The fetch firewall in
 * `vitest.setup.ts` would catch a regression on that front, but the
 * harness deliberately separates the pure logic from the SDK touchpoint
 * so this test pays no startup cost for the AI SDK packages.
 *
 * The committed prompt files under `./smoke/` are also used as
 * fixtures: a single `discoverPrompts` call should round-trip all ten
 * without throwing, and every one must declare the required frontmatter
 * fields.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import {
  applyRubric,
  computeMeanStd,
  discoverPrompts,
  loadBaseline,
  parsePromptFile,
  passesNumericFloor,
  renderSummary,
  sha256,
} from '../evals/run-evals.js';
import type { PromptVerdict, PromptRubric } from '../evals/run-evals.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SMOKE_DIR = join(HERE, '..', 'evals', 'smoke');
const BASELINE_DIR = join(SMOKE_DIR, 'baselines');

describe('parsePromptFile', () => {
  it('parses valid frontmatter into a PromptFile', () => {
    const raw = [
      '---',
      'prompt_id: t-001',
      'category: competence',
      'prompt: |',
      '  do the thing',
      'rubric:',
      '  required_tokens: ["foo", "bar"]',
      'score_floor: 0.7',
      'reference_output_hash: deadbeef',
      '---',
      '',
      '# notes',
    ].join('\n');
    const parsed = parsePromptFile(raw);
    expect(parsed.prompt_id).toBe('t-001');
    expect(parsed.category).toBe('competence');
    expect(parsed.prompt.trim()).toBe('do the thing');
    expect(parsed.rubric.required_tokens).toEqual(['foo', 'bar']);
    expect(parsed.score_floor).toBe(0.7);
    expect(parsed.reference_output_hash).toBe('deadbeef');
  });

  it('throws if opening delimiter is missing', () => {
    expect(() => parsePromptFile('no frontmatter here\n')).toThrow(/opening frontmatter/);
  });

  it('throws if closing delimiter is missing', () => {
    expect(() => parsePromptFile('---\nprompt_id: x\n')).toThrow(/closing frontmatter/);
  });

  it('throws if required field is missing', () => {
    const raw = [
      '---',
      'prompt_id: t-002',
      'category: competence',
      // intentionally missing prompt, rubric, score_floor, reference_output_hash
      '---',
    ].join('\n');
    expect(() => parsePromptFile(raw)).toThrow(/missing required field/);
  });
});

describe('discoverPrompts: real smoke directory', () => {
  it('loads every .md file under smoke/ without throwing', () => {
    const prompts = discoverPrompts(SMOKE_DIR);
    expect(prompts.length).toBeGreaterThanOrEqual(10);
    for (const p of prompts) {
      expect(p.prompt_id).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(['competence', 'usage']).toContain(p.category);
      expect(p.prompt.length).toBeGreaterThan(0);
      expect(typeof p.score_floor).toBe('number');
      expect(p.score_floor).toBeGreaterThan(0);
      expect(p.score_floor).toBeLessThanOrEqual(1);
    }
  });

  it('produces unique prompt_ids', () => {
    const prompts = discoverPrompts(SMOKE_DIR);
    const ids = prompts.map((p) => p.prompt_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers the eight required categories', () => {
    const prompts = discoverPrompts(SMOKE_DIR);
    const subcats = new Set(prompts.map((p) => p.subcategory).filter(Boolean));
    // Per the rubric design these eight must all be present; two more
    // are maintainer-judgment slots (structured-output-json,
    // tool-use-with-error) — checked individually.
    const expectedCore = [
      'code-gen',
      'explain',
      'refactor',
      'debug',
      'write-tests',
      'write-docs',
      'search',
      'conversation-continuation',
    ];
    for (const c of expectedCore) {
      expect(subcats).toContain(c);
    }
    expect(subcats).toContain('structured-output-json');
    expect(subcats).toContain('tool-use-with-error');
  });
});

describe('applyRubric: deterministic checks', () => {
  it('passes a fully-conforming output', () => {
    const rubric: PromptRubric = {
      length: { min: 2, max: 5 },
      required_tokens: ['foo', 'bar'],
      forbidden_tokens: ['baz'],
      required_patterns: ['fenced_code:typescript'],
    };
    const output = ['```typescript', 'const foo = 1;', 'const bar = 2;', '```'].join('\n');
    const r = applyRubric(output, rubric);
    expect(r.pass).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it('flags missing required tokens', () => {
    const rubric: PromptRubric = { required_tokens: ['absent-needle'] };
    const r = applyRubric('different content', rubric);
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toMatch(/required_tokens.*absent-needle/);
  });

  it('flags forbidden tokens', () => {
    const rubric: PromptRubric = { forbidden_tokens: ['secret'] };
    const r = applyRubric('this output contains the secret word', rubric);
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toMatch(/forbidden_tokens.*secret/);
  });

  it('enforces length.min', () => {
    const rubric: PromptRubric = { length: { min: 3 } };
    const r = applyRubric('one line only', rubric);
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toMatch(/length\.min/);
  });

  it('enforces length.max', () => {
    const rubric: PromptRubric = { length: { max: 2 } };
    const r = applyRubric('a\nb\nc\nd', rubric);
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toMatch(/length\.max/);
  });

  it('flags a missing fenced code block', () => {
    const rubric: PromptRubric = { required_patterns: ['fenced_code:typescript'] };
    const r = applyRubric('plain prose, no fence', rubric);
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toMatch(/fenced code block tagged `typescript`/);
  });

  it('counts substring occurrences exactly', () => {
    const rubric: PromptRubric = { required_patterns: ['count_substring:it(==3'] };
    const passOutput = ['it(', 'it(', 'it('].join('\n');
    const failOutput = ['it(', 'it('].join('\n');
    expect(applyRubric(passOutput, rubric).pass).toBe(true);
    expect(applyRubric(failOutput, rubric).pass).toBe(false);
  });

  it('accepts valid_json and rejects non-JSON', () => {
    const rubric: PromptRubric = { required_patterns: ['valid_json'] };
    expect(applyRubric('{"a": 1}', rubric).pass).toBe(true);
    expect(applyRubric('not json', rubric).pass).toBe(false);
  });

  it('checks json_keys exact match', () => {
    const rubric: PromptRubric = { required_patterns: ['json_keys:name,count,active'] };
    expect(applyRubric('{"name":"x","count":1,"active":true}', rubric).pass).toBe(true);
    expect(applyRubric('{"name":"x","count":1}', rubric).pass).toBe(false);
    expect(applyRubric('{"name":"x","count":1,"active":true,"extra":1}', rubric).pass).toBe(false);
  });

  it('checks json_value equality with JSON-parsed RHS', () => {
    const rubric: PromptRubric = {
      required_patterns: ['json_value:active==true', 'json_value:count==3', 'json_value:name==kai'],
    };
    expect(applyRubric('{"name":"kai","count":3,"active":true}', rubric).pass).toBe(true);
    expect(applyRubric('{"name":"kai","count":3,"active":false}', rubric).pass).toBe(false);
  });

  it('reports unknown pattern DSL as a failure rather than throwing', () => {
    const rubric: PromptRubric = { required_patterns: ['unknown_dsl:something'] };
    const r = applyRubric('any output', rubric);
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toMatch(/unknown required_patterns DSL/);
  });

  it('handles empty rubric (no constraints) by passing', () => {
    const r = applyRubric('anything goes', {});
    expect(r.pass).toBe(true);
  });
});

describe('computeMeanStd', () => {
  it('returns zeros for an empty array', () => {
    expect(computeMeanStd([])).toEqual({ mean: 0, std: 0, n: 0 });
  });

  it('returns std = 0 for a single value', () => {
    expect(computeMeanStd([0.5])).toEqual({ mean: 0.5, std: 0, n: 1 });
  });

  it('computes sample mean and stddev correctly', () => {
    const r = computeMeanStd([0.8, 0.9, 1.0]);
    expect(r.n).toBe(3);
    expect(r.mean).toBeCloseTo(0.9, 10);
    // Sample stddev of [0.8, 0.9, 1.0] = sqrt(((0.1)^2 + 0 + (0.1)^2) / 2) = 0.1
    expect(r.std).toBeCloseTo(0.1, 6);
  });
});

describe('passesNumericFloor', () => {
  it('passes when score is at or above mean - 2*std', () => {
    // Use a slight margin so floating-point rounding cannot trip the
    // boundary case: 0.8 - 2 * 0.1 = 0.6000000000000001 in IEEE-754.
    expect(passesNumericFloor(0.61, { mean: 0.8, std: 0.1, n: 5 })).toBe(true);
  });

  it('passes when score is well above the floor', () => {
    expect(passesNumericFloor(0.75, { mean: 0.8, std: 0.1, n: 5 })).toBe(true);
  });

  it('fails when score is below the floor', () => {
    expect(passesNumericFloor(0.55, { mean: 0.8, std: 0.1, n: 5 })).toBe(false);
  });

  it('with std = 0, the floor degenerates to the mean', () => {
    expect(passesNumericFloor(0.79, { mean: 0.8, std: 0, n: 1 })).toBe(false);
    expect(passesNumericFloor(0.8, { mean: 0.8, std: 0, n: 1 })).toBe(true);
  });
});

describe('loadBaseline: graceful degradation', () => {
  it('returns status=missing when no file exists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'eval-baseline-'));
    try {
      const r = loadBaseline(tmp, 'model-x', 'prompt-y');
      expect(r.status).toBe('missing');
      expect(r.baseline).toBeNull();
      expect(r.reason).toMatch(/no baseline file/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns status=placeholder when captured_at contains the sentinel', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'eval-baseline-'));
    try {
      mkdirSync(join(tmp, 'model-x'), { recursive: true });
      writeFileSync(
        join(tmp, 'model-x', 'prompt-y.json'),
        JSON.stringify({
          model_id: 'model-x',
          prompt_id: 'prompt-y',
          captured_at: 'PLACEHOLDER - regenerate before enabling workflow',
          n_samples: 5,
          score_mean: null,
          score_std: null,
          outputs_sha256: [],
        }),
        'utf8',
      );
      const r = loadBaseline(tmp, 'model-x', 'prompt-y');
      expect(r.status).toBe('placeholder');
      expect(r.baseline).not.toBeNull();
      expect(r.reason).toMatch(/placeholder/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns status=placeholder when score_mean or score_std is null', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'eval-baseline-'));
    try {
      mkdirSync(join(tmp, 'model-x'), { recursive: true });
      writeFileSync(
        join(tmp, 'model-x', 'prompt-y.json'),
        JSON.stringify({
          model_id: 'model-x',
          prompt_id: 'prompt-y',
          captured_at: '2026-05-19T07:00:00Z',
          n_samples: 5,
          score_mean: null,
          score_std: null,
          outputs_sha256: [],
        }),
        'utf8',
      );
      const r = loadBaseline(tmp, 'model-x', 'prompt-y');
      expect(r.status).toBe('placeholder');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns status=ok for a fully-populated baseline', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'eval-baseline-'));
    try {
      mkdirSync(join(tmp, 'model-x'), { recursive: true });
      writeFileSync(
        join(tmp, 'model-x', 'prompt-y.json'),
        JSON.stringify({
          model_id: 'model-x',
          prompt_id: 'prompt-y',
          captured_at: '2026-05-19T07:00:00Z',
          n_samples: 5,
          score_mean: 0.82,
          score_std: 0.04,
          outputs_sha256: ['abc', 'def', 'ghi', 'jkl', 'mno'],
        }),
        'utf8',
      );
      const r = loadBaseline(tmp, 'model-x', 'prompt-y');
      expect(r.status).toBe('ok');
      expect(r.baseline?.score_mean).toBe(0.82);
      expect(r.baseline?.score_std).toBe(0.04);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns status=missing when JSON parse fails', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'eval-baseline-'));
    try {
      mkdirSync(join(tmp, 'model-x'), { recursive: true });
      writeFileSync(join(tmp, 'model-x', 'prompt-y.json'), 'not valid json', 'utf8');
      const r = loadBaseline(tmp, 'model-x', 'prompt-y');
      expect(r.status).toBe('missing');
      expect(r.reason).toMatch(/parse failed/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('committed baselines: all real prompt × model pairs are placeholders', () => {
  // A committed baseline that is not a placeholder would mean a maintainer
  // actually captured real model output and accepted those numbers as the
  // gate. Until that happens, every committed baseline file must still
  // carry the sentinel string in `captured_at`.
  it('every committed baseline file is still a placeholder', () => {
    expect(existsSync(BASELINE_DIR)).toBe(true);
    const prompts = discoverPrompts(SMOKE_DIR);
    const models = ['claude-3-5-haiku-latest', 'gpt-4o-mini'];
    for (const m of models) {
      for (const p of prompts) {
        const r = loadBaseline(BASELINE_DIR, m, p.prompt_id);
        // Each committed file must exist (status != 'missing') and must
        // be a placeholder (status === 'placeholder').
        expect(r.status, `expected placeholder for ${m}/${p.prompt_id}, got ${r.status}`).toBe('placeholder');
      }
    }
  });
});

describe('renderSummary', () => {
  it('renders a human-readable summary with status counts and per-prompt detail', () => {
    const verdicts: PromptVerdict[] = [
      {
        prompt_id: 'a',
        model_id: 'm1',
        status: 'pass',
        deterministic_failures: [],
        sample_scores: [0.9, 0.85],
        observed: { mean: 0.875, std: 0.025, n: 2 },
        baseline: {
          model_id: 'm1',
          prompt_id: 'a',
          captured_at: '2026-05-19T07:00:00Z',
          n_samples: 5,
          score_mean: 0.8,
          score_std: 0.05,
          outputs_sha256: [],
        },
        notes: [],
      },
      {
        prompt_id: 'b',
        model_id: 'm1',
        status: 'fail',
        deterministic_failures: ['required_tokens: missing "foo"'],
        sample_scores: [0.1],
        observed: { mean: 0.1, std: 0, n: 1 },
        baseline: null,
        notes: ['the rubric expected foo'],
      },
    ];
    const out = renderSummary(verdicts);
    expect(out).toContain('Prompts × models evaluated: 2');
    expect(out).toContain('pass:                1');
    expect(out).toContain('fail:                1');
    expect(out).toContain('## a × m1 — pass');
    expect(out).toContain('## b × m1 — fail');
    expect(out).toContain('required_tokens: missing "foo"');
  });
});

describe('sha256', () => {
  it('produces the standard SHA-256 of an empty string', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('is deterministic across calls', () => {
    const s = 'the quick brown fox jumps over the lazy dog';
    expect(sha256(s)).toBe(sha256(s));
  });
});
