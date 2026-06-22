import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import {
  PB,
  type AuthPromptPayload,
  type AuthSubmitPayload,
  type BrowserApi,
  type DownloadPayload,
  type OpenTabPayload,
  type ShortcutPayload,
} from './ipc.js';

function listen<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: BrowserApi = {
  onShortcut: (cb) => listen<ShortcutPayload>(PB.shortcut, cb),
  onOpenTab: (cb) => listen<OpenTabPayload>(PB.openTab, cb),
  onDownload: (cb) => listen<DownloadPayload>(PB.download, cb),
  onAuthPrompt: (cb) => listen<AuthPromptPayload>(PB.authPrompt, cb),
  onMenuFind: (cb) => listen<void>('menu:find', () => cb()),
  openExternal: (url) => ipcRenderer.invoke(PB.openExternal, url),
  showInFolder: (path) => ipcRenderer.invoke(PB.showInFolder, path),
  submitAuth: (r: AuthSubmitPayload) => ipcRenderer.invoke(PB.authSubmit, r),
  reportZoom: (partition, level) => ipcRenderer.invoke(PB.zoomChanged, { partition, level }),
  getZoom: (partition) => ipcRenderer.invoke(PB.getZoom, partition),
};

contextBridge.exposeInMainWorld('browserApi', api);
