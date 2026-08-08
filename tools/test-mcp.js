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
  ok(Array.isArray(tools) && tools.length === 19, 'tools/list advertises 19 tools', 'got ' + (tools || []).length);
  ok(tools.every(t => t.name && t.description && t.inputSchema), 'every tool has name, description, schema');
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

  await call('create_sprite', { name: 'merge-hidden', width: 4, height: 4, palette: ['#ff0000', '#00ff00'] });
  await call('add_layer', { name: 'merge-hidden' });
  await call('set_layer', { name: 'merge-hidden', layer: 1, visible: false });
  r = await call('merge_layer', { name: 'merge-hidden', layer: 1 });
  ok(!r.isError && /hidden/.test(r.text), 'warns when merging a hidden layer');
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
