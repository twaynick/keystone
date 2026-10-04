'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
function on(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('overlayApi', {
  appearance: () => invoke('app:appearance'),
  onAppearance: (cb) => on('app:appearance', cb),
  quickAction: (id) => invoke('mod:quick', id),
  onState: (cb) => on('overlay:state', cb),
  onValues: (cb) => on('overlay:values', cb),
  onMode: (cb) => on('overlay:mode', cb),
  onFlash: (cb) => on('overlay:flash', cb),
  setPanel: (id, patch) => invoke('overlay:setPanel', id, patch),
  addWaypoint: (wp) => invoke('overlay:addWaypoint', wp),
  setTracked: (id) => invoke('overlay:setTracked', id),
  teleportTo: (pos) => invoke('overlay:teleportTo', pos),
  setZoom: (z) => invoke('overlay:setZoom', z),
  finishEditing: () => invoke('overlay:edit', false),
});
