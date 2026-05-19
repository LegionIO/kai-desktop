---
prompt_id: debug-001
category: competence
subcategory: debug
prompt: |
  The following TypeScript function should return the sum of the array but
  has a bug. Identify the bug in one sentence, then show the corrected
  function in a single fenced code block tagged `typescript`. Do not add any
  other commentary.

  ```typescript
  function sum(xs: number[]): number {
    let total = 0;
    for (let i = 1; i < xs.length; i++) {
      total += xs[i];
    }
    return total;
  }
  ```
rubric:
  length:
    min: 5
    max: 25
  required_tokens:
    - '0'
    - 'sum'
    - 'total'
  forbidden_tokens:
    - 'i = 1'
  required_patterns:
    - 'fenced_code:typescript'
score_floor: 0.7
reference_output_hash: PLACEHOLDER
---

# debug-001

The bug is the loop starting at `i = 1` instead of `i = 0`, so the first
element is skipped. The forbidden-token check on `i = 1` ensures the model's
corrected version no longer carries the off-by-one starting index. Required
tokens insist the corrected snippet still names the function and accumulator.
