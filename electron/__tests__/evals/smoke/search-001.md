---
prompt_id: search-001
category: usage
subcategory: search
prompt: |
  In one sentence, state which Node.js LTS major version was current as of
  October 2024. Include the version number (an integer) and the word "LTS".
  Do not include URLs, code blocks, or markdown formatting.
rubric:
  length:
    min: 1
    max: 3
  required_tokens:
    - '20'
    - 'LTS'
  forbidden_tokens:
    - 'http'
    - '```'
  required_patterns: []
score_floor: 0.6
reference_output_hash: PLACEHOLDER
---

# search-001

A factual recall prompt with a single well-defined answer (Node 20 LTS).
This is the "search" category because in a tool-equipped agent run, the
model is expected to consult a web or MCP source to confirm — but the
deterministic rubric only checks the final answer's shape. Pinned to
"October 2024" so future LTS rotations cannot shift the expected version.
