'use strict';
/**
 * Composes the 1200×630 social preview card from sprites in the library.
 *
 * Link previews on Twitter, Discord, Slack and iMessage all crop toward roughly
 * 1.91:1. Handing them a raw sprite export means a thin strip letterboxed in
 * grey, so the card is composed at the size they actually want.
 *
 * There is no text renderer here and no font to embed, so the card carries no
 * wordmark — the title comes from og:title, which every one of those platforms
 * renders alongside the image anyway. What the card shows is the artwork: one
 * hero piece over a strip of scenes. That keeps it honest (everything on it was
 * drawn with the tool it advertises) and keeps it brand-neutral, so renaming the
 * site never means redrawing a picture of its old name.
 *
 * Sprites are chosen by tag, not by name, so the card follows the library rather
 * than hardcoding whichever art happened to exist when this was written.
 */

const S = require('../lib/sprite');
const { encodePNG } = require('../lib/png');

const W = 1200, H = 630;
const BG = [0x12, 0x10, 0x0e];   // matches the site's --bg

/**
 * Tags kept off the card entirely.
 *
 * `bigfoot` because the site no longer leads with it. `fanart` because this
 * image is embedded in every link preview and crawled by every platform that
 * sees the URL — it is the single most redistributed asset the site has, which
 * makes it the wrong place for art derived from someone else's characters.
 * Those sprites stay in the gallery; they just don't front it.
 */
const EXCLUDE = ['bigfoot', 'fanart'];

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

  // Load every candidate once — the card picks by tag and by area, and both
  // need the sprite itself, not just its name.
  const all = available
    .map(n => ({ n, s: load(n) }))
    // A 16×16 icon is not too small for this card — a strip cell upscales it 12×,
    // to the same 192px a 32×32 piece reaches. Only genuinely sub-icon art is cut.
    .filter(o => o.s && o.s.w >= 16)
    .filter(o => !EXCLUDE.some(t => (o.s.tags || []).includes(t)))
    .sort((a, b) => (b.s.w * b.s.h) - (a.s.w * a.s.h));

  const tagged = tag => all.filter(o => (o.s.tags || []).includes(tag));

  /**
   * Best `n` by tag preference, largest first, never repeating a pick.
   * `where` rejects candidates that cannot be laid out in the slot they're for.
   */
  const taken = new Set();
  function choose(n, tags, where) {
    const ok = where || (() => true);
    const out = [];
    for (const tag of tags.concat([null])) {       // null = "anything left"
      const pool = (tag === null ? all : tagged(tag)).filter(ok);
      for (const o of pool) {
        if (out.length >= n) return out;
        if (taken.has(o.n)) continue;
        taken.add(o.n);
        out.push(o);
      }
    }
    return out;
  }

  /**
   * Slots are fixed boxes and fitBox floors at 1×, so a sprite bigger than its
   * box cannot be shrunk to fit — it draws at full size and spills over its
   * neighbours. The library's UI bars (392×48) are exactly that shape. Candidates
   * are therefore filtered on whether they fit, rather than clipped afterwards;
   * the aspect cap additionally keeps long thin bars out of square-ish cells.
   */
  const fitsBox = (boxW, boxH, maxAspect) => o =>
    o.s.w <= boxW && o.s.h <= boxH && o.s.w / o.s.h <= maxAspect;

  // ---- hero, upper third -------------------------------------------------
  const HERO_W = 1000, HERO_H = 300;
  const [hero] = choose(1, ['retro', 'scene', 'character', 'portrait'],
    fitsBox(HERO_W, HERO_H, 3));
  if (hero) {
    const scale = fitBox(hero.s, HERO_W, HERO_H);
    const { width, height, rgba: px } = S.frameToRGBA(hero.s, 0, scale);
    blit(rgba, px, width, height, Math.round((W - width) / 2),
      50 + Math.round((HERO_H - height) / 2));
  }

  // ---- a strip of scenes along the bottom -------------------------------
  // Scenes read better at card size than icons do.
  // Five, not six: at six the cells are narrow enough that a 64×64 scene only
  // reaches 2× and reads as an afterthought under the hero. Five lets them hit
  // 3×, which lines the strip up with the hero above it.
  const STRIP = 5;
  const CELL_W = Math.floor(1120 / STRIP) - 16, CELL_H = 200;
  // `gameboy` sits second because those icons share the hardware's palette, so
  // the strip reads as one set rather than as assorted art in five styles.
  const strip = choose(STRIP, ['retro', 'gameboy', 'scene', 'character', 'ui', 'anim'],
    fitsBox(CELL_W, CELL_H, 2)).map(o => o.n);

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
