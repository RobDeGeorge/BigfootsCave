/* eslint-env browser, node */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Reference = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';
/**
 * Turning a reference photo or artwork into something a pixel artist can use.
 *
 * Two operations, both pure functions over RGBA so the editor, the server and
 * the MCP server can share them. Getting RGBA in the first place differs by
 * host — a browser has canvas, Node has lib/png.js — but everything after that
 * is identical, so it lives here.
 *
 *   resample()  shrink to the sprite's real size. A reference only tells you
 *               which features survive once it is 32 pixels wide, and that is
 *               the question that decides what to draw.
 *   quantise()  reduce to N colours and hand back the palette. Sampled hues
 *               beat guessed ones, and guessing is what makes a set look muddy.
 */

/**
 * Box-filter down to tw×th.
 *
 * Colour is averaged weighted by alpha. Without that, transparent pixels drag
 * their (usually black) RGB into the average and every edge picks up a dark
 * halo — the classic artefact of naive image downscaling.
 */
function resample(rgba, w, h, tw, th) {
  if (!tw || !th) throw new Error('resample needs a positive target size');
  const out = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor(y * h / th), y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / th));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * w / tw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / tw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1 && sy < h; sy++) {
        for (let sx = x0; sx < x1 && sx < w; sx++) {
          const i = (sy * w + sx) * 4, av = rgba[i + 3];
          r += rgba[i] * av; g += rgba[i + 1] * av; b += rgba[i + 2] * av;
          a += av; n++;
        }
      }
      const o = (y * tw + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = n ? Math.round(a / n) : 0;
    }
  }
  return out;
}

const hex = (r, g, b) => '#' + [r, g, b].map(v =>
  Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/**
 * Median-cut quantisation to `colors` entries.
 *
 * Median cut repeatedly splits the most spread-out box of colours at its median
 * along its widest channel. It beats picking the most frequent colours, which
 * on a shaded sprite returns six near-identical midtones and no highlight.
 */
function quantise(rgba, w, h, colors, alphaCutoff) {
  const cut = alphaCutoff == null ? 128 : alphaCutoff;
  const n = Math.max(1, Math.min(64, Math.round(colors || 8)));

  const pixels = [];
  for (let i = 0; i < w * h; i++) {
    if (rgba[i * 4 + 3] >= cut) pixels.push([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]);
  }
  if (!pixels.length) return { palette: [], indices: new Int16Array(w * h).fill(-1) };

  let boxes = [pixels];
  while (boxes.length < n) {
    let target = -1, spread = -1, channel = 0;
    boxes.forEach((box, bi) => {
      if (box.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0;
        for (const px of box) { if (px[c] < lo) lo = px[c]; if (px[c] > hi) hi = px[c]; }
        if (hi - lo > spread) { spread = hi - lo; target = bi; channel = c; }
      }
    });
    if (target < 0 || spread <= 0) break;             // every box is a single colour
    const box = boxes[target];
    box.sort((p, q) => p[channel] - q[channel]);
    const mid = box.length >> 1;
    boxes.splice(target, 1, box.slice(0, mid), box.slice(mid));
  }

  const palette = boxes.filter(b => b.length).map(box => {
    let r = 0, g = 0, b = 0;
    for (const px of box) { r += px[0]; g += px[1]; b += px[2]; }
    return hex(r / box.length, g / box.length, b / box.length);
  });

  const rgbOf = palette.map(c => [
    parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]);
  const indices = new Int16Array(w * h).fill(-1);
  for (let i = 0; i < w * h; i++) {
    if (rgba[i * 4 + 3] < cut) continue;
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    let best = 0, bestD = Infinity;
    for (let p = 0; p < rgbOf.length; p++) {
      const d = (r - rgbOf[p][0]) ** 2 + (g - rgbOf[p][1]) ** 2 + (b - rgbOf[p][2]) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    indices[i] = best;
  }
  return { palette, indices };
}

/** Shrink then quantise — the whole reference-to-sprite conversion. */
function toSprite(rgba, w, h, tw, th, colors, alphaCutoff) {
  const small = resample(rgba, w, h, tw, th);
  const { palette, indices } = quantise(small, tw, th, colors, alphaCutoff);
  return { width: tw, height: th, rgba: small, palette, indices };
}

/**
 * Crop to the bounding box of the opaque pixels.
 *
 * Reference art usually carries a wide transparent margin and a sprite drawn to
 * fill its canvas does not, so comparing them untrimmed compares framing rather
 * than shape. Returns the input unchanged when nothing is drawn.
 */
function trim(rgba, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (rgba[(y * w + x) * 4 + 3] === 0) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return { rgba, width: w, height: h };
  const nw = x1 - x0 + 1, nh = y1 - y0 + 1;
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const src = ((y + y0) * w + x0) * 4;
    out.set(rgba.subarray(src, src + nw * 4), y * nw * 4);
  }
  return { rgba: out, width: nw, height: nh };
}

/** Scale to fit inside boxW×boxH, preserving aspect ratio, centred. */
function fitInto(rgba, w, h, boxW, boxH) {
  const s = Math.min(boxW / w, boxH / h);
  const nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
  const scaled = resample(rgba, w, h, nw, nh);
  const out = new Uint8Array(boxW * boxH * 4);
  const ox = Math.floor((boxW - nw) / 2), oy = Math.floor((boxH - nh) / 2);
  for (let y = 0; y < nh; y++) {
    out.set(scaled.subarray(y * nw * 4, (y + 1) * nw * 4), ((oy + y) * boxW + ox) * 4);
  }
  return out;
}

/** Sort a palette light to dark, which is the order a ramp is authored in. */
function byLuminance(palette) {
  return palette.slice().sort((a, b) => {
    const lum = c => 0.299 * parseInt(c.slice(1, 3), 16)
                   + 0.587 * parseInt(c.slice(3, 5), 16)
                   + 0.114 * parseInt(c.slice(5, 7), 16);
    return lum(b) - lum(a);
  });
}

return { resample, quantise, toSprite, trim, fitInto, byLuminance };
});
