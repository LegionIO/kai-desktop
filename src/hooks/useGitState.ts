import { useState, useEffect, useCallback, useRef } from 'react';
import { app } from '@/lib/ipc-client';
import type { GitBranch, GitCommit, GitStagedFile, GitRemoteStatus } from '../../shared/workspace-types';

interface UseGitStateReturn {
  currentBranch: string;
  branches: GitBranch[];
  defaultBranch: string;
  files: GitStagedFile[];
  remoteStatus: GitRemoteStatus;
  commits: GitCommit[];
  lastFetchTime: number | null;
  loading: boolean;
  syncing: boolean;
  // Mutations
  stage: (filePaths: string[]) => Promise<void>;
  unstage: (filePaths: string[]) => Promise<void>;
  stageAll: () => Promise<void>;
  unstageAll: () => Promise<void>;
  commit: (summary: string, description?: string) => Promise<{ success: boolean; error?: string }>;
  checkout: (branchName: string) => Promise<{ success: boolean; error?: string }>;
  createBranch: (branchName: string) => Promise<{ success: boolean; error?: string }>;
  fetchOrigin: () => Promise<{ success: boolean; error?: string }>;
  pullOrigin: () => Promise<{ success: boolean; error?: string }>;
  pushOrigin: () => Promise<{ success: boolean; error?: string }>;
  refreshFiles: () => Promise<void>;
  refreshAll: () => Promise<void>;
  loadHistory: (limit?: number) => Promise<void>;
}

export function useGitState(projectPath: string): UseGitStateReturn {
  const [currentBranch, setCurrentBranch] = useState('');
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [files, setFiles] = useState<GitStagedFile[]>([]);
  const [remoteStatus, setRemoteStatus] = useState<GitRemoteStatus>({ ahead: 0, behind: 0 });
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [lastFetchTime, setLastFetchTime] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const mountedRef = useRef(true);

  const refreshBranch = useCallback(async () => {
    if (!projectPath) return;
    try {
      const result = await app.git.currentBranch(projectPath);
      if (mountedRef.current && result.branch) setCurrentBranch(result.branch);
    } catch (err) { console.warn('[git] currentBranch failed:', err); }
  }, [projectPath]);

  const refreshBranches = useCallback(async () => {
    if (!projectPath) return;
    try {
      const result = await app.git.branches(projectPath);
      if (mountedRef.current) {
        setBranches(result.branches ?? []);
        setDefaultBranch(result.defaultBranch ?? 'main');
      }
    } catch (err) { console.warn('[git] branches failed:', err); }
  }, [projectPath]);

  const refreshFiles = useCallback(async () => {
    if (!projectPath) return;
    try {
      const result = await app.git.stagedStatus(projectPath);
      if (mountedRef.current) setFiles(result.files ?? []);
    } catch (err) { console.warn('[git] stagedStatus failed:', err); }
  }, [projectPath]);

  const refreshRemoteStatus = useCallback(async () => {
    if (!projectPath) return;
    try {
      const result = await app.git.remoteStatus(projectPath);
      if (mountedRef.current) setRemoteStatus({ ahead: result.ahead ?? 0, behind: result.behind ?? 0 });
    } catch (err) { console.warn('[git] remoteStatus failed:', err); }
  }, [projectPath]);

  const refreshAll = useCallback(async () => {
    if (!projectPath) return;
    setLoading(true);
    await Promise.all([refreshBranch(), refreshBranches(), refreshFiles(), refreshRemoteStatus()]);
    if (mountedRef.current) setLoading(false);
  }, [projectPath, refreshBranch, refreshBranches, refreshFiles, refreshRemoteStatus]);

  const loadHistory = useCallback(async (limit?: number) => {
    if (!projectPath) return;
    try {
      const result = await app.git.log(projectPath, limit);
      if (mountedRef.current) setCommits(result.commits ?? []);
    } catch { /* ignore */ }
  }, [projectPath]);

  // Initial load
  useEffect(() => {
    mountedRef.current = true;
    if (projectPath) refreshAll();
    return () => { mountedRef.current = false; };
  }, [projectPath, refreshAll]);

  // Poll remote status every 60s
  useEffect(() => {
    if (!projectPath) return;
    const interval = setInterval(refreshRemoteStatus, 60000);
    return () => clearInterval(interval);
  }, [projectPath, refreshRemoteStatus]);

  // Mutations
  const stage = useCallback(async (filePaths: string[]) => {
    if (!projectPath) return;
    await app.git.stage(projectPath, filePaths);
    await refreshFiles();
  }, [projectPath, refreshFiles]);

  const unstage = useCallback(async (filePaths: string[]) => {
    if (!projectPath) return;
    await app.git.unstage(projectPath, filePaths);
    await refreshFiles();
  }, [projectPath, refreshFiles]);

  const stageAll = useCallback(async () => {
    const unstaged = files.filter((f) => !f.staged).map((f) => f.path);
    if (unstaged.length > 0) await stage(unstaged);
  }, [files, stage]);

  const unstageAll = useCallback(async () => {
    const staged = files.filter((f) => f.staged).map((f) => f.path);
    if (staged.length > 0) await unstage(staged);
  }, [files, unstage]);

  const commit = useCallback(async (summary: string, description?: string) => {
    if (!projectPath) return { success: false, error: 'No project' };
    const result = await app.git.commit(projectPath, summary, description);
    if (result.success) {
      await refreshFiles();
      await refreshRemoteStatus();
    }
    return result;
  }, [projectPath, refreshFiles, refreshRemoteStatus]);

  const checkout = useCallback(async (branchName: string) => {
    if (!projectPath) return { success: false, error: 'No project' };
    const result = await app.git.checkout(projectPath, branchName);
    if (result.success) await refreshAll();
    return result;
  }, [projectPath, refreshAll]);

  const createBranch = useCallback(async (branchName: string) => {
    if (!projectPath) return { success: false, error: 'No project' };
    const result = await app.git.createBranch(projectPath, branchName);
    if (result.success) await refreshAll();
    return result;
  }, [projectPath, refreshAll]);

  const fetchOrigin = useCallback(async () => {
    if (!projectPath) return { success: false, error: 'No project' };
    setSyncing(true);
    const result = await app.git.fetch(projectPath);
    if (result.success) {
      setLastFetchTime(Date.now());
      await refreshRemoteStatus();
    }
    if (mountedRef.current) setSyncing(false);
    return result;
  }, [projectPath, refreshRemoteStatus]);

  const pullOrigin = useCallback(async () => {
    if (!projectPath) return { success: false, error: 'No project' };
    setSyncing(true);
    const result = await app.git.pull(projectPath);
    if (result.success) {
      await refreshAll();
      setLastFetchTime(Date.now());
    }
    if (mountedRef.current) setSyncing(false);
    return result;
  }, [projectPath, refreshAll]);

  const pushOrigin = useCallback(async () => {
    if (!projectPath) return { success: false, error: 'No project' };
    setSyncing(true);
    const result = await app.git.push(projectPath);
    if (result.success) await refreshRemoteStatus();
    if (mountedRef.current) setSyncing(false);
    return result;
  }, [projectPath, refreshRemoteStatus]);

  return {
    currentBranch,
    branches,
    defaultBranch,
    files,
    remoteStatus,
    commits,
    lastFetchTime,
    loading,
    syncing,
    stage,
    unstage,
    stageAll,
    unstageAll,
    commit,
    checkout,
    createBranch,
    fetchOrigin,
    pullOrigin,
    pushOrigin,
    refreshFiles,
    refreshAll,
    loadHistory,
  };
}
