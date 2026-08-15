import { createContext, useContext, useRef, useCallback, useState, type ReactNode } from 'react';

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
  addAttachments: (files: AttachedFile[]) => void;
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
  addAttachments: () => {},
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

  const addAttachments = useCallback((files: AttachedFile[]) => {
    attachmentsRef.current = [...attachmentsRef.current, ...files];
    setAttachments(attachmentsRef.current);
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
