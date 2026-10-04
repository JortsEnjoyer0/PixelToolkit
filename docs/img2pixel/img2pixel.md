# Img to PixelArt tool

Read before changing Img to PixelArt: the tool shell, its sub-tools, Rectify To Grid's panel, stage, output preview or
store, or the pixel-art algorithms behind them. Elsewhere: UI rules `docs/ui.md`; `files.*` IPC, the workspace and
adding a tool `docs/architecture.md`.

## Overview

Tools that turn images into pixel art, as sub-tools picked with the "Tool" select at the top of the control panel.
Nothing touches `data/`: images come in through the open dialog (`files.openImage`), a drop or a paste, and results
leave through a save dialog (`files.savePng`). Sub-tool state lives in memory only, so it is gone after a restart; the
options are kept in the workspace.

**Rectify To Grid** (`rectify`) takes pseudo pixel art (an AI image whose "pixels" are blocks several px wide, with
mixels and noise), finds the fake-pixel size, fits a uniform grid of that size (fractional size, arbitrary offset) and
outputs true pixel art: one px per grid cell, optionally without the background, with merged colours and squared.

| Where | What |
|---|---|
| `tools/img2pixel/Img2PixelTool.vue`, `subtools.ts` | Shell: control panel (sub-tool select + the sub-tool's panel) and the stage area; the sub-tool registry |
| `tools/img2pixel/ImageInput.vue`, `imageSources.ts` | Reusable image box (emits `browse` / `file`, never calls `window.api`); drop and clipboard picking, `useImagePaste()` |
| `tools/img2pixel/view/CanvasView.ts` | Shared pan / zoom 2D canvas (no three.js in this tool); its colours are TS constants there |
| `tools/img2pixel/rectify/` | `RectifyPanel.vue`; `RectifyStage.vue` + `GridStageView.ts` (image with the grid overlay); `RectifyPreviewDialog.vue` opened by `previewDialog.ts` (`openRectifyPreview`) |
| `stores/rectify.ts` | Rectify To Grid state (`RectifyStoreApi`, `SourceImage` in `stores/types.ts`) |
| `core/pixelart/` | `grid.ts` (grid model), `estimate.ts` (`estimateGrid`), `rectify.ts` (`rectify`, incl. edge snapping), `quantize.ts` (Max colours: `quantizeColors`, `COLOR_LIMITS`, `snapColorLimit`); `decode.ts` (browser-only decoding) |
| `src/shared/image.ts` | `RgbaImage`, `OPEN_IMAGE_EXTENSIONS` and the size limits |

## UI

Control panel on the left (`--panel-width`, `data-zone="img2pixel-panel"`), the stage to its right (Img2PixelTool's
flex column, `data-zone="img2pixel-stage"`). No tabs. Switching sub-tools unmounts the old panel and stage; their state
stays in the store.

Rectify To Grid's panel (`RectifyPanel.vue`), scrolling sections and a pinned footer:
- **Image**: `ImageInput`. Click (Enter / Space) opens the dialog; an image file dropped on the box (or the stage)
  loads; the name and `W × H px` sit below the thumbnail; a spinner covers it while decoding.
- **Pixel Grid**: "Estimate pixel grid" (disabled without an image, tooltip says why; spinner while estimating); a
  notice when the estimator found no grid at all (confidence 0). The confidence is not shown otherwise: it is relative
  (about 0.2 on correct grids of real AI images, 0.9 on clean upscales). Field-only `NumberSlider`s with `wheel`: Pixel
  size (`MIN_GRID_SIZE`..`MAX_GRID_SIZE`, `SIZE_DECIMALS`, wheel / arrows `SIZE_NUDGE`) with ½ and ×2 (the one-click fix
  for the estimator's main miss, half or twice the size), Offset X / Y (any value within ±`MAX_IMAGE_SIDE`, wrapped into
  [0, size) by the store; `OFFSET_DECIMALS`, wheel / arrows `OFFSET_NUDGE`). The output size ("Output 64 × 64 px",
  `outputSize()` incl. Make square) and a hint about dragging the grid.
- **Output**: Remove background, Merge similar colours, Snap to pixel edges, Make square, and Max colours (a
  `StepSlider` over `COLOR_LIMITS`, ∞ = no limit) (`RectifyOptions`; workspace-persisted, Max colours snapped to a
  slider setting by `parseImg2Pixel`).
- **Footer**: "Rectify Image" (primary; disabled without an image or when the grid has no cell inside it; spinner while
  rectifying) runs `store.rectify()` and opens the output preview with the result.

Stage (`RectifyStage.vue` + `GridStageView`): the source image with the grid drawn over it. Middle drag pans, the
wheel zooms around the cursor, a left drag moves the grid (the offset changes by whole image px and keeps an
estimate's fractional part; Escape restores it), and the arrow keys move it by 1 image px while the stage zone is
current. An image file dropped on it loads too; without an image it shows an empty state with an open button. Overlays:
"Fit to view", a HUD (zoom, image px and cell under the cursor) and control hints.

Output preview (`RectifyPreviewDialog.vue`, `DialogFrame` size `xl`, opened by `openRectifyPreview(result,
sourceName)`): the rectified image in a `'pow2'` `CanvasView`. The wheel zooms in power-of-two steps of device px per
image px (1, 2, 4, …; the canvas backing store follows `devicePixelRatio`, so an image pixel is never cut and pans are
whole device px), middle drag pans, a reset button (top right, only while the view differs from the default) returns
to 1× centred. An info line shows size and colour count; Save… writes the PNG through `files.savePng` and the dialog
stays open (the saved path, or the error, shows in its footer).

## Flows

- **Loading** (`store.loadBlob(blob, name)`; `openFile()` = `files.openImage` → `loadBlob`, nothing on cancel):
  `decodeImageBlob()` decodes without premultiplication or colour conversion and rejects with a user-facing message
  (not an image; larger than `MAX_IMAGE_SIDE` or `MAX_IMAGE_PIXELS`, naming the size and the limit). The panel reports
  it with the title `Could not open "<name>"` (drops and pastes) or "Could not open the image" (the dialog; the message
  names the file). A newer load wins over a slower older one (sequence counter; the loser's bitmap is
  closed, its failure dropped). Adopting an image revokes the old object URL, closes the old bitmap and clears
  `lastEstimate`; the grid stays.
- **Paste**: Ctrl+V with an image on the clipboard (a copied image, or a copied image file) while the panel is shown;
  named after the file (a raw clipboard bitmap, e.g. a screenshot, arrives as Chromium's "image.png"); a mouse note
  confirms.
- **Estimate** (`runEstimate()`): sets `estimating`, waits for a paint (double `requestAnimationFrame`) so the spinner
  shows, then runs `estimateGrid()` synchronously on the source and adopts it as the grid and `lastEstimate`.
- **Grid edits** (`setGrid`, `nudge`): always through `normalizeGrid()` (size clamped and rounded to `SIZE_DECIMALS`:
  a size error accumulates over every cell, so it keeps more decimals than the offsets; offsets wrapped); the grid is a
  frozen object replaced on change.
- **Rectify** (`store.rectify()`): sets `rectifying`, waits for a paint like the estimate, then runs
  `rectify(source.image, grid, options)` from `core/pixelart/rectify.ts` synchronously; the preview owns saving.

## State and persistence

- `stores/rectify.ts`: `source` is a `markRaw` `SourceImage` in a `shallowRef` (pixels, bitmap, object URL are never
  reactive); `grid`, `lastEstimate`, `loading`, `estimating`, `outputSize`; `options` read from the workspace and
  written back with `setOptions()`. Disposing the store releases the source.
- Workspace `img2pixel` (`WorkspaceState`): `subtool` (any non-empty id; an unknown one shows the first sub-tool) and
  `rectify` (`DEFAULT_RECTIFY_OPTIONS`: everything that cleans the output is on, nothing pads it, no colour limit).
  `parseWorkspace()` takes each option only when it has the default's type (`sameTypeFields`), so a malformed field
  falls back alone.
- Not persisted: the image, the grid and the estimate.

## Keys and focus

- Zones `img2pixel-panel` and `img2pixel-stage` (Skel Anim's `panel` / `editor` / `frametrack` keys never fire here).
  Ctrl+S, Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z decline while this tool is shown (`installDocumentShortcuts(isActive)`).
- Ctrl+V: `useImagePaste()` listens on the document from mount / activation to deactivation / unmount (KeepAlive) and
  ignores pastes while a modal is open, into text fields, and when its panel is not in the document.
- Stage: arrows (zone-scoped to `img2pixel-stage`), left drag, middle drag, wheel. Preview: wheel, middle drag.

## Adding a sub-tool

1. A folder `tools/img2pixel/<id>/` with a panel (root: a flex column, `col flex-1`, holding `.panel-body` sections and
   an optional pinned footer) and a stage (fills the stage column); one entry in `SUBTOOLS` (`subtools.ts`).
2. Its own store; reuse `ImageInput` + `useImagePaste()` and `CanvasView`. Options: a field beside `rectify` in
   `WorkspaceState.img2pixel`, defaults in `defaultWorkspace()`, parsing in `parseImg2Pixel()` (`stores/workspace.ts`).
3. Algorithms framework-free in `core/pixelart/` on `RgbaImage`, node-tested; only `decode.ts` needs a browser.

## Algorithm

Both files open with a pipeline summary; the constants are named and commented there. This section records why the
pipeline looks the way it does. Grid convention (`grid.ts`): lines at `offset + k·size`, one output px per cell whose
centre lies inside the image (`gridCells`), the same in the estimator, the rectifier, the stage and the tests.

**Estimator** (`estimate.ts`, `estimateGrid` / `analyseGrid`). A uniform square grid, fractional size, any offset.
- Edges, not colours: colour steps between neighbouring pixels (luma weighted, smoothed chroma for 4:2:0 JPEGs), with
  pairs that are both background zeroed (background noise and JPEG blocks would otherwise vote). The background model
  comes from the border band: one colour as a robust plane, or a painted "transparency" checkerboard (AI images often
  fake transparency that way; its squares would otherwise win the vote), speckle-filtered when noise would unmask it.
  Two scales: adjacent pixels (sharp, small cells) and pixels 5 apart (blurred edges). Thresholded against the
  image's own noise (lower quantiles when edges dominate, e.g. dithering over the whole canvas).
- Per column / row a saturating support profile whose local maxima become candidate lines (sub-pixel centroids). The
  weight is support length, capped, so a few long silhouette lines cannot outvote many short interior ones.
- A Hough-like vote over (size, phase) normalised against chance (whole-pixel and JPEG quantisation raise chance), then
  robust least squares of `position = offset + k·size` and a whole-pixel lock when that drifts less than `LOCK_DRIFT`
  over the art.
- Harmonics are the hard part: a lattice explains its edges as well as any sub-multiple does, and AI images have mixels
  (detail on half cells). Dividing needs strong, significant sub-lattice evidence (`SUB_RATIO`, `SUB_SIGNIFICANCE`) and
  the fine lines voting for the divided lattice (`DIV_VOTE_GAIN`: blurry upscales and JPEG block grids fooled the ratio
  alone); promoting to 2× needs nearly empty in-between lines plus the vote. A half-cell phase check (whole-cell colour
  error) fixes fits locked onto mid-cell mixel lines. Remaining misses are mostly ½ or 2× on flat, heavily mixeled art:
  hence the panel's ½ / ×2.
- Known limit: pseudo pixel art that was nearest-upscaled again by a whole factor (every px a 2×2 block) returns that
  factor (2, 3, 4): true pixel art upscaled by k looks the same, so it cannot be decided automatically.
  `analyseGrid()` reports the grid of the 1/k image as `upscaled`; the user types the size.
- `integerOnly` post-processes the free estimate (nearest whole size, phases refitted); `minSize === maxSize` fits only
  the offsets. Confidence is coherence-based and relative (see the panel). No grid: fallback size, confidence 0.

**Rectifier** (`rectify.ts`, `rectify` / `rectifyDetailed`). Background removal works on output cells after the
colours are known (never on the source pixels), so every output pixel is either opaque or transparent.
- Sampling: the inner part of each cell (`margin`), after a PSF / phase fit on the busiest crop corrects small grid
  offsets and drift; inhomogeneous windows of larger cells may re-centre. Cell colour: alpha majority, then a
  mean-shift mode of the samples (rejects bleed from neighbours; a mean would invent colours). Cells under
  `deconvMaxSize` are deconvolved with the fitted blur.
- Snap to pixel edges (`snapToEdges`, on by default; step 1b in the file header): AI sprite sheets are not one
  uniform grid, each sprite has its own phase. The user's grid and the output size stay as they are; only the
  sampling follows the image. Edge profiles are summed per band of `snap.band` output rows (for the vertical lines)
  and columns (for the horizontal ones), so neighbouring sprites get their own line positions; each line then moves
  on its own (anchored on its unsnapped position, never chained) to a clearly stronger edge within `snap.window`
  cells, and each cell samples between its own snapped lines. It cannot fix a sprite drawn at a different fake-pixel
  size (the cell count stays the grid's). Chosen on a synthetic sprite-sheet set with per-sprite phases and sizes
  (dev and test, plus aligned sheets as the control) without regressions on the standard sets; on the real samples
  the sheets and knight2 got cleaner, the rest stayed the same.
- Merge similar colours: a tolerance from the art's own neighbour noise (`mergeK`, clamped), leader clustering,
  Lloyd refinement and an overlap merge; members take the cluster mean, so flat regions become exactly one colour.
- Background: `detectBackground()` on the source border band (dominant colour, tolerance from its noise; null when the
  border is not one solid colour, e.g. full scenes, which then keep everything). The user's policy (they choose
  background colours that do not clash with the art) is "remove every matching cell": `pockets: 'all'`, plus one halo
  ring and isolated specks. Without removal the background cells are painted in the one background colour.
- Chroma-key backgrounds (saturated, e.g. magenta): AI sprites leave key-tinted fringes (anti-aliased outlines mixed
  with the key). `keyFringe` removes slightly off-key cells and un-blends up to `keyRings` rings from the background
  against a neutral colour or a neighbour's colour (key share >= 0.5: background, smaller: the un-blended colour). The
  un-blending is skipped when the art's interior itself uses the key's hue (`keyArtShare`).
- Make square: centred (floor) padding with transparency, or the background colour when it is kept.
- Max colours (`quantize.ts`, applied by `rectify()` to the finished image): weighted k-means in OKLab over the
  output's unique colours, seeded deterministically (heaviest colour, then largest count × squared distance), so a
  setting always gives the same palette. Transparent pixels are untouched; a kept background colour stays exact and
  takes one slot. Cluster means can be slightly less saturated than the most vivid member colours.

**How it was chosen.** A synthetic benchmark (the true-pixel sprites plus procedural art, upscaled by integer and
fractional sizes with jitter, mixels, blur, noise, JPEG-like artifacts and varied backgrounds; dev, test and holdout
sets plus 700-case pools) scored five independent estimators (projection comb, spectral, run lengths, cell variance,
edge lines); the shipped one is the edge-line fit with the harmonic and phase stages above. Held-out results: grid
correct (mean line error < 0.15 cell, max < 0.35) on 100 % of the test and holdout sets and 99.6 % of a fresh
700-case pool; the rectifier on the true grid recovers about 99 % of the cell colours. Real samples
(`assets/test_imgs/fakepixelart/`) were checked by eye and are locked in `scripts/test-pixelart.ts`. Run time on
1.25-1.5 MP images: estimate about 150-450 ms, rectify 25-300 ms, on the main thread behind spinners (a Web Worker is
the next step if that grows).

## Testing

- `npm run test:pixelart` (`scripts/test-pixelart.ts`): grid model, estimate and rectify on synthetic upscales with
  known grids, the options, the colour quantizer, edge snapping on two-sprite sheets (side by side, stacked, small
  cells; floors a broken band, vertical or small-cell path would miss), degenerate inputs (must not throw) and the
  real samples (sizes locked, the magenta fringe).
  A deliberate algorithm change may re-lock `REAL_SIZES` after checking the new grids by eye.
- `npm run test:docs` drives the rectify store with stubbed decoding (grid normalization, options in the workspace,
  load ordering, release of URLs and bitmaps, estimate, `files.openImage`) and the workspace `img2pixel` parsing.
- UI changes: run the app (`docs/architecture.md`, "Testing and verification"); `PT_TEST_IMPORT_FILE` /
  `PT_TEST_SAVE_FILE` replace the open and save dialogs.
