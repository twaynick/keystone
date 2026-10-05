'use strict';

// Crosshair drawing, shared by the overlay and the preview in the Overlay
// tab so what you set up is exactly what you get. Loads in Node (tests) and
// in the browser, like map-math.js.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Crosshair = api;
})(typeof self !== 'undefined' ? self : this, () => {
  const STYLES = ['cross', 'dot', 'circle', 'crossdot', 'tee'];
  const COLORS = { accent: null, white: '#ffffff', green: '#4dff7c', red: '#ff4d4d', cyan: '#3df2ff', yellow: '#ffe14d' };
  const DEFAULTS = { on: false, style: 'cross', size: 10, thickness: 2, gap: 4, color: 'accent', opacity: 1, outline: true, dx: 0, dy: 0 };

  const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);

  // Cleans settings from disk or the UI; anything odd falls back to defaults.
  function normalize(c = {}) {
    return {
      on: Boolean(c.on),
      style: STYLES.includes(c.style) ? c.style : DEFAULTS.style,
      size: Math.round(clamp(c.size, 2, 40, DEFAULTS.size)),
      thickness: Math.round(clamp(c.thickness, 1, 8, DEFAULTS.thickness)),
      gap: Math.round(clamp(c.gap, 0, 30, DEFAULTS.gap)),
      color: c.color in COLORS || /^#[0-9a-f]{6}$/i.test(c.color || '') ? c.color : DEFAULTS.color,
      opacity: Math.round(clamp(c.opacity, 0.2, 1, 1) * 100) / 100,
      outline: c.outline === undefined ? DEFAULTS.outline : Boolean(c.outline),
      dx: Math.round(clamp(c.dx, -400, 400, 0)),
      dy: Math.round(clamp(c.dy, -400, 400, 0)),
    };
  }

  // How big a canvas the crosshair needs (CSS px, square).
  function extent(c) {
    return 2 * (c.size + c.gap + c.thickness + 3);
  }

  // Draws centred at (cx, cy). accent: the current accent colour, for
  // color "accent".
  function draw(ctx, c, cx, cy, accent) {
    const color = COLORS[c.color] || (c.color in COLORS ? accent : c.color) || accent;
    const t = c.thickness;
    const shapes = [];
    // Bars: [x, y, w, h], centred on whole or half pixels so thin lines
    // stay crisp instead of smearing across two pixel rows.
    const off = t % 2 ? 0.5 : 0;
    const x0 = Math.round(cx) + off;
    const y0 = Math.round(cy) + off;
    if (c.style === 'cross' || c.style === 'crossdot' || c.style === 'tee') {
      const near = c.gap;
      const far = c.gap + c.size;
      shapes.push(['rect', x0 + near, y0 - t / 2, far - near, t]);
      shapes.push(['rect', x0 - far, y0 - t / 2, far - near, t]);
      shapes.push(['rect', x0 - t / 2, y0 + near, t, far - near]);
      if (c.style !== 'tee') shapes.push(['rect', x0 - t / 2, y0 - far, t, far - near]);
    }
    if (c.style === 'dot' || c.style === 'crossdot') {
      const r = c.style === 'dot' ? Math.max(1.5, c.size / 4) : Math.max(1, t / 1.5);
      shapes.push(['dot', x0, y0, r]);
    }
    if (c.style === 'circle') shapes.push(['ring', x0, y0, c.size / 2 + c.gap]);

    ctx.save();
    ctx.globalAlpha = c.opacity;
    const paint = (stroke) => {
      for (const s of shapes) {
        ctx.beginPath();
        if (s[0] === 'rect') ctx.rect(s[1], s[2], s[3], s[4]);
        else if (s[0] === 'dot') ctx.arc(s[1], s[2], s[3], 0, Math.PI * 2);
        else ctx.arc(s[1], s[2], s[3], 0, Math.PI * 2);
        if (stroke) { ctx.lineWidth = s[0] === 'ring' ? t + 2 : 2; ctx.stroke(); } else if (s[0] === 'ring') { ctx.lineWidth = t; ctx.stroke(); } else ctx.fill();
      }
    };
    // A dark outline keeps the crosshair visible on bright and dark scenes.
    if (c.outline) { ctx.strokeStyle = 'rgba(0,0,0,0.85)'; paint(true); }
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    paint(false);
    ctx.restore();
  }

  return { STYLES, COLORS, DEFAULTS, normalize, extent, draw };
});
