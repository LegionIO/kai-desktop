# ADR 0004: Appshots — persisted capture artifacts

- **Status**: Accepted
- **Date**: 2026-07-11
- **Deciders**: maintainers

## Context

Computer-use captures screenshots today as in-memory `ComputerFrame` data URLs
(`shared/computer-use.ts`) that vanish when the session ends. There was no way
to browse or re-use a capture after the fact. Issue #81 asks for **Appshots** —
metadata-enhanced, PERSISTED screenshots ("snapshot+"): an image saved with
structured metadata (app/window name, timestamp, originating conversation,
triggering action, display, optional visible-text), browsable in a settings
gallery and re-attachable into a chat.

This is distinct from the pre-existing `shared/app-shots.ts` (`AppShotPayload`)
feature, which is the EPHEMERAL capture-to-attach/inline hotkey mechanism
(in-memory data URL, ref-based composer inlining). The two coexist; naming is
kept distinct: `Appshot`/`appshots` (this feature) vs `AppShot`/`appShots`.

The agent implements the platform-agnostic layer only — data model, on-disk
store, IPC, retention, and the renderer gallery. macOS Swift capture is reused
behind the existing harness `captureFrame()` hook; no Swift is written.

## Decision

### Data model & storage

- `shared/appshots.ts`: `Appshot`, `AppshotIndex {version:1; appshots[]}`,
  `CreateAppshotInput`, `APPSHOT_ID_RE`, `isValidAppshotId`. `imageRef` is a
  BARE filename (`"<id>.jpg"`), never a path. `dataUrl` is never persisted.
- `electron/computer-use/appshot-store.ts` (no Electron import, unit-testable):
  split storage — bytes at `~/.kai/data/appshots/<id>.jpg`, metadata in
  `index.json`. IDs from `makeComputerUseId('appshot')`.

### Security posture (Cerberus must-fixes)

- **Path traversal**: every id-keyed op validates `APPSHOT_ID_RE` BEFORE any
  `path.join`; `imageRef` re-validated as a bare filename on read (index.json is
  user-writable and never trusted for path construction).
- **TOCTOU / symlink**: `getImage` `lstat`s (rejects non-regular files, i.e.
  symlinks) and confirms `realpath` stays inside the fixed appshots dir.
- **Content-type**: `getImage` verifies JPEG magic bytes (`FF D8 FF`) before
  emitting `data:image/jpeg;base64,…`.
- **Atomic write**: index writes go through the shared `atomicWriteFileSync`
  (write to a sibling `O_EXCL|O_NOFOLLOW` temp → chmod → rename). Image is
  written+committed BEFORE the index entry referencing it (write-image-then-
  index), so a crash between leaves an orphan image that retention GCs — never a
  dangling index entry. A corrupt `index.json` recovers to empty (the on-disk
  file is not wiped mid-op; the next successful write replaces it).
- **Disk-DoS ceiling**: retention runs serialized with the index write;
  `maxTotalBytes` is re-checked AFTER write with rollback of the new appshot if
  exceeded. Pinned items are exempt from age/count eviction but STILL count
  toward the byte ceiling.
- **`update(id, patch)` allowlist**: a strict zod schema `{ tags?, pinned? }`;
  any other key is rejected (no `imageRef`/`id`/`createdAt` overwrite); tags are
  length/count-capped.
- **Fire-and-forget hook**: the auto-capture persist (in `session-manager`'s
  `emitEvent` on a `'frame'`) is config-gated, single-flight per session (drop a
  new appshot if a prior write is in flight — no unbounded queue), and
  `.catch()`-logs every rejection so it can never throw into the computer-use
  loop. It persists the ALREADY-harness-redacted emitted frame — never
  re-captures.

### At-rest / PII

- The appshots dir is created `mode 0o700`. **No encryption-at-rest is
  provided** — appshots inherit only filesystem permissions.
- `captureVisibleText` defaults off. Settings copy must NOT claim
  `captureExcludedApps` fully protects: full-screen excluded apps are skipped,
  but other visible windows may be captured.
- A **"Delete all appshots"** affordance is provided.

### Config

`appshots { enabled:false, autoCapture:false, captureVisibleText:false,
retention:{ maxCount:200, maxAgeDays:30, maxTotalBytes:524288000 } }` — all OFF
by default; added to both the schema and the `desktopConfigPayload()` allowlist.

## Consequences

- Nothing is captured or written until an operator enables `appshots.enabled` +
  `autoCapture`. Default behavior is unchanged.
- The store is fully unit-testable against a temp dir on Linux (no GUI/Swift).
- Retention ordering relies on the index array's INSERTION order as the
  chronological ground truth (same-millisecond creates share a `createdAt`, so
  re-sorting by timestamp alone would be unstable).

## Out of scope (future issues)

Automated PII redaction of `visibleText`; encryption-at-rest; backporting the
atomic-write helper's dir-fsync to a shared durability primitive.
