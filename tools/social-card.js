'use strict';
/**
 * Composes the 1200×630 social preview card from sprites in the library.
 *
 * Link previews on Twitter, Discord, Slack and iMessage all crop toward roughly
 * 1.91:1. Handing them a raw sprite export means a thin strip letterboxed in
 * grey, so the card is composed at the size they actually want.
 *
 * There is no text renderer here and no font to embed — the wordmark is the
 * `bigfoot-banner` sprite, which already spells BIGFOOT in pixels. That keeps
 * the card honest: everything on it was drawn with the tool it advertises.
 */

const S = require('../lib/sprite');
const { encodePNG } = require('../lib/png');

const W = 1200, H = 630;
const BG = [0x12, 0x10, 0x0e];   // matches the site's --bg

/** Alpha-aware copy of one RGBA buffer into another. Source alpha is 0 or 255. */
function blit(dst, src, srcW, srcH, x, y) {
  for (let sy = 0; sy < srcH; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= H) continue;
    for (let sx = 0; sx < srcW; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= W) continue;
      const s = (sy * srcW + sx) * 4;
      if (src[s + 3] === 0) continue;          // transparent pixel, leave the backdrop
      const d = (dy * W + dx) * 4;
      dst[d] = src[s]; dst[d + 1] = src[s + 1];
      dst[d + 2] = src[s + 2]; dst[d + 3] = 255;
    }
  }
}

/** Scale that makes a sprite as large as possible within a box, staying integer. */
function fitBox(sprite, boxW, boxH) {
  return Math.max(1, Math.min(Math.floor(boxW / sprite.w), Math.floor(boxH / sprite.h)));
}

/**
 * @param {(name: string) => object|null} load  resolves a sprite by name
 * @param {string[]} available                  every sprite name in the library
 */
function buildCard(load, available) {
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = BG[0]; rgba[i * 4 + 1] = BG[1];
    rgba[i * 4 + 2] = BG[2]; rgba[i * 4 + 3] = 255;
  }

  const has = n => available.includes(n);
  const pick = (...names) => names.find(has) || null;

  // ---- wordmark, upper third -------------------------------------------
  const bannerName = pick('bigfoot-banner', 'bigfoot-badge', 'bigfoot-face');
  if (bannerName) {
    const banner = load(bannerName);
    const scale = fitBox(banner, 1000, 260);
    const { width, height, rgba: px } = S.frameToRGBA(banner, 0, scale);
    blit(rgba, px, width, height, Math.round((W - width) / 2), 70);
  }

  // ---- a strip of scenes along the bottom -------------------------------
  // Scenes read better at card size than icons do; fall back to whatever the
  // library has if the bigfoot set was renamed or removed.
  // Five, not six: at six the cells are narrow enough that a 64×64 scene only
  // reaches 2× and reads as an afterthought under the wordmark. Five lets them
  // hit 3×, which lines the strip up with the banner width.
  const STRIP = 5;
  const wanted = ['bigfoot-campfire', 'bigfoot-forest', 'bigfoot-snow',
                  'bigfoot-moon', 'bigfoot-ufo', 'bigfoot-river'];
  let strip = wanted.filter(has).slice(0, STRIP);
  if (strip.length < STRIP) {
    const extra = available
      .filter(n => !strip.includes(n))
      .map(n => ({ n, s: load(n) }))
      .filter(o => o.s && o.s.w >= 32)            // skip tiny icons
      .sort((a, b) => (b.s.w * b.s.h) - (a.s.w * a.s.h))
      .map(o => o.n);
    strip = strip.concat(extra).slice(0, STRIP);
  }

  if (strip.length) {
    const cell = Math.floor(1120 / strip.length);
    const startX = Math.round((W - cell * strip.length) / 2);
    for (let i = 0; i < strip.length; i++) {
      const sp = load(strip[i]);
      if (!sp) continue;
      const scale = fitBox(sp, cell - 16, 200);
      const { width, height, rgba: px } = S.frameToRGBA(sp, 0, scale);
      blit(rgba, px, width, height,
        startX + i * cell + Math.round((cell - width) / 2),
        372 + Math.round((200 - height) / 2));
    }
  }

  return encodePNG(W, H, rgba);
}

module.exports = { buildCard, CARD_W: W, CARD_H: H };
