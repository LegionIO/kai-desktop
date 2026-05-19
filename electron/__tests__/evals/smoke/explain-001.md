---
prompt_id: explain-001
category: competence
subcategory: explain
prompt: |
  Explain in 2-4 sentences what this TypeScript snippet does. Do not include
  code, only prose.

  ```typescript
  const memo = new Map<number, number>();
  function f(n: number): number {
    if (memo.has(n)) return memo.get(n)!;
    const v = n < 2 ? n : f(n - 1) + f(n - 2);
    memo.set(n, v);
    return v;
  }
  ```
rubric:
  length:
    min: 2
    max: 6
  required_tokens:
    - 'memo'
    - 'fibonacci'
  forbidden_tokens:
    - '```'
  required_patterns: []
score_floor: 0.6
reference_output_hash: PLACEHOLDER
---

# explain-001

The function name is hidden so the model has to read the body. The required
tokens insist the explanation names the memoization mechanism and identifies
the Fibonacci sequence. The forbidden-token check on backticks asserts the
model honoured "do not include code".
