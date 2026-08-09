'use strict';
/**
 * Shape primitives over a grid of characters.
 *
 * draw_ascii asks a model to emit N rows of exactly N characters. That is a
 * counting task, and models fail it in a specific way: they default to
 * constant-width rows because those are easiest to count, so freehand art comes
 * out as rounded rectangles. These primitives remove the counting entirely —
 * you name a centre and a radius and get a real curve.
 *
 * Everything works on `grid`, an array of arrays of single characters, where
 * '.' means transparent. The caller maps characters to colours afterwards.
 */

const at = (g, x, y) => (g[y] || [])[x];
const inside = (g, x, y) => y >= 0 && x >= 0 && y < g.length && x < g[0].length;

function blank(w, h) {
  return Array.from({ length: h }, () => Array(w).fill('.'));
}

function ellipse(g, cx, cy, rx, ry, fill) {
  if (rx <= 0 || ry <= 0) throw new Error('ellipse needs rx and ry greater than 0');
  for (let y = 0; y < g.length; y++) {
    const dy = (y - cy) / ry;
    if (Math.abs(dy) > 1) continue;
    const dx = rx * Math.sqrt(1 - dy * dy);
    const a = Math.round(cx - dx), b = Math.round(cx + dx);
    // A 1px cap at the pole reads as a stray pixel rather than as a curve.
    if (b - a < 2) continue;
    for (let x = Math.max(0, a); x <= Math.min(g[0].length - 1, b); x++) g[y][x] = fill;
  }
  return g;
}

function rect(g, x0, y0, x1, y1, fill) {
  const [ax, bx] = x0 <= x1 ? [x0, x1] : [x1, x0];
  const [ay, by] = y0 <= y1 ? [y0, y1] : [y1, y0];
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++)
    if (inside(g, x, y)) g[y][x] = fill;
  return g;
}

/**
 * Thick line. Stamps a disc of diameter `t` along the segment, so ends round
 * off and diagonal runs stay solid instead of breaking into a dotted stair.
 * This is the primitive for limbs, tails, ears, antennae and vines — the parts
 * that fail worst when placed by hand.
 */
function line(g, x0, y0, x1, y1, t, fill) {
  const thick = Math.max(1, t || 1);
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 || 1;
  const r = thick / 2;
  for (let i = 0; i <= steps; i++) {
    const cx = x0 + (x1 - x0) * i / steps, cy = y0 + (y1 - y0) * i / steps;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
        if (inside(g, x, y) && (x - cx) ** 2 + (y - cy) ** 2 <= r * r) g[y][x] = fill;
  }
  return g;
}

function path(g, points, t, fill) {
  if (!Array.isArray(points) || points.length < 2) throw new Error('path needs at least 2 points');
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1], [bx, by] = points[i];
    line(g, ax, ay, bx, by, t, fill);
  }
  return g;
}

/** Stamp rows on top, leaving '.' cells alone. For faces and other detail. */
function rows(g, lines, ox = 0, oy = 0) {
  lines.forEach((row, y) => [...String(row)].forEach((ch, x) => {
    if (ch !== '.' && ch !== ' ' && inside(g, ox + x, oy + y)) g[oy + y][ox + x] = ch;
  }));
  return g;
}

/** Normalise {light,mid,dark} or {tones:[...]} into a lightest-first array. */
function toneList(ramp) {
  if (Array.isArray(ramp)) return ramp;
  if (Array.isArray(ramp.tones)) return ramp.tones;
  return [ramp.light, ramp.mid, ramp.dark].filter(t => t !== undefined);
}

/** Flood-fill the connected regions sharing one fill character. */
function components(grid, fill) {
  const h = grid.length, w = grid[0].length;
  const seen = Array.from({ length: h }, () => Array(w).fill(false));
  const found = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (seen[y][x] || grid[y][x] !== fill) continue;
    const cells = [], stack = [[x, y]];
    seen[y][x] = true;
    while (stack.length) {
      const [cx, cy] = stack.pop();
      cells.push([cx, cy]);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && !seen[ny][nx] && grid[ny][nx] === fill) {
          seen[ny][nx] = true;
          stack.push([nx, ny]);
        }
      }
    }
    found.push(cells);
  }
  return found;
}

/**
 * Shade each filled region as a lit volume.
 *
 * The obvious implementation — walk in from the edge and darken — produces
 * *contour shading*: a uniform light rim hugging the whole silhouette with a
 * flat middle. It reads as a bevelled sticker, not as a form, and it is the
 * single thing that most makes sprite art look amateur.
 *
 * So instead each connected region is treated as a rounded volume: a light
 * centre is placed off toward the light source, and tone is chosen by distance
 * from that centre, normalised against the region's own extent so long limbs
 * shade along their length rather than in rings. The result is a broad lit
 * area, a terminator that curves across the form, and a crescent of shadow on
 * the far side — which is what a lit ball actually looks like.
 *
 * `ramps` maps a fill character to {light, mid, dark} or {tones:[...]},
 * lightest first. mode "rim" restores the flat contour look, which is
 * occasionally the right choice for graphic icons.
 */
function shade(g, ramps, opts = {}) {
  const dir = opts.light || [-1, -1];
  const len = Math.hypot(dir[0], dir[1]) || 1;
  const [lx, ly] = [dir[0] / len, dir[1] / len];

  for (const fill of Object.keys(ramps)) {
    const tones = toneList(ramps[fill]);
    if (!tones.length) continue;

    if (opts.mode === 'rim') {
      const snap = g.map(r => r.slice());
      const isBody = (x, y) => at(snap, x, y) === fill;
      for (let y = 0; y < g.length; y++) for (let x = 0; x < g[0].length; x++) {
        if (snap[y][x] !== fill) continue;
        const lit = !isBody(x + Math.round(lx * 2), y + Math.round(ly * 2));
        const dark = !isBody(x - Math.round(lx * 2), y - Math.round(ly * 2));
        g[y][x] = lit ? tones[0] : dark ? tones[tones.length - 1] : tones[Math.min(1, tones.length - 1)];
      }
      continue;
    }

    for (const cells of components(g, fill)) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [x, y] of cells) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      // Half-extents, floored at 1 so a 1px-wide limb still divides cleanly.
      const hw = Math.max(1, (maxX - minX) / 2), hh = Math.max(1, (maxY - minY) / 2);
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      // Push the light centre most of the way toward the lit edge; the terminator
      // then falls across the body instead of sitting on the outline.
      const push = opts.offset == null ? 0.55 : opts.offset;
      const px = cx + lx * hw * push, py = cy + ly * hh * push;
      // Normalising by the region's own half-extents makes the falloff track the
      // shape: a long tail shades down its length, a ball shades radially.
      const reach = 1 + push;
      for (const [x, y] of cells) {
        const d = Math.hypot((x - px) / hw, (y - py) / hh) / reach;
        const band = Math.min(tones.length - 1, Math.floor(d * tones.length));
        g[y][x] = tones[band];
      }
    }
  }
  return g;
}

/**
 * Trace a 1px border around the union of `fills`.
 *
 * Call it once per part with a dark tint of that part's own hue. One black
 * keyline across every part flattens them together; per-part keylines keep the
 * parts separable, which is most of what separates a sprite from clip art.
 */
function outline(g, fills, lineChar) {
  const set = new Set(fills);
  const snap = g.map(r => r.slice());
  for (let y = 0; y < g.length; y++) for (let x = 0; x < g[0].length; x++) {
    if (!set.has(snap[y][x])) continue;
    const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const v = at(snap, x + dx, y + dy);
      return v === undefined || !set.has(v);
    });
    if (edge) g[y][x] = lineChar;
  }
  return g;
}

/**
 * Absorb single pixels that share no 8-neighbour with their own value.
 * The server's own guidance warns against stray diagonal pixels; nothing
 * enforced it until now. 8-connectivity matters: a diagonal outline run is a
 * legitimate edge, and a 4-connected test eats it.
 */
function despeckle(g) {
  const snap = g.map(r => r.slice());
  const N = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let y = 0; y < g.length; y++) for (let x = 0; x < g[0].length; x++) {
    const me = snap[y][x];
    const nb = N.map(([dx, dy]) => at(snap, x + dx, y + dy)).filter(v => v !== undefined);
    if (nb.some(v => v === me)) continue;
    const tally = {};
    nb.forEach(v => { tally[v] = (tally[v] || 0) + 1; });
    const best = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
    if (best !== undefined) g[y][x] = best;
  }
  return g;
}

/** Mirror the left half onto the right. Most creatures are symmetric front-on. */
function mirror(g, axis) {
  const w = g[0].length;
  const ax = axis == null ? Math.floor(w / 2) : axis;
  for (let y = 0; y < g.length; y++) for (let x = 0; x < ax; x++) {
    const dst = ax * 2 - 1 - x;
    if (inside(g, dst, y)) g[y][dst] = g[y][x];
  }
  return g;
}

/** Run one shape descriptor from a draw_shapes call. */
function apply(g, s) {
  const n = (v, what) => {
    const x = Number(v);
    if (!Number.isFinite(x)) throw new Error(s.type + ' needs a numeric ' + what);
    return Math.round(x);
  };
  switch (s.type) {
    case 'ellipse': return ellipse(g, n(s.cx, 'cx'), n(s.cy, 'cy'), n(s.rx, 'rx'), n(s.ry, 'ry'), s.fill);
    case 'circle':  return ellipse(g, n(s.cx, 'cx'), n(s.cy, 'cy'), n(s.r, 'r'), n(s.r, 'r'), s.fill);
    case 'rect':    return rect(g, n(s.x0, 'x0'), n(s.y0, 'y0'), n(s.x1, 'x1'), n(s.y1, 'y1'), s.fill);
    case 'line':    return line(g, n(s.x0, 'x0'), n(s.y0, 'y0'), n(s.x1, 'x1'), n(s.y1, 'y1'), s.thickness, s.fill);
    case 'path':    return path(g, s.points, s.thickness, s.fill);
    case 'rows':    return rows(g, s.rows || [], Math.round(s.x || 0), Math.round(s.y || 0));
    default: throw new Error('unknown shape type "' + s.type + '". ' +
      'Use ellipse, circle, rect, line, path or rows.');
  }
}

module.exports = { blank, ellipse, rect, line, path, rows, shade, outline, despeckle, mirror, apply };
