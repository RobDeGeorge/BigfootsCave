# Pixel Art Engine

![Pixel Art Engine](https://robdegeorge.github.io/PixelArtEngine/brand/og.png)

A place to make pixel art for your other projects — buttons, banners, icons, sprite
animations — and a way for AI agents to make it too, into the same library.

It lives at **[robdegeorge.github.io/PixelArtEngine](https://robdegeorge.github.io/PixelArtEngine/)** —
[draw in the browser](https://robdegeorge.github.io/PixelArtEngine/editor.html),
or [browse the library](https://robdegeorge.github.io/PixelArtEngine/gallery.html).

No dependencies. No build step. Node and a browser.

```
node server.js        # then open http://localhost:8787
```

---

## What's here

```
index.html      the editor — one file, opens in any browser
server.js       static host + REST API over the sprite library
lib/sprite.js   the sprite format (shared by editor, server and MCP)
lib/png.js      PNG encoder
lib/gif.js      animated GIF encoder
mcp/server.js   MCP server, so agents can draw into the same library
tools/          static site generator for the published site
library/        your sprites, one .json each
exports/        rendered PNG / GIF / SVG / CSS output
```

The editor, the server and the MCP server all read and write the same `library/`
folder. Draw something with an agent, then open it in the editor and fix it by hand.
Or the other way round.

---

## The editor

**Tools** — pencil, eraser, flood fill, line, rectangle, ellipse, select & move,
eyedropper. Hold <kbd>Shift</kbd> while dragging a rectangle or ellipse to fill it.
Right-drag erases with any tool.

**Layers** — add, duplicate, reorder, merge down, toggle visibility. The `ghost`
slider fades a layer for tracing; it's a preview aid and doesn't affect exports.

**Frames** — a timeline along the bottom, with onion skinning (previous frame in
red, next in blue), playback, and adjustable fps.

**Palettes** — Game Boy DMG and Pocket, GBC, PICO-8, NES, Sweetie 16, CGA,
Endesga 32. Switching palettes remaps existing art to the nearest colour, so you
can redraw a sprite in a different mood without starting over. Edit individual
colours and every pixel using that slot updates live.

**Mirror drawing** — toggle the X or Y axis and every stroke is mirrored. This is
how you draw a symmetrical character in half the time.

**Tracing a reference** — `Import` a PNG and choose *trace*, and the image is
shrunk to the canvas size, reduced to twelve sampled colours and dropped on a
faded layer to draw over; the `ghost` slider fades it further. Choose *open*
instead and the file is loaded at its own size with its colours untouched, which
is the lossless way back in for pixel art you exported earlier. Both run in the
browser, so they work on the published editor with nothing installed.

**Gallery** — a full view of everything in the library. Search by name or tag,
filter by tag, sort by newest / name / size, and resize the thumbnails. Animated
sprites play in place, because the thumbnails are the server's own GIF export.
The four swatches in the toolbar drop the art onto a transparent, dark, light or
mid-grey backdrop, which is the quickest way to find out whether a sprite still
reads against the surface you're going to put it on. Click a card to open it in
the editor; `png` downloads it at 8×; `del` removes it from the library.

### Shortcuts

| | |
|---|---|
| <kbd>B</kbd> <kbd>E</kbd> <kbd>G</kbd> | pencil · eraser · fill |
| <kbd>L</kbd> <kbd>R</kbd> <kbd>O</kbd> | line · rectangle · ellipse |
| <kbd>M</kbd> <kbd>I</kbd> | select & move · eyedropper |
| <kbd>1</kbd>–<kbd>9</kbd> | pick palette colour |
| <kbd>X</kbd> | toggle transparent |
| <kbd>[</kbd> <kbd>]</kbd> | brush size |
| wheel | zoom at cursor |
| space-drag, middle-drag | pan |
| <kbd>+</kbd> <kbd>-</kbd> <kbd>F</kbd> | zoom in · out · fit |
| <kbd>,</kbd> <kbd>.</kbd> | previous · next frame |
| <kbd>Enter</kbd> | play / stop |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> | undo · redo |
| <kbd>Ctrl</kbd>+<kbd>A</kbd> <kbd>C</kbd> <kbd>V</kbd> | select all · copy · paste |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | save to library |
| <kbd>Esc</kbd> | drop floating selection / close dialog |

---

## Getting art into your apps

The Export dialog gives you, at any integer scale:

- **PNG** — one frame.
- **Spritesheet PNG** — all frames in a grid.
- **Animated GIF** — palette-indexed, so it's byte-exact and tiny.
- **SVG** — horizontal runs merged into rects, `shape-rendering="crispEdges"`.
- **data-URI `<img>`** — paste straight into HTML, no file to ship.
- **CSS box-shadow** — the whole sprite as one `<div>`, zero image requests.
- **`.json` sprite** — the editable source.

The server also renders on demand, which is handy for a live page:

```
/api/export/coin.png?scale=8&frame=0
/api/export/coin.sheet.png?scale=4&cols=4
/api/export/coin.gif?scale=8
```

So a button in one of your other projects can just be:

```html
<img src="http://localhost:8787/api/export/button-start.png?scale=2">
```

...during development, and an exported PNG once you ship.

---

## MCP — letting agents draw

Register the server (from this folder):

```bash
claude mcp add pixelart -- node mcp/server.js
```

A `.mcp.json` is already here, so any Claude Code session started in this folder
picks it up too.

The design leans on one observation: a language model is good at describing a
picture as rows of characters, and pixel art *is* rows of characters. So one
authoring tool takes ASCII, and the preview tool hands back a real PNG the agent
can look at.

That holds right up until the picture has a curve in it. Emitting N rows of
exactly N characters is a counting task, and models fail it in a consistent
direction: they reach for constant-width rows because those are easiest to keep
straight, so freehand shapes arrive as rounded rectangles. `draw_shapes` exists
for that — you name a centre and a radius and get real geometry, plus optional
shading, per-part outlines and a cleanup pass. The usual split is `draw_shapes`
for bodies and limbs, then `draw_ascii` with `mode: "over"` for faces and detail.

```
look                                            draw
  list_palettes  the built-in palettes            create_sprite  new sprite, given size + palette
  list_sprites   what's in the library            draw_shapes    ellipses, lines, paths + shading
  get_sprite     read back as ASCII + palette     draw_ascii     rows of characters + a char→colour key
  preview_sprite render to PNG, return the image  set_pixels     individual pixel touch-ups
  preview_sprites  many sprites, one contact sheet transform     flip, rotate, shift, outline, despeckle
  compare_reference  sprite vs reference, side by side  set_palette  swap colours, keeping pixel indices
  import_reference   shrink + sample a reference image

structure                                       manage
  add_frame      append a frame (or copy one)     set_meta       rename, retag, change fps
  delete_frame   remove a frame                   export_sprite  png / sheet / gif / svg / css / json
  add_layer      add a layer to every frame       delete_sprite  remove from the library
  delete_layer   remove a layer from every frame
  move_layer     reorder — later draws on top
  set_layer      rename, hide, set opacity
  merge_layer    merge a layer into the one below
```

`create_sprite` refuses to overwrite an existing name unless you pass
`overwrite: true`, because there is no undo and a name collision used to destroy
the art silently.

Run `npm test` to exercise all of it. The suite spawns the real server and talks
JSON-RPC to it over stdio against a throwaway library, so the schemas, the
dispatch layer and the error envelope are covered, not just the internals.

A typical exchange looks like:

```
create_sprite  name="coin" width=8 height=8 palette=["#4a2a0a","#c07a1a","#f2b134","#ffe08a"]

draw_ascii     name="coin"
               key={"K":0,"d":1,"m":2,"l":3}
               rows=["..KKKK..",
                     ".KmmllK.",
                     "KmmllmmK",
                     "KmlldmmK",
                     "KmlldmmK",
                     "KmmdmmmK",
                     ".KmmmmK.",
                     "..KKKK.."]

preview_sprite name="coin" scale=16     → returns the actual image
```

`.` and a space mean transparent. Key values can be a palette index or a
`#rrggbb` colour, which gets appended to the palette if it's new.

Anything rounder than a coin is easier through `draw_shapes`. Shapes composite in
order into a character grid; then `shade` replaces each flat fill with three
tones lit from the top-left, `outline` traces a border per part, and stray single
pixels are absorbed:

```
draw_shapes  name="slime"
             shapes=[{type:"ellipse", cx:16, cy:19, rx:12, ry:9, fill:"B"},
                     {type:"line", x0:9, y0:11, x1:4, y1:3, thickness:4, fill:"B"}]
             mirror=true
             shade={"B": {light:"1", mid:"2", dark:"3"}}
             outline=[{fills:["1","2","3"], with:"4"}]
             key={"1":"#a8e6c4","2":"#74c79c","3":"#4a9070","4":"#2c5a48"}
```

`mirror` draws the left half onto the right, which halves the work on anything
symmetric and guarantees the halves match — it runs before shading, so the light
still falls from one side. Shading and outlining invent characters that were
never in any shape, and every one of them needs a colour in the `key`; the tool
says which are missing if you forget.

Reviewing a batch one `preview_sprite` call at a time gets slow, and comparing
sprites you can't see side by side is how a set drifts out of a shared style.
`preview_sprites name=[...]` renders up to 64 into a single labelled grid.

### Drawing from reference

An agent drawing a real subject is working from a description it recalls, not
from a picture, so it invents proportions and guesses colours — and it cannot
tell that it guessed wrong. `import_reference` closes that gap:

```
import_reference  path="~/refs/heron.png" width=32 height=32 colors=8
```

It shrinks the image to sprite size, median-cuts it to a small palette, and
returns the result next to its silhouette, plus the sampled colours light to
dark. Both halves matter: the silhouette is the shape that has to be hit, and
sampled hues beat invented ones. Pass `into="sprite-name"` to lay the result
straight into a layer to trace over.

`compare_reference name="heron" path="~/refs/heron.png"` then puts the sprite
and the reference side by side, each with its silhouette. Proportion errors show
up in that pairing and are close to invisible without it.

Only PNG is supported here — the decoder in `lib/png.js` is deliberately narrow,
and rejects interlaced files rather than guessing. Convert anything else first.
There is no URL fetching: whatever is driving the server can already download a
file, and a local server that fetches arbitrary URLs on request is an SSRF hole
for no real gain.

Three examples are in `library/` already — `heart`, `coin` (4-frame spin) and
`button-start` — all made through the MCP server.

---

## The published site

`tools/build-site.js` writes three pages into `site/`:

```
/                landing page — what it is, and a way in
/editor.html     the editor itself
/gallery.html    every sprite — search, tag filter, backdrop swatches,
                 and a detail view with palette and downloads
```

```
npm run build:site
cd site && python3 -m http.server 8000
```

The landing page is generated from `tools/landing.template.html`, and its
showcase strip is real art pulled from `library/` at build time — the same
ranking the gallery uses, so it is never a row of set symbols.

`/editor.html` is the same `index.html` you run locally, copied and patched at
build time: the build injects the social tags, repoints the Gallery button at
`gallery.html`, turns the wordmark into a link home, and copies whatever
`<script src>` the editor references so a new dependency ships rather than
404ing. `index.html` itself is never modified, so the local editor is unaffected.

Published, there is no API to talk to, and the editor already handles that: it
detects the missing server and switches Save to downloading a `.json`. Drawing,
layers, frames, palettes and every export format are client-side and work
untouched. Saving *into the library* is the one thing that needs `node server.js`.

There is no server and no database behind it; it is a folder of files, so there
is nothing to attack and nothing to run. A GitHub Actions workflow rebuilds and
deploys it to GitHub Pages on every push to `main`, which means adding art to
`library/` is the entire publishing process.

`site/` is not committed — it is regenerated on every deploy.

Analytics are off unless `PIXELART_ANALYTICS_TOKEN` is set to a Cloudflare Web
Analytics site token; with no token the build emits an HTML comment and nothing
else. It is cookieless and sets no cross-site identifiers, so it needs no
consent banner. In CI the value comes from the `CF_ANALYTICS_TOKEN` repository
variable — a variable rather than a secret, since the token is served in the
page regardless.

---

## The sprite format

One JSON file per sprite:

```json
{
  "format": "pixelart/1",
  "name": "coin",
  "w": 8, "h": 8, "fps": 10,
  "palette": ["#4a2a0a", "#c07a1a", "#f2b134", "#ffe08a"],
  "frames": [ { "layers": [ { "name": "Layer 1", "visible": true, "opacity": 1,
                              "data": "2.-1 4.0 2.-1 1.-1 ..." } ] } ],
  "tags": ["game", "anim"]
}
```

`data` is run-length encoded as `count.index` pairs, left to right and top to
bottom, where `-1` is transparent. Palette indices rather than colours is what
makes palette-swapping and clean GIF export fall out for free.

---

## Notes

- Sprites are capped at 512×512. This is a pixel art tool; if you need bigger,
  you want a different tool.
- Sprite names become filenames and get slugified, so `My Cool Sprite!` is saved
  as `my-cool-sprite`.
- **`server.js` has no authentication and no per-user isolation. Run it locally;
  don't put it on the internet.** The public site is the static build in `site/`,
  which is what gets deployed. Renders are capped at 16.7M output pixels
  (`clampScale` in `lib/sprite.js`) so a large sprite at a large scale can't
  exhaust memory.
- `PORT` changes the port. `PIXELART_LIBRARY` and `PIXELART_EXPORTS` point the
  MCP server at different folders.
