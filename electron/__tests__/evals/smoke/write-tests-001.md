---
prompt_id: write-tests-001
category: competence
subcategory: write-tests
prompt: |
  Write a Vitest test suite for the following TypeScript function. Include
  exactly three `it` blocks: one for the zero-element array, one for a
  single-element array, and one for a multi-element array. Use
  `expect(...).toBe(...)` assertions. Return the test file in a single
  fenced code block tagged `typescript`. Do not include any prose outside
  the code block.

  ```typescript
  export function sum(xs: number[]): number {
    return xs.reduce((a, b) => a + b, 0);
  }
  ```
rubric:
  length:
    min: 8
    max: 35
  required_tokens:
    - 'describe'
    - 'it('
    - 'expect'
    - 'toBe'
    - 'sum'
  forbidden_tokens:
    - 'toMatchSnapshot'
    - 'toEqual'
  required_patterns:
    - 'fenced_code:typescript'
    - 'count_substring:it(==3'
score_floor: 0.7
reference_output_hash: PLACEHOLDER
---

# write-tests-001

The repo bans snapshot assertions outright and prefers `toBe` for primitive
equality. The forbidden-token check on `toMatchSnapshot` plus the
`count_substring:it(==3` pattern characterise both house conventions and the
specific structural request. No LLM judge is needed — the test file's shape
is fully observable from the rubric.
