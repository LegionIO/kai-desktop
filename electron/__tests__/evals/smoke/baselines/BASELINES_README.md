# Baselines

This directory holds per-model baseline statistics for the behavioural
evaluation harness in [`../../run-evals.ts`](../../run-evals.ts).

Layout: one subdirectory per pinned model id, one JSON file per
prompt id inside it.

```text
baselines/
  claude-3-5-haiku-latest/
    code-gen-001.json
    explain-001.json
    ...
  gpt-4o-mini/
    code-gen-001.json
    ...
```

## Schema

Each baseline file has this shape:

```json
{
  "model_id": "claude-3-5-haiku-latest",
  "prompt_id": "code-gen-001",
  "captured_at": "2026-05-19T07:00:00Z",
  "n_samples": 5,
  "score_mean": 0.82,
  "score_std": 0.04,
  "outputs_sha256": ["a3f5...", "..."]
}
```

| Field            | Type                                                                                 | Notes                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `model_id`       | string                                                                               | Must match the `model_id` of the pinned model the workflow runs against.                                            |
| `prompt_id`      | string                                                                               | Must match the `prompt_id` frontmatter of the corresponding `.md` prompt.                                           |
| `captured_at`    | ISO-8601 string OR the literal `"PLACEHOLDER - regenerate before enabling workflow"` | Placeholder values cause the harness to refuse to run for that prompt × model pair (graceful degradation).          |
| `n_samples`      | integer                                                                              | The number of independent samples used to compute mean and stddev. The harness pins this to `N = 5`.                |
| `score_mean`     | number or null                                                                       | Mean Mastra scorer score across the captured samples. `null` while placeholder.                                     |
| `score_std`      | number or null                                                                       | Sample standard deviation across the captured samples. `null` while placeholder.                                    |
| `outputs_sha256` | string[]                                                                             | SHA-256 of each captured sample's output, for change-detection across regenerations. Empty array while placeholder. |

## Regeneration

Baselines are model-pinned. Whenever the workflow's model id changes, every
file under that subdirectory must be regenerated. The intended flow is:

1. **Pin the new model.** The workflow file
   [`.github/workflows/evals.yml`](../../../../../.github/workflows/evals.yml)
   has explicit model id arguments — change them there only.
2. **Run with `--regen-baselines`** against the new pinned model. From the
   repo root, with `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` exported:

   ```bash
   pnpm test:evals -- --regen-baselines
   ```

   The harness will execute each prompt × model pair `N = 5` times,
   compute mean + stddev of the Mastra scorer score, and overwrite the
   corresponding JSON file in this directory.

3. **Hand-verify a sample.** Open one or two regenerated files and confirm
   the `score_mean` is plausible (somewhere between the prompt's
   `score_floor` and 1.0). If a prompt's baseline mean is below its
   `score_floor`, the prompt's rubric is wrong, not the baseline — fix the
   prompt or the rubric before committing.
4. **Commit the updated JSON files.** The `captured_at` field replaces the
   placeholder sentinel.

## Why the placeholder sentinel?

Committing real baseline numbers requires a maintainer to have run the
real model. Until a maintainer does that, the workflow must refuse to
gate on numbers the repo cannot reproduce. The string
`"PLACEHOLDER - regenerate before enabling workflow"` in the
`captured_at` field is what the harness watches for: any prompt whose
baseline still has the sentinel exits the harness with an explanatory
error rather than running against null numbers.

This is the same "graceful degradation" pattern used by the coverage
workflow when no baseline artifact is available.

## See also

- [`../../run-evals.ts`](../../run-evals.ts) — the harness that consumes
  these files.
- [`../../../../../docs/EVAL_RUBRIC.md`](../../../../../docs/EVAL_RUBRIC.md)
  — design rationale and the prompt-file schema.
