'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
function on(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('overlayApi', {
  onState: (cb) => on('overlay:state', cb),
  onValues: (cb) => on('overlay:values', cb),
  onMode: (cb) => on('overlay:mode', cb),
  onFlash: (cb) => on('overlay:flash', cb),
  setPanel: (id, patch) => invoke('overlay:setPanel', id, patch),
  addWaypoint: (wp) => invoke('overlay:addWaypoint', wp),
  setTracked: (id) => invoke('overlay:setTracked', id),
  setZoom: (z) => invoke('overlay:setZoom', z),
  finishEditing: () => invoke('overlay:edit', false),
});
