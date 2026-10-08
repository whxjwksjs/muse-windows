const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hotkeyAPI', {
  get: () => ipcRenderer.invoke('hotkeys-get'),
  set: (bindings) => ipcRenderer.invoke('hotkeys-set', bindings),
});
