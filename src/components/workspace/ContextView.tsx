import { useState, type FC } from 'react';
import { BookOpenIcon } from 'lucide-react';
import { FileTree, SAMPLE_TREE } from './FileTree';

/* ── Component ──────────────────────────────────────────── */

export const ContextView: FC = () => {
  const [selectedFile, setSelectedFile] = useState<string | undefined>();

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Context</h2>
          <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/50">~/project</p>
        </div>
      </div>

      {/* Split view */}
      <div className="flex min-h-0 flex-1">
        {/* File tree (left) */}
        <div className="w-[250px] shrink-0 overflow-y-auto border-r border-border/40 p-2">
          <FileTree
            nodes={SAMPLE_TREE}
            selectedPath={selectedFile}
            onSelect={setSelectedFile}
          />
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
                <pre className="font-mono text-xs text-muted-foreground/60 leading-relaxed">
                  File preview will be available when connected to the filesystem
                </pre>
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
