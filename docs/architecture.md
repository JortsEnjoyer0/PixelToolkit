# Architecture

Read before working on main, preload or shared code, files under `data/`, settings, startup or close, a new tool, or
before running the app to verify a change. The other docs are listed in the root `CLAUDE.md`.

## Stack

| Piece | Version | Why it matters |
|---|---|---|
| Electron | `^44.5.1` (Node 24, Chrome 152) | The package has had no postinstall since v42, so `postinstall` runs `install-electron`. `@types/node ^24` matches its Node |
| electron-vite | `^5` | Builds main, preload and renderer into `out/`. Its Vite peer range ends at 7, so `vite` stays `^7.3` (Vite 8 needs electron-vite 6) |
| TypeScript | `~6.0.3`, not 7 | TS 7 (Go) has no JS compiler API, so `vue-tsc` 3 and typescript-eslint cannot run on it. typescript-eslint's peer range also ends below 6.1 |
| Vue, Pinia | `^3.5` (`<script setup lang="ts">`), `^4` | Pinia 4 is ESM-only, same API |
| three | `^0.186` | Imported only in `src/renderer/src/editor/` |
| pngjs, `@lucide/vue`, `vue-draggable-plus` | `^7`, `^1`, `^0.6` | Pure-JS PNG, imported only by `src/main/png.ts` (main and scripts); icons (not the deprecated `lucide-vue-next`); drag-and-drop reordering of tabs and frame-track frames |
| tsx, Playwright | dev | Node test runners; `connectOverCDP` automation (no browser download needed) |

- TS projects: `tsconfig.node.json` (main, preload, shared), `tsconfig.web.json` (renderer, shared) and
  `scripts/tsconfig.json`. Renderer code imports `@shared/*`; main, preload and scripts import `src/shared` relatively.
  `electron-builder.yml` packages none of `src`, `data`, `docs`, `archive`, `testbed` or `appSettings.config`.

## Process model and IPC

Renderer: `contextIsolation`, `sandbox: true`, no `nodeIntegration`, in-app navigation blocked, `window.open` denied
(https URLs open in the system browser). The CSP (`src/renderer/index.html`) allows network only to `'self'`,
`ptk-asset:` and dev HMR, so PixelLab calls run in main. `window.api` is the renderer's only access to the system:
- Contract `src/shared/api.ts` (`IPC` channels, `PixelToolkitApi` documented per method, `ApiEvents`, `Result<T>`,
  `assetUrl()`); `src/preload/index.ts` (one invoke wrapper per method, `api.on()` → unsubscribe; may only
  `require('electron')` at runtime, so `src/shared` is bundled in); handlers: `src/main/ipc/*.ts`, `src/main/jobs.ts`.
- Adding a method: `IPC` channel, documented `PixelToolkitApi` signature, preload wrapper, `ipc/` handler, `core/`
  logic; typecheck then requires it in the fake `stores/doc/selftestEnv.ts` (the `playbackJobs.test.ts` mock is cast).
- Events (main → renderer; typed by `ApiEvents`, allow-listed by the preload's `EVENTS`; `api.on()` rejects others):
  `jobs:update` (a `JobUpdateEvent` to every window; no initial snapshot, call `jobs.list()`) and `app:before-close`.
- Handler helpers (`src/main/ipc/handle.ts`) all validate the sender (`isTrustedSender`: `file://` or the dev URL):
  - `handleResult` for operations that fail for expected reasons (`pixellab.*`, `jobs.submitAnimate`, `jobs.cancel`):
    returns `Result<T>` (`{ ok: false, status?, error }`), never rejects; a throw becomes `{ ok: false }`.
  - `handle` / `handleWithEvent` for the rest: a failure rejects with a user-facing `Error` message, which the renderer
    lets reach the global handler (`services/errors.ts`) unless it needs context (CodeGuide: no blanket try/catch).
- Arguments are untrusted: main re-checks paths (sandbox), entity names (`checkEntityName`) and job input
  (`validateSubmitInput`). Only plain data crosses IPC: send `plainCopy()` or serialized objects, never Vue proxies.

## Main process

Logic lives in electron-free `core/` modules with injected dependencies (fetch, clock, emit), tested by tsx scripts:

| Area | Files | Tested by |
|---|---|---|
| Core | `src/main/core/`: `dataFs.ts` (sandbox, atomic writes, rename, scan, temp cleanup), `assetPath.ts`, `imageImport.ts`, `sessionCreated.ts`, `pixellabClient.ts`, `jobService.ts`, `resultImages.ts`; plus `src/main/png.ts` | `scripts/test-main-fs.ts`, `scripts/test-jobs.ts` |
| Electron glue | `index.ts` (startup, window, quit), `paths.ts` (app root, data-root safety), `assetProtocol.ts`, `devScreenshot.ts`, `jobs.ts` (JobService wiring, `jobs:*` handlers), thin `ipc/*` handlers (`images.ts` adds only the file dialog; `app.ts` the close protocol) | the running app |

Startup (`src/main/index.ts`):
1. `registerAssetScheme()` before `ready`; single-instance lock in packaged builds only (dev respawns main on change:
   never run two dev instances). No app menu: no Ctrl+R reload, Ctrl+W close or Edit-role Ctrl+Z (F12 = devtools in dev).
2. `loadSettings()` (creates `appSettings.config`), `openDataRoot()`: the default and a `PT_DATA_ROOT` folder are
   created when missing (unsafe: start fails). Another configured folder is never silently recreated: unsafe or
   unopenable → Use default / Quit; missing → Create it / Use default / Quit ("Use default" resets `app.dataRoot`).
3. Temp cleanup, `initJobs()` (an unreadable journal fails the start rather than drop paid jobs), startup sweep, asset
   protocol, IPC, window, job polling, screenshot server. A throw in `start()` shows "failed to start" and quits.

Close and quit: `installCloseProtocol()` (`ipc/app.ts`) cancels every window close and sends `app:before-close`; the
preload acks (`app:close-ack`), or answers `closeReady` itself when nothing listens (testbed). The renderer runs its
close handlers (`services/lifecycle.ts`), then `api.app.closeReady()` destroys the window. No ack within 10 s (dev: 3 s)
or a dead renderer: production asks "Quit anyway?", dev just closes; after an ack main waits (a prompt may be open).
`will-quit` holds the quit (time-bounded) for POSTs in flight, so job ids get journaled, then for a clean close's sweep.

App root (`getAppRoot()`, `src/main/paths.ts`) holds `appSettings.config` and, by default, `data/`: the project folder
in dev; packaged, `%APPDATA%\PixelToolkit` or a portable exe's folder, never the install dir (NSIS deletes it on update;
`copyFromInstallDir()` migrates an older build's files once). `PT_DATA_ROOT` overrides the data root.

Asset protocol (`src/main/assetProtocol.ts`): `ptk-asset://data/<rel>` (build with `assetUrl()`) serves data-root files
to `<img>`, `fetch` and three.js textures (CORS set for WebGL), behind the fs sandbox check. `<owner>.<uid>.png` is
cached `immutable` for a year, other files `no-cache` (`assetUrl(rel, v)` appends `?v=` for files that change).

## Data root and files

Sandbox (`src/main/core/dataFs.ts`): every renderer path is POSIX, relative to the data root, no leading slash.
`resolveChecked()` = `resolveInside()` (rejects absolute, drive and UNC paths, NUL, escapes, and the root itself unless
`allowRoot`) + `assertRealInside()` (realpath of the nearest existing ancestor: junctions cannot lead outside).
`dataRootProblem()` (`paths.ts`) refuses a drive root, the user folder, the app root (API keys), folders above them and,
packaged, anything in the install dir: the data root is the renderer's sandbox and is cleaned at startup.

Layout (path helpers in `src/shared/dataPaths.ts`):
```
data/
  <Folder>/              folder: root-level dir without a sibling json; holds characters only
    <Char>.json          character meta (pairs with the dir case-insensitively); characters may also sit at the root
    <Char>/              character dir
      base.<uid>.png     character base image
      <Anim>.json        animation
      <Anim>.<uid>.png   image owned by animation <Anim>
```
- `scanData()` returns folders, characters, `brokenCharacter` (json without its dir) and animations with json mtimes; it
  never stats PNGs and skips dot entries (`.ptk/`), `*.tmp` and links. Folders exist only at the root: a json-less dir
  inside a folder is not listed (name checks still count it: `entityNamesInListing()`).
- Entity names map 1:1 to file names: `nameProblem()` (`src/shared/names.ts`, main and renderer) forbids blanks,
  `\ / : * ? " < > | .`, control characters, edge spaces, Windows device names, `base` and > 64 characters. Sibling
  uniqueness is case-insensitive and excludes self (case-only renames work): `validateName()`, `core/util/naming.ts`.
- Image name: exactly `<owner>.<uid>.png` (`IMAGE_FILE_RE`, `parseImageFileName()`), uid = 8 chars of `[0-9a-z]`
  (`src/shared/uid.ts`). Owner `base` is the character; any other owner is the animation of that name.
- Immutable: pixels are never rewritten; new pixels get a new uid (so the immutable cache is safe). Ownership is an
  exact name match. Owners never share a uid: a base image used as a reference is copied (`images.copyToAnimation`).
  Imports and copies use `writeNewImage()` (`core/imageImport.ts`: fresh uid, no overwrite, existing character dir);
  job results are staged in `.ptk/jobs/` and moved in with `fs.rename`. Imports (PNG ≤ 256 px) are centred on the
  smallest fitting 16/32/64/128/256 square canvas, never scaled.

Writes, renames, deletes:
- `atomicWrite()`: temp `<name>.<12 hex>.tmp` beside the target (stale ones are deleted at startup), fsync, rename.
  Non-recursive unless `createDirs` (only `.ptk/` files and `appSettings.config` use it), as is `fs.mkdir`: a late
  write fails (ENOENT) instead of resurrecting a deleted or renamed folder.
- `fs.writeJson` formats with `formatJson()` (`src/shared/json.ts`: 2-space indent, numeric arrays on one line) and
  resolves the new mtime, so the renderer tells its own saves from external edits. Reads accept a UTF-8 BOM.
- `fs.rename` (`renameEntry()`) rejects when the target exists (case-insensitively, except a case-only rename of the
  same entry) or its parent is missing, and retries EPERM/EBUSY/EACCES (antivirus, OneDrive, Explorer previews).
- Multi-file renames are ordered so an interruption heals (character: json, then dir; animation: owned images, then
  json) and roll back on failure: `renameCharacterFiles` (`explorerOps.ts`), `moveAnimationFiles` (`documents.ts`).
- User deletes go to the Recycle Bin (`fs.trash`). Permanent deletes are internal only: image GC (`fs.deleteFiles`,
  files only), the session sweep, startup temp cleanup and job staging dirs.

`.ptk/` internals (constants in `src/shared/dataPaths.ts`):

| Path | Owner | Contents |
|---|---|---|
| `jobs.json` | main `JobService` | Job journal, written before the paid POST; jobs are never resubmitted. An invalid one is copied to `jobs.corrupt-<ms>.json` first (`docs/pixellab.md`) |
| `jobs/<key>/<uid>.png` | main writes; renderer moves out (`fs.rename`); `jobs.ack` deletes the dir | Finished results waiting to be applied |
| `workspace.json` | renderer `stores/workspace.ts` | UI state (see Workspace) |
| `session-created.json` | main `core/sessionCreated.ts` | Images main wrote this session |

Session sweep (crash-safe image GC, `core/sessionCreated.ts`): `sessionEntryFor()` lists every `<owner>.<uid>.png`
main writes outside `.ptk/` (imports, copies, `fs.writeBinary`, staged results renamed out). At startup and after a
clean close, a listed image whose uid no json mentions and no journaled job needs is deleted, with any renamed
`*.<uid>.png`; images beside an unparsable json are kept. The json walk (`collectReferences()`, `MAX_DEPTH` dirs) skips
dot entries (`isHiddenName()`), so a json in a dot dir keeps nothing alive. Renderer GC: `docs/skelanim/skelanim.md`.

## Settings and secrets

`appSettings.config` (JSON in the app root, gitignored) mirrors `AppSettings` in `src/shared/settings.ts`:

| Section | Keys (defaults) |
|---|---|
| `pixellab` | `apiKey` (secret), `baseUrl` (`https://api.pixellab.ai/v2`) |
| `ai` | `anthropicApiKey`, `openaiApiKey` (secrets; editable, used by no feature yet) |
| `app` | `dataRoot` (`./data`, relative to the app root), `autoSaveIntervalSec` (60, 0 = off), `undoLimit` (100), `defaultFps` (12) |
| `editor` | `flySpeed` (1.5); `showFloor`, `showFrameImage`, `showCoco` (true) seed a new workspace's toggles, and a change in Settings applies to the toolbar at once |

- `loadSettings()` (`src/main/ipc/settings.ts`) returns real secrets, for main only; the PixelLab client reads key and
  base URL per call (a new key works without a restart). Never log, print or return secrets.
- Masking: `settings.read()` / `write()` return `SECRET_MASK` for a non-empty secret; a patch carrying it keeps the
  stored value, `''` clears it. The renderer (`stores/settings.ts`, a frozen snapshot) only ever sees masked values.
- Merging: per section; a key is taken only if known and of the default's type; unknown keys in the file are kept.
  Invalid JSON throws, so the file is never clobbered. Main does not range-check numbers; the dialog's controls do.
- Validation: a changed `app.dataRoot` must pass `dataRootProblem()` in main (it applies after a restart); `baseUrl`
  must pass `checkedBase()` (https on `pixellab.ai`; dialog and client both check): the key goes nowhere else.

## Renderer layers

Under `src/renderer/src/`. Dependencies point down the table; the last column is the complete allow-list besides
`@shared`, vue and UI packages.

| Layer | Responsibility | May import |
|---|---|---|
| `tools/<id>/` | One folder per tool: wires stores, services, editor and components | everything below |
| `components/` | `common/`: reusable controls and the global hosts. `shell/`: NavBar, Settings dialog | services, `stores/settings`, `tools/registry`, `core/util` |
| `stores/` | Pinia setup stores. Contracts in `stores/types.ts` (`*StoreApi`, `DocHandle`) | core, services, `editor/types.ts` (types, sanitizers) |
| `editor/` | The three.js viewport (`EditorViewport` and its views): plain classes, non-reactive, fed by `DocSource`, reporting through events | core, three. Never stores or services |
| `services/` | Global UI singletons (next section) | other services |
| `core/` | Framework-free logic: persisted model and migrations (`model.ts`), state producers (`docState.ts`), generate preflight (`generate.ts`), rig math (`rig/`), undo (`undo/`), `util/` | `@shared` only. No Vue, three, stores, services or `window.api` |
| `styles/` | `theme.css` tokens, `base.css`, `controls.css`, `utilities.css`, loaded once by `bootstrap.ts` | |

- Entries `main.ts` and `testbed.ts` call `mountApp()` (`bootstrap.ts`: Pinia, `v-tooltip`, global error handling).
  `App.vue` shows NavBar, the active tool in `<KeepAlive>` (hidden tools stay mounted) and the global hosts.
- `window.api` callers: stores, tools, `services/lifecycle.ts` (close handshake) and `SettingsDialog.vue` (balance,
  data root path). Core and editor never call it.

## Global services

Singletons in `services/`; a service with a host is state only (hosts mount once in `App.vue`). Usage: `docs/ui.md`.

| Service | Purpose | Key API |
|---|---|---|
| `dialogs.ts` | Modal dialogs as promises (`DialogHost`) | `dialogs.confirm`, `prompt`, `choice`, `open(component, props)`, `isModalOpen()` |
| `toasts.ts` | Notifications (`ToastHost`) | `toasts.push(opts)` → id, `dismiss` |
| `contextMenu.ts` | The one context menu (`ContextMenuHost`) | `contextMenu.open(eventOrPoint, items)`, `SEPARATOR`, `close` |
| `mouseNotify.ts` | Short text at the pointer, e.g. "Saved" (`MouseNotifyHost`) | `mouseNotify(text)` |
| `shortcuts.ts` | One keydown listener; zone handlers before global ones; off while a modal or the menu is open | `shortcuts.register(scope, combo, handler, opts)` → unregister, `blurTextField()` |
| `focusZone.ts` | Last-used UI zone, from elements tagged `data-zone="…"` | `ZONES`, `focusZone.get()`, `set()`, `current` |
| `editorState.ts` | Bridge between the one editor viewport and the stores | `editorInteracting`, `whenEditorIdle()`, `cancelEditorInteraction()` |
| `lifecycle.ts` | Renderer side of the close handshake | `registerCloseHandler(fn)`, `installCloseHandshake()`, `lifecycle.isClosing()` |
| `errors.ts` | Vue errors, unhandled rejections and window errors are logged and toasted | `reportError(e, title)`, `errorMessage(e)` |

## Workspace

`data/.ptk/workspace.json` (`WorkspaceState` in `stores/types.ts`, store `stores/workspace.ts`) is UI state restored on
launch. Not persisted: camera views (per doc, in memory), selection, playback. Preferences go in `appSettings.config`.

| Field | Contents |
|---|---|
| `tabs`, `activeRel` | Open animation json rels in tab order; the active one |
| `expanded` | Expanded explorer node rels |
| `display` | Editor toolbar toggles (`DisplayOptions`, defaults `DEFAULT_DISPLAY` in `editor/types.ts`): floor, frame image, COCO, skeleton, ghosts (`ghostCount`, `ghostColor`), gizmo space, ortho. `cocoEdit` is saved false, `gizmoMode` as `rotate` |
| `explorerWidth`, `thumbHeight` | Explorer width; frame-track thumbnail height (56–240) |

- Read once when the store is created; missing or invalid fields fall back to defaults (`parseWorkspace()`).
  `update(patch)` merges, skips no-op patches and writes debounced (400 ms); patches made before the read finishes are
  merged on top of the file, never written over it. `flush()` runs in the documents store's close handler.
- Restore order (`startup()` in `App.vue`): settings → document stores (shortcuts, autosave, close handler) →
  `workspace.whenLoaded()` → mount the tool → `restoreWorkspace()` (`stores/tabs.ts`: reopens tabs whose json
  exists) → `initJobs()`, so finished jobs apply to reopened tabs, not headless. Hand-edit the file only while closed.

## Adding a tool

1. Root component `src/renderer/src/tools/<id>/<Name>Tool.vue`; add `{ id, label, icon: markRaw(Icon), component:
   markRaw(Root) }` to `TOOLS` in `tools/registry.ts` (NavBar and `App.vue` pick it up). Hidden tools stay mounted
   (`KeepAlive`): pause heavy work in `onDeactivated`, resume in `onActivated`.
2. UI from `components/common/` and `styles/`; dialogs, toasts, menus, shortcuts and close handling via the services.
   Tag panes `data-zone`, scope shortcuts to zones (new names go into `ZONES`). Ctrl+S/Z/Y and Ctrl+Shift+Z always act
   on Skel Anim's active doc (`installDocumentShortcuts()` in `stores/tabs.ts`): bind them zone-scoped or gate them.
3. State: Pinia setup stores with a typed `*StoreApi`, frozen snapshots (`shallowRef` + `deepFreeze()`), nothing large
   reactive (never three.js objects); framework-free logic in `core/`. Unsaved work: `registerCloseHandler()`.
4. Files only through `window.api.fs`, following the rules above. The data root is Skel Anim's today: a non-dot
   root dir shows in its explorer as a folder. Use `data/.<id>/` (hidden from `scanData()`), and either name images so
   they do not match `IMAGE_FILE_RE` or exempt the dir in `sessionEntryFor()`: otherwise the session sweep deletes
   them (Session sweep, above). UI state: optional `WorkspaceState` fields, validated in `parseWorkspace()`.
5. New system access: an IPC method (see above), logic in `src/main/core/`; network calls return `Result<T>`.
6. Tests: a tsx script with a `check(name, ok)` helper, a pass/fail count and exit code 1 on failure (like
   `scripts/test-main-fs.ts`), chained into `npm test`. Docs: `docs/<id>/<id>.md`, a row in the root `CLAUDE.md` "Read
   before you work" table, and a folder `CLAUDE.md` for invariants an editor of that folder must not miss.

## Testing and verification

| Command | Runs | Covers |
|---|---|---|
| `npm run typecheck`, `npm run lint` | `tsc` (node), `vue-tsc` (web), `tsc` (scripts); ESLint (`lint:fix` autofixes) | types; CodeGuide mechanics |
| `npm run test:rig` | `scripts/verify-rig.ts` | rig numerics on the fixtures (`docs/skelanim/rig.md`) |
| `npm run test:main` | `scripts/test-main-fs.ts`, `scripts/test-jobs.ts` | sandbox, atomic writes, renames, scan, temp cleanup, junction guard, asset URLs, PNG import, session sweep, PixelLab mapping; job service with fake fetch and clock (backoff, 404s, deadline, cancel, restart without resubmit, result image shapes) |
| `npm run test:docs` | `stores/doc/selftest.ts` | documents, tabs and workspace stores against an in-memory `window.api` mimicking main's fs rules |
| `npm run test:playback` | `stores/job/playbackJobs.test.ts` | playback and the jobs store (apply, estimate, submit) with mocks |

- `npm test` runs the four: plain tsx, no framework, no Electron, network or generations; the renderer-side two use
  `--tsconfig tsconfig.web.json`. `test:main` makes temp dirs under `PT_TEST_TMP` (default: OS temp).
- Testbed (dev only): `npm run dev:testbed` (`src/renderer/src/testbed/`) drives the real `EditorViewport` and
  `core/rig` on `testbed/fixtures`, no IPC. `npm run fixtures` costs money (`docs/pixellab.md`).

Running the app for a check:
1. Back up `data/` outside the project first, or run on a copy with `PT_DATA_ROOT=<absolute dir>`. After the app has
   exited, restore `data/.ptk/workspace.json` (and anything else the run changed) from the backup.
2. Start `npm run dev:debug` in the background (CDP on 127.0.0.1:9222; testbed: `dev:testbed:debug`), one at a time.
3. Screenshot: `curl.exe -s -o NUL "http://127.0.0.1:47321/screenshot?file=<name>.png"` writes `.screenshots/<name>.png`
   (poll `/health` first; `PT_SCREENSHOT_PORT` changes the port). In dev the window paints while covered.
4. Drive it with Playwright `chromium.connectOverCDP('http://127.0.0.1:9222')`. Pinia store `<id>`:
   `document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('<id>')` (`settings`, `workspace`,
   `tabs`, `documents`, `explorer`, `jobs`, `playback`). Dev only:
   - `window.__editorViewport` (set by `EditorPane.vue`): `projectBone(bone)`, `projectCoco(i)` and `debugPickAt(x, y)`
     (→ `{ axis, bone, coco }`) use CSS px relative to the editor canvas: add its `getBoundingClientRect()` origin
     before `page.mouse.click`. Getters `selectedBone`, `gizmoMode`, `renderCount`.
   - In-page imports: `await import('/src/core/rig/fk.ts')` (the renderer root is `src/renderer`); shared modules via
     `/@fs/<absolute project path, forward slashes>/src/shared/<file>.ts`. `PT_TEST_IMPORT_FILE=<absolute png>` makes
     image import skip the file dialog.
5. Stop: kill the process tree owning port 5173, e.g. PowerShell
   `taskkill /T /F /PID (Get-NetTCPConnection -LocalPort 5173 -State Listen).OwningProcess`. Never kill all `node.exe`
   (Claude Code runs on node). A hard kill skips the close handshake: unsaved edits are lost; the sweep runs next start.
