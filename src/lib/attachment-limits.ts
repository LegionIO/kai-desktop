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

// Bytes currently reserved by in-flight reads that have NOT yet reached the attachment store (R187).
// Each pre-read filter starts its own budget at zero, so without a shared reservation two rapid
// drops/pastes could each pass their own aggregate gate and concurrently materialize ~2× the cap
// (plus base64 overhead). filterAttachmentsBySize charges against this global reservation; the caller
// releases it once the reads settle (whether committed to the store or dropped).
let inFlightReservedBytes = 0;

/** Reserve bytes for an in-flight batch (called internally by filterAttachmentsBySize for accepted
 *  files). Exported for callers that need to release the exact amount later. */
export function releaseAttachmentReservation(bytes: number): void {
  inFlightReservedBytes = Math.max(0, inFlightReservedBytes - bytes);
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
 * Enforces the per-file cap and a running aggregate cap that INCLUDES bytes already reserved by other
 * in-flight batches (R187), so concurrent drops/pastes can't collectively exceed the ceiling. Reserves
 * the accepted bytes against the global in-flight counter; the caller must release `reservedBytes` when
 * the reads settle. Order-preserving.
 */
export function filterAttachmentsBySize(files: readonly File[]): AttachmentFilterResult {
  const accepted: File[] = [];
  const skipped: string[] = [];
  let batchBytes = 0;
  for (const file of files) {
    const wouldTotal = inFlightReservedBytes + batchBytes + file.size;
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
