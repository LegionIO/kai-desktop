// This sandboxed preload deliberately has no generic IPC or window.app API.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bridgeApproval', {
  read: () => ipcRenderer.invoke('bridge-approval:read'),
  decide: (id, approved) => ipcRenderer.invoke('bridge-approval:decide', id, approved),
});
