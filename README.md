# Quire

An infinite handwriting whiteboard for [Obsidian](https://obsidian.md). Each board is a
`.quire` file in your vault. No account, no server, no network access.

A *quire* is a gathering of sheets — the unit a notebook is bound from.

## Why another one

Quire is built around three things that decide whether a stylus feels right on a canvas.

**Strokes are baked, not redrawn.** Two stacked canvases: finished strokes are drawn once
onto the committed layer, and only the stroke under the pen is redrawn each frame. The
committed layer is rebuilt only when the view pans or zooms. Per-frame cost does not grow
with the number of strokes already on the board.

**Every sample is used.** Apple Pencil reports at up to 240 Hz while `pointermove` fires at
the display rate. Quire reads `getCoalescedEvents()` for the samples in between and
`getPredictedEvents()` to draw slightly ahead of the pen, and requests a
`desynchronized` 2D context for a shorter path to the screen.

**Palm and pen are separated at the touch layer.** Quire listens to `touchstart` /
`touchmove` / `touchend` and splits input on `Touch.touchType`. This avoids a WebKit
behaviour on iPad where, while a finger is in contact, the next pen `pointerdown` is
delayed or withheld while the system decides whether the contact is a gesture.
`touch-action: none` is applied down the whole view subtree, not only the canvas, so no
enclosing element keeps a scroll recognizer armed. Pointer Events are still used on
desktop.


## Select and move

Pick the **⬚** tool, draw a lasso around what you want, then drag it. Only things
**entirely inside** the lasso are picked up — partly-crossed strokes are left alone, so
what you get is predictable. `Delete` removes the selection, `Escape` drops it.

## Radial menu — hold the pen down

Apple Pencil's double-tap and squeeze are not handed to web views by WebKit, so a plugin
cannot read them. Holding the pen still for a moment does the same job: a wheel opens
where the pen is. Inner ring picks the tool, outer ring picks colour and width. Slide onto
one and lift. Lift in the middle, or well outside, to cancel.

## Images

Toolbar **🖼** inserts from a file, and paste or drag-and-drop work too. Images sit under
the ink, and the lasso moves them like anything else.

The picture itself goes into the vault as an attachment and the board stores the path,
not the bytes. Embedding the data would push a board into tens of megabytes and copy all
of it into every undo step.

## Image search

Toolbar **🔍** searches [Openverse](https://openverse.org) — no API key, and everything
returned is Creative Commons or public domain. The credit line is stored with the image
and drawn beneath it, because attribution is a condition of those licences.

Google and Bing image search need a paid key and tell you nothing about whether you may
use the result, so they are not offered.

## File format

```
{ "v": 2, "strokes": [ … ], "images": [ { "id", "src", "x", "y", "w", "h", "attr" } ], "view": { … } }
```

Boards written by earlier versions have no `images` key. They open unchanged — the key is
filled in with an empty list rather than the file being refused.

## What it does

- Infinite canvas — two-finger pan and pinch zoom, wheel and ⌘-wheel on desktop
- Pen, highlighter, stroke-level eraser
- Pressure-driven stroke width
- Colour and width presets
- Palm rejection — finger input is ignored while the pen is in contact
- Pen, highlighter and stroke-level eraser; four stroke widths; pressure on/off
- Undo and redo, 60 steps deep, covering erases as well as strokes
- Five colour presets plus a custom colour picker
- Fit to content
- **Background grid** — off, dots or lines. Spacing steps by powers of two so it stays
  between 16 and 64 screen pixels at any zoom. Drawn as a cached tile pattern, so it costs
  one `fillRect` per rebake regardless of viewport size or zoom.
- **Origin marker** — a small cross at world (0, 0). A grid looks the same everywhere, so
  without it the grid tells you nothing about where you are.
- **Minimap** — bottom right, showing the bounding box of everything drawn, the origin, and
  the window you are currently looking at. It fades while you are drawing so it does not
  hide strokes underneath.
- Tool, colour, width, pressure, grid mode and minimap persist across restarts
- Viewport culling — off-screen strokes are skipped when the committed layer is rebuilt
- An input diagnostics overlay (the 🐞 button) showing event counts and a timestamped
  event trace, for reporting stylus problems on hardware I cannot test

## Not there yet

Stated plainly so nobody is surprised:

- The minimap is display only — you cannot tap it to jump
- No stroke selection or move
- No PDF or image background
- No text
- No layers

## Hardware

Built and tested on **iPadOS with Apple Pencil**, and on **macOS with a mouse**. That is
what I have, and it is what I intend to support.

The palm-rejection path keys off `Touch.touchType === 'stylus'`, which Apple populates.
It only activates once a stylus touch has actually been seen, so hardware that does not
report `touchType` — Windows, Android, most non-Apple styluses — stays on the standard
Pointer Events path, where pens are identified by `pointerType === 'pen'`. Drawing and
pressure work there; what you do not get is the touch-layer palm rejection, so resting
your hand may pan the canvas.

I cannot test those setups and will not be fixing bugs I cannot reproduce. Reports with
the 🐞 diagnostics output are still welcome, and so are pull requests.

## File format

`.quire` is JSON. Points are stored flat as `[x, y, pressure, …]` in world coordinates,
with a cached bounding box per stroke.

```json
{
  "v": 1,
  "strokes": [{ "c": "#e8e8e8", "w": 3, "a": 1, "pts": [0, 0, 0.5, 12, 4, 0.62] }],
  "view": { "x": 0, "y": 0, "k": 1 }
}
```

If a file fails to parse, the view refuses to open it rather than overwriting it.

## Install

Not in the community plugin list yet.

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release
2. Put them in `<vault>/.obsidian/plugins/quire/`
3. Reload Obsidian and enable **Quire** under Settings → Community plugins

Working from a clone: edit in the repo and run `./sync.sh` to copy the three files into
your vault. Set `QUIRE_VAULT` if your vault is not at the default iCloud path.

`npm test` runs `test/smoke.js`, which loads the plugin against a stubbed Obsidian API and
asserts the input, undo and persistence behaviour. It catches duplicate method definitions,
bad string escapes and state leaking across files — the three things that got past a
careful read of the diff.

## Prior art

[Pencil](https://github.com/rcanand/obsidian-pencil) by rcanand covers the same ground and
has features Quire does not — stroke selection and move. Quire shares no code with it. If you want the fuller feature set today, use Pencil.

## Licence

MIT
