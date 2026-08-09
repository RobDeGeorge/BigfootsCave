'use strict';
/**
 * Minimal PNG encoder and decoder (RGBA, no interlace). Node only — uses zlib.
 *
 * The decoder exists so an agent can load a reference image. A browser gets
 * this for free from canvas; Node does not, and the alternative was a
 * dependency, which this project does not have and does not want.
 */

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba  width*height*4 bytes
 * @returns {Buffer} PNG file contents
 */
function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const dst = y * (1 + width * 4);
    raw[dst] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, dst + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ decoding

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Undo the per-scanline filter PNG applies before compression. */
function unfilter(raw, width, height, bpp, stride) {
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = y * stride, prev = line - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[pos + i];
      const a = i >= bpp ? out[line + i - bpp] : 0;
      const b = y > 0 ? out[prev + i] : 0;
      const c = (y > 0 && i >= bpp) ? out[prev + i - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error('unsupported PNG row filter ' + filter);
      }
      out[line + i] = v & 0xff;
    }
    pos += stride;
  }
  return out;
}

/**
 * Decode a PNG buffer to { width, height, rgba }.
 *
 * Deliberately narrow: 8- and 16-bit non-interlaced images, plus the sub-byte
 * bit depths that indexed PNGs commonly use. Anything else is rejected with a
 * message saying so rather than decoded wrongly and silently.
 */
function decodePNG(buf, opts = {}) {
  const maxPixels = opts.maxPixels || 64 * 1024 * 1024;
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) {
    throw new Error('not a PNG file (bad signature). Convert the image to PNG first.');
  }

  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];

  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (p + 12 + len > buf.length) throw new Error('truncated PNG chunk "' + type + '"');
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    p += 12 + len;
  }

  if (!width || !height) throw new Error('PNG has no IHDR');
  if (width * height > maxPixels) throw new Error('PNG is too large: ' + width + '×' + height);
  if (interlace) throw new Error('interlaced (Adam7) PNGs are not supported; re-save without interlacing');
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error('unsupported PNG colour type ' + colorType);
  if (![1, 2, 4, 8, 16].includes(bitDepth)) throw new Error('unsupported PNG bit depth ' + bitDepth);
  if (bitDepth < 8 && colorType !== 3 && colorType !== 0) {
    throw new Error('bit depth ' + bitDepth + ' is only valid for greyscale and indexed PNGs');
  }
  if (colorType === 3 && !palette) throw new Error('indexed PNG has no PLTE chunk');
  if (!idat.length) throw new Error('PNG has no image data');

  const bitsPerPixel = channels * bitDepth;
  const stride = Math.ceil(width * bitsPerPixel / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) throw new Error('PNG image data is truncated');
  const px = unfilter(raw, width, height, bpp, stride);

  // Read one sample, normalising every supported bit depth to 0..255.
  const sample = (line, i) => {
    if (bitDepth === 16) return px[line + i * 2];          // high byte is enough
    if (bitDepth === 8) return px[line + i];
    const perByte = 8 / bitDepth;                           // 1, 2 or 4 bits
    const byte = px[line + Math.floor(i / perByte)];
    const shift = (perByte - 1 - (i % perByte)) * bitDepth;
    return (byte >> shift) & ((1 << bitDepth) - 1);
  };
  const scale = bitDepth < 8 ? 255 / ((1 << bitDepth) - 1) : 1;

  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const line = y * stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      if (colorType === 3) {
        const idx = sample(line, s);
        rgba[o] = palette[idx * 3]; rgba[o + 1] = palette[idx * 3 + 1]; rgba[o + 2] = palette[idx * 3 + 2];
        rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (colorType === 0 || colorType === 4) {
        const g = Math.round(sample(line, s) * scale);
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
        rgba[o + 3] = colorType === 4 ? Math.round(sample(line, s + 1) * scale) : 255;
      } else {
        rgba[o] = Math.round(sample(line, s) * scale);
        rgba[o + 1] = Math.round(sample(line, s + 1) * scale);
        rgba[o + 2] = Math.round(sample(line, s + 2) * scale);
        rgba[o + 3] = colorType === 6 ? Math.round(sample(line, s + 3) * scale) : 255;
      }
    }
  }
  return { width, height, rgba };
}

module.exports = { encodePNG, decodePNG };
