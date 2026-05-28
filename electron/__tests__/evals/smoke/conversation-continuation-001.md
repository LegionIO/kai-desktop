---
prompt_id: conversation-continuation-001
category: usage
subcategory: conversation-continuation
prompt: |
  Multi-turn coherence probe. Treat the following as the third turn of an
  ongoing conversation where the user has already declared:

  Turn 1 (user): "My favourite colour is teal."
  Turn 2 (assistant): "Got it, teal it is."

  Turn 3 (user, this is the live prompt): "What is my favourite colour, and
  which two primary colours mix to make it?"

  Answer in one or two sentences. Do not restate the question. Do not include
  code blocks or markdown formatting.
rubric:
  length:
    min: 1
    max: 4
  required_tokens:
    - 'teal'
    - 'blue'
    - 'green'
  forbidden_tokens:
    - '```'
  required_patterns: []
score_floor: 0.7
reference_output_hash: PLACEHOLDER
---

# conversation-continuation-001

Tests recall across a synthetic conversation context plus a small piece of
factual knowledge (teal is a blue + green mixture). Three required tokens
plus a length cap fully characterise correctness without needing an
LLM judge.
