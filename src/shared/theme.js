'use strict';

// Accent color for every Keystone page (app, overlay, browser, phone).
// Only light accents are offered, so dark text on an accent fill is always
// readable; that's why the ink color is fixed.
(function (root) {
  const ACCENTS = [
    { id: 'keystone', label: 'Keystone purple', hex: '#c48aff' },
    { id: 'lime', label: 'Lime', hex: '#e7ff0c' },
    { id: 'sky', label: 'Sky', hex: '#5cc8ff' },
    { id: 'mint', label: 'Mint', hex: '#4be3c1' },
    { id: 'coral', label: 'Coral', hex: '#ff8a5c' },
    { id: 'rose', label: 'Rose', hex: '#ff8fb1' },
  ];

  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  function applyAccent(id) {
    const a = ACCENTS.find((x) => x.id === id) || ACCENTS[0];
    const s = document.documentElement.style;
    s.setProperty('--accent', a.hex);
    s.setProperty('--accent-wash', rgba(a.hex, 0.12));
    s.setProperty('--accent-line', rgba(a.hex, 0.55));
    s.setProperty('--accent-glow', rgba(a.hex, 0.4));
    return a;
  }

  root.KeystoneTheme = { ACCENTS, applyAccent };
})(typeof self !== 'undefined' ? self : this);
