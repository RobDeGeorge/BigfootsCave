#!/usr/bin/env node
'use strict';
/**
 * Phase 0 static site generator for the public gallery.
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
const LANDING = path.join(__dirname, 'landing.template.html');

const REPO = 'https://github.com/RobDeGeorge/PixelArtEngine';

/**
 * Where the built site actually lives. Absolute URLs (canonical, og:*, sitemap)
 * are derived from this, so moving to a custom domain later is a one-line edit.
 */
const SITE_URL = 'https://robdegeorge.github.io/PixelArtEngine';

/**
 * Path prefix the site is served under — '/PixelArtEngine/' on a GitHub Pages
 * project site, '/' at the root of a domain.
 *
 * index.html only ever uses relative asset paths, so it survives either. 404.html
 * cannot: Pages serves it for a request at any depth, so a relative href would
 * resolve against the missing path rather than the site root. It needs this.
 */
const BASE = new URL(SITE_URL).pathname.replace(/\/?$/, '/');

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
 * identical 16×16 set symbols would bury the artwork worth showing off. Rank
 * by what a first-time visitor should see: the big characters and scenes, then
 * the interface work, then the long tail.
 */
const FEATURE_ORDER = ['retro', 'scene', 'character', 'flower', 'anim', 'banner', 'portrait'];

/**
 * Tags that sink below everything else, whatever else they carry.
 *
 * The bigfoot set stays in the library and stays searchable — it is just not
 * what the site leads with any more. This has to be tested *before*
 * FEATURE_ORDER, because those sprites are also tagged `scene` and `character`
 * and would otherwise walk straight back onto the front page.
 */
const DEMOTE = ['bigfoot'];

function featureRank(sprite, tags) {
  if (DEMOTE.some(t => tags.includes(t))) return FEATURE_ORDER.length + 3;
  for (let i = 0; i < FEATURE_ORDER.length; i++) {
    if (tags.includes(FEATURE_ORDER[i])) return i;
  }
  // Untagged-but-large sprites are usually real artwork; tiny icons rarely are.
  const area = sprite.w * sprite.h;
  if (area >= 64 * 64) return FEATURE_ORDER.length;
  if (area >= 32 * 32) return FEATURE_ORDER.length + 1;
  return FEATURE_ORDER.length + 2;
}

/** Sprite titles and tags are free text; the landing page puts them in markup. */
function escapeHTML(s) {
  return String(s).replace(/[&<>"]/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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

/**
 * The editor, adapted for a static host.
 *
 * index.html is the editor as it runs locally against server.js. Published,
 * there is no API — and it already copes, because checkServer() flips it into an
 * offline mode where Save downloads a .json instead of POSTing. Two things it
 * cannot know on its own: that a built gallery exists at a sibling URL, and that
 * telling a visitor to "run: node server.js" is the wrong advice on a public
 * page. Both are patched here, on a copy, so the local editor is untouched.
 */
function editorPage(html, headTags) {
  const shim = `
<script>
// Injected by tools/build-site.js for the static build: no /api on this host.
(function () {
  var g = document.getElementById('btnGallery');
  if (g) g.onclick = function () { location.href = 'gallery.html'; };
  // Locally the editor is the whole app, so its wordmark goes nowhere. Published
  // it sits under a landing page, and with no link back it would be a dead end.
  // A real anchor, so middle-click and keyboard focus behave as expected.
  var lg = document.getElementById('logo');
  if (lg) {
    var a = document.createElement('a');
    a.href = './';
    a.textContent = lg.textContent;
    a.title = 'Back to pixelartengine';
    a.style.color = 'inherit';
    a.style.textDecoration = 'none';
    lg.textContent = '';
    lg.appendChild(a);
  }
  var el = document.getElementById('serverState');
  if (!el) return;
  // checkServer() resolves after this runs, so watch for its result rather than
  // racing it. Rewriting the text re-fires the observer, but the guard is false
  // the second time, so it settles immediately.
  new MutationObserver(function () {
    if (el.textContent.indexOf('offline') !== -1) {
      el.textContent = '\\u25cb browser mode \\u2014 Save downloads a file';
    }
  }).observe(el, { childList: true, characterData: true, subtree: true });
})();
</script>`;
  return html
    .replace('</head>', () => headTags + '\n</head>')
    .replace('</body>', () => shim + '\n</body>');
}

/** GitHub Pages serves /404.html for any unknown path. */
function notFoundPage(logo) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found — Pixel Art Engine</title>
<meta name="robots" content="noindex">
<link rel="icon" href="${BASE}brand/icon.png">
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#10120e; color:#cfe0b8; text-align:center;
         font:15px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  img { image-rendering:pixelated; width:96px; height:96px; }
  h1 { color:#9bbc0f; letter-spacing:.12em; text-transform:uppercase; font-size:20px; margin:18px 0 6px; }
  p { color:#7f8f6c; margin:0 0 20px; }
  a { color:#9bbc0f; }
</style>
</head>
<body>
  <div>
    <img src="${BASE}${logo}" alt="">
    <h1>Nothing here</h1>
    <p>There's nothing at this address.</p>
    <a href="${BASE}">Back to the start</a>
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
  const logoSprite = pick('logo-dpad', 'retro-cartridge');

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
    .replace(/__SITEURL__/g, SITE_URL)
    .replace(/__LOGO__/g, logo)
    .replace(/__FAVICON__/g, favicon)
    .replace(/__OGIMAGE__/g, ogImage)
    .replace(/__ANALYTICS__/g, () => analyticsTag());

  write('gallery.html', html);

  // ---- the landing page, which is what `/` serves ------------------------
  // Featured art first, then everything, because the strip cycles through the
  // whole library — the opening frame should still be the good stuff.
  const ordered = sprites.slice()
    .sort((a, b) => a.rank - b.rank || b.updated.localeCompare(a.updated));

  // A sprite's first tag stands in for "which set is this from". The strip uses
  // it to avoid filling itself with one set — see the guard in the template.
  const group = s => (s.tags && s.tags[0]) || '';

  const SHOWCASE_TILES = 8;
  const showcase = ordered.slice(0, SHOWCASE_TILES).map(s =>
    '<figure data-group="' + escapeHTML(group(s)) + '">' +
    '<a href="gallery.html"><div class="box"><img src="' + escapeHTML(s.img) +
    '" width="' + s.iw + '" height="' + s.ih + '" alt="' + escapeHTML(s.title) + '">' +
    '</div><figcaption>' + escapeHTML(s.title) + '</figcaption></a></figure>')
    .join('\n      ');

  /**
   * Every sprite, for the strip to rotate through.
   *
   * The thumbnails total ~1.7 MB across 410 sprites, so a marquee holding them
   * all would make the landing page many times heavier than the tool it is
   * advertising. This ships paths only — about 25 KB — and the page keeps eight
   * <img> elements alive, swapping their src. The browser fetches each ~4 KB
   * thumbnail on demand and caches it.
   */
  const showcaseData = JSON.stringify(
    ordered.map(s => [s.img, s.title, s.iw, s.ih, group(s)]));

  write('index.html', fs.readFileSync(LANDING, 'utf8')
    .replace(/__COUNT__/g, String(sprites.length))
    .replace(/__BUILT__/g, built)
    .replace(/__REPO__/g, REPO)
    .replace(/__SITEURL__/g, SITE_URL)
    .replace(/__LOGO__/g, logo)
    .replace(/__FAVICON__/g, favicon)
    .replace(/__OGIMAGE__/g, ogImage)
    .replace(/__SHOWCASE__/g, () => showcase)
    .replace(/__SHOWCASE_DATA__/g, () => showcaseData)
    .replace(/__ANALYTICS__/g, () => analyticsTag()));

  // ---- the editor --------------------------------------------------------
  const editorSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  // Copy whatever the editor actually loads rather than a hardcoded list, so a
  // new dependency ships instead of 404ing silently on the published site.
  for (const m of editorSrc.matchAll(/<script[^>]+src="([^"]+)"/g)) {
    const rel = m[1];
    if (/^https?:/.test(rel)) continue;
    const from = path.join(ROOT, rel);
    if (!fs.existsSync(from)) {
      console.error('  editor references ' + rel + ', which does not exist');
      process.exit(1);
    }
    write(rel, fs.readFileSync(from));
  }

  const editorHead = [
    '<meta name="description" content="A free pixel art editor that runs in your browser — layers, frames, onion skinning, palette swapping, GIF and spritesheet export. No account, no install.">',
    '<meta property="og:title" content="Pixel Art Engine">',
    '<meta property="og:description" content="A free pixel art editor that runs in your browser. Draw, animate and export — no account, no install.">',
    '<meta property="og:type" content="website">',
    '<meta property="og:url" content="' + SITE_URL + '/editor.html">',
    '<meta property="og:image" content="' + SITE_URL + '/' + ogImage + '">',
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta property="og:site_name" content="Pixel Art Engine">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:image" content="' + SITE_URL + '/' + ogImage + '">',
    '<link rel="canonical" href="' + SITE_URL + '/editor.html">',
    '<link rel="icon" href="' + favicon + '">',
    analyticsTag(),
  ].join('\n');

  write('editor.html', editorPage(editorSrc, editorHead));
  // No CNAME: the site is served from github.io, not a custom domain. Writing one
  // would silently claim that domain the moment its DNS pointed at GitHub.
  write('.nojekyll', '');            // stop Pages eating files that start with _

  // A site whose whole strategy is accumulating art needs to be indexable.
  write('robots.txt',
    'User-agent: *\nAllow: /\n\nSitemap: ' + SITE_URL + '/sitemap.xml\n');
  // Both pages, because the gallery is the crawlable content — it is the reason
  // the site is worth indexing, and it no longer sits at the root.
  const urls = ['/', '/editor.html', '/gallery.html'].map(u =>
    '  <url>\n' +
    '    <loc>' + SITE_URL + u + '</loc>\n' +
    '    <lastmod>' + built + '</lastmod>\n' +
    '    <changefreq>weekly</changefreq>\n' +
    '  </url>\n').join('');
  write('sitemap.xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls +
    '</urlset>\n');
  write('404.html', notFoundPage(logo));

  const mb = (bytes / 1e6).toFixed(2);
  console.log('  built ' + sprites.length + ' sprites -> ' + path.relative(ROOT, OUT) + '/');
  console.log('  assets ' + mb + ' MB · html ' + (html.length / 1024).toFixed(0) + ' KB');
  console.log('  site ' + SITE_URL + '/');
  if (skipped.length) {
    console.log('  skipped ' + skipped.length + ':');
    for (const s of skipped) console.log('    ' + s);
  }
}

build();
