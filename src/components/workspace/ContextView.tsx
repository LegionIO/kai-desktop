import { useState, useEffect, useCallback, type FC } from 'react';
import { BookOpenIcon, Loader2Icon } from 'lucide-react';
import { FileTree, type FileNode } from './FileTree';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import { app } from '@/lib/ipc-client';

/* ── Helpers ───────────────────────────────────────────── */

/** Convert flat directory listing to FileNode[] */
function entriesToNodes(
  entries: Array<{ name: string; isDirectory: boolean }>,
): FileNode[] {
  return entries.map((e) => ({
    name: e.name,
    type: e.isDirectory ? 'directory' as const : 'file' as const,
    children: e.isDirectory ? [] : undefined,
  }));
}

/* ── Component ──────────────────────────────────────────── */

export const ContextView: FC = () => {
  const { project } = useWorkspace();
  const [tree, setTree] = useState<FileNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | undefined>();
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  // Load root directory listing when project changes
  useEffect(() => {
    if (!project) {
      setTree([]);
      setSelectedFile(undefined);
      setFileContent(null);
      return;
    }
    let cancelled = false;
    setTreeLoading(true);
    app.fs.listDirectory(project.path).then((result) => {
      if (cancelled) return;
      if (result.error) {
        console.warn('[ContextView] Failed to list directory:', result.error);
        setTree([]);
      } else {
        setTree(entriesToNodes(result.entries));
      }
    }).catch(() => {
      if (!cancelled) setTree([]);
    }).finally(() => {
      if (!cancelled) setTreeLoading(false);
    });
    return () => { cancelled = true; };
  }, [project]);

  // Load file content when a file is selected
  const handleSelect = useCallback((path: string) => {
    setSelectedFile(path);
    if (!project) return;

    // Build full path
    const fullPath = `${project.path}/${path}`;
    setFileLoading(true);
    setFileError(null);
    setFileContent(null);

    app.fs.readFile(fullPath).then((result) => {
      if (result.error) {
        setFileError(result.error);
      } else {
        setFileContent(result.content ?? '');
      }
    }).catch((err) => {
      setFileError(String(err));
    }).finally(() => {
      setFileLoading(false);
    });
  }, [project]);

  const projectLabel = project?.path ?? '~/project';

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Context</h2>
          <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/50">{projectLabel}</p>
        </div>
      </div>

      {/* Split view */}
      <div className="flex min-h-0 flex-1">
        {/* File tree (left) */}
        <div className="w-[250px] shrink-0 overflow-y-auto border-r border-border/40 p-2">
          {treeLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2Icon className="h-5 w-5 animate-spin text-muted-foreground/40" />
            </div>
          ) : tree.length > 0 ? (
            <FileTree
              nodes={tree}
              selectedPath={selectedFile}
              onSelect={handleSelect}
            />
          ) : (
            <p className="px-2 py-4 text-xs text-muted-foreground/50">
              {project ? 'No files found' : 'Open a project first'}
            </p>
          )}
        </div>

        {/* File preview (right) */}
        <div className="flex min-w-0 flex-1 flex-col">
          {selectedFile ? (
            <>
              {/* File name bar */}
              <div className="border-b border-border/40 px-4 py-2">
                <span className="font-mono text-xs text-foreground/80">{selectedFile}</span>
              </div>

              {/* Preview area */}
              <div className="flex-1 overflow-auto p-4">
                {fileLoading ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground/50">
                    <Loader2Icon className="h-4 w-4 animate-spin" />
                    Loading...
                  </div>
                ) : fileError ? (
                  <pre className="font-mono text-xs text-destructive/70 leading-relaxed">
                    {fileError}
                  </pre>
                ) : (
                  <pre className="font-mono text-xs text-muted-foreground/80 leading-relaxed whitespace-pre-wrap break-all">
                    {fileContent}
                  </pre>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <BookOpenIcon className="h-10 w-10 text-muted-foreground/40" />
              <div>
                <p className="text-sm font-medium text-muted-foreground">Select a file to preview</p>
                <p className="mt-1 text-xs text-muted-foreground/60">
                  Browse the file tree on the left to view contents.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
