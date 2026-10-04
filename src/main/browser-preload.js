'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Only for Keystone's own toolbar page. Websites run inside the <webview>,
// which gets no preload at all (see KeystoneBrowser.hardenWebview).
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('browserApi', {
  state: () => invoke('browser:state'),
  setOpacity: (v) => invoke('browser:opacity', v),
  setOnTop: (on) => invoke('browser:onTop', on),
  setHome: (url) => invoke('browser:home', url),
  hide: () => invoke('browser:hide'),
  onNavigate: (cb) => {
    const l = (_e, url) => cb(url);
    ipcRenderer.on('browser:navigate', l);
    return () => ipcRenderer.removeListener('browser:navigate', l);
  },
});
