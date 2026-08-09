---
name: pixel-art
description: Draw pixel art sprites with the pixelart MCP server — creatures, characters, icons, tiles, UI. Use whenever art is being made into the sprite library, or when a sprite already drawn needs to be judged or improved. Enforces a silhouette-first process and the specific craft rules that separate sprite art from clip art.
---

# Pixel art

Making a sprite is not one drawing act. It is four, in a fixed order, each
verified by looking before the next begins:

**silhouette → form → colour → detail**

Skipping ahead is the single most common cause of bad output. Detail on a weak
silhouette is wasted; shading a shape you haven't checked just makes a
well-lit wrong thing.

## The loop

Every stage ends with `preview_sprite`. Reading back ASCII is not looking.

1. **Silhouette.** Block the masses with `draw_shapes` in one flat colour.
   Then `preview_sprite silhouette=true`. Ask: *without colour, is this
   identifiable, and is it distinct from the last thing I drew?* If not, fix
   the shape. Do not proceed. This check is cheap and it is the one that
   decides whether the sprite is any good.
2. **Form.** Add `shade` with a 4-tone ramp. Preview. The lit area should be a
   broad region offset toward the light with a terminator curving across the
   body — not a rim tracing the outline.
3. **Colour.** Set the real palette. Preview.
4. **Detail.** Faces, markings, small features, with `draw_ascii mode:"over"`.
   Preview at `scale=6`, then again at `scale=1`. If it dies at 1×, the detail
   is too fine — remove it rather than shrinking it.

Then run the critique below and do at least one revision pass. First drafts are
never done. Budget three to six passes per sprite; if a sprite has only had one,
it is not finished.

## Craft rules

**Silhouette carries the character.** At 32×32 you get two or three readable
features. Pick the two or three that identify the subject, exaggerate them hard,
and delete everything else. A Pokémon is its ears, its tail, its shell — not its
toes. Detail that survives at 1× is real; detail that doesn't is noise.

**Vary the axis.** Two stacked ellipses with a symmetric face is the default
that every subject collapses into, and it is why a set ends up looking like
recolours of one sprite. Break it deliberately: tilt the head, push the mass
off-centre, let one limb cross the body, use a three-quarter view. Asymmetry in
the pose is worth more than any amount of shading.

**Two or three tones per material, with a hard edge between them.** Not four,
and not a smooth ramp. Measured against a real 96×96 creature sprite: eleven
colours total, of which the body used *two* — one light, one shadow — meeting
at a crisp terminator. A four-tone radial gradient looks soft and muddy at
sprite scale and is a common way to make work look amateur. Reach for
`shade` with `tones` of length 2 first, and add a third only where the form
genuinely needs it.

**Give every volume its own fill character.** `shade` lights each connected
region as one mass, so a head and body that touch get a single light centre and
the lower half goes uniformly dark. Draw the head as `H`, the body as `Y`, the
tail as `T` — all mapping to the same two tones — and each gets its own
highlight, which is what actually reads as separate forms.

**A single dark keyline is normal and correct for this style.** Character sprites
in the Pokémon/JRPG idiom are outlined in one near-black throughout. Per-part
outlines in a tint of each part's own hue give a softer, painterly look — a
legitimate choice, but a different one. Pick deliberately; do not assume the
tinted version is more sophisticated.

**Hue-shift the ramp — do not just change lightness.** Shadows shift toward the
cool end and desaturate slightly; highlights shift toward warm and saturate.

```
flat, lifeless          hue-shifted
#f0a040  light          #ffd54a
#906020  shadow         #e6a452
```

**Keep one light direction across an entire set.** Top-left unless there is a
reason. Nothing makes a collection look assembled by different hands faster than
inconsistent lighting.

## Failure modes, by name

Check for these explicitly — each has a specific fix.

- **Pillow shading** — tone follows the outline inward, so the shape glows
  evenly from its own edge. Fix: light from a direction, not from the border.
  `shadeMode:"form"` does this; `"rim"` does not.
- **Banding** — parallel diagonal stripes of equal width in a gradient. Fix:
  vary band widths, break the boundary.
- **Jaggies** — a curve whose stair steps run 3,1,2,4 instead of a consistent
  run. Fix: make step lengths monotone along the curve.
- **Orphan pixels** — a single pixel with no like neighbour. Fix: `despeckle`.
- **The blob default** — the subject became a rounded rectangle or a two-ellipse
  snowman. Fix: return to the silhouette stage; no later stage repairs this.
- **Muddy palette** — more than about sixteen colours, or ramps sharing tones
  across unrelated materials.

## Critique before declaring done

Look at the preview and answer these as a critic, not as the author. Any "no" is
a revision, not a caveat to report:

1. From the silhouette alone, what is it? Is that what it should be?
2. Which single feature identifies it? Is that feature the most prominent thing?
3. Where is the light? Is it in the same place on every part?
4. Does it survive at 1×?
5. Put it next to the last three sprites with `preview_sprites` — does it look
   like a sibling or a recolour? Recolour means the silhouette work was skipped.
6. What is the weakest area? Fix that specific thing and preview again.

## Tools

- `draw_shapes` — bodies, heads, limbs, tails. Ellipses, lines with thickness,
  paths. Use for anything with a curve. Writing curves as ascii is a counting
  task, and the failure mode is constant-width rows, which come out rectangular.
- `draw_ascii mode:"over"` — faces and small detail, stamped on top.
- `preview_sprite silhouette=true` — the squint test. Use it early, every time.
- `preview_sprites` — review a batch as a set, to catch drift and sameness.
- `transform op:"despeckle"` — clean stray pixels on existing art.

## Working size — decide this first, and do not default

Size is the one decision that cannot be fixed later, and picking it carelessly
poisons everything downstream. 16×16 is an icon. **48×64 is a creature.** 32×32
is a small icon or a very simple creature, and is not enough for a character
with a face, limbs and a distinguishing feature — a full-body creature at 32×32
gets roughly a quarter the pixel budget of the sprites it will be compared to,
and the resulting art looks crude for reasons no amount of technique repairs.

If there is a reference, measure it: trim it to its subject and match that
pixel count. A 96×96 reference file whose creature occupies 50 pixels of height
wants a canvas around 64, not 32.

Draw at the size the subject needs and export at 4× or 8×; never draw large
merely to get detail, and never draw small out of habit.
