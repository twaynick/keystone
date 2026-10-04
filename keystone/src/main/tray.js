'use strict';

const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');

// System tray icon. Keystone keeps running here when the window is closed,
// so the overlay, phone remote and hotkeys stay available while you play.

function createTray({ root, onOpen, onQuit, getState, setOverlay, setPhone }) {
  const icon = nativeImage.createFromPath(path.join(root, 'assets', 'icon-256.png')).resize({ width: 16, height: 16 });
  const tray = new Tray(icon);
  tray.setToolTip('Keystone');

  const rebuild = async () => {
    const st = await getState();
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Keystone', click: onOpen },
      { type: 'separator' },
      { label: st.game ? `Game: ${st.game}` : 'No game selected', enabled: false },
      { label: 'Show overlay', type: 'checkbox', checked: st.overlay, click: (item) => setOverlay(item.checked) },
      { label: 'Phone control', type: 'checkbox', checked: st.phone, click: (item) => setPhone(item.checked) },
      { type: 'separator' },
      { label: 'Quit Keystone', click: onQuit },
    ]));
  };

  // Windows convention: a single click on a tray icon opens the app.
  tray.on('click', onOpen);
  rebuild();
  return { tray, rebuild, destroy: () => tray.destroy() };
}

module.exports = { createTray };
