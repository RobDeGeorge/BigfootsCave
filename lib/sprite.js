/* eslint-env browser, node */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sprite = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';
/**
 * The sprite format shared by the editor, the HTTP server and the MCP server.
 *
 *   {
 *     format:  "pixelart/1",
 *     name:    "heart",
 *     w: 16, h: 16, fps: 8,
 *     palette: ["#0f380f", "#306230", ...],   // index 0..n-1
 *     frames:  [ { layers: [ { name, visible, opacity, data } ] } ],
 *     tags:    ["ui", "icon"]
 *   }
 *
 * `data` is a run-length string of "count.index" pairs, index -1 = transparent.
 * Runs read left-to-right, top-to-bottom. Total run length always equals w*h.
 */

const FORMAT = 'pixelart/1';

// ---------------------------------------------------------------- run-length

function encodeRLE(pixels) {
  if (!pixels.length) return '';
  const runs = [];
  let value = pixels[0], count = 1;
  for (let i = 1; i < pixels.length; i++) {
    if (pixels[i] === value) { count++; continue; }
    runs.push(count + '.' + value);
    value = pixels[i]; count = 1;
  }
  runs.push(count + '.' + value);
  return runs.join(' ');
}

function decodeRLE(str, length) {
  const out = new Int16Array(length).fill(-1);
  if (!str) return out;
  let at = 0;
  for (const run of str.split(' ')) {
    if (!run) continue;
    const dot = run.indexOf('.');
    const count = parseInt(run.slice(0, dot), 10);
    const value = parseInt(run.slice(dot + 1), 10);
    for (let i = 0; i < count && at < length; i++) out[at++] = value;
  }
  return out;
}

// ------------------------------------------------------------------ palettes

const PALETTES = {
  dmg: {
    name: 'Game Boy DMG',
    colors: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'],
  },
  pocket: {
    name: 'Game Boy Pocket',
    colors: ['#000000', '#555555', '#aaaaaa', '#ffffff'],
  },
  gbc: {
    name: 'Game Boy Color',
    colors: ['#000000', '#3e3e3e', '#7c7c7c', '#bcbcbc', '#ffffff',
             '#a41e11', '#e84b30', '#f8a05c', '#f8d878', '#186818',
             '#38a038', '#78d858', '#0058f8', '#3cbcfc', '#6844fc', '#f878f8'],
  },
  pico8: {
    name: 'PICO-8',
    colors: ['#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f',
             '#c2c3c7', '#fff1e8', '#ff004d', '#ffa300', '#ffec27', '#00e436',
             '#29adff', '#83769c', '#ff77a8', '#ffccaa'],
  },
  nes: {
    name: 'NES',
    colors: ['#000000', '#fcfcfc', '#f8f8f8', '#bcbcbc', '#7c7c7c', '#a4e4fc',
             '#3cbcfc', '#0078f8', '#0000fc', '#b8b8f8', '#6888fc', '#0058f8',
             '#d8b8f8', '#9878f8', '#6844fc', '#f8b8f8', '#f878f8', '#d800cc',
             '#f8a4c0', '#f85898', '#e40058', '#f0d0b0', '#f87858', '#f83800',
             '#fce0a8', '#fca044', '#e45c10', '#f8d878', '#f8b800', '#ac7c00',
             '#d8f878', '#b8f818', '#00b800', '#b8f8b8', '#58d854', '#00a800',
             '#b8f8d8', '#58f898', '#00a844', '#00fcfc', '#00e8d8', '#008888'],
  },
  sweetie16: {
    name: 'Sweetie 16',
    colors: ['#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75', '#a7f070',
             '#38b764', '#257179', '#29366f', '#3b5dc9', '#41a6f6', '#73eff7',
             '#f4f4f4', '#94b0c2', '#566c86', '#333c57'],
  },
  cga: {
    name: 'CGA',
    colors: ['#000000', '#0000aa', '#00aa00', '#00aaaa', '#aa0000', '#aa00aa',
             '#aa5500', '#aaaaaa', '#555555', '#5555ff', '#55ff55', '#55ffff',
             '#ff5555', '#ff55ff', '#ffff55', '#ffffff'],
  },
  endesga32: {
    name: 'Endesga 32',
    colors: ['#be4a2f', '#d77643', '#ead4aa', '#e4a672', '#b86f50', '#733e39',
             '#3e2731', '#a22633', '#e43b44', '#f77622', '#feae34', '#fee761',
             '#63c74d', '#3e8948', '#265c42', '#193c3e', '#124e89', '#0099db',
             '#2ce8f5', '#ffffff', '#c0cbdc', '#8b9bb4', '#5a6988', '#3a4466',
             '#262b44', '#181425', '#ff0044', '#68386c', '#b55088', '#f6757a',
             '#e8b796', '#c28569'],
  },
};

// ---------------------------------------------------------------- construction

function emptyLayer(w, h, name) {
  return { name: name || 'Layer 1', visible: true, opacity: 1, data: encodeRLE(new Array(w * h).fill(-1)) };
}

function newSprite(opts) {
  const o = opts || {};
  const w = clampSize(o.w != null ? o.w : 16);
  const h = clampSize(o.h != null ? o.h : 16);
  const pal = o.palette || (PALETTES[o.paletteName] || PALETTES.dmg).colors;
  return {
    format: FORMAT,
    name: o.name || 'untitled',
    w, h,
    fps: o.fps || 8,
    palette: pal.slice(),
    frames: [{ layers: [emptyLayer(w, h)] }],
    tags: o.tags || [],
  };
}

function clampSize(n) {
  n = Math.round(Number(n) || 16);
  if (n < 1) n = 1;
  if (n > 512) n = 512;
  return n;
}

/**
 * Ceiling on a single rendered image, in pixels. A render costs 4 bytes per
 * output pixel, so this is the memory a request is allowed to ask for: 16.7M
 * pixels is 67 MB of RGBA. Clamping the *scale factor* alone is not enough —
 * scale is multiplicative on both axes, so a 512×512 sprite at 64× is 32768²,
 * or 4.3 GB, which is one request away from taking the process down.
 */
const MAX_OUTPUT_PIXELS = 4096 * 4096;

/**
 * The largest integer scale that keeps `tiles` copies of a w×h sprite inside
 * the output budget. `tiles` is the frame count for sheets and GIFs, 1 for a
 * single frame. Callers clamp rather than throw so that an over-large request
 * still returns a usable image instead of an error.
 */
function clampScale(w, h, scale, tiles) {
  scale = Math.max(1, Math.round(Number(scale) || 1));
  const cells = Math.max(1, Math.round(Number(tiles) || 1));
  const area = Math.max(1, w * h * cells);
  const max = Math.max(1, Math.floor(Math.sqrt(MAX_OUTPUT_PIXELS / area)));
  return Math.min(scale, max);
}

/** Throws on anything malformed; returns a normalised copy. */
function validate(sprite) {
  if (!sprite || typeof sprite !== 'object') throw new Error('sprite must be an object');
  const w = clampSize(sprite.w), h = clampSize(sprite.h);
  if (!Array.isArray(sprite.palette) || !sprite.palette.length) throw new Error('sprite.palette must be a non-empty array');
  for (const c of sprite.palette) {
    if (!/^#[0-9a-fA-F]{6}$/.test(c)) throw new Error('bad palette colour: ' + c + ' (want #rrggbb)');
  }
  if (!Array.isArray(sprite.frames) || !sprite.frames.length) throw new Error('sprite.frames must be a non-empty array');
  const frames = sprite.frames.map((f, fi) => {
    if (!f || !Array.isArray(f.layers) || !f.layers.length) throw new Error('frame ' + fi + ' has no layers');
    return {
      layers: f.layers.map((l, li) => ({
        name: String(l.name || 'Layer ' + (li + 1)),
        visible: l.visible !== false,
        opacity: l.opacity == null ? 1 : Math.max(0, Math.min(1, Number(l.opacity))),
        data: encodeRLE(Array.from(decodeRLE(l.data || '', w * h))),
      })),
    };
  });
  return {
    format: FORMAT,
    name: String(sprite.name || 'untitled'),
    w, h,
    fps: Math.max(1, Math.min(60, Math.round(Number(sprite.fps) || 8))),
    palette: sprite.palette.map(c => c.toLowerCase()),
    frames,
    tags: Array.isArray(sprite.tags) ? sprite.tags.map(String) : [],
  };
}

// ------------------------------------------------------------------ flatten

/** Composite one frame's visible layers into a flat Int16Array of palette indices. */
function flattenFrame(sprite, frameIndex) {
  const frame = sprite.frames[frameIndex || 0];
  const size = sprite.w * sprite.h;
  const out = new Int16Array(size).fill(-1);
  for (const layer of frame.layers) {
    if (!layer.visible || layer.opacity === 0) continue;
    const px = decodeRLE(layer.data, size);
    for (let i = 0; i < size; i++) if (px[i] >= 0) out[i] = px[i];
  }
  return out;
}

/** Composite to RGBA bytes at a given integer scale. */
function frameToRGBA(sprite, frameIndex, scale) {
  scale = Math.max(1, Math.round(scale || 1));
  const px = flattenFrame(sprite, frameIndex);
  const W = sprite.w * scale, H = sprite.h * scale;
  // Backstop. Callers are expected to have run the scale through clampScale;
  // this catches the ones that forget rather than trusting them.
  if (W * H > MAX_OUTPUT_PIXELS) {
    throw new Error('render too large: ' + W + '×' + H + ' exceeds the ' + MAX_OUTPUT_PIXELS + ' pixel limit');
  }
  const rgba = new Uint8Array(W * H * 4);
  const rgb = sprite.palette.map(hexToRGB);
  for (let y = 0; y < sprite.h; y++) {
    for (let x = 0; x < sprite.w; x++) {
      const idx = px[y * sprite.w + x];
      const c = idx >= 0 ? rgb[idx] : null;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const o = (((y * scale + sy) * W) + (x * scale + sx)) * 4;
          if (c) { rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255; }
        }
      }
    }
  }
  return { width: W, height: H, rgba };
}

function hexToRGB(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

// ---------------------------------------------------------------- ascii I/O

/**
 * ASCII art is the friendliest way for a language model to describe a sprite.
 * Each character is one pixel; `key` maps a character to a palette index.
 * '.' and ' ' are transparent unless the key overrides them.
 */
const DEFAULT_KEY_CHARS = '0123456789abcdefghijklmnopqrstuv';

function asciiToPixels(rows, key, w, h) {
  const px = new Int16Array(w * h).fill(-1);
  for (let y = 0; y < h; y++) {
    const row = rows[y] || '';
    for (let x = 0; x < w; x++) {
      const ch = row[x];
      if (ch == null || ch === '.' || ch === ' ') continue;
      const v = key[ch];
      if (v == null) throw new Error('character "' + ch + '" at row ' + y + ' is not in the key');
      px[y * w + x] = v;
    }
  }
  return px;
}

function pixelsToAscii(px, w, h, key) {
  const rev = {};
  for (const ch of Object.keys(key)) rev[key[ch]] = ch;
  const rows = [];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) {
      const v = px[y * w + x];
      row += v < 0 ? '.' : (rev[v] != null ? rev[v] : '?');
    }
    rows.push(row);
  }
  return rows;
}

/** Build a char->index key covering every palette entry. */
function defaultKey(paletteLength) {
  const key = {};
  for (let i = 0; i < paletteLength && i < DEFAULT_KEY_CHARS.length; i++) key[DEFAULT_KEY_CHARS[i]] = i;
  return key;
}

return {
  FORMAT, PALETTES, DEFAULT_KEY_CHARS, MAX_OUTPUT_PIXELS,
  encodeRLE, decodeRLE, newSprite, validate, clampSize, clampScale, emptyLayer,
  flattenFrame, frameToRGBA, hexToRGB,
  asciiToPixels, pixelsToAscii, defaultKey,
};
});
