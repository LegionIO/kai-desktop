---
prompt_id: refactor-001
category: competence
subcategory: refactor
prompt: |
  Refactor the following TypeScript function to early-return rather than
  using nested if/else. Preserve the original behaviour exactly. Return the
  refactored function in a single fenced code block tagged `typescript`. Do
  not add prose outside the code block.

  ```typescript
  function classify(n: number): string {
    if (n === 0) {
      return "zero";
    } else {
      if (n > 0) {
        if (n < 10) {
          return "small";
        } else {
          return "large";
        }
      } else {
        return "negative";
      }
    }
  }
  ```
rubric:
  length:
    min: 6
    max: 25
  required_tokens:
    - 'classify'
    - 'return'
    - 'zero'
    - 'small'
    - 'large'
    - 'negative'
  forbidden_tokens:
    - '} else {'
  required_patterns:
    - 'fenced_code:typescript'
score_floor: 0.7
reference_output_hash: PLACEHOLDER
---

# refactor-001

The forbidden-token check `} else {` is the structural signal: a correct
early-return rewrite has no `else` branches at all. Required tokens assert
each of the four classification outputs is preserved, so behaviour is held
constant by the rubric without needing to actually run the refactored code.
