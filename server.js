#!/usr/bin/env node
'use strict';
/**
 * Pixel art engine — static host for the editor plus a REST API over the
 * sprite library on disk. No dependencies; `node server.js` and go.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const S = require('./lib/sprite');
const { encodePNG } = require('./lib/png');
const { encodeGIF } = require('./lib/gif');

const ROOT = __dirname;
const LIBRARY = path.join(ROOT, 'library');
const PORT = Number(process.env.PORT) || 8787;

fs.mkdirSync(LIBRARY, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

/** Sprite names are filenames — keep them boring so they can never escape the library. */
function safeName(name) {
  const clean = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!clean) throw new Error('invalid sprite name');
  return clean.slice(0, 64);
}

function spritePath(name) {
  return path.join(LIBRARY, safeName(name) + '.json');
}

function readSprite(name) {
  return S.validate(JSON.parse(fs.readFileSync(spritePath(name), 'utf8')));
}

function listSprites() {
  return fs.readdirSync(LIBRARY)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const full = path.join(LIBRARY, f);
      try {
        const sp = JSON.parse(fs.readFileSync(full, 'utf8'));
        return {
          name: path.basename(f, '.json'),
          title: sp.name,
          w: sp.w, h: sp.h,
          frames: (sp.frames || []).length,
          layers: ((sp.frames || [])[0] || {}).layers ? sp.frames[0].layers.length : 0,
          palette: sp.palette,
          tags: sp.tags || [],
          updated: fs.statSync(full).mtime.toISOString(),
        };
      } catch (e) {
        return { name: path.basename(f, '.json'), error: e.message };
      }
    })
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
}

// ------------------------------------------------------------------ exports

function spriteToPNG(sprite, frame, scale) {
  scale = S.clampScale(sprite.w, sprite.h, scale, 1);
  const { width, height, rgba } = S.frameToRGBA(sprite, frame, scale);
  return encodePNG(width, height, rgba);
}

function spriteToSheet(sprite, scale, cols) {
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
      const src = y * cw * 4;
      const dst = ((oy + y) * W + ox) * 4;
      rgba.set(cell.rgba.subarray(src, src + cw * 4), dst);
    }
  }
  return encodePNG(W, H, rgba);
}

function spriteToGIF(sprite, scale) {
  scale = S.clampScale(sprite.w, sprite.h, scale, sprite.frames.length);
  return Buffer.from(encodeGIF({
    width: sprite.w,
    height: sprite.h,
    palette: sprite.palette,
    frames: sprite.frames.map((_, i) => S.flattenFrame(sprite, i)),
    delayMs: 1000 / sprite.fps,
    scale: scale,
  }));
}

// ------------------------------------------------------------------ routing

/**
 * Reads are open so exports can be embedded from other local projects
 * (`<img src="http://localhost:8787/api/export/x.png">`). Writes are not:
 * a wildcard on mutating methods lets any page the user happens to be
 * visiting preflight and then POST/PUT/DELETE into the library, and this
 * server has no authentication to fall back on. Images don't consult CORS
 * at all, so keeping the wildcard on GET costs nothing.
 */
function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i;

/**
 * Guards mutating requests against a web page the user is visiting and against
 * DNS rebinding.
 *
 * A cross-origin `fetch` always sends `Origin`, so rejecting a non-local one
 * closes the browser path. Rebinding gets the attacker a local-looking Origin
 * but not a local `Host`, so both are checked. Direct clients (curl, the MCP
 * server) send no Origin and are unaffected.
 */
function localRequestOnly(req) {
  const host = req.headers.host || '';
  if (!LOCAL_HOST.test(host)) return 'refusing request for host "' + host + '" — bind is localhost only';
  const origin = req.headers.origin;
  if (origin) {
    let h;
    try { h = new URL(origin).host; } catch (e) { return 'bad Origin header'; }
    if (!LOCAL_HOST.test(h)) return 'cross-origin writes are not allowed (Origin: ' + origin + ')';
  }
  return null;
}

function sendJSON(res, code, obj) {
  send(res, code, JSON.stringify(obj, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 20 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleAPI(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ["api", ...]
  const q = url.searchParams;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const refusal = localRequestOnly(req);
    if (refusal) return sendJSON(res, 403, { error: refusal });
  }

  if (parts[1] === 'palettes') return sendJSON(res, 200, S.PALETTES);

  if (parts[1] === 'sprites') {
    const name = parts[2];
    if (!name) {
      if (req.method === 'GET') return sendJSON(res, 200, listSprites());
      if (req.method === 'POST') {
        const sprite = S.validate(JSON.parse(await readBody(req)));
        const file = safeName(sprite.name);
        fs.writeFileSync(spritePath(file), JSON.stringify(sprite, null, 2));
        return sendJSON(res, 201, { ok: true, name: file });
      }
    } else {
      if (req.method === 'GET') return sendJSON(res, 200, readSprite(name));
      if (req.method === 'PUT') {
        const sprite = S.validate(JSON.parse(await readBody(req)));
        // The URL is the sprite's identity. Letting the body disagree writes a
        // file whose internal name points at a different sprite, and the next
        // edit of this one would then overwrite that one instead.
        sprite.name = safeName(name);
        fs.writeFileSync(spritePath(name), JSON.stringify(sprite, null, 2));
        return sendJSON(res, 200, { ok: true, name: safeName(name) });
      }
      if (req.method === 'DELETE') {
        fs.unlinkSync(spritePath(name));
        return sendJSON(res, 200, { ok: true });
      }
    }
  }

  // /api/export/<name>.<png|gif>  and  /api/export/<name>.sheet.png
  if (parts[1] === 'export' && parts[2]) {
    const file = parts[2];
    const scale = Math.max(1, Math.min(64, Number(q.get('scale')) || 1));
    const m = /^(.+?)(\.sheet)?\.(png|gif)$/.exec(file);
    if (!m) return sendJSON(res, 400, { error: 'export path must end in .png or .gif' });
    const sprite = readSprite(m[1]);
    if (m[3] === 'gif') return send(res, 200, spriteToGIF(sprite, scale), MIME['.gif']);
    if (m[2]) return send(res, 200, spriteToSheet(sprite, scale, Number(q.get('cols')) || 0), MIME['.png']);
    const frame = Math.max(0, Math.min(sprite.frames.length - 1, Number(q.get('frame')) || 0));
    return send(res, 200, spriteToPNG(sprite, frame, scale), MIME['.png']);
  }

  return sendJSON(res, 404, { error: 'no such endpoint' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const full = path.join(ROOT, rel);
  if (!full.startsWith(ROOT + path.sep)) return sendJSON(res, 403, { error: 'forbidden' });
  fs.readFile(full, (err, data) => {
    if (err) return sendJSON(res, 404, { error: 'not found: ' + rel });
    send(res, 200, data, MIME[path.extname(full).toLowerCase()] || 'application/octet-stream');
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (url.pathname.startsWith('/api/')) {
    handleAPI(req, res, url).catch(err => {
      const code = /ENOENT/.test(err.message) ? 404 : 400;
      sendJSON(res, code, { error: err.message });
    });
    return;
  }
  serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log('  pixel art engine');
  console.log('  editor   http://localhost:' + PORT);
  console.log('  library  ' + LIBRARY);
});
