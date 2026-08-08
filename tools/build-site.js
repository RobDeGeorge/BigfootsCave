#!/usr/bin/env node
'use strict';
/**
 * Phase 0 static site generator for bigfootscave.com.
 *
 * Renders every sprite in library/ to PNG (and GIF for animated ones), then
 * writes a self-contained gallery into site/. No server, no database, nothing
 * to attack — it's files. Deployable to GitHub Pages as-is.
 *
 *   node tools/build-site.js
 */

const fs = require('fs');
const path = require('path');
const S = require('../lib/sprite');
const { encodePNG } = require('../lib/png');
const { encodeGIF } = require('../lib/gif');
const { buildCard } = require('./social-card');

const ROOT = path.join(__dirname, '..');
const LIBRARY = process.env.PIXELART_LIBRARY || path.join(ROOT, 'library');
const OUT = process.env.PIXELART_SITE || path.join(ROOT, 'site');
const TEMPLATE = path.join(__dirname, 'gallery.template.html');

const DOMAIN = 'bigfootscave.com';
const REPO = 'https://github.com/RobDeGeorge/BigfootsCave';

/**
 * Cloudflare Web Analytics site token, or empty to emit nothing at all.
 *
 * Cookieless and with no cross-site identifiers, so it needs no consent
 * banner. The token is public by design — it ships in the page — but it is
 * still validated before being interpolated, since it arrives from the
 * environment and lands inside an HTML attribute.
 */
const ANALYTICS_TOKEN = (process.env.PIXELART_ANALYTICS_TOKEN || '').trim();

function analyticsTag() {
  if (!ANALYTICS_TOKEN) {
    return '<!-- analytics: set PIXELART_ANALYTICS_TOKEN to enable -->';
  }
  if (!/^[A-Za-z0-9]{16,64}$/.test(ANALYTICS_TOKEN)) {
    console.error('  PIXELART_ANALYTICS_TOKEN does not look like a site token — refusing to embed it');
    process.exit(1);
  }
  return '<script defer src="https://static.cloudflareinsights.com/beacon.min.js" ' +
    'data-cf-beacon=\'{"token":"' + ANALYTICS_TOKEN + '"}\'></script>';
}

/** Thumbnails aim for roughly this many pixels on the long edge. */
const THUMB_TARGET = 256;
/** Scale for the "download the PNG" asset. */
const DOWNLOAD_SCALE = 8;

// ------------------------------------------------------------------ helpers

/** Largest integer scale that keeps the long edge at or under `target`. */
function fitScale(w, h, target) {
  return Math.max(1, Math.floor(target / Math.max(w, h)));
}

/**
 * Ordering for the default "featured" view.
 *
 * Sorting by mtime puts whatever was generated last on the front page, and
 * bulk runs are exactly the kind of thing that gets generated last — 294 near
 * identical 16×16 set symbols would bury the art the site is named after. Rank
 * by what a first-time visitor should see: the big characters and scenes, then
 * the interface work, then the long tail.
 */
const FEATURE_ORDER = ['bigfoot', 'scene', 'character', 'flower', 'anim', 'banner', 'portrait'];

function featureRank(sprite, tags) {
  for (let i = 0; i < FEATURE_ORDER.length; i++) {
    if (tags.includes(FEATURE_ORDER[i])) return i;
  }
  // Untagged-but-large sprites are usually real artwork; tiny icons rarely are.
  const area = sprite.w * sprite.h;
  if (area >= 64 * 64) return FEATURE_ORDER.length;
  if (area >= 32 * 32) return FEATURE_ORDER.length + 1;
  return FEATURE_ORDER.length + 2;
}

function write(rel, data) {
  const full = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
  return rel;
}

function png(sprite, frame, scale) {
  scale = S.clampScale(sprite.w, sprite.h, scale, 1);
  const { width, height, rgba } = S.frameToRGBA(sprite, frame, scale);
  return encodePNG(width, height, rgba);
}

function sheet(sprite, scale) {
  const n = sprite.frames.length;
  scale = S.clampScale(sprite.w, sprite.h, scale, n);
  const cw = sprite.w * scale, ch = sprite.h * scale;
  const cols = Math.min(n, 8), rows = Math.ceil(n / cols);
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

function gif(sprite, scale) {
  scale = S.clampScale(sprite.w, sprite.h, scale, sprite.frames.length);
  return Buffer.from(encodeGIF({
    width: sprite.w, height: sprite.h, palette: sprite.palette,
    frames: sprite.frames.map((_, i) => S.flattenFrame(sprite, i)),
    delayMs: 1000 / sprite.fps,
    scale: scale,
  }));
}

/** GitHub Pages serves /404.html for any unknown path. */
function notFoundPage(logo) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found — Bigfoot's Cave</title>
<meta name="robots" content="noindex">
<link rel="icon" href="/brand/icon.png">
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#12100e; color:#e8ddd0; text-align:center;
         font:15px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  img { image-rendering:pixelated; width:96px; height:96px; }
  h1 { color:#f2b134; letter-spacing:.12em; text-transform:uppercase; font-size:20px; margin:18px 0 6px; }
  p { color:#8b7d6d; margin:0 0 20px; }
  a { color:#f2b134; }
</style>
</head>
<body>
  <div>
    <img src="/${logo}" alt="">
    <h1>Tracks lead nowhere</h1>
    <p>There's nothing at this address.</p>
    <a href="/">Back to the cave</a>
  </div>
</body>
</html>
`;
}

// -------------------------------------------------------------------- build

function build() {
  if (!fs.existsSync(LIBRARY)) {
    console.error('no library at ' + LIBRARY);
    process.exit(1);
  }

  // Start clean so deleted sprites don't linger as orphaned files in the site.
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const files = fs.readdirSync(LIBRARY).filter(f => f.endsWith('.json')).sort();
  const sprites = [];
  const skipped = [];
  let bytes = 0;

  for (const file of files) {
    const name = path.basename(file, '.json');
    let sprite;
    try {
      sprite = S.validate(JSON.parse(fs.readFileSync(path.join(LIBRARY, file), 'utf8')));
    } catch (e) {
      skipped.push(name + ' — ' + e.message);
      continue;
    }

    const animated = sprite.frames.length > 1;
    const thumbScale = fitScale(sprite.w, sprite.h, THUMB_TARGET);
    const updated = fs.statSync(path.join(LIBRARY, file)).mtime.toISOString();

    const assets = {};
    assets.png = write('a/' + name + '.png', png(sprite, 0, DOWNLOAD_SCALE));
    const thumb = write('a/' + name + '.t.png', png(sprite, 0, thumbScale));
    if (animated) {
      assets.gif = write('a/' + name + '.gif', gif(sprite, thumbScale));
      assets.sheet = write('a/' + name + '.sheet.png', sheet(sprite, DOWNLOAD_SCALE));
    }
    assets.json = write('s/' + name + '.json', JSON.stringify(sprite, null, 2));

    for (const rel of Object.values(assets).concat(thumb)) {
      bytes += fs.statSync(path.join(OUT, rel)).size;
    }

    sprites.push({
      name,
      title: sprite.name,
      w: sprite.w, h: sprite.h,
      frames: sprite.frames.length,
      fps: sprite.fps,
      palette: sprite.palette,
      tags: sprite.tags,
      updated,
      img: animated ? assets.gif : thumb,   // what the card shows
      iw: sprite.w * thumbScale,            // real asset size, so cards don't reflow
      ih: sprite.h * thumbScale,
      png: assets.png,
      gif: assets.gif || null,
      sheet: assets.sheet || null,
      json: assets.json,
      big: fitScale(sprite.w, sprite.h, 380), // integer scale for the lightbox
      rank: featureRank(sprite, sprite.tags),
    });
  }

  if (!sprites.length) {
    console.error('library has no valid sprites — nothing to build');
    process.exit(1);
  }

  // Pick brand assets by preference, falling back to whatever exists.
  const pick = (...names) => names.map(n => sprites.find(s => s.name === n)).find(Boolean) || sprites[0];
  const logoSprite = pick('bigfoot-icon', 'bigfoot-face', 'bigfoot-stand');

  const loadSprite = name => {
    try {
      return S.validate(JSON.parse(fs.readFileSync(path.join(LIBRARY, name + '.json'), 'utf8')));
    } catch (e) {
      return null;
    }
  };

  const logo = write('brand/logo.png',
    png(loadSprite(logoSprite.name), 0, fitScale(logoSprite.w, logoSprite.h, 112)));
  const favicon = write('brand/icon.png',
    png(loadSprite(logoSprite.name), 0, fitScale(logoSprite.w, logoSprite.h, 64)));
  const ogImage = write('brand/og.png',
    buildCard(loadSprite, sprites.map(s => s.name)));

  // Sprite titles and tags are free text written by humans and agents, and they
  // get embedded in a <script> block. A literal "</script>" in any of them would
  // close the block early, so neutralise it (and the HTML-comment opener, which
  // has the same effect inside a script element).
  const payload = JSON.stringify(sprites)
    .replace(/<\/(script)/gi, '<\\/$1')
    .replace(/<!--/g, '<\\!--');

  const built = new Date().toISOString().slice(0, 10);
  const html = fs.readFileSync(TEMPLATE, 'utf8')
    .replace(/__SPRITES__/g, () => payload)
    .replace(/__COUNT__/g, String(sprites.length))
    .replace(/__BUILT__/g, built)
    .replace(/__REPO__/g, REPO)
    .replace(/__LOGO__/g, logo)
    .replace(/__FAVICON__/g, favicon)
    .replace(/__OGIMAGE__/g, ogImage)
    .replace(/__ANALYTICS__/g, () => analyticsTag());

  write('index.html', html);
  write('CNAME', DOMAIN + '\n');     // GitHub Pages custom domain
  write('.nojekyll', '');            // stop Pages eating files that start with _

  // A site whose whole strategy is accumulating art needs to be indexable.
  write('robots.txt',
    'User-agent: *\nAllow: /\n\nSitemap: https://' + DOMAIN + '/sitemap.xml\n');
  write('sitemap.xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    '  <url>\n' +
    '    <loc>https://' + DOMAIN + '/</loc>\n' +
    '    <lastmod>' + built + '</lastmod>\n' +
    '    <changefreq>weekly</changefreq>\n' +
    '  </url>\n' +
    '</urlset>\n');
  write('404.html', notFoundPage(logo));

  const mb = (bytes / 1e6).toFixed(2);
  console.log('  built ' + sprites.length + ' sprites -> ' + path.relative(ROOT, OUT) + '/');
  console.log('  assets ' + mb + ' MB · html ' + (html.length / 1024).toFixed(0) + ' KB');
  console.log('  domain ' + DOMAIN);
  if (skipped.length) {
    console.log('  skipped ' + skipped.length + ':');
    for (const s of skipped) console.log('    ' + s);
  }
}

build();
