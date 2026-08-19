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
export const MAX_ATTACHMENT_TOTAL_BYTES = 256 * 1024 * 1024; // across ALL attachment stores, renderer-wide

// Two GLOBAL (module-level) counters form a single renderer-wide ceiling (R189):
//   committedBytes    — bytes of attachments currently held across EVERY store (shared chat store +
//                        any task-local stores). Each store reports its deltas via onAttachments*.
//   inFlightReservedBytes — bytes of reads that have passed the pre-read gate but not yet committed.
// The pre-read gate checks committed + reserved + batch, so neither multiple mounted stores (chat +
// task-local) nor concurrent in-flight batches can collectively exceed MAX_ATTACHMENT_TOTAL_BYTES.
let committedBytes = 0;
let inFlightReservedBytes = 0;

/** A store reports bytes it has newly COMMITTED (added to its live list). */
export function onAttachmentsCommitted(bytes: number): void {
  committedBytes += Math.max(0, bytes);
}

/** A store reports bytes it has RELEASED (removed/cleared/consumed from its live list). */
export function onAttachmentsReleased(bytes: number): void {
  committedBytes = Math.max(0, committedBytes - Math.max(0, bytes));
}

/** Current renderer-wide committed attachment bytes across all stores (for a store's own backstop). */
export function globalCommittedBytes(): number {
  return committedBytes;
}

/** Current renderer-wide OUTSTANDING attachment bytes: committed across every store PLUS bytes reserved
 *  by in-flight reads that have passed the pre-read gate but not yet committed. A direct-commit backstop
 *  (a path that adds WITHOUT going through filterAttachmentsBySize — native picker / App Shot payload)
 *  must check against this, not committedBytes alone: otherwise a large in-flight drop that already
 *  reserved the budget plus a concurrent direct commit can together exceed the renderer-wide cap (R190). */
export function globalOutstandingBytes(): number {
  return committedBytes + inFlightReservedBytes;
}

/** Release an in-flight reservation once the read settles (committed to a store OR discarded). When a
 *  read commits, the store's onAttachmentsCommitted moves those bytes into `committedBytes`, so the
 *  reservation must be released to avoid double-counting. */
export function releaseAttachmentReservation(bytes: number): void {
  inFlightReservedBytes = Math.max(0, inFlightReservedBytes - Math.max(0, bytes));
}

export type AttachmentFilterResult = {
  /** Files that fit within the per-file cap and the running aggregate cap, in input order. */
  accepted: File[];
  /** Names of files rejected for exceeding the per-file cap or the aggregate budget. */
  skipped: string[];
  /** Total bytes of `accepted` reserved against the global in-flight ceiling. The caller MUST pass
   *  this to releaseAttachmentReservation() once the reads settle (committed or discarded). */
  reservedBytes: number;
};

/**
 * Partition a File selection into the files safe to read and the names to report as skipped.
 * Enforces the per-file cap and a single renderer-wide aggregate cap that INCLUDES bytes already
 * committed to ANY store (R189) plus bytes reserved by other in-flight batches (R187). Reserves the
 * accepted bytes against the global in-flight counter; the caller MUST release `reservedBytes` once the
 * reads settle. Order-preserving.
 */
export function filterAttachmentsBySize(files: readonly File[]): AttachmentFilterResult {
  const accepted: File[] = [];
  const skipped: string[] = [];
  let batchBytes = 0;
  for (const file of files) {
    const wouldTotal = committedBytes + inFlightReservedBytes + batchBytes + file.size;
    if (file.size > MAX_ATTACHMENT_BYTES || wouldTotal > MAX_ATTACHMENT_TOTAL_BYTES) {
      skipped.push(file.name);
      continue;
    }
    batchBytes += file.size;
    accepted.push(file);
  }
  inFlightReservedBytes += batchBytes;
  return { accepted, skipped, reservedBytes: batchBytes };
}

/** Build a user-facing notice string for skipped attachment names, or null if nothing was skipped. */
export function skippedAttachmentsNotice(skipped: readonly string[]): string | null {
  if (skipped.length === 0) return null;
  const names = skipped.join(', ');
  return skipped.length === 1
    ? `Couldn't attach ${names} (too large or not a regular file).`
    : `Couldn't attach ${skipped.length} files (too large or not regular files): ${names}`;
}

/**
 * Map staged attachments to the `{ image, mimeType }[]` shape the task-plan IPC accepts (R187).
 * Only IMAGE attachments are forwarded — the task-plan model request is multimodal for images only;
 * non-image files (PDF/text) are ignored here so they aren't silently mis-sent as images.
 */
export function attachmentsToImagePayload(
  attachments: ReadonlyArray<{ isImage: boolean; dataUrl: string; mime?: string }>,
): Array<{ image: string; mimeType?: string }> {
  return attachments
    .filter((a) => a.isImage && typeof a.dataUrl === 'string' && a.dataUrl.length > 0)
    .map((a) => (a.mime ? { image: a.dataUrl, mimeType: a.mime } : { image: a.dataUrl }));
}
