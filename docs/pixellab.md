# PixelLab API

Read before writing or changing anything that calls PixelLab. API facts come from the v2 OpenAPI spec (checked
2026-10-02) plus what live calls and the fixtures showed. Where this doc and the code disagree, the code wins.

## Endpoints and auth

- Base URL `https://api.pixellab.ai/v2` (`pixellab.baseUrl` in `appSettings.config`). `checkedBase()` accepts only
  https on `pixellab.ai` or a subdomain, with no credentials, query or fragment, so the key cannot leak elsewhere.
- Headers: `Authorization: Bearer <key>`, `Accept: application/json`, `Content-Type: application/json` with a body.
  FastAPI checks auth before the body (no key → 401 `Not authenticated`; bad key → 401 `Invalid API token`).
- **Every request object has `additionalProperties: false`.** One extra key (body, keypoint or image) → 422
  `{detail: [{loc, msg, type, input, ctx}]}`. There is no `image_size`, no width/height on images, no camelCase `zIndex`.
- Image in a request: `{type: "base64", base64: "<raw base64, no data: prefix>", format: "png"}`.

| Method + path | What | Cost |
|---|---|---|
| `POST /estimate-skeleton` | Synchronous. Sprite → 18 keypoints. (The v3 description says GET; GET returns 405.) | ≈0.1 gen |
| `POST /animate-with-skeleton-v3` | Asynchronous. Returns a background job id | 2–4 gen |
| `GET /background-jobs/{id}` | Poll a job | free |
| `DELETE /background-jobs/{id}` | Cancel a job | free (a running job may still bill) |
| `GET /balance` | `{subscription: {generations (remaining), total}, credits: {usd}}` | free |

## estimate-skeleton

- Body `{image: <Base64Image>}`, nothing else. Canvas must be square 16/32/64/128/256 (`ESTIMATE_CANVAS_SIZES`).
  **Pad, never rescale**, and send the same padded PNG later as `first_frame` so the coordinates stay valid. The app
  pads every import (`padToSquare()`, `src/main/png.ts`); estimate and submit both send the animation's reference PNG.
- Response: `{keypoints: [{x, y, label, z_index}] × 18, usage: {type: "generations", generations: 0.1}}`. Seen live:
  - No `depth`, and `usage` has no `usd` key. The spec's 200 example with an `image` field is wrong.
  - **Keypoints are not in canonical order** (NOSE, LEFT EYE, RIGHT EYE, …, NECK last). Match them by label.
  - `z_index` is a **float** in coarse layers: nearest = 0, the rest negative, with half steps (−3.5, −0.5).
    Front view: nose, elbows, wrists and knees are 0; eyes, shoulders, hips, ankles and NECK are −1; ears are −2.
  - It is not a reliable facing cue. The east-facing merchant fixture got the front-view pattern, while the
    east-facing peasant got RIGHT limb joints 0/−1 and LEFT −3/−4. NECK is the exact shoulder midpoint in every fixture.
- Errors: 401, 402, 422, 429, 529. Latency is unmeasured (probably seconds); the client timeout is 120 s.

## animate-with-skeleton-v3

Beta. Needs Tier 1 or higher (403 below that). The body is exactly these keys (`AnimateV3Body`):

| Key | Rule |
|---|---|
| `description` | Non-empty, ≤1000 chars (the cap is MCP's; the app enforces it). Appearance noun phrase: colours, clothing, held items. No pose, motion, style or background |
| `action` | Non-empty, ≤100 chars (same). Short motion label (`walk`, `attack`) |
| `direction` | `DIRECTIONS` enum. Required, no default |
| `view` | `side`, `low top-down`, `high top-down`, spelled with spaces (`low-top-down` is PixelLab's private web API; never send it). Default `low top-down`. Must match the sprite |
| `first_frame` | Base64Image PNG, at most 256×256. Output frames are this size |
| `first_frame_keypoints` | 18 joints: the pose the sprite is **already in** |
| `keypoints` | 3..15 frames of 18 joints (the limit is stated in prose, not in the schema) |
| `template_id` | `mannequin` (default), `bear`, `cat`, `dog`, `horse`, `lion`. Supplies any missing `depth` |
| `seed` | Integer ≥ 0, default 0 = random. **Never `null`** (422) |
| `no_background` | Boolean, default true |

- **`first_frame_keypoints` vs `keypoints`:** the model redraws the reference in `first_frame_keypoints` to learn its
  colours and background key; a mismatch costs transparency and colour accuracy. That frame is not returned: the
  result has **exactly `len(keypoints)` images**, in input order (text-v3 and PixMiniMax return N+1 instead).
- To start the clip in the reference pose, `keypoints[0]` must equal `first_frame_keypoints`. The app only seeds
  frame 1 with the reference pose when an estimate lands on an empty track (`withEstimate()`).
- 200 `{background_job_id, status: "processing", usage: null}` means accepted, not finished.
- Errors: 401, 402 (credits), 403 (tier), 422, 429 (`Too many concurrent background jobs`).
- PixelLab calls its direction and view controls "quite weak". Each direction needs its own reference sprite.

## Keypoints

Input joint `{label, x, y, z_index, depth?}`. `label`, `x` and `y` are required; `z_index` defaults to 0. Labels in
canonical order (`SKELETON_LABELS`; the spec enum order is the OpenPose COCO-18 index, and each label means its COCO joint):
0 `NOSE`, 1 `NECK`, 2 `RIGHT SHOULDER`, 3 `RIGHT ELBOW`, 4 `RIGHT ARM`, 5 `LEFT SHOULDER`, 6 `LEFT ELBOW`, 7 `LEFT ARM`,
8 `RIGHT HIP`, 9 `RIGHT KNEE`, 10 `RIGHT LEG`, 11 `LEFT HIP`, 12 `LEFT KNEE`, 13 `LEFT LEG`, 14 `RIGHT EYE`,
15 `LEFT EYE`, 16 `RIGHT EAR`, 17 `LEFT EAR`.

- **`*ARM` = wrist and `*LEG` = ankle.** PixelLab aims the forearm along ELBOW→ARM and the shin along KNEE→LEG.
  Bones: NECK–NOSE–EYE–EAR; NECK–SHOULDER–ELBOW–ARM; NECK–HIP–KNEE–LEG. Rig bone mapping: `docs/skelanim/rig.md`.
- Labels are uppercase with a single space. Send all 18, each once, in canonical order. The server matches by
  label, but `validateAnimateRequest()` insists on canonical order. Occluded joints stay in the array with a low `z_index`.
- **Coordinates** are fractions of the `first_frame` canvas you send, padding included: x = px/W, y = py/H. Origin
  top-left, **y down**, range [0, 1] inclusive. Values are continuous: do not snap to pixel centres. The app clamps
  joints outside the canvas, and the cost confirm warns about it (`GenerationPlan.clamped`).
- **NECK = exact midpoint of the two shoulders.** PixelLab samples and estimates agree, and PixelLab's 3D preview
  hangs the clavicles from NECK. The rig can only produce that NECK (`docs/skelanim/rig.md`).
- **`z_index`** is an integer (fractions are rejected), "higher draws on top". Only the relative order matters;
  ties and negatives are fine. Coarse integer layers (the estimate's style, rounded) and a unique rank are both valid.
  - The app sends a unique rank 0..17 (nearest = 17) with hysteresis across one submission (`projectPoseSequence()`;
    formula in `docs/skelanim/rig.md`). The estimate's float `z_index` is never sent: lifting only uses it as an
    ordering hint (limb depth signs, torso-yaw sign, hidden face points).
- **`depth`** is optional: 0..255, higher = nearer, about 128 at the body's centre. If omitted, it comes from
  `template_id`'s standing pose for this direction. Its scale and axis are unknown (U1). The app omits it unless the
  panel's "Send depth" (`sendDepth`) is on. One third-party A/B test saw no visible difference.
- **Camera (orthographic):** direction → yaw θ = index·45° in `DIRECTIONS` order (south 0°, east 90°, north 180°,
  west 270°). South faces the camera, so the character's RIGHT is on image-left; east faces screen-right, RIGHT side
  nearer. View → pitch preset `VIEW_PITCH`: side 0°, low top-down 20°, high top-down 35°. The values are approximate
  (PixelLab's exact `camera_tilt` is private); the user can override `pitchDeg`, and a view change resets it.
- 2D mirror east↔west: x' = 1−x, swap LEFT/RIGHT labels, each z_index stays with its swapped label (the app never does this).

## Background jobs

- `GET /background-jobs/{id}` returns `{id, status, created_at, last_response: object|null, usage: Usage|null}`.
  - `completed`: frames in `last_response.images`. `failed`: reason in `last_response.detail` (the app also fails
    `error`, `cancelled`, `canceled`). Any other status is still running; while queued, `last_response` also has
    `queue_position` and `estimated_wait_seconds`.
- Under load the top-level status and the images can be briefly out of step. Done = `completed` **and**
  `len(images) == len(keypoints)`; the app re-polls a short `completed` up to 5 times (`MAX_INCOMPLETE`), then fails it.
- **Image shape is unverified (U2).** It may be a bare string or `{type: "base64"|"rgba_bytes", base64, width?,
  height?}`, with or without a `data:` prefix, holding PNG or raw RGBA bytes. Decode defensively. Read `images`,
  never `quantized_images`. Billing is the top-level `usage` (sometimes also `last_response.billing_usage`).
- Poll every 5–10 s. On 429, 5xx or a network error, back off and **re-poll the same id. Never resubmit a paid job.**
  A deadline must never cancel or fail a job: it may still finish.
- 404 means gone or not yours. Jobs are cleaned up some time after completion (retention unknown): persist frames promptly.
- Cancelling: `DELETE` returns `{id, status: "failed", message, usage}` and frees the concurrency slot at once. A
  queued job is not charged; a running one may be. 400 = it already finished; 409 = it finished during the cancel.
- App policy (`jobService.ts`): 6 s polls, failures back off ×2 to 5 min, 3 consecutive 404s fail the job. Running
  60 min (clock restarts at app start and wake) → note + 5-min polls, never a cancel. Cancel: 404 = cancelled; 400/409 → re-poll.

## Cost and limits

- estimate ≈0.1 generation (`ESTIMATE_COST`). v3 by frame count, not canvas (`generationCost()`): **3 → 2, 4–8 → 3,
  9–15 → 4**; only 3/8/15 are published, one live 4-frame job billed 3. Bill from `usage`. Failures reportedly don't bill.
- Latency: v3 usually takes 3–5 min; 17–30 min was seen under a 20-job load.
- Concurrency limits are unpublished; 429 means the limit was hit. Third-party figures: Tier 1 = 8, Tier 2 = 10,
  Tier 3 = 20. Space submissions at least 2 s apart, and back off on 429 or 529.
- Still open: **U1** depth scale and axis (free to resolve: `GET /v2/characters/{id}` `skeletons` gives template depth
  for a character the user owns; that path is not on the allow-list); **U2** result image shape, and whether frames
  always match the `first_frame` size (`decodeResultImages()` does not check); **U3** whether v3 accepts non-square or
  small canvases (only square ones have been used); **U4** what missing or duplicate joints do; **U5** the exact tilt
  per view; **U6** whether `z_index` magnitude matters; **U7** whether a request `base64` may carry a `data:` prefix (avoid it).

## In this codebase

| Module | Role |
|---|---|
| `src/shared/pixellab.ts` | Wire types and enums, `SKELETON_LABELS`, `VIEW_PITCH`, `canonicalKeypoints()`, `generationCost()`, `checkedBase()`, `validateAnimateRequest()` (the pre-submit check, safe on untrusted input) |
| `src/main/core/pixellabClient.ts` | Transport: path allow-list (`ALLOWED_PATH`; add new endpoints there), key and base URL read at call time, timeouts, never throws. `maybeSent` flags failures after which a POST may have been accepted. `balance()`, `estimateSkeleton()` (reorders the result to canonical) |
| `src/main/ipc/pixellab.ts` | `window.api.pixellab.balance / estimateSkeleton` over `net.fetch`. The key never leaves main |
| `src/main/core/jobService.ts`, `src/main/jobs.ts` | Job journal, submit, polling, decode, stage, push `jobs:update` |
| `src/main/core/resultImages.ts` | Defensive decoder for every U2 shape; outputs PNGs |
| `src/shared/jobs.ts` | `JobRecord`, `JobStatus`, `validateSubmitInput()` |
| `src/renderer/src/core/generate.ts` | Preflight, plus `buildGeneration()`: the request without `first_frame`, and the snapshot |
| `src/renderer/src/core/rig/projection.ts` | 3D pose → keypoints (`docs/skelanim/rig.md`) |
| `src/renderer/src/stores/job/jobsCore.ts` | Estimate (with cache), `submitGenerate`, applying final records |

- **Submit (journal before POST):**
  1. The renderer builds the plan and fresh `frameUids` and calls `jobs.submitAnimate`. Main validates the input and
     reads the reference PNG with `readCanvasPng()` (square 16/32/64/128/256 canvas required).
  2. Main writes a `submitting` entry to `data/.ptk/jobs.json`. If that write fails, nothing is sent.
  3. Main POSTs. A definite failure removes the entry. `maybeSent` (timeout, 5xx, connection lost) or a missing or
     invalid job id leaves a `failed` record that says "not resubmitted" and is returned as `record`.
  4. The job id is journaled and polling starts.
  - At startup, any entry still `submitting`, or not final without an id, becomes failed and is never resubmitted.
    Quitting waits, with a time limit, for POSTs still in flight (main `will-quit` and the renderer close handler).
- **Results:** main stages them at `data/.ptk/jobs/<key>/<frameUid>.png` and marks the record `completed`. The
  renderer moves them next to the animation, applies and saves; only then does `jobs.ack(key)` delete the record and
  its staging dir. Orphan staging dirs are swept at startup. Renderer side: `docs/skelanim/skelanim.md`.
- Estimates are cached on the source base image (`baseImages[i].estimate`, via `reference.sourceBaseUid`): "Estimate"
  reuses it, "Re-estimate" pays. A reference imported straight into the animation has no cache: every estimate pays.
- **Budget:** the CLAUDE.md rule also covers Estimate/Generate clicks under automation and `npm run fixtures` (pays for
  each missing estimate json). Check `GET /balance` (free; Settings → "Check balance") before and after; report spend.
- **Fixtures:** `testbed/fixtures/<name>.png` holds the padded sprites from `assets/test_imgs`. `<name>.estimate.json`
  (`EstimateFixtureFile`) holds the raw response in API order, plus `source`, `canvas` and `offset`.
  `npm run fixtures` fetches only missing estimates (`--dry` never calls the API). Used by `scripts/verify-rig.ts`,
  `scripts/test-main-fs.ts`, `src/renderer/src/testbed/fixtures.ts` and `scripts/test-jobs.ts` (fake fetch and clock).
