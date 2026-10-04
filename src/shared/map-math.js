'use strict';

// World <-> map image conversion. Shared by the main process (Node), the
// overlay and the desktop preview (browser), so it's written to load in both.
//
// A map is described by the world coordinates at the image's edges:
//   bounds = { left, right, top, bottom }
// Many games have Y pointing up while images have Y pointing down; that's just
// top > bottom here, so no separate "flip" setting is needed.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MapMath = api;
})(typeof self !== 'undefined' ? self : this, () => {
  function worldToImage(bounds, width, height, x, y) {
    return {
      x: ((x - bounds.left) / (bounds.right - bounds.left)) * width,
      y: ((y - bounds.top) / (bounds.bottom - bounds.top)) * height,
    };
  }

  function imageToWorld(bounds, width, height, px, py) {
    return {
      x: bounds.left + (px / width) * (bounds.right - bounds.left),
      y: bounds.top + (py / height) * (bounds.bottom - bounds.top),
    };
  }

  // Two-point calibration: the player stood at world position a.world, b.world
  // and clicked a.px, b.px on the image. Solves scale + offset per axis.
  function boundsFromTwoPoints(a, b, width, height) {
    const dwx = b.world.x - a.world.x;
    const dwy = b.world.y - a.world.y;
    const dpx = b.px.x - a.px.x;
    const dpy = b.px.y - a.px.y;
    // Too-close points make the scale wildly sensitive to a misclick.
    if (Math.abs(dpx) < width * 0.08 || Math.abs(dpy) < height * 0.08) {
      throw new Error('Pick two spots farther apart on the map, both left-right and up-down.');
    }
    if (Math.abs(dwx) < 1e-6 || Math.abs(dwy) < 1e-6) {
      throw new Error('Your position barely changed between the two spots. Move farther before the second click.');
    }
    const sx = dpx / dwx; // image px per world unit
    const sy = dpy / dwy;
    const left = a.world.x - a.px.x / sx;
    const top = a.world.y - a.px.y / sy;
    return { left, right: left + width / sx, top, bottom: top + height / sy };
  }

  function distance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  function validBounds(b) {
    return Boolean(b) && ['left', 'right', 'top', 'bottom'].every((k) => Number.isFinite(b[k])) &&
      b.left !== b.right && b.top !== b.bottom;
  }

  return { worldToImage, imageToWorld, boundsFromTwoPoints, distance, validBounds };
});
