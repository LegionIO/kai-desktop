import { createContext, useContext, useRef, useCallback, useState, type ReactNode } from 'react';
import {
  MAX_ATTACHMENT_TOTAL_BYTES,
  onAttachmentsCommitted,
  onAttachmentsReleased,
  globalOutstandingBytes,
} from '@/lib/attachment-limits';

export type AttachedFile = {
  name: string;
  mime: string;
  isImage: boolean;
  size: number;
  dataUrl: string;
  text?: string;
  filePath?: string;
};

type AttachmentContextValue = {
  attachments: AttachedFile[];
  /** Append files to the store, enforcing the global aggregate byte cap across ALL prior + in-flight
   *  attachments (R185). Returns the names of any files REJECTED because they'd exceed the total cap —
   *  each per-event pre-read filter uses its own running budget, so this is the authoritative backstop
   *  against many separate batches together exhausting renderer memory. */
  addAttachments: (files: AttachedFile[]) => { skipped: string[] };
  removeAttachment: (index: number) => void;
  clearAttachments: () => void;
  /** Called by RuntimeProvider to consume attachments when sending */
  consumeAttachments: () => AttachedFile[];
  /** Live attachment count (ref-backed) for async closures that must not read
   *  the stale render-time `attachments` — e.g. revalidating before a deferred
   *  mid-turn fallback send that would otherwise consume a just-added attachment. */
  getAttachmentCount: () => number;
  /** Live total bytes of currently-staged attachments (ref-backed) — passed to filterAttachmentsBySize
   *  so a new selection's pre-read budget accounts for what's ALREADY staged (R188). */
  getResidentBytes: () => number;
};

const AttachmentContext = createContext<AttachmentContextValue>({
  attachments: [],
  addAttachments: () => ({ skipped: [] }),
  removeAttachment: () => {},
  clearAttachments: () => {},
  consumeAttachments: () => [],
  getAttachmentCount: () => 0,
  getResidentBytes: () => 0,
});

export function AttachmentProvider({ children }: { children: ReactNode }) {
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const attachmentsRef = useRef<AttachedFile[]>([]);

  // Keep the ref in sync at render too (covers an external/reset path), but every
  // mutator below ALSO updates it SYNCHRONOUSLY — so getAttachmentCount() reflects
  // an add/remove immediately, even before React flushes the state update (an
  // add + a mid-turn gate resolving in the same batch must not read a stale zero).
  attachmentsRef.current = attachments;

  const addAttachments = useCallback((files: AttachedFile[]): { skipped: string[] } => {
    // Backstop the renderer-wide aggregate cap against the GLOBAL OUTSTANDING total (R185/R189/R190):
    // committed bytes across every store PLUS in-flight reserved bytes. This path (native picker / App
    // Shot) commits WITHOUT a pre-read gate, so it must not ignore bytes another store's large in-flight
    // drop already reserved. Report committed deltas so the global counter tracks this store's contribution.
    const accepted: AttachedFile[] = [];
    const skipped: string[] = [];
    let addedBytes = 0;
    for (const file of files) {
      const size = file.size || 0;
      if (globalOutstandingBytes() + addedBytes + size > MAX_ATTACHMENT_TOTAL_BYTES) {
        skipped.push(file.name);
        continue;
      }
      addedBytes += size;
      accepted.push(file);
    }
    if (accepted.length > 0) {
      attachmentsRef.current = [...attachmentsRef.current, ...accepted];
      setAttachments(attachmentsRef.current);
      onAttachmentsCommitted(addedBytes);
    }
    return { skipped };
  }, []);

  const removeAttachment = useCallback((index: number) => {
    const removed = attachmentsRef.current[index];
    attachmentsRef.current = attachmentsRef.current.filter((_, i) => i !== index);
    setAttachments(attachmentsRef.current);
    if (removed) onAttachmentsReleased(removed.size || 0);
  }, []);

  const clearAttachments = useCallback(() => {
    const releasedBytes = attachmentsRef.current.reduce((sum, f) => sum + (f.size || 0), 0);
    attachmentsRef.current = [];
    setAttachments([]);
    onAttachmentsReleased(releasedBytes);
  }, []);

  const consumeAttachments = useCallback((): AttachedFile[] => {
    const current = attachmentsRef.current;
    const releasedBytes = current.reduce((sum, f) => sum + (f.size || 0), 0);
    attachmentsRef.current = [];
    setAttachments([]);
    onAttachmentsReleased(releasedBytes);
    return current;
  }, []);

  const getAttachmentCount = useCallback((): number => attachmentsRef.current.length, []);

  const getResidentBytes = useCallback(
    (): number => attachmentsRef.current.reduce((sum, f) => sum + (f.size || 0), 0),
    [],
  );

  return (
    <AttachmentContext.Provider
      value={{
        attachments,
        addAttachments,
        removeAttachment,
        clearAttachments,
        consumeAttachments,
        getAttachmentCount,
        getResidentBytes,
      }}
    >
      {children}
    </AttachmentContext.Provider>
  );
}

export function useAttachments() {
  return useContext(AttachmentContext);
}
