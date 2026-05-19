## What

<!-- One or two sentences describing what changed. -->

## Why

<!-- Motivation for the change. Link related issues with `Fixes #N` or `Refs #N`. -->

## Checklist

- [ ] `pnpm lint` passes
- [ ] `pnpm type-check` passes
- [ ] `pnpm test` passes (or note "no tests yet for this area" with rationale)
- [ ] `pnpm build` succeeds
- [ ] If this changes IPC, the preload bridge (`electron/preload.ts`) is updated and the type contract still holds
- [ ] If this adds a new config section, `desktopConfigPayload()` allowlist is updated
- [ ] Doc impact considered (README, CONTRIBUTING, AGENTS, CLAUDE)
