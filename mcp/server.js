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
const path = require('path');
const S = require('../lib/sprite');
const { encodePNG } = require('../lib/png');
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
        op: { type: 'string', enum: ['flip_x', 'flip_y', 'rotate_cw', 'shift', 'outline'], description: 'rotate_cw needs a square sprite. outline traces a 1px border in outlineColor.' },
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
    const png = a.sheet ? sheetOf(sprite, scale, 0)
                        : pngOf(sprite, checkIndex(a.frame == null ? 0 : a.frame, sprite.frames.length, 'frame'), scale);
    return {
      content: [
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: sprite.name + ' — ' + sprite.w + '×' + sprite.h + ' at ' + scale + '× magnification' +
          (a.sheet ? ', all ' + sprite.frames.length + ' frames' : '') },
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
    if (a.visible !== undefined) changed.push('visible: ' + (a.visible !== false));
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
      if (a.visible !== undefined) layer.visible = a.visible !== false;
      if (a.opacity !== undefined) layer.opacity = Number(a.opacity);
    }
    save(sprite);
    return text('Updated layer ' + l + ' of "' + sprite.name + '".\n  ' + changed.join('\n  '));
  },

  merge_layer(a) {
    const sprite = load(a.name);
    const l = checkIndex(a.layer, sprite.frames[0].layers.length, 'layer');
    if (l === 0) throw new Error('layer 0 is the bottom layer — there is nothing beneath it to merge into');

    const hidden = sprite.frames[0].layers[l].visible === false;
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
      sprite.frames[0].layers.length + ' layer(s) left.' +
      (hidden ? '\n\nHeads up: that layer was hidden, and its pixels are now visible in the merged result.' : ''));
  },
};

// ---------------------------------------------------------------- transport

const SERVER_INFO = { name: 'pixelart', version: '1.0.0' };

const INSTRUCTIONS = [
  'This server draws and stores pixel art in a shared library that a human also edits in a browser.',
  '',
  'The usual loop is: list_palettes -> create_sprite -> draw_ascii -> preview_sprite -> adjust -> export_sprite.',
  'Always call preview_sprite after drawing. Pixel art is unforgiving and reading back ASCII is not the same as seeing it.',
  '',
  'Advice that makes the art better:',
  '- Keep palettes small. Four to sixteen colours is plenty; more looks muddy at these sizes.',
  '- Work at the smallest size that carries the idea, then export at 4x or 8x rather than drawing large.',
  '- Give shapes a dark outline and put the light source in one consistent corner.',
  '- Avoid single stray pixels along a diagonal; they read as noise rather than as an edge.',
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
