# Rig math

Read before changing `src/renderer/src/core/rig/`, how the editor draws or aligns the rig, or how poses become PixelLab
keypoints. Document flows that call this math (Estimate Skeleton, camera change, COCO edit, Generate) are in
`docs/skelanim/skelanim.md`; the PixelLab wire format is in `docs/pixellab.md`.

## Coordinates

- three.js world: right-handed, **Y up**, floor at Y = 0. The template character is exactly 1.0 tall.
- **Canonical character space:** the character faces **+Z** and its **left is +X**. `Pose` (`src/shared/pose.ts`),
  `RigCalibration` and `reference.coco` exist only in this space.
- **Direction is a camera property.** A direction, view or pitch change moves the camera (`cameraBasis`), never a
  pose, so track frames serve every direction. Only the reference pose, rig and projection are re-derived (re-lift).
- Quaternions are unit `[x, y, z, w]` (three.js order). `qMul(a, b)` = a·b applies b first. `Pose.rot` holds LOCAL
  rotations (rest = identity); `qW(child) = qW(parent)·qL(child)`.
- **Mirroring** (`mirror.ts`, across X = 0): p → (−x, y, z), q → (x, −y, −z, w), Left* ↔ Right* swapped; `mirrorPose`
  also negates `root.x`. FK of a mirrored pose is the exact mirror only with `mirrorCalibration` as well, and a
  calibrated rig is asymmetric. Unity export (not implemented; left-handed, +X = character right) needs the same p / q
  maps without the swap.

## Rig

| File | Key exports | Main callers outside the folder |
|---|---|---|
| `rigDef.ts` | `BONES`, `PARENT_INDEX`, `BONE_INDEX`, `END_SITES`, `LIMB_CHAINS`, `TEMPLATE`, `JOINT_FOR_COCO`, `HUMAN_NAMES` | editor (`RigMeshes`, `Picker`, `GizmoController`), toolbar |
| `fk.ts` | `fk`, `cocoFromFk`, `cocoFromPose`, `worldRotations`, `createFkResult`, `createCoco` | `EditorViewport`, `GhostView`, `docState.ts` |
| `poses.ts` | `templateCalibration`, `restPose`, `idlePose`, `clonePose`, `calibrationHeight`, `restRootHeight` | `model.ts` defaults, frame ops, `generate.ts` |
| `calibrate.ts` | `calibrate`, `forceNeck`, `cocoResidual`, `HEAD_TILT_KEEP` | `docState.ts` |
| `lift.ts` | `lift`, `faceWeightsFromEstimate`, `LiftReport` | `docState.ts` |
| `projection.ts` | `cameraBasis`, `toCanvas`, `fromCanvas`, `translateAnchor`, `defaultProjection`, `alignedView`, `projectToKeypoints`, `projectPose`, `projectPoseSequence`, `projectPoseForDisplay`, `projectCocoForDisplay`, `createProjectScratch` | `generate.ts`, `docState.ts`, `model.ts`, `frametrack/thumbDraw.ts`, `EditorViewport`, `CameraRig`, testbed |
| `coco.ts` | `COCO` (named indices), `LABEL_INDEX`, `COCO_LIMBS`, `OPENPOSE_COLORS`, `limbColor`, `humanLabel` | `CocoView`, `EditorViewport`, `thumbDraw.ts`, testbed |
| `math.ts` | vec3 / quaternion helpers (optional `out`), `qSwingTwist`, `qPow`, `fitRotation` (Horn) | rig internals, testbed |
| `mirror.ts` | `mirrorPose`, `mirrorCalibration`, `mirrorCoco` | `scripts/verify-rig.ts` only |

Hierarchy (Unity HumanBodyBones subset: 22 bones, 5 end sites in brackets):

```
Hips (root, the anchor)
├─ Spine → Chest → UpperChest
│    ├─ Neck → Head → [HeadTop]
│    ├─ LeftShoulder → LeftUpperArm → LeftLowerArm → LeftHand → [LeftHandEnd]
│    └─ RightShoulder → RightUpperArm → RightLowerArm → RightHand → [RightHandEnd]
├─ LeftUpperLeg → LeftLowerLeg → LeftFoot → LeftToes → [LeftToesEnd]
└─ RightUpperLeg → RightLowerLeg → RightFoot → RightToes → [RightToesEnd]
```

- `BONE_NAMES` (`src/shared/pose.ts`) is hierarchy order, parents first; `BONES[i].name === BONE_NAMES[i]` and every
  per-bone array (FK buffers, `PARENT_INDEX`) uses it. `*Shoulder` bones are clavicles (UI "Left Clavicle").
- **Rest pose** = T-pose, identity local rotations. Rest directions: spine/neck/head +Y, left arm +X, right arm −X,
  legs −Y, foot toward the toes, toes +Z.
- **FK** (`fk`): `p(child) = p(parent) + qW(parent)·offset(child)`, end sites included. Hips sits at `Pose.root` with
  `qW = qL(Hips)`; its offset is unused.
- **Offsets** (`RigCalibration.offsets`, `core/model.ts`): each head relative to the parent's head, in the parent's
  rest frame. Proportions belong to the animation (set by calibration); poses carry only `root` + local rotations, so
  track frames pick up new proportions automatically.
- **Bend normals** (`LIMB_CHAINS`, rest direction `d0`, hinge `n0`): a positive rotation about `n0` flexes the joint.
  Legs (1,0,0): the shin swings back (−Z). Left arm (0,−1,0), right arm (0,1,0): the forearm swings forward (+Z). `ref`
  (UpperChest for arms, Hips for legs) is the frame of the straight-limb fallback. Calibration walks the chains; they
  are also meant for IK, which does not exist yet.
- **Template** (`TEMPLATE`, chibi): HeadTop y = 1, Hips y = 0.35 (= `restRootHeight`), toes on the floor.
  `torso` 0.32 = Spine + Chest + UpperChest + Neck offsets and `ankleHeight` 0.04 = −Toes offset y must stay equal:
  then lift's s_char equals calibrate's and the lowest toes land exactly on Y = 0. Clavicle heads sit at
  (±0.2·halfShoulder, neckLen, 0) above UpperChest so rest COCO NECK = Neck head. Face offsets: head-local, h = 0.31.
- **H_char** (`calibrationHeight`, stored as `rig.height`) = rest HeadTop y − lowest rest Foot/Toes/ToesEnd y. It
  scales the z_index tie band, `depth` and `defaultProjection`.
- **Editor:** `RigMeshes` draws head → tail (end site, else first child in `BONES` order; thighs and clavicles get link
  lines). `GizmoController` writes local rotations (`qW(parent)⁻¹·proxy.q`); only Hips translates (`Pose.root`).

## COCO-18 mapping

`cocoFromFk` follows `JOINT_FOR_COCO` (`rigDef.ts`):

| COCO joints | Source |
|---|---|
| SHOULDER, ELBOW, ARM (wrist) | UpperArm, LowerArm, Hand heads |
| HIP, KNEE, LEG (ankle) | UpperLeg, LowerLeg, Foot heads |
| NECK | midpoint of the two UpperArm heads (derived) |
| NOSE, EYES, EARS | `Head.pos + qW(Head)·calib.face[k]` (rigid, template-aligned frame) |

- Order is `SKELETON_LABELS` (`src/shared/pixellab.ts`), the OpenPose COCO-18 index order. `*ARM` = wrist, `*LEG` =
  ankle (`humanLabel` shows "Wrist"/"Ankle"). Use `COCO.*` instead of literal indices.
- **NECK is never independent:** FK can only put it at the shoulder midpoint. `calibrate` forces it (`forceNeck`),
  `reference.coco` stores the forced value, `lift` replaces the 2D NECK with the 2D shoulder midpoint, and COCO edit
  mode never picks it and recomputes it live during drags (`EditorViewport.moveCocoDrag`).

## Calibration

`calibrate(coco18, { weights, prevPose, headTilt })` → `{ calib, pose, residual, warnings }`: the 18 canonical COCO
points of the reference → the animation's proportions (`RigCalibration`) + the reference pose.
- **Guarantee:** `cocoFromPose(pose, calib)` reproduces the NECK-forced input to < 1e-6 (≈1e-15 in practice) for any
  finite input, degenerate ones included (they become warnings, never a broken fit). Throws on non-finite input.
- Lengths are measured per side, so a calibrated rig is left/right asymmetric. Template-derived offsets (Head, Toes,
  end sites) scale by `s_char = |NECK − hipC| / TEMPLATE.torso` (1, with a warning, when NECK sits on the hip centre).

Top-down solve: each bone's world rotation, then FK places the child's head. `calibrate()` marks the steps inline.
1. **Hips:** `Pose.root` = hip centre; X exactly along the hip line, up halfway between +Y and the torso direction (the
   pelvis takes half the lean). Warns when the pelvis faces away from +Z: LEFT / RIGHT are probably swapped.
2. **Spine:** straight from the Spine head to NECK, split by template fractions; the shoulder-line twist is spread
   over Spine, Chest, UpperChest as swing·twist (twist on the RIGHT; the other order misses NECK). The Neck head lands
   exactly on NECK.
3. **Clavicles:** heads at (±0.2·halfShoulder, neckLen, 0) in UpperChest; UpperArm offset = the measured distance.
4. **Limbs** (`solveLimb`): the hinge normal blends a fallback with the measured `norm(d × t)` by bend angle
   (`BLEND_LO`, `BLEND_SPAN`). The fallback comes from the UpperChest / Hips frame, never the clavicle (arbitrary
   roll), or from `prevPose`'s hinge, so near-straight limbs keep it. A measured normal opposing the fallback is
   hyperextension, not a 180° twist. The end head lands exactly on the wrist / ankle. Hand and Toes: identity local;
   Foot: flat, yawed to the pelvis's ground-projected forward.
5. **Neck / Head:** weighted Kabsch fit (`fitRotation`) of the 5 face points (lift's `faceWeights`). The yaw is kept and
   the tilt scaled by `HEAD_TILT_KEEP`: pixel-art faces are drawn level and frontal, so the raw fit reads pitched /
   rolled heads. Neck takes part of it. `face[k]` offsets are measured from the FK head, so exactness never depends on
   the head fit.
6. **Finish:** end sites × s_char; `height = calibrationHeight(calib)`; `pose.rot` in `BONE_NAMES` key order
   (byte-stable saves).

Callers (`core/docState.ts`): `relift` (Estimate Skeleton, camera change) passes lift's face weights and
`prevPose = reference.pose`, and also installs lift's projection; `withReferenceCoco` (COCO edit commit) recomputes the
weights from the pre-edit stored estimate and keeps the projection. Track frames keep their roots and local rotations.

## Projection

`projection.ts`, orthographic. Yaw θ = `DIRECTION_YAW` (index·45° in `DIRECTIONS` order: south 0°, east 90°); pitch
φ = `pitchDeg` (view presets `VIEW_PITCH`, `docs/pixellab.md`). The camera sits above the subject, looking down by φ:

```
r  = ( cosθ,       0,     sinθ      )   screen right
u  = ( sinθ·sinφ,  cosφ, −cosθ·sinφ )   screen up
c  = (−sinθ·cosφ,  sinφ,  cosθ·cosφ )   toward the camera; r × u = c
ch = (−sinθ,       0,     cosθ      )   horizontal toward the camera
```

- φ > 0: a nearer point sits lower on the canvas. South shows the subject's RIGHT on image-left; east, its RIGHT nearer.
- **World → canvas** (`toCanvas`, y down): `px = a_x + ppu·(P·r)`, `py = a_y − ppu·(P·u)`; `Projection = { ppu,
  anchorPx }`, anchor = canvas position of the world origin. PixelLab gets x = px/W, y = py/H.
- **Inverse** (`fromCanvas`): `sx = (px − a_x)/ppu`, `sy = (a_y − py)/ppu`, `P = sx·r + sy·u + d_c·c`.
- **Anchor rule** (`translateAnchor`): translating the world by T keeps every canvas position iff
  `a' = a − ppu·(T·r, −T·u)`; T·c is free.
- **Two depths, never mixed:** `d_c = P·c` (camera depth; lifting only, where bone lengths are Pythagorean along c) and
  `d_h = (P − hipC)·ch` (horizontal, from this frame's hip centre; z_index and `depth`).
- `defaultProjection` (before any estimate): ppu = 0.8·H/H_char, anchor (W/2, 0.9·H).
- **Aligned editor view** (`alignedView`): target = ((W/2 − a_x)/ppu)·r + ((a_y − H/2)/ppu)·u (the canvas centre),
  camera at target + k·c with up = +Y, ortho half extents W/(2·ppu) × H/(2·ppu). The image plane (`ProjectionPlane`)
  is spanned by r and u through the target: perpendicular to c, tilted by φ, not vertical. `EditorViewport.rebuild`
  feeds it to `CameraRig.setAlignSpec` and `ProjectionPlane.setCanvas`; `CameraRig.alignedPose` snaps the ortho zoom
  to a whole number of device px per texel when the canvas fits.
- **Entry points:** `projectToKeypoints(coco18, ctx)` (raw world points) ← `projectPose` (adds FK, hip centre, head
  forward, H_char; thumbnails call it with a shared scratch) ← `projectPoseSequence` (Generate, `core/generate.ts`:
  reference + frames with hysteresis) and `projectPoseForDisplay` (doc-level wrapper, testbed). `projectCocoForDisplay`
  projects raw COCO points during a COCO drag (no FK; head forward ≈ nose − ear midpoint).
- Off-canvas joints are clamped to [0, 1] and listed (`clamped`, `clampedJoints`); Generate warns before spending.

## z_index and depth

- **Ranking:** `z_index` is a unique integer rank 0..17, **nearest = 17** (the estimate's float z_index is also
  higher = nearer, but in coarse layers: nearest 0, the rest negative). Descending sort on one scalar key per joint,
  `k_j = d_h,j + ε·(0.5·prio_j/4 + 0.5·prevRank_j/17)`, ε = 0.02·H_char; ties rank the lower label index nearer. A
  single key is a strict total order; a pairwise "within ε, use priority" comparator can cycle.
- **Priority** (`Z_PRIORITY`): NOSE 4, EYES 3, wrists = elbows = knees 2, EARS 1, rest 0 (near-ties favour joints whose
  occlusion matters most). Face priorities are negated when the head faces away: `(qW(Head)·+Z)·ch < 0`.
- **Hysteresis:** `prevRanks` = the previous frame's ranks within one submission: the reference first (→
  `first_frame_keypoints`), then frames 1..N, no wrap-around. A joint overtakes one ranked Δr above it last frame only
  when it is nearer by more than 0.5·ε·Δr/17 (plus the priority term). Only Generate chains frames; thumbnails project
  each pose alone.
- **depth** (only with `sendDepth`, off by default): `clamp(round(128 + 255·d_h/H_char), 0, 255)`, 128 at the hip
  centre, higher = nearer. PixelLab does not document its depth axis; horizontal is our choice.

## Lifting

`lift({ estimate, canvas, direction, pitchDeg })` → `{ coco, projection, faceWeights, report }`: the `estimate-skeleton`
2D result → 18 canonical 3D reference points + the projection that maps them back onto it. **Every joint but NECK keeps
its 2D position exactly; lifting only chooses each joint's camera depth d_c.** Caller: `docState.relift`, on Estimate
Skeleton and on every direction / view / pitch change (re-lifting `reference.estimate`, one undo entry).

1. **Input:** canonical order (`canonicalKeypoints`; throws unless each of the 18 labels occurs once). NECK := 2D
   shoulder midpoint (`report.neckResidualPx`).
2. **Template:** the template rig's canonical idle pose projected with basis(θ, φ), **never yawed by θ** (the camera
   already carries θ; yawing both rotates by 2θ). A relative torso yaw δ is fitted instead.
3. **Torso yaw δ, width scale k** (`fitTorso`): grid search plus refinement, scored by the 2D torso error plus priors
   on δ and ln k (`SIGMA_YAW`, `SIGMA_LN_K`; weaker priors pushed real sprites to extreme widths). The sign comes from
   the LEFT / RIGHT z_index of shoulders and hips (RIGHT nearer ⇔ sin(θ + δ) > 0); south / north without a z side →
   δ = 0 (frontal width and yaw are not separable). Limit hits, an unsatisfiable sign and no fit warn.
4. **ppu:** least squares over the torso and the limb bones that show clearly (`RHO_CLEAR`); `g = s/ppu` = the torso's
   world scale vs the template.
5. **Torso depths:** template points at δ, k, scaled by g; hip centre d_c = 0, NECK = shoulder mean.
6. **Limb depths,** parent → child, from the 2D length m and the projected fraction ρ of the yawed template bone: a
   clear bone keeps the template's out-of-plane angle (a limb drawn short reads as short, not tilted); others take the
   template length × g. Sign, first decisive rule (`report.limbRules`): `zIndex` (child vs parent layers ≥ `Z_STEP`
   apart and only one sign consistent), `template`, `plausibility` (limbs reach forward, the shin goes back); else
   `flat`.
7. **Face** (`fitFace`): head yaw ψ near δ (prior) with the face's 2D offset and scale; a face turned away
   (cos(θ + δ) < −0.5) takes ψ = δ. `faceWeightsFromEstimate`: 0.25 for face points on the group's lowest z_index
   (unless all equal) and the lower one of a twin pair within 1 px, else 1; passed on to `calibrate`.
8. **Back to world:** `fromCanvas` with the anchor at the 2D hip centre; translate so the hip centre has X = Z = 0 and
   the lowest ankle sits at `TEMPLATE.ankleHeight·s_char` (calibrate's flat feet then put the lowest toes exactly on
   Y = 0); `translateAnchor` moves the anchor along.
9. **Guarantee:** the 17 non-NECK joints reproject to < 1e-6 px (`report.maxResidualPx`, warns otherwise).

## OpenPose palette

Pinned to the controlnet_aux `draw_bodypose` colours; all in `coco.ts`, shared by `editor/CocoView.ts`,
`tools/skelanim/frametrack/thumbDraw.ts` and `src/renderer/src/testbed/preview2d.ts`. Do not change values or order.
- Joint i: `OPENPOSE_COLORS[i]` (18 RGB in COCO index order, red → yellow → green → cyan → blue → magenta).
- Limb j (the j-th pair of `COCO_LIMBS`, OpenPose render order): `limbColor(j)` = joint colour j × 0.6, truncated
  like controlnet_aux `int(c·0.6)`. Limb colours follow the limb index, not its joints.

## Invariants and tests

`npm run test:rig` (`scripts/verify-rig.ts`, part of `npm test`): about 200 numeric checks, no Electron, no API
calls. Run it after any change here. Fixtures: `testbed/fixtures/*.estimate.json` (two south, two east; "right" in
the name means east). `npm run dev:testbed` drives the real viewport with them.

| Invariant | Threshold / expectation |
|---|---|
| FK∘calibrate exact | residual < 1e-6: idle, T-pose ± jitter, straight / bent / folded / hyperextended limbs, crouch, torso twist, head cases, 30 random poses, 20 arbitrary point sets, degenerate sets, mirrored input |
| lift → project exact | 17 joints < 1e-6 px for the lift and for FK of the calibrated pose; every fixture × 8 directions × 3 pitches finite and exact; re-lift at pitch 0/35 and `withCamera` exact |
| Calibration recovers truth | idle → template proportions, identity Neck/Head, 0° head pitch; bent limbs, crouch, torso twist < 1e-6°; straight-arm twist < 15° (no 180° flips); `prevPose` keeps the hinge |
| Head regularization | yaw kept, tilt = 20% of the raw fit (< 1e-6°); fixtures: south pitch/roll vs chest < 5°, east roll < 8° |
| Lift plausibility | hip centre X = Z = 0; lowest toes at Y = 0 (1e-9); south δ within ±1°; east RIGHT nearer, −60° < δ < 0, pelvis faces screen-right; synthetic idle recovered (3D < 1e-3, yaw < 0.5°, \|k − 1\| < 0.01); yawed torso sign right |
| Camera | basis orthonormal, r × u = c (24 combos, 1e-12); facing matches the direction name; `fromCanvas`, `translateAnchor`, `alignedView` centre exact |
| z_index | unique ranks 0..17; priority order; strict order where an ε-comparator cycles; hysteresis band; depth formula; no `depth` without sendDepth; clamping reported |
| Sequence | result[0] = the reference alone = the estimate (17 joints); small perturbations never flip; a real change reorders |
| Mirror | each mirror twice = identity; FK(mirrored) = mirrorCoco(FK) < 1e-12; projection x' = 2a_x/W − x under θ → −θ |
| Persistence | save → load → save byte-identical; the 6-decimal saved rig reproduces `reference.coco` < 1e-4 |
| Performance | buffered `fk` + `cocoFromFk` < 20 µs per call (≈0.5 µs), identical to the allocating version |

Cross-file invariants:
- `reference.coco` = `cocoFromFk(fk(reference.pose, rig))` (NECK forced, < 1e-6) whenever both are set: `relift` and
  `withReferenceCoco` store calibrate's NECK-forced input, `withTargetPose` re-derives it by FK after a REF pose edit.
- `fk`, `cocoFromFk`, `worldRotations` allocate nothing with buffers. One `createProjectScratch()` per caller
  (`thumbDraw.ts` shares one: projection is synchronous). `projectPose` / `projectToKeypoints` still allocate the
  small per-call arrays (keys, ranks, keypoints).

### Known limitations

- Torso yaw is biased toward 0° by its priors; frontal at pitch 0, little beyond its sign is observable.
- Lift's face fit models head yaw only; calibrate keeps 20% of the head tilt, so east fixtures still show up to ~7°
  roll vs the chest at top-down pitches.
- A slightly bent, noisy limb takes its hinge axis from the noise (never a 180° flip).
- Saves round to 6 decimals: FK of a loaded pose differs from the saved `reference.coco` by ≈1e-6.
- H_char changes when a re-lift uses another pitch (affects only the tie band and the depth scale).
- Recalibration keeps each track frame's root; nothing re-floors frames when leg lengths change.
- A REF gizmo edit is lost on the next re-lift (it starts from `reference.estimate`).
