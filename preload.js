const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize:       () => ipcRenderer.send('minimize'),
  close:          () => ipcRenderer.send('close'),

  // Admin
  relaunchAdmin:  () => ipcRenderer.send('relaunch-admin'),
  onAdminStatus:  (cb) => ipcRenderer.once('admin-status', (_, v) => cb(v)),

  // Install
  startInstall:      (apps) => ipcRenderer.send('start-install', apps),
  onAppStatus:       (cb)   => ipcRenderer.on('app-status',      (_, d) => cb(d)),
  onInstallComplete: (cb)   => ipcRenderer.once('install-complete', (_, d) => cb(d)),

  // Installed check
  checkInstalled: (ids) => ipcRenderer.invoke('check-installed', ids),

  // Logs
  openLogs: () => ipcRenderer.send('open-logs'),

  // Auto-update
  checkUpdate:      ()        => ipcRenderer.invoke('check-update'),
  applyUpdate:      (payload) => ipcRenderer.send('apply-update', payload),
  onUpdateProgress: (cb)      => ipcRenderer.on('update-progress', (_, d) => cb(d)),

  // Cleanup listeners
  removeListeners: () => {
    ipcRenderer.removeAllListeners('app-status');
    ipcRenderer.removeAllListeners('install-complete');
    ipcRenderer.removeAllListeners('update-progress');
  },
});
