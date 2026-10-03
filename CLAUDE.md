# PixelToolkit

Windows desktop toolkit (Electron + Vue 3 + TypeScript + three.js) of tools for sprites, pixel art and 3D pixel art,
used in downstream pipelines and as a testbed for new workflows. Each tool is a page reached from the vertical nav bar.

**Tools:** Skel Anim (Skeletal Animator). Characters and animations in a file-mirroring explorer. A 3D rig editor
(Unity-style humanoid) whose poses are projected to 2D OpenPose/COCO-18 keypoints and sent to PixelLab's
skeleton-v3 API, which returns sprite frames.

## Repo map

| Path | What |
|---|---|
| `src/main/` | Electron main. `core/` holds the electron-free, node-tested logic (fs sandbox, job service, PixelLab client, image import); `ipc/` holds thin handlers |
| `src/preload/` | `window.api` bridge (contextBridge; the renderer has no Node access) |
| `src/shared/` | Types and constants used by both processes: IPC contract `api.ts`, PixelLab wire types, jobs, settings, data paths |
| `src/renderer/src/core/` | Framework-free logic: persisted model, state producers, rig math, undo |
| `src/renderer/src/editor/` | three.js viewport. Non-reactive, imports no stores |
| `src/renderer/src/stores/` | Pinia stores |
| `src/renderer/src/services/` | Global UI singletons: dialogs, toasts, context menu, shortcuts, … |
| `src/renderer/src/components/` | `common/` (shared controls) and `shell/` (nav bar, settings dialog) |
| `src/renderer/src/tools/` | `registry.ts`, plus one folder per tool |
| `src/renderer/src/styles/` | Theme tokens and shared control CSS |
| `scripts/` | Node test runners and the fixture fetcher |
| `testbed/fixtures/`, `assets/test_imgs/` | Padded test sprites and cached PixelLab estimates; their source PNGs |
| `build/`, `resources/` | Packaging only: electron-builder icons and entitlements; the app icon |
| `data/`, `appSettings.config` | User data and settings with API keys. Both gitignored |
| `archive/` | Outdated build history, not a source of truth. Do not read it unless asked |

`.ignore` hides `archive/` from Grep, but Glob still lists it: scope globs to `src/`, `scripts/` or `docs/`.
Most source files open with a header comment stating their role (some `src/main/` files, the entry files and tiny
components have none). Keep it accurate when you change a file, and give new files one.

## Read before you work

| Working on | Read first |
|---|---|
| Any code edit | `CodeGuide.md` (mandatory style rules; ESLint enforces the mechanical ones) |
| Main process, IPC, files on disk, settings, app-wide conventions, adding a tool or big feature, running/verifying the app | `docs/architecture.md` |
| UI components, styling, dialogs/toasts/shortcuts/focus conventions | `docs/ui.md` |
| Anything that calls PixelLab | `docs/pixellab.md` |
| Skel Anim features: explorer, panel, frame track, documents/undo/saving/jobs | `docs/skelanim/skelanim.md` |
| Rig math, projection, lifting, calibration, how the editor draws the rig | `docs/skelanim/rig.md` |

`src/main/`, `src/renderer/src/stores/`, `src/renderer/src/editor/` and `src/renderer/src/core/rig/` each have a short
`CLAUDE.md` with their invariants. It loads automatically when you work in that folder.

## Commands

```bash
npm run dev            # app with HMR (dev:debug adds CDP on 9222; dev:testbed opens the rig testbed page)
npm run typecheck      # node + web (vue-tsc) + scripts
npm run lint           # ESLint incl. CodeGuide rules (lint:fix autofixes)
npm test               # all node suites: test:rig, test:main, test:docs, test:playback (no Electron, no API calls)
```

A code change is done when typecheck, lint and `npm test` pass. A UI change must also be checked in the running app
(see `docs/architecture.md`, "Testing and verification").

## Hard rules

- **`data/` is the user's real work**, including paid PixelLab generations.
  - Never change it outside the app's own flows.
  - Back up `data/` before driving the app in automation, and restore `data/.ptk/workspace.json` afterwards.
- **PixelLab calls cost money.**
  - Don't call estimate or animate without the user's explicit go-ahead. `GET /balance` is free.
  - Prefer `testbed/fixtures` and cached estimates.
- **`appSettings.config` holds API keys.** Never print or log it. The renderer only ever sees masked secrets.
- **Commits are the user's job.** Do not commit unless asked.
- **Docs record intent, invariants and cross-file flows**, not what a single file already says. Name constants and
  functions instead of copying their values. If you change behaviour a doc describes, update it in the same change.
