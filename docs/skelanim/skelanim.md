# Skel Anim tool

Read before changing Skel Anim features (explorer, Character dialog, tabs, panel, editor wiring, frame track) or the
document, undo, saving, GC and job flows behind them. Elsewhere: rig math and projection `docs/skelanim/rig.md`, PixelLab
and main's job service `docs/pixellab.md`, disk layout / IPC / close handshake / workspace `docs/architecture.md`, UI
rules `docs/ui.md`.

## Overview

The Skeletal Animator turns a sprite into an animation. The user poses a 3D humanoid rig, the app projects each pose to
OpenPose / COCO-18 keypoints, and PixelLab's animate-with-skeleton-v3 draws the frames.
1. Create a character in the explorer and import its base images (padded sprites) in the Character dialog.
2. Create an animation. The first base image facing the character's default direction is copied in as its reference.
3. Estimate the reference skeleton (PixelLab estimate-skeleton, cached per base image). This lifts the 2D keypoints to
   3D and calibrates the rig to the sprite. An empty track gets one copy of the reference pose.
4. Pose frames 1..N (3–15) in the 3D editor: rotate bones, move Hips, add, clone and reorder frames.
5. Generate. The job runs in main. Its result replaces the track with posed frames that carry images (one undo entry).

| Where | What |
|---|---|
| `src/renderer/src/core/model.ts`, `core/docState.ts`, `core/generate.ts` | Persisted types, parse / serialize, state producers, generation preflight and request |
| `src/renderer/src/stores/documents.ts`, `stores/doc/*` | DocHandle, IO queues, save, rename, runExclusive, reconcile, image GC |
| `stores/tabs.ts`, `workspace.ts`, `explorer.ts`, `playback.ts` + `job/playbackCore.ts`, `jobs.ts` + `job/jobsCore.ts` | The other stores (`*Core.ts` = store-free logic the node tests drive) |
| `src/renderer/src/tools/skelanim/` | `SkelAnimTool.vue`, `explorer/`, `CharacterDialog.vue`, `tabs/`, `panel/`, `editor/`, `frametrack/`, `livePose.ts` |
| `src/renderer/src/editor/` | The three.js viewport (`EditorViewport`; contracts in `editor/types.ts`) |

## Data model

On disk (layout, image naming, immutability and write rules: `docs/architecture.md`, Data root and files):
```
data/Townsfolk/Merchant.json             CharacterMeta (a character = this json + the dir of the same name)
data/Townsfolk/Merchant/base.<uid>.png   base image, owned by the character
data/Townsfolk/Merchant/Walk.json        AnimationMeta
data/Townsfolk/Merchant/Walk.<uid>.png   animation-owned image (reference copy or frame image)
```
- **CharacterMeta** (`core/model.ts`): `description` (default for every animation's description), `baseImages[]`, and
  `defaults {direction, view, templateId}` for new animations. A `BaseImage` holds `uid`, `label`, `direction | null`,
  the padded canvas size, source size and `offset`, and `estimate {keypoints, at} | null` (the estimate cache).
- **AnimationMeta**: generation fields `action`, `description` (`''` sends the character's), `direction`, `view`,
  `pitchDeg`, `templateId`, `seed` (0 = random), `noBackground`, `sendDepth`; `fps` (playback only, not undoable, not
  sent); `reference`; `rig` (template calibration until estimated); `projection {ppu, anchorPx}` (default framing
  until estimated); `frames: FrameData[]` of `{uid, pose, image | null, imageStale}`. A frame `uid` is its identity
  (playback target, selection, job snapshot), not an image uid. `imageStale`: the pose changed after the image was made.
- **The REF slot is not a track frame.** `reference` holds the image, `sourceBaseUid` (the base image it was copied
  from: the estimate cache key), its 2D `estimate` (canonical order; OpenPose edits move its x / y), 18 3D `coco`
  points (NECK = shoulder midpoint), the calibrated `pose` (`cocoFromFk(fk(pose, rig)) == coco`) and `needsEstimate`.
  On Generate, REF becomes `first_frame` + `first_frame_keypoints` and frames 1..N become `keypoints`.
  `FrameTarget = {kind:'ref'} | {kind:'frame', uid}`.
- **Images:** state holds image uids only; the file is `<anim>.<uid>.png` beside the json, so a rename must move them.
  Picking a base image copies it to a new animation-owned uid (`images.copyToAnimation`). Non-uid image refs parse as
  `null`.
- **Parse / serialize:** `parseAnimation` / `parseCharacter` validate, migrate (`ANIMATION_MIGRATIONS` keyed by the
  version they upgrade from) and fill defaults; they throw only for a non-object or an unsupported version (newer, or
  no migration). Missing bones → identity, quaternions renormalized, duplicate frame uids replaced.
  `serializeAnimation` / `serializeCharacter` return a plain copy rounded to 6 decimals and throw on NaN / Infinity;
  only that output goes to `fs.writeJson` (never store state or proxies over IPC).
- **Changing fields:** names are frozen; a changed meaning needs a version bump plus migration. A new animation field
  needs `AnimationMeta`, a `parseAnimation` default, `createAnimationMeta`, `UNDOABLE_KEYS` when undoable, and
  `metaFromState` (`core/docState.ts`), which lists every field explicitly in file order: a field missing there is
  never saved.

## Documents

- **`DocHandle`** (contract `stores/types.ts`; `createDocHandle` in `stores/doc/handle.ts`; `stores/mockDoc.ts` wraps
  the same handle) is one open animation. `id` (AnimationMeta.id) keys the documents map, tabs, playback and jobs.
  `rel` / `charRel` / `name` refs are the only place the path lives (`setLocation` on an animation rename or when
  `runExclusive` remaps a folder / character rename). `version` bumps on every content change (the viewport's refresh
  key). Handles are `markRaw`: keep them in `shallowReactive` / plain containers, never `reactive()`.
- **UndoableState** = `Pick<AnimationMeta, UNDOABLE_KEYS>`, immutable and copy-on-write (`deepFreeze` in dev and node
  tests, skipped in production). Every change is `doc.apply(label, producer, opts?)`; the producer returns a new state
  sharing unchanged branches, or the same object for a no-op (no entry). Producers: `core/docState.ts`
  (`withTargetPose`, `withReferenceCoco`, `withEstimate`, `withCamera`, `withReferenceImage`, `withFrames`),
  `stores/job/applyResult.ts` (`withJobResult`). Selectors, also `core/docState.ts`: `targetPose` (REF or frame pose),
  `ghostPoses` (onion skin), `referencedImages` (GC live sets, renames, duplicates). Track edits:
  `tools/skelanim/frametrack/frameOps.ts` (`addFrame`, `cloneTarget`, `moveFrame`, `deleteFrame`; each returns the
  target to select, null for a no-op; `canClone` gates the UI).
- **Undo stack** (`core/undo/UndoStack.ts`, `doc.history`; keys: `undoRedo` in `tabs.ts`): a push drops the redo
  branch, or merges into the top entry on the same `mergeKey` within `mergeMs` (1000 ms) of that entry's last push
  with no undo / redo / `seal()` since; only the pitch slider merges (`pitch:<docId>`, sealed on commit). Limit
  `settings.app.undoLimit` (100) counts undo + redo steps (oldest undo trimmed first); a settings change trims every
  stack. Every dropped state (redo truncation, merge, trim, `clear`, `reset`) fires `onEvict` → image GC.
- **Undoable:** `UNDOABLE_KEYS` (all content but `fps`). **Not:** the name (filesystem rename), fps (`metaRev` →
  dirty), playback target, bone selection, camera view, toolbar toggles, explorer ops, Character dialog edits. Entry
  labels follow `docs/ui.md` (Labels and text).
- **Dirty** = `state !== savedState || metaRev !== savedMetaRev` by object identity: undoing back to the saved state
  clears it. A save records the exact state it serialized (`markSavedAs`), so edits made during the write stay dirty.
- **Drags commit once:** the viewport edits a scratch pose (`GizmoController`) or COCO drag points outside Vue, emits
  rAF-throttled `livePose` / `liveCoco` (→ `tools/skelanim/livePose.ts` → only the matching thumbnail redraws), and
  makes one `commitPose` / `commitCoco` (= one `doc.apply`) on pointerup. Escape / `cancelInteraction()` discards.
  `services/editorState.ts`: while `editorInteracting`, Ctrl+Z / Y and Left / Right are blocked and autosave waits
  (`whenEditorIdle`); `cancelEditorInteraction()` runs before undo, redo, an estimate or job apply to the active doc,
  active-tab close and app close. The viewport itself cancels on a doc swap, target change or content refresh.
- **Stores:** `documents` (open docs in a `shallowReactive` Map, the character cache, every IO-aware operation),
  `tabs` (docIds in order + active; `TabInfo` derived; a doc leaving `documents` loses its tab at once; an active-tab
  change first blurs the focused field so it commits to its own doc), `workspace`, `explorer`, `playback`, `jobs`,
  `settings`. UI opens docs with `tabs.open(rel)`; only headless job apply calls `documents.load` directly.
- **Load:** concurrent loads of a rel share one promise. A json copied outside the app shares its original's id
  (`isCopy`: a job or images point at another json holding it): it gets a fresh id, its own jobs are rekeyed
  (`api.jobs.rekey`) and the json is rewritten. The second of two open jsons with one id also gets a fresh id.

## Saving, DocIO and image GC

- **DocIO:** one `IoQueue` per open doc (`stores/doc/ioQueue.ts`) runs saves, renames, reference import / copy,
  job-result moves, GC, rescan checks and duplicating an open doc, and dispatches estimate / submit calls.
  `doc.runIo((paths) => …)` passes the paths current at run time; never read `doc.rel` when queueing. A failing op
  never blocks later ones. Network calls are dispatched inside (for the path) but awaited outside, so saves never wait
  on PixelLab. Other queues: one per character json (`loadCharacter` / `updateCharacter` read-modify-write, so the
  Character dialog and the estimate cache never clobber each other) and one per closed animation rel (load vs
  rename). `ioBusy` sums them (the explorer postpones focus rescans).
- **Save** (`writeDoc`) serializes the state current when it runs; `writeJson`'s mtime becomes `diskMtime` (a rescan
  never re-reads the app's own write).
  - Ctrl+S blurs the focused field first (it commits), then "Saved"; failures toast.
  - Autosave every `settings.app.autoSaveIntervalSec` (default 60, 0 = off): dirty docs that are not missing or
    closing; waits for a drag; skipped while the app closes; one "Auto-saved".
  - A missing-on-disk doc is recreated only by an explicit save (fails if the character folder is gone).
  - Dirty tab close: Save / Don't Save / Cancel (`tabs.close`; a failed save keeps the tab), then `documents.unload`.
  - App close (`onAppClose`, a `services/lifecycle.ts` handler): cancel the drag, blur, one prompt for all dirty docs
    noting running jobs (they continue next launch), save or discard, GC every doc, drain character queues, flush the
    workspace. The jobs store's handler (registered later, so it runs after) waits ≤ 125 s for in-flight generation
    POSTs.
- **Rename** (`documents.renameAnimation`; explorer F2 and the panel Name field): on the open doc's queue, else under
  the rel lock; validated against sibling jsons. Images first (the exact `<old>.<uid>.png`, else an orphan
  `*.<uid>.png` whose owner json does not exist: heals an interrupted rename), then the json; images roll back if the
  json fails. Jobs are retargeted. Missing-on-disk docs refuse. Never inside `runExclusive` (that pauses its queue).
- **`runExclusive(rel, op, remap)`** (folder / character renames, every explorer delete): waits for older loads and
  closed renames under `rel`, drains and pauses the affected docs' queues, runs `op`, remaps docs (`null` = deleted:
  unloaded without prompt or GC, tab closes), cached characters and job records, then releases. Later loads wait for
  it. `op` must never save or rename an affected doc (its queue is paused).
- **Rescan** (`explorer.refresh` → `fs.scanData` → `documents.reconcile`): a doc missing from the scan is re-checked
  on its queue, then flagged `missingOnDisk`; a clean doc whose mtime changed reloads (`replaceState`, history cleared)
  only if its parsed content differs; dirty docs never reload. Vanished characters leave the cache; changed ones reload.
- **Image GC** (`stores/doc/gc.ts`): candidates are uids in the doc's loaded json, in any state it held, or registered
  with `noteCreatedImage`. It deletes (`fs.deleteFiles`, permanent) only `<name>.<uid>.png` in the doc's character dir,
  never for deleted docs or the name `base`. Job images = for every record still in the jobs store (unacked) of the doc
  (by docId or animRel) its `frameUids`, plus its submitted reference when the doc owns that file.

| Trigger | Live set (plus job images) |
|---|---|
| History eviction (debounced 300 ms) | Current, saved, every undo / redo state, created uids not in any state yet (apply pending) |
| Unload (tab close) | Saved state only: the history and unsaved edits are discarded |
| App close | Saved + current (main's session sweep, `docs/architecture.md`, then removes unsaved images main wrote) |

- **Paid-image safety:** results stay staged in `.ptk/jobs/<key>/` until moved inside the doc's queue; a job is acked
  only after the doc is saved (else once it is clean or closed: `ackOnceSaved`), so until then the journal record keeps
  the frames live for GC and main's sweep and a crash re-applies them; a result with no target goes to the Recycle
  Bin; base images are never candidates; new images are noted before their apply.

## Estimate and generation flow

- **Estimate** (`tools/skelanim/panel/panelActions.ts` `estimateReference` → `jobs.estimate` → `withEstimate`):
  1. Needs a reference image and a non-busy doc. With a reference pose or frames, confirm "Replace the reference
     skeleton?" (checkbox: delete all frames).
  2. `jobs.estimate` uses the source base image's cached keypoints unless `force` ("Re-estimate (≈0.1 gen)"), else
     calls `pixellab.estimateSkeleton` on the animation's reference copy and caches the result on the base image
     (`updateCharacter`). Imported PNGs have no base image: never cached.
  3. Stale guard: doc closed or `reference.image` changed meanwhile → result dropped ("Estimate discarded" toast while
     the doc is still open).
  4. One "Estimate Skeleton" entry: lift the 2D estimate (3D COCO + projection), calibrate rig + reference pose
     (`docs/skelanim/rig.md`), clear `needsEstimate`. Empty track or box checked → frames = [copy of the reference
     pose]; otherwise frames keep their local rotations. Lift / calibration warnings → toast.
- **Camera edits** (direction, view, pitch) re-lift from `reference.estimate` in one entry (`withCamera`); a view
  change resets the pitch to `VIEW_PITCH[view]`. **A new reference image** (Pick / Import) drops the 2D estimate and
  sets `needsEstimate`; the skeleton stays, so Generate still works (with a confirm warning). **OpenPose edit commit**
  (`withReferenceCoco`) forces NECK, recalibrates, and moves the stored estimate to the corrected points, so a later
  camera change re-lifts the correction.
- **Generate** (`generateAnimation` → `jobs.submitGenerate`; the button stays enabled when not ready):
  1. Preflight `generationProblems` (`core/generate.ts`): 3–15 frames, reference image + pose, action, description
     (own or character's), lengths, API key → "Not ready to generate" toast.
  2. `buildGeneration` projects REF + frames in one pass; snapshot = frame uids + poses + camera; `clamped` flag.
  3. Confirm with the cost (`generationCost`), clamp note and `generationWarnings` (needsEstimate, base direction).
  4. `submitGenerate` captures the state at call time, preallocates one image uid per frame (`frameUids`) and submits
     from the doc's queue (for `animRel` / `refImageRel`). Main journals before the POST (`docs/pixellab.md`).
- **Busy:** `jobs.busy(docId)` = an estimate, submit or apply in flight, or an unfinished record: disables Estimate /
  Generate for that doc, drives spinners (tab, explorer via `busyUnder`, footer). Editing is never locked (snapshot).
- **Job records** mirror main (`jobs:update` + `api.jobs.list()` in `initJobs()`, which App.vue calls after
  `restoreWorkspace()` so results land in reopened tabs). Final records are handled once per key, one at a time:
  - `cancelled` → ack. `failed` → error toast + ack; `jobId === null` = "Generation not confirmed" (PixelLab may have
    billed it): sticky toast. Nothing is ever resubmitted.
  - `completed` (`applyCompleted`): wait while the app is closing → a record main no longer has is dropped; an
    incomplete image set is discarded + acked → find the doc (open by id, else load `animRel` headless, else the one
    json in data holding the id, retargeted; none → staged dir to Recycle Bin + toast + ack) → move the PNGs to
    `<anim>.<uid>.png` on its queue (noted as created) → unless the track already holds them (crash between apply and
    ack), cancel the drag (active tab) and apply one "Generate" entry (track = snapshot poses + result images, fresh
    frame uids, nothing stale; the rest of the state kept) → save (autosave wording; a headless doc is then unloaded,
    or opened in a tab if the save failed) → ack, else `ackOnceSaved`.
  - Toast "Animation generated — <name> (N frames)": says when the track or camera changed since submit (Undo restores
    the old track), "Open" unless active; sticky with a taskbar flash when the window is unfocused. A handling error
    gives a sticky toast with Retry; the record is retried next launch.
- Explorer deletes cancel the pending jobs below the target (listed in the confirm); renames retarget them; a json moved
  outside the app is found by id at apply.

## Playback

`stores/playback.ts` + `stores/job/playbackCore.ts` own each doc's target as a `FrameTarget`, never an index. EditorPane
feeds `playback.target(docId)` to `viewport.setTarget`; thumbnails and the toolbar readout read it too.
- REF is the default. A vanished frame uid resolves to the frame now at its last known index (clamped), else REF; a sync
  watcher normalizes stored targets inside `apply` / `undo`, so delete, undo and Generate land on the nearest frame.
- `play()`: active doc only, needs ≥ 1 frame, from REF starts at frame 1, loops 1..N (REF never in the loop). rAF
  accumulator at `doc.fps` clamped 1..60 (invalid → 12); a gap > 250 ms counts as one frame.
- Pauses: tab switch, emptied track, `step`, seeks, `setTarget(REF)` while playing, an editor or frame drag start, a
  thumbnail click. `setTarget(frame)` while playing continues from there.
- `step(±1)` clamps REF..N, no wrap (REF + 1 → frame 1). `seekStart` → REF, `seekEnd` → last frame (or REF).

## UI

Paths below are relative to `src/renderer/src/tools/skelanim/` unless they start with `stores/`. **Layout**
(`SkelAnimTool.vue`):
```
Explorer (180–560 px, persisted) | TabBar
                                 | ControlPanel (fixed) | EditorToolbar + viewport (align button, stale badge)
                                 |                      | splitter (thumbnail height 56–240, default 104, persisted)
                                 |                      | FrameToolbar + frame strip
```
No tab open: a placeholder with hints; the editor stays mounted (`v-show`) so WebGL is created once. The panel is keyed
by doc id, so a field focused across a tab switch never commits into the new doc.

**Explorer** (`explorer/ExplorerPanel.vue`, `ExplorerNode.vue`, `explorerOps.ts`, `stores/explorer.ts`):
- Nodes: folders (root only), characters, animations, broken characters (json without dir). Keyed by rel,
  case-insensitively, so expansion (persisted) and selection survive rescans. Rows show open, dirty and busy (a
  collapsed container shows its descendants'). The toolbar and the per-kind context menus live in `ExplorerPanel.vue`.
- Filesystem ops run one at a time on `explorer.runOp` (never await an op from an op); ops touching open docs go
  through `documents.runExclusive` / `renameAnimation`.
- Create: unique default name ("New Character 2"), then inline rename. New Character goes into the selected folder (or
  the selected item's folder, else root), writes json then dir, then opens the Character dialog. New Animation: camera
  + template from the character defaults, fps from settings, the first base image facing the default direction copied
  in, projection framed for its canvas; opens a tab.
- Character rename: json, then dir (json rolled back on failure). Duplicate: new id and name ("Walk 2"), images copied
  to new uids, an open doc copied as edited (unsaved changes included).
- Delete: counts from a fresh scan; the confirm lists the tabs that close (unsaved marked) and the jobs it cancels. All
  to the Recycle Bin (`fs.trash`): a character's dir then json; an animation's json then every file whose parsed owner
  equals its name (case-sensitive). Repair: recreate the missing character dir, or (confirmed) the lost character json.
- Rescans: Refresh, window focus (300 ms debounce, postponed while IO or an op runs), after each op, and when an open
  doc's rel is not in the tree (panel rename). Activating a tab reveals its animation.

**Character dialog** (`CharacterDialog.vue` via `openCharacterDialog`, `explorer/characterDialog.ts`): Import PNG
(label = file name, direction from `characterForm.guessDirection`) and Remove (to the Recycle Bin; the confirm lists
animations using it as reference source, advisory only since each owns its copy) write at once; the rest on Save, all
through `updateCharacter` producers touching only their fields. Opened by double-click / Enter on a character, Edit
Character…, New Character and the panel's reference preview.

**Tabs** (`tabs/TabBar.vue`): `*` dirty, spinner busy, icon missing on disk, dim character suffix when names clash.
Multi-tab closes stop at the first Cancel. Tabs persist and reopen.

**Control panel** (`panel/ControlPanel.vue`, `panelActions.ts`, `GenerateFooter.vue`): scrolling sections plus a pinned
footer (frame count, cost, job status, Generate).
- Text fields (`CommitField.vue`) commit once on Enter / blur and revert on Escape. Name commits through
  `documents.renameAnimation`; an error shows and the field reverts.
- Estimate is a split button: the main action uses the cached estimate when possible, the menu adds "Re-estimate
  (≈0.1 gen)". The pitch slider makes one merged entry per drag.
- Length counters ("n / max") show only while the field is focused, out of flow (no layout shift).
- Generate is disabled only while the doc is busy; when not ready, the preflight toast says why.

**Editor** (`editor/EditorPane.vue`, `EditorToolbar.vue`, `docSource.ts`; viewport internals: `src/renderer/src/editor/`):
- One `EditorViewport` for the app, mounted once and re-pointed with `setDocument`. EditorPane keeps it, the per-doc
  `DocSource`s and camera `ViewState`s in plain variables / Maps (never reactive; views are in-memory only, a newly
  shown doc opens aligned). A closed doc's texture cache is freed (`forgetDocument`). Dev automation hooks:
  `docs/architecture.md` (Testing and verification).
- `docSourceFromHandle` (`docSource.ts`, shared with the testbed) maps commits to `doc.apply`; EditorPane's `sourceFor`
  passes an `imageUrl` that builds the `ptk-asset` URL from the doc's current name at request time (follows renames).
  `doc.version` drives `viewport.refresh()`; `displayChange` (Hips mode, leaving REF ends OpenPose edit) updates the
  toolbar and workspace.
- `EditorToolbar.vue` only emits (`set` with a `DisplayOptions` patch, `resetPose`); `EditorPane.vue` handles them. A
  new pose action copies `resetPose()`: act on the shown track frame only, `viewport.cancelInteraction()`, then one
  `doc.apply('<Label>', (s) => withTargetPose(s, t, …))` that returns `s` for a no-op.
- Toolbar toggles persist in the workspace `display`. Defaults: `DEFAULT_DISPLAY`, `DEFAULT_GHOST_COLOR`,
  `GHOST_COUNT_MAX` (`src/renderer/src/editor/types.ts`), with Settings › Editor seeding floor / frame image / OpenPose
  (a change there applies at once); `parseWorkspace()` sanitizes them. OpenPose edit is never restored, Move is saved
  as Rotate.
  - Frame image: frames without one show the reference faded. Skeleton hidden = no rig picking, no gizmo.
  - Ghost frames (off by default): the committed poses of up to N frames before the shown one (`ghostPoses`; no wrap,
    none on REF or frame 1), drawn by `editor/GhostView.ts` as our rig in the ghost colour, every part at
    `GHOST_OPACITY` × its normal opacity, under the active skeleton; independent of Skeleton, never picked.
  - OpenPose edit (REF only, needs an estimated reference): entering from a frame jumps to REF, showing a frame ends
    it; rig picking off; drag a point (NECK excluded, derived), Alt = depth; one "Move <point>" entry recalibrates.
  - Rotate / Move (Hips only, transient: a fresh Hips selection starts in Rotate; clicking the selected Hips toggles);
    gizmo space local / world; ortho (default; aligned view = the PixelLab canvas exactly) / perspective; Reset Pose
    (track frames only).
- Align button (top right): Align / Aligned (disabled, no previous view) / Previous view. Aligned is an explicit flag:
  set by align, cleared by orbit, pan, wheel and fly keys. "Stale image" badge when Frame image is on and the shown
  frame's image predates its pose edits.

**Frame track** (`frametrack/FrameTrack.vue`, `FrameThumb.vue`, `FrameToolbar.vue`, `frameOps.ts`):
- Strip `[REF] 1 2 … N [+]`. REF is pinned (Clone inserts frame 1; Delete disabled). Only numbered frames drag
  (vue-draggable-plus; the library's DOM move is reverted and the doc re-renders): one "Move Frame" entry. "+" appends
  a copy of the last pose, else the reference pose, else the idle pose; Clone inserts after. Menus, toolbar buttons
  and keys all call `frameOps.ts` and select its result.
- Keys are registered in `FrameTrack.vue` (`offKeys`, unregistered on unmount) and decline unless `isCurrent()` (the
  track's doc is the active tab; `docs/ui.md` Shortcuts).
- Thumbnails (canvas 2D, `thumbDraw.ts`): pixelated image (frames without one show the reference faded), the COCO-18
  keypoints PixelLab receives in the OpenPose palette, the number, a "stale" badge. Redraw only on frame object,
  reference or projection-key change, image load, or a live pose targeting them.

## Keyboard and mouse

Zone = the `data-zone` pane last clicked or focused; routing, text-field and modal rules: `docs/ui.md` (Shortcuts).

| Zone | Input | Action |
|---|---|---|
| global | Ctrl+S | Save the active doc (also from text fields; blurs the field first) |
| global | Ctrl+Z / Ctrl+Y, Ctrl+Shift+Z | Undo / redo the active doc (text fields keep native undo; blocked mid-drag) |
| global | Ctrl+, | Settings |
| explorer | Up / Down, Home / End, PageUp / PageDown | Move the selection |
| explorer | Left / Right | Collapse or go to parent / expand or go to first child |
| explorer | Enter, double-click | Folder: toggle; character: Character dialog; animation: open; broken: repair |
| explorer | F2 / Delete | Inline rename (not broken characters; Enter commits, Escape cancels, blur commits a valid name) / delete with confirm |
| explorer | Click, right-click | Select (an animation also opens); empty space deselects; context menu (also the menu key) |
| tabs | Click, middle-click or ×, drag, right-click, wheel | Activate, close, reorder, close menu, scroll sideways |
| panel | Enter or blur, Escape, Shift+Enter | Commit a field, revert it, newline in Description |
| editor | LMB drag / MMB drag / wheel | Orbit / pan / zoom (a click on empty space deselects) |
| editor | Click a joint or bone | Select its bone; click the selected Hips again to toggle Rotate / Move |
| editor | Drag the gizmo; OpenPose edit: drag a point, Alt+drag | Rotate or move (one undo entry); move the point in the screen plane / in depth |
| editor | W / S, A / D, Space / C, + Shift | Fly forward / back (zoom in ortho), strafe, up / down, faster (viewport focused) |
| editor | Escape | Cancel the running drag (viewport focused) |
| editor, frametrack | Left / Right | Step frames (pauses; blocked mid-drag) |
| frametrack | Delete | Delete the active frame (no-op on REF) |
| frametrack | Click, drag, right-click, wheel | Select (pauses), reorder, Clone / Delete or Add Frame menu, scroll sideways |
| Character dialog | Escape | Close (asks to discard unsaved edits) |
