import { createContext, useContext, useRef, useCallback, useState, type ReactNode } from 'react';
import { MAX_ATTACHMENT_TOTAL_BYTES } from '@/lib/attachment-limits';

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
};

const AttachmentContext = createContext<AttachmentContextValue>({
  attachments: [],
  addAttachments: () => ({ skipped: [] }),
  removeAttachment: () => {},
  clearAttachments: () => {},
  consumeAttachments: () => [],
  getAttachmentCount: () => 0,
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
    // Enforce the aggregate byte cap against the CURRENT live store (R185): each per-event pre-read
    // filter starts its budget from zero, so without this backstop several separate picker/drop/paste
    // batches could each pass their own 256 MiB gate and together exhaust renderer memory.
    let liveBytes = attachmentsRef.current.reduce((sum, f) => sum + (f.size || 0), 0);
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
      attachmentsRef.current = [...attachmentsRef.current, ...accepted];
      setAttachments(attachmentsRef.current);
    }
    return { skipped };
  }, []);

  const removeAttachment = useCallback((index: number) => {
    attachmentsRef.current = attachmentsRef.current.filter((_, i) => i !== index);
    setAttachments(attachmentsRef.current);
  }, []);

  const clearAttachments = useCallback(() => {
    attachmentsRef.current = [];
    setAttachments([]);
  }, []);

  const consumeAttachments = useCallback((): AttachedFile[] => {
    const current = attachmentsRef.current;
    attachmentsRef.current = [];
    setAttachments([]);
    return current;
  }, []);

  const getAttachmentCount = useCallback((): number => attachmentsRef.current.length, []);

  return (
    <AttachmentContext.Provider
      value={{
        attachments,
        addAttachments,
        removeAttachment,
        clearAttachments,
        consumeAttachments,
        getAttachmentCount,
      }}
    >
      {children}
    </AttachmentContext.Provider>
  );
}

export function useAttachments() {
  return useContext(AttachmentContext);
}
