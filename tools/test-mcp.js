#!/usr/bin/env node
'use strict';
/**
 * Test suite for the MCP server.
 *
 * Drives the real server over its real transport — spawned as a subprocess,
 * newline-delimited JSON-RPC over stdio — rather than importing the handlers.
 * That way the tool schemas, the dispatch layer and the error envelope are all
 * under test, not just the internals.
 *
 * Runs against a throwaway library in a temp directory, so it never touches
 * real art.
 *
 *   node tools/test-mcp.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../lib/sprite');

const SERVER = path.join(__dirname, '..', 'mcp', 'server.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelart-test-'));
const LIB = path.join(TMP, 'library');
const EXP = path.join(TMP, 'exports');

let proc, nextId = 1;
const pending = new Map();
let buffer = '';

function start() {
  proc = spawn('node', [SERVER], {
    env: { ...process.env, PIXELART_LIBRARY: LIB, PIXELART_EXPORTS: EXP },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  proc.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(d); });
}

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout: ' + method)); } }, 10000);
  });
}

/** Call a tool. Returns {text, isError, content}. */
async function call(tool, args) {
  const msg = await rpc('tools/call', { name: tool, arguments: args || {} });
  if (msg.error) return { text: msg.error.message, isError: true, content: [] };
  const content = msg.result.content || [];
  return {
    text: content.filter(c => c.type === 'text').map(c => c.text).join('\n'),
    isError: !!msg.result.isError,
    content,
  };
}

/** Read a sprite straight off disk, to check what the tool actually wrote. */
function onDisk(name) {
  return JSON.parse(fs.readFileSync(path.join(LIB, name + '.json'), 'utf8'));
}

// ------------------------------------------------------------------ harness

let passed = 0, failed = 0, group = '';
const failures = [];

function section(title) { group = title; console.log('\n' + title); }

function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else {
    failed++;
    failures.push(group + ' :: ' + label + (detail ? '\n      ' + detail : ''));
    console.log('  ✗ ' + label + (detail ? '\n      ' + detail : ''));
  }
}

/** Every mutation must leave a sprite the rest of the toolchain can still load. */
function invariants(name, label) {
  let sp;
  try { sp = onDisk(name); } catch (e) { return ok(false, label + ' — readable on disk', e.message); }
  try { S.validate(sp); } catch (e) { return ok(false, label + ' — passes validate()', e.message); }
  if (!sp.frames.length) return ok(false, label + ' — has >= 1 frame');
  if (sp.frames.some(f => !f.layers.length)) return ok(false, label + ' — every frame has >= 1 layer');
  const counts = [...new Set(sp.frames.map(f => f.layers.length))];
  if (counts.length !== 1) return ok(false, label + ' — layer count equal across frames', 'counts: ' + counts.join(','));
  ok(true, label + ' — invariants hold');
}

// -------------------------------------------------------------------- tests

async function main() {
  start();

  // ---------------------------------------------------------------- protocol
  section('protocol');
  const init = await rpc('initialize', { protocolVersion: '2024-11-05' });
  ok(init.result && init.result.serverInfo.name === 'pixelart', 'initialize returns serverInfo');
  ok(init.result && /preview_sprite/.test(init.result.instructions || ''), 'initialize returns usage instructions');

  const list = await rpc('tools/list');
  const tools = list.result.tools;
  ok(Array.isArray(tools) && tools.length === 23, 'tools/list advertises 23 tools', 'got ' + (tools || []).length);
  ok(tools.every(t => t.name && t.description && t.inputSchema), 'every tool has name, description, schema');
  const missing = ['draw_ascii', 'draw_shapes', 'preview_sprite', 'preview_sprites', 'transform', 'import_reference', 'compare_reference']
    .filter(n => !tools.some(t => t.name === n));
  ok(!missing.length, 'the drawing and review tools are all advertised', 'missing ' + missing.join(','));
  const dupes = tools.map(t => t.name).filter((n, i, a) => a.indexOf(n) !== i);
  ok(!dupes.length, 'no duplicate tool names', dupes.join(','));

  const bogus = await rpc('tools/call', { name: 'no_such_tool', arguments: {} });
  ok(!!bogus.error, 'unknown tool returns a JSON-RPC error');

  const pong = await rpc('ping');
  ok(!!pong.result, 'ping responds');

  // ------------------------------------------------------- overwrite guard
  section('create_sprite overwrite guard');
  let r = await call('create_sprite', { name: 'guard', width: 4, height: 4, palette: ['#ff0000', '#00ff00'] });
  ok(!r.isError, 'creates a new sprite');
  await call('draw_ascii', { name: 'guard', key: { a: 0 }, rows: ['aaaa', 'aaaa', 'aaaa', 'aaaa'] });

  r = await call('create_sprite', { name: 'guard', width: 8, height: 8 });
  ok(r.isError && /already exists/.test(r.text), 'refuses to clobber an existing name');
  ok(onDisk('guard').w === 4, 'blocked create left the original art untouched');

  r = await call('create_sprite', { name: 'guard', width: 8, height: 8, overwrite: true });
  ok(!r.isError && onDisk('guard').w === 8, 'overwrite: true replaces it');

  // -------------------------------------------------------------- set_meta
  section('set_meta');
  await call('create_sprite', { name: 'meta-test', width: 4, height: 4, tags: ['old'] });

  r = await call('set_meta', { name: 'meta-test', tags: ['ui', 'button'] });
  ok(!r.isError && onDisk('meta-test').tags.join(',') === 'ui,button', 'sets tags');

  r = await call('set_meta', { name: 'meta-test', fps: 24 });
  ok(!r.isError && onDisk('meta-test').fps === 24, 'sets fps');

  r = await call('set_meta', { name: 'meta-test', fps: 999 });
  ok(r.isError && /1 to 60/.test(r.text), 'rejects out-of-range fps');
  ok(onDisk('meta-test').fps === 24, 'rejected fps left the old value');

  r = await call('set_meta', { name: 'meta-test', tags: 'notanarray' });
  ok(r.isError && /array/.test(r.text), 'rejects non-array tags');

  r = await call('set_meta', { name: 'meta-test' });
  ok(r.isError && /nothing to change/.test(r.text), 'rejects a no-op call');

  // rename
  await call('draw_ascii', { name: 'meta-test', key: { a: 0 }, rows: ['aaaa', 'aaaa', 'aaaa', 'aaaa'] });
  const beforeRename = onDisk('meta-test').frames[0].layers[0].data;
  r = await call('set_meta', { name: 'meta-test', newName: 'meta-renamed' });
  ok(!r.isError, 'renames a sprite');
  ok(!fs.existsSync(path.join(LIB, 'meta-test.json')), 'old file is gone after rename');
  ok(fs.existsSync(path.join(LIB, 'meta-renamed.json')), 'new file exists after rename');
  ok(onDisk('meta-renamed').name === 'meta-renamed', 'internal name field updated');
  ok(onDisk('meta-renamed').frames[0].layers[0].data === beforeRename, 'rename preserved the art');

  await call('create_sprite', { name: 'occupied', width: 4, height: 4 });
  r = await call('set_meta', { name: 'meta-renamed', newName: 'occupied' });
  ok(r.isError && /already exists/.test(r.text), 'rename onto an existing name is refused');
  ok(fs.existsSync(path.join(LIB, 'meta-renamed.json')), 'refused rename left the source intact');
  invariants('meta-renamed', 'after set_meta');

  // ---------------------------------------------------------- delete_frame
  section('delete_frame');
  await call('create_sprite', { name: 'frames', width: 4, height: 4 });
  await call('add_frame', { name: 'frames' });
  await call('add_frame', { name: 'frames' });
  ok(onDisk('frames').frames.length === 3, 'set up 3 frames');

  r = await call('delete_frame', { name: 'frames', frame: 1 });
  ok(!r.isError && onDisk('frames').frames.length === 2, 'removes a frame');

  r = await call('delete_frame', { name: 'frames', frame: 99 });
  ok(r.isError, 'rejects an out-of-range frame index');

  await call('delete_frame', { name: 'frames', frame: 0 });
  r = await call('delete_frame', { name: 'frames', frame: 0 });
  ok(r.isError && /at least one/.test(r.text), 'refuses to delete the last frame');
  invariants('frames', 'after delete_frame');

  // ---------------------------------------------------------- delete_layer
  section('delete_layer');
  await call('create_sprite', { name: 'layers', width: 4, height: 4 });
  await call('add_frame', { name: 'layers' });
  await call('add_layer', { name: 'layers', layerName: 'shading' });
  let sp = onDisk('layers');
  ok(sp.frames.every(f => f.layers.length === 2), 'add_layer applied to every frame');

  r = await call('delete_layer', { name: 'layers', layer: 1 });
  sp = onDisk('layers');
  ok(!r.isError && sp.frames.every(f => f.layers.length === 1), 'removes the layer from every frame');

  r = await call('delete_layer', { name: 'layers', layer: 0 });
  ok(r.isError && /at least one/.test(r.text), 'refuses to delete the last layer');
  invariants('layers', 'after delete_layer');

  // ------------------------------------------------------------ move_layer
  section('move_layer');
  await call('create_sprite', { name: 'order', width: 4, height: 4 });
  await call('add_frame', { name: 'order' });
  await call('add_layer', { name: 'order', layerName: 'mid' });
  await call('add_layer', { name: 'order', layerName: 'top' });
  const names = () => onDisk('order').frames.map(f => f.layers.map(l => l.name).join('>'));

  r = await call('move_layer', { name: 'order', layer: 2, to: 0 });
  ok(!r.isError && names().every(n => n.startsWith('top')), 'moves a layer to the bottom');
  ok(new Set(names()).size === 1, 'reorder applied identically to every frame');

  r = await call('move_layer', { name: 'order', layer: 1, to: 1 });
  ok(!r.isError && /already at that index/.test(r.text), 'moving to the same index is a no-op');

  r = await call('move_layer', { name: 'order', layer: 0, to: 99 });
  ok(r.isError, 'rejects an out-of-range target');
  invariants('order', 'after move_layer');

  // ------------------------------------------------------------- set_layer
  section('set_layer');
  await call('create_sprite', { name: 'vis', width: 4, height: 4, palette: ['#ff0000', '#00ff00'] });
  await call('add_layer', { name: 'vis', layerName: 'over' });
  await call('draw_ascii', { name: 'vis', layer: 0, key: { a: 0 }, rows: ['aaaa', 'aaaa', 'aaaa', 'aaaa'] });
  await call('draw_ascii', { name: 'vis', layer: 1, key: { b: 1 }, rows: ['bbbb', 'bbbb', 'bbbb', 'bbbb'] });

  r = await call('get_sprite', { name: 'vis' });
  ok(/1111/.test(r.text), 'flattened view shows the top layer');

  r = await call('set_layer', { name: 'vis', layer: 1, visible: false });
  ok(!r.isError && onDisk('vis').frames[0].layers[1].visible === false, 'hides a layer');
  r = await call('get_sprite', { name: 'vis' });
  ok(/0000/.test(r.text) && !/1111/.test(r.text), 'hidden layer is excluded from the flattened view');

  r = await call('set_layer', { name: 'vis', layer: 1, opacity: 5 });
  ok(r.isError && /0 to 1/.test(r.text), 'rejects out-of-range opacity');

  // "false" is truthy; coercing it would reveal a layer the caller meant to hide.
  r = await call('set_layer', { name: 'vis', layer: 1, visible: 'false' });
  ok(r.isError && /true or false/.test(r.text), 'rejects a non-boolean visible');
  ok(onDisk('vis').frames[0].layers[1].visible === false, 'layer stayed hidden after the rejection');

  r = await call('set_layer', { name: 'vis', layer: 0, layerName: 'base' });
  ok(!r.isError && onDisk('vis').frames[0].layers[0].name === 'base', 'renames a layer');

  r = await call('set_layer', { name: 'vis', layer: 0 });
  ok(r.isError && /nothing to change/.test(r.text), 'rejects a no-op call');
  invariants('vis', 'after set_layer');

  // ----------------------------------------------------------- merge_layer
  section('merge_layer');
  await call('create_sprite', { name: 'merge', width: 4, height: 4, palette: ['#ff0000', '#00ff00'] });
  await call('add_layer', { name: 'merge', layerName: 'top' });
  await call('draw_ascii', { name: 'merge', layer: 0, key: { a: 0 }, rows: ['aaaa', 'aaaa', 'aaaa', 'aaaa'] });
  await call('draw_ascii', { name: 'merge', layer: 1, key: { b: 1 }, rows: ['b...', '....', '....', '....'] });

  r = await call('merge_layer', { name: 'merge', layer: 1 });
  ok(!r.isError && onDisk('merge').frames[0].layers.length === 1, 'merging drops the upper layer');
  r = await call('get_sprite', { name: 'merge', layer: 0 });
  ok(/1000/.test(r.text), 'upper layer pixel won');
  ok(/0000/.test(r.text), 'lower layer pixels survived where the upper was transparent');

  r = await call('merge_layer', { name: 'merge', layer: 0 });
  ok(r.isError && /nothing beneath/.test(r.text), 'refuses to merge layer 0');

  // Merging a hidden layer reveals its pixels irreversibly, so it is refused
  // rather than warned about — a warning arrives after the art has changed.
  await call('create_sprite', { name: 'merge-hidden', width: 4, height: 4, palette: ['#ff0000', '#00ff00'] });
  await call('add_layer', { name: 'merge-hidden' });
  await call('set_layer', { name: 'merge-hidden', layer: 1, visible: false });
  const hiddenBefore = onDisk('merge-hidden').frames[0].layers.length;
  r = await call('merge_layer', { name: 'merge-hidden', layer: 1 });
  ok(r.isError && /hidden/.test(r.text), 'refuses to merge a hidden layer');
  ok(onDisk('merge-hidden').frames[0].layers.length === hiddenBefore, 'refused merge changed nothing');
  await call('set_layer', { name: 'merge-hidden', layer: 1, visible: true });
  r = await call('merge_layer', { name: 'merge-hidden', layer: 1 });
  ok(!r.isError, 'merging succeeds once the layer is made visible');
  invariants('merge', 'after merge_layer');

  // multi-frame merge
  await call('create_sprite', { name: 'merge-multi', width: 4, height: 4 });
  await call('add_frame', { name: 'merge-multi' });
  await call('add_layer', { name: 'merge-multi' });
  await call('merge_layer', { name: 'merge-multi', layer: 1 });
  ok(onDisk('merge-multi').frames.every(f => f.layers.length === 1), 'merge applied to every frame');
  invariants('merge-multi', 'after multi-frame merge');

  // ---------------------------------------------------- security regression
  section('security regressions');
  await call('create_sprite', { name: 'sec', width: 4, height: 4 });
  const outside = path.join(TMP, 'ESCAPED.png');
  r = await call('export_sprite', { name: 'sec', format: 'png', outPath: outside });
  ok(r.isError && /exports directory/.test(r.text), 'export_sprite rejects an outPath outside exports/');
  ok(!fs.existsSync(outside), 'no file was written outside exports/');

  r = await call('export_sprite', { name: 'sec', format: 'png', outPath: path.join(EXP, '..', 'escape.png') });
  ok(r.isError, 'export_sprite rejects traversal via ..');

  // A hostile internal name must not steer the default export path.
  const hostile = onDisk('sec');
  hostile.name = '../../../../ESCAPED';
  fs.writeFileSync(path.join(LIB, 'sec.json'), JSON.stringify(hostile));
  r = await call('export_sprite', { name: 'sec', format: 'png' });
  ok(!r.isError, 'export still succeeds with a hostile internal name');
  ok(!fs.existsSync(path.join(TMP, 'ESCAPED.png')) && !fs.existsSync('/ESCAPED.png'),
    'hostile internal name did not escape exports/');
  // load() now normalises the internal name to the filename, so the forged name
  // is gone before it can reach a path at all. safeExportPath still confines the
  // result — two independent barriers, either of which would be sufficient.
  ok(fs.existsSync(path.join(EXP, 'sec.png')),
    'export used the filename identity, not the forged internal name');
  ok(!fs.readdirSync(EXP).some(f => /escaped/i.test(f)),
    'the forged name did not survive into a filename at all');

  r = await call('export_sprite', { name: 'sec', format: 'png', outPath: path.join(EXP, 'fine.png') });
  ok(!r.isError && fs.existsSync(path.join(EXP, 'fine.png')), 'a legitimate outPath inside exports/ still works');

  // ------------------------------------- filename is the sprite's identity
  // A file whose internal `name` disagrees with its filename used to make every
  // mutation write to whatever sprite that name pointed at — clobbering an
  // innocent bystander while the intended edit silently went nowhere.
  section('filename/internal-name mismatch');
  await call('create_sprite', { name: 'target', width: 4, height: 4, palette: ['#111111'] });
  await call('create_sprite', { name: 'innocent', width: 8, height: 8, palette: ['#222222'] });
  const innocentBefore = fs.readFileSync(path.join(LIB, 'innocent.json'), 'utf8');

  const forged = onDisk('target');
  forged.name = 'innocent';
  fs.writeFileSync(path.join(LIB, 'target.json'), JSON.stringify(forged));

  r = await call('set_meta', { name: 'target', tags: ['landed'] });
  ok(!r.isError, 'set_meta succeeds on a mismatched file');
  ok(fs.readFileSync(path.join(LIB, 'innocent.json'), 'utf8') === innocentBefore,
    'set_meta did not clobber the unrelated sprite');
  ok(onDisk('target').tags.join(',') === 'landed', 'the change landed on the intended sprite');
  ok(onDisk('target').name === 'target', 'internal name is normalised to the filename');

  const forged2 = onDisk('target');
  forged2.name = 'innocent';
  fs.writeFileSync(path.join(LIB, 'target.json'), JSON.stringify(forged2));
  await call('draw_ascii', { name: 'target', key: { a: 0 }, rows: ['aaaa', 'aaaa', 'aaaa', 'aaaa'] });
  ok(fs.readFileSync(path.join(LIB, 'innocent.json'), 'utf8') === innocentBefore,
    'draw_ascii did not clobber the unrelated sprite either');

  // The HTTP routes are the other way a mismatched file gets minted, so check
  // they store the slugified name rather than whatever the body claimed.
  const httpPort = 8796;
  const httpSrv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(httpPort), PIXELART_LIBRARY: LIB }, stdio: 'ignore',
  });
  await new Promise(res => setTimeout(res, 1200));
  const body = {
    format: 'pixelart/1', name: 'Mismatched Name!', w: 4, h: 4, fps: 8,
    palette: ['#111111'],
    frames: [{ layers: [{ name: 'L', visible: true, opacity: 1, data: '16.-1' }] }], tags: [],
  };
  const post = await fetch('http://localhost:' + httpPort + '/api/sprites', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(x => x.json()).catch(e => ({ error: e.message }));
  const stored = await fetch('http://localhost:' + httpPort + '/api/sprites/' + post.name)
    .then(x => x.json()).catch(() => ({}));
  ok(post.name === 'mismatched-name', 'POST slugifies the filename');
  ok(stored.name === 'mismatched-name', 'POST stores the slugified name internally too');

  const put = await fetch('http://localhost:' + httpPort + '/api/sprites/mismatched-name', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, name: 'SOMETHING-ELSE' }),
  }).then(x => x.json()).catch(e => ({ error: e.message }));
  const afterPut = await fetch('http://localhost:' + httpPort + '/api/sprites/mismatched-name')
    .then(x => x.json()).catch(() => ({}));
  ok(!put.error, 'PUT succeeds');
  ok(afterPut.name === 'mismatched-name', 'PUT ignores a body name that disagrees with the URL');
  httpSrv.kill();

  // ------------------------------------------------------------- rendering
  section('rendering');
  await call('create_sprite', { name: 'big', width: 512, height: 512 });
  r = await call('preview_sprite', { name: 'big', scale: 32 });
  const img = r.content.find(c => c.type === 'image');
  ok(!!img, 'preview_sprite returns an image');
  if (img) {
    const buf = Buffer.from(img.data, 'base64');
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    ok(w * h <= 4096 * 4096, 'oversized preview is clamped', w + 'x' + h);
  }

  await call('create_sprite', { name: 'small', width: 8, height: 8, palette: ['#112233'] });
  r = await call('preview_sprite', { name: 'small', scale: 8 });
  const img2 = r.content.find(c => c.type === 'image');
  ok(img2 && Buffer.from(img2.data, 'base64').readUInt32BE(16) === 64, 'normal preview scales exactly');

  section('png decoding');
  {
    const { encodePNG, decodePNG } = require('../lib/png');
    const w = 7, h = 5, src = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      src[i * 4] = (i * 9) & 255; src[i * 4 + 1] = 255 - ((i * 7) & 255);
      src[i * 4 + 2] = (i * 31) & 255; src[i * 4 + 3] = i % 3 === 0 ? 0 : 255;
    }
    const back = decodePNG(encodePNG(w, h, src));
    let diff = 0;
    for (let i = 0; i < src.length; i++) if (src[i] !== back.rgba[i]) diff++;
    ok(back.width === w && back.height === h, 'decodePNG recovers the dimensions');
    ok(diff === 0, 'decodePNG round-trips every byte', diff + ' bytes differ');
    let threw = '';
    try { decodePNG(Buffer.from('<!DOCTYPE html>')); } catch (e) { threw = e.message; }
    ok(/not a PNG/.test(threw), 'a non-PNG is rejected by signature', threw);
    // an HTML error page saved as .png is the realistic failure, not a corrupt PNG
    threw = '';
    try { decodePNG(Buffer.alloc(4)); } catch (e) { threw = e.message; }
    ok(!!threw, 'a truncated buffer is rejected rather than read out of bounds', threw);
  }

  section('reference resampling');
  {
    const R = require('../lib/reference');
    // half-transparent black beside opaque white: alpha weighting must stop the
    // transparent side dragging the average toward black
    const w = 4, h = 1, src = new Uint8Array(w * h * 4);
    for (let i = 0; i < 4; i++) {
      const opaque = i >= 2;
      src[i * 4] = src[i * 4 + 1] = src[i * 4 + 2] = opaque ? 255 : 0;
      src[i * 4 + 3] = opaque ? 255 : 0;
    }
    const small = R.resample(src, w, h, 1, 1);
    ok(small[0] === 255, 'resample weights colour by alpha (no dark halo)', 'got ' + small[0]);
    ok(small[3] > 100 && small[3] < 160, 'resample averages alpha', 'got ' + small[3]);

    const grad = new Uint8Array(64 * 4);
    for (let i = 0; i < 64; i++) {
      grad[i * 4] = i * 4; grad[i * 4 + 1] = 255 - i * 4; grad[i * 4 + 2] = 128; grad[i * 4 + 3] = 255;
    }
    const q = R.quantise(grad, 8, 8, 4);
    ok(q.palette.length === 4, 'quantise returns the requested colour count', 'got ' + q.palette.length);
    ok(q.palette.every(c => /^#[0-9a-f]{6}$/.test(c)), 'palette entries are hex colours', q.palette.join(' '));
    ok(q.indices.length === 64 && q.indices.every(i => i >= 0 && i < 4), 'every pixel maps to a palette slot');
    const ramp = R.byLuminance(q.palette);
    ok(ramp.length === 4 && ramp[0] !== ramp[3], 'byLuminance orders the ramp');
    // trim/fitInto: comparing a margin-heavy reference against a sprite that
    // fills its canvas compares framing, not shape, unless both are trimmed.
    const box = new Uint8Array(8 * 8 * 4);
    for (let y = 1; y < 4; y++) for (let x = 5; x < 7; x++) {
      const i = (y * 8 + x) * 4; box[i] = 200; box[i + 3] = 255;
    }
    const t = R.trim(box, 8, 8);
    ok(t.width === 2 && t.height === 3, 'trim crops to the opaque bounding box',
      t.width + '×' + t.height);
    ok(t.rgba[3] === 255, 'the trimmed buffer starts at the subject');
    const none = R.trim(new Uint8Array(8 * 8 * 4), 8, 8);
    ok(none.width === 8 && none.height === 8, 'trimming a blank image returns it unchanged');
    const fitted = R.fitInto(t.rgba, t.width, t.height, 8, 8);
    let opaque = 0;
    for (let i = 0; i < 64; i++) if (fitted[i * 4 + 3] > 0) opaque++;
    ok(opaque > 0 && opaque < 64, 'fitInto scales the subject into the box with margin',
      opaque + ' of 64 pixels opaque');

    const empty = R.quantise(new Uint8Array(16), 2, 2, 4);
    ok(empty.palette.length === 0 && empty.indices.every(i => i === -1),
      'a fully transparent image quantises to nothing rather than throwing');
  }

  section('import_reference');
  {
    const { encodePNG } = require('../lib/png');
    const w = 64, h = 64, img = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, inCircle = (x - 32) ** 2 + (y - 32) ** 2 < 24 * 24;
      // Shaded, not flat: a flat subject legitimately quantises to one colour,
      // which would not exercise the split at all.
      img[i] = inCircle ? 120 + y * 2 : 30;
      img[i + 1] = inCircle ? 40 + x : 30;
      img[i + 2] = 60;
      img[i + 3] = inCircle ? 255 : 0;
    }
    const refPath = path.join(TMP, 'ref.png');
    fs.writeFileSync(refPath, encodePNG(w, h, img));

    r = await call('import_reference', { path: refPath, width: 16, height: 16, colors: 4 });
    ok(!r.isError && r.content.some(c => c.type === 'image'), 'import_reference returns a preview image', r.text);
    ok(/16×16/.test(r.text) && /Sampled palette/.test(r.text), 'it reports the size and sampled palette', r.text);
    ok(/#[0-9a-f]{6}/.test(r.text), 'the sampled palette contains real colours', r.text);

    await call('create_sprite', { name: 'traced', width: 16, height: 16 });
    r = await call('import_reference', { path: refPath, into: 'traced' });
    ok(!r.isError && /Written into/.test(r.text), 'it can write into a sprite for tracing', r.text);
    invariants('traced', 'import_reference into');
    const traced = onDisk('traced');
    ok(traced.palette.length > 1, 'the sprite palette was replaced with sampled colours',
      traced.palette.join(' '));
    const tpx = S.decodeRLE(traced.frames[0].layers[0].data, 16 * 16);
    ok(tpx.some(v => v >= 0) && tpx.some(v => v < 0),
      'the traced layer has both drawn and transparent pixels');

    r = await call('import_reference', { path: refPath, into: 'traced', width: 32, height: 32 });
    ok(r.isError && /32×32/.test(r.text), 'a size mismatch against the target sprite is explained', r.text);

    r = await call('import_reference', { path: path.join(TMP, 'nope.png') });
    ok(r.isError && /cannot read/.test(r.text), 'a missing reference file is reported', r.text);

    section('compare_reference');
    r = await call('compare_reference', { name: 'traced', path: refPath, scale: 3 });
    ok(!r.isError && r.content.some(c => c.type === 'image'), 'compare_reference returns a panel', r.text);
    ok(/silhouette/.test(r.text), 'the panel explains what to look at first', r.text);
    r = await call('compare_reference', { name: 'no-such-sprite', path: refPath });
    ok(r.isError, 'comparing a missing sprite is an error');
  }

  section('draw_shapes');
  await call('create_sprite', { name: 'blob', width: 32, height: 32, palette: ['#000000'] });
  r = await call('draw_shapes', {
    name: 'blob',
    shapes: [
      { type: 'ellipse', cx: 16, cy: 18, rx: 11, ry: 9, fill: 'B' },
      { type: 'line', x0: 9, y0: 10, x1: 4, y1: 2, thickness: 4, fill: 'B' },
    ],
    mirror: true,
    shade: { B: { light: '1', mid: '2', dark: '3' } },
    outline: [{ fills: ['1', '2', '3'], with: '4' }],
    key: { 1: '#ffd98a', 2: '#f0a83c', 3: '#b06a18', 4: '#4a2808' },
  });
  ok(!r.isError, 'draw_shapes composites, shades and outlines', r.text);
  invariants('blob', 'draw_shapes');
  let blob = onDisk('blob');
  let used = new Set(S.decodeRLE(blob.frames[0].layers[0].data, 32 * 32));
  ok(used.size >= 4, 'shading produced more than one tone', 'tones: ' + used.size);

  // The whole point of ellipse(): row widths must actually vary, or the caller
  // has just drawn a rectangle again.
  const px = S.decodeRLE(blob.frames[0].layers[0].data, 32 * 32);
  const widths = new Set();
  for (let y = 0; y < 32; y++) {
    let n = 0;
    for (let x = 0; x < 32; x++) if (px[y * 32 + x] >= 0) n++;
    if (n) widths.add(n);
  }
  ok(widths.size > 4, 'ellipse yields varying row widths, not a rectangle', 'distinct widths: ' + widths.size);

  // The ear was drawn only on the left, so mirror must have reproduced its
  // shape on the right. Compare the silhouette, not the colours: shading runs
  // after mirroring and its light comes from one corner, so the two halves are
  // meant to differ in tone.
  let asymmetric = 0;
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 16; x++)
      if ((px[y * 32 + x] >= 0) !== (px[y * 32 + (31 - x)] >= 0)) asymmetric++;
  ok(asymmetric === 0, 'mirror made the silhouette symmetric', asymmetric + ' mismatched pixels');

  r = await call('draw_shapes', {
    name: 'blob',
    shapes: [{ type: 'ellipse', cx: 16, cy: 16, rx: 8, ry: 8, fill: 'B' }],
    shade: { B: { light: '1', mid: '2', dark: '3' } },
    key: { 1: '#ffffff' },
  });
  ok(r.isError && /not in the key/.test(r.text), 'shading without colours for every tone explains itself', r.text);

  r = await call('draw_shapes', {
    name: 'blob', shapes: [{ type: 'wat', fill: 'B' }], key: { B: 0 },
  });
  ok(r.isError && /unknown shape type/.test(r.text), 'unknown shape type explains itself', r.text);

  r = await call('draw_shapes', {
    name: 'blob', shapes: [{ type: 'ellipse', cx: 16, cy: 16, rx: 8, ry: 8 }], key: { B: 0 },
  });
  ok(r.isError && /fill/.test(r.text), 'a shape without a fill character is rejected', r.text);

  section('form shading');
  // The tell between form shading and contour shading is not where the
  // highlight sits — both put it up-left — but whether it touches the outline.
  // Contour shading's highlight *is* an edge band, so nearly all of it borders
  // transparency. A lit volume's highlight is inset, ringed by mid tone.
  await call('create_sprite', { name: 'ball', width: 24, height: 24, palette: ['#000000'] });
  await call('draw_shapes', {
    name: 'ball',
    shapes: [{ type: 'ellipse', cx: 12, cy: 12, rx: 10, ry: 10, fill: 'B' }],
    shade: { B: { tones: ['1', '2', '3', '4'] } },
    key: { 1: '#ffffff', 2: '#cccccc', 3: '#888888', 4: '#333333' },
    despeckle: false,
  });
  const ball = S.decodeRLE(onDisk('ball').frames[0].layers[0].data, 24 * 24);
  const lightIdx = onDisk('ball').palette.indexOf('#ffffff');
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
    if (ball[y * 24 + x] === lightIdx) { sx += x; sy += y; n++; }
  }
  ok(n > 0, 'the highlight tone is present');
  ok(n && sx / n < 11 && sy / n < 11, 'the highlight sits toward the light',
    n ? 'highlight centroid ' + (sx / n).toFixed(1) + ',' + (sy / n).toFixed(1) : 'none');
  let touching = 0;
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
    if (ball[y * 24 + x] !== lightIdx) continue;
    const border = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .some(([dx, dy]) => (ball[(y + dy) * 24 + (x + dx)] ?? -1) < 0);
    if (border) touching++;
  }
  ok(n > 0 && touching / n < 0.25,
    'the highlight is inset, not a band on the outline (contour shading)',
    touching + ' of ' + n + ' highlight pixels touch the silhouette edge');
  // and the darkest tone must land opposite it
  const darkIdx = onDisk('ball').palette.indexOf('#333333');
  let dx = 0, dy = 0, dn = 0;
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
    if (ball[y * 24 + x] === darkIdx) { dx += x; dy += y; dn++; }
  }
  ok(dn > 0 && dx / dn > 12 && dy / dn > 12, 'the shadow falls on the far side',
    dn ? 'shadow centroid ' + (dx / dn).toFixed(1) + ',' + (dy / dn).toFixed(1) : 'no shadow tone');

  section('silhouette preview');
  r = await call('preview_sprite', { name: 'ball', scale: 4, silhouette: true });
  const sil = r.content.find(c => c.type === 'image');
  ok(!!sil, 'preview_sprite returns a silhouette image');
  ok(/silhouette/.test(r.text), 'the silhouette preview says what it is for', r.text);

  section('draw_ascii row validation');
  await call('create_sprite', { name: 'ruler', width: 16, height: 16, palette: ['#000000'] });
  r = await call('draw_ascii', { name: 'ruler', rows: ['####', '########'], key: { '#': 0 } });
  ok(/shorter than 16/.test(r.text), 'short rows are reported, not silently padded', r.text);
  ok(/rows 0, 1/.test(r.text), 'the offending rows are named', r.text);

  section('despeckle');
  await call('create_sprite', { name: 'speck', width: 8, height: 8, palette: ['#000000', '#ffffff'] });
  // one lone pixel in open space, plus a solid block that must survive
  await call('draw_ascii', { name: 'speck', rows: ['........', '..#.....', '........', '....##..', '....##..'], key: { '#': 1 } });
  r = await call('transform', { name: 'speck', op: 'despeckle' });
  ok(!r.isError, 'despeckle runs', r.text);
  const speck = S.decodeRLE(onDisk('speck').frames[0].layers[0].data, 64);
  ok(speck[1 * 8 + 2] < 0, 'the lone pixel is absorbed');
  ok(speck[3 * 8 + 4] === 1 && speck[4 * 8 + 5] === 1, 'the solid block survives');
  invariants('speck', 'despeckle');

  section('preview_sprites');
  r = await call('preview_sprites', { names: ['blob', 'small'], scale: 2, cols: 2 });
  const sheet = r.content.find(c => c.type === 'image');
  ok(!!sheet, 'preview_sprites returns one contact sheet image');
  if (sheet) {
    const buf = Buffer.from(sheet.data, 'base64');
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    // two 32px-cell columns at 2x plus padding; must be wider than one cell
    ok(w > 32 * 2 && h > 0, 'the sheet is laid out as a grid', w + 'x' + h);
  }
  ok(/blob/.test(r.text) && /small/.test(r.text), 'the sheet legend names the sprites in order', r.text);
  r = await call('preview_sprites', { names: ['blob', 'ghost-sprite'], scale: 2 });
  ok(/not found/.test(r.text), 'a missing sprite is reported without failing the batch', r.text);
  r = await call('preview_sprites', { names: [] });
  ok(r.isError, 'an empty name list is an error');

  // ----------------------------------------------------------- error paths
  section('error handling');
  r = await call('get_sprite', { name: 'does-not-exist' });
  ok(r.isError, 'missing sprite is an error');
  r = await call('draw_ascii', { name: 'small', rows: ['zzzz'] });
  ok(r.isError && /not in the key/.test(r.text), 'unknown ascii character explains itself');
  r = await call('create_sprite', { name: '!!!', width: 4, height: 4 });
  ok(r.isError, 'unusable sprite name is rejected');
  r = await call('delete_layer', { name: 'small', layer: -1 });
  ok(r.isError, 'negative index is rejected');

  // ---------------------------------------------------------------- report
  console.log('\n' + '-'.repeat(60));
  console.log((failed ? 'FAILED' : 'PASSED') + ' — ' + passed + ' passed, ' + failed + ' failed');
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log('  - ' + f);
  }

  proc.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch(e => {
  console.error('harness error:', e);
  if (proc) proc.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
