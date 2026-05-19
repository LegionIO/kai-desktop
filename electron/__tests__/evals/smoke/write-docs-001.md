---
prompt_id: write-docs-001
category: competence
subcategory: write-docs
prompt: |
  Write a JSDoc comment block for the following TypeScript function. Include
  exactly one `@param` line for each parameter and one `@returns` line. Do
  not modify the function body. Return the comment followed by the original
  function unchanged, both inside a single fenced code block tagged
  `typescript`. Do not add any prose outside the code block.

  ```typescript
  export function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }
  ```
rubric:
  length:
    min: 6
    max: 25
  required_tokens:
    - '@param'
    - '@returns'
    - 'clamp'
    - 'value'
    - 'min'
    - 'max'
  forbidden_tokens: []
  required_patterns:
    - 'fenced_code:typescript'
    - 'count_substring:@param==3'
score_floor: 0.7
reference_output_hash: PLACEHOLDER
---

# write-docs-001

The rubric pins exactly the JSDoc tags expected (`@param` × 3 and one
`@returns`). The output must echo the function signature, so all three
parameter names appear in the required-tokens list. Structural correctness
is fully expressible as substring + count assertions.
