import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttachedFile } from '@/providers/AttachmentContext';
import {
  MAX_ATTACHMENT_TOTAL_BYTES,
  globalCommittedBytes,
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

  const addAttachments = useCallback((files: AttachedFile[]): { skipped: string[] } => {
    // Aggregate cap is renderer-wide: this local store's bytes plus every OTHER store's committed
    // bytes (chat + other task views) must not exceed the ceiling. Count our own resident bytes
    // exactly and add the rest via globalCommittedBytes(), which already includes ours — so subtract
    // our resident bytes to avoid double-counting, then grow as we accept.
    const ownResident = ref.current.reduce((sum, f) => sum + (f.size || 0), 0);
    const otherBytes = Math.max(0, globalCommittedBytes() - ownResident);
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
    const removed = ref.current[index];
    ref.current = ref.current.filter((_, i) => i !== index);
    setAttachments(ref.current);
    if (removed) onAttachmentsReleased(removed.size || 0);
  }, []);

  const clearAttachments = useCallback(() => {
    const releasedBytes = ref.current.reduce((sum, f) => sum + (f.size || 0), 0);
    ref.current = [];
    setAttachments([]);
    if (releasedBytes > 0) onAttachmentsReleased(releasedBytes);
  }, []);

  const getResidentBytes = useCallback((): number => ref.current.reduce((sum, f) => sum + (f.size || 0), 0), []);

  // Releasing on unmount prevents a task view that is torn down with files still staged from leaking
  // its bytes into the renderer-wide committed counter forever.
  useEffect(() => {
    return () => {
      const releasedBytes = ref.current.reduce((sum, f) => sum + (f.size || 0), 0);
      if (releasedBytes > 0) onAttachmentsReleased(releasedBytes);
    };
  }, []);

  return { attachments, addAttachments, removeAttachment, clearAttachments, getResidentBytes };
}
