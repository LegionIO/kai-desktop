import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type PropsWithChildren,
} from 'react';
import { useSidePanelOptional } from '@/components/side-panel/SidePanelHost';

export type ArtifactType = 'html' | 'markdown' | 'svg' | 'mermaid' | 'react' | 'text';

export type ArtifactVersion = {
  content: string;
  title: string;
  updatedAt: string;
};

export type Artifact = {
  id: string;
  title: string;
  type: ArtifactType;
  content: string;
  updatedAt: string;
  /** Full version history — index 0 is the first version, last is current. */
  versions: ArtifactVersion[];
};

export type ArtifactUpsert = {
  id: string;
  title?: string;
  type?: ArtifactType;
  content: string;
  updatedAt?: string;
};

type ArtifactContextValue = {
  artifacts: Map<string, Artifact>;
  activeId: string | null;
  /** Create or update an artifact. Pushes a new version when content changed. */
  upsert: (artifact: ArtifactUpsert) => Artifact;
  setActive: (id: string | null) => void;
  /** Open the side panel on the Preview tab. */
  openPanel: () => void;
  closePanel: () => void;
  minimizePanel: () => void;
};

const ArtifactContext = createContext<ArtifactContextValue | null>(null);

/** Tab id used by the Preview tab in `SidePanelHost`. */
export const ARTIFACT_PREVIEW_TAB_ID = 'preview';

export const ArtifactProvider: FC<PropsWithChildren> = ({ children }) => {
  const sidePanel = useSidePanelOptional();
  const [artifacts, setArtifacts] = useState<Map<string, Artifact>>(() => new Map());
  // Mirror of the latest artifacts map so upsert() can compute the resulting
  // record synchronously (React doesn't guarantee the setState updater runs
  // synchronously, so we must not derive the return value inside it).
  const artifactsRef = useRef(artifacts);
  useEffect(() => {
    artifactsRef.current = artifacts;
  }, [artifacts]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const upsert = useCallback((input: ArtifactUpsert): Artifact => {
    const now = input.updatedAt ?? new Date().toISOString();
    // Compute the resulting record from the latest map BEFORE calling
    // setArtifacts, so the return value is deterministic (the setState updater
    // may run asynchronously).
    const existing = artifactsRef.current.get(input.id);
    let record: Artifact;
    if (existing) {
      const contentChanged = existing.content !== input.content;
      record = {
        ...existing,
        title: input.title ?? existing.title,
        type: input.type ?? existing.type,
        content: input.content,
        updatedAt: now,
        versions: contentChanged
          ? [...existing.versions, { content: input.content, title: input.title ?? existing.title, updatedAt: now }]
          : existing.versions,
      };
    } else {
      record = {
        id: input.id,
        title: input.title ?? 'Untitled',
        type: input.type ?? 'text',
        content: input.content,
        updatedAt: now,
        versions: [{ content: input.content, title: input.title ?? 'Untitled', updatedAt: now }],
      };
    }
    // Keep the ref in sync immediately so a rapid second upsert in the same tick
    // (before the effect runs) still sees this record.
    const nextMap = new Map(artifactsRef.current);
    nextMap.set(input.id, record);
    artifactsRef.current = nextMap;
    setArtifacts(nextMap);
    setActiveId(input.id);
    return record;
  }, []);

  const setActive = useCallback((id: string | null) => setActiveId(id), []);

  const openPanel = useCallback(() => {
    sidePanel?.openPanel(ARTIFACT_PREVIEW_TAB_ID);
  }, [sidePanel]);

  const closePanel = useCallback(() => sidePanel?.closePanel(), [sidePanel]);
  const minimizePanel = useCallback(() => sidePanel?.minimizePanel(), [sidePanel]);

  const value = useMemo<ArtifactContextValue>(
    () => ({ artifacts, activeId, upsert, setActive, openPanel, closePanel, minimizePanel }),
    [artifacts, activeId, upsert, setActive, openPanel, closePanel, minimizePanel],
  );

  return <ArtifactContext.Provider value={value}>{children}</ArtifactContext.Provider>;
};

export function useArtifacts(): ArtifactContextValue {
  const ctx = useContext(ArtifactContext);
  if (!ctx) throw new Error('useArtifacts must be used within an <ArtifactProvider>');
  return ctx;
}

export function useArtifactsOptional(): ArtifactContextValue | null {
  return useContext(ArtifactContext);
}
