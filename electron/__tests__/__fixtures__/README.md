# HTTP fixtures

This directory holds JSONL fixtures used by the msw-based HTTP mock. Each
provider gets its own subdirectory; each fixture file contains one or more
recorded request/response pairs (one JSON object per line).

Layout:

```
__fixtures__/
  anthropic/   – Anthropic SDK (`/v1/messages`)
  openai/      – OpenAI SDK (`/v1/chat/completions`, `/v1/responses`)
  bedrock/     – AWS Bedrock Runtime (`/model/{id}/invoke`)
  azure/       – Azure OpenAI (`/openai/deployments/{id}/chat/completions`)
  claude-sdk/  – Anthropic Agent SDK
  codex/       – OpenAI Codex SDK (streaming with MCP framing)
  mastra/      – Mastra-orchestrated multi-step exchanges
  generate.ts  – Typed JSONL builder (`pnpm fixtures:gen`)
  .checksum    – sha256 manifest verified by `pnpm test:fixtures:verify`
```

## Format

Each line is a single `FixtureEntry`:

```json
{
  "request":  { "method": "POST", "url": "https://api.anthropic.com/v1/messages", "body": { ... } },
  "response": { "status": 200, "headers": { ... }, "body": { ... } }
}
```

For streaming responses, replace `body` with `bodyStream: [ "data: {...}\n\n", "data: [DONE]\n\n" ]`.

## DO NOT put real API keys or PII in fixtures

These files are committed and run in CI. Treat them as public. Any
`authorization`, `api-key`, `x-api-key`, AWS signature, or cookie header in
a recorded request must be redacted to a constant like `test-key-not-real`
before commit. `generate.ts` redacts known auth headers automatically; if
you hand-edit a fixture, do the same.

The same applies to user content: scrub names, organization IDs, account
IDs, and any real-world data from request bodies and response choices.

## Regenerating

```bash
pnpm fixtures:gen          # rebuild every fixture from generate.ts inputs
pnpm test:fixtures:verify  # check checksums match the committed files
```

The verify step runs in CI; if you hand-edit a fixture without updating
`.checksum`, the build fails.
