---
prompt_id: structured-output-json-001
category: usage
subcategory: structured-output-json
prompt: |
  Return a JSON object with exactly these three keys: `name` (string),
  `count` (integer), `active` (boolean). The values must be: name = "kai",
  count = 3, active = true. Return only the JSON object, with no prose,
  no markdown, and no code fence. The output must parse as valid JSON.
rubric:
  length:
    min: 1
    max: 5
  required_tokens:
    - '"name"'
    - '"count"'
    - '"active"'
    - 'kai'
    - 'true'
  forbidden_tokens:
    - '```'
    - 'Here'
  required_patterns:
    - 'valid_json'
    - 'json_keys:name,count,active'
    - 'json_value:name==kai'
    - 'json_value:count==3'
    - 'json_value:active==true'
score_floor: 0.8
reference_output_hash: PLACEHOLDER
---

# structured-output-json-001

Behavioural concern: many models prepend prose ("Here is the JSON:") or
wrap in a markdown fence even when told not to. The `valid_json` pattern
runs `JSON.parse` on the trimmed output; the `json_keys` and `json_value`
patterns assert the parsed shape exactly. This is the single highest-signal
prompt for instruction-following.
