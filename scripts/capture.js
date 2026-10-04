'use strict';

// Dev helper: launches the app, runs a snippet in the main window, and saves a
// screenshot. Used to check UI changes without clicking through by hand.
//   CAPTURE_OUT=shot.png CAPTURE_JS="document.getElementById('demoBtn').click()" npm run capture
const { app, BrowserWindow } = require('electron');
const fs = require('fs');

require('../src/main/main.js');

const out = process.env.CAPTURE_OUT || 'capture.png';
const wait = Number(process.env.CAPTURE_WAIT || 1500);
const js = process.env.CAPTURE_JS || '';

let hooked = false;
app.on('browser-window-created', (_e, win) => {
  // Only the first window (the main one); the overlay window is created later.
  if (hooked) return;
  hooked = true;
  win.webContents.once('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 600));
    if (js) await win.webContents.executeJavaScript(`(async () => { ${js} })()`);
    await new Promise((r) => setTimeout(r, wait));
    // CAPTURE_TARGET=overlay|browser grabs that window instead of the main one.
    const page = { overlay: 'overlay.html', browser: 'browser.html' }[process.env.CAPTURE_TARGET];
    const target = page
      ? BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith(page)) || win
      : win;
    const img = await target.webContents.capturePage();
    fs.writeFileSync(out, img.toPNG());
    app.quit();
  });
});
