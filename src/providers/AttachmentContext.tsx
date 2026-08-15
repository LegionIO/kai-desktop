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

  // Keep ref in sync
  attachmentsRef.current = attachments;

  const addAttachments = useCallback((files: AttachedFile[]) => {
    setAttachments((prev) => [...prev, ...files]);
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments([]);
  }, []);

  const consumeAttachments = useCallback((): AttachedFile[] => {
    const current = attachmentsRef.current;
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
