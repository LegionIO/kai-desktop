---
prompt_id: code-gen-001
category: competence
subcategory: code-gen
prompt: |
  Write a TypeScript function `fib(n: number): number` that returns the n-th
  Fibonacci number using memoization. The function must handle n = 0 (returns 0)
  and n = 1 (returns 1). Wrap the implementation in a single fenced code block
  tagged `typescript`. Do not include any prose outside the code block.
rubric:
  length:
    min: 6
    max: 40
  required_tokens:
    - 'function'
    - 'fib'
    - 'return'
  forbidden_tokens:
    - 'Math.random'
    - 'console.log'
  required_patterns:
    - 'fenced_code:typescript'
score_floor: 0.7
reference_output_hash: PLACEHOLDER
---

# code-gen-001

Pinned to the recursive-with-memoization shape because the deterministic
substring + fenced-block checks completely characterise correctness. The
behavioural concern is whether the model still emits the memoization pattern
and the correct base cases — both observable from the rubric without an
LLM judge.
