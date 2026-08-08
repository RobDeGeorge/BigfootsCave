/* eslint-env browser, node */
/**
 * Tiny animated-GIF encoder for palette-indexed pixel art.
 *
 * Pixel art is already indexed colour, which is exactly what GIF wants — so
 * there's no quantisation step here and the output is byte-exact.
 *
 *   encodeGIF({ width, height, palette: ["#rrggbb", ...], frames: [Int16Array], delayMs, scale })
 *
 * Frame pixels are palette indices; -1 means transparent.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GIF = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

function ByteStream() {
  this.bytes = [];
}
ByteStream.prototype.u8 = function (v) { this.bytes.push(v & 0xff); return this; };
ByteStream.prototype.u16 = function (v) { this.bytes.push(v & 0xff, (v >> 8) & 0xff); return this; };
ByteStream.prototype.str = function (s) { for (let i = 0; i < s.length; i++) this.bytes.push(s.charCodeAt(i)); return this; };
ByteStream.prototype.raw = function (arr) { for (let i = 0; i < arr.length; i++) this.bytes.push(arr[i] & 0xff); return this; };

// ------------------------------------------------------------------ LZW

function lzwEncode(pixels, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let dict = new Map();

  const out = [];
  let bitBuffer = 0, bitCount = 0;
  function emit(code) {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  }

  emit(clearCode);
  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const k = pixels[i];
    const key = prefix * 4096 + k;
    if (dict.has(key)) {
      prefix = dict.get(key);
      continue;
    }
    emit(prefix);
    dict.set(key, nextCode++);
    if (nextCode > (1 << codeSize)) {
      if (codeSize < 12) {
        codeSize++;
      } else {
        emit(clearCode);
        dict = new Map();
        nextCode = eoiCode + 1;
        codeSize = minCodeSize + 1;
      }
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoiCode);
  if (bitCount > 0) out.push(bitBuffer & 0xff);
  return out;
}

function writeSubBlocks(stream, data) {
  for (let i = 0; i < data.length; i += 255) {
    const slice = data.slice(i, i + 255);
    stream.u8(slice.length).raw(slice);
  }
  stream.u8(0);
}

// ------------------------------------------------------------------ encode

function hexToRGB(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function encodeGIF(opts) {
  const scale = Math.max(1, Math.round(opts.scale || 1));
  const srcW = opts.width, srcH = opts.height;
  const W = srcW * scale, H = srcH * scale;
  const palette = opts.palette;
  if (palette.length > 255) throw new Error('GIF export supports at most 255 palette colours (plus transparency)');

  // The transparent slot sits right after the real colours.
  const transparentIndex = palette.length;
  const tableSize = Math.max(2, 1 << Math.ceil(Math.log2(palette.length + 1)));
  const minCodeSize = Math.max(2, Math.log2(tableSize));

  const s = new ByteStream();
  s.str('GIF89a').u16(W).u16(H);
  s.u8(0xf0 | (Math.log2(tableSize) - 1)); // global table present, size
  s.u8(0).u8(0);                            // background index, aspect ratio
  for (let i = 0; i < tableSize; i++) {
    const c = i < palette.length ? hexToRGB(palette[i]) : [0, 0, 0];
    s.u8(c[0]).u8(c[1]).u8(c[2]);
  }

  // Netscape looping extension
  s.u8(0x21).u8(0xff).u8(11).str('NETSCAPE2.0').u8(3).u8(1).u16(opts.loop == null ? 0 : opts.loop).u8(0);

  const delay = Math.max(2, Math.round((opts.delayMs || 125) / 10)); // GIF ticks are 1/100s

  for (const frame of opts.frames) {
    // Graphic control extension: restore-to-background, transparency on.
    s.u8(0x21).u8(0xf9).u8(4).u8(0x09).u16(delay).u8(transparentIndex).u8(0);
    // Image descriptor
    s.u8(0x2c).u16(0).u16(0).u16(W).u16(H).u8(0);

    const indexed = new Uint8Array(W * H);
    for (let y = 0; y < srcH; y++) {
      for (let x = 0; x < srcW; x++) {
        const v = frame[y * srcW + x];
        const idx = v < 0 ? transparentIndex : v;
        for (let sy = 0; sy < scale; sy++) {
          const row = (y * scale + sy) * W + x * scale;
          for (let sx = 0; sx < scale; sx++) indexed[row + sx] = idx;
        }
      }
    }
    s.u8(minCodeSize);
    writeSubBlocks(s, lzwEncode(indexed, minCodeSize));
  }

  s.u8(0x3b); // trailer
  return new Uint8Array(s.bytes);
}

return { encodeGIF };
});
