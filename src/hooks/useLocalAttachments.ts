import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttachedFile } from '@/providers/AttachmentContext';
import {
  MAX_ATTACHMENT_TOTAL_BYTES,
  globalOutstandingBytes,
  onAttachmentsCommitted,
  onAttachmentsReleased,
} from '@/lib/attachment-limits';

/**
 * A component-LOCAL attachment store with the same add/remove/clear surface as the shared
 * AttachmentProvider, but scoped to a single view (R186).
 *
 * The shared AttachmentProvider spans BOTH chat and the task views. Using it from a task composer
 * meant (a) leaving a task view could clear the user's unsent CHAT attachments, and (b) files staged
 * in a task — which the task-creation/refine pipeline cannot submit — leaked into a later chat send.
 * Task composers use this local store instead so their attachment lifecycle is fully isolated.
 *
 * `addAttachments` enforces the same aggregate byte cap as the shared provider and returns the names
 * of any files rejected for exceeding it, so callers can surface the rejection.
 */
export function useLocalAttachments() {
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const ref = useRef<AttachedFile[]>([]);
  ref.current = attachments;
  // Once the view unmounts, any pending async read (native dialog await / FileReader) that later calls
  // addAttachments must be a full no-op: committing bytes post-unmount would increment the renderer-wide
  // global counter with no future release (unmount cleanup already ran), permanently leaking budget (R190).
  const disposedRef = useRef(false);

  const addAttachments = useCallback((files: AttachedFile[]): { skipped: string[] } => {
    if (disposedRef.current) return { skipped: files.map((f) => f.name) };
    // Aggregate cap is renderer-wide: this local store's bytes plus every OTHER store's committed
    // bytes (chat + other task views) plus in-flight reserved bytes must not exceed the ceiling.
    // globalOutstandingBytes() = committed(all stores) + reserved; it already includes THIS store's
    // committed bytes, so subtract our resident bytes to avoid double-counting them, then grow as we
    // accept. Including reserved bytes (R190) closes a concurrent large-drop-plus-direct-commit overflow.
    const ownResident = ref.current.reduce((sum, f) => sum + (f.size || 0), 0);
    const otherBytes = Math.max(0, globalOutstandingBytes() - ownResident);
    let liveBytes = ownResident;
    const accepted: AttachedFile[] = [];
    const skipped: string[] = [];
    let addedBytes = 0;
    for (const file of files) {
      const size = file.size || 0;
      if (otherBytes + liveBytes + size > MAX_ATTACHMENT_TOTAL_BYTES) {
        skipped.push(file.name);
        continue;
      }
      liveBytes += size;
      addedBytes += size;
      accepted.push(file);
    }
    if (accepted.length > 0) {
      ref.current = [...ref.current, ...accepted];
      setAttachments(ref.current);
      onAttachmentsCommitted(addedBytes);
    }
    return { skipped };
  }, []);

  const removeAttachment = useCallback((index: number) => {
    if (disposedRef.current) return; // unmounted — bytes already released; a late call must not double-release (R213)
    const removed = ref.current[index];
    ref.current = ref.current.filter((_, i) => i !== index);
    setAttachments(ref.current);
    if (removed) onAttachmentsReleased(removed.size || 0);
  }, []);

  const clearAttachments = useCallback(() => {
    if (disposedRef.current) return; // unmounted — the unmount cleanup already released these bytes (R213)
    const releasedBytes = ref.current.reduce((sum, f) => sum + (f.size || 0), 0);
    ref.current = [];
    setAttachments([]);
    if (releasedBytes > 0) onAttachmentsReleased(releasedBytes);
  }, []);

  const getResidentBytes = useCallback((): number => ref.current.reduce((sum, f) => sum + (f.size || 0), 0), []);
  // Live IDENTITY signature of the staged set (R212/R213/R216): a byte-total match doesn't prove the SAME
  // files (a same-sized replacement passes). Use CHEAP per-file discriminators — NOT the full dataUrls (that
  // added hundreds of MiB of heap, R213). Sample the dataUrl at THREE points past the constant
  // `data:<mime>;base64,` header (a 24-char head is ~all header, so a same-name/size replacement collides,
  // R216): a mid-point + tail sample over the actual payload makes a same-name/size swap distinguishable.
  const dataUrlSample = (d: string | undefined): string => {
    if (!d) return '';
    const n = d.length;
    const mid = Math.floor(n / 2);
    return `${d.slice(64, 96)}|${d.slice(mid, mid + 32)}|${d.slice(Math.max(0, n - 32))}`;
  };
  const getAttachmentSignature = useCallback(
    (): string =>
      ref.current.map((f) => `${f.name} ${f.size ?? 0} ${f.dataUrl?.length ?? 0} ${dataUrlSample(f.dataUrl)}`).join(''),
    [],
  );

  // Releasing on unmount prevents a task view that is torn down with files still staged from leaking
  // its bytes into the renderer-wide committed counter forever. Mark disposed so a late async read's
  // addAttachments can't re-commit bytes after this release.
  useEffect(() => {
    // Reset on (re)mount so React 18 StrictMode's dev setup→cleanup→setup on the SAME ref doesn't leave
    // the store permanently disposed (which would reject every subsequent add in development) — R202.
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      const releasedBytes = ref.current.reduce((sum, f) => sum + (f.size || 0), 0);
      ref.current = []; // empty so a late getResidentBytes/getAttachmentSignature reads empty, not stale (R213)
      if (releasedBytes > 0) onAttachmentsReleased(releasedBytes);
    };
  }, []);

  return { attachments, addAttachments, removeAttachment, clearAttachments, getResidentBytes, getAttachmentSignature };
}
