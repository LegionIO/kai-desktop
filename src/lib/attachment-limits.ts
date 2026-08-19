/**
 * Renderer-side attachment size gating (R183).
 *
 * The native file-open dialog enforces per-file (64 MiB) and aggregate (256 MiB) caps in the main
 * process before base64-encoding. The web file-input and drag/drop ingestion paths, however, read
 * every selected File fully with FileReader (concurrently), so a large or bulk selection can OOM the
 * RENDERER before anything reaches the attachment sink. Filter by `File.size` BEFORE reading — the
 * only point at which we can avoid materializing the bytes at all.
 *
 * Kept intentionally in sync with the main-process caps in electron/main.ts (dialog:open-file).
 */
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024; // per file
export const MAX_ATTACHMENT_TOTAL_BYTES = 256 * 1024 * 1024; // across a single selection

export type AttachmentFilterResult = {
  /** Files that fit within the per-file cap and the running aggregate cap, in input order. */
  accepted: File[];
  /** Names of files rejected for exceeding the per-file cap or the aggregate budget. */
  skipped: string[];
};

/**
 * Partition a File selection into the files safe to read and the names to report as skipped.
 * Enforces the per-file cap and a running aggregate cap; once the aggregate would be exceeded, the
 * remaining files are skipped rather than read. Order-preserving and side-effect free.
 */
export function filterAttachmentsBySize(files: readonly File[]): AttachmentFilterResult {
  const accepted: File[] = [];
  const skipped: string[] = [];
  let aggregateBytes = 0;
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES || aggregateBytes + file.size > MAX_ATTACHMENT_TOTAL_BYTES) {
      skipped.push(file.name);
      continue;
    }
    aggregateBytes += file.size;
    accepted.push(file);
  }
  return { accepted, skipped };
}

/** Build a user-facing notice string for skipped attachment names, or null if nothing was skipped. */
export function skippedAttachmentsNotice(skipped: readonly string[]): string | null {
  if (skipped.length === 0) return null;
  const names = skipped.join(', ');
  return skipped.length === 1
    ? `Couldn't attach ${names} (too large or not a regular file).`
    : `Couldn't attach ${skipped.length} files (too large or not regular files): ${names}`;
}
