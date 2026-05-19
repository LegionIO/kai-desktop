# Evaluation Rubric

This document is the design reference for the behavioural evaluation harness
that lives under [`electron/__tests__/evals/`](../electron/__tests__/evals/)
and runs on the nightly cadence via
[`.github/workflows/evals.yml`](../.github/workflows/evals.yml).

The harness is deliberately small. Its goal is to detect when a pinned
model's behaviour drifts in a way that the deterministic rubric — written
once, by hand — can see. It is not a leaderboard, not a model-quality
benchmark, and not a per-PR merge gate.

Companion reading: [`docs/TESTING_ARCHITECTURE.md`](TESTING_ARCHITECTURE.md)
explains why the pipeline avoids LLM-as-judge graders; this doc explains
how the deterministic alternative is constructed and extended.

## What "Behavioural Evaluation" Means Here

A behavioural evaluation in this repo has three layers, applied in this
order:

1. **Deterministic rubric checks.** The output is a string. The rubric
   makes a small set of predicates on that string — length, required
   substrings, forbidden substrings, structural patterns. Every check is
   a one-line predicate whose semantics are obvious from the rubric
   field name. No NLP, no embeddings, no judge model.

2. **Numeric rubric (Mastra scorer).** A deterministic scorer from
   `@mastra/evals` produces a single number in [0, 1]. The harness uses
   the `keyword-coverage` scorer, which counts how many of the prompt's
   declared keywords appear in the response, normalised. This number is
   compared against a model-pinned baseline (`score_mean ± 2σ`).

3. **No third layer.** There is no LLM-as-judge step. The rationale is
   documented in detail in `TESTING_ARCHITECTURE.md` (Why No LLM-as-Judge):
   the version-skew problem makes a judge model's score uncorrelated
   with the target model's actual quality change.

The two layers are AND-combined. A prompt passes iff every deterministic
check passes **and** the mean score is above the floor.

## Prompt-File Schema

Each prompt lives in a single `.md` file under
[`electron/__tests__/evals/smoke/`](../electron/__tests__/evals/smoke/).
The file uses YAML frontmatter for the rubric and a markdown body for
maintainer notes.

```markdown
---
prompt_id: code-gen-001 # globally unique kebab-case identifier
category: competence # competence | usage
subcategory: code-gen # human-readable refinement of the category
prompt: |
  Write a TypeScript function ...
rubric:
  length:
    min: 6 # minimum non-empty output lines (inclusive)
    max: 40 # maximum non-empty output lines (inclusive)
  required_tokens: # every entry must appear as a substring
    - 'function'
    - 'fib'
    - 'return'
  forbidden_tokens: # no entry may appear as a substring
    - 'Math.random'
  required_patterns: # see "Patterns DSL" below
    - 'fenced_code:typescript'
score_floor: 0.7 # minimum numeric score before baseline 2σ
reference_output_hash: PLACEHOLDER # sha256 of N=5 reference outputs, computed during baseline regen
---

# code-gen-001

Free-form notes for maintainers reading the file by hand.
```

### Frontmatter Field Reference

| Field                      | Type     | Required | Notes                                                                                                                                                                                   |
| -------------------------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt_id`                | string   | yes      | Globally unique identifier. Used as the filename stem and as the key in baselines.                                                                                                      |
| `category`                 | string   | yes      | One of `competence` or `usage`. The harness uses this purely for reporting; the gate is per-prompt.                                                                                     |
| `subcategory`              | string   | no       | Maintainer-readable refinement, e.g. `code-gen`, `explain`, `search`.                                                                                                                   |
| `prompt`                   | string   | yes      | The text the harness sends to the model. Multi-line allowed via the YAML block style (a `\|` literal followed by an indented block).                                                    |
| `rubric.length.min`        | integer  | no       | Minimum non-empty output lines after trimming.                                                                                                                                          |
| `rubric.length.max`        | integer  | no       | Maximum non-empty output lines after trimming.                                                                                                                                          |
| `rubric.required_tokens`   | string[] | no       | Each entry must appear as a substring of the output. Case-sensitive.                                                                                                                    |
| `rubric.forbidden_tokens`  | string[] | no       | No entry may appear as a substring of the output. Case-sensitive.                                                                                                                       |
| `rubric.required_patterns` | string[] | no       | Structural predicates expressed as a small DSL — see below.                                                                                                                             |
| `score_floor`              | number   | yes      | Minimum numeric score from the Mastra scorer in addition to the baseline 2σ check. Acts as an absolute floor so a per-model baseline regression cannot drag the gate down indefinitely. |
| `reference_output_hash`    | string   | yes      | Currently the literal `PLACEHOLDER`. Replaced with a real sha256 by `pnpm test:evals -- --regen-baselines`. The hash is informational; it is not consulted by the gate.                 |

### Patterns DSL

The `required_patterns` field uses a tiny domain-specific language. Each
pattern is a one-line string that the harness parses and evaluates:

| Pattern                         | Meaning                                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fenced_code:<lang>`            | Output must contain a fenced code block opened with ` ``` ` followed by `<lang>` (e.g. `fenced_code:typescript`).                                         |
| `count_substring:<needle>==<n>` | Output must contain exactly `n` non-overlapping occurrences of `<needle>`. The substring may contain any character that is not the literal sequence `==`. |
| `valid_json`                    | The trimmed output must successfully `JSON.parse`. Useful for structured-output prompts.                                                                  |
| `json_keys:<a>,<b>,...`         | The parsed JSON must be an object with exactly the listed top-level keys (any order).                                                                     |
| `json_value:<key>==<value>`     | The parsed JSON's `<key>` must equal `<value>` (parsed as JSON itself, so `true`, `3`, and `"kai"` all work as expected).                                 |

Unknown patterns fail the rubric with a clear `unknown required_patterns
DSL` error rather than silently skipping. This is intentional — a typo in
the DSL is a per-prompt configuration bug, not a successful pass.

## When to Add a Prompt or Extend the Rubric

The harness ships with ten prompts covering eight competence/usage
behaviours (code-gen, explain, refactor, debug, write-tests, write-docs,
search, conversation-continuation) and two maintainer-judgment slots
(structured-output-json, tool-use-with-error).

Add a new prompt when:

- A user-visible behaviour class becomes important enough that a
  regression in it would be embarrassing. Example: a new MCP-driven
  search flow lands and the deterministic rubric should assert the
  agent quotes the source it called.
- An existing class is too narrow. The existing prompts pin specific
  shapes (`fib`, `classify`, `sum`) — duplicating one with a different
  shape covers a wider behavioural surface without changing the rubric
  DSL.

Extend the rubric DSL when:

- A behaviour can only be verified with a structural assertion the
  current DSL does not express. Example: a future need to assert
  `output is valid Python 3 syntax` would justify a new `valid_py`
  pattern.

Do **not** extend the rubric DSL when:

- The check can be written as a substring or count. Prefer the existing
  primitives.
- The check requires a model to decide. That is the LLM-as-judge path,
  which is explicitly out of scope.

When the DSL grows, document the new pattern in this file in the
"Patterns DSL" table, and add a covering unit test in
[`run-evals.test.ts`](../electron/__tests__/evals/run-evals.test.ts).

## Baseline Regeneration

Baselines are per-model. When the workflow's pinned model id changes,
every baseline file under that model's directory must be regenerated.
The intended flow is documented in
[`electron/__tests__/evals/smoke/baselines/BASELINES_README.md`](../electron/__tests__/evals/smoke/baselines/BASELINES_README.md);
the short version:

```bash
# With ANTHROPIC_API_KEY and OPENAI_API_KEY exported in the local shell:
pnpm test:evals -- --regen-baselines
```

The `--regen-baselines` flag overwrites each baseline file with newly
captured mean + stddev statistics. The maintainer running the command
is responsible for hand-checking that the new mean is plausibly above
each prompt's `score_floor` and committing the updated JSON files.

A baseline whose `captured_at` field still contains the string
`PLACEHOLDER` is treated as "not yet captured" by the harness, which
refuses to gate on placeholder values. This is the same
graceful-degradation pattern used by the coverage workflow's baseline
fetch.

## N = 5 Sampling Rationale

The harness collects N = 5 samples per prompt per model on every run.
The choice trades off three considerations:

1. **Variance characterisation.** A single sample tells you nothing
   about the noise floor. Five samples give you both a mean and a
   non-degenerate standard deviation (sample stddev with Bessel's
   correction is defined for n ≥ 2; five is the smallest n that gives
   you a stddev estimate with a meaningful effective degrees-of-freedom).

2. **Cost.** The nightly path pays for N × prompts × models real-API
   calls. Ten prompts, two models, N = 5 = 100 calls per night. At
   pinned cheap models (haiku, gpt-4o-mini) and short responses, that
   is well under a dollar.

3. **Determinism floor.** Models at temperature 0 still have small
   server-side stochasticity. N = 5 is large enough that the mean
   smooths over a single bad sample.

Higher N (say N = 25) gives a tighter stddev estimate but multiplies
cost by 5×. If a maintainer wants to characterise variance more
precisely for a specific prompt, the right move is a one-off bench,
not a default change. Lower N (say N = 3) saves money but produces a
stddev that is dominated by which three samples happened to land in
the window.

## Score Floor + 2σ Tolerance Rationale

The gate is:

```
gate = (deterministic checks all pass)
       AND
       (sample mean >= max(prompt.score_floor, baseline.score_mean - 2 * baseline.score_std))
```

The 2σ tolerance derives from a normal-distribution assumption:
approximately 97.5% of single samples from a stationary distribution
fall above `mean − 2σ`. Five samples whose own mean falls below that
threshold is strong evidence the underlying distribution shifted, not
just that we drew an unlucky sample.

The absolute `score_floor` exists for a second reason: a long, slow
baseline drift could in principle move the per-model `mean − 2σ`
threshold below a level the prompt actually requires for correctness.
Pinning a per-prompt floor catches that. The floor is set per prompt
based on a maintainer's judgment of "this prompt is no longer being
answered if the score drops below X".

If both layers reject a sample, the verdict is unambiguous. If only the
absolute floor rejects, the baseline has drifted into nonsense and needs
review. If only the 2σ check rejects, the model genuinely changed
behaviour on that prompt.

## Cadence: Event-Triggered, Not Calendar

The nightly schedule is the default. Two other triggers exist:

- **Manual dispatch** via the Actions UI. Use this to re-run the eval
  after pinning a new model version, or after capturing fresh baselines,
  to confirm the gate is healthy before relying on the cadence.

- **PR label `run-eval`.** Apply this label to a PR that meaningfully
  changes the prompt-handling code path, agent configuration, or model
  routing logic. The workflow runs on the PR head and posts a sticky
  comment with the per-prompt verdict.

Routine PRs do not need the label. The cadence is the safety net;
on-demand is the maintainer's check-it-before-you-merge tool.

When the cron run **fails**, the workflow opens a GitHub issue from the
`behavioral-regression.yml` template with three labels:
`behavioral-regression`, `nightly-detected`, `category:llm-eval`. Dedup
is by title prefix on open issues. When the cron run **passes**, a new
row is appended to `docs/eval-history.jsonl` via a follow-up PR (the
PR's only path is `docs/eval-history.jsonl`, which is outside the eval
workflow's trigger filter, so merging it does not retrigger evals).

## Related Documents

- [`docs/TESTING_ARCHITECTURE.md`](TESTING_ARCHITECTURE.md) — long-form
  rationale for the pipeline as a whole, including the "Why no
  LLM-as-judge" argument that this doc shortens.
- [`docs/MAINTAINERS.md`](MAINTAINERS.md) — operational checklist that
  references the `run-eval` label and the behavioural-regression issue
  flow.
- [`electron/__tests__/evals/smoke/baselines/BASELINES_README.md`](../electron/__tests__/evals/smoke/baselines/BASELINES_README.md)
  — concrete steps to regenerate baselines.
