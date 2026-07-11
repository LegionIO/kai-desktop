# ADR 0005: Platform Capability Seam

- **Status**: Accepted
- **Date**: 2026-07-11
- **Deciders**: maintainers

## Context

Several of Kai's capabilities are macOS-only today: local "computer use"
(screenshot + synthetic input on the real desktop) and "dictation anywhere"
(inserting transcribed text into any app's focused native field via the
accessibility APIs). Historically these were gated by scattered inline
`process.platform === 'darwin'` checks. On a non-macOS build that meant a user
could select a feature that then silently failed, and every new Windows/Linux
effort had to rediscover where the platform branches lived.

We want Windows (and later Linux) users to get an honest "Coming to Windows"
state, and we want all future platform work to route through one model rather
than accreting more inline branches.

There is no Windows runtime on the build hardware or in CI, so this decision
covers only what is **statically verifiable**: the capability model, routing,
gating, and the fact that a not-yet-ready Windows build cannot ship.

## Decision

1. **A pure capability model.** `electron/platform/capabilities.ts` exports
   `getPlatformCapabilities(platform = process.platform)` — a pure function
   (no fs/config/env reads) returning booleans + static reason strings for
   `computerUseLocal`, `computerUseBrowser`, `dictationCapture`,
   `dictationAnywhere`, and `dockIcon`. It is trivially testable per injected
   platform. This is distinct from the low-level `NativePlatformAdapter` /
   `AdapterCapabilities` in `electron/platform/types.ts`, which describe what a
   native host can do at runtime; this seam answers the coarser product
   question "is this feature available on this OS yet?".

2. **A terminal Windows stub harness.** `WindowsStubHarness` (implements the
   existing `ComputerHarness` interface) is selected for the new
   `local-windows` target in `getHarness()`. Every action method rejects with a
   typed `ComputerHarnessUnsupportedError`; the harness never touches
   `permissions.ts` or any native helper. Orchestration must surface the
   failure and must NOT fall back to another harness or swallow it into a
   success. `dispose()` is a safe no-op so cleanup never throws.

3. **A dictation platform seam.** `electron/dictation/dictation-platform.ts`
   exposes `getDictationPlatform(platform).supportsAnywhereInsertion()`.
   `startDictation` consults it once and refuses "dictation anywhere" where it
   isn't supported, instead of starting a session that could never insert. The
   ~13 existing inline darwin guards in `dictation-manager.ts` are intentionally
   left untouched in this slice so macOS behavior is provably unchanged; folding
   them behind the seam is a deferred follow-up.

4. **Capabilities surfaced to the UI.** `platform:get-feature-capabilities`
   IPC (registered by `registerPlatformHandlers`) exposes the pure result via
   `window.app.platform.getFeatureCapabilities()` (inside the existing
   `window.app` bridge — no new `exposeInMainWorld` namespace, mirrored in the
   web-server bridge). Settings render the local-computer-use control disabled
   with the `reason` when unsupported.

5. **The Windows build is gated off by default.** `generate-builder-config.ts`
   strips the `win`/`nsis` targets from the generated electron-builder config
   unless `KAI_ENABLE_WIN_BUILD` is set, so CI publishes no Windows artifact
   until a real Windows build is validated.

## Consequences

- macOS behavior is byte-unchanged: `getPlatformCapabilities('darwin')` reports
  everything supported, `local-macos` still routes to the native/desktop
  harness, and the dictation-anywhere gate passes on darwin.
- Future Windows/Linux capability work has one place to flip a capability from
  unsupported to supported, plus a harness to replace.
- This slice ships **no native Windows automation and validates nothing on real
  Windows** — it is a seam + honest gating slice only.

## Out of scope (future work)

Native Windows computer-use harness (UIAutomation/SendInput/capture), Windows
AX text insertion, composer-only Windows dictation, refactoring the inline
dictation darwin guards behind the seam, a Windows permissions model,
re-enabling the Windows build, and a Windows dock/tray equivalent.
