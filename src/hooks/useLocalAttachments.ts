import { useCallback, useRef, useState } from 'react';
import type { AttachedFile } from '@/providers/AttachmentContext';
import { MAX_ATTACHMENT_TOTAL_BYTES } from '@/lib/attachment-limits';

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
    let liveBytes = ref.current.reduce((sum, f) => sum + (f.size || 0), 0);
    const accepted: AttachedFile[] = [];
    const skipped: string[] = [];
    for (const file of files) {
      const size = file.size || 0;
      if (liveBytes + size > MAX_ATTACHMENT_TOTAL_BYTES) {
        skipped.push(file.name);
        continue;
      }
      liveBytes += size;
      accepted.push(file);
    }
    if (accepted.length > 0) {
      ref.current = [...ref.current, ...accepted];
      setAttachments(ref.current);
    }
    return { skipped };
  }, []);

  const removeAttachment = useCallback((index: number) => {
    ref.current = ref.current.filter((_, i) => i !== index);
    setAttachments(ref.current);
  }, []);

  const clearAttachments = useCallback(() => {
    ref.current = [];
    setAttachments([]);
  }, []);

  return { attachments, addAttachments, removeAttachment, clearAttachments };
}
