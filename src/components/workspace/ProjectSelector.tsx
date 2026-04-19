import { useState, type FC } from 'react';
import { BriefcaseIcon, FolderOpenIcon } from 'lucide-react';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import { app } from '@/lib/ipc-client';

export const ProjectSelector: FC = () => {
  const { setProject } = useWorkspace();
  const [inputVisible, setInputVisible] = useState(false);
  const [path, setPath] = useState('');

  const handleOpen = () => {
    // Use native folder dialog via IPC
    if (app?.dialog?.openDirectory) {
      void app.dialog.openDirectory().then((result) => {
        if (!result.canceled && result.directoryPath) {
          const folderPath = result.directoryPath;
          const name = result.name ?? folderPath.split('/').pop() ?? folderPath.split('\\').pop() ?? 'Project';
          setProject({ path: folderPath, name });
        }
      });
      return;
    }
    // Fallback: show inline path input
    setInputVisible(true);
  };

  const handleSubmitPath = () => {
    const trimmed = path.trim();
    if (!trimmed) return;
    const name = trimmed.split('/').pop() ?? trimmed.split('\\').pop() ?? 'Project';
    setProject({ path: trimmed, name });
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <BriefcaseIcon className="h-12 w-12 text-muted-foreground/30" />
      <div>
        <h2 className="text-sm font-semibold text-foreground">Select a Project</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose a folder to start your workspace.
        </p>
      </div>

      {inputVisible ? (
        <div className="flex w-full max-w-xs gap-2">
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSubmitPath(); }}
            placeholder="/path/to/project"
            autoFocus
            className="flex-1 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            type="button"
            onClick={handleSubmitPath}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Open
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={handleOpen}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <FolderOpenIcon className="h-[14px] w-[14px]" />
          Open Project
        </button>
      )}
    </div>
  );
};
