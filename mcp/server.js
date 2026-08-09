#!/usr/bin/env node
'use strict';
/**
 * MCP server over stdio for the pixel art library.
 *
 * The whole design leans on one idea: a language model is good at describing a
 * picture as rows of characters, and pixel art *is* rows of characters. So the
 * main authoring tool takes ASCII rows plus a character->colour key, and the
 * preview tool hands back a real PNG so the agent can look at what it drew.
 *
 * Run:  node mcp/server.js          (library defaults to ../library)
 *       PIXELART_LIBRARY=/path node mcp/server.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../lib/sprite');
const G = require('../lib/shapes');
const REF = require('../lib/reference');
const { encodePNG, decodePNG } = require('../lib/png');
const { encodeGIF } = require('../lib/gif');

const LIBRARY = process.env.PIXELART_LIBRARY || path.join(__dirname, '..', 'library');
const EXPORTS = process.env.PIXELART_EXPORTS || path.join(__dirname, '..', 'exports');
fs.mkdirSync(LIBRARY, { recursive: true });

// ---------------------------------------------------------------- library io

function safeName(name) {
  const clean = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!clean) throw new Error('invalid sprite name: ' + JSON.stringify(name));
  return clean.slice(0, 64);
}

const spritePath = name => path.join(LIBRARY, safeName(name) + '.json');

/**
 * Confine an export destination to the exports directory.
 *
 * Everything reaching this function is model-controlled: `outPath` comes
 * straight off the tool call, and the default filename is built from the
 * sprite's internal `name` field, which `validate()` passes through untouched
 * (a sprite saved as `foo.json` can carry any name it likes inside). Without a
 * check, an agent that has been talked into calling export_sprite is an
 * arbitrary file write — ~/.bashrc, ~/.ssh/authorized_keys, a crontab — and
 * several export formats embed attacker-influenced text in their contents.
 *
 * Resolve first, then compare, so `..` segments and symlinked parents are
 * already collapsed by the time the prefix test runs.
 */
function safeExportPath(outPath, fallbackName) {
  fs.mkdirSync(EXPORTS, { recursive: true });
  const root = fs.realpathSync(EXPORTS);
  const target = path.resolve(outPath ? String(outPath) : path.join(root, fallbackName));
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('outPath must stay inside the exports directory (' + root + ')');
  }
  return target;
}

/**
 * The filename is the sprite's identity, not the `name` field inside it.
 *
 * save() derives its destination from `sprite.name`, so if a file on disk
 * carries a name that disagrees with its filename — which the HTTP PUT route
 * and hand-edited files can both produce — then every mutation writes to a
 * *different* sprite than the one it loaded. Editing A silently overwrites B,
 * and A never changes. There is no undo here, so that is unrecoverable data
 * loss. Normalising on load makes the whole class of bug impossible.
 */
function load(name) {
  const p = spritePath(name);
  if (!fs.existsSync(p)) throw new Error('no sprite named "' + safeName(name) + '". Use list_sprites to see what exists.');
  const sprite = S.validate(JSON.parse(fs.readFileSync(p, 'utf8')));
  sprite.name = safeName(name);
  return sprite;
}

function save(sprite) {
  const s = S.validate(sprite);
  fs.writeFileSync(spritePath(s.name), JSON.stringify(s, null, 2));
  return s;
}

function pixelsOf(sprite, f, l) {
  return S.decodeRLE(sprite.frames[f].layers[l].data, sprite.w * sprite.h);
}

function setPixelsOf(sprite, f, l, px) {
  sprite.frames[f].layers[l].data = S.encodeRLE(Array.from(px));
}

function checkIndex(n, len, what) {
  n = Math.round(Number(n) || 0);
  if (n < 0 || n >= len) throw new Error(what + ' ' + n + ' is out of range (0..' + (len - 1) + ')');
  return n;
}

/** Turn `{"#": 3, "o": 1}` or `{"#": "#ff0044"}` into a char -> palette index map. */
function resolveKey(key, sprite) {
  if (!key) return S.defaultKey(sprite.palette.length);
  const out = {};
  for (const ch of Object.keys(key)) {
    const v = key[ch];
    if (typeof v === 'number') {
      out[ch] = checkIndex(v, sprite.palette.length, 'palette index');
    } else if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) {
      const hex = v.toLowerCase();
      let idx = sprite.palette.indexOf(hex);
      if (idx < 0) { sprite.palette.push(hex); idx = sprite.palette.length - 1; }
      out[ch] = idx;
    } else {
      throw new Error('key["' + ch + '"] must be a palette index or a #rrggbb colour');
    }
  }
  return out;
}

// ---------------------------------------------------------------- rendering

function pngOf(sprite, frame, scale) {
  scale = S.clampScale(sprite.w, sprite.h, scale, 1);
  const { width, height, rgba } = S.frameToRGBA(sprite, frame, scale);
  return encodePNG(width, height, rgba);
}

const MAX_REFERENCE_BYTES = 32 * 1024 * 1024;

/**
 * Load a reference image off local disk.
 *
 * Unlike export_sprite, this path is deliberately not confined to a project
 * folder. A reference lives wherever the user keeps it, and confining reads
 * here would buy nothing: whatever is driving this server can already read
 * files by other means, so a jail would be inconvenience without security.
 * Writes are the dangerous direction, and those are still fenced by
 * safeExportPath.
 */
function loadReference(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('path is required');
  const full = path.resolve(p.replace(/^~(?=\/|$)/, os.homedir()));
  let stat;
  try { stat = fs.statSync(full); }
  catch (e) { throw new Error('cannot read "' + full + '": ' + e.code); }
  if (stat.isDirectory()) throw new Error('"' + full + '" is a directory, not an image');
  if (stat.size > MAX_REFERENCE_BYTES) {
    throw new Error('reference is ' + Math.round(stat.size / 1048576) + 'MB; the limit is 32MB');
  }
  const decoded = decodePNG(fs.readFileSync(full));
  return { ...decoded, path: full };
}

/** Composite equal-sized RGBA cells into one labelled grid image. */
function panelPNG(cells, cw, ch, cols, pad = 4) {
  const rows = Math.ceil(cells.length / cols);
  const W = cw * cols + pad * (cols + 1), H = ch * rows + pad * (rows + 1);
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {                       // neutral backdrop
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 0xe8;
    out[i * 4 + 3] = 255;
  }
  cells.forEach((cell, i) => {
    const ox = (i % cols) * (cw + pad) + pad, oy = Math.floor(i / cols) * (ch + pad) + pad;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const s = (y * cw + x) * 4, d = ((oy + y) * W + ox + x) * 4;
      const a = cell[s + 3] / 255;
      for (let c = 0; c < 3; c++) out[d + c] = Math.round(cell[s + c] * a + out[d + c] * (1 - a));
    }
  });
  return encodePNG(W, H, out);
}

/** Blow an RGBA buffer up by an integer factor so it can actually be judged. */
function zoom(rgba, w, h, scale) {
  const out = new Uint8Array(w * scale * h * scale * 4);
  for (let y = 0; y < h * scale; y++) for (let x = 0; x < w * scale; x++) {
    const s = ((y / scale | 0) * w + (x / scale | 0)) * 4, d = (y * w * scale + x) * 4;
    out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]; out[d + 3] = rgba[s + 3];
  }
  return out;
}

/** Flatten opaque pixels of an RGBA buffer to one colour. */
function flatten(rgba) {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length / 4; i++) {
    const on = rgba[i * 4 + 3] > 0;
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = on ? 0x18 : 0xf4;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/**
 * Flatten every opaque pixel to one colour — the squint test, mechanised.
 *
 * A sprite is only readable if its outline alone identifies it. Colour and
 * detail hide a weak silhouette very effectively, so the shape has to be judged
 * with both taken away, before any time goes into shading or faces.
 */
function silhouetteOf(sprite, frame, scale) {
  scale = S.clampScale(sprite.w, sprite.h, scale, 1);
  const { width, height, rgba } = S.frameToRGBA(sprite, frame, scale);
  for (let i = 0; i < width * height; i++) {
    const opaque = rgba[i * 4 + 3] > 0;
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = opaque ? 0x18 : 0xf4;
    rgba[i * 4 + 3] = 255;
  }
  return encodePNG(width, height, rgba);
}

function sheetOf(sprite, scale, cols) {
  const n = sprite.frames.length;
  scale = S.clampScale(sprite.w, sprite.h, scale, n);
  cols = Math.max(1, Math.round(cols || n));
  const rows = Math.ceil(n / cols);
  const cw = sprite.w * scale, ch = sprite.h * scale;
  const W = cw * cols, H = ch * rows;
  const rgba = new Uint8Array(W * H * 4);
  for (let f = 0; f < n; f++) {
    const cell = S.frameToRGBA(sprite, f, scale);
    const ox = (f % cols) * cw, oy = Math.floor(f / cols) * ch;
    for (let y = 0; y < ch; y++) {
      rgba.set(cell.rgba.subarray(y * cw * 4, (y + 1) * cw * 4), ((oy + y) * W + ox) * 4);
    }
  }
  return encodePNG(W, H, rgba);
}

function gifOf(sprite, scale) {
  scale = S.clampScale(sprite.w, sprite.h, scale, sprite.frames.length);
  return Buffer.from(encodeGIF({
    width: sprite.w, height: sprite.h, palette: sprite.palette,
    frames: sprite.frames.map((_, i) => S.flattenFrame(sprite, i)),
    delayMs: 1000 / sprite.fps, scale: scale,
  }));
}

function svgOf(sprite, frame, scale) {
  const px = S.flattenFrame(sprite, frame);
  const rects = [];
  for (let y = 0; y < sprite.h; y++) {
    let x = 0;
    while (x < sprite.w) {
      const v = px[y * sprite.w + x];
      if (v < 0) { x++; continue; }
      let run = 1;
      while (x + run < sprite.w && px[y * sprite.w + x + run] === v) run++;
      rects.push(`<rect x="${x}" y="${y}" width="${run}" height="1" fill="${sprite.palette[v]}"/>`);
      x += run;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sprite.w * scale}" height="${sprite.h * scale}" ` +
    `viewBox="0 0 ${sprite.w} ${sprite.h}" shape-rendering="crispEdges">\n  ${rects.join('\n  ')}\n</svg>`;
}

function cssOf(sprite, frame, scale) {
  const px = S.flattenFrame(sprite, frame);
  const parts = [];
  for (let y = 0; y < sprite.h; y++) {
    for (let x = 0; x < sprite.w; x++) {
      const v = px[y * sprite.w + x];
      if (v >= 0) parts.push(`${x * scale}px ${y * scale}px 0 0 ${sprite.palette[v]}`);
    }
  }
  return `.${sprite.name} {\n  width: ${scale}px;\n  height: ${scale}px;\n  box-shadow:\n    ${parts.join(',\n    ')};\n}`;
}

// ---------------------------------------------------------------- tool specs

const TOOLS = [
  {
    name: 'list_palettes',
    description: 'List the built-in colour palettes (Game Boy DMG, PICO-8, NES, Sweetie 16, …) with their hex colours. Use this before creating a sprite to pick a palette that suits the piece.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_sprites',
    description: 'List every sprite in the library with its size, frame count and tags.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_sprite',
    description: 'Read a sprite back as ASCII rows plus its palette. This is the tool to call before editing something that already exists, so you can see the current art.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Sprite name.' },
        frame: { type: 'number', description: 'Frame index, default 0.' },
        layer: { type: 'number', description: 'Layer index. Omit to read the flattened composite of all visible layers.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'create_sprite',
    description: 'Create a new empty sprite in the library. Pick a size that suits the job: 8-16px for icons, 32px for tiles, 64px for portraits, 160x32 for a banner. Fails if the name is taken unless overwrite is true.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Sprite name; becomes the filename.' },
        width: { type: 'number', description: 'Width in pixels, 1-512.' },
        height: { type: 'number', description: 'Height in pixels, 1-512.' },
        palette: { type: 'array', items: { type: 'string' }, description: 'Explicit palette as #rrggbb strings. Takes priority over paletteName.' },
        paletteName: { type: 'string', description: 'Name of a built-in palette, e.g. "dmg", "pico8", "sweetie16". Default "dmg".' },
        fps: { type: 'number', description: 'Playback speed for animations, default 8.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Free-form tags, e.g. ["ui","button"].' },
        overwrite: { type: 'boolean', description: 'Replace an existing sprite of the same name. Defaults to false — without it, creating over an existing name fails rather than destroying the art.' },
      },
      required: ['name', 'width', 'height'],
    },
  },
  {
    name: 'draw_ascii',
    description:
      'Draw a sprite by describing it as rows of characters — the primary way to make art. ' +
      'Each character is one pixel. "." and " " mean transparent. ' +
      'The key maps characters to either a palette index (number) or a #rrggbb colour (added to the palette if new). ' +
      'With no key, characters 0-9 and a-v map to palette indices 0-31. ' +
      'Rows shorter than the sprite are padded with transparency, so you only need to describe the part you care about.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        rows: { type: 'array', items: { type: 'string' }, description: 'One string per pixel row, top to bottom.' },
        key: { type: 'object', description: 'Character -> palette index or #rrggbb. Example: {"#": 0, "o": "#ff0044"}.' },
        frame: { type: 'number', description: 'Frame index, default 0. Use add_frame first if it does not exist.' },
        layer: { type: 'number', description: 'Layer index, default 0.' },
        x: { type: 'number', description: 'Left offset to stamp the rows at, default 0.' },
        y: { type: 'number', description: 'Top offset to stamp the rows at, default 0.' },
        mode: { type: 'string', enum: ['replace', 'over'], description: '"replace" (default) clears the layer first; "over" stamps on top, leaving existing pixels where the rows are transparent.' },
      },
      required: ['name', 'rows'],
    },
  },
  {
    name: 'draw_shapes',
    description:
      'Build a sprite from geometry instead of hand-counted rows — the better starting point for anything with a curve. ' +
      'Shapes are composited in order into a character grid, then optionally shaded, outlined and cleaned, ' +
      'and finally coloured through the same character key draw_ascii uses. ' +
      'Prefer this for bodies, heads, limbs and tails; use draw_ascii (mode "over") afterwards for faces and small detail. ' +
      'Shape types: ellipse (cx,cy,rx,ry), circle (cx,cy,r), rect (x0,y0,x1,y1), line (x0,y0,x1,y1,thickness), ' +
      'path (points,thickness), rows (rows,x,y). Every shape takes a "fill" character.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        shapes: {
          type: 'array',
          description: 'Shapes composited in order, later ones drawing over earlier ones.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['ellipse', 'circle', 'rect', 'line', 'path', 'rows'] },
              fill: { type: 'string', description: 'The character this shape writes.' },
              cx: { type: 'number' }, cy: { type: 'number' },
              rx: { type: 'number' }, ry: { type: 'number' }, r: { type: 'number' },
              x0: { type: 'number' }, y0: { type: 'number' },
              x1: { type: 'number' }, y1: { type: 'number' },
              thickness: { type: 'number', description: 'For line/path: stroke width in pixels.' },
              points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'For path: [[x,y],...].' },
              rows: { type: 'array', items: { type: 'string' }, description: 'For rows: ascii to stamp.' },
              x: { type: 'number' }, y: { type: 'number' },
            },
            required: ['type'],
          },
        },
        key: { type: 'object', description: 'Character -> palette index or #rrggbb, same as draw_ascii.' },
        shade: {
          type: 'object',
          description:
            'Optional shading, applied before outlining. Maps a fill character either to ' +
            '{"tones":["1","2","3","4"]} lightest-first (4 tones read better than 3), or to ' +
            '{"light","mid","dark"}. Each connected region is lit as a volume: a broad highlight ' +
            'offset toward the light, a terminator curving across the form, shadow on the far side. ' +
            'Flat fills are the main thing that makes sprite art look like clip art.',
        },
        shadeMode: {
          type: 'string', enum: ['form', 'rim'],
          description: '"form" (default) lights each region as a volume. "rim" gives a flat contour band — occasionally right for graphic icons, but it is what makes art look bevelled rather than lit.',
        },
        light: {
          type: 'array', items: { type: 'number' },
          description: 'Light direction [dx, dy], default [-1,-1] (top-left). Keep it the same across a set.',
        },
        outline: {
          type: 'array',
          description:
            'Optional 1px borders, applied in order. Each entry is {fills:[chars], with:char}. ' +
            'Outline each part with a dark tint of its own colour rather than one black keyline for everything — ' +
            'a single keyline flattens the parts together.',
          items: {
            type: 'object',
            properties: {
              fills: { type: 'array', items: { type: 'string' } },
              with: { type: 'string' },
            },
            required: ['fills', 'with'],
          },
        },
        mirror: { type: 'boolean', description: 'Mirror the left half onto the right before shading. Most creatures are symmetric front-on.' },
        despeckle: { type: 'boolean', description: 'Absorb stray single pixels into their neighbours. Default true.' },
        frame: { type: 'number' },
        layer: { type: 'number' },
        mode: { type: 'string', enum: ['replace', 'over'], description: '"replace" (default) clears the layer first.' },
      },
      required: ['name', 'shapes', 'key'],
    },
  },
  {
    name: 'import_reference',
    description:
      'Load a local PNG as drawing reference. Shrinks it to sprite size and reduces it to a small ' +
      'palette, then returns both the shrunk image and the sampled colours. ' +
      'Do this before drawing anything you want to look like a real subject: a reference only tells ' +
      'you which features survive once it is 32 pixels wide, and sampled colours beat guessed ones. ' +
      'Pass "into" to lay the result into a sprite layer to trace over.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to a PNG on this machine. "~" is expanded.' },
        trim: { type: 'boolean', description: 'Crop the reference to its subject before fitting, so it fills the sprite instead of keeping the source margin. Default true.' },
        width: { type: 'number', description: 'Target width. Defaults to the "into" sprite\'s size, else 32.' },
        height: { type: 'number', description: 'Target height.' },
        colors: { type: 'number', description: 'Palette size to reduce to, 1-64. Default 8.' },
        into: { type: 'string', description: 'Optional sprite name to write the result into, for tracing.' },
        layer: { type: 'number', description: 'Layer index to write into when using "into". Default 0.' },
        scale: { type: 'number', description: 'Magnification of the returned preview. Default 8.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'compare_reference',
    description:
      'Put a sprite and a reference image side by side, each with its silhouette, in one image. ' +
      'This is the correction loop: it shows proportion and shape errors that are invisible when ' +
      'looking at the sprite on its own.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Sprite to judge.' },
        path: { type: 'string', description: 'Path to the reference PNG.' },
        frame: { type: 'number' },
        scale: { type: 'number', description: 'Magnification, default 6.' },
      },
      required: ['name', 'path'],
    },
  },
  {
    name: 'preview_sprites',
    description:
      'Render several sprites into one contact sheet image. Use this to review a batch in a single ' +
      'look instead of one round trip per sprite.',
    inputSchema: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: 'Sprite names, up to 64.' },
        scale: { type: 'number', description: 'Pixel magnification, default 4.' },
        cols: { type: 'number', description: 'Columns in the grid. Default is roughly square.' },
      },
      required: ['names'],
    },
  },
  {
    name: 'set_pixels',
    description: 'Set individual pixels. Good for small touch-ups after draw_ascii. Use index -1 to erase.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        pixels: {
          type: 'array',
          description: 'Pixels to set.',
          items: {
            type: 'object',
            properties: {
              x: { type: 'number' }, y: { type: 'number' },
              index: { type: 'number', description: 'Palette index, or -1 for transparent.' },
              color: { type: 'string', description: 'Alternative to index: a #rrggbb colour, added to the palette if new.' },
            },
            required: ['x', 'y'],
          },
        },
        frame: { type: 'number' },
        layer: { type: 'number' },
      },
      required: ['name', 'pixels'],
    },
  },
  {
    name: 'add_frame',
    description: 'Append an animation frame, optionally copying an existing one as a starting point.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        copyFrom: { type: 'number', description: 'Frame index to duplicate. Omit for an empty frame.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_layer',
    description: 'Add a layer to every frame. Later layers draw on top of earlier ones.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        layerName: { type: 'string', description: 'Label for the layer, e.g. "shading".' },
      },
      required: ['name'],
    },
  },
  {
    name: 'set_palette',
    description: 'Replace the palette. Pixel indices are left alone, so this is how you recolour a whole sprite at once — swap in a different set of colours and every pixel follows.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        palette: { type: 'array', items: { type: 'string' }, description: 'New palette as #rrggbb strings.' },
        paletteName: { type: 'string', description: 'Or the name of a built-in palette.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'transform',
    description: 'Flip, rotate, shift or outline a sprite. Operates on every frame and layer unless a frame/layer is given.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        op: { type: 'string', enum: ['flip_x', 'flip_y', 'rotate_cw', 'shift', 'outline', 'despeckle'], description: 'rotate_cw needs a square sprite. outline traces a 1px border in outlineColor. despeckle absorbs stray single pixels into their neighbours.' },
        dx: { type: 'number', description: 'For "shift": horizontal offset in pixels.' },
        dy: { type: 'number', description: 'For "shift": vertical offset in pixels.' },
        outlineColor: { type: 'string', description: 'For "outline": a #rrggbb colour. Default the darkest palette entry.' },
        frame: { type: 'number' },
        layer: { type: 'number' },
      },
      required: ['name', 'op'],
    },
  },
  {
    name: 'preview_sprite',
    description: 'Render a sprite to a PNG image and return it, so you can actually look at what you drew and judge it. Call this after drawing — pixel art is easy to get subtly wrong, and seeing it is the only real check.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        frame: { type: 'number', description: 'Frame index, default 0.' },
        scale: { type: 'number', description: 'Pixel magnification, default 8. Small sprites are hard to judge at 1:1.' },
        sheet: { type: 'boolean', description: 'Render all frames side by side instead of one frame.' },
        silhouette: {
          type: 'boolean',
          description:
            'Flatten every opaque pixel to one colour. Check this BEFORE shading or detailing: ' +
            'colour and detail disguise a weak shape, and if the silhouette is not identifiable ' +
            'on its own, no amount of shading will save it.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'export_sprite',
    description: 'Write a sprite to a file on disk in a usable format, and return the path.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        format: { type: 'string', enum: ['png', 'sheet', 'gif', 'svg', 'css', 'datauri', 'json'], description: 'png = one frame; sheet = all frames in a grid; gif = animation; css = box-shadow art; datauri = an <img> tag you can paste into HTML.' },
        scale: { type: 'number', description: 'Pixel magnification, default 1 for png/sheet/gif, 1 for svg/css.' },
        frame: { type: 'number' },
        cols: { type: 'number', description: 'For "sheet": columns in the grid.' },
        outPath: { type: 'string', description: 'Absolute path to write to. Defaults to the exports folder next to the library.' },
      },
      required: ['name', 'format'],
    },
  },
  {
    name: 'delete_sprite',
    description: 'Remove a sprite from the library.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'set_meta',
    description: 'Rename a sprite or change its tags and playback speed. Tags drive search and filtering in ' +
      'the gallery, so tagging work after drawing it is how it becomes findable.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        newName: { type: 'string', description: 'Rename the sprite. Gets slugified like any sprite name.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replaces the existing tags entirely.' },
        fps: { type: 'number', description: 'Playback speed, 1-60.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'delete_frame',
    description: 'Remove one animation frame. A sprite must keep at least one frame.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        frame: { type: 'number', description: 'Frame index to remove.' },
      },
      required: ['name', 'frame'],
    },
  },
  {
    name: 'delete_layer',
    description: 'Remove a layer from every frame. A sprite must keep at least one layer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        layer: { type: 'number', description: 'Layer index to remove.' },
      },
      required: ['name', 'layer'],
    },
  },
  {
    name: 'move_layer',
    description: 'Reorder a layer. Later layers draw on top, so this is how you push shading above or below ' +
      'the art it shades.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        layer: { type: 'number', description: 'Layer index to move.' },
        to: { type: 'number', description: 'Index to move it to.' },
      },
      required: ['name', 'layer', 'to'],
    },
  },
  {
    name: 'set_layer',
    description: 'Rename a layer or change its visibility. A hidden layer keeps its pixels but is left out of ' +
      'previews and exports.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        layer: { type: 'number' },
        layerName: { type: 'string' },
        visible: { type: 'boolean' },
        opacity: { type: 'number', description: '0 to 1. Rendering treats 0 as hidden.' },
      },
      required: ['name', 'layer'],
    },
  },
  {
    name: 'merge_layer',
    description: 'Merge a layer into the one below it, in every frame. The upper layer wins where both have ' +
      'a pixel. Cannot merge layer 0, which has nothing beneath it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        layer: { type: 'number', description: 'Index of the upper layer, the one that gets merged down.' },
      },
      required: ['name', 'layer'],
    },
  },
];

// ---------------------------------------------------------------- handlers

function text(s) { return { content: [{ type: 'text', text: s }] }; }

function describe(sprite, frame, layerIndex) {
  const f = checkIndex(frame == null ? 0 : frame, sprite.frames.length, 'frame');
  const px = layerIndex == null
    ? S.flattenFrame(sprite, f)
    : pixelsOf(sprite, f, checkIndex(layerIndex, sprite.frames[f].layers.length, 'layer'));
  const key = S.defaultKey(sprite.palette.length);
  const rows = S.pixelsToAscii(px, sprite.w, sprite.h, key);
  const legend = sprite.palette.map((c, i) => '  ' + S.DEFAULT_KEY_CHARS[i] + ' = ' + c + '  (index ' + i + ')').join('\n');
  return [
    sprite.name + '  ' + sprite.w + '×' + sprite.h +
      '  frames: ' + sprite.frames.length + '  layers: ' + sprite.frames[f].layers.length +
      '  fps: ' + sprite.fps + (sprite.tags.length ? '  tags: ' + sprite.tags.join(', ') : ''),
    '',
    'palette:',
    legend,
    '  . = transparent',
    '',
    'frame ' + f + (layerIndex == null ? ' (flattened)' : ' layer ' + layerIndex) + ':',
    rows.join('\n'),
  ].join('\n');
}

const HANDLERS = {

  list_palettes() {
    return text(Object.keys(S.PALETTES).map(k =>
      k + '  "' + S.PALETTES[k].name + '"  (' + S.PALETTES[k].colors.length + ' colours)\n    ' +
      S.PALETTES[k].colors.join(' ')).join('\n\n'));
  },

  list_sprites() {
    const files = fs.readdirSync(LIBRARY).filter(f => f.endsWith('.json'));
    if (!files.length) return text('The library is empty. Use create_sprite to start one.');
    const lines = files.map(f => {
      try {
        const sp = JSON.parse(fs.readFileSync(path.join(LIBRARY, f), 'utf8'));
        return '  ' + path.basename(f, '.json') + '  ' + sp.w + '×' + sp.h +
          '  ' + sp.frames.length + ' frame(s), ' + sp.frames[0].layers.length + ' layer(s)' +
          ((sp.tags || []).length ? '  [' + sp.tags.join(', ') + ']' : '');
      } catch (e) {
        return '  ' + path.basename(f, '.json') + '  (unreadable: ' + e.message + ')';
      }
    });
    return text(files.length + ' sprite(s) in ' + LIBRARY + ':\n' + lines.join('\n'));
  },

  get_sprite(a) {
    return text(describe(load(a.name), a.frame, a.layer));
  },

  create_sprite(a) {
    // Silently replacing a sprite is unrecoverable — there is no history and no
    // undo, so a name collision used to destroy the work with no warning.
    if (!a.overwrite && fs.existsSync(spritePath(a.name))) {
      throw new Error('a sprite named "' + safeName(a.name) + '" already exists. ' +
        'Pick another name, or pass overwrite: true to replace it (this discards the existing art).');
    }
    const sprite = S.newSprite({
      name: safeName(a.name),
      w: a.width, h: a.height,
      palette: a.palette,
      paletteName: a.paletteName || 'dmg',
      fps: a.fps,
      tags: a.tags,
    });
    save(sprite);
    return text('Created "' + sprite.name + '" at ' + sprite.w + '×' + sprite.h + '.\n\n' +
      'palette:\n' + sprite.palette.map((c, i) =>
        '  ' + S.DEFAULT_KEY_CHARS[i] + ' = ' + c + '  (index ' + i + ')').join('\n') +
      '\n\nNow call draw_ascii with ' + sprite.h + ' rows of ' + sprite.w + ' characters.');
  },

  draw_ascii(a) {
    const sprite = load(a.name);
    const f = checkIndex(a.frame == null ? 0 : a.frame, sprite.frames.length, 'frame');
    const l = checkIndex(a.layer == null ? 0 : a.layer, sprite.frames[f].layers.length, 'layer');
    const key = resolveKey(a.key, sprite);
    const ox = Math.round(a.x || 0), oy = Math.round(a.y || 0);

    if (!Array.isArray(a.rows) || !a.rows.length) throw new Error('rows must be a non-empty array of strings');

    const px = a.mode === 'over' ? pixelsOf(sprite, f, l) : new Int16Array(sprite.w * sprite.h).fill(-1);

    const warnings = [];
    if (a.mode !== 'over') {
      if (a.rows.length !== sprite.h && !oy) {
        warnings.push('got ' + a.rows.length + ' rows for a ' + sprite.h + '-pixel-tall sprite');
      }
      const wide = a.rows.filter(r => r.length > sprite.w).length;
      if (wide) warnings.push(wide + ' row(s) are wider than ' + sprite.w + ' pixels and were cropped');
      // A short row is padded with transparency, which silently eats the right
      // edge of the art. That reads as "the shape came out wrong" rather than
      // "I miscounted", so it has to be called out by row number.
      const short = a.rows
        .map((r, i) => (r.length && r.length < sprite.w ? i : -1))
        .filter(i => i >= 0);
      if (short.length) {
        warnings.push(short.length + ' row(s) are shorter than ' + sprite.w +
          ' pixels and were padded with transparency (rows ' +
          short.slice(0, 8).join(', ') + (short.length > 8 ? ', …' : '') + ')');
      }
    }

    for (let ry = 0; ry < a.rows.length; ry++) {
      const row = String(a.rows[ry]);
      for (let rx = 0; rx < row.length; rx++) {
        const ch = row[rx];
        if (ch === '.' && key['.'] == null) continue;
        if (ch === ' ' && key[' '] == null) continue;
        const v = key[ch];
        if (v == null) {
          throw new Error('character "' + ch + '" (row ' + ry + ', column ' + rx + ') is not in the key. ' +
            'Either add it to the key, or use "." for transparent.');
        }
        const x = ox + rx, y = oy + ry;
        if (x < 0 || y < 0 || x >= sprite.w || y >= sprite.h) continue;
        px[y * sprite.w + x] = v;
      }
    }

    setPixelsOf(sprite, f, l, px);
    save(sprite);
    return text('Drew into "' + sprite.name + '" frame ' + f + ', layer ' + l + '.' +
      (warnings.length ? '\n\nHeads up: ' + warnings.join('; ') + '.' : '') +
      '\n\nCall preview_sprite to see how it actually looks.');
  },

  draw_shapes(a) {
    const sprite = load(a.name);
    const f = checkIndex(a.frame == null ? 0 : a.frame, sprite.frames.length, 'frame');
    const l = checkIndex(a.layer == null ? 0 : a.layer, sprite.frames[f].layers.length, 'layer');

    if (!Array.isArray(a.shapes) || !a.shapes.length) throw new Error('shapes must be a non-empty array');

    const grid = G.blank(sprite.w, sprite.h);
    for (let i = 0; i < a.shapes.length; i++) {
      const s = a.shapes[i];
      if (s.type !== 'rows' && (typeof s.fill !== 'string' || s.fill.length !== 1)) {
        throw new Error('shapes[' + i + '] needs a single-character "fill"');
      }
      try {
        G.apply(grid, s);
      } catch (e) {
        throw new Error('shapes[' + i + ']: ' + e.message);
      }
    }

    if (a.mirror) G.mirror(grid);
    if (a.shade) G.shade(grid, a.shade, { mode: a.shadeMode, light: a.light });
    if (a.despeckle !== false) G.despeckle(grid);
    for (const o of (a.outline || [])) {
      if (!Array.isArray(o.fills) || typeof o.with !== 'string') {
        throw new Error('each outline entry needs {fills: [chars], with: char}');
      }
      G.outline(grid, o.fills, o.with);
    }

    // Resolve colours only now — shade/outline invent characters that were
    // never in any shape, and they all have to exist in the key.
    const key = resolveKey(a.key, sprite);
    const px = a.mode === 'over' ? pixelsOf(sprite, f, l) : new Int16Array(sprite.w * sprite.h).fill(-1);
    const unknown = new Set();
    for (let y = 0; y < sprite.h; y++) {
      for (let x = 0; x < sprite.w; x++) {
        const ch = grid[y][x];
        if (ch === '.' && key['.'] == null) continue;
        if (ch === ' ' && key[' '] == null) continue;
        const v = key[ch];
        if (v == null) { unknown.add(ch); continue; }
        px[y * sprite.w + x] = v;
      }
    }
    if (unknown.size) {
      throw new Error('these characters ended up in the picture but are not in the key: ' +
        [...unknown].map(c => '"' + c + '"').join(', ') +
        '. Shade and outline produce new characters — every light/mid/dark and every ' +
        'outline "with" character needs a colour too.');
    }

    setPixelsOf(sprite, f, l, px);
    save(sprite);
    return text('Drew ' + a.shapes.length + ' shape(s) into "' + sprite.name + '" frame ' + f + ', layer ' + l + '.' +
      (a.shade ? ' Shaded.' : '') + ((a.outline || []).length ? ' Outlined.' : '') +
      '\n\nCall preview_sprite to see how it actually looks.');
  },

  import_reference(a) {
    const src = loadReference(a.path);
    const target = a.into ? load(a.into) : null;
    const tw = Math.max(1, Math.min(512, Math.round(a.width || (target ? target.w : 32))));
    const th = Math.max(1, Math.min(512, Math.round(a.height || (target ? target.h : tw))));
    const colors = Math.max(1, Math.min(64, Math.round(a.colors || 8)));

    // Reference art is usually mostly margin. Resampling the whole canvas would
    // land the subject in the middle of the sprite at half size, so trim to the
    // subject and fit it to the frame, preserving aspect ratio.
    const crop = a.trim === false
      ? { rgba: src.rgba, width: src.width, height: src.height }
      : REF.trim(src.rgba, src.width, src.height);
    const fitted = REF.fitInto(crop.rgba, crop.width, crop.height, tw, th);
    const { palette, indices } = REF.quantise(fitted, tw, th, colors);
    const out = { palette, indices };
    const ramp = REF.byLuminance(out.palette);

    // Render the quantised result, which is what the sprite would actually be —
    // not the smooth downscale, which flatters the reference.
    const shown = new Uint8Array(tw * th * 4);
    out.indices.forEach((idx, i) => {
      if (idx < 0) return;
      const c = out.palette[idx];
      shown[i * 4] = parseInt(c.slice(1, 3), 16);
      shown[i * 4 + 1] = parseInt(c.slice(3, 5), 16);
      shown[i * 4 + 2] = parseInt(c.slice(5, 7), 16);
      shown[i * 4 + 3] = 255;
    });

    const scale = Math.max(1, Math.min(32, Math.round(a.scale || 8)));
    const png = panelPNG(
      [zoom(shown, tw, th, scale), zoom(flatten(shown), tw, th, scale)],
      tw * scale, th * scale, 2);

    let wrote = '';
    if (target) {
      const l = checkIndex(a.layer == null ? 0 : a.layer, target.frames[0].layers.length, 'layer');
      if (tw !== target.w || th !== target.h) {
        throw new Error('reference resolves to ' + tw + '×' + th + ' but "' + target.name +
          '" is ' + target.w + '×' + target.h + '. Omit width/height to match the sprite.');
      }
      target.palette = out.palette.slice();
      setPixelsOf(target, 0, l, Int16Array.from(out.indices));
      save(target);
      wrote = '\n\nWritten into "' + target.name + '" layer ' + l +
        ' and its palette replaced. Trace over it on another layer, then delete this one.';
    }

    return {
      content: [
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text:
          path.basename(src.path) + ' — ' + src.width + '×' + src.height + ' reduced to ' +
          tw + '×' + th + ' in ' + out.palette.length + ' colours.\n' +
          'Left: what the reference becomes at sprite size. Right: its silhouette — this is the ' +
          'shape you have to hit.\n\nSampled palette, light to dark:\n  ' + ramp.join('  ') + wrote },
      ],
    };
  },

  compare_reference(a) {
    const sprite = load(a.name);
    const src = loadReference(a.path);
    const f = checkIndex(a.frame == null ? 0 : a.frame, sprite.frames.length, 'frame');
    const scale = Math.max(1, Math.min(32, Math.round(a.scale || 6)));

    // Trim both to their subjects and fit them into the same box, so the
    // comparison is about shape rather than how much margin each one carries.
    const cropMine = REF.trim(S.frameToRGBA(sprite, f, 1).rgba, sprite.w, sprite.h);
    const cropRef = REF.trim(src.rgba, src.width, src.height);
    const box = Math.max(sprite.w, sprite.h);
    const mine = REF.fitInto(cropMine.rgba, cropMine.width, cropMine.height, box, box);
    const theirs = REF.fitInto(cropRef.rgba, cropRef.width, cropRef.height, box, box);
    const cells = [
      zoom(mine, box, box, scale),
      zoom(theirs, box, box, scale),
      zoom(flatten(mine), box, box, scale),
      zoom(flatten(theirs), box, box, scale),
    ];
    const png = panelPNG(cells, box * scale, box * scale, 2);
    return {
      content: [
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text:
          'Top row: "' + sprite.name + '" then ' + path.basename(src.path) + ', both trimmed to their subject and scaled to match.\n' +
          'Bottom row: the same two as silhouettes.\n' +
          'Compare the silhouettes first — proportion errors show there and hide everywhere else.' },
      ],
    };
  },

  preview_sprites(a) {
    if (!Array.isArray(a.names) || !a.names.length) throw new Error('names must be a non-empty array');
    if (a.names.length > 64) throw new Error('at most 64 sprites per contact sheet; got ' + a.names.length);

    const loaded = a.names.map(n => {
      try { return { name: n, sprite: load(n) }; }
      catch (e) { return { name: n, error: e.message }; }
    });
    const ok = loaded.filter(r => r.sprite);
    if (!ok.length) throw new Error('none of those sprites could be loaded');

    const scale = Math.max(1, Math.min(32, Math.round(a.scale || 4)));
    const cols = Math.max(1, Math.round(a.cols || Math.ceil(Math.sqrt(ok.length))));
    const rows = Math.ceil(ok.length / cols);
    const pad = 2;
    // One cell size for every sprite, so a mixed-size batch still lines up.
    const cw = Math.max(...ok.map(r => r.sprite.w)) * scale + pad * 2;
    const ch = Math.max(...ok.map(r => r.sprite.h)) * scale + pad * 2;
    const W = cw * cols, H = ch * rows;
    const rgba = new Uint8Array(W * H * 4);

    ok.forEach((r, i) => {
      const cell = S.frameToRGBA(r.sprite, 0, scale);
      const sw = r.sprite.w * scale, sh = r.sprite.h * scale;
      const ox = (i % cols) * cw + pad + Math.floor((cw - pad * 2 - sw) / 2);
      const oy = Math.floor(i / cols) * ch + pad + Math.floor((ch - pad * 2 - sh) / 2);
      for (let y = 0; y < sh; y++) {
        rgba.set(cell.rgba.subarray(y * sw * 4, (y + 1) * sw * 4), ((oy + y) * W + ox) * 4);
      }
    });

    const missing = loaded.filter(r => r.error);
    return {
      content: [
        { type: 'image', data: encodePNG(W, H, rgba).toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: ok.length + ' sprite(s) at ' + scale + '×, ' + cols + ' per row, reading left to right:\n' +
          ok.map((r, i) => '  ' + (i + 1) + '. ' + r.sprite.name).join('\n') +
          (missing.length ? '\n\nnot found: ' + missing.map(r => r.name + ' (' + r.error + ')').join(', ') : '') },
      ],
    };
  },

  set_pixels(a) {
    const sprite = load(a.name);
    const f = checkIndex(a.frame == null ? 0 : a.frame, sprite.frames.length, 'frame');
    const l = checkIndex(a.layer == null ? 0 : a.layer, sprite.frames[f].layers.length, 'layer');
    const px = pixelsOf(sprite, f, l);
    let skipped = 0;
    for (const p of a.pixels) {
      let v;
      if (p.color) {
        const hex = String(p.color).toLowerCase();
        if (!/^#[0-9a-f]{6}$/.test(hex)) throw new Error('bad colour: ' + p.color);
        v = sprite.palette.indexOf(hex);
        if (v < 0) { sprite.palette.push(hex); v = sprite.palette.length - 1; }
      } else {
        v = p.index == null ? -1 : Math.round(p.index);
        if (v >= sprite.palette.length) throw new Error('palette index ' + v + ' does not exist (palette has ' + sprite.palette.length + ' colours)');
        if (v < -1) v = -1;
      }
      const x = Math.round(p.x), y = Math.round(p.y);
      if (x < 0 || y < 0 || x >= sprite.w || y >= sprite.h) { skipped++; continue; }
      px[y * sprite.w + x] = v;
    }
    setPixelsOf(sprite, f, l, px);
    save(sprite);
    return text('Set ' + (a.pixels.length - skipped) + ' pixel(s)' +
      (skipped ? ' (' + skipped + ' outside the canvas were ignored)' : '') + '.');
  },

  add_frame(a) {
    const sprite = load(a.name);
    const src = a.copyFrom == null ? null : sprite.frames[checkIndex(a.copyFrom, sprite.frames.length, 'frame')];
    sprite.frames.push({
      layers: sprite.frames[0].layers.map((proto, i) => ({
        name: proto.name, visible: proto.visible, opacity: proto.opacity,
        data: src ? src.layers[i].data : S.encodeRLE(new Array(sprite.w * sprite.h).fill(-1)),
      })),
    });
    save(sprite);
    return text('"' + sprite.name + '" now has ' + sprite.frames.length + ' frames. The new one is index ' + (sprite.frames.length - 1) + '.');
  },

  add_layer(a) {
    const sprite = load(a.name);
    for (const f of sprite.frames) {
      f.layers.push({
        name: a.layerName || 'Layer ' + (f.layers.length + 1),
        visible: true, opacity: 1,
        data: S.encodeRLE(new Array(sprite.w * sprite.h).fill(-1)),
      });
    }
    save(sprite);
    const n = sprite.frames[0].layers.length;
    return text('Added layer ' + (n - 1) + ' ("' + sprite.frames[0].layers[n - 1].name + '") to all ' + sprite.frames.length + ' frame(s).');
  },

  set_palette(a) {
    const sprite = load(a.name);
    let next = a.palette;
    if (!next && a.paletteName) {
      const p = S.PALETTES[a.paletteName];
      if (!p) throw new Error('no built-in palette named "' + a.paletteName + '". Try list_palettes.');
      next = p.colors.slice();
    }
    if (!next) throw new Error('give either palette or paletteName');
    const before = sprite.palette.length;
    sprite.palette = next;
    // Any pixel pointing past the new palette would render as nothing — clamp it.
    if (next.length < before) {
      for (const f of sprite.frames) {
        for (const l of f.layers) {
          const px = S.decodeRLE(l.data, sprite.w * sprite.h);
          for (let i = 0; i < px.length; i++) if (px[i] >= next.length) px[i] = next.length - 1;
          l.data = S.encodeRLE(Array.from(px));
        }
      }
    }
    save(sprite);
    return text('Palette for "' + sprite.name + '" is now:\n' +
      next.map((c, i) => '  ' + i + ' = ' + c).join('\n'));
  },

  transform(a) {
    const sprite = load(a.name);
    const frames = a.frame == null ? sprite.frames.map((_, i) => i) : [checkIndex(a.frame, sprite.frames.length, 'frame')];

    if (a.op === 'rotate_cw' && sprite.w !== sprite.h) {
      throw new Error('rotate_cw needs a square sprite; this one is ' + sprite.w + '×' + sprite.h);
    }

    let outlineIdx = -1;
    if (a.op === 'outline') {
      const hex = (a.outlineColor || '').toLowerCase();
      if (/^#[0-9a-f]{6}$/.test(hex)) {
        outlineIdx = sprite.palette.indexOf(hex);
        if (outlineIdx < 0) { sprite.palette.push(hex); outlineIdx = sprite.palette.length - 1; }
      } else {
        // darkest palette entry reads as an outline more often than not
        let best = 0, bestLum = Infinity;
        sprite.palette.forEach((c, i) => {
          const [r, g, b] = S.hexToRGB(c);
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          if (lum < bestLum) { bestLum = lum; best = i; }
        });
        outlineIdx = best;
      }
    }

    for (const fi of frames) {
      const layers = a.layer == null
        ? sprite.frames[fi].layers.map((_, i) => i)
        : [checkIndex(a.layer, sprite.frames[fi].layers.length, 'layer')];
      for (const li of layers) {
        const src = pixelsOf(sprite, fi, li);
        const out = new Int16Array(sprite.w * sprite.h).fill(-1);
        if (a.op === 'outline') {
          out.set(src);
          for (let y = 0; y < sprite.h; y++) {
            for (let x = 0; x < sprite.w; x++) {
              if (src[y * sprite.w + x] >= 0) continue;
              const touches = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
                const nx = x + dx, ny = y + dy;
                return nx >= 0 && ny >= 0 && nx < sprite.w && ny < sprite.h && src[ny * sprite.w + nx] >= 0;
              });
              if (touches) out[y * sprite.w + x] = outlineIdx;
            }
          }
        } else if (a.op === 'despeckle') {
          // 8-connectivity on purpose: a diagonal outline run is a real edge,
          // and a 4-connected test would eat it.
          out.set(src);
          const N = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
          for (let y = 0; y < sprite.h; y++) {
            for (let x = 0; x < sprite.w; x++) {
              const me = src[y * sprite.w + x];
              const nb = [];
              for (const [dx, dy] of N) {
                const nx = x + dx, ny = y + dy;
                if (nx >= 0 && ny >= 0 && nx < sprite.w && ny < sprite.h) nb.push(src[ny * sprite.w + nx]);
              }
              if (nb.some(v => v === me)) continue;
              const tally = new Map();
              nb.forEach(v => tally.set(v, (tally.get(v) || 0) + 1));
              let best = me, bestN = -1;
              tally.forEach((n, v) => { if (n > bestN) { bestN = n; best = v; } });
              out[y * sprite.w + x] = best;
            }
          }
        } else {
          const dx = Math.round(a.dx || 0), dy = Math.round(a.dy || 0);
          for (let y = 0; y < sprite.h; y++) {
            for (let x = 0; x < sprite.w; x++) {
              let nx, ny;
              if (a.op === 'flip_x') { nx = sprite.w - 1 - x; ny = y; }
              else if (a.op === 'flip_y') { nx = x; ny = sprite.h - 1 - y; }
              else if (a.op === 'rotate_cw') { nx = sprite.h - 1 - y; ny = x; }
              else { nx = x + dx; ny = y + dy; }
              if (nx < 0 || ny < 0 || nx >= sprite.w || ny >= sprite.h) continue;
              out[ny * sprite.w + nx] = src[y * sprite.w + x];
            }
          }
        }
        setPixelsOf(sprite, fi, li, out);
      }
    }
    save(sprite);
    return text('Applied ' + a.op + ' to "' + sprite.name + '".');
  },

  preview_sprite(a) {
    const sprite = load(a.name);
    const scale = Math.max(1, Math.min(32, Math.round(a.scale || 8)));
    const frame = checkIndex(a.frame == null ? 0 : a.frame, sprite.frames.length, 'frame');
    const png = a.silhouette ? silhouetteOf(sprite, frame, scale)
              : a.sheet ? sheetOf(sprite, scale, 0)
              : pngOf(sprite, frame, scale);
    return {
      content: [
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: sprite.name + ' — ' + sprite.w + '×' + sprite.h + ' at ' + scale + '× magnification' +
          (a.silhouette ? ', silhouette only — if you cannot tell what this is, fix the shape before anything else'
            : a.sheet ? ', all ' + sprite.frames.length + ' frames' : '') },
      ],
    };
  },

  export_sprite(a) {
    const sprite = load(a.name);
    const scale = Math.max(1, Math.min(64, Math.round(a.scale || 1)));
    const frame = checkIndex(a.frame == null ? 0 : a.frame, sprite.frames.length, 'frame');
    const ext = { png: 'png', sheet: 'png', gif: 'gif', svg: 'svg', css: 'css', datauri: 'html', json: 'json' }[a.format];
    if (!ext) throw new Error('unknown format: ' + a.format);

    let body;
    if (a.format === 'png') body = pngOf(sprite, frame, scale);
    else if (a.format === 'sheet') body = sheetOf(sprite, scale, a.cols);
    else if (a.format === 'gif') body = gifOf(sprite, scale);
    else if (a.format === 'svg') body = svgOf(sprite, frame, scale);
    else if (a.format === 'css') body = cssOf(sprite, frame, scale);
    else if (a.format === 'json') body = JSON.stringify(sprite, null, 2);
    else {
      const uri = 'data:image/png;base64,' + pngOf(sprite, frame, scale).toString('base64');
      body = '<img src="' + uri + '" width="' + sprite.w * scale + '" height="' + sprite.h * scale +
        '" style="image-rendering:pixelated" alt="' + sprite.name + '">';
    }

    // safeName() the sprite's own name — it is not a filename until here.
    const out = safeExportPath(
      a.outPath,
      safeName(sprite.name) + (a.format === 'sheet' ? '-sheet' : '') + '.' + ext);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body);
    return text('Wrote ' + out + ' (' + (Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body)) + ' bytes).');
  },

  delete_sprite(a) {
    const p = spritePath(a.name);
    if (!fs.existsSync(p)) throw new Error('no sprite named "' + safeName(a.name) + '"');
    fs.unlinkSync(p);
    return text('Deleted "' + safeName(a.name) + '".');
  },

  set_meta(a) {
    const sprite = load(a.name);
    const was = safeName(a.name);
    const changed = [];

    if (a.tags !== undefined) {
      if (!Array.isArray(a.tags)) throw new Error('tags must be an array of strings');
      sprite.tags = a.tags.map(String);
      changed.push('tags: ' + (sprite.tags.length ? sprite.tags.join(', ') : '(none)'));
    }
    if (a.fps !== undefined) {
      const fps = Math.round(Number(a.fps));
      if (!Number.isFinite(fps) || fps < 1 || fps > 60) throw new Error('fps must be a number from 1 to 60');
      sprite.fps = fps;
      changed.push('fps: ' + fps);
    }

    let now = was;
    if (a.newName !== undefined) {
      now = safeName(a.newName);
      if (now !== was && fs.existsSync(spritePath(now))) {
        throw new Error('a sprite named "' + now + '" already exists — delete it first or pick another name');
      }
      sprite.name = now;
      changed.push('name: ' + was + ' -> ' + now);
    }

    if (!changed.length) throw new Error('nothing to change — pass newName, tags or fps');

    save(sprite);
    // Write the new file before removing the old one, so a failure midway
    // leaves a duplicate rather than losing the sprite.
    if (now !== was) fs.unlinkSync(spritePath(was));
    return text('Updated "' + now + '".\n  ' + changed.join('\n  '));
  },

  delete_frame(a) {
    const sprite = load(a.name);
    const f = checkIndex(a.frame, sprite.frames.length, 'frame');
    if (sprite.frames.length === 1) {
      throw new Error('"' + sprite.name + '" has only one frame — a sprite must keep at least one. ' +
        'Use delete_sprite to remove it entirely.');
    }
    sprite.frames.splice(f, 1);
    save(sprite);
    return text('Removed frame ' + f + ' from "' + sprite.name + '". ' +
      sprite.frames.length + ' frame(s) left.');
  },

  delete_layer(a) {
    const sprite = load(a.name);
    // Layers run parallel across frames (add_layer adds to every frame), so the
    // index is validated against frame 0 and applied to all of them.
    const l = checkIndex(a.layer, sprite.frames[0].layers.length, 'layer');
    if (sprite.frames[0].layers.length === 1) {
      throw new Error('"' + sprite.name + '" has only one layer — a sprite must keep at least one.');
    }
    let removed = 0;
    for (const frame of sprite.frames) {
      if (frame.layers.length > 1 && l < frame.layers.length) {
        frame.layers.splice(l, 1);
        removed++;
      }
    }
    save(sprite);
    return text('Removed layer ' + l + ' from ' + removed + ' frame(s) of "' + sprite.name + '". ' +
      sprite.frames[0].layers.length + ' layer(s) left.');
  },

  move_layer(a) {
    const sprite = load(a.name);
    const count = sprite.frames[0].layers.length;
    const from = checkIndex(a.layer, count, 'layer');
    const to = checkIndex(a.to, count, 'target index');
    if (from === to) return text('Layer ' + from + ' is already at that index.');
    for (const frame of sprite.frames) {
      if (from < frame.layers.length) {
        const [moved] = frame.layers.splice(from, 1);
        frame.layers.splice(Math.min(to, frame.layers.length), 0, moved);
      }
    }
    save(sprite);
    return text('Moved layer ' + from + ' to ' + to + ' in "' + sprite.name + '". ' +
      'Order is bottom to top: ' + sprite.frames[0].layers.map(l => l.name).join(', '));
  },

  set_layer(a) {
    const sprite = load(a.name);
    const l = checkIndex(a.layer, sprite.frames[0].layers.length, 'layer');
    const changed = [];

    if (a.layerName !== undefined) changed.push('name: ' + String(a.layerName));
    if (a.visible !== undefined) {
      // Insist on a real boolean. Coercing would read the string "false" as
      // truthy and reveal a layer the caller was trying to hide.
      if (typeof a.visible !== 'boolean') throw new Error('visible must be true or false, not ' + JSON.stringify(a.visible));
      changed.push('visible: ' + a.visible);
    }
    if (a.opacity !== undefined) {
      const o = Number(a.opacity);
      if (!Number.isFinite(o) || o < 0 || o > 1) throw new Error('opacity must be a number from 0 to 1');
      changed.push('opacity: ' + o);
    }
    if (!changed.length) throw new Error('nothing to change — pass layerName, visible or opacity');

    for (const frame of sprite.frames) {
      const layer = frame.layers[l];
      if (!layer) continue;
      if (a.layerName !== undefined) layer.name = String(a.layerName);
      if (a.visible !== undefined) layer.visible = a.visible;
      if (a.opacity !== undefined) layer.opacity = Number(a.opacity);
    }
    save(sprite);
    return text('Updated layer ' + l + ' of "' + sprite.name + '".\n  ' + changed.join('\n  '));
  },

  merge_layer(a) {
    const sprite = load(a.name);
    const l = checkIndex(a.layer, sprite.frames[0].layers.length, 'layer');
    if (l === 0) throw new Error('layer 0 is the bottom layer — there is nothing beneath it to merge into');

    // Merging a hidden layer makes its pixels visible, which changes how the
    // sprite looks and cannot be undone. Refuse rather than warn afterwards —
    // by the time a warning is read, the art has already changed.
    const hiddenIn = sprite.frames.findIndex(f => f.layers[l] && f.layers[l].visible === false);
    if (hiddenIn >= 0) {
      throw new Error('layer ' + l + ' is hidden in frame ' + hiddenIn + '. Merging it would make its pixels ' +
        'visible and there is no undo. Call set_layer with visible: true first if that is what you want, ' +
        'or delete_layer to discard it.');
    }
    for (const frame of sprite.frames) {
      if (l >= frame.layers.length) continue;
      const size = sprite.w * sprite.h;
      const top = S.decodeRLE(frame.layers[l].data, size);
      const under = S.decodeRLE(frame.layers[l - 1].data, size);
      for (let i = 0; i < size; i++) if (top[i] >= 0) under[i] = top[i];
      frame.layers[l - 1].data = S.encodeRLE(Array.from(under));
      frame.layers.splice(l, 1);
    }
    save(sprite);
    return text('Merged layer ' + l + ' into layer ' + (l - 1) + ' of "' + sprite.name + '". ' +
      sprite.frames[0].layers.length + ' layer(s) left.');
  },
};

// ---------------------------------------------------------------- transport

const SERVER_INFO = { name: 'pixelart', version: '1.0.0' };

const INSTRUCTIONS = [
  'This server draws and stores pixel art in a shared library that a human also edits in a browser.',
  '',
  'The usual loop is: list_palettes -> create_sprite -> draw_shapes -> preview_sprite -> adjust -> export_sprite.',
  'Always call preview_sprite after drawing. Pixel art is unforgiving and reading back ASCII is not the same as seeing it.',
  '',
  'Which drawing tool to reach for:',
  '- draw_shapes for anything with a curve — bodies, heads, limbs, tails. You name centres and radii',
  '  and get real geometry. Writing curves as ascii means counting characters per row, and the usual',
  '  failure is constant-width rows, which come out as a rounded rectangle no matter what was intended.',
  '- draw_ascii with mode "over" for faces and small detail, stamped on top of the shapes.',
  '- preview_sprites to review a whole batch in one image rather than one round trip each.',
  '',
  'Advice that makes the art better:',
  '- Keep palettes small. Four to sixteen colours is plenty; more looks muddy at these sizes.',
  '- Work at the smallest size that carries the idea, then export at 4x or 8x rather than drawing large.',
  '- Use the "shade" option rather than a flat fill. Three tones against one light source is the',
  '  difference between a lit form and a flat sticker, and it costs nothing to ask for.',
  '- Outline each part with a dark tint of its own colour, not one black keyline over everything.',
  '  A single keyline welds the parts together and is most of what makes art read as clip art.',
  '- Avoid single stray pixels along a diagonal; they read as noise rather than as an edge.',
  '  draw_shapes cleans these up by default, and transform op "despeckle" fixes existing art.',
].join('\n');

function reply(id, result) { write({ jsonrpc: '2.0', id: id, result: result }); }
function replyError(id, code, message) { write({ jsonrpc: '2.0', id: id, error: { code: code, message: message } }); }
function write(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });

  if (method === 'tools/call') {
    const fn = HANDLERS[params && params.name];
    if (!fn) return replyError(id, -32601, 'no tool named ' + (params && params.name));
    try {
      return reply(id, fn(params.arguments || {}));
    } catch (err) {
      // Tool failures come back as results so the model can read the message and retry.
      return reply(id, { content: [{ type: 'text', text: 'Error: ' + err.message }], isError: true });
    }
  }

  if (id != null) replyError(id, -32601, 'unsupported method: ' + method);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch (e) { continue; }
    try { handle(msg); }
    catch (err) { if (msg.id != null) replyError(msg.id, -32603, err.message); }
  }
});
process.stdin.on('end', () => process.exit(0));
